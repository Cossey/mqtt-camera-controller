import { describe, it, expect, beforeEach } from '@jest/globals';
import { createHash } from 'crypto';
import {
  parseDigestChallenge,
  generateDigestAuthHeader,
  buildDigestRetryInit,
  type DigestChallenge,
} from '../src/onvif/digestAuth';
import {
  parseSecurityCapabilities,
  selectAuthMethods,
  type SecurityCapabilities,
} from '../src/onvif/authStrategy';
import { CameraConfig } from '../src/types';

describe('HTTP Digest Authentication', () => {
  describe('parseDigestChallenge', () => {
    it('parses a complete Digest challenge with all parameters', () => {
      const header = 'Digest realm="MyRealm", nonce="abc123", algorithm=MD5, opaque="xyz", qop="auth"';
      const challenge = parseDigestChallenge(header);
      expect(challenge).toEqual({
        realm: 'MyRealm',
        nonce: 'abc123',
        algorithm: 'MD5',
        opaque: 'xyz',
        qop: 'auth',
      });
    });

    it('parses a Digest challenge with minimal required parameters', () => {
      const header = 'Digest realm="Test", nonce="def456"';
      const challenge = parseDigestChallenge(header);
      expect(challenge).toEqual({
        realm: 'Test',
        nonce: 'def456',
        algorithm: undefined,
        opaque: undefined,
        qop: undefined,
      });
    });

    it('returns null for non-Digest WWW-Authenticate header', () => {
      const header = 'Basic realm="Test"';
      const challenge = parseDigestChallenge(header);
      expect(challenge).toBeNull();
    });

    it('returns null when realm is missing', () => {
      const header = 'Digest nonce="abc", algorithm=MD5';
      const challenge = parseDigestChallenge(header);
      expect(challenge).toBeNull();
    });

    it('returns null when nonce is missing', () => {
      const header = 'Digest realm="Test", algorithm=MD5';
      const challenge = parseDigestChallenge(header);
      expect(challenge).toBeNull();
    });

    it('parses Digest challenge with stale=true', () => {
      const header = 'Digest realm="Test", nonce="xyz", stale="true"';
      const challenge = parseDigestChallenge(header);
      expect(challenge?.stale).toBe(true);
    });

    it('parses Digest challenge with stale=false', () => {
      const header = 'Digest realm="Test", nonce="xyz", stale="false"';
      const challenge = parseDigestChallenge(header);
      expect(challenge?.stale).toBe(false);
    });

    it('extracts first qop option when multiple are specified', () => {
      const header = 'Digest realm="Test", nonce="xyz", qop="auth,auth-int"';
      const challenge = parseDigestChallenge(header);
      expect(challenge?.qop).toBe('auth');
    });
  });

  describe('generateDigestAuthHeader', () => {
    let cfg: CameraConfig;
    let challenge: DigestChallenge;

    beforeEach(() => {
      cfg = {
        name: 'testcam',
        host: '192.168.1.100',
        port: 8080,
        username: 'admin',
        password: 'password',
      };

      challenge = {
        realm: 'ONVIF Device',
        nonce: 'testnonce12345',
        algorithm: 'MD5',
        opaque: 'opaque123',
        qop: 'auth',
      };
    });

    it('generates valid Digest auth header with qop', () => {
      const result = generateDigestAuthHeader(cfg, challenge, 'POST', '/service', '');
      expect(result.Authorization).toContain('Digest username="admin"');
      expect(result.Authorization).toContain('realm="ONVIF Device"');
      expect(result.Authorization).toContain('nonce="testnonce12345"');
      expect(result.Authorization).toContain('uri="/service"');
      expect(result.Authorization).toContain('qop=auth');
      expect(result.Authorization).toContain('cnonce=');
      expect(result.Authorization).toContain('nc=00000001');
      expect(result.Authorization).toContain('response=');
      expect(result.Authorization).toContain('opaque="opaque123"');
    });

    it('generates Digest auth header without qop', () => {
      challenge.qop = undefined;
      const result = generateDigestAuthHeader(cfg, challenge, 'POST', '/service', '');
      expect(result.Authorization).toContain('response=');
      expect(result.Authorization).not.toContain('cnonce=');
      expect(result.Authorization).not.toContain('nc=');
      expect(result.Authorization).not.toContain('qop=');
    });

    it('generates Digest auth header with SHA-256 algorithm', () => {
      challenge.algorithm = 'SHA-256';
      const result = generateDigestAuthHeader(cfg, challenge, 'POST', '/service', '');
      expect(result.Authorization).toContain('algorithm=SHA-256');
    });

    it('handles empty password correctly', () => {
      cfg.password = '';
      const result = generateDigestAuthHeader(cfg, challenge, 'POST', '/service', '');
      expect(result.Authorization).toContain('username="admin"');
      expect(result.Authorization).toContain('response=');
    });

    it('generates different response hashes for different URIs', () => {
      const result1 = generateDigestAuthHeader(cfg, challenge, 'POST', '/service1', '');
      const result2 = generateDigestAuthHeader(cfg, challenge, 'POST', '/service2', '');
      expect(result1.Authorization).not.toEqual(result2.Authorization);
    });

    it('uses a 32 hex character random cnonce when qop is present', () => {
      const result = generateDigestAuthHeader(cfg, challenge, 'POST', '/service', '');
      const cnonce = result.Authorization.match(/cnonce="([0-9a-f]+)"/)?.[1] ?? '';
      expect(cnonce).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('buildDigestRetryInit', () => {
    const cfg: CameraConfig = {
      name: 'testcam',
      host: '192.168.1.100',
      port: 8080,
      username: 'admin',
      password: 'secret',
    };

    const digestChallenge = 'Digest realm="ONVIF Device", nonce="abc123", qop="auth"';

    it('returns null for a Basic challenge', () => {
      const init = { method: 'POST', headers: { 'Content-Type': 'application/soap+xml' }, body: '<body/>' };
      expect(buildDigestRetryInit(init, cfg, 'Basic realm="Test"', 'http://camera/onvif/device_service')).toBeNull();
    });

    it('returns null for a malformed challenge', () => {
      const init = { method: 'POST', headers: {}, body: '<body/>' };
      expect(buildDigestRetryInit(init, cfg, 'Digest nocRealm', 'http://camera/onvif/device_service')).toBeNull();
    });

    it('returns null when the camera config has no credentials', () => {
      const init = { method: 'POST', headers: {}, body: '<body/>' };
      const noCreds = { ...cfg, username: undefined, password: undefined };
      expect(buildDigestRetryInit(init, noCreds, digestChallenge, 'http://camera/onvif/device_service')).toBeNull();
    });

    it('builds a correct MD5 + qop=auth Digest authorization and preserves other headers', () => {
      const init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          SOAPAction: 'http://www.onvif.org/ver10/device/wsdl/GetCapabilities',
          Authorization: 'Basic YWRtaW46c2VjcmV0',
        },
        body: '<s:Envelope/>',
      };

      const retry = buildDigestRetryInit(init, cfg, digestChallenge, 'http://camera/onvif/device_service');
      expect(retry).not.toBeNull();
      const auth = retry?.headers.Authorization ?? '';

      expect(auth).toContain('Digest username="admin"');
      expect(auth).toContain('realm="ONVIF Device"');
      expect(auth).toContain('nonce="abc123"');
      expect(auth).toContain('uri="/onvif/device_service"');
      expect(auth).toContain('qop=auth');
      expect(auth).toContain('nc=00000001');

      // cnonce is 32 hex chars
      const cnonce = auth.match(/cnonce="([0-9a-f]+)"/)?.[1] ?? '';
      expect(cnonce).toMatch(/^[0-9a-f]{32}$/);

      // response is the RFC 2617 MD5 computation over the request-target (path)
      const ha1 = createHash('md5').update('admin:ONVIF Device:secret').digest('hex');
      const ha2 = createHash('md5').update('POST:/onvif/device_service').digest('hex');
      const expectedResponse = createHash('md5')
        .update(`${ha1}:abc123:00000001:${cnonce}:auth:${ha2}`)
        .digest('hex');
      expect(auth).toContain(`response="${expectedResponse}"`);

      // request shape preserved, only Authorization replaced
      expect(retry?.headers['Content-Type']).toBe('application/soap+xml; charset=utf-8');
      expect(retry?.headers.SOAPAction).toBe('http://www.onvif.org/ver10/device/wsdl/GetCapabilities');
      expect(retry?.body).toBe('<s:Envelope/>');
      expect(retry?.method).toBe('POST');
    });

    it('uses the query string in the digest uri when present', () => {
      const retry = buildDigestRetryInit(
        { method: 'GET', headers: {} },
        cfg,
        digestChallenge,
        'http://camera/snapshot.jpg?channel=1',
      );
      expect(retry).not.toBeNull();
      expect(retry?.headers.Authorization).toContain('uri="/snapshot.jpg?channel=1"');
    });
  });

});

describe('ONVIF Security Capabilities Parsing', () => {
  describe('parseSecurityCapabilities', () => {
    it('extracts UsernameToken capability from nested XML structure', () => {
      const xmlObj = {
        Envelope: {
          Body: {
            GetCapabilitiesResponse: {
              Capabilities: {
                Security: {
                  UsernameToken: true,
                  HttpDigest: false,
                },
              },
            },
          },
        },
      };

      const caps = parseSecurityCapabilities(xmlObj);
      expect(caps.usernameToken).toBe(true);
      expect(caps.httpDigest).toBe(false);
    });

    it('extracts HttpDigest capability', () => {
      const xmlObj = {
        's:Envelope': {
          's:Body': {
            'tds:GetCapabilitiesResponse': {
              Capabilities: {
                Security: {
                  HttpDigest: true,
                },
              },
            },
          },
        },
      };

      const caps = parseSecurityCapabilities(xmlObj);
      expect(caps.httpDigest).toBe(true);
    });

    it('extracts TLS versions from Security capabilities', () => {
      const xmlObj = {
        Envelope: {
          Body: {
            GetCapabilitiesResponse: {
              Capabilities: {
                Security: {
                  'TLS1.2': true,
                  'TLS1.1': false,
                },
              },
            },
          },
        },
      };

      const caps = parseSecurityCapabilities(xmlObj);
      expect(caps.tlsSupported).toBe(true);
    });

    it('extracts hashing algorithms from Security capabilities', () => {
      const xmlObj = {
        Envelope: {
          Body: {
            GetCapabilitiesResponse: {
              Capabilities: {
                Security: {
                  HashingAlgorithms: {
                    Algorithm: ['MD5', 'SHA-256'],
                  },
                },
              },
            },
          },
        },
      };

      const caps = parseSecurityCapabilities(xmlObj);
      expect(caps.hashingAlgorithms).toContain('MD5');
      expect(caps.hashingAlgorithms).toContain('SHA-256');
    });

    it('defaults to basicAuth=true even with no Security node', () => {
      const xmlObj = {
        Envelope: {
          Body: {
            GetCapabilitiesResponse: {
              Capabilities: {},
            },
          },
        },
      };

      const caps = parseSecurityCapabilities(xmlObj);
      expect(caps.basicAuth).toBe(true);
      expect(caps.usernameToken).toBe(false);
      expect(caps.httpDigest).toBe(false);
    });

    it('handles empty or invalid XML gracefully', () => {
      const caps = parseSecurityCapabilities({});
      expect(caps.basicAuth).toBe(true);
      expect(caps.usernameToken).toBe(false);
      expect(caps.httpDigest).toBe(false);
    });

    it('handles null/undefined input gracefully', () => {
      const caps = parseSecurityCapabilities(null as unknown);
      expect(caps.basicAuth).toBe(true);
    });
  });

  describe('selectAuthMethods', () => {
    let cfg: CameraConfig;

    beforeEach(() => {
      cfg = {
        name: 'testcam',
        host: '192.168.1.100',
        port: 8080,
        username: 'admin',
        password: 'password',
      };
    });

    it('returns none when no credentials provided', () => {
      cfg.username = '';
      cfg.password = '';

      const caps: SecurityCapabilities = {
        usernameToken: true,
        httpDigest: true,
        tlsSupported: true,
        basicAuth: true,
      };

      const methods = selectAuthMethods(caps, cfg, true);
      expect(methods).toEqual(['none']);
    });

    it('prioritizes WS-Security over other methods when supported', () => {
      const caps: SecurityCapabilities = {
        usernameToken: true,
        httpDigest: true,
        tlsSupported: true,
        basicAuth: true,
      };

      const methods = selectAuthMethods(caps, cfg, true);
      expect(methods[0]).toBe('wsse');
    });

    it('includes Digest only over HTTPS', () => {
      const caps: SecurityCapabilities = {
        usernameToken: false,
        httpDigest: true,
        tlsSupported: true,
        hashingAlgorithms: ['MD5'],
        basicAuth: true,
      };

      const methodsHttps = selectAuthMethods(caps, cfg, true);
      expect(methodsHttps).toContain('digest');

      const methodsHttp = selectAuthMethods(caps, cfg, false);
      expect(methodsHttp).not.toContain('digest');
    });

    it('always includes Basic as fallback when supported and creds present', () => {
      const caps: SecurityCapabilities = {
        usernameToken: false,
        httpDigest: false,
        tlsSupported: false,
        basicAuth: true,
      };

      const methods = selectAuthMethods(caps, cfg, false);
      expect(methods).toContain('basic');
    });

    it('returns correct priority order: wsse > digest > basic', () => {
      const caps: SecurityCapabilities = {
        usernameToken: true,
        httpDigest: true,
        tlsSupported: true,
        hashingAlgorithms: ['MD5'],
        basicAuth: true,
      };

      const methods = selectAuthMethods(caps, cfg, true);
      expect(methods).toEqual(['wsse', 'digest', 'basic']);
    });

    it('skips Digest if no hashing algorithms advertised', () => {
      const caps: SecurityCapabilities = {
        usernameToken: false,
        httpDigest: true,
        tlsSupported: true,
        hashingAlgorithms: [],
        basicAuth: true,
      };

      const methods = selectAuthMethods(caps, cfg, true);
      expect(methods).not.toContain('digest');
      expect(methods).toContain('basic');
    });
  });
});
