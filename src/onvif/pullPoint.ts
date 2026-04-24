import { XMLParser } from 'fast-xml-parser';
import debug from 'debug';
import { createHash, randomBytes } from 'crypto';
import { CameraConfig } from '../types';
import { logDebug, logError, logInfo, logWarn } from '../logger';

const log = debug('pullpoint');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', allowBooleanAttributes: true });

const TOPIC_TO_EVENT: Record<string, 'motion' | 'people' | 'line' | 'tplink'> = {
  'RuleEngine/MotionRegionDetector/Motion': 'motion',
  'RuleEngine/MotionRegionDetector/Motion//.': 'motion',
  'RuleEngine/CellMotionDetector/Motion': 'motion',
  'RuleEngine/CellMotionDetector/Motion//.': 'motion',
  'VideoSoure/MotionAlarm': 'motion',
  'VideoSource/MotionAlarm': 'motion',
  'RuleEngine/PeopleDetector/People': 'people',
  'RuleEngine/PeopleDetector/People//.': 'people',
  'RuleEngine/LineCrossDetector/LineCross': 'line',
  'RuleEngine/LineCrossDetector/LineCross//.': 'line',
  'RuleEngine/TPSmartEventDetector/TPSmartEvent': 'tplink',
};

function stripNs(name: string) {
  const idx = name.indexOf(':');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

function toBoolOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'off') return false;
  return undefined;
}

function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch {
    return raw;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildWsseSecurityHeader(cfg: CameraConfig): string {
  if (!cfg.username || !cfg.password) return '';

  const nonceBytes = randomBytes(16);
  const nonceB64 = nonceBytes.toString('base64');
  const created = new Date().toISOString();
  const digest = createHash('sha1')
    .update(Buffer.concat([nonceBytes, Buffer.from(created, 'utf8'), Buffer.from(cfg.password, 'utf8')]))
    .digest('base64');

  return `
    <wsse:Security s:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>${escapeXml(cfg.username)}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
        <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceB64}</wsse:Nonce>
        <wsu:Created>${created}</wsu:Created>
      </wsse:UsernameToken>
    </wsse:Security>`;
}

function buildSoapEnvelope(bodyInnerXml: string, cfg: CameraConfig, useWsse: boolean): string {
  const security = useWsse ? buildWsseSecurityHeader(cfg) : '';
  const header = security ? `<s:Header>${security}</s:Header>` : '';

  return `<?xml version="1.0" encoding="utf-8"?>
  <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
    ${header}
    <s:Body>
      ${bodyInnerXml}
    </s:Body>
  </s:Envelope>`;
}

function buildDeviceServiceUrl(cfg: CameraConfig): string {
  if (!cfg.host || typeof cfg.port !== 'number') {
    throw new Error(`Camera ${cfg.name}: host and port are required for ONVIF pull events`);
  }

  const host = String(cfg.host).trim();
  const scheme = host.startsWith('http://') || host.startsWith('https://') ? '' : 'http://';
  const baseHost = `${scheme}${host.replace(/\/$/, '')}`;
  return `${baseHost}:${cfg.port}/onvif/device_service`;
}

function normalizeTopic(topic: string): string {
  const trimmed = topic.trim();
  const idx = trimmed.indexOf(':');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function textFromUnknown(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;

  const rec = value as Record<string, unknown>;
  if (typeof rec._ === 'string') return rec._;
  if (typeof rec['#text'] === 'string') return rec['#text'];

  for (const v of Object.values(rec)) {
    if (typeof v === 'string') return v;
  }
  return null;
}

function collectAllByLocalName(node: unknown, localName: string, out: unknown[]) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectAllByLocalName(item, localName, out);
    return;
  }
  if (typeof node !== 'object') return;

  const rec = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    if (stripNs(k) === localName) {
      out.push(v);
    }
    if (typeof v === 'object') {
      collectAllByLocalName(v, localName, out);
    }
  }
}

