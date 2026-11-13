import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, resolveConfigPath } from '../src/config';

function writeTempYaml(content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const p = path.join(dir, 'test.yaml');
  fs.writeFileSync(p, content);
  return p;
}

describe('Config path resolution', () => {
  const originalConfigPath = process.env.CONFIG_PATH;

  afterEach(() => {
    if (originalConfigPath === undefined) {
      delete process.env.CONFIG_PATH;
    } else {
      process.env.CONFIG_PATH = originalConfigPath;
    }
  });

  test('prefers explicit path over CONFIG_PATH', () => {
    const explicitPath = writeTempYaml('mqtt: {}\ncameras: {}\n');
    const envPath = writeTempYaml('mqtt: {}\ncameras: {}\n');
    process.env.CONFIG_PATH = envPath;

    expect(resolveConfigPath(explicitPath)).toBe(explicitPath);
  });

  test('uses CONFIG_PATH when explicit path is not provided', () => {
    const envPath = writeTempYaml('mqtt: {}\ncameras: {}\n');
    process.env.CONFIG_PATH = envPath;

    expect(resolveConfigPath()).toBe(envPath);
  });
});

describe('Config loader normalization', () => {
  test('loads mapping form cameras and mqtt server', () => {
    const yaml = `mqtt:\n  server: example.com\n  port: 1884\n  basetopic: testbase\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      type: url\n      address: http://192.168.1.10/snap.jpg\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.mqtt.server).toBe('example.com');
    expect(cfg.mqtt.basetopic).toBe('testbase');
    expect(cfg.cameras.find(c => c.name === 'front-door')?.host).toBe('192.168.1.10');
  });

  test('loads array form cameras and stream snapshot', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  - name: driveway\n    host: 192.168.1.11\n    port: 554\n    snapshot:\n      type: stream\n      address: rtsp://192.168.1.11/stream\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    const cam = cfg.cameras.find(c => c.name === 'driveway');
    expect(cam).toBeDefined();
    expect(cam?.host).toBe('192.168.1.11');
    expect(cam?.snapshot?.type).toBe('stream');
  });

  test('loads pull endpointSelection mode from camera event config', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  gate:\n    host: 192.168.1.50\n    port: 2020\n    event:\n      mode: pull\n      pull:\n        endpointSelection: configured\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    const cam = cfg.cameras.find(c => c.name === 'gate');
    expect(cam?.event?.pull?.endpointSelection).toBe('configured');
  });

  test('throws when pull mode camera has no port', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  garage:\n    host: 192.168.1.50\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow("Camera 'garage' requires a valid numeric 'port' for ONVIF pull mode");
  });

  test('defaults snapshot interval and onEvent delays to 0 when omitted', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      onEvent:\n        types: [motion]\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    const cam = cfg.cameras.find(c => c.name === 'front-door');
    expect(cam?.snapshot?.interval).toBe(0);
    expect(cam?.snapshot?.onEvent?.delay).toBe(0);
    expect(cam?.snapshot?.onEvent?.stopDelay).toBe(0);
    expect(cam?.snapshot?.onEvent?.mode).toBe('single');
  });

  test('loads snapshot.onEvent.stopDelay in milliseconds', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      onEvent:\n        types: [motion]\n        stopDelay: 5000\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.cameras[0].snapshot?.onEvent?.stopDelay).toBe(5000);
  });

  test('rejects a negative snapshot.onEvent.stopDelay', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      onEvent:\n        types: [motion]\n        stopDelay: -1\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow("Camera 'front-door' has invalid snapshot.onEvent.stopDelay");
  });

  test('loads continuous snapshot.onEvent mode', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      onEvent:\n        types: [people]\n        mode: continuous\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.cameras[0].snapshot?.onEvent?.mode).toBe('continuous');
  });

  test('defaults snapshot.timeout when omitted and keeps an explicit value', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      interval: 60000\n  back-door:\n    host: 192.168.1.12\n    port: 80\n    snapshot:\n      address: http://192.168.1.12/snap.jpg\n      interval: 60000\n      timeout: 30000\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.cameras.find(c => c.name === 'front-door')?.snapshot?.timeout).toBe(15000);
    expect(cfg.cameras.find(c => c.name === 'back-door')?.snapshot?.timeout).toBe(30000);
  });

  test('rejects invalid snapshot.timeout', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      interval: 60000\n      timeout: -1\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow("Camera 'front-door' has invalid snapshot.timeout");
  });

  test('rejects invalid snapshot.onEvent mode', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      onEvent:\n        types: [people]\n        mode: burst\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow("Camera 'front-door' has invalid snapshot.onEvent.mode");
  });

  test('throws when snapshot.onEvent uses boolean form', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      onEvent: true\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow("Camera 'front-door' has invalid snapshot.onEvent");
  });

  test('throws when snapshot.onEvent.types is missing', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      onEvent:\n        delay: 100\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow("Camera 'front-door' has invalid snapshot.onEvent.types");
  });

  test('throws when snapshot.onEvent.types contains invalid values', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      onEvent:\n        types: [motion, bark]\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow("Camera 'front-door' has invalid snapshot.onEvent.types values");
  });

  test('throws when snapshot.onEvent.types mixes all with other values', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      onEvent:\n        types: [all, motion]\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow("Camera 'front-door' has invalid snapshot.onEvent.types; 'all' must be the only value when present");
  });

  test('throws when snapshot trigger is configured without snapshot.address', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      onEvent:\n        types: [motion]\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow("Camera 'front-door' requires snapshot.address when snapshot interval or onEvent is configured");
  });

  test('throws when camera statusHeartbeatInterval is invalid', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    statusHeartbeatInterval: -1\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow("Camera 'front-door' has invalid statusHeartbeatInterval; expected a non-negative number (milliseconds)");
  });

  test('throws when root statusHeartbeatInterval is invalid', () => {
    const yaml = `mqtt:\n  server: example.com\nstatusHeartbeatInterval: -1\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow('Invalid statusHeartbeatInterval; expected a non-negative number (milliseconds) or undefined');
  });

  test('defaults homeassistant enabled and root rateLimit cooldown', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.homeassistant?.enabled).toBe(true);
    expect(cfg.homeassistant?.prefix).toBe('homeassistant');
    expect(cfg.rateLimit?.enabled).toBe(true);
    expect(cfg.rateLimit?.cooldownMs).toBe(3000);
  });

  test('allows disabling homeassistant discovery explicitly', () => {
    const yaml = `mqtt:\n  server: example.com\n\nhomeassistant:\n  enabled: false\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.homeassistant?.enabled).toBe(false);
  });

  test('throws for invalid root rateLimit.cooldownMs', () => {
    const yaml = `mqtt:\n  server: example.com\n\nrateLimit:\n  cooldownMs: -1\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow('rateLimit.cooldownMs must be a non-negative number (milliseconds)');
  });

  test('throws for invalid homeassistant.enabled type', () => {
    const yaml = `mqtt:\n  server: example.com\n\nhomeassistant:\n  enabled: yes\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow('homeassistant.enabled must be a boolean');
  });

  test('throws for invalid homeassistant.components.appReloadCommand type', () => {
    const yaml = `mqtt:\n  server: example.com\n\nhomeassistant:\n  components:\n    appReloadCommand: yes\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow('homeassistant.components.appReloadCommand must be a boolean');
  });

  test('loads mqtt.tls settings', () => {
    const yaml = `mqtt:\n  server: example.com\n  tls:\n    enabled: true\n    caFile: /run/secrets/ca.crt\n    certFile: /run/secrets/client.crt\n    keyFile: /run/secrets/client.key\n    keyPassphraseFile: /run/secrets/key.pass\n    rejectUnauthorized: false\n    servername: broker.example\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.mqtt.tls).toEqual({
      enabled: true,
      caFile: '/run/secrets/ca.crt',
      certFile: '/run/secrets/client.crt',
      keyFile: '/run/secrets/client.key',
      keyPassphraseFile: '/run/secrets/key.pass',
      rejectUnauthorized: false,
      servername: 'broker.example',
    });
  });

  test('omits mqtt.tls when absent', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.mqtt.tls).toBeUndefined();
    expect(cfg.mqtt.url).toBeUndefined();
  });

  test('throws when mqtt.tls sets only one of certFile/keyFile', () => {
    const yaml = `mqtt:\n  server: example.com\n  tls:\n    enabled: true\n    certFile: /run/secrets/client.crt\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow('mqtt.tls requires both certFile and keyFile');
  });

  test('throws when mqtt.tls is not an object', () => {
    const yaml = `mqtt:\n  server: example.com\n  tls: true\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow('mqtt.tls must be an object');
  });

  test('throws when mqtt.url has an unsupported scheme', () => {
    const yaml = `mqtt:\n  url: http://example.com:1883\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow('mqtt.url must start with mqtt:// or mqtts://');
  });

  test('loads an mqtts:// mqtt.url override', () => {
    const yaml = `mqtt:\n  url: mqtts://user:pass@broker.example:8883\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.mqtt.url).toBe('mqtts://user:pass@broker.example:8883');
  });

  test('loads homeassistant.expireAfterSeconds when set', () => {
    const yaml = `mqtt:\n  server: example.com\n\nhomeassistant:\n  expireAfterSeconds: 3600\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.homeassistant?.expireAfterSeconds).toBe(3600);
  });

  test('treats homeassistant.expireAfterSeconds 0 as unset', () => {
    const yaml = `mqtt:\n  server: example.com\n\nhomeassistant:\n  expireAfterSeconds: 0\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.homeassistant?.expireAfterSeconds).toBeUndefined();
  });

  test('throws for invalid homeassistant.expireAfterSeconds', () => {
    const yaml = `mqtt:\n  server: example.com\n\nhomeassistant:\n  expireAfterSeconds: -5\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow('homeassistant.expireAfterSeconds must be a non-negative integer (seconds)');
  });

  test('throws for non-integer homeassistant.expireAfterSeconds', () => {
    const yaml = `mqtt:\n  server: example.com\n\nhomeassistant:\n  expireAfterSeconds: 1.5\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n`;
    const p = writeTempYaml(yaml);
    expect(() => loadConfig(p)).toThrow('homeassistant.expireAfterSeconds must be a non-negative integer (seconds)');
  });
});