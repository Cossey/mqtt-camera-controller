import http from 'http';
import { parseNotificationXml, startPushServer, resolveNotifyConfig, buildNotifyUrl, createPushSubscription } from '../src/onvif/push';
import { CameraManager } from '../src/cameras/cameraManager';
import { AppConfig } from '../src/types';

const originalFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;

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

  test('createPushSubscription returns true for 2xx non-fault response', async () => {
    const mockFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<CreateSubscriptionResponse/>',
    }));
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    const ok = await createPushSubscription(
      'http://camera/events',
      { host: 'camera', port: 80 } as any,
      'http://controller/onvif/notify/driveway'
    );

    expect(ok).toBe(true);
  });

  test('createPushSubscription returns false for non-2xx response', async () => {
    const mockFetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }));
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    const ok = await createPushSubscription(
      'http://camera/events',
      { host: 'camera', port: 80 } as any,
      'http://controller/onvif/notify/driveway'
    );

    expect(ok).toBe(false);
  });

  test('createPushSubscription returns false for SOAP Fault response', async () => {
    const mockFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<s:Fault><s:Reason><s:Text>bad request</s:Text></s:Reason></s:Fault>',
    }));
    (globalThis as unknown as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

    const ok = await createPushSubscription(
      'http://camera/events',
      { host: 'camera', port: 80 } as any,
      'http://controller/onvif/notify/driveway'
    );

    expect(ok).toBe(false);
  });
});
