import debug from 'debug';
import fs from 'fs';
import http from 'http';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { loadConfig, resolveConfigPath } from './config';
import { buildBrokerUrl, buildClientOptions, MQTTWrapper } from './mqttClient';
import { CameraManager } from './cameras/cameraManager';
import { AppConfig } from './types';
import { setLogLevel, logInfo, logWarn, logError, logDebug } from './logger';

const log = debug('app');
const CONFIG_WATCH_ENV_NAME = 'MQTT_CAM_CONFIG_RELOAD';
const CONFIG_WATCH_DEBOUNCE_MS = 500;

function checkFfmpeg() {
  try {
    const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return res.status === 0;
  } catch (err) {
    return false;
  }
}

interface RuntimeState {
  cfg: AppConfig;
  mqtt: MQTTWrapper;
  camManager: CameraManager;
  pushServer: http.Server | null;
}

function buildMqttOptions(cfg: AppConfig) {
  // Thin wrapper over the shared mqttClient builders so connection handling
  // (credentials, will, TLS material) lives in one place.
  return {
    mqttOpts: buildClientOptions(cfg.mqtt),
    baseTopic: cfg.mqtt.basetopic || cfg.mqtt.baseTopic || 'onvif2mqtt',
  };
}

function createMqttClient(cfg: AppConfig): MQTTWrapper {
  const { mqttOpts, baseTopic } = buildMqttOptions(cfg);
  return new MQTTWrapper(buildBrokerUrl(cfg.mqtt), mqttOpts, baseTopic);
}

function readFingerprintFileHash(path?: string): string | null {
  if (!path) return null;
  try {
    return createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  } catch (err) {
    // Unreadable files fail fast when the client options are built; keep the
    // fingerprint total (null) so a later fix still reconnects.
    logDebug(`[DEBUG] mqttFingerprint could not read file path=${path}`, err);
    return null;
  }
}

function mqttFingerprint(cfg: AppConfig): string {
  const baseTopic = cfg.mqtt.basetopic || cfg.mqtt.baseTopic || 'onvif2mqtt';
  const brokerUrl = buildBrokerUrl(cfg.mqtt);
  const username = cfg.mqtt.username || '';
  const password = cfg.mqtt.password || '';
  // TLS settings and certificate file contents are part of the fingerprint so
  // rotating a cert forces an MQTT reconnect on reload.
  const tls = cfg.mqtt.tls
    ? {
        enabled: cfg.mqtt.tls.enabled ?? false,
        rejectUnauthorized: cfg.mqtt.tls.rejectUnauthorized ?? true,
        servername: cfg.mqtt.tls.servername ?? null,
        caFile: cfg.mqtt.tls.caFile ?? null,
        certFile: cfg.mqtt.tls.certFile ?? null,
        keyFile: cfg.mqtt.tls.keyFile ?? null,
        keyPassphraseFile: cfg.mqtt.tls.keyPassphraseFile ?? null,
        ca: readFingerprintFileHash(cfg.mqtt.tls.caFile),
        cert: readFingerprintFileHash(cfg.mqtt.tls.certFile),
        key: readFingerprintFileHash(cfg.mqtt.tls.keyFile),
        passphrase: readFingerprintFileHash(cfg.mqtt.tls.keyPassphraseFile),
      }
    : null;
  return JSON.stringify({ brokerUrl, baseTopic, username, password, tls });
}

