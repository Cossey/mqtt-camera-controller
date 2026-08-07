import { createHash } from 'crypto';
import { CameraConfig } from '../types';

/**
 * HTTP Digest Authentication (RFC 2617/7616)
 * Parses WWW-Authenticate: Digest challenges and computes Authorization responses.
 */

export interface DigestChallenge {
  realm: string;
  nonce: string;
  algorithm?: string; // MD5 (default), SHA-256, etc.
  opaque?: string;
  qop?: string; // auth, auth-int
  stale?: boolean;
}

export interface DigestAuthHeader {
  Authorization: string;
}

/**
 * Parse WWW-Authenticate header to extract Digest challenge parameters.
 * Example: WWW-Authenticate: Digest realm="MyRealm", nonce="abc123", algorithm=MD5, opaque="xyz", qop="auth"
 */
export function parseDigestChallenge(wwwAuthHeader: string): DigestChallenge | null {
  try {
    if (!/^\s*Digest\s+/i.test(wwwAuthHeader)) {
      return null; // Not a Digest challenge
    }

    const challenge: DigestChallenge = {
      realm: '',
      nonce: '',
    };

    // Extract realm (required)
    const realmMatch = wwwAuthHeader.match(/realm\s*=\s*"([^"]+)"/i);
    if (!realmMatch) return null;
    challenge.realm = realmMatch[1];

    // Extract nonce (required)
    const nonceMatch = wwwAuthHeader.match(/nonce\s*=\s*"([^"]+)"/i);
    if (!nonceMatch) return null;
    challenge.nonce = nonceMatch[1];

    // Extract optional parameters
    const algorithmMatch = wwwAuthHeader.match(/algorithm\s*=\s*"?([^\s,;"]+)"?/i);
    if (algorithmMatch) challenge.algorithm = algorithmMatch[1];

    const opaqueMatch = wwwAuthHeader.match(/opaque\s*=\s*"([^"]+)"/i);
    if (opaqueMatch) challenge.opaque = opaqueMatch[1];

    const qopMatch = wwwAuthHeader.match(/qop\s*=\s*"?([^\s,;"]+)"?/i);
    if (qopMatch) challenge.qop = qopMatch[1];

    const staleMatch = wwwAuthHeader.match(/stale\s*=\s*"?([^\s,;"]+)"?/i);
    if (staleMatch) challenge.stale = staleMatch[1].toLowerCase() === 'true';

    return challenge;
  } catch {
    return null;
  }
}

/**
 * Compute MD5 or SHA-256 hash.
 */
function hashPassword(password: string, algorithm?: string): string {
  const algo = algorithm?.toUpperCase() === 'SHA-256' ? 'sha256' : 'md5';
  return createHash(algo).update(password).digest('hex');
}

/**
 * Generate HTTP Digest Authorization response.
 * Supports both MD5 and SHA-256 algorithms.
 */
export function generateDigestAuthHeader(
  cfg: CameraConfig,
  challenge: DigestChallenge,
  method: string,
  uri: string,
  body?: string,
): DigestAuthHeader {
  const algorithm = challenge.algorithm?.toUpperCase() || 'MD5';
  const username = cfg.username || '';
  const password = cfg.password || '';
  const realm = challenge.realm;
  const nonce = challenge.nonce;
  const opaque = challenge.opaque || '';
  const qop = challenge.qop?.split(',')[0].trim() || ''; // Use first qop option if multiple

  // Compute ha1 (hash of username:realm:password)
  const ha1Input = `${username}:${realm}:${password}`;
  const ha1 = hashPassword(ha1Input, algorithm);

  // Compute ha2 (hash of method:uri)
  const ha2Input = `${method}:${uri}`;
  const ha2 = hashPassword(ha2Input, algorithm);

  // If qop is present, use cnonce and nc; otherwise use old-style (without qop)
  let responseInput: string;
  let authHeader: string;

  if (qop) {
    // MD5-sess is not widely supported by cameras, so we skip that variant
    const cnonce = createHash('md5').update(Math.random().toString()).digest('hex');
    const nc = '00000001';

    // response = H(ha1:nonce:nc:cnonce:qop:ha2)
    responseInput = `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`;
    const response = hashPassword(responseInput, algorithm);

    authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
    if (opaque) authHeader += `, opaque="${opaque}"`;
    if (algorithm && algorithm !== 'MD5') authHeader += `, algorithm=${algorithm}`;
  } else {
    // Legacy response (without qop)
    // response = H(ha1:nonce:ha2)
    responseInput = `${ha1}:${nonce}:${ha2}`;
    const response = hashPassword(responseInput, algorithm);

    authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
    if (opaque) authHeader += `, opaque="${opaque}"`;
    if (algorithm && algorithm !== 'MD5') authHeader += `, algorithm=${algorithm}`;
  }

  return { Authorization: authHeader };
}

/**
 * Execute a fetch request with HTTP Digest authentication.
 * Sends initial request; if 401 is received with Digest challenge, retries with computed auth.
 */
export async function fetchWithDigestAuth(
  fetcher: typeof fetch,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  cfg: CameraConfig,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  // First attempt without auth
  const method = init.method || 'GET';
  const firstResp = await fetcher(url, init as Parameters<typeof fetch>[1]);

  // If successful, return
  if (firstResp.ok) {
    return firstResp as { ok: boolean; status: number; text: () => Promise<string> };
  }

  // If 401, try to extract Digest challenge
  if (firstResp.status === 401) {
    const wwwAuth = firstResp.headers.get('WWW-Authenticate');
    if (wwwAuth) {
      const challenge = parseDigestChallenge(wwwAuth);
      if (challenge) {
        // Generate Digest auth header
        const digestAuth = generateDigestAuthHeader(cfg, challenge, method, url, init.body);

        // Retry with Authorization header
        const retryHeaders = { ...(init.headers || {}) };
        retryHeaders.Authorization = digestAuth.Authorization;
        const retryInit = { ...init, headers: retryHeaders };

        const retryResp = await fetcher(url, retryInit as Parameters<typeof fetch>[1]);
        return retryResp as { ok: boolean; status: number; text: () => Promise<string> };
      }
    }
  }

  // If not 401 or no Digest challenge, return original response
  return firstResp as { ok: boolean; status: number; text: () => Promise<string> };
}
