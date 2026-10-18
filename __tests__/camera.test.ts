import { Camera } from '../src/cameras/camera';
import { CameraManager } from '../src/cameras/cameraManager';
import { CameraConfig } from '../src/types';
import { EventEmitter } from 'events';
import * as childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

afterEach(() => {
  jest.clearAllMocks();
});

function mockSpawnOnce(opts: {
  onArgs?: (args: string[]) => void;
  exitCode?: number;
  stdout?: Buffer;
  stderr?: string;
}) {
  const { onArgs, exitCode = 0, stdout = Buffer.from('image'), stderr = '' } = opts;
  return (childProcess.spawn as unknown as jest.Mock).mockImplementation(((_cmd: string, args: readonly string[]) => {
    onArgs?.(args as string[]);
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    process.nextTick(() => {
      if (stdout.length > 0) proc.stdout.emit('data', stdout);
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('close', exitCode);
    });
    return proc;
  }) as any);
}

describe('Camera event publishing', () => {
  test('publishes ON with retain=true when event state is true', async () => {
    const mqtt = {
      publish: jest.fn(),
      subscribe: jest.fn(),
    } as any;

    const cfg: CameraConfig = {
      name: 'frontdoor',
      host: '192.168.1.10',
      port: 80,
    };

    const cam = new Camera(cfg, mqtt);
    await cam.handleEvent({ type: 'motion', state: true });

    expect(mqtt.publish).toHaveBeenCalledWith('frontdoor/motion', 'ON', { retain: true });
  });

  test('publishes OFF with retain=true when event state is false', async () => {
    const mqtt = {
      publish: jest.fn(),
      subscribe: jest.fn(),
    } as any;

    const cfg: CameraConfig = {
      name: 'frontdoor',
      host: '192.168.1.10',
      port: 80,
    };

    const cam = new Camera(cfg, mqtt);
    await cam.handleEvent({ type: 'motion', state: false });

    expect(mqtt.publish).toHaveBeenCalledWith('frontdoor/motion', 'OFF', { retain: true });
  });

  test('publishes uppercase status transitions for pull health then failure', async () => {
    const mqtt = {
      publish: jest.fn(),
      subscribe: jest.fn(),
    } as any;

    const cfg: CameraConfig = {
      name: 'frontdoor',
      host: '192.168.1.10',
      port: 80,
    };

    const cam = new Camera(cfg, mqtt);
    await cam.setEventChannelStatus('online', 'pull poll success');
    await cam.setEventChannelStatus('offline', 'pull poll failure');

    expect(mqtt.publish).toHaveBeenNthCalledWith(1, 'frontdoor/status', 'ONLINE', { retain: true });
    expect(mqtt.publish).toHaveBeenNthCalledWith(2, 'frontdoor/status', 'OFFLINE', { retain: true });
  });
});

