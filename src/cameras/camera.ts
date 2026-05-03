import debug from 'debug';
import { spawn } from 'child_process';
import fs from 'fs';
import { CameraConfig, RateLimitConfig } from '../types';
import { MQTTWrapper } from '../mqttClient';
import { logInfo, logError, logDebug } from '../logger';

const log = debug('camera');

export class Camera {
  cfg: CameraConfig;
  mqtt: MQTTWrapper;
  private rateLimit: RateLimitConfig;
  private lastEventChannelStatus: 'online' | 'offline' | null = null;
  private pendingOnEventSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private lastOnEventSnapshotAttemptAt = 0;
  private pullSubscription: { stop: () => void } | null = null;
  private unsubscribeSnapshotCommand: (() => void) | null = null;

  private normalizeCredential(v?: string): string | undefined {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }

  private decodeCredential(v?: string): string | undefined {
    if (!v) return undefined;
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }

  private resolveSnapshotCredentials(address: string, snapshot: CameraConfig['snapshot']) {
    let username = this.normalizeCredential(snapshot?.username);
    let password = this.normalizeCredential(snapshot?.password);

    if (!password && snapshot?.password_file) {
      // password_file should have been resolved at config load, but attempt to read here too.
      try {
        const txt = fs.readFileSync(snapshot.password_file, 'utf8');
        password = this.normalizeCredential(txt);
      } catch (_e) {
        // ignore
      }
    }

    try {
      const u = new URL(address);
      if (!username && u.username) username = this.decodeCredential(u.username);
      if (!password && u.password) password = this.decodeCredential(u.password);
    } catch (_err) {
      // ignore URL parse error
    }

    return { username, password };
  }

  private buildAuthenticatedStreamUrl(address: string, username?: string, password?: string): string {
    if (!username || !password) return address;
    try {
      const u = new URL(address);
      // Assigning URL username/password applies percent-encoding for reserved characters.
      u.username = username;
      u.password = password;
      return u.toString();
    } catch (_err) {
      return address;
    }
  }