function findEventXaddrCandidates(parsedXml: unknown): string[] {
  const results = new Set<string>();
  const eventsBlocks: unknown[] = [];
  collectAllByLocalName(parsedXml, 'Events', eventsBlocks);

  for (const block of eventsBlocks) {
    const xaddrs: unknown[] = [];
    collectAllByLocalName(block, 'XAddr', xaddrs);
    for (const x of xaddrs) {
      const s = textFromUnknown(x);
      if (s && /^https?:\/\//i.test(s)) results.add(s);
    }
  }

  // Fallback: gather all XAddr values and prefer event-like paths.
  if (results.size === 0) {
    const allXaddrs: unknown[] = [];
    collectAllByLocalName(parsedXml, 'XAddr', allXaddrs);
    for (const x of allXaddrs) {
      const s = textFromUnknown(x);
      if (s && /^https?:\/\//i.test(s)) results.add(s);
    }
  }

  return Array.from(results);
}

function pickBestEventXaddr(candidates: string[]): string | null {
  if (candidates.length === 0) return null;

  const preferred = candidates.find((u) => /event/i.test(u));
  if (preferred) return preferred;

  return candidates[0] || null;
}

function soapFaultSummary(xml: string): string | null {
  try {
    const parsed = parser.parse(xml) as Record<string, unknown>;
    const faultNodes: unknown[] = [];
    collectAllByLocalName(parsed, 'Fault', faultNodes);
    if (faultNodes.length === 0) return null;

    const fault = faultNodes[0] as Record<string, unknown>;
    const reasonNodes: unknown[] = [];
    collectAllByLocalName(fault, 'Reason', reasonNodes);
    const codeNodes: unknown[] = [];
    collectAllByLocalName(fault, 'Code', codeNodes);

    let reasonText = '';
    if (reasonNodes.length > 0) {
      const textNodes: unknown[] = [];
      collectAllByLocalName(reasonNodes[0], 'Text', textNodes);
      reasonText = textNodes.map((n) => textFromUnknown(n)).find((t) => typeof t === 'string' && t.length > 0) || '';
    }

    let codeText = '';
    if (codeNodes.length > 0) {
      const valueNodes: unknown[] = [];
      collectAllByLocalName(codeNodes[0], 'Value', valueNodes);
      codeText = valueNodes.map((n) => textFromUnknown(n)).find((t) => typeof t === 'string' && t.length > 0) || '';
    }

    const detailNodes: unknown[] = [];
    collectAllByLocalName(fault, 'Detail', detailNodes);
    const detailText = detailNodes.length > 0 ? JSON.stringify(detailNodes[0]).slice(0, 300) : '';

    const parts = [codeText, reasonText, detailText].filter((p) => p && p.length > 0);
    return parts.length > 0 ? parts.join(' | ') : null;
  } catch {
    return null;
  }
}

function resolveMaybeRelativeUrl(urlOrPath: string, baseUrl: string): string {
  try {
    return new URL(urlOrPath, baseUrl).toString();
  } catch {
    return urlOrPath;
  }
}

function extractSubscriptionAddressFromResponse(parsed: unknown, baseUrl: string): string | null {
  // Preferred: CreatePullPointSubscriptionResponse -> SubscriptionReference -> Address
  const responseNodes: unknown[] = [];
  collectAllByLocalName(parsed, 'CreatePullPointSubscriptionResponse', responseNodes);
  for (const resp of responseNodes) {
    const subRefNodes: unknown[] = [];
    collectAllByLocalName(resp, 'SubscriptionReference', subRefNodes);
    for (const subRef of subRefNodes) {
      const addrNodes: unknown[] = [];
      collectAllByLocalName(subRef, 'Address', addrNodes);
      for (const a of addrNodes) {
        const txt = textFromUnknown(a);
        if (txt && txt.length > 0) {
          return resolveMaybeRelativeUrl(txt, baseUrl);
        }
      }
    }
  }

  // Fallback: any Address field in response payload
  const allAddrNodes: unknown[] = [];
  collectAllByLocalName(parsed, 'Address', allAddrNodes);
  for (const a of allAddrNodes) {
    const txt = textFromUnknown(a);
    if (txt && txt.length > 0) {
      return resolveMaybeRelativeUrl(txt, baseUrl);
    }
  }

  return null;
}

function collectSimpleItems(node: unknown, out: Record<string, unknown>) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const v of node) collectSimpleItems(v, out);
    return;
  }

  if (typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;

  const name = rec['@Name'] ?? rec.Name;
  const value = rec['@Value'] ?? rec.Value;
  if (typeof name === 'string') {
    out[name] = value;
  }

  for (const [k, v] of Object.entries(rec)) {
    const key = stripNs(k);
    if (key === 'SimpleItem') {
      if (Array.isArray(v)) {
        for (const item of v) collectSimpleItems(item, out);
      } else {
        collectSimpleItems(v, out);
      }
      continue;
    }

    if (key === 'State' || /^Is[A-Za-z]+$/.test(key)) {
      out[key] = v;
    }

    if (typeof v === 'object') {
      collectSimpleItems(v, out);
    }
  }
}