describe('Camera onEvent snapshot behavior', () => {
  test('triggers snapshot only when event type matches snapshot.onEvent.types', async () => {
    const mqtt = {
      publish: jest.fn(),
      subscribe: jest.fn(),
    } as any;

    const cfg: CameraConfig = {
      name: 'frontdoor',
      snapshot: {
        address: 'http://192.168.1.10/snap.jpg',
        onEvent: {
          types: ['motion'],
          delay: 0,
        },
      },
    };

    const cam = new Camera(cfg, mqtt);
    const getSnapshotSpy = jest.spyOn(cam, 'getSnapshot').mockResolvedValue(Buffer.from('image'));
    const publishSnapshotSpy = jest.spyOn(cam, 'publishSnapshot').mockResolvedValue(undefined);

    await cam.handleEvent({ type: 'people', state: true });
    expect(getSnapshotSpy).not.toHaveBeenCalled();

    await cam.handleEvent({ type: 'motion', state: true });
    expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
    expect(publishSnapshotSpy).toHaveBeenCalledTimes(1);
  });

  test('continuous mode captures while selected events are active and stops when they clear', async () => {
    jest.useFakeTimers();
    try {
      const mqtt = {
        publish: jest.fn(),
        subscribe: jest.fn(),
      } as any;

      const cfg: CameraConfig = {
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          onEvent: {
            types: ['people', 'motion'],
            mode: 'continuous',
            delay: 100,
          },
        },
      };

      const cam = new Camera(cfg, mqtt);
      const getSnapshotSpy = jest.spyOn(cam, 'getSnapshot').mockResolvedValue(Buffer.from('image'));
      const publishSnapshotSpy = jest.spyOn(cam, 'publishSnapshot').mockResolvedValue(undefined);

      await cam.handleEvent({ type: 'people', state: true });
      await jest.advanceTimersByTimeAsync(0);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
      expect(publishSnapshotSpy).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(99);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(2);

      await cam.handleEvent({ type: 'motion', state: true });
      await cam.handleEvent({ type: 'people', state: false });
      await jest.advanceTimersByTimeAsync(100);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(3);

      await cam.handleEvent({ type: 'motion', state: false });
      await jest.advanceTimersByTimeAsync(1000);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(3);
      await cam.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('continuous mode keeps capturing until stopDelay expires', async () => {
    jest.useFakeTimers();
    try {
      const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
      const cam = new Camera({
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          onEvent: { types: ['motion'], mode: 'continuous', delay: 100, stopDelay: 250 },
        },
      }, mqtt);
      const getSnapshotSpy = jest.spyOn(cam, 'getSnapshot').mockResolvedValue(Buffer.from('image'));

      await cam.handleEvent({ type: 'motion', state: true });
      await jest.advanceTimersByTimeAsync(0);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(1);

      await cam.handleEvent({ type: 'motion', state: false });
      await jest.advanceTimersByTimeAsync(249);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(1000);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(3);
      await cam.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('renewed activity cancels a pending continuous stopDelay', async () => {
    jest.useFakeTimers();
    try {
      const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
      const cam = new Camera({
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          onEvent: { types: ['motion'], mode: 'continuous', delay: 100, stopDelay: 250 },
        },
      }, mqtt);
      const getSnapshotSpy = jest.spyOn(cam, 'getSnapshot').mockResolvedValue(Buffer.from('image'));

      await cam.handleEvent({ type: 'motion', state: true });
      await jest.advanceTimersByTimeAsync(0);
      await cam.handleEvent({ type: 'motion', state: false });
      await jest.advanceTimersByTimeAsync(100);
      await cam.handleEvent({ type: 'motion', state: true });
      await jest.advanceTimersByTimeAsync(100);
      await cam.handleEvent({ type: 'motion', state: false });
      await jest.advanceTimersByTimeAsync(50);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(199);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(5);
      await jest.advanceTimersByTimeAsync(1);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(5);

      await jest.advanceTimersByTimeAsync(1000);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(5);
      await cam.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('continuous mode with zero delay waits for each capture before starting the next', async () => {
    jest.useFakeTimers();
    try {
      const mqtt = {
        publish: jest.fn(),
        subscribe: jest.fn(),
      } as any;
      const cfg: CameraConfig = {
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          onEvent: { types: ['people'], mode: 'continuous', delay: 0 },
        },
      };
      const cam = new Camera(cfg, mqtt);
      let finishCapture: (() => void) | undefined;
      const getSnapshotSpy = jest.spyOn(cam, 'getSnapshot').mockImplementation(() => new Promise((resolve) => {
        finishCapture = () => resolve(Buffer.from('image'));
      }));
      const publishSnapshotSpy = jest.spyOn(cam, 'publishSnapshot').mockResolvedValue(undefined);

      await cam.handleEvent({ type: 'people', state: true });
      expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
      expect(publishSnapshotSpy).not.toHaveBeenCalled();

      finishCapture?.();
      await jest.advanceTimersByTimeAsync(0);
      expect(publishSnapshotSpy).toHaveBeenCalledTimes(1);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(2);

      await cam.handleEvent({ type: 'people', state: false });
      finishCapture?.();
      await jest.advanceTimersByTimeAsync(0);
      expect(publishSnapshotSpy).toHaveBeenCalledTimes(1);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(2);
      await cam.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('coalesces delayed event snapshots to one pending snapshot per camera', async () => {
    jest.useFakeTimers();
    try {
      const mqtt = {
        publish: jest.fn(),
        subscribe: jest.fn(),
      } as any;

      const cfg: CameraConfig = {
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          onEvent: {
            types: ['motion'],
            delay: 100,
          },
        },
      };

      const cam = new Camera(cfg, mqtt);
      const getSnapshotSpy = jest.spyOn(cam, 'getSnapshot').mockResolvedValue(Buffer.from('image'));
      const publishSnapshotSpy = jest.spyOn(cam, 'publishSnapshot').mockResolvedValue(undefined);

      await cam.handleEvent({ type: 'motion', state: true });
      await jest.advanceTimersByTimeAsync(50);

      await cam.handleEvent({ type: 'motion', state: true });
      await jest.advanceTimersByTimeAsync(99);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(0);

      await jest.advanceTimersByTimeAsync(1);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
      expect(publishSnapshotSpy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('drops event-triggered snapshots while cooldown is active', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const mqtt = {
        publish: jest.fn(),
        subscribe: jest.fn(),
      } as any;

      const cfg: CameraConfig = {
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          onEvent: {
            types: ['motion'],
            delay: 0,
          },
        },
      };

      const cam = new Camera(cfg, mqtt, { enabled: true, cooldownMs: 3000 });
      const getSnapshotSpy = jest.spyOn(cam, 'getSnapshot').mockResolvedValue(Buffer.from('image'));

      await cam.handleEvent({ type: 'motion', state: true });
      await cam.handleEvent({ type: 'motion', state: true });
      expect(getSnapshotSpy).toHaveBeenCalledTimes(1);

      jest.setSystemTime(new Date('2026-01-01T00:00:03.001Z'));
      await cam.handleEvent({ type: 'motion', state: true });
      expect(getSnapshotSpy).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('cooldown starts after failed event snapshot attempt', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const mqtt = {
        publish: jest.fn(),
        subscribe: jest.fn(),
      } as any;

      const cfg: CameraConfig = {
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          onEvent: {
            types: ['motion'],
            delay: 0,
          },
        },
      };

      const cam = new Camera(cfg, mqtt, { enabled: true, cooldownMs: 3000 });
      const getSnapshotSpy = jest
        .spyOn(cam, 'getSnapshot')
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValue(Buffer.from('image'));

      await cam.handleEvent({ type: 'motion', state: true });
      await cam.handleEvent({ type: 'motion', state: true });
      expect(getSnapshotSpy).toHaveBeenCalledTimes(1);

      jest.setSystemTime(new Date('2026-01-01T00:00:03.001Z'));
      await cam.handleEvent({ type: 'motion', state: true });
      expect(getSnapshotSpy).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('allows all event snapshots when cooldownMs is 0', async () => {
    jest.useFakeTimers();
    try {
    const mqtt = {
      publish: jest.fn(),
      subscribe: jest.fn(),
    } as any;

    const cfg: CameraConfig = {
      name: 'frontdoor',
      snapshot: {
        address: 'http://192.168.1.10/snap.jpg',
        onEvent: {
          types: ['motion'],
          delay: 0,
        },
      },
    };

    const cam = new Camera(cfg, mqtt, { enabled: true, cooldownMs: 0 });
    const getSnapshotSpy = jest.spyOn(cam, 'getSnapshot').mockResolvedValue(Buffer.from('image'));

    await cam.handleEvent({ type: 'motion', state: true });
    await cam.handleEvent({ type: 'motion', state: true });
    expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(getSnapshotSpy).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not delay manual or onEvent snapshots by snapshot.interval', async () => {
    jest.useFakeTimers();
    try {
      let commandHandler: ((topic: string, message: Buffer) => Promise<void>) | undefined;
      const mqtt = {
        publish: jest.fn(),
        subscribe: jest.fn((_topic: string, handler: (topic: string, message: Buffer) => Promise<void>) => {
          commandHandler = handler;
          return jest.fn();
        }),
      } as any;
      const cam = new Camera({
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          interval: 600000,
          onEvent: { types: ['motion'], delay: 0 },
        },
        event: { mode: 'push' },
      }, mqtt, { enabled: true, cooldownMs: 0 });
      let finishManualCapture: (() => void) | undefined;
      const getSnapshotSpy = jest.spyOn(cam, 'getSnapshot')
        .mockImplementationOnce(() => new Promise((resolve) => {
          finishManualCapture = () => resolve(Buffer.from('manual'));
        }))
        .mockResolvedValue(Buffer.from('event'));
      const publishSnapshotSpy = jest.spyOn(cam, 'publishSnapshot');

      await cam.init();
      const manualRequest = commandHandler?.('frontdoor/command', Buffer.from('snapshot'));
      expect(getSnapshotSpy).toHaveBeenCalledTimes(1);

      await cam.handleEvent({ type: 'motion', state: true });
      finishManualCapture?.();

      // the queued on-event capture runs immediately rather than waiting out the 10 minute interval
      await jest.advanceTimersByTimeAsync(0);
      expect(getSnapshotSpy).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(0);
      expect(publishSnapshotSpy).toHaveBeenCalledTimes(2);
      await manualRequest;
      await cam.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('measures the periodic interval from the last snapshot of any kind', async () => {
    jest.useFakeTimers();
    try {
      const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
      const cam = new Camera({
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          interval: 1000,
          onEvent: { types: ['motion'], delay: 0 },
        },
      }, mqtt, { enabled: true, cooldownMs: 0 });

      // publishSnapshot stays real: it records lastSnapshotCompletedAt, the clock the
      // interval is measured from. Only getSnapshot is stubbed.
      const captureTimes: number[] = [];
      const start = Date.now();
      jest.spyOn(cam, 'getSnapshot').mockImplementation(async () => {
        captureTimes.push(Date.now() - start);
        return Buffer.from('image');
      });
      cam.startPeriodicSnapshotLoop();

      // periodic captures land one interval apart
      await jest.advanceTimersByTimeAsync(2500);
      expect(captureTimes).toEqual([1000, 2000]);

      // an on-event capture happens immediately and restarts the interval clock
      captureTimes.length = 0;
      await cam.handleEvent({ type: 'motion', state: true });
      await jest.advanceTimersByTimeAsync(0);
      expect(captureTimes).toEqual([2500]);

      await jest.advanceTimersByTimeAsync(999);
      expect(captureTimes).toEqual([2500]);
      await jest.advanceTimersByTimeAsync(1);
      expect(captureTimes).toEqual([2500, 3500]);

      await cam.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('measures the periodic interval from the last manual snapshot', async () => {
    jest.useFakeTimers();
    try {
      let commandHandler: ((topic: string, message: Buffer) => Promise<void>) | undefined;
      const mqtt = {
        publish: jest.fn(),
        subscribe: jest.fn((_topic: string, handler: (topic: string, message: Buffer) => Promise<void>) => {
          commandHandler = handler;
          return jest.fn();
        }),
      } as any;
      const cam = new Camera({
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          interval: 1000,
        },
        event: { mode: 'push' },
      }, mqtt);

      const captureTimes: number[] = [];
      const start = Date.now();
      jest.spyOn(cam, 'getSnapshot').mockImplementation(async () => {
        captureTimes.push(Date.now() - start);
        return Buffer.from('image');
      });

      await cam.init();
      cam.startPeriodicSnapshotLoop();

      await jest.advanceTimersByTimeAsync(1000);
      expect(captureTimes).toEqual([1000]);

      // a manual snapshot midway through the next interval runs immediately
      await jest.advanceTimersByTimeAsync(500);
      const manual = commandHandler?.('frontdoor/command', Buffer.from('snapshot'));
      await jest.advanceTimersByTimeAsync(0);
      expect(captureTimes).toEqual([1000, 1500]);

      // the next periodic capture is one interval after the manual one, not the last tick
      await jest.advanceTimersByTimeAsync(999);
      expect(captureTimes).toEqual([1000, 1500]);
      await jest.advanceTimersByTimeAsync(1);
      expect(captureTimes).toEqual([1000, 1500, 2500]);

      await manual;
      await cam.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Camera snapshot capture stall handling', () => {
  // Installs a fetch that never resolves for the first `stallCount` requests to `stallUrl`
  // until they are aborted, mimicking a camera that accepts the connection but never
  // sends a snapshot. Later requests to that URL succeed so recovery is observable.
  function mockStalledFetch(stallUrl: string, stallCount = Number.POSITIVE_INFINITY) {
    const original = (globalThis as unknown as { fetch?: unknown }).fetch;
    const calls: string[] = [];
    (globalThis as unknown as { fetch?: unknown }).fetch = (url: string, init: { signal?: AbortSignal }) => {
      calls.push(url);
      const stalledForUrl = calls.filter((u) => u === stallUrl).length;
      if (url !== stallUrl || stalledForUrl > stallCount) {
        return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('image').buffer });
      }
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(new Error('aborted'));
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener('abort', onAbort);
      });
    };
    return {
      callsFor: (url: string) => calls.filter((u) => u === url).length,
      restore: () => {
        if (original === undefined) delete (globalThis as unknown as { fetch?: unknown }).fetch;
        else (globalThis as unknown as { fetch?: unknown }).fetch = original;
      },
    };
  }

  test('releases the capture lane when a camera never responds', async () => {
    jest.useFakeTimers();
    const stalled = mockStalledFetch('http://192.168.1.10/snap.jpg', 1);
    try {
      const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
      const cam = new Camera({
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          timeout: 5000,
          onEvent: { types: ['motion'], delay: 0 },
        },
      }, mqtt, { enabled: false });
      const publishSnapshotSpy = jest.spyOn(cam, 'publishSnapshot').mockResolvedValue(undefined);
      const captures = () => stalled.callsFor('http://192.168.1.10/snap.jpg');

      void cam.handleEvent({ type: 'motion', state: true });
      await jest.advanceTimersByTimeAsync(10);
      expect(captures()).toBe(1);
      expect(publishSnapshotSpy).not.toHaveBeenCalled();

      // a later event still publishes once the stalled capture is aborted by the timeout
      await cam.handleEvent({ type: 'motion', state: true });
      await jest.advanceTimersByTimeAsync(4989);
      expect(captures()).toBe(1);

      await jest.advanceTimersByTimeAsync(1);
      expect(captures()).toBe(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(publishSnapshotSpy).toHaveBeenCalledTimes(1);

      await cam.stop();
    } finally {
      stalled.restore();
      jest.useRealTimers();
    }
  });

  test('keeps the pending capture backlog bounded and settles superseded requests', async () => {
    jest.useFakeTimers();
    const stalled = mockStalledFetch('http://192.168.1.10/snap.jpg');
    try {
      const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
      const cam = new Camera({
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          timeout: 10000,
          onEvent: { types: ['motion'], delay: 0 },
        },
      }, mqtt, { enabled: false });
      jest.spyOn(cam, 'publishSnapshot').mockResolvedValue(undefined);
      const captures = () => stalled.callsFor('http://192.168.1.10/snap.jpg');

      const queueDepth = () => (cam as unknown as { snapshotCaptureQueue: unknown[] }).snapshotCaptureQueue.length;

      void cam.handleEvent({ type: 'motion', state: true });
      await jest.advanceTimersByTimeAsync(1);
      for (let i = 0; i < 40; i += 1) {
        await cam.handleEvent({ type: 'motion', state: true });
      }

      // the backlog never grows past the cap while the camera is unresponsive
      expect(queueDepth()).toBeLessThanOrEqual(8);
      expect(captures()).toBe(1);

      // each timeout hands the lane to the next pending capture
      await jest.advanceTimersByTimeAsync(10000);
      expect(captures()).toBe(2);
      expect(queueDepth()).toBe(7);

      await cam.stop();
    } finally {
      stalled.restore();
      jest.useRealTimers();
    }
  });

  test('a stalled camera does not block snapshot capture on other cameras', async () => {
    jest.useFakeTimers();
    const stalled = mockStalledFetch('http://192.168.1.10/stalled.jpg');
    try {
      const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
      const makeCamera = (name: string) => new Camera({
        name,
        snapshot: {
          address: `http://192.168.1.10/${name}.jpg`,
          timeout: 5000,
          onEvent: { types: ['motion'], delay: 0 },
        },
      }, mqtt, { enabled: false });

      const stalledCamera = makeCamera('stalled');
      const healthyCamera = makeCamera('healthy');
      jest.spyOn(stalledCamera, 'publishSnapshot').mockResolvedValue(undefined);
      const healthyPublishSpy = jest.spyOn(healthyCamera, 'publishSnapshot').mockResolvedValue(undefined);

      void stalledCamera.handleEvent({ type: 'motion', state: true });
      await jest.advanceTimersByTimeAsync(10);
      expect(stalled.callsFor('http://192.168.1.10/stalled.jpg')).toBe(1);

      // the healthy camera keeps capturing while the other one is stuck
      await healthyCamera.handleEvent({ type: 'motion', state: true });
      await jest.advanceTimersByTimeAsync(10);
      expect(healthyPublishSpy).toHaveBeenCalledTimes(1);
      expect(stalled.callsFor('http://192.168.1.10/stalled.jpg')).toBe(1);

      await stalledCamera.stop();
      await healthyCamera.stop();
    } finally {
      stalled.restore();
      jest.useRealTimers();
    }
  });

  test('aborts a stalled HTTP snapshot fetch after snapshot.timeout', async () => {
    jest.useFakeTimers();
    try {
      const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
      const cam = new Camera({
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          timeout: 4000,
        },
      }, mqtt);

      let observedSignal: AbortSignal | undefined;
      (globalThis as unknown as { fetch?: unknown }).fetch = (_url: string, init: { signal?: AbortSignal }) => {
        observedSignal = init?.signal;
        return new Promise((_resolve, reject) => {
          observedSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      };

      // attach the expectation before advancing so the rejection is never unhandled
      const pending = expect(cam.getSnapshot()).rejects.toThrow('Snapshot fetch timed out after 4000ms');
      await jest.advanceTimersByTimeAsync(3999);
      expect(observedSignal?.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(observedSignal?.aborted).toBe(true);
      await pending;
      delete (globalThis as unknown as { fetch?: unknown }).fetch;
    } finally {
      jest.useRealTimers();
    }
  });

  test('kills ffmpeg when a stream snapshot stalls past snapshot.timeout', async () => {
    jest.useFakeTimers();
    try {
      const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
      const cam = new Camera({
        name: 'driveway',
        snapshot: {
          type: 'stream',
          address: 'rtsp://192.168.1.11:554/stream1',
          timeout: 8000,
        },
      }, mqtt);

      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      (childProcess.spawn as unknown as jest.Mock).mockReturnValue(proc);

      const pending = expect(cam.getSnapshot()).rejects.toThrow('ffmpeg snapshot timed out after 8000ms');
      await jest.advanceTimersByTimeAsync(7999);
      expect(proc.kill).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      await pending;
    } finally {
      jest.useRealTimers();
    }
  });

  test('periodic refresh keeps running after a stalled capture times out', async () => {
    jest.useFakeTimers();
    const stalled = mockStalledFetch('http://192.168.1.10/snap.jpg', 1);
    try {
      const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
      const cam = new Camera({
        name: 'frontdoor',
        snapshot: {
          address: 'http://192.168.1.10/snap.jpg',
          timeout: 5000,
          interval: 10000,
        },
      }, mqtt);

      const published: string[] = [];
      jest.spyOn(cam, 'publishSnapshot').mockImplementation(async () => {
        published.push('image');
      });
      cam.startPeriodicSnapshotLoop();
      const captures = () => stalled.callsFor('http://192.168.1.10/snap.jpg');

      // first periodic capture stalls and is aborted by the timeout
      await jest.advanceTimersByTimeAsync(15000);
      expect(captures()).toBe(1);
      expect(published).toHaveLength(0);

      // the periodic loop reschedules instead of dying with the stalled capture
      await jest.advanceTimersByTimeAsync(10000);
      expect(captures()).toBe(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(published).toHaveLength(1);

      await cam.stop();
    } finally {
      stalled.restore();
      jest.useRealTimers();
    }
  });
});

describe('Camera stream snapshot credentials', () => {
  test('stream snapshot injects explicit snapshot username/password into ffmpeg input URL', async () => {
    const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
    const cfg: CameraConfig = {
      name: 'driveway',
      snapshot: {
        type: 'stream',
        address: 'rtsp://embedded:embeddedpass@192.168.1.11:554/stream1',
        username: 'cfguser',
        password: 'cfgpass',
      },
    };

    let inputUrl = '';
    mockSpawnOnce({
      onArgs: (args) => {
        inputUrl = args[args.indexOf('-i') + 1];
      },
    });

    const cam = new Camera(cfg, mqtt);
    const snap = await cam.getSnapshot();

    expect(snap.length).toBeGreaterThan(0);
    expect(inputUrl).toContain('cfguser:cfgpass@');
    expect(inputUrl).not.toContain('embedded:embeddedpass@');
  });

  test('stream snapshot supports snapshot.password_file with snapshot.username', async () => {
    const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-pw-'));
    const pwFile = path.join(dir, 'snapshot.pass');
    fs.writeFileSync(pwFile, 'filepass');

    const cfg: CameraConfig = {
      name: 'driveway',
      snapshot: {
        type: 'stream',
        address: 'rtsp://192.168.1.11:554/stream1',
        username: 'fileuser',
        password_file: pwFile,
      },
    };

    let inputUrl = '';
    mockSpawnOnce({
      onArgs: (args) => {
        inputUrl = args[args.indexOf('-i') + 1];
      },
    });

    const cam = new Camera(cfg, mqtt);
    const snap = await cam.getSnapshot();

    expect(snap.length).toBeGreaterThan(0);
    expect(inputUrl).toContain('fileuser:filepass@');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('stream snapshot URL-encodes injected credentials for ffmpeg input URL', async () => {
    const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
    const cfg: CameraConfig = {
      name: 'driveway',
      snapshot: {
        type: 'stream',
        address: 'rtsp://192.168.1.11:554/stream1',
        username: 'user@name',
        password: 'p@ss:word#1',
      },
    };

    let inputUrl = '';
    mockSpawnOnce({
      onArgs: (args) => {
        inputUrl = args[args.indexOf('-i') + 1];
      },
    });

    const cam = new Camera(cfg, mqtt);
    await cam.getSnapshot();

    expect(inputUrl).toContain('user%40name:p%40ss%3Aword%231@');
  });

  test('stream snapshot ffmpeg errors redact embedded credentials', async () => {
    const mqtt = { publish: jest.fn(), subscribe: jest.fn() } as any;
    const cfg: CameraConfig = {
      name: 'driveway',
      snapshot: {
        type: 'stream',
        address: 'rtsp://user:secret@192.168.1.11:554/stream1',
      },
    };

    mockSpawnOnce({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: 'open failed for rtsp://user:secret@192.168.1.11:554/stream1',
    });

    const cam = new Camera(cfg, mqtt);
    let err: Error | null = null;
    try {
      await cam.getSnapshot();
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeTruthy();
    expect(err?.message).toContain('***:***@');
    expect(err?.message).not.toContain('user:secret@');
  });
});

describe('CameraManager startup baselines', () => {
  test('publishes retained OFF baseline topics at startup', async () => {
    const mqtt = {
      publish: jest.fn(),
      subscribe: jest.fn(),
    } as any;

    const manager = new CameraManager({
      mqtt: { server: 'example.com' },
      cameras: [
        {
          name: 'driveway',
          host: '192.168.1.20',
          port: 80,
          event: { mode: 'push' },
        },
      ],
    } as any, mqtt);

    try {
      await manager.init();

      expect(mqtt.publish).toHaveBeenCalledWith('driveway/motion', 'OFF', { retain: true });
      expect(mqtt.publish).toHaveBeenCalledWith('driveway/line', 'OFF', { retain: true });
      expect(mqtt.publish).toHaveBeenCalledWith('driveway/people', 'OFF', { retain: true });
      expect(mqtt.publish).toHaveBeenCalledWith('driveway/vehicle', 'OFF', { retain: true });
      expect(mqtt.publish).toHaveBeenCalledWith('driveway/animal', 'OFF', { retain: true });
      expect(mqtt.publish).toHaveBeenCalledWith('driveway/status', 'OFFLINE', { retain: true });
    } finally {
      await manager.stop();
    }
  });

  test('schedules periodic snapshots after the previous capture completes', async () => {
    jest.useFakeTimers();
    const mqtt = {
      publish: jest.fn(),
      subscribe: jest.fn(),
    } as any;

    try {
      const manager = new CameraManager({
        mqtt: { server: 'example.com' },
        cameras: [
          {
            name: 'driveway',
            host: '192.168.1.20',
            port: 80,
            snapshot: {
              address: 'http://192.168.1.20/snap.jpg',
              interval: 250,
            },
            event: { mode: 'push' },
          },
        ],
      } as any, mqtt);

      try {
        await manager.init();
        const camera = manager.cameras[0];
        let finishFirstCapture: (() => void) | undefined;
        const getSnapshotSpy = jest.spyOn(camera, 'getSnapshot')
          .mockImplementationOnce(() => new Promise((resolve) => {
            finishFirstCapture = () => resolve(Buffer.from('image'));
          }))
          .mockResolvedValue(Buffer.from('image'));

        await jest.advanceTimersByTimeAsync(250);
        expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1000);
        expect(getSnapshotSpy).toHaveBeenCalledTimes(1);

        finishFirstCapture?.();
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(249);
        expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(getSnapshotSpy).toHaveBeenCalledTimes(2);
      } finally {
        await manager.stop();
      }
    } finally {
      jest.useRealTimers();
    }
  });
});
