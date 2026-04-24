import debug from 'debug';
import { spawnSync } from 'child_process';
import { loadConfig } from './config';
import { MQTTWrapper } from './mqttClient';
import { CameraManager } from './cameras/cameraManager';
import { setLogLevel, logInfo, logWarn, logError } from './logger';

const log = debug('app');

function checkFfmpeg() {
  try {
    const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return res.status === 0;
  } catch (err) {
    return false;
  }
}

async function main() {
  const cfg = loadConfig();
  setLogLevel(cfg.logging?.level || process.env.LOG_LEVEL);

  // runtime check for ffmpeg (useful for stream snapshot mode)
  const hasFfmpeg = checkFfmpeg();
  if (!hasFfmpeg) {
    logWarn('Warning: ffmpeg was not found on PATH. Stream-based snapshots will not work.\n' +
      'If you are running in Docker, ensure the image includes ffmpeg (the provided Dockerfile installs it).');
  }

  const mqttOpts: { username?: string; password?: string; will?: { topic: string; payload: string; retain: boolean; qos: 0 | 1 | 2 } } = {};
  if (cfg.mqtt.username) {
    mqttOpts.username = cfg.mqtt.username;
    mqttOpts.password = cfg.mqtt.password;
  }

  const baseTopic = cfg.mqtt.basetopic || cfg.mqtt.baseTopic || 'onvif2mqtt';
  mqttOpts.will = {
    topic: `${baseTopic}/status`,
    payload: 'offline',
    retain: true,
    qos: 1,
  };

  const brokerHost = cfg.mqtt.server || 'localhost';
  const brokerPort = cfg.mqtt.port || 1883;
  const brokerUrl = `mqtt://${brokerHost}${brokerPort ? ':' + brokerPort : ''}`;
  const mqtt = new MQTTWrapper(brokerUrl, mqttOpts, baseTopic);
  const camManager = new CameraManager(cfg, mqtt);

  // Start notify server if configured (push-mode)
  if (cfg.notify) {
    try {
      const { startPushServer } = await import('./onvif/push');
      startPushServer(cfg, camManager);
    } catch (err) {
      log('push notify module not available', err);
    }
  }

  await camManager.init();
  mqtt.publish('status', 'online', { retain: true });
  logInfo('[INFO] Global app status set to online topic=status');

  log('App initialized');

  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log('Shutting down');
    logInfo(`[INFO] ${signal} received, publishing OFFLINE statuses`);

    mqtt.publish('status', 'offline', { retain: true });
    for (const c of cfg.cameras) {
      mqtt.publish(`${c.name}/status`, 'offline', { retain: true });
    }

    setTimeout(() => process.exit(0), 300);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

main().catch((err) => {
  logError('[ERROR] Fatal error', err);
  process.exit(1);
});
