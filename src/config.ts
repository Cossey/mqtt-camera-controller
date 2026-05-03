import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { AppConfig, CameraConfig, RawCameraEntry, MqttConfig, SnapshotConfig, LogLevelName, HomeAssistantConfig, RateLimitConfig } from './types';

const VALID_SNAPSHOT_EVENT_TYPES = ['motion', 'line', 'people', 'vehicle', 'animal', 'all'] as const;

function normalizeBoolean(value: unknown, defaultValue: boolean, fieldName: string): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  throw new Error(`${fieldName} must be a boolean`);
}

function normalizeRateLimit(raw: unknown): RateLimitConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (r.cooldownMs !== undefined && typeof r.cooldownMs !== 'number') {
    throw new Error('rateLimit.cooldownMs must be a non-negative number (milliseconds)');
  }
  return {
    enabled: normalizeBoolean(r.enabled, true, 'rateLimit.enabled'),
    cooldownMs: typeof r.cooldownMs === 'number' ? r.cooldownMs : 3000,
  };
}

function validateRateLimitConfiguration(rateLimit: RateLimitConfig) {
  if (rateLimit.enabled !== undefined && typeof rateLimit.enabled !== 'boolean') {
    throw new Error('rateLimit.enabled must be a boolean');
  }

  if (typeof rateLimit.cooldownMs !== 'number' || !Number.isFinite(rateLimit.cooldownMs) || rateLimit.cooldownMs < 0) {
    throw new Error('rateLimit.cooldownMs must be a non-negative number (milliseconds)');
  }
}

function normalizeHomeAssistant(raw: unknown): HomeAssistantConfig {
  const h = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (h.prefix !== undefined && typeof h.prefix !== 'string') {
    throw new Error('homeassistant.prefix must be a non-empty string');
  }
  if (h.components !== undefined && typeof h.components !== 'object') {
    throw new Error('homeassistant.components must be an object');
  }
  const components = h.components && typeof h.components === 'object'
    ? (h.components as Record<string, unknown>)
    : {};

  return {
    enabled: normalizeBoolean(h.enabled, true, 'homeassistant.enabled'),
    prefix: typeof h.prefix === 'string' ? h.prefix : 'homeassistant',
    retain: normalizeBoolean(h.retain, true, 'homeassistant.retain'),
    components: {
      events: normalizeBoolean(components.events, true, 'homeassistant.components.events'),
      status: normalizeBoolean(components.status, true, 'homeassistant.components.status'),
      snapshot: normalizeBoolean(components.snapshot, true, 'homeassistant.components.snapshot'),
      snapshotCommand: normalizeBoolean(components.snapshotCommand, true, 'homeassistant.components.snapshotCommand'),
      appReloadCommand: normalizeBoolean(components.appReloadCommand, true, 'homeassistant.components.appReloadCommand'),
    },
  };
}

function validateHomeAssistantConfiguration(homeAssistant: HomeAssistantConfig) {
  if (homeAssistant.enabled !== undefined && typeof homeAssistant.enabled !== 'boolean') {
    throw new Error('homeassistant.enabled must be a boolean');
  }

  if (homeAssistant.retain !== undefined && typeof homeAssistant.retain !== 'boolean') {
    throw new Error('homeassistant.retain must be a boolean');
  }

  if (typeof homeAssistant.prefix !== 'string' || homeAssistant.prefix.trim().length === 0) {
    throw new Error('homeassistant.prefix must be a non-empty string');
  }

  const components = homeAssistant.components;
  if (!components) return;
  if (components.events !== undefined && typeof components.events !== 'boolean') {
    throw new Error('homeassistant.components.events must be a boolean');
  }
  if (components.status !== undefined && typeof components.status !== 'boolean') {
    throw new Error('homeassistant.components.status must be a boolean');
  }
  if (components.snapshot !== undefined && typeof components.snapshot !== 'boolean') {
    throw new Error('homeassistant.components.snapshot must be a boolean');
  }
  if (components.snapshotCommand !== undefined && typeof components.snapshotCommand !== 'boolean') {
    throw new Error('homeassistant.components.snapshotCommand must be a boolean');
  }
  if (components.appReloadCommand !== undefined && typeof components.appReloadCommand !== 'boolean') {
    throw new Error('homeassistant.components.appReloadCommand must be a boolean');
  }
}

