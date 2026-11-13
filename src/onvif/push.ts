import { XMLParser } from 'fast-xml-parser';
import debug from 'debug';
import http from 'http';
import { CameraConfig, AppConfig } from '../types';
import { CameraManager } from '../cameras/cameraManager';
import {
  buildSoapEnvelope,
  extractSubscriptionAddressFromResponse,
  extractSubscriptionTimingFromResponse,
  fetchWithTimeout,
  findEventTypesInObj,
  PULL_REQUEST_TIMEOUT_MS,
  redactUrl,
  soapFaultSummary,
} from './pullPoint';
import { buildDigestRetryInit, warnDigestOverHttpOnce } from './digestAuth';
import { logDebug, logError, logInfo, logWarn } from '../logger';
import {
  selectAuthMethods,
  logAuthCapabilities,
  logAuthStrategy,
  logAuthSuccess,
  logAuthFailure,
  type SecurityCapabilities,
} from './authStrategy';

const log = debug('push');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', allowBooleanAttributes: true });
const PUSH_SUBSCRIPTION_TERMINATION = 'PT24H';

export interface PushSubscriptionResult {
  ok: boolean;
  // Subscription address reported by the camera; null when the response omits one
  // (the keep-alive then renews against the events xaddr).
  address?: string | null;
  currentTimeMs?: number | null;
  terminationTimeMs?: number | null;
}

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

    // Some clients include query strings or absolute-form URLs; normalize to pathname for matching.
    let requestPath = req.url;
    try {
      requestPath = new URL(req.url, 'http://localhost').pathname;
    } catch {
      requestPath = req.url.split('?')[0];
    }

    // only accept POSTs under basePath
    if (!requestPath.startsWith(basePath)) {
      logError(`[ERROR] Rejected ONVIF notify path receivedPath=${requestPath} expectedPrefix=${basePath}`);
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
        const cam = manager.getCameraByNotifyPath(requestPath);
        if (cam) {
          for (const e of evs) {
            try {
              await cam.handleEvent({ type: e.type, state: e.state });
            } catch (err) {
              log('notify handleEvent failed', err);
            }
          }
        } else {
          log('No matching camera for notify path', requestPath);
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

export async function createPushSubscription(
  eventsXaddr: string,
  cfg: CameraConfig,
  notifyUrl: string,
  requestTimeoutMs = PULL_REQUEST_TIMEOUT_MS,
): Promise<PushSubscriptionResult> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
  <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
    <s:Body>
      <tev:CreateSubscription xmlns:tev="http://www.onvif.org/ver10/events/wsdl">
        <tev:InitialTerminationTime>${PUSH_SUBSCRIPTION_TERMINATION}</tev:InitialTerminationTime>
        <tev:NotifyTo xmlns:wsa="http://www.w3.org/2005/08/addressing">
          <wsa:EndpointReference>
            <wsa:Address>${notifyUrl}</wsa:Address>
          </wsa:EndpointReference>
        </tev:NotifyTo>
      </tev:CreateSubscription>
    </s:Body>
  </s:Envelope>`;

  const headers: Record<string, string> = { 'Content-Type': 'application/soap+xml; charset=utf-8' };
  const hasCreds = Boolean(cfg.username && cfg.password);
  const isHttpsUrl = /^https:\/\//i.test(eventsXaddr);

  try {
    const fetcher = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!fetcher) throw new Error('Global fetch is not available');

    // For push mode, use default capabilities assumption (most devices support both WS-Security and Basic)
    const defaultCaps: SecurityCapabilities = {
      usernameToken: true,
      httpDigest: false,
      tlsSupported: isHttpsUrl,
      basicAuth: true,
    };

    if (hasCreds) {
      logAuthCapabilities(cfg.name, defaultCaps, isHttpsUrl);
      const methods = selectAuthMethods(defaultCaps, cfg, isHttpsUrl);
      logAuthStrategy(cfg.name, methods, isHttpsUrl);

      // For push, try Basic auth (WS-Security not typically supported in push notifications)
      const auth = basicAuthHeader(cfg);
      if (auth) {
        headers.Authorization = auth;
      }

      if (/^http:\/\//i.test(eventsXaddr) && auth) {
        logWarn(`[WARN] Falling back to Basic auth over non-TLS camera=${cfg.name} url=${eventsXaddr}`);
      }
    }

    const init = { method: 'POST', headers, body };
    let r: Awaited<ReturnType<typeof fetchWithTimeout>>;
    try {
      r = await fetchWithTimeout(fetcher, eventsXaddr, init, requestTimeoutMs);
    } catch (err) {
      log('createPushSubscription error', err);
      logError('[ERROR] CreateSubscription request failed', err);
      return { ok: false };
    }
    const txt = await r.text();
    const snippet = txt.slice(0, 200);
    log('createPushSubscription response', snippet);

    if (!r.ok) {
      if (hasCreds) {
        logAuthFailure(cfg.name, 'basic', r.status);
      }

      // Digest retry: some cameras challenge with 401 + WWW-Authenticate: Digest only.
      const digestInit = buildDigestRetryInit(init, cfg, r.headers['www-authenticate'] ?? '', eventsXaddr);
      if (digestInit) {
        warnDigestOverHttpOnce(cfg.name, eventsXaddr);
        try {
          const digestResp = await fetchWithTimeout(fetcher, eventsXaddr, digestInit, requestTimeoutMs);
          const digestTxt = await digestResp.text();
          if (digestResp.ok && !/<\s*(?:\w+:)?fault\b/i.test(digestTxt)) {
            if (hasCreds) {
              logAuthSuccess(cfg.name, 'digest');
            }
            log('createPushSubscription digest response', digestTxt.slice(0, 200));
            const obj = parser.parse(digestTxt);
            const timing = extractSubscriptionTimingFromResponse(obj, 'CreateSubscriptionResponse');
            return {
              ok: true,
              address: extractSubscriptionAddressFromResponse(obj, eventsXaddr),
              currentTimeMs: timing.currentTimeMs,
              terminationTimeMs: timing.terminationTimeMs,
            };
          }
          logDebug(`[DEBUG] CreateSubscription Digest attempt failed camera=${cfg.name} status=${digestResp.status} body=${digestTxt.slice(0, 200)}`);
        } catch (err) {
          logDebug(`[DEBUG] CreateSubscription Digest attempt error camera=${cfg.name}`, err);
        }
      }

      logWarn(`[WARN] CreateSubscription failed status=${r.status} body=${snippet}`);
      return { ok: false };
    }

    if (/<\s*(?:\w+:)?fault\b/i.test(txt)) {
      if (hasCreds) {
        logAuthFailure(cfg.name, 'basic', r.status, 'soap_fault');
      }
      logError(`[ERROR] CreateSubscription returned SOAP Fault status=${r.status} body=${snippet}`);
      return { ok: false };
    }

    if (hasCreds) {
      logAuthSuccess(cfg.name, 'basic');
    }

    let address: string | null = null;
    let currentTimeMs: number | null = null;
    let terminationTimeMs: number | null = null;
    try {
      const obj = parser.parse(txt);
      address = extractSubscriptionAddressFromResponse(obj, eventsXaddr);
      const timing = extractSubscriptionTimingFromResponse(obj, 'CreateSubscriptionResponse');
      currentTimeMs = timing.currentTimeMs;
      terminationTimeMs = timing.terminationTimeMs;
    } catch (err) {
      logDebug(`[DEBUG] CreateSubscription response parse warning camera=${cfg.name}`, err);
    }

    return { ok: true, address, currentTimeMs, terminationTimeMs };
  } catch (err) {
    log('createPushSubscription error', err);
    logError('[ERROR] CreateSubscription request failed', err);
    return { ok: false };
  }
}

export async function renewPushSubscription(
  subAddr: string,
  cfg: CameraConfig,
  requestTimeoutMs = PULL_REQUEST_TIMEOUT_MS,
): Promise<{ currentTimeMs: number | null; terminationTimeMs: number | null } | null> {
  const bodyInner = `<wsnt:Renew xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">
        <wsnt:TerminationTime>${PUSH_SUBSCRIPTION_TERMINATION}</wsnt:TerminationTime>
      </wsnt:Renew>`;
  const action = 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest';
  const headerVariants: Array<{ name: string; headers: Record<string, string> }> = [
    {
      name: 'soap12-action-content-type',
      headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"` },
    },
    {
      name: 'soap12-soapaction-header',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', SOAPAction: action },
    },
    {
      name: 'soap11-soapaction-header',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${action}"` },
    },
    {
      name: 'soap12-basic',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    },
  ];

  const auth = basicAuthHeader(cfg);
  const requestVariants = cfg.username && cfg.password
    ? [
        { name: 'wsse', useWsse: true },
        { name: 'basic', useWsse: false },
      ]
    : [
        { name: 'basic', useWsse: false },
      ];

  try {
    const fetcher = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!fetcher) throw new Error('Global fetch is not available');

    const attemptFailures: string[] = [];

    for (const variant of headerVariants) {
      for (const req of requestVariants) {
        if (req.useWsse && (!cfg.username || !cfg.password)) continue;

        const headers = { ...variant.headers };
        if (!req.useWsse && auth) {
          if (/^http:\/\//i.test(subAddr)) {
            logWarn(`[WARN] Falling back to Basic auth over non-TLS camera=${cfg.name} url=${redactUrl(subAddr)}`);
          }
          headers.Authorization = auth;
        }

        const body = buildSoapEnvelope(bodyInner, cfg, req.useWsse);
        const init = { method: 'POST', headers, body };
        const attempt = `${variant.name}/${req.name}`;

        let response: Awaited<ReturnType<typeof fetchWithTimeout>>;
        try {
          response = await fetchWithTimeout(fetcher, subAddr, init, requestTimeoutMs);
        } catch (err) {
          const msg = `variant=${attempt} fetchError=${(err as Error)?.message || String(err)}`;
          attemptFailures.push(msg);
          logDebug(`[DEBUG] RenewPushSubscription request error camera=${cfg.name} url=${redactUrl(subAddr)} ${msg}`);
          continue;
        }

        const txt = await response.text();
        if (!response.ok) {
          const fault = soapFaultSummary(txt);
          const msg = `variant=${attempt} status=${response.status} fault=${fault || 'n/a'}`;
          attemptFailures.push(msg);
          logDebug(`[DEBUG] RenewPushSubscription attempt failed camera=${cfg.name} url=${redactUrl(subAddr)} ${msg}`);
          continue;
        }

        const okFault = soapFaultSummary(txt);
        if (okFault) {
          const msg = `variant=${attempt} status=${response.status} fault=${okFault}`;
          attemptFailures.push(msg);
          logDebug(`[DEBUG] RenewPushSubscription SOAP fault (retrying) camera=${cfg.name} url=${redactUrl(subAddr)} ${msg}`);
          continue;
        }

        const obj = parser.parse(txt);
        const timing = extractSubscriptionTimingFromResponse(obj, 'RenewResponse');
        if (timing.terminationTimeMs) {
          if (attemptFailures.length > 0) {
            logDebug(`[DEBUG] RenewPushSubscription connected using fallback camera=${cfg.name} finalVariant=${attempt} priorFailures=${attemptFailures.length}`);
          }
          return timing;
        }

        logDebug(`[DEBUG] RenewPushSubscription response missing termination time camera=${cfg.name} variant=${attempt} body=${txt.slice(0, 300)}`);
        return {
          currentTimeMs: timing.currentTimeMs,
          terminationTimeMs: null,
        };
      }
    }

    logWarn(`[WARN] RenewPushSubscription exhausted all fallbacks camera=${cfg.name} url=${redactUrl(subAddr)} failureCount=${attemptFailures.length}`);
    return null;
  } catch (err) {
    logWarn(`[WARN] RenewPushSubscription request failed camera=${cfg.name} url=${redactUrl(subAddr)}`, err);
    log('renewPushSubscription error', err);
    return null;
  }
}
