import { XMLParser } from 'fast-xml-parser';
import debug from 'debug';
import http from 'http';
import { CameraConfig, AppConfig } from '../types';
import { CameraManager } from '../cameras/cameraManager';
import { findEventTypesInObj } from './pullPoint';
import { logError, logInfo, logWarn } from '../logger';

const log = debug('push');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', allowBooleanAttributes: true });

export interface ResolvedNotifyConfig {
  listenPort: number;
  basePath: string;
  callbackBaseUrl?: string;
  portMismatch: boolean;
}

function normalizeBasePath(basePath?: string): string {
  const p = (basePath || '/onvif/notify').trim();
  if (!p) return '/onvif/notify';
  return p.startsWith('/') ? p : `/${p}`;
}

export function resolveNotifyConfig(cfg: AppConfig): ResolvedNotifyConfig {
  const basePath = normalizeBasePath(cfg.notify?.basePath);
  const configuredPort = cfg.notify?.port;
  const rawBaseUrl = cfg.notify?.baseUrl?.trim();

  let parsed: URL | null = null;
  if (rawBaseUrl) {
    try {
      parsed = new URL(rawBaseUrl);
    } catch {
      parsed = null;
    }
  }

  const baseUrlPort = parsed?.port ? Number(parsed.port) : undefined;
  const listenPort = typeof configuredPort === 'number' && configuredPort > 0
    ? configuredPort
    : (baseUrlPort || 8080);

  let callbackBaseUrl: string | undefined;
  let portMismatch = false;

  if (parsed) {
    if (parsed.port) {
      if (typeof configuredPort === 'number' && configuredPort > 0 && configuredPort !== Number(parsed.port)) {
        portMismatch = true;
      }
    } else {
      parsed.port = String(listenPort);
    }
    callbackBaseUrl = parsed.toString().replace(/\/$/, '');
  }

  return { listenPort, basePath, callbackBaseUrl, portMismatch };
}

export function buildNotifyUrl(cfg: AppConfig, cameraName: string, notifyPath?: string): string | null {
  const resolved = resolveNotifyConfig(cfg);
  if (!resolved.callbackBaseUrl) return null;

  const path = notifyPath || `${resolved.basePath}/${encodeURIComponent(cameraName)}`;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${resolved.callbackBaseUrl}${normalizedPath}`;
}

function basicAuthHeader(cfg: CameraConfig) {
  if (!cfg.username) return undefined;
  const token = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  return `Basic ${token}`;
}

export function parseNotificationXml(xml: string) {
  try {
    const obj = parser.parse(xml);
    return findEventTypesInObj(obj);
  } catch (err) {
    logError('[ERROR] Failed to parse ONVIF notify payload', err);
    log('parse error', err);
    return [] as { type: string; state?: boolean | null }[];
  }
}

export function startPushServer(cfg: AppConfig, manager: CameraManager) {
  const resolved = resolveNotifyConfig(cfg);
  const port = resolved.listenPort;
  const basePath = resolved.basePath;

  if (resolved.portMismatch) {
    logWarn(`[WARN] notify.baseUrl port and notify.port differ; callback and listener ports are split callbackBaseUrl=${resolved.callbackBaseUrl} listenPort=${port}`);
  }

  const srv = http.createServer(async (req, res) => {
    if (!req.url || req.method !== 'POST') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    // only accept POSTs under basePath
    if (!req.url.startsWith(basePath)) {
      logError(`[ERROR] Rejected ONVIF notify path receivedPath=${req.url} expectedPrefix=${basePath}`);
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', async () => {
      try {
        const evs = parseNotificationXml(body);
        const cam = manager.getCameraByNotifyPath(req.url || '');
        if (cam) {
          for (const e of evs) {
            try {
              await cam.handleEvent({ type: e.type, state: e.state });
            } catch (err) {
              log('notify handleEvent failed', err);
            }
          }
        } else {
          log('No matching camera for notify path', req.url);
        }
        res.statusCode = 200;
        res.end('OK');
      } catch (err) {
        log('notify error', err);
        res.statusCode = 500;
        res.end('Error');
      }
    });
  });

  logInfo(`[INFO] Push notify server listening port=${port} basePath=${basePath}`);
  srv.listen(port, () => log(`notify server listening on ${port} ${basePath}`));

  return srv;
}

export async function createPushSubscription(eventsXaddr: string, cfg: CameraConfig, notifyUrl: string) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
  <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
    <s:Body>
      <tev:CreateSubscription xmlns:tev="http://www.onvif.org/ver10/events/wsdl">
        <tev:InitialTerminationTime>PT24H</tev:InitialTerminationTime>
        <tev:NotifyTo xmlns:wsa="http://www.w3.org/2005/08/addressing">
          <wsa:EndpointReference>
            <wsa:Address>${notifyUrl}</wsa:Address>
          </wsa:EndpointReference>
        </tev:NotifyTo>
      </tev:CreateSubscription>
    </s:Body>
  </s:Envelope>`;

  const headers: Record<string, string> = { 'Content-Type': 'application/soap+xml; charset=utf-8' };
  const auth = basicAuthHeader(cfg as CameraConfig);
  if (auth) headers.Authorization = auth;

  try {
    const fetcher = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!fetcher) throw new Error('Global fetch is not available');
    const init = { method: 'POST', headers, body };
    const r = await fetcher(eventsXaddr, init as { method?: string; headers?: Record<string,string>; body?: string });
    const txt = await r.text();
    log('createPushSubscription response', txt.slice(0, 200));
    return true;
  } catch (err) {
    log('createPushSubscription error', err);
    return false;
  }
}