function validateSnapshotConfiguration(cameras: CameraConfig[]) {
  for (const cam of cameras) {
    const snapshot = cam.snapshot;
    if (!snapshot) continue;

    if (snapshot.interval === undefined) {
      snapshot.interval = 0;
    }

    if (typeof snapshot.interval !== 'number' || !Number.isFinite(snapshot.interval) || snapshot.interval < 0) {
      throw new Error(`Camera '${cam.name}' has invalid snapshot.interval; expected a non-negative number (milliseconds)`);
    }

    if (snapshot.onEvent !== undefined) {
      if (!snapshot.onEvent || typeof snapshot.onEvent !== 'object' || Array.isArray(snapshot.onEvent)) {
        throw new Error(`Camera '${cam.name}' has invalid snapshot.onEvent; expected object with required 'types'`);
      }

      const rawTypes = (snapshot.onEvent as { types?: unknown }).types;
      if (!Array.isArray(rawTypes) || rawTypes.length === 0) {
        throw new Error(`Camera '${cam.name}' has invalid snapshot.onEvent.types; expected a non-empty array`);
      }

      const normalizedTypes = rawTypes.map((t) => String(t).trim().toLowerCase());
      const invalidTypes = normalizedTypes.filter((t) => !VALID_SNAPSHOT_EVENT_TYPES.includes(t as typeof VALID_SNAPSHOT_EVENT_TYPES[number]));
      if (invalidTypes.length > 0) {
        throw new Error(`Camera '${cam.name}' has invalid snapshot.onEvent.types values: ${invalidTypes.join(', ')}`);
      }

      if (normalizedTypes.includes('all') && normalizedTypes.length > 1) {
        throw new Error(`Camera '${cam.name}' has invalid snapshot.onEvent.types; 'all' must be the only value when present`);
      }

      snapshot.onEvent.types = normalizedTypes as typeof snapshot.onEvent.types;

      if (snapshot.onEvent.delay === undefined) {
        snapshot.onEvent.delay = 0;
      }

      if (typeof snapshot.onEvent.delay !== 'number' || !Number.isFinite(snapshot.onEvent.delay) || snapshot.onEvent.delay < 0) {
        throw new Error(`Camera '${cam.name}' has invalid snapshot.onEvent.delay; expected a non-negative number (milliseconds)`);
      }
    }

    const hasActiveSnapshotTrigger = snapshot.interval > 0 || snapshot.onEvent !== undefined;
    if (hasActiveSnapshotTrigger && (!snapshot.address || snapshot.address.trim().length === 0)) {
      throw new Error(`Camera '${cam.name}' requires snapshot.address when snapshot interval or onEvent is configured`);
    }
  }
}

function normalizeEndpointSelection(raw: unknown): 'auto' | 'camera' | 'configured' | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'auto' || v === 'camera' || v === 'configured') return v;
  return undefined;
}

function validateCameraOnvifConnectivity(cameras: CameraConfig[]) {
  for (const cam of cameras) {
    const mode = cam.event?.mode || 'pull';
    const requiresConnection = mode === 'pull' || (mode === 'push' && Boolean(cam.event?.push?.autoSubscribe));
    if (!requiresConnection) continue;

    if (!cam.host || typeof cam.host !== 'string' || cam.host.trim().length === 0) {
      throw new Error(`Camera '${cam.name}' requires 'host' for ONVIF ${mode} mode`);
    }

    if (typeof cam.port !== 'number' || !Number.isFinite(cam.port) || cam.port <= 0) {
      throw new Error(`Camera '${cam.name}' requires a valid numeric 'port' for ONVIF ${mode} mode`);
    }
  }
}

