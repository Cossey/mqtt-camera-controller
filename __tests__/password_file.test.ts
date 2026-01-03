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

describe('password_file handling', () => {
  test('mqtt.password_file loads password', () => {
    const pwFile = path.join(os.tmpdir(), 'mqtt_pw_test');
    fs.writeFileSync(pwFile, 's3cret\n');

    const yaml = `mqtt:\n  server: example.com\n  password_file: ${pwFile}\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    expect(cfg.mqtt.password).toBe('s3cret');
  });

  test('camera password_file loads camera password', () => {
    const pwFile = path.join(os.tmpdir(), 'cam_pw_test');
    fs.writeFileSync(pwFile, 'camsecret\n');

    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  front-door:\n    host: 192.168.1.10\n    password_file: ${pwFile}\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    const cam = cfg.cameras.find(c => c.name === 'front-door');
    expect(cam?.password).toBe('camsecret');
  });
});