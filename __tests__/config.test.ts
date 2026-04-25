import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../src/config';

function writeTempYaml(content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const p = path.join(dir, 'test.yaml');
  fs.writeFileSync(p, content);
  return p;
}

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
});