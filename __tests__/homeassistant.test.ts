import { publishHomeAssistantDiscovery, resetHomeAssistantDiscoveryStateForTests } from '../src/homeassistant/discovery';
import { AppConfig } from '../src/types';

describe('Home Assistant discovery', () => {
  beforeEach(() => {
    resetHomeAssistantDiscoveryStateForTests();
  });

  test('publishes discovery entities by default', async () => {
    const mqtt = {
      baseTopic: 'mqttai',
      publishRaw: jest.fn(),
    } as any;

    const cfg: AppConfig = {
      mqtt: { basetopic: 'mqttai' },
      cameras: [
        {
          name: 'frontdoor',
          host: '192.168.1.10',
          port: 80,
        },
      ],
      homeassistant: {
        enabled: true,
      },
    };

    await publishHomeAssistantDiscovery(cfg, mqtt);

    expect(mqtt.publishRaw).toHaveBeenCalledTimes(9);
    expect(mqtt.publishRaw).toHaveBeenCalledWith(
      expect.stringContaining('homeassistant/binary_sensor/frontdoor_motion/config'),
      expect.any(String),
      { retain: true },
    );
    expect(mqtt.publishRaw).toHaveBeenCalledWith(
      expect.stringContaining('homeassistant/select/frontdoor_command/config'),
      expect.any(String),
      { retain: true },
    );
    expect(mqtt.publishRaw).toHaveBeenCalledWith(
      expect.stringContaining('homeassistant/select/mqttai_app_command/config'),
      expect.any(String),
      { retain: true },
    );

    const appCommandDiscoveryCall = mqtt.publishRaw.mock.calls.find((args: unknown[]) =>
      String(args[0]).includes('homeassistant/select/mqttai_app_command/config'),
    );
    expect(appCommandDiscoveryCall).toBeDefined();
    const appCommandPayload = JSON.parse(String((appCommandDiscoveryCall as unknown[])[1]));
    expect(appCommandPayload.command_topic).toBe('mqttai/command');
    expect(appCommandPayload.options).toEqual(['reload']);

    const motionDiscoveryCall = mqtt.publishRaw.mock.calls.find((args: unknown[]) =>
      String(args[0]).includes('homeassistant/binary_sensor/frontdoor_motion/config'),
    );
    expect(motionDiscoveryCall).toBeDefined();
    const motionPayload = JSON.parse(String((motionDiscoveryCall as unknown[])[1]));
    expect(motionPayload.availability_mode).toBe('all');
    expect(motionPayload.availability).toEqual([
      {
        topic: 'mqttai/frontdoor/status',
        payload_available: 'ONLINE',
        payload_not_available: 'OFFLINE',
      },
      {
        topic: 'mqttai/status',
        payload_available: 'ONLINE',
        payload_not_available: 'OFFLINE',
      },
    ]);
  });

  test('does not publish discovery when disabled', async () => {
    const mqtt = {
      baseTopic: 'mqttai',
      publishRaw: jest.fn(),
    } as any;

    const cfg: AppConfig = {
      mqtt: { basetopic: 'mqttai' },
      cameras: [{ name: 'frontdoor' } as any],
      homeassistant: {
        enabled: false,
      },
    };

    await publishHomeAssistantDiscovery(cfg, mqtt);
    expect(mqtt.publishRaw).not.toHaveBeenCalled();
  });

  test('respects component toggles', async () => {
    const mqtt = {
      baseTopic: 'mqttai',
      publishRaw: jest.fn(),
    } as any;

    const cfg: AppConfig = {
      mqtt: { basetopic: 'mqttai' },
      cameras: [{ name: 'frontdoor' } as any],
      homeassistant: {
        enabled: true,
        components: {
          events: false,
          status: true,
          snapshot: false,
          snapshotCommand: true,
          appReloadCommand: false,
        },
      },
    };

    await publishHomeAssistantDiscovery(cfg, mqtt);

    expect(mqtt.publishRaw).toHaveBeenCalledTimes(2);
    expect(mqtt.publishRaw).toHaveBeenCalledWith(
      expect.stringContaining('homeassistant/select/frontdoor_command/config'),
      expect.any(String),
      { retain: true },
    );
    expect(mqtt.publishRaw).toHaveBeenCalledWith(
      'mqttai/frontdoor/meta',
      expect.any(String),
      { retain: true },
    );
    expect(mqtt.publishRaw).not.toHaveBeenCalledWith(
      expect.stringContaining('homeassistant/sensor/frontdoor_status/config'),
      expect.any(String),
      { retain: true },
    );
  });

  test('allows disabling app reload command discovery', async () => {
    const mqtt = {
      baseTopic: 'mqttai',
      publishRaw: jest.fn(),
    } as any;

    const cfg: AppConfig = {
      mqtt: { basetopic: 'mqttai' },
      cameras: [{ name: 'frontdoor' } as any],
      homeassistant: {
        enabled: true,
        components: {
          events: false,
          snapshot: false,
          snapshotCommand: false,
          appReloadCommand: false,
        },
      },
    };

    await publishHomeAssistantDiscovery(cfg, mqtt);

    expect(mqtt.publishRaw).not.toHaveBeenCalledWith(
      expect.stringContaining('homeassistant/select/mqttai_app_command/config'),
      expect.any(String),
      { retain: true },
    );
  });

  test('clears stale owned discovery topics on republish', async () => {
    const mqtt = {
      baseTopic: 'mqttai',
      publishRaw: jest.fn(),
    } as any;

    const firstCfg: AppConfig = {
      mqtt: { basetopic: 'mqttai' },
      cameras: [{ name: 'frontdoor' } as any],
      homeassistant: { enabled: true },
    };

    const secondCfg: AppConfig = {
      mqtt: { basetopic: 'mqttai' },
      cameras: [{ name: 'backyard' } as any],
      homeassistant: { enabled: true },
    };

    await publishHomeAssistantDiscovery(firstCfg, mqtt);
    mqtt.publishRaw.mockClear();

    await publishHomeAssistantDiscovery(secondCfg, mqtt);

    expect(mqtt.publishRaw).toHaveBeenCalledWith(
      'homeassistant/binary_sensor/frontdoor_motion/config',
      '',
      { retain: true },
    );
    expect(mqtt.publishRaw).toHaveBeenCalledWith('mqttai/frontdoor/meta', '', { retain: true });
  });
});
