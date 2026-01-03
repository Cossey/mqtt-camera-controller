import debug from 'debug';
import { spawnSync } from 'child_process';
import { loadConfig } from './config';
import { MQTTWrapper } from './mqttClient';
import { CameraManager } from './cameras/cameraManager';

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
  // runtime check for ffmpeg (useful for stream snapshot mode)
  const hasFfmpeg = checkFfmpeg();
  if (!hasFfmpeg) {
    console.warn('Warning: ffmpeg was not found on PATH. Stream-based snapshots will not work.\n' +
      'If you are running in Docker, ensure the image includes ffmpeg (the provided Dockerfile installs it).');
  }

  const cfg = loadConfig();
  const mqttOpts: { username?: string; password?: string } = {};
  if (cfg.mqtt.username) {
    mqttOpts.username = cfg.mqtt.username;
    mqttOpts.password = cfg.mqtt.password;
  }

  const baseTopic = cfg.mqtt.basetopic || cfg.mqtt.baseTopic || 'onvif2mqtt';
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

  // publish status for each camera
  for (const c of cfg.cameras) {
    mqtt.publish(`${c.name}/status`, 'online', { retain: true });
  }

  log('App initialized');

  // graceful shutdown
  process.on('SIGINT', () => {
    log('Shutting down');
    for (const c of cfg.cameras) {
      mqtt.publish(`${c.name}/status`, 'offline', { retain: true });
    }
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error', err);
  process.exit(1);
});
