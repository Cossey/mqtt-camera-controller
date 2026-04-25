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

    await manager.init();

    expect(mqtt.publish).toHaveBeenCalledWith('driveway/motion', 'OFF', { retain: true });
    expect(mqtt.publish).toHaveBeenCalledWith('driveway/line', 'OFF', { retain: true });
    expect(mqtt.publish).toHaveBeenCalledWith('driveway/people', 'OFF', { retain: true });
    expect(mqtt.publish).toHaveBeenCalledWith('driveway/vehicle', 'OFF', { retain: true });
    expect(mqtt.publish).toHaveBeenCalledWith('driveway/animal', 'OFF', { retain: true });
    expect(mqtt.publish).toHaveBeenCalledWith('driveway/status', 'OFFLINE', { retain: true });
  });
});