function findTopicInObject(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const rec = node as Record<string, unknown>;

  for (const [k, v] of Object.entries(rec)) {
    if (stripNs(k) === 'Topic') {
      const text = textFromUnknown(v);
      if (text) return text;
    }
  }

  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object') {
      const nested = findTopicInObject(v);
      if (nested) return nested;
    }
  }

  return null;
}

function findTopicDirect(rec: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(rec)) {
    if (stripNs(k) === 'Topic') {
      const text = textFromUnknown(v);
      if (text) return text;
    }
  }
  return null;
}

function collectNotificationNodes(node: unknown, out: Record<string, unknown>[]) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const v of node) collectNotificationNodes(v, out);
    return;
  }

  if (typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;

  const topic = findTopicDirect(rec);
  if (topic) {
    out.push(rec);
    return;
  }

  for (const [k, v] of Object.entries(rec)) {
    if (stripNs(k) === 'NotificationMessage') {
      collectNotificationNodes(v, out);
      continue;
    }
    if (v && typeof v === 'object') collectNotificationNodes(v, out);
  }
}

function basicAuthHeader(cfg: CameraConfig) {
  if (!cfg.username) return undefined;
  const token = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  return `Basic ${token}`;
}

export async function getEventsXaddr(cfg: CameraConfig): Promise<string | null> {
  let url = '';
  try {
    url = buildDeviceServiceUrl(cfg);
  } catch (err) {
    logError('[ERROR] Pull discovery configuration error:', err);
    return null;
  }

  const bodyInner = `<tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
        <tds:Category>All</tds:Category>
      </tds:GetCapabilities>`;

  const headers: Record<string, string> = { 'Content-Type': 'application/soap+xml; charset=utf-8' };
  const auth = basicAuthHeader(cfg);
  const hasCreds = Boolean(cfg.username && cfg.password);

  try {
    const fetcher = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!fetcher) throw new Error('Global fetch is not available');

    const parseCandidates = (xml: string) => {
      const obj = parser.parse(xml);
      const candidates = findEventXaddrCandidates(obj);
      const selected = pickBestEventXaddr(candidates);
      return { candidates, selected };
    };

    if (hasCreds) {
      // Security-first: try WS-Security UsernameToken before Basic auth fallback.
      const wsseBody = buildSoapEnvelope(bodyInner, cfg, true);
      const wsseInit = { method: 'POST', headers, body: wsseBody };
      const wsseResp = await fetcher(url, wsseInit as { method?: string; headers?: Record<string,string>; body?: string });
      const wsseTxt = await wsseResp.text();
      const wsseFault = soapFaultSummary(wsseTxt);

      if (wsseResp.ok && !wsseFault) {
        const wsseParsed = parseCandidates(wsseTxt);
        if (wsseParsed.selected) {
          if (!/event/i.test(wsseParsed.selected)) {
            logDebug(`[DEBUG] Events XAddr fallback selected camera=${cfg.name} xaddr=${redactUrl(wsseParsed.selected)} candidates=${wsseParsed.candidates.map((c) => redactUrl(c)).join(',')}`);
          }
          return wsseParsed.selected;
        }
      } else {
        logDebug(`[DEBUG] GetCapabilities WSSE attempt failed camera=${cfg.name} url=${redactUrl(url)} status=${wsseResp.status} fault=${wsseFault || 'n/a'}`);
      }

      if (auth && /^http:\/\//i.test(url)) {
        logWarn(`[WARN] Falling back to Basic auth over non-TLS camera=${cfg.name} url=${redactUrl(url)}`);
      }

      const basicHeaders: Record<string, string> = { ...headers };
      if (auth) basicHeaders.Authorization = auth;
      const basicBody = buildSoapEnvelope(bodyInner, cfg, false);
      const basicInit = { method: 'POST', headers: basicHeaders, body: basicBody };
      const basicResp = await fetcher(url, basicInit as { method?: string; headers?: Record<string,string>; body?: string });
      const basicTxt = await basicResp.text();
      const basicFault = soapFaultSummary(basicTxt);

      if (!basicResp.ok || basicFault) {
        logError(`[ERROR] GetCapabilities failed camera=${cfg.name} url=${redactUrl(url)} status=${basicResp.status} fault=${basicFault || 'n/a'} body=${basicTxt.slice(0, 300)}`);
        return null;
      }

      const basicParsed = parseCandidates(basicTxt);
      if (basicParsed.selected) {
        if (!/event/i.test(basicParsed.selected)) {
          logDebug(`[DEBUG] Events XAddr fallback selected camera=${cfg.name} xaddr=${redactUrl(basicParsed.selected)} candidates=${basicParsed.candidates.map((c) => redactUrl(c)).join(',')}`);
        }
        logDebug(`[DEBUG] GetCapabilities connected using Basic fallback camera=${cfg.name}`);
        return basicParsed.selected;
      }
      return null;
    }

    const body = buildSoapEnvelope(bodyInner, cfg, false);
    const init = { method: 'POST', headers, body };
    const r = await fetcher(url, init as { method?: string; headers?: Record<string,string>; body?: string });
    const txt = await r.text();
    const fault = soapFaultSummary(txt);
    if (!r.ok || fault) {
      logError(`[ERROR] GetCapabilities failed camera=${cfg.name} url=${redactUrl(url)} status=${r.status} fault=${fault || 'n/a'} body=${txt.slice(0, 300)}`);
      return null;
    }
    const parsed = parseCandidates(txt);
    if (parsed.selected) {
      if (!/event/i.test(parsed.selected)) {
        logDebug(`[DEBUG] Events XAddr fallback selected camera=${cfg.name} xaddr=${redactUrl(parsed.selected)} candidates=${parsed.candidates.map((c) => redactUrl(c)).join(',')}`);
      }
      return parsed.selected;
    }
    return null;
  } catch (err) {
    logError(`[ERROR] GetCapabilities request failed camera=${cfg.name} url=${redactUrl(url)}`, err);
    log('getEventsXaddr error', err);
    return null;
  }
}

