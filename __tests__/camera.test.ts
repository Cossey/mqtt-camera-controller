import { Camera } from '../src/cameras/camera';
import { CameraManager } from '../src/cameras/cameraManager';
import { CameraConfig } from '../src/types';

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
