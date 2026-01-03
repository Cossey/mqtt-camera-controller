import { XMLParser } from 'fast-xml-parser';
import debug from 'debug';
import http from 'http';
import { CameraConfig, AppConfig } from '../types';
import { CameraManager } from '../cameras/cameraManager';
import { findEventTypesInObj } from './pullPoint';

const log = debug('push');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', allowBooleanAttributes: true });

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
    log('parse error', err);
    return [] as { type: string; state?: boolean | null }[];
  }
}

export function startPushServer(cfg: AppConfig, manager: CameraManager) {
  const port = (cfg.notify && cfg.notify.port) || 8080;
  const basePath = (cfg.notify && cfg.notify.basePath) || '/onvif/notify';

  const srv = http.createServer(async (req, res) => {
    console.log('notify request', req && req.url, 'method', req && req.method);
    if (!req.url || req.method !== 'POST') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    // only accept POSTs under basePath
    if (!req.url.startsWith(basePath)) {
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
