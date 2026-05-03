import mqtt, { MqttClient } from 'mqtt';
import debug from 'debug';

const log = debug('mqtt-client');

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