function normalizeMqtt(raw: unknown): MqttConfig {
  const mqtt: MqttConfig = {};
  if (!raw || typeof raw !== 'object') return mqtt;
  const r = raw as Record<string, unknown>;
  mqtt.server = (r.server as string) || (r.host as string) || undefined;
  mqtt.port = (r.port as number) || undefined;
  mqtt.client = (r.client as string) || (r.clientId as string) || undefined;
  mqtt.basetopic = (r.basetopic as string) || (r.baseTopic as string) || 'onvif2mqtt';
  mqtt.username = r.username as string | undefined;
  mqtt.password = r.password as string | undefined;
  mqtt.password_file = r.password_file as string | undefined;
  // support password_file for MQTT (Docker secrets)
  if (!mqtt.password && mqtt.password_file) {
    try {
      const txt = fs.readFileSync(mqtt.password_file, 'utf8');
      mqtt.password = txt.trim();
    } catch (err) {
      console.error(`[ERROR] Failed to read mqtt.password_file path=${mqtt.password_file}`, err);
    }
  }
  return mqtt;
}

function normalizeCamera(name: string, entry: RawCameraEntry): CameraConfig {
  if (typeof entry === 'string') {
    // simple string -> treat as snapshot address
    return {
      name,
      snapshot: { address: entry } as SnapshotConfig,
    } as CameraConfig;
  }

  const e = entry as Record<string, unknown>;
  const host = (e.host as string) || undefined;
  const port = (e.port as number) || undefined;

  // snapshot normalization: unified address field
  const snapshotCfg = (e.snapshot && typeof e.snapshot === 'object') ? { ...(e.snapshot as SnapshotConfig) } : undefined;
  let snapshotAddr = (e.url as string) || (e.snapshotUrl as string) || undefined;
  if (snapshotCfg && snapshotCfg.address) snapshotAddr = snapshotCfg.address;

  const cfg: CameraConfig = {
    name,
    host,
    port,
    username: e.username as string | undefined,
    password: e.password as string | undefined,
    snapshot: snapshotCfg as SnapshotConfig | undefined,
    eventDurations: (e.durations as Record<string, number>) || undefined,
  };

  if (snapshotAddr) {
    if (!cfg.snapshot) cfg.snapshot = {} as SnapshotConfig;
    cfg.snapshot.address = snapshotAddr;
  }

  if (cfg.snapshot && cfg.snapshot.interval === undefined) {
    cfg.snapshot.interval = 0;
  }

  if (cfg.snapshot?.onEvent && typeof cfg.snapshot.onEvent === 'object' && cfg.snapshot.onEvent.delay === undefined) {
    cfg.snapshot.onEvent.delay = 0;
  }

  // support snapshot-specific username/password/password_file
  const snap = (e.snapshot as Record<string, unknown>) || undefined;
  if (snap && cfg.snapshot) {
    if (snap.username) cfg.snapshot.username = String(snap.username);
    if (snap.password) cfg.snapshot.password = String(snap.password);
    if (snap.password_file) cfg.snapshot.password_file = String(snap.password_file);
  }

  // support password_file for camera credentials (Docker secrets)
  const pwFile = e.password_file as string | undefined;
  if (!cfg.password && pwFile) {
    try {
      const txt = fs.readFileSync(pwFile, 'utf8');
      cfg.password = txt.trim();
    } catch (err) {
      console.error(`[ERROR] Failed to read camera password_file camera=${name} path=${pwFile}`, err);
    }
  }

  // support password_file for snapshot credentials
  if (cfg.snapshot?.password_file && !cfg.snapshot.password) {
    try {
      const txt = fs.readFileSync(cfg.snapshot.password_file as string, 'utf8');
      cfg.snapshot.password = txt.trim();
    } catch (err) {
      console.error(`[ERROR] Failed to read snapshot.password_file camera=${name} path=${cfg.snapshot.password_file}`, err);
    }
  }

  return cfg;
}