async function createPullPointSubscription(eventsXaddr: string, cfg: CameraConfig): Promise<string | null> {
  const bodyWithTermination = `<tev:CreatePullPointSubscription xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">
        <wsnt:InitialTerminationTime>PT1H</wsnt:InitialTerminationTime>
      </tev:CreatePullPointSubscription>`;
  const bodyMinimal = `<tev:CreatePullPointSubscription xmlns:tev="http://www.onvif.org/ver10/events/wsdl" />`;

  const action = 'http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionRequest';
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

  try {
    const fetcher = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!fetcher) throw new Error('Global fetch is not available');

    const requestVariants = cfg.username && cfg.password
      ? [
          { name: 'wsse-with-termination', bodyInner: bodyWithTermination, useWsse: true },
          { name: 'wsse-minimal', bodyInner: bodyMinimal, useWsse: true },
          { name: 'basic-with-termination', bodyInner: bodyWithTermination, useWsse: false },
          { name: 'basic-minimal', bodyInner: bodyMinimal, useWsse: false },
        ]
      : [
          { name: 'basic-with-termination', bodyInner: bodyWithTermination, useWsse: false },
          { name: 'basic-minimal', bodyInner: bodyMinimal, useWsse: false },
        ];

    const attemptFailures: string[] = [];
    let warnedBasicOverHttp = false;

    for (const variant of headerVariants) {
      for (const req of requestVariants) {
        if (req.useWsse && (!cfg.username || !cfg.password)) continue;

        const headers = { ...variant.headers };
        if (!req.useWsse && auth) {
          if (!warnedBasicOverHttp && /^http:\/\//i.test(eventsXaddr)) {
            warnedBasicOverHttp = true;
            logWarn(`[WARN] Falling back to Basic auth over non-TLS camera=${cfg.name} url=${redactUrl(eventsXaddr)}`);
          }
          headers.Authorization = auth;
        }

        const body = buildSoapEnvelope(req.bodyInner, cfg, req.useWsse);
        const init = { method: 'POST', headers, body };
        const r = await fetcher(eventsXaddr, init as { method?: string; headers?: Record<string,string>; body?: string });
        const txt = await r.text();
        const attempt = `${variant.name}/${req.name}`;

        if (!r.ok) {
          const fault = soapFaultSummary(txt);
          const msg = `variant=${attempt} status=${r.status} fault=${fault || 'n/a'}`;
          attemptFailures.push(msg);
          logDebug(`[DEBUG] CreatePullPointSubscription attempt failed camera=${cfg.name} url=${redactUrl(eventsXaddr)} ${msg}`);
          continue;
        }

        // Some cameras return SOAP Fault with HTTP 200.
        const okFault = soapFaultSummary(txt);
        if (okFault) {
          const msg = `variant=${attempt} status=${r.status} fault=${okFault}`;
          attemptFailures.push(msg);
          logDebug(`[DEBUG] CreatePullPointSubscription SOAP fault (retrying) camera=${cfg.name} url=${redactUrl(eventsXaddr)} ${msg}`);
          continue;
        }

        const obj = parser.parse(txt);
        const addr = extractSubscriptionAddressFromResponse(obj, eventsXaddr);
        if (addr) {
          if (attemptFailures.length > 0) {
            logDebug(`[DEBUG] CreatePullPointSubscription connected using fallback camera=${cfg.name} finalVariant=${attempt} priorFailures=${attemptFailures.length}`);
          }
          return addr;
        }

        // Some cameras omit explicit SubscriptionReference Address and expect PullMessages on Events XAddr.
        if (attemptFailures.length > 0) {
          logDebug(`[DEBUG] CreatePullPointSubscription using events xaddr fallback after prior failures camera=${cfg.name} finalVariant=${attempt} priorFailures=${attemptFailures.length}`);
        }
        logDebug(`[DEBUG] CreatePullPointSubscription response missing subscription address camera=${cfg.name} variant=${attempt} using events xaddr fallback=${redactUrl(eventsXaddr)} body=${txt.slice(0, 300)}`);
        return eventsXaddr;
      }
    }

    logError(`[ERROR] CreatePullPointSubscription exhausted all fallbacks camera=${cfg.name} url=${redactUrl(eventsXaddr)} failureCount=${attemptFailures.length}`);

    return null;
  } catch (err) {
    logError(`[ERROR] CreatePullPointSubscription request failed camera=${cfg.name} url=${redactUrl(eventsXaddr)}`, err);
    log('createPullPointSubscription error', err);
    return null;
  }
}

