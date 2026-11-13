import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildBrokerUrl, buildClientOptions } from '../src/mqttClient';
import { MqttConfig } from '../src/types';

describe('buildBrokerUrl', () => {
  test('defaults to mqtt://localhost:1883', () => {
    expect(buildBrokerUrl({})).toBe('mqtt://localhost:1883');
  });

  test('uses the configured server and port', () => {
    expect(buildBrokerUrl({ server: 'example.com', port: 1884 })).toBe('mqtt://example.com:1884');
  });

  test('uses mqtts and port 8883 when tls is enabled', () => {
    expect(buildBrokerUrl({ server: 'broker.example', tls: { enabled: true } })).toBe('mqtts://broker.example:8883');
  });

  test('keeps an explicit port when tls is enabled', () => {
    expect(buildBrokerUrl({ server: 'broker.example', port: 8884, tls: { enabled: true } })).toBe('mqtts://broker.example:8884');
  });

  test('stays plain mqtt when tls exists but is not enabled', () => {
    expect(buildBrokerUrl({ server: 'broker.example', tls: { caFile: '/run/secrets/ca.crt' } })).toBe('mqtt://broker.example:1883');
  });

  test('url override wins over server/port/tls', () => {
    const url = 'mqtts://user:pass@broker.example:8883';
    expect(buildBrokerUrl({ server: 'other.example', port: 1883, url, tls: { enabled: true } })).toBe(url);
  });

  test('rejects a non-mqtt url scheme', () => {
    expect(() => buildBrokerUrl({ url: 'http://broker.example:1883' })).toThrow('mqtt.url must start with mqtt:// or mqtts://');
  });
});

describe('buildClientOptions', () => {
  test('includes username/password and the retained OFFLINE will', () => {
    const opts = buildClientOptions({ basetopic: 'mqttai', username: 'user', password: 'pass' });
    expect(opts.username).toBe('user');
    expect(opts.password).toBe('pass');
    expect(opts.will).toEqual({
      topic: 'mqttai/status',
      payload: 'OFFLINE',
      retain: true,
      qos: 1,
    });
  });

  test('uses the baseTopic fallback for the will', () => {
    const opts = buildClientOptions({ baseTopic: 'legacy' });
    expect(opts.will?.topic).toBe('legacy/status');
    expect(opts.username).toBeUndefined();
  });

  test('loads tls material from files when tls is enabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqtt-tls-'));
    const caFile = path.join(dir, 'ca.crt');
    const certFile = path.join(dir, 'client.crt');
    const keyFile = path.join(dir, 'client.key');
    const passphraseFile = path.join(dir, 'key.pass');
    fs.writeFileSync(caFile, 'CA-CONTENT');
    fs.writeFileSync(certFile, 'CERT-CONTENT');
    fs.writeFileSync(keyFile, 'KEY-CONTENT');
    fs.writeFileSync(passphraseFile, 'KEY-PASSPHRASE');

    const cfg: MqttConfig = {
      server: 'broker.example',
      tls: {
        enabled: true,
        caFile,
        certFile,
        keyFile,
        keyPassphraseFile: passphraseFile,
        servername: 'broker.local',
      },
    };

    try {
      const opts = buildClientOptions(cfg);
      expect(Buffer.isBuffer(opts.ca)).toBe(true);
      expect((opts.ca as Buffer).toString()).toBe('CA-CONTENT');
      expect((opts.cert as Buffer).toString()).toBe('CERT-CONTENT');
      expect((opts.key as Buffer).toString()).toBe('KEY-CONTENT');
      expect((opts as { passphrase?: string }).passphrase).toBe('KEY-PASSPHRASE');
      expect(opts.rejectUnauthorized).toBe(true); // default when tls enabled
      expect(opts.servername).toBe('broker.local');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('passes rejectUnauthorized: false through', () => {
    const opts = buildClientOptions({ tls: { enabled: true, rejectUnauthorized: false } });
    expect(opts.rejectUnauthorized).toBe(false);
  });

  test('does not set tls options when tls is disabled', () => {
    const opts = buildClientOptions({ server: 'broker.example', tls: { caFile: '/run/secrets/ca.crt' } });
    expect(opts.ca).toBeUndefined();
    expect(opts.cert).toBeUndefined();
    expect(opts.key).toBeUndefined();
    expect(opts.rejectUnauthorized).toBeUndefined();
  });

  test('throws when a tls file cannot be read', () => {
    const cfg: MqttConfig = {
      tls: { enabled: true, caFile: path.join(os.tmpdir(), 'does-not-exist-ca.crt') },
    };
    expect(() => buildClientOptions(cfg)).toThrow('mqtt.tls.caFile could not be read');
  });
});
