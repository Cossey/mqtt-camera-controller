import { XMLParser } from 'fast-xml-parser';
import debug from 'debug';
import { CameraConfig } from '../types';

const log = debug('pullpoint');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', allowBooleanAttributes: true });

function basicAuthHeader(cfg: CameraConfig) {
  if (!cfg.username) return undefined;
  const token = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  return `Basic ${token}`;
}

export async function getEventsXaddr(cfg: CameraConfig): Promise<string | null> {
  // Derive device_service URL from the configured snapshotUrl if available
  let baseHost: string | null = null;
  if (cfg.snapshot?.address) {
    try {
      const u = new URL(cfg.snapshot.address);
      baseHost = `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
    } catch (err) {
      baseHost = null;
    }
  }
  const url = baseHost ? `${baseHost}/onvif/device_service` : null;
  const body = `<?xml version="1.0" encoding="utf-8"?>
  <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
    <s:Body>
      <tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
        <tds:Category>All</tds:Category>
      </tds:GetCapabilities>
    </s:Body>
  </s:Envelope>`;

  const headers: Record<string, string> = { 'Content-Type': 'application/soap+xml; charset=utf-8' };
  const auth = basicAuthHeader(cfg);
  if (auth) headers.Authorization = auth;

  try {
    if (!url) throw new Error('No base device URL available to query GetCapabilities');
    const fetcher = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!fetcher) throw new Error('Global fetch is not available');
    const init = { method: 'POST', headers, body };
    const r = await fetcher(url, init as { method?: string; headers?: Record<string,string>; body?: string });
    const txt = await r.text();
    const obj = parser.parse(txt);
    // Try to find Capabilities -> Events -> XAddr in response
    const caps = obj?.['s:Envelope']?.['s:Body']?.['tds:GetCapabilitiesResponse']?.['tds:Capabilities'];
    const events = caps?.['tev:Events'] || caps?.['Events'];
    const xaddr = events?.['tev:XAddr'] || events?.['XAddr'];
    if (xaddr) return xaddr;

    // fallback: try to search for any XAddr in parsed object
    const found = JSON.stringify(obj).match(/https?:\/\/[^"'\s>]+/);
    return found ? found[0] : null;
  } catch (err) {
    log('getEventsXaddr error', err);
    return null;
  }
}

async function createPullPointSubscription(eventsXaddr: string, cfg: CameraConfig): Promise<string | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
  <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
    <s:Body>
      <tev:CreatePullPointSubscription xmlns:tev="http://www.onvif.org/ver10/events/wsdl" />
    </s:Body>
  </s:Envelope>`;

  const headers: Record<string, string> = { 'Content-Type': 'application/soap+xml; charset=utf-8' };
  const auth = basicAuthHeader(cfg);
  if (auth) headers.Authorization = auth;

  try {
    const fetcher = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!fetcher) throw new Error('Global fetch is not available');
    const init = { method: 'POST', headers, body };
    const r = await fetcher(eventsXaddr, init as { method?: string; headers?: Record<string,string>; body?: string });
    const txt = await r.text();
    const obj = parser.parse(txt);
    const addr = obj?.['s:Envelope']?.['s:Body']?.['tev:CreatePullPointSubscriptionResponse']?.['tev:SubscriptionReference']?.['wsa:Address']
      || obj?.['s:Envelope']?.['s:Body']?.['tev:CreatePullPointSubscriptionResponse']?.['tev:SubscriptionReference']?.['Address'];
    return addr || null;
  } catch (err) {
    log('createPullPointSubscription error', err);
    return null;
  }
}

async function pullMessagesOnce(subAddr: string, cfg: CameraConfig): Promise<string | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
  <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
    <s:Body>
      <tev:PullMessages xmlns:tev="http://www.onvif.org/ver10/events/wsdl">
        <tev:Timeout>PT2S</tev:Timeout>
        <tev:MessageLimit>10</tev:MessageLimit>
      </tev:PullMessages>
    </s:Body>
  </s:Envelope>`;

  const headers: Record<string, string> = { 'Content-Type': 'application/soap+xml; charset=utf-8' };
  const auth = basicAuthHeader(cfg);
  if (auth) headers.Authorization = auth;

  try {
    const fetcher = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (!fetcher) throw new Error('Global fetch is not available');
    const init = { method: 'POST', headers, body };
    const r = await fetcher(subAddr, init as { method?: string; headers?: Record<string,string>; body?: string });
    const txt = await r.text();
    return txt;
  } catch (err) {
    log('pullMessagesOnce error', err);
    return null;
  }
}

interface RawEvent { type: string; state?: boolean | null }

export function findEventTypesInObj(obj: unknown): RawEvent[] {
  const matches: RawEvent[] = [];

  const tryPush = (type: string, state?: boolean | null) => {
    if (!type) return;
    type = type.toLowerCase();
    if (type.includes('linecross') || type.includes('line')) type = 'line';
    else if (type.includes('person') || type.includes('people')) type = 'people';
    else if (type.includes('vehicle')) type = 'vehicle';
    else if (type.includes('pet') || type.includes('animal')) type = 'animal';
    else if (type.includes('motion')) type = 'motion';
    else return;

    // if an entry exists with same type, prefer explicit boolean state over undefined
    const exist = matches.find((m) => m.type === type);
    if (exist) {
      if ((exist.state === undefined || exist.state === null) && (state === true || state === false)) {
        exist.state = state;
      }
      return;
    }

    matches.push({ type, state });
  };

  const search = (item: unknown) => {
    if (!item) return;

    if (typeof item === 'string') {
      const s = item.toLowerCase();
      // if string contains explicit true/false, try extract
      const boolTrue = /\b(true|1)\b/.test(s);
      const boolFalse = /\b(false|0)\b/.test(s);
      if (/linecross|line/.test(s)) tryPush('line', boolTrue ? true : boolFalse ? false : undefined);
      if (/person|people/.test(s)) tryPush('people', boolTrue ? true : boolFalse ? false : undefined);
      if (/vehicle/.test(s)) tryPush('vehicle', boolTrue ? true : boolFalse ? false : undefined);
      if (/pet|animal/.test(s)) tryPush('animal', boolTrue ? true : boolFalse ? false : undefined);
      if (/motion/.test(s)) tryPush('motion', boolTrue ? true : boolFalse ? false : undefined);

    } else if (Array.isArray(item)) {
      for (const v of item) search(v);

    } else if (typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      // Many ONVIF messages use SimpleItem elements with @Name and @Value, or keys like IsMotion
      if (obj['@Name'] && obj['@Value']) {
        const name = String(obj['@Name']);
        const val = String(obj['@Value']).toLowerCase();
        const state = val === 'true' || val === '1' ? true : val === 'false' || val === '0' ? false : undefined;
        tryPush(name, state);
      }

      // Also detect keys like IsMotion: true
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (/Is[A-Za-z]+/.test(k)) {
          const name = k.replace(/^Is/, '');
          let state: boolean | null | undefined = undefined;
          if (typeof v === 'string') {
            const lv = v.toLowerCase();
            state = lv === 'true' || lv === '1' ? true : lv === 'false' || lv === '0' ? false : undefined;
          } else if (typeof v === 'boolean') state = v;
          tryPush(name, state === undefined ? null : state);
        }
        search(v);
      }
    }
  };

  search(obj);
  return matches;
}

export async function startPullPoint(cfg: CameraConfig, cb: (event: { type: string; state?: boolean | null }) => void) {
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
  log('Subscription address', subscriptionAddr);

  let stopped = false;

  (async () => {
    while (!stopped) {
      try {
        const xml = await pullMessagesOnce(subscriptionAddr, cfg);
        if (xml) {
          const obj = parser.parse(xml);
          const evTypes = findEventTypesInObj(obj);
          for (const et of evTypes) {
            cb({ type: et.type, state: et.state });
          }
        }
      } catch (err) {
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
