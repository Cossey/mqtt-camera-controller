import http from 'http';
import { parseNotificationXml, startPushServer } from '../src/onvif/push';
import { CameraManager } from '../src/cameras/cameraManager';
import { AppConfig } from '../src/types';

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

describe('ONVIF push notify parsing & server', () => {
  test('parseNotificationXml extracts motion', () => {
    const evs = parseNotificationXml(sampleNotify);
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.find((e) => e.type === 'motion')).toBeTruthy();
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
});
