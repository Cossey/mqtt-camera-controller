import { CameraConfig } from '../types';
import { logDebug, logInfo, logWarn } from '../logger';

/**
 * ONVIF Authentication Strategy
 * Manages capability detection and authentication method selection per RFC 2617/7616 and ONVIF spec.
 */

export interface SecurityCapabilities {
  usernameToken: boolean; // WS-Security UsernameToken support
  httpDigest: boolean; // HTTP Digest auth support
  tlsSupported: boolean; // TLS 1.0/1.1/1.2+ supported
  hashingAlgorithms?: string[]; // e.g., ['MD5', 'SHA-256']
  basicAuth?: boolean; // Implicit (always available)
}

export type AuthMethod = 'wsse' | 'digest' | 'basic' | 'none';

function findSecurityCaps(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;

  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const normalizedKey = key.includes(':') ? key.split(':')[1] : key;
    if (normalizedKey === 'Security' && typeof value === 'object') {
      return value as Record<string, unknown>;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const result = findSecurityCaps(item);
        if (result) return result;
      }
    } else if (typeof value === 'object') {
      const result = findSecurityCaps(value);
      if (result) return result;
    }
  }
  return null;
}

/**
 * Parse security capabilities from ONVIF GetCapabilities response.
 * Extracts UsernameToken, HttpDigest, TLS versions, and hashing algorithms.
 */
export function parseSecurityCapabilities(parsedXml: unknown): SecurityCapabilities {
  const caps: SecurityCapabilities = {
    usernameToken: false,
    httpDigest: false,
    tlsSupported: false,
    hashingAlgorithms: [],
    basicAuth: true, // Always available as fallback
  };

  try {
    // Navigate parsed XML to Security capabilities
    const rec = parsedXml as Record<string, unknown>;

    const securityNode = findSecurityCaps(rec);
    if (securityNode) {
      for (const [k, v] of Object.entries(securityNode)) {
        const key = k.includes(':') ? k.split(':')[1] : k;

        if (key === 'UsernameToken' && v === true) caps.usernameToken = true;
        if (key === 'HttpDigest' && v === true) caps.httpDigest = true;

        if (key === 'TLS1.0' && v === true) caps.tlsSupported = true;
        if (key === 'TLS1.1' && v === true) caps.tlsSupported = true;
        if (key === 'TLS1.2' && v === true) caps.tlsSupported = true;

        if (key === 'HashingAlgorithms' && typeof v === 'object') {
          // Handle both array and object formats for algorithms
          if (Array.isArray(v)) {
            for (const algo of v) {
              if (typeof algo === 'string') {
                caps.hashingAlgorithms?.push(algo);
              }
            }
          } else {
            const algoNode = v as Record<string, unknown>;
            // Could be {Algorithm: ['MD5', 'SHA-256']} or similar
            for (const algEntry of Object.values(algoNode)) {
              if (Array.isArray(algEntry)) {
                for (const algo of algEntry) {
                  if (typeof algo === 'string') {
                    caps.hashingAlgorithms?.push(algo);
                  }
                }
              } else if (typeof algEntry === 'string') {
                caps.hashingAlgorithms?.push(algEntry);
              }
            }
          }
        }
      }
    }
  } catch {
    // If parsing fails, return defaults (basicAuth always available)
  }

  return caps;
}

/**
 * Select authentication methods to attempt based on device capabilities and config.
 * Returns array in priority order (most secure first).
 *
 * Strategy:
 * 1. WS-Security UsernameToken (always available if creds present, most secure)
 * 2. HTTP Digest (if device supports + has creds + TLS or non-critical data)
 * 3. Basic auth (if device supports + has creds, least secure)
 * 4. None (if no credentials)
 */
