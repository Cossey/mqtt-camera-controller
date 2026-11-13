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
  private pushKeepAlives: Array<{ stop: () => void }> = [];

  constructor(cfg: AppConfig, mqtt: MQTTWrapper) {
    this.cfg = cfg;
    this.mqtt = mqtt;
  }

  async init() {
    for (const camCfg of this.cfg.cameras) {
      const cam = new Camera(camCfg, this.mqtt, this.cfg.rateLimit);

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

      // Start periodic snapshots right after init succeeds. Push auto-subscribe below
      // can bail out early; periodic snapshots must not depend on its outcome.
      cam.startPeriodicSnapshotLoop();

      // if push mode and autoSubscribe configured, start the subscription keep-alive.
      // It establishes the subscription, renews it before expiry, and re-subscribes
      // (with backoff) after failures so camera reboots recover without a restart.
      try {
        if (camCfg.event?.mode === 'push' && camCfg.event?.push?.autoSubscribe) {
          const { buildNotifyUrl } = await import('../onvif/push');
          const notifyUrl = buildNotifyUrl(this.cfg, camCfg.name, camCfg.event?.push?.notifyPath);
          if (!notifyUrl) {
            await cam.setEventChannelStatus('offline', 'notify baseUrl missing/invalid for push auto-subscribe');
            logError(`[ERROR] Missing or invalid notify.baseUrl for push auto-subscribe camera=${camCfg.name}`);
            log('Could not determine notify URL for push subscription', camCfg.name);
          } else {
            const { startPushSubscriptionKeepAlive } = await import('../onvif/pushSubscriptionKeepAlive');
            const keepAlive = startPushSubscriptionKeepAlive(camCfg, notifyUrl, {
              onHealthy: () => {
                void cam.setEventChannelStatus('online', 'push subscription healthy');
              },
              onError: (err: unknown) => {
                logError(`[ERROR] Push subscription attempt failed for camera=${camCfg.name}`, err);
                log('Push subscription attempt failed for', camCfg.name, err);
                void cam.setEventChannelStatus('offline', 'push subscription unhealthy');
              },
            });
            this.pushKeepAlives.push(keepAlive);
            log('Push subscription keep-alive started for', camCfg.name);
          }
        }
      } catch (err) {
        await cam.setEventChannelStatus('offline', 'push auto-subscribe error');
        logError(`[ERROR] Push auto-subscribe error camera=${camCfg.name}`, err);
        log('autoSubscribe push error', err);
      }
    }

    if (typeof (this.mqtt as unknown as { publishRaw?: unknown }).publishRaw === 'function') {
      const { publishHomeAssistantDiscovery } = await import('../homeassistant/discovery');
      await publishHomeAssistantDiscovery(this.cfg, this.mqtt);
    }
  }

  async stop() {
    for (const keepAlive of this.pushKeepAlives) {
      keepAlive.stop();
    }
    this.pushKeepAlives = [];

    for (const camera of this.cameras) {
      await camera.stop();
    }
    this.cameras = [];
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
