import mqtt, { MqttClient } from 'mqtt';
import debug from 'debug';

const log = debug('mqtt-client');

export class MQTTWrapper {
  private client: MqttClient;
  baseTopic: string;

  constructor(brokerUrl: string, opts: mqtt.IClientOptions | Record<string, unknown> = {}, baseTopic = 'onvif2mqtt') {
    this.client = mqtt.connect(brokerUrl, opts as mqtt.IClientOptions);
    this.baseTopic = baseTopic;

    this.client.on('connect', () => log('Connected to MQTT'));
    this.client.on('reconnect', () => log('Reconnecting to MQTT'));
    this.client.on('error', (err) => log('MQTT error', err));
  }

  publish(topicPath: string, payload: Buffer | string, options?: mqtt.IClientPublishOptions) {
    const topic = `${this.baseTopic}/${topicPath}`;
    log('publish', topic);
    this.client.publish(topic, payload, options);
  }

  subscribe(topicPath: string, cb: (topic: string, message: Buffer) => void) {
    const topic = `${this.baseTopic}/${topicPath}`;
    this.client.subscribe(topic);
    this.client.on('message', (t: string, msg: Buffer) => {
      if (t === topic) cb(t, msg);
    });
  }

  getClient() {
    return this.client;
  }
}