export function selectAuthMethods(
  caps: SecurityCapabilities,
  cfg: CameraConfig,
  isHttpsUrl: boolean,
): AuthMethod[] {
  const methods: AuthMethod[] = [];
  const hasCreds = Boolean(cfg.username && cfg.password);

  if (!hasCreds) {
    return ['none'];
  }

  // WS-Security UsernameToken: always try first if creds present (most secure)
  if (caps.usernameToken) {
    methods.push('wsse');
  }

  // HTTP Digest: try if device supports AND (TLS or can accept over HTTP)
  if (caps.httpDigest && caps.hashingAlgorithms && caps.hashingAlgorithms.length > 0) {
    // Only recommend digest over HTTPS, or if explicitly accepted
    if (isHttpsUrl) {
      methods.push('digest');
    }
  }

  // Basic auth: always available as last resort if creds present
  if (caps.basicAuth) {
    methods.push('basic');
  }

  return methods.length > 0 ? methods : ['none'];
}

/**
 * Log detected capabilities and selected auth strategy.
 */
export function logAuthCapabilities(
  cameraName: string,
  caps: SecurityCapabilities,
  _isHttpsUrl: boolean,
): void {
  const capsList = [];
  if (caps.usernameToken) capsList.push('UsernameToken');
  if (caps.httpDigest) capsList.push('HttpDigest');
  if (caps.tlsSupported) capsList.push('TLS');

  const hashingStr = caps.hashingAlgorithms && caps.hashingAlgorithms.length > 0
    ? caps.hashingAlgorithms.join(',')
    : 'n/a';

  logInfo(
    `[INFO] Auth capabilities detected camera=${cameraName} supported=${capsList.join('|') || 'none'} hashing_algorithms=${hashingStr} tls=${caps.tlsSupported}`,
  );
}

/**
 * Log the auth strategy that will be attempted.
 */
export function logAuthStrategy(
  cameraName: string,
  methods: AuthMethod[],
  isHttpsUrl: boolean,
): void {
  const reasons: string[] = [];

  if (methods.includes('digest') && !isHttpsUrl) {
    reasons.push('digest_requires_tls');
  }

  const reasonStr = reasons.length > 0 ? ` (${reasons.join(', ')})` : '';
  logInfo(
    `[INFO] Auth strategy: camera=${cameraName} attempting=${methods.join('>')}${reasonStr}`,
  );
}

/**
 * Log a specific auth attempt.
 */
export function logAuthAttempt(
  cameraName: string,
  method: AuthMethod,
  variant?: string,
): void {
  const variantStr = variant ? `/${variant}` : '';
  logDebug(`[DEBUG] Auth attempt: camera=${cameraName} method=${method}${variantStr}`);
}

/**
 * Log successful auth.
 */
export function logAuthSuccess(cameraName: string, method: AuthMethod, variant?: string): void {
  const variantStr = variant ? `/${variant}` : '';
  logDebug(`[DEBUG] Auth succeeded: camera=${cameraName} method=${method}${variantStr}`);
}

/**
 * Log auth failure on a specific attempt.
 */
export function logAuthFailure(
  cameraName: string,
  method: AuthMethod,
  status: number,
  fault?: string | null,
  variant?: string,
): void {
  const variantStr = variant ? `/${variant}` : '';
  const faultStr = fault ? ` fault=${fault}` : '';
  logDebug(
    `[DEBUG] Auth failed: camera=${cameraName} method=${method}${variantStr} status=${status}${faultStr}`,
  );
}

/**
 * Log warning when falling back to less secure method.
 */
export function logAuthDowngrade(
  cameraName: string,
  from: AuthMethod,
  to: AuthMethod,
  reason: string,
): void {
  logWarn(
    `[WARN] Auth fallback: camera=${cameraName} downgrading_from=${from} to=${to} reason=${reason}`,
  );
}

/**
 * Log when all auth methods fail.
 */
export function logAuthExhausted(
  cameraName: string,
  methods: AuthMethod[],
  finalStatus: number,
): void {
  logWarn(
    `[WARN] Auth exhausted: camera=${cameraName} all_methods_failed=${methods.join(',')} final_status=${finalStatus}`,
  );
}