export function resolveConfigPath(configPath?: string): string {
  // Do NOT use config.yaml.example in production. Only include the example as a fallback when
  // running tests (NODE_ENV=test) or explicitly requested via USE_EXAMPLE_CONFIG=true
  const includeExample = process.env.NODE_ENV === 'test' || process.env.USE_EXAMPLE_CONFIG === 'true';
  const candidates = [
    configPath,
    process.env.CONFIG_PATH,
    path.join(process.cwd(), 'config.yaml'),
  ];
  if (includeExample) candidates.push(path.join(process.cwd(), 'config.yaml.example'));

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('No configuration file found (looked for CONFIG_PATH, config.yaml)');
}

export function loadConfig(configPath?: string): AppConfig {
  const p = resolveConfigPath(configPath);

  const content = fs.readFileSync(p, 'utf8');
  const raw = p.endsWith('.yaml') || p.endsWith('.yml') ? YAML.parse(content) : JSON.parse(content);

  const mqtt = normalizeMqtt(raw.mqtt || raw.MQTT || raw.Mqtt);
  const rateLimit = normalizeRateLimit(raw.rateLimit || raw.ratelimit);
  const homeAssistant = normalizeHomeAssistant(raw.homeassistant || raw.homeAssistant || raw.hass);

  const camerasRaw = raw.cameras || raw.Cameras || raw.onvif || {};
  const cameras: CameraConfig[] = [];

  // optional notify server config
  const notify = raw.notify || raw.notifications || undefined;
  let notifyCfg: AppConfig['notify'] = undefined;
  if (notify && typeof notify === 'object') {
    notifyCfg = {
      baseUrl: notify.baseUrl as string | undefined,
      port: notify.port as number | undefined,
      basePath: notify.basePath as string | undefined,
    };
  }

  // optional logging config
  const loggingRaw = raw.logging || raw.log || undefined;
  let loggingCfg: AppConfig['logging'] = undefined;
  if (loggingRaw && typeof loggingRaw === 'object') {
    const level = String((loggingRaw as Record<string, unknown>).level || '').toLowerCase();
    if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
      loggingCfg = { level: level as LogLevelName };
    }
  }

  // cameras may be an object mapping names -> entry or an array
  if (Array.isArray(camerasRaw)) {
    for (const ent of camerasRaw) {
      if (typeof ent === 'string') {
        // no name, use url as name placeholder
        cameras.push(normalizeCamera(ent, ent));
      } else if (ent && typeof ent === 'object' && 'name' in ent) {
        const entObj = ent as Record<string, unknown>;
        const name = String(entObj.name);
        const cam = normalizeCamera(name, entObj as RawCameraEntry);
        // support event.mode and push options
        if (entObj.event && typeof entObj.event === 'object') {
          const ev = entObj.event as any;
          cam.event = {
            mode: (ev.mode as 'pull' | 'push') || undefined,
            pull: {
              endpointSelection: normalizeEndpointSelection(ev.pull?.endpointSelection) || 'auto',
            },
            push: (ev.push as any) || undefined,
          };
        }
        cameras.push(cam);
      }
    }
  } else if (camerasRaw && typeof camerasRaw === 'object') {
    for (const [name, entry] of Object.entries(camerasRaw)) {
      const cam = normalizeCamera(name, entry as RawCameraEntry);
      const entObj = entry as Record<string, unknown>;
      if (entObj.event && typeof entObj.event === 'object') {
        const ev = entObj.event as any;
        cam.event = {
          mode: (ev.mode as 'pull' | 'push') || undefined,
          pull: {
            endpointSelection: normalizeEndpointSelection(ev.pull?.endpointSelection) || 'auto',
          },
          push: (ev.push as any) || undefined,
        };
      }
      cameras.push(cam);
    }
  }

  validateSnapshotConfiguration(cameras);
  validateRateLimitConfiguration(rateLimit);
  validateHomeAssistantConfiguration(homeAssistant);
  validateCameraOnvifConnectivity(cameras);

  const cfg: AppConfig = { mqtt, cameras, rateLimit, homeassistant: homeAssistant, notify: notifyCfg, logging: loggingCfg };
  return cfg;
}
