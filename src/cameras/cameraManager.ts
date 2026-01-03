import debug from 'debug';
import { Camera } from './camera';
import { AppConfig } from '../types';
import { MQTTWrapper } from '../mqttClient';

const log = debug('camera-manager');

export class CameraManager {
  cameras: Camera[] = [];
  cfg: AppConfig;
  mqtt: MQTTWrapper;

  constructor(cfg: AppConfig, mqtt: MQTTWrapper) {
    this.cfg = cfg;
    this.mqtt = mqtt;
  }

  async init() {
    for (const camCfg of this.cfg.cameras) {
      const cam = new Camera(camCfg, this.mqtt);
      try {
        await cam.init();
        this.cameras.push(cam);
        log('Camera initialized', camCfg.name);
      } catch (err) {
        log('Failed to init camera', camCfg.name, err);
      }

      // if push mode and autoSubscribe configured, try to ask camera to POST to our notify endpoint
      try {
        if (camCfg.event?.mode === 'push' && camCfg.event?.push?.autoSubscribe && this.cfg.notify?.baseUrl) {
          const { getEventsXaddr } = await import('../onvif/pullPoint');
          const { createPushSubscription } = await import('../onvif/push');
          const eventsXaddr = await getEventsXaddr(camCfg);
          if (eventsXaddr) {
            const path = camCfg.event?.push?.notifyPath || `${this.cfg.notify.basePath || '/onvif/notify'}/${encodeURIComponent(camCfg.name)}`;
            const notifyUrl = `${this.cfg.notify.baseUrl}${path}`;
            const ok = await createPushSubscription(eventsXaddr, camCfg, notifyUrl);
            if (ok) log('Push subscription created for', camCfg.name);
            else log('Push subscription attempt failed for', camCfg.name);
          } else {
            log('Could not determine events XAddr for push subscription', camCfg.name);
          }
        }
      } catch (err) {
        log('autoSubscribe push error', err);
      }

      // Setup periodic snapshots if configured
      if (camCfg.snapshot?.interval && camCfg.snapshot.interval > 0) {
        setInterval(async () => {
          try {
            const snap = await cam.getSnapshot();
            await cam.publishSnapshot(snap);
          } catch (err) {
            log('periodic snapshot failed', camCfg.name, err);
          }
        }, (camCfg.snapshot.interval || 60) * 1000);
      }
    }
  }

  getCameraByName(name: string) {
    return this.cameras.find((c) => c.cfg.name === name);
  }

  // find camera by notify path (allows incoming POSTs to map to camera)
  getCameraByNotifyPath(path: string) {
    // path may look like /onvif/notify/front-door
    const parts = path.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    return this.getCameraByName(decodeURIComponent(last));
  }
}
