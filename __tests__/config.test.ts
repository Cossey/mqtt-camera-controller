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

  test('defaults snapshot.interval and snapshot.onEvent.delay to 0 when omitted', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    port: 80\n    snapshot:\n      address: http://192.168.1.10/snap.jpg\n      onEvent:\n        types: [motion]\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    const cam = cfg.cameras.find(c => c.name === 'front-door');
    expect(cam?.snapshot?.interval).toBe(0);
    expect(cam?.snapshot?.onEvent?.delay).toBe(0);
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
});