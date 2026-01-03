import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { AppConfig, CameraConfig, RawCameraEntry, MqttConfig, SnapshotConfig } from './types';

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
    } catch (_err) {
      // ignore, will log later if missing
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
  const snapshotCfg = (e.snapshot as SnapshotConfig) || undefined;
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
    } catch (_err) {
      // ignore, will log later
    }
  }

  // support password_file for snapshot credentials
  if (cfg.snapshot?.password_file && !cfg.snapshot.password) {
    try {
      const txt = fs.readFileSync(cfg.snapshot.password_file as string, 'utf8');
      cfg.snapshot.password = txt.trim();
    } catch (_err) {
      // ignore
    }
  }

  return cfg;
}

export function loadConfig(configPath?: string): AppConfig {
  // Do NOT use config.yaml.example in production. Only include the example as a fallback when
  // running tests (NODE_ENV=test) or explicitly requested via USE_EXAMPLE_CONFIG=true
  const includeExample = process.env.NODE_ENV === 'test' || process.env.USE_EXAMPLE_CONFIG === 'true';
  const candidates = [
    configPath,
    process.env.CONFIG_PATH,
    path.join(process.cwd(), 'config.yaml'),
  ];
  if (includeExample) candidates.push(path.join(process.cwd(), 'config.yaml.example'));
  const candidatesFiltered = candidates.filter(Boolean) as string[];

  let p: string | undefined;
  for (const c of candidatesFiltered) {
    if (c && fs.existsSync(c)) {
      p = c;
      break;
    }
  }
  if (!p) throw new Error('No configuration file found (looked for CONFIG_PATH, config.yaml)');

  const content = fs.readFileSync(p, 'utf8');
  const raw = p.endsWith('.yaml') || p.endsWith('.yml') ? YAML.parse(content) : JSON.parse(content);

  const mqtt = normalizeMqtt(raw.mqtt || raw.MQTT || raw.Mqtt);

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
          push: (ev.push as any) || undefined,
        };
      }
      cameras.push(cam);
    }
  }

  const cfg: AppConfig = { mqtt, cameras, notify: notifyCfg };
  return cfg;
}
