import mqtt, { MqttClient } from 'mqtt';
import debug from 'debug';
import fs from 'fs';
import { MqttConfig } from './types';
import { logError } from './logger';

const log = debug('mqtt-client');

function readTlsFile(path: string, field: string): Buffer {
  try {
    return fs.readFileSync(path);
  } catch (err) {
    logError(`[ERROR] Failed to read ${field} path=${path}`, err);
    throw new Error(`${field} could not be read path=${path}`);
  }
}

/**
 * Build the broker connection URL: `mqtt.url` wins when set (must be mqtt:// or mqtts://),
 * otherwise `{mqtt,mqtts}://server[:port]` with the default port 1883 (8883 with TLS enabled).
 */
export function buildBrokerUrl(cfg: MqttConfig): string {
  if (cfg.url) {
    if (!/^mqtts?:\/\//.test(cfg.url)) {
      throw new Error('mqtt.url must start with mqtt:// or mqtts://');
    }
    return cfg.url;
  }

  const tlsEnabled = cfg.tls?.enabled === true;
  const scheme = tlsEnabled ? 'mqtts' : 'mqtt';
  const host = cfg.server || 'localhost';
  const port = cfg.port || (tlsEnabled ? 8883 : 1883);
  return `${scheme}://${host}:${port}`;
}

/**
 * Build the mqtt.connect client options: username/password plus the retained OFFLINE
 * will on `<baseTopic>/status`, and (when tls.enabled) CA/client-certificate material
 * read from the configured files. A missing certificate file throws so the app fails
 * fast instead of silently downgrading to plaintext.
 */
export function buildClientOptions(cfg: MqttConfig): mqtt.IClientOptions {
  const opts: mqtt.IClientOptions = {};
  if (cfg.username) {
    opts.username = cfg.username;
    opts.password = cfg.password;
  }

  const baseTopic = cfg.basetopic || cfg.baseTopic || 'onvif2mqtt';
  opts.will = {
    topic: `${baseTopic}/status`,
    payload: 'OFFLINE',
    retain: true,
    qos: 1,
  };

  if (cfg.tls?.enabled) {
    if (cfg.tls.caFile) opts.ca = readTlsFile(cfg.tls.caFile, 'mqtt.tls.caFile');
    if (cfg.tls.certFile) opts.cert = readTlsFile(cfg.tls.certFile, 'mqtt.tls.certFile');
    if (cfg.tls.keyFile) opts.key = readTlsFile(cfg.tls.keyFile, 'mqtt.tls.keyFile');
    if (cfg.tls.keyPassphraseFile) {
      // mqtt.js forwards the full options object to tls.connect; the passphrase is
      // simply absent from its IClientOptions type.
      (opts as { passphrase?: string }).passphrase = readTlsFile(
        cfg.tls.keyPassphraseFile,
        'mqtt.tls.keyPassphraseFile',
      ).toString('utf8');
    }
    opts.rejectUnauthorized = cfg.tls.rejectUnauthorized ?? true;
    if (cfg.tls.servername) opts.servername = cfg.tls.servername;
  }

  return opts;
}

export class MQTTWrapper {
  private client: MqttClient;
  private subscriptions: Map<string, Set<(topic: string, message: Buffer) => void>> = new Map();
  baseTopic: string;

  constructor(brokerUrl: string, opts: mqtt.IClientOptions | Record<string, unknown> = {}, baseTopic = 'onvif2mqtt') {
    this.client = mqtt.connect(brokerUrl, opts as mqtt.IClientOptions);
    this.baseTopic = baseTopic;

    this.client.on('connect', () => log('Connected to MQTT'));
    this.client.on('reconnect', () => log('Reconnecting to MQTT'));
    this.client.on('error', (err) => log('MQTT error', err));
    this.client.on('message', (topic: string, message: Buffer) => {
      const callbacks = this.subscriptions.get(topic);
      if (!callbacks) return;
      for (const cb of callbacks) {
        cb(topic, message);
      }
    });
  }

  publish(topicPath: string, payload: Buffer | string, options?: mqtt.IClientPublishOptions) {
    const topic = `${this.baseTopic}/${topicPath}`;
    log('publish', topic);
    this.client.publish(topic, payload, options);
  }

  publishRaw(topic: string, payload: Buffer | string, options?: mqtt.IClientPublishOptions) {
    log('publish raw', topic);
    this.client.publish(topic, payload, options);
  }

  subscribe(topicPath: string, cb: (topic: string, message: Buffer) => void) {
    const topic = `${this.baseTopic}/${topicPath}`;
    let callbacks = this.subscriptions.get(topic);
    if (!callbacks) {
      callbacks = new Set();
      this.subscriptions.set(topic, callbacks);
      this.client.subscribe(topic);
    }

    callbacks.add(cb);

    return () => {
      const set = this.subscriptions.get(topic);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) {
        this.subscriptions.delete(topic);
        this.client.unsubscribe(topic);
      }
    };
  }

  async stop() {
    this.subscriptions.clear();
    await new Promise<void>((resolve) => {
      this.client.end(false, {}, () => resolve());
    });
  }

  getClient() {
    return this.client;
  }
}
