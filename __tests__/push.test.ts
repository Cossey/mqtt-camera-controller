import http from 'http';
import { parseNotificationXml, startPushServer, resolveNotifyConfig, buildNotifyUrl, createPushSubscription } from '../src/onvif/push';
import { startPushSubscriptionKeepAlive } from '../src/onvif/pushSubscriptionKeepAlive';
import { CameraManager } from '../src/cameras/cameraManager';
import { AppConfig, CameraConfig } from '../src/types';

const originalFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;

const SOAP_CAPABILITIES_WITH_EVENTS_XADDR = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <s:Body>
    <tds:GetCapabilitiesResponse>
      <tds:Capabilities>
        <tds:Events>
          <tds:XAddr>http://192.168.50.202:1024/event-1024_1024</tds:XAddr>
        </tds:Events>
      </tds:Capabilities>
    </tds:GetCapabilitiesResponse>
  </s:Body>
</s:Envelope>`;

const SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS_AND_TIMING = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa="http://www.w3.org/2005/08/addressing">
  <s:Body>
    <tev:CreateSubscriptionResponse>
      <wsnt:SubscriptionReference>
        <wsa:Address>http://192.168.50.202:1024/event-1024_1024/sub-1</wsa:Address>
      </wsnt:SubscriptionReference>
      <wsnt:CurrentTime>2026-04-26T00:00:00Z</wsnt:CurrentTime>
      <wsnt:TerminationTime>2026-04-26T00:00:02Z</wsnt:TerminationTime>
    </tev:CreateSubscriptionResponse>
  </s:Body>
</s:Envelope>`;

const SOAP_CREATE_SUBSCRIPTION_WITH_TIMING_NO_ADDRESS = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">
  <s:Body>
    <tev:CreateSubscriptionResponse>
      <wsnt:CurrentTime>2026-04-26T00:00:00Z</wsnt:CurrentTime>
      <wsnt:TerminationTime>2026-04-26T00:00:02Z</wsnt:TerminationTime>
    </tev:CreateSubscriptionResponse>
  </s:Body>
</s:Envelope>`;

const SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS_AND_TIMING_SUB2 = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa="http://www.w3.org/2005/08/addressing">
  <s:Body>
    <tev:CreateSubscriptionResponse>
      <wsnt:SubscriptionReference>
        <wsa:Address>http://192.168.50.202:1024/event-1024_1024/sub-2</wsa:Address>
      </wsnt:SubscriptionReference>
      <wsnt:CurrentTime>2026-04-26T00:00:01Z</wsnt:CurrentTime>
      <wsnt:TerminationTime>2026-04-26T00:00:03Z</wsnt:TerminationTime>
    </tev:CreateSubscriptionResponse>
  </s:Body>
</s:Envelope>`;

const SOAP_RENEW_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">
  <s:Body>
    <wsnt:RenewResponse>
      <wsnt:CurrentTime>2026-04-26T00:00:01Z</wsnt:CurrentTime>
      <wsnt:TerminationTime>2026-04-26T00:00:03Z</wsnt:TerminationTime>
    </wsnt:RenewResponse>
  </s:Body>
</s:Envelope>`;

const DIGEST_CHALLENGE = 'Digest realm="IPC", nonce="abc123", qop="auth"';

function mockResponse(ok: boolean, status: number, body: string, headers: Record<string, string> = {}) {
  return {
    ok,
    status,
    text: async () => body,
    headers,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const sampleNotify = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body>
    <tev:Notify xmlns:tev="http://www.onvif.org/ver10/events/wsdl">
      <tev:Topic>tns1:RuleEngine/CellMotionDetector/Motion</tev:Topic>
      <tev:Message>
        <tt:Data xmlns:tt="http://www.onvif.org/ver10/schema">
          <tt:SimpleItem Name="IsMotion" Value="true" />
        </tt:Data>
      </tev:Message>
    </tev:Notify>
  </s:Body>
</s:Envelope>`;

const tplinkVehicleNotify = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body>
    <tev:Notify xmlns:tev="http://www.onvif.org/ver10/events/wsdl">
      <tev:Topic>tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent</tev:Topic>
      <tev:Message>
        <tt:Data xmlns:tt="http://www.onvif.org/ver10/schema">
          <tt:SimpleItem Name="IsVehicle" Value="true" />
        </tt:Data>
      </tev:Message>
    </tev:Notify>
  </s:Body>
