import debug from 'debug';
import { Camera } from './camera';
import { AppConfig } from '../types';
import { MQTTWrapper } from '../mqttClient';
import { logInfo, logError } from '../logger';

const log = debug('camera-manager');
const EVENT_BASELINE_TOPICS = ['motion', 'line', 'people', 'vehicle', 'animal'] as const;

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

      // Initialize retained baseline event and status state so dashboards have deterministic startup values.
      for (const topic of EVENT_BASELINE_TOPICS) {
        this.mqtt.publish(`${camCfg.name}/${topic}`, 'OFF', { retain: true });
      }
      this.mqtt.publish(`${camCfg.name}/status`, 'OFFLINE', { retain: true });

      try {
        await cam.init();
        this.cameras.push(cam);
        logInfo(`[INFO] Camera initialized camera=${camCfg.name}`);
        log('Camera initialized', camCfg.name);
      } catch (err) {
        await cam.setEventChannelStatus('offline', 'camera init failed');
        logError(`[ERROR] Camera init failed name=${camCfg.name}`, err);
        log('Failed to init camera', camCfg.name, err);
        continue;
      }

      // if push mode and autoSubscribe configured, try to ask camera to POST to our notify endpoint
      try {
        if (camCfg.event?.mode === 'push' && camCfg.event?.push?.autoSubscribe) {
          const { getEventsXaddr } = await import('../onvif/pullPoint');
          const { createPushSubscription, buildNotifyUrl } = await import('../onvif/push');
          const eventsXaddr = await getEventsXaddr(camCfg);
          if (eventsXaddr) {
            const notifyUrl = buildNotifyUrl(this.cfg, camCfg.name, camCfg.event?.push?.notifyPath);
            if (!notifyUrl) {
              await cam.setEventChannelStatus('offline', 'notify baseUrl missing/invalid for push auto-subscribe');
              logError(`[ERROR] Missing or invalid notify.baseUrl for push auto-subscribe camera=${camCfg.name}`);
              continue;
            }
            const ok = await createPushSubscription(eventsXaddr, camCfg, notifyUrl);
            if (ok) {
              await cam.setEventChannelStatus('online', 'push auto-subscribe ok');
              logInfo(`[INFO] Push subscription created camera=${camCfg.name} notifyUrl=${notifyUrl}`);
              log('Push subscription created for', camCfg.name);
            } else {
              await cam.setEventChannelStatus('offline', 'push auto-subscribe failed');
              logError(`[ERROR] Push subscription attempt failed for camera=${camCfg.name}`);
              log('Push subscription attempt failed for', camCfg.name);
            }
          } else {
            await cam.setEventChannelStatus('offline', 'events xaddr discovery failed for push auto-subscribe');
            logError(`[ERROR] Could not determine events XAddr for push subscription camera=${camCfg.name}`);
            log('Could not determine events XAddr for push subscription', camCfg.name);
          }
        }
      } catch (err) {
        await cam.setEventChannelStatus('offline', 'push auto-subscribe error');
        logError(`[ERROR] Push auto-subscribe error camera=${camCfg.name}`, err);
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