async function pullMessagesOnce(subAddr: string, cfg: CameraConfig): Promise<string | null> {
  const bodyInner = `<tev:PullMessages xmlns:tev="http://www.onvif.org/ver10/events/wsdl">
        <tev:Timeout>PT2S</tev:Timeout>
        <tev:MessageLimit>10</tev:MessageLimit>
      </tev:PullMessages>
`;

  const headers: Record<string, string> = { 'Content-Type': 'application/soap+xml; charset=utf-8' };
  const auth = basicAuthHeader(cfg);
  const hasCreds = Boolean(cfg.username && cfg.password);

  try {
    const fetcher = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!fetcher) throw new Error('Global fetch is not available');
    if (hasCreds) {
      const wsseBody = buildSoapEnvelope(bodyInner, cfg, true);
      const wsseInit = { method: 'POST', headers, body: wsseBody };
      const wsseResp = await fetcher(subAddr, wsseInit as { method?: string; headers?: Record<string,string>; body?: string });
      const wsseTxt = await wsseResp.text();
      const wsseFault = soapFaultSummary(wsseTxt);
      if (wsseResp.ok && !wsseFault) return wsseTxt;

      logDebug(`[DEBUG] PullMessages WSSE attempt failed camera=${cfg.name} url=${redactUrl(subAddr)} status=${wsseResp.status} fault=${wsseFault || 'n/a'}`);

      if (auth && /^http:\/\//i.test(subAddr)) {
        logWarn(`[WARN] Falling back to Basic auth over non-TLS camera=${cfg.name} url=${redactUrl(subAddr)}`);
      }

      const basicHeaders: Record<string, string> = { ...headers };
      if (auth) basicHeaders.Authorization = auth;
      const basicBody = buildSoapEnvelope(bodyInner, cfg, false);
      const basicInit = { method: 'POST', headers: basicHeaders, body: basicBody };
      const basicResp = await fetcher(subAddr, basicInit as { method?: string; headers?: Record<string,string>; body?: string });
      const basicTxt = await basicResp.text();
      const basicFault = soapFaultSummary(basicTxt);
      if (!basicResp.ok || basicFault) {
        logError(`[ERROR] PullMessages failed camera=${cfg.name} url=${redactUrl(subAddr)} status=${basicResp.status} fault=${basicFault || 'n/a'} body=${basicTxt.slice(0, 300)}`);
        return null;
      }
      logDebug(`[DEBUG] PullMessages connected using Basic fallback camera=${cfg.name} url=${redactUrl(subAddr)}`);
      return basicTxt;
    }

    const body = buildSoapEnvelope(bodyInner, cfg, false);
    const init = { method: 'POST', headers, body };
    const r = await fetcher(subAddr, init as { method?: string; headers?: Record<string,string>; body?: string });
    const txt = await r.text();
    const fault = soapFaultSummary(txt);
    if (!r.ok || fault) {
      logError(`[ERROR] PullMessages failed camera=${cfg.name} url=${redactUrl(subAddr)} status=${r.status} fault=${fault || 'n/a'} body=${txt.slice(0, 300)}`);
      return null;
    }
    return txt;
  } catch (err) {
    logError(`[ERROR] PullMessages request failed camera=${cfg.name} url=${redactUrl(subAddr)}`, err);
    log('pullMessagesOnce error', err);
    return null;
  }
}