  private redactCredentials(text: string): string {
    if (!text) return text;
    return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s/:]+)(?::([^@\s/]*))?@/gi, '$1***:***@');
  }

  private getOnEventSnapshotSettings() {
    const onEvent = this.cfg.snapshot?.onEvent;
    if (!onEvent) return null;
    if (!Array.isArray(onEvent.types) || onEvent.types.length === 0) return null;

    const types = new Set(onEvent.types.map((t) => String(t).toLowerCase()));
    const delay = typeof onEvent.delay === 'number' && Number.isFinite(onEvent.delay) && onEvent.delay >= 0 ? onEvent.delay : 0;
    return { types, delay };
  }

  private isOnEventSnapshotInCooldown(): boolean {
    if (!this.rateLimit.enabled) return false;
    const cooldownMs = typeof this.rateLimit.cooldownMs === 'number' ? this.rateLimit.cooldownMs : 3000;
    if (cooldownMs <= 0) return false;
    const elapsedMs = Date.now() - this.lastOnEventSnapshotAttemptAt;
    return elapsedMs < cooldownMs;
  }

  private async takeSnapshotForEventTrigger() {
    if (this.isOnEventSnapshotInCooldown()) {
      logDebug(`[DEBUG] Event snapshot skipped due to cooldown camera=${this.cfg.name}`);
      return;
    }

    this.lastOnEventSnapshotAttemptAt = Date.now();

    try {
      const snap = await this.getSnapshot();
      await this.publishSnapshot(snap);
    } catch (err) {
      log('snapshot on event failed', err);
    }
  }

  private scheduleSnapshotForEventTrigger(delayMs: number) {
    if (delayMs <= 0) {
      void this.takeSnapshotForEventTrigger();
      return;
    }

    if (this.pendingOnEventSnapshotTimer) {
      clearTimeout(this.pendingOnEventSnapshotTimer);
      this.pendingOnEventSnapshotTimer = null;
    }

    this.pendingOnEventSnapshotTimer = setTimeout(() => {
      this.pendingOnEventSnapshotTimer = null;
      void this.takeSnapshotForEventTrigger();
    }, delayMs);
  }

  constructor(cfg: CameraConfig, mqtt: MQTTWrapper, rateLimit?: RateLimitConfig) {
    this.cfg = cfg;
    this.mqtt = mqtt;
    this.rateLimit = {
      enabled: rateLimit?.enabled ?? true,
      cooldownMs: rateLimit?.cooldownMs ?? 3000,
    };
  }

  async setEventChannelStatus(status: 'online' | 'offline', reason?: string) {
    if (this.lastEventChannelStatus === status) return;
    this.lastEventChannelStatus = status;
    const mqttStatus = status.toUpperCase();
    this.mqtt.publish(`${this.cfg.name}/status`, mqttStatus, { retain: true });
    if (reason) {
      logInfo(`[INFO] Camera status camera=${this.cfg.name} status=${mqttStatus} reason=${reason}`);
      log('event channel status change', this.cfg.name, mqttStatus, reason);
    }
  }

  async init() {
    log('Initialized camera (no onvif client)', this.cfg.name);

    // Subscribe to commands for snapshot requests
    this.unsubscribeSnapshotCommand = this.mqtt.subscribe(`${this.cfg.name}/command`, async (_t: string, message: Buffer) => {
      const command = message.toString('utf8').trim().toLowerCase();
      if (command !== 'snapshot') {
        logDebug(`[DEBUG] Unsupported camera command ignored camera=${this.cfg.name} command=${command || '<empty>'}`);
        return;
      }

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
        this.pullSubscription = await startPullPoint(this.cfg, async (evt) => {
          try {
            await this.handleEvent(evt);
          } catch (err: unknown) {
            log('handleEvent failed', err);
          }
        }, {
          onHealthy: () => {
            void this.setEventChannelStatus('online', 'pull poll success');
          },
          onError: (err: unknown) => {
            logError(`[ERROR] Pull loop error for camera=${this.cfg.name}`, err);
            void this.setEventChannelStatus('offline', 'pull poll failure');
          },
        });
        // Do not mark online yet; only mark online after first successful PullMessages response.
      } catch (err) {
        logError(`[ERROR] PullPoint start error for camera=${this.cfg.name}`, err);
        await this.setEventChannelStatus('offline', 'pull startup failed');
        log('PullPoint module not available', err);
        throw err;
      }
    }

    // if push mode is configured and autoSubscribe is true, attempt to create subscription when app-level notify.baseUrl is set
    if (mode === 'push') {
      // we perform auto subscribe in CameraManager where we have access to notify server info
      log('Configured for push-mode events');
      await this.setEventChannelStatus('online', 'push mode configured');
    }
  }

  async stop() {
    if (this.pendingOnEventSnapshotTimer) {
      clearTimeout(this.pendingOnEventSnapshotTimer);
      this.pendingOnEventSnapshotTimer = null;
    }

    if (this.pullSubscription) {
      this.pullSubscription.stop();
      this.pullSubscription = null;
    }

    if (this.unsubscribeSnapshotCommand) {
      this.unsubscribeSnapshotCommand();
      this.unsubscribeSnapshotCommand = null;
    }

    this.lastOnEventSnapshotAttemptAt = 0;
  }

  async getSnapshot(): Promise<Buffer> {
    // Determine snapshot behavior: prefer explicit snapshot.type; address is in snapshot.address
    const snapshot = this.cfg.snapshot;
    const address = snapshot?.address;
    const snapshotType = snapshot?.type || (address && (address.startsWith('rtsp') || address.startsWith('rtmp')) ? 'stream' : (address ? 'url' : undefined));

    if (snapshotType === 'stream') {
      const streamUrl = address;
      if (!streamUrl) throw new Error('No stream address configured for stream snapshot');
      const { username, password } = this.resolveSnapshotCredentials(streamUrl, snapshot);
      const inputUrl = this.buildAuthenticatedStreamUrl(streamUrl, username, password);
      // Use ffmpeg to grab a single frame and output to stdout
      return await new Promise<Buffer>((resolve, reject) => {
        const args = [
          '-hide_banner',
          '-loglevel', 'error',
          '-y',
          '-i', inputUrl,
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
          else reject(new Error(`ffmpeg failed: code=${code} ${this.redactCredentials(stderr)}`));
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
      const { username, password } = this.resolveSnapshotCredentials(addr, snapshot);

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
    const onEventSettings = this.getOnEventSnapshotSettings();
    let shouldTriggerOnEventSnapshot = false;

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

      if (onEventSettings) {
        if (onEventSettings.types.has('all') || onEventSettings.types.has(type)) {
          shouldTriggerOnEventSnapshot = true;
        }
      }

      const topic = `${this.cfg.name}/${type}`;

      const duration = this.cfg.eventDurations?.[type];

      if (duration && duration > 0) {
        // behave as pulse: set ON then schedule OFF
        this.mqtt.publish(topic, 'ON', { retain: true });
        setTimeout(() => this.mqtt.publish(topic, 'OFF', { retain: true }), duration * 1000);
      } else {
        // duration is absent or zero: follow ONVIF's reported state if available
        if (state === true) {
          this.mqtt.publish(topic, 'ON', { retain: true });
        } else if (state === false) {
          this.mqtt.publish(topic, 'OFF', { retain: true });
        } else {
          // no explicit state reported: emit ON (no scheduled OFF)
          this.mqtt.publish(topic, 'ON', { retain: true });
        }
      }
    }

    if (onEventSettings && shouldTriggerOnEventSnapshot) {
      this.scheduleSnapshotForEventTrigger(onEventSettings.delay);
    }
  }
}
