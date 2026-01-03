import debug from 'debug';
import { spawn } from 'child_process';
import fs from 'fs';
import { CameraConfig } from '../types';
import { MQTTWrapper } from '../mqttClient';

const log = debug('camera');

export class Camera {
  cfg: CameraConfig;
  mqtt: MQTTWrapper;

  constructor(cfg: CameraConfig, mqtt: MQTTWrapper) {
    this.cfg = cfg;
    this.mqtt = mqtt;
  }

  async init() {
    log('Initialized camera (no onvif client)', this.cfg.name);

    // Subscribe to commands for snapshot requests
    this.mqtt.subscribe(`${this.cfg.name}/command/snapshot`, async (_t: string, _message: Buffer) => {
      log('snapshot command for', this.cfg.name);
      try {
        const snap = await this.getSnapshot();
        await this.publishSnapshot(snap);
      } catch (err) {
        log('snapshot error', err);
      }
    });

    // ONVIF event subscription mode: support PullPoint (default) and Push/Notify
    const mode = this.cfg.event?.mode || 'pull';

    if (mode === 'pull') {
      try {
        const { startPullPoint } = await import('../onvif/pullPoint');
        startPullPoint(this.cfg, async (evt) => {
          try {
            await this.handleEvent(evt);
          } catch (err: unknown) {
            log('handleEvent failed', err);
          }
        }).catch((err: unknown) => log('PullPoint start error', err));
      } catch (err) {
        log('PullPoint module not available', err);
      }
    }

    // if push mode is configured and autoSubscribe is true, attempt to create subscription when app-level notify.baseUrl is set
    if (mode === 'push') {
      // we perform auto subscribe in CameraManager where we have access to notify server info
      log('Configured for push-mode events');
    }
  }

  async getSnapshot(): Promise<Buffer> {
    // Determine snapshot behavior: prefer explicit snapshot.type; address is in snapshot.address
    const snapshot = this.cfg.snapshot;
    const address = snapshot?.address;
    const snapshotType = snapshot?.type || (address && (address.startsWith('rtsp') || address.startsWith('rtmp')) ? 'stream' : (address ? 'url' : undefined));

    if (snapshotType === 'stream') {
      const streamUrl = address;
      if (!streamUrl) throw new Error('No stream address configured for stream snapshot');
      // Use ffmpeg to grab a single frame and output to stdout
      return await new Promise<Buffer>((resolve, reject) => {
        const args = [
          '-hide_banner',
          '-loglevel', 'error',
          '-y',
          '-i', streamUrl,
          '-frames:v', '1',
          '-f', 'image2',
          '-' // stdout
        ];
        const ff = spawn('ffmpeg', args);
        const chunks: Buffer[] = [];
        let stderr = '';
        ff.stdout.on('data', (c: Buffer) => chunks.push(c));
        ff.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
        ff.on('close', (code: number | null) => {
          if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
          else reject(new Error(`ffmpeg failed: code=${code} ${stderr}`));
        });
        ff.on('error', (err: Error) => reject(err));
      });
    }

    if (snapshotType === 'url') {
      const addr = address;
      if (!addr) throw new Error('No snapshot address configured for camera');
      const fetcher = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
      if (!fetcher) throw new Error('Global fetch() is not available in this runtime');

      const headers: Record<string, string> = {};

      // resolve credentials: snapshot-specific credentials take precedence, otherwise embedded credentials in URL
      let username: string | undefined = snapshot?.username || undefined;
      let password: string | undefined = snapshot?.password || undefined;

      try {
        const u = new URL(addr);
        if ((!username || !password) && (u.username || u.password)) {
          username = u.username || username;
          password = u.password || password;
        }
      } catch (_err) {
        // ignore URL parse error
      }

      if (!password && snapshot?.password_file) {
        // password_file should have been resolved at config load, but attempt to read here too
        try {
          const txt = fs.readFileSync(snapshot?.password_file as string, 'utf8');
          password = txt.trim();
        } catch (_e) {
          // ignore
        }
      }

      if (username && password) {
        const token = Buffer.from(`${username}:${password}`).toString('base64');
        headers.Authorization = `Basic ${token}`;
      }

      interface SimpleRequestInit { method?: string; headers?: Record<string,string>; body?: string }
      const init: SimpleRequestInit = { headers };
      const res = await fetcher(addr, init as SimpleRequestInit);
      if (!res.ok) throw new Error(`Snapshot fetch failed ${res.status}`);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    }

    throw new Error('No snapshot configuration available (address)');
  }

  buildBasicAuthHeader() {
    if (!this.cfg.username) return '';
    const auth = Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64');
    return `Basic ${auth}`;
  }

  async publishSnapshot(img: Buffer) {
    // Publish a raw image buffer (no JSON wrapper) to the image topic
    this.mqtt.publish(`${this.cfg.name}/image`, img);
  }

  normalizeEventType(raw: string) {
    const s = (raw || '').toLowerCase();
    if (s.includes('line') || s.includes('linecross')) return 'line';
    if (s.includes('person') || s.includes('people')) return 'people';
    if (s.includes('vehicle')) return 'vehicle';
    if (s.includes('pet') || s.includes('animal')) return 'animal';
    if (s.includes('motion')) return 'motion';
    return null;
  }

  async handleEvent(event: unknown) {
    // event may be string, { type, state } or an array of such
    const evts: unknown[] = Array.isArray(event) ? (event as unknown[]) : [event];

    for (const e of evts) {
      let type: string | null = null;
      let state: boolean | null | undefined = undefined;
      if (typeof e === 'string') {
        type = this.normalizeEventType(e);
      } else if (e && typeof e === 'object') {
        const obj = e as Record<string, unknown>;
        if (obj.type) {
          type = this.normalizeEventType(String(obj.type));
        }
        if ('state' in obj) {
          state = typeof obj.state === 'boolean' ? (obj.state as boolean) : (obj.state === null ? null : undefined);
        }
      }

      if (!type) continue;
      const topic = `${this.cfg.name}/${type}`;

      const duration = this.cfg.eventDurations?.[type];

      if (duration && duration > 0) {
        // behave as pulse: set ON then schedule OFF
        this.mqtt.publish(topic, 'ON');
        setTimeout(() => this.mqtt.publish(topic, 'OFF'), duration * 1000);
      } else {
        // duration is absent or zero: follow ONVIF's reported state if available
        if (state === true) {
          this.mqtt.publish(topic, 'ON');
        } else if (state === false) {
          this.mqtt.publish(topic, 'OFF');
        } else {
          // no explicit state reported: emit ON (no scheduled OFF)
          this.mqtt.publish(topic, 'ON');
        }
      }
    }

    if (this.cfg.snapshot?.onEvent) {
      try {
        const snap = await this.getSnapshot();
        await this.publishSnapshot(snap);
      } catch (err) {
        log('snapshot on event failed', err);
      }
    }
  }
}