async function closePushServer(server: http.Server | null) {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function startRuntime(cfg: AppConfig, existingMqtt?: MQTTWrapper): Promise<RuntimeState> {
  setLogLevel(cfg.logging?.level || process.env.LOG_LEVEL);

  const mqtt = existingMqtt || createMqttClient(cfg);
  const camManager = new CameraManager(cfg, mqtt);

  let pushServer: http.Server | null = null;
  if (cfg.notify) {
    try {
      const { startPushServer } = await import('./onvif/push');
      pushServer = startPushServer(cfg, camManager);
    } catch (err) {
      log('push notify module not available', err);
    }
  }

  await camManager.init();
  mqtt.publish('status', 'ONLINE', { retain: true });
  logInfo('[INFO] Global app status set to ONLINE topic=status');

  return {
    cfg,
    mqtt,
    camManager,
    pushServer,
  };
}

async function stopRuntime(runtime: RuntimeState, options: { publishOffline: boolean; stopMqtt: boolean }) {
  if (options.publishOffline) {
    runtime.mqtt.publish('status', 'OFFLINE', { retain: true });
    for (const camera of runtime.cfg.cameras) {
      runtime.mqtt.publish(`${camera.name}/status`, 'OFFLINE', { retain: true });
    }
  }

  await runtime.camManager.stop();
  await closePushServer(runtime.pushServer);

  if (options.stopMqtt) {
    await runtime.mqtt.stop();
  }
}

async function main() {
  const initialConfigPath = resolveConfigPath();
  const cfg = loadConfig(initialConfigPath);
  setLogLevel(cfg.logging?.level || process.env.LOG_LEVEL);

  // runtime check for ffmpeg (useful for stream snapshot mode)
  const hasFfmpeg = checkFfmpeg();
  if (!hasFfmpeg) {
    logWarn('Warning: ffmpeg was not found on PATH. Stream-based snapshots will not work.\n' +
      'If you are running in Docker, ensure the image includes ffmpeg (the provided Dockerfile installs it).');
  }

  let runtime = await startRuntime(cfg);
  let activeConfigPath = initialConfigPath;

  log('App initialized');

  let shuttingDown = false;
  let reloading = false;
  let unsubscribeGlobalCommand: (() => void) | null = null;
  let configWatcher: fs.FSWatcher | null = null;
  let configWatchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const stopGlobalCommandSubscription = () => {
    if (!unsubscribeGlobalCommand) return;
    unsubscribeGlobalCommand();
    unsubscribeGlobalCommand = null;
  };

  const stopConfigWatcher = () => {
    if (configWatchDebounceTimer) {
      clearTimeout(configWatchDebounceTimer);
      configWatchDebounceTimer = null;
    }
    if (!configWatcher) return;
    configWatcher.close();
    configWatcher = null;
  };

  const setupGlobalCommandSubscription = () => {
    stopGlobalCommandSubscription();
    unsubscribeGlobalCommand = runtime.mqtt.subscribe('command', (_topic: string, message: Buffer) => {
      const command = message.toString('utf8').trim().toLowerCase();
      if (command !== 'reload') {
        logDebug(`[DEBUG] Unsupported global command ignored command=${command || '<empty>'}`);
        return;
      }

      logInfo('[INFO] MQTT reload command received topic=command');
      void requestReload('mqtt-command');
    });
  };

  const setupConfigWatcher = () => {
    stopConfigWatcher();

    if (process.env[CONFIG_WATCH_ENV_NAME] !== 'true') return;

    try {
      configWatcher = fs.watch(activeConfigPath, () => {
        if (shuttingDown) return;

        if (configWatchDebounceTimer) {
          clearTimeout(configWatchDebounceTimer);
        }

        configWatchDebounceTimer = setTimeout(() => {
          configWatchDebounceTimer = null;
          logInfo(`[INFO] Config file change detected, reloading path=${activeConfigPath}`);
          void requestReload('file-watch');
        }, CONFIG_WATCH_DEBOUNCE_MS);
      });

      configWatcher.on('error', (err) => {
        logError(`[ERROR] Config file watcher error path=${activeConfigPath}`, err);
      });

      logInfo(`[INFO] Config file watcher enabled env=${CONFIG_WATCH_ENV_NAME} path=${activeConfigPath}`);
    } catch (err) {
      logError(`[ERROR] Failed to watch config file path=${activeConfigPath}`, err);
    }
  };

  const requestReload = async (trigger: 'sighup' | 'mqtt-command' | 'file-watch') => {
    if (shuttingDown || reloading) return;
    reloading = true;

    const previousRuntime = runtime;
    const previousConfigPath = activeConfigPath;
    let shouldReconnectMqtt = false;

    try {
      if (trigger === 'sighup') {
        logInfo('[INFO] SIGHUP received, reloading configuration');
      } else if (trigger === 'mqtt-command') {
        logInfo('[INFO] MQTT command requested configuration reload');
      } else {
        logInfo('[INFO] File watcher requested configuration reload');
      }

      const nextConfigPath = resolveConfigPath();
      const nextCfg = loadConfig(nextConfigPath);

      shouldReconnectMqtt = mqttFingerprint(runtime.cfg) !== mqttFingerprint(nextCfg);
      const reusableMqtt = shouldReconnectMqtt ? undefined : runtime.mqtt;

      stopGlobalCommandSubscription();
      await previousRuntime.camManager.stop();
      await closePushServer(previousRuntime.pushServer);
      if (shouldReconnectMqtt) {
        await previousRuntime.mqtt.stop();
      }

      runtime = await startRuntime(nextCfg, reusableMqtt);
      activeConfigPath = nextConfigPath;
      logInfo(`[INFO] Configuration reload complete trigger=${trigger}`);
    } catch (err) {
      logError('[ERROR] Configuration reload failed', err);
      try {
        const rollbackMqtt = shouldReconnectMqtt ? undefined : previousRuntime.mqtt;
        runtime = await startRuntime(previousRuntime.cfg, rollbackMqtt);
        activeConfigPath = previousConfigPath;
        logWarn('[WARN] Reload rolled back to previous configuration');
      } catch (rollbackErr) {
        logError('[ERROR] Reload rollback failed', rollbackErr);
      }
    } finally {
      setupGlobalCommandSubscription();
      setupConfigWatcher();
      reloading = false;
    }
  };

  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log('Shutting down');
    logInfo(`[INFO] ${signal} received, shutting down runtime`);

    try {
      stopGlobalCommandSubscription();
      stopConfigWatcher();
      await stopRuntime(runtime, { publishOffline: true, stopMqtt: true });
      process.exit(0);
    } catch (err) {
      logError('[ERROR] Failed during shutdown', err);
      process.exit(1);
    }
  };

  setupGlobalCommandSubscription();
  setupConfigWatcher();

  process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
  process.on('SIGHUP', () => { void requestReload('sighup'); });
}

main().catch((err) => {
  logError('[ERROR] Fatal error', err);
  process.exit(1);
});
