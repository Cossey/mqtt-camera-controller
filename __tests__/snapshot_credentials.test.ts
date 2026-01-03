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

describe('Snapshot credentials and address normalization', () => {
  test('loads snapshot.address and snapshot.password_file', () => {
    const pwFile = writeTempYaml('snapsecret');
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  - name: vpncam\n    host: 192.168.1.20\n    snapshot:\n      type: url\n      address: http://192.168.1.20/snap.jpg\n      password_file: ${pwFile}\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    const cam = cfg.cameras.find(c => c.name === 'vpncam');
    expect(cam).toBeDefined();
    expect(cam?.snapshot?.address).toBe('http://192.168.1.20/snap.jpg');
    expect(cam?.snapshot?.password).toBe('snapsecret');
  });

  test('embedded credentials in address are parsed and used when snapshot creds not provided', () => {
    const yaml = `mqtt:\n  server: example.com\n\ncameras:\n  - name: authcam\n    snapshot:\n      address: http://user:pass@192.168.1.30/snap.jpg\n`;
    const p = writeTempYaml(yaml);
    const cfg = loadConfig(p);
    const cam = cfg.cameras.find(c => c.name === 'authcam');
    expect(cam).toBeDefined();
    expect(cam?.snapshot?.address).toBe('http://user:pass@192.168.1.30/snap.jpg');
  });
});