</s:Envelope>`;

describe('ONVIF push notify parsing & server', () => {
  afterEach(() => {
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  test('parseNotificationXml extracts motion', () => {
    const evs = parseNotificationXml(sampleNotify);
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.find((e) => e.type === 'motion')).toBeTruthy();
  });

  test('parseNotificationXml maps TPLink smart IsVehicle to vehicle', () => {
    const evs = parseNotificationXml(tplinkVehicleNotify);
    expect(evs.find((e) => e.type === 'vehicle' && e.state === true)).toBeTruthy();
  });

  test('startPushServer accepts POST and routes by path', (done) => {
    const cfg = { notify: { port: 0, basePath: '/onvif/notify' } } as AppConfig;
    const mgr = new CameraManager({ mqtt: {} as any, cameras: [] }, {} as any);
    const srv = startPushServer(cfg, mgr);
    // poll for server.address() to be available (port 0 binds asynchronously)
    let waited = 0;
    const t = setInterval(() => {
      const address = srv.address();
      if (address && typeof address !== 'string') {
        clearInterval(t);
        const port = address.port;
        const opts: http.RequestOptions = {
          hostname: '127.0.0.1',
          port,
          path: '/onvif/notify/some-camera',
          method: 'POST',
        };

        const req = http.request(opts, (res) => {
          expect(res.statusCode).toBe(200);
          // we don't need to wait for full body; presence of response is sufficient
          srv.close();
          done();
        });
        req.write(sampleNotify);
        req.end();
        return;
      }
      waited += 10;
      if (waited > 3000) {
        clearInterval(t);
        try { srv.close(); } catch (e) { /* ignore */ }
        done(new Error('Server failed to bind'));
      }
    }, 10);
  });

  test('startPushServer accepts POST notify path with query string', (done) => {
    const cfg = { notify: { port: 0, basePath: '/onvif/notify' } } as AppConfig;
    const mgr = new CameraManager({ mqtt: {} as any, cameras: [] }, {} as any);
    const srv = startPushServer(cfg, mgr);
    let waited = 0;
    const t = setInterval(() => {
      const address = srv.address();
      if (address && typeof address !== 'string') {
        clearInterval(t);
        const port = address.port;
        const opts: http.RequestOptions = {
          hostname: '127.0.0.1',
          port,
          path: '/onvif/notify/some-camera?subscription=abc',
          method: 'POST',
        };

        const req = http.request(opts, (res) => {
          expect(res.statusCode).toBe(200);
          srv.close();
          done();
        });
        req.write(sampleNotify);
        req.end();
        return;
      }
      waited += 10;
      if (waited > 3000) {
        clearInterval(t);
        try { srv.close(); } catch (e) { /* ignore */ }
        done(new Error('Server failed to bind'));
      }
    }, 10);
  });

  test('resolveNotifyConfig uses baseUrl port when notify.port is omitted', () => {
    const cfg = { notify: { baseUrl: 'http://192.168.69.240:8013' } } as AppConfig;
    const resolved = resolveNotifyConfig(cfg);
    expect(resolved.listenPort).toBe(8013);
    expect(resolved.portMismatch).toBe(false);
    expect(resolved.callbackBaseUrl).toBe('http://192.168.69.240:8013');
  });

  test('buildNotifyUrl appends notify.port when baseUrl omits port', () => {
    const cfg = {
      notify: {
        baseUrl: 'http://192.168.69.240',
        port: 8013,
      },
    } as AppConfig;

    const notifyUrl = buildNotifyUrl(cfg, 'frontdoor');
    expect(notifyUrl).toBe('http://192.168.69.240:8013/onvif/notify/frontdoor');
  });

  test('resolveNotifyConfig flags port mismatch when baseUrl and notify.port differ', () => {
    const cfg = {
      notify: {
        baseUrl: 'http://192.168.69.240:8013',
        port: 8080,
      },
    } as AppConfig;

    const resolved = resolveNotifyConfig(cfg);
    expect(resolved.portMismatch).toBe(true);
    expect(resolved.listenPort).toBe(8080);
    expect(resolved.callbackBaseUrl).toBe('http://192.168.69.240:8013');
  });

  test('createPushSubscription returns ok for 2xx non-fault response', async () => {
    const mockFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<CreateSubscriptionResponse/>',
    }));
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    const result = await createPushSubscription(
      'http://camera/events',
      { host: 'camera', port: 80 } as any,
      'http://controller/onvif/notify/driveway'
    );

    expect(result.ok).toBe(true);
    // response has no SubscriptionReference/Address or timing
    expect(result.address).toBeNull();
    expect(result.currentTimeMs).toBeNull();
    expect(result.terminationTimeMs).toBeNull();
  });

  test('createPushSubscription returns not ok for non-2xx response', async () => {
    const mockFetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }));
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    const result = await createPushSubscription(
      'http://camera/events',
      { host: 'camera', port: 80 } as any,
      'http://controller/onvif/notify/driveway'
    );

    expect(result.ok).toBe(false);
  });

  test('createPushSubscription returns not ok for SOAP Fault response', async () => {
    const mockFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<s:Fault><s:Reason><s:Text>bad request</s:Text></s:Reason></s:Fault>',
    }));
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    const result = await createPushSubscription(
      'http://camera/events',
      { host: 'camera', port: 80 } as any,
      'http://controller/onvif/notify/driveway'
    );

    expect(result.ok).toBe(false);
  });

  test('createPushSubscription parses subscription address and timing from the response', async () => {
    const mockFetch = jest.fn(async () => mockResponse(true, 200, SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS_AND_TIMING));
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    const result = await createPushSubscription(
      'http://192.168.50.202:1024/event-1024_1024',
      { host: 'camera', port: 80 } as any,
      'http://controller/onvif/notify/driveway'
    );

    expect(result.ok).toBe(true);
    expect(result.address).toBe('http://192.168.50.202:1024/event-1024_1024/sub-1');
    expect(result.currentTimeMs).toBe(Date.parse('2026-04-26T00:00:00Z'));
    expect(result.terminationTimeMs).toBe(Date.parse('2026-04-26T00:00:02Z'));
  });

  test('createPushSubscription returns null address when the response omits one', async () => {
    const mockFetch = jest.fn(async () => mockResponse(true, 200, SOAP_CREATE_SUBSCRIPTION_WITH_TIMING_NO_ADDRESS));
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    const result = await createPushSubscription(
      'http://192.168.50.202:1024/event-1024_1024',
      { host: 'camera', port: 80 } as any,
      'http://controller/onvif/notify/driveway'
    );

    expect(result.ok).toBe(true);
    expect(result.address).toBeNull();
    expect(result.terminationTimeMs).toBe(Date.parse('2026-04-26T00:00:02Z'));
  });

  test('createPushSubscription retries with Digest auth after a 401 Digest challenge', async () => {
    const mockFetch = jest.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      const auth = init?.headers?.Authorization || '';
      if (auth.startsWith('Digest ')) {
        return mockResponse(true, 200, SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS_AND_TIMING);
      }
      return mockResponse(false, 401, 'Unauthorized', { 'WWW-Authenticate': DIGEST_CHALLENGE });
    });
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    const result = await createPushSubscription(
      'http://camera/events',
      { host: 'camera', port: 80, username: 'admin', password: 'pw' } as any,
      'http://controller/onvif/notify/driveway'
    );

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const digestInit = mockFetch.mock.calls[1][1] as { headers: Record<string, string> };
    expect(digestInit.headers.Authorization).toContain('Digest username="admin"');
    expect(digestInit.headers['Content-Type']).toBe('application/soap+xml; charset=utf-8');
  });
});

describe('Push subscription keep-alive', () => {
  afterEach(() => {
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  const keepAliveCfg = { name: 'driveway', host: '192.168.50.202', port: 2020 } as CameraConfig;
  const notifyUrl = 'http://controller/onvif/notify/driveway';

  test('establishes the subscription and reports healthy', async () => {
    const fetchMock = jest.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body || '';
      if (url.endsWith('/onvif/device_service')) return mockResponse(true, 200, SOAP_CAPABILITIES_WITH_EVENTS_XADDR);
      if (body.includes('CreateSubscription')) return mockResponse(true, 200, SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS_AND_TIMING);
      return mockResponse(false, 500, 'unexpected url');
    });
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const onHealthy = jest.fn();
    const onError = jest.fn();
    const keepAlive = startPushSubscriptionKeepAlive(keepAliveCfg, notifyUrl, { onHealthy, onError });

    try {
      await wait(150);
      expect(onHealthy).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://192.168.50.202:1024/event-1024_1024',
        expect.objectContaining({ body: expect.stringContaining('CreateSubscription') })
      );
    } finally {
      keepAlive.stop();
    }
  });

  test('renews the subscription before expiry at the subscription address', async () => {
    const fetchMock = jest.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body || '';
      if (url.endsWith('/onvif/device_service')) return mockResponse(true, 200, SOAP_CAPABILITIES_WITH_EVENTS_XADDR);
      if (body.includes('CreateSubscription')) return mockResponse(true, 200, SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS_AND_TIMING);
      if (body.includes('<wsnt:Renew')) return mockResponse(true, 200, SOAP_RENEW_RESPONSE);
      return mockResponse(false, 500, 'unexpected url');
    });
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const onHealthy = jest.fn();
    // 2s lifetime with the fixture timing -> renew scheduled at ~1s
    const keepAlive = startPushSubscriptionKeepAlive(keepAliveCfg, notifyUrl, { onHealthy });

    try {
      await wait(1500);
      expect(onHealthy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://192.168.50.202:1024/event-1024_1024/sub-1',
        expect.objectContaining({ body: expect.stringContaining('<wsnt:Renew') })
      );
    } finally {
      keepAlive.stop();
    }
  });

  test('renews against the events xaddr when the response omits the subscription address', async () => {
    const fetchMock = jest.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body || '';
      if (url.endsWith('/onvif/device_service')) return mockResponse(true, 200, SOAP_CAPABILITIES_WITH_EVENTS_XADDR);
      if (body.includes('CreateSubscription')) return mockResponse(true, 200, SOAP_CREATE_SUBSCRIPTION_WITH_TIMING_NO_ADDRESS);
      if (body.includes('<wsnt:Renew')) return mockResponse(true, 200, SOAP_RENEW_RESPONSE);
      return mockResponse(false, 500, 'unexpected url');
    });
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const keepAlive = startPushSubscriptionKeepAlive(keepAliveCfg, notifyUrl, {});

    try {
      await wait(1500);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://192.168.50.202:1024/event-1024_1024',
        expect.objectContaining({ body: expect.stringContaining('<wsnt:Renew') })
      );
    } finally {
      keepAlive.stop();
    }
  });

  test('re-subscribes after a failed renewal and reports healthy again', async () => {
    let createCount = 0;
    const fetchMock = jest.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body || '';
      if (url.endsWith('/onvif/device_service')) return mockResponse(true, 200, SOAP_CAPABILITIES_WITH_EVENTS_XADDR);
      if (body.includes('CreateSubscription')) {
        createCount += 1;
        return mockResponse(
          true,
          200,
          createCount === 1 ? SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS_AND_TIMING : SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS_AND_TIMING_SUB2
        );
      }
      if (body.includes('<wsnt:Renew')) {
        // only the first subscription's renewal fails; the re-created subscription renews fine
        return url.endsWith('/sub-1')
          ? mockResponse(false, 500, 'renew failed')
          : mockResponse(true, 200, SOAP_RENEW_RESPONSE);
      }
      return mockResponse(false, 500, 'unexpected url');
    });
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const onHealthy = jest.fn();
    const onError = jest.fn();
    const keepAlive = startPushSubscriptionKeepAlive(keepAliveCfg, notifyUrl, { onHealthy, onError });

    try {
      // establish (~0s) -> renew at ~1s fails -> re-subscribe -> next renew (sub-2) at ~2s
      await wait(2500);
      expect(createCount).toBe(2);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://192.168.50.202:1024/event-1024_1024/sub-2',
        expect.objectContaining({ body: expect.stringContaining('<wsnt:Renew') })
      );
      // a single renewal failure stays below the 3-failure status threshold
      expect(onHealthy).toHaveBeenCalledTimes(2);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      keepAlive.stop();
    }
  });

  test('reports an error after 3 consecutive subscription failures', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/onvif/device_service')) return mockResponse(true, 200, SOAP_CAPABILITIES_WITH_EVENTS_XADDR);
      return mockResponse(false, 500, 'subscribe failed');
    });
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const onHealthy = jest.fn();
    const onError = jest.fn();
    const keepAlive = startPushSubscriptionKeepAlive(keepAliveCfg, notifyUrl, { onHealthy, onError });

    try {
      // startup attempt (1) + recovery attempt 1 (2) + recovery attempt 2 after the 3s backoff (3)
      await wait(4200);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onHealthy).not.toHaveBeenCalled();
    } finally {
      keepAlive.stop();
    }
  });

  test('stop() prevents further subscription requests', async () => {
    const fetchMock = jest.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body || '';
      if (url.endsWith('/onvif/device_service')) return mockResponse(true, 200, SOAP_CAPABILITIES_WITH_EVENTS_XADDR);
      if (body.includes('CreateSubscription')) return mockResponse(true, 200, SOAP_CREATE_SUBSCRIPTION_WITH_ADDRESS_AND_TIMING);
      if (body.includes('<wsnt:Renew')) return mockResponse(true, 200, SOAP_RENEW_RESPONSE);
      return mockResponse(false, 500, 'unexpected url');
    });
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const keepAlive = startPushSubscriptionKeepAlive(keepAliveCfg, notifyUrl, {});
    await wait(100);
    keepAlive.stop();

    const callsAtStop = fetchMock.mock.calls.length;
    await wait(300);
    expect(fetchMock.mock.calls.length).toBe(callsAtStop);
  });
});