interface RawEvent { type: string; state?: boolean | null }

export function findEventTypesInObj(obj: unknown): RawEvent[] {
  const matches: RawEvent[] = [];
  const notifications: Record<string, unknown>[] = [];
  collectNotificationNodes(obj, notifications);

  for (const note of notifications) {
    const rawTopic = findTopicInObject(note);
    if (!rawTopic) continue;

    const topic = normalizeTopic(rawTopic);
    const mapped = TOPIC_TO_EVENT[topic];

    const params: Record<string, unknown> = {};
    collectSimpleItems(note, params);

    if (!mapped) {
      logDebug(`[DEBUG] Unrecognized ONVIF event topic topic=${topic} params=${JSON.stringify(params)}`);
      continue;
    }

    if (mapped === 'tplink') {
      if (Object.prototype.hasOwnProperty.call(params, 'IsVehicle')) {
        matches.push({ type: 'vehicle', state: toBoolOrUndefined(params.IsVehicle) });
      } else if (Object.prototype.hasOwnProperty.call(params, 'IsPet')) {
        matches.push({ type: 'animal', state: toBoolOrUndefined(params.IsPet) });
      } else {
        logDebug(`[DEBUG] Unrecognized TPLink smart event topic=${topic} params=${JSON.stringify(params)}`);
      }
      continue;
    }

    if (mapped === 'motion') {
      const state = toBoolOrUndefined(params.IsMotion ?? params.State);
      matches.push({ type: 'motion', state });
      continue;
    }

    if (mapped === 'people') {
      const state = toBoolOrUndefined(params.IsPeople ?? params.State);
      matches.push({ type: 'people', state });
      continue;
    }

    if (mapped === 'line') {
      const state = toBoolOrUndefined(params.IsLineCross ?? params.State);
      matches.push({ type: 'line', state });
    }
  }

  return matches;
}

export async function startPullPoint(
  cfg: CameraConfig,
  cb: (event: { type: string; state?: boolean | null }) => void,
  hooks?: { onError?: (err: unknown) => void; onHealthy?: () => void }
) {
  const eventsXaddr = await getEventsXaddr(cfg);
  if (!eventsXaddr) {
    log('No Events XAddr found');
    throw new Error('No Events XAddr found');
  }
  log('Events XAddr', eventsXaddr);

  const subscriptionAddr = await createPullPointSubscription(eventsXaddr, cfg);
  if (!subscriptionAddr) {
    log('Failed to create PullPoint subscription');
    throw new Error('Failed to create PullPoint subscription');
  }
  logInfo(`[INFO] PullPoint subscription established camera=${cfg.name} subscription=${redactUrl(subscriptionAddr)}`);
  log('Subscription address', subscriptionAddr);

  let stopped = false;
  let healthyLogged = false;

  (async () => {
    while (!stopped) {
      try {
        const xml = await pullMessagesOnce(subscriptionAddr, cfg);
        if (xml) {
          if (!healthyLogged) {
            healthyLogged = true;
            logInfo(`[INFO] PullPoint polling healthy camera=${cfg.name}`);
          }
          hooks?.onHealthy?.();
          const obj = parser.parse(xml);
          const evTypes = findEventTypesInObj(obj);
          for (const et of evTypes) {
            cb({ type: et.type, state: et.state });
          }
        }
      } catch (err) {
        hooks?.onError?.(err);
        log('pull loop error', err);
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
  })();

  return {
    stop: () => {
      stopped = true;
    },
  };
}
