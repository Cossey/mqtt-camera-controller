import { AppConfig, CameraConfig } from '../types';
import { MQTTWrapper } from '../mqttClient';
import { logInfo, logError } from '../logger';

const EVENT_TYPES = ['motion', 'line', 'people', 'vehicle', 'animal'] as const;
let ownedHomeAssistantTopics = new Set<string>();

interface DiscoveryEntry {
  topic: string;
  payload: string;
  retain: boolean;
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

function getHomeAssistantSettings(cfg: AppConfig) {
  const settings = cfg.homeassistant || {};
  const components = settings.components || {};
  return {
    enabled: settings.enabled !== false,
    prefix: settings.prefix || 'homeassistant',
    retain: settings.retain !== false,
    components: {
      events: components.events !== false,
      status: components.status !== false, // compatibility no-op
      snapshot: components.snapshot !== false,
      snapshotCommand: components.snapshotCommand !== false,
      appReloadCommand: components.appReloadCommand !== false,
    },
  };
}

function buildAvailability(baseTopic: string, cameraName: string) {
  return [
    {
      topic: `${baseTopic}/${cameraName}/status`,
      payload_available: 'ONLINE',
      payload_not_available: 'OFFLINE',
    },
    {
      topic: `${baseTopic}/status`,
      payload_available: 'ONLINE',
      payload_not_available: 'OFFLINE',
    },
  ];
}

function buildCameraMetadata(camera: CameraConfig) {
  return {
    cameraIp: camera.host || null,
    onvifPort: camera.port || null,
    eventMode: camera.event?.mode || 'pull',
  };
}

function buildDevice(baseTopic: string, camera: CameraConfig) {
  const metadata = buildCameraMetadata(camera);
  return {
    name: camera.name,
    identifiers: [sanitizeId(`${baseTopic}_${camera.name}`)],
    manufacturer: 'mqtt-camera-controller',
    model: 'ONVIF Camera',
    configuration_url: metadata.cameraIp ? `http://${metadata.cameraIp}:${metadata.onvifPort || 80}` : undefined,
  };
}

function buildAppDevice(baseTopic: string) {
  return {
    name: `${baseTopic} app`,
    identifiers: [sanitizeId(`${baseTopic}_app`)],
    manufacturer: 'mqtt-camera-controller',
    model: 'ONVIF Bridge',
  };
}

function buildEventDiscovery(
  camera: CameraConfig,
  baseTopic: string,
  prefix: string,
  retain: boolean,
): DiscoveryEntry[] {
  const device = buildDevice(baseTopic, camera);
  const metadataTopic = `${baseTopic}/${camera.name}/meta`;
  const entries: DiscoveryEntry[] = [];

  for (const eventType of EVENT_TYPES) {
    const objectId = sanitizeId(`${camera.name}_${eventType}`);
    const topic = `${prefix}/binary_sensor/${objectId}/config`;
    const payload: Record<string, unknown> = {
      name: `${camera.name} ${eventType}`,
      unique_id: objectId,
      state_topic: `${baseTopic}/${camera.name}/${eventType}`,
      payload_on: 'ON',
      payload_off: 'OFF',
      availability: buildAvailability(baseTopic, camera.name),
      availability_mode: 'all',
      json_attributes_topic: metadataTopic,
      device,
    };

    if (eventType === 'motion') payload.device_class = 'motion';
    if (eventType === 'people') payload.device_class = 'occupancy';

    entries.push({
      topic,
      payload: JSON.stringify(payload),
      retain,
    });
  }

  return entries;
}

function buildCameraMetadataEntry(camera: CameraConfig, baseTopic: string): DiscoveryEntry {
  return {
    topic: `${baseTopic}/${camera.name}/meta`,
    payload: JSON.stringify(buildCameraMetadata(camera)),
    retain: true,
  };
}

function buildSnapshotDiscovery(
  camera: CameraConfig,
  baseTopic: string,
  prefix: string,
  retain: boolean,
): DiscoveryEntry {
  const objectId = sanitizeId(`${camera.name}_snapshot`);
  const topic = `${prefix}/camera/${objectId}/config`;
  const metadataTopic = `${baseTopic}/${camera.name}/meta`;
  const payload = {
    name: `${camera.name} snapshot`,
    unique_id: objectId,
    topic: `${baseTopic}/${camera.name}/image`,
    availability: buildAvailability(baseTopic, camera.name),
    availability_mode: 'all',
    json_attributes_topic: metadataTopic,
    device: buildDevice(baseTopic, camera),
  };

  return {
    topic,
    payload: JSON.stringify(payload),
    retain,
  };
}

function buildCommandSelectDiscovery(
  camera: CameraConfig,
  baseTopic: string,
  prefix: string,
  retain: boolean,
): DiscoveryEntry {
  const objectId = sanitizeId(`${camera.name}_command`);
  const topic = `${prefix}/select/${objectId}/config`;
  const metadataTopic = `${baseTopic}/${camera.name}/meta`;
  const payload = {
    name: `${camera.name} command`,
    unique_id: objectId,
    command_topic: `${baseTopic}/${camera.name}/command`,
    options: ['snapshot'],
    availability: buildAvailability(baseTopic, camera.name),
    availability_mode: 'all',
    json_attributes_topic: metadataTopic,
    device: buildDevice(baseTopic, camera),
  };

  return {
    topic,
    payload: JSON.stringify(payload),
    retain,
  };
}

function buildAppReloadSelectDiscovery(
  baseTopic: string,
  prefix: string,
  retain: boolean,
): DiscoveryEntry {
  const objectId = sanitizeId(`${baseTopic}_app_command`);
  const topic = `${prefix}/select/${objectId}/config`;
  const payload = {
    name: 'app command',
    unique_id: objectId,
    command_topic: `${baseTopic}/command`,
    options: ['reload'],
    availability: [
      {
        topic: `${baseTopic}/status`,
        payload_available: 'ONLINE',
        payload_not_available: 'OFFLINE',
      },
    ],
    availability_mode: 'all',
    device: buildAppDevice(baseTopic),
  };

  return {
    topic,
    payload: JSON.stringify(payload),
    retain,
  };
}

function buildDiscoveryEntries(cfg: AppConfig): DiscoveryEntry[] {
  const settings = getHomeAssistantSettings(cfg);
  const baseTopic = cfg.mqtt.basetopic || cfg.mqtt.baseTopic || 'onvif2mqtt';
  const entries: DiscoveryEntry[] = [];

  if (!settings.enabled) return entries;

  if (settings.components.appReloadCommand) {
    entries.push(buildAppReloadSelectDiscovery(baseTopic, settings.prefix, settings.retain));
  }

  for (const camera of cfg.cameras) {
    const hasDiscoveryComponent = settings.components.events || settings.components.snapshot || settings.components.snapshotCommand;
    if (hasDiscoveryComponent) {
      entries.push(buildCameraMetadataEntry(camera, baseTopic));
    }

    if (settings.components.events) {
      entries.push(...buildEventDiscovery(camera, baseTopic, settings.prefix, settings.retain));
    }
    if (settings.components.snapshot) {
      entries.push(buildSnapshotDiscovery(camera, baseTopic, settings.prefix, settings.retain));
    }
    if (settings.components.snapshotCommand) {
      entries.push(buildCommandSelectDiscovery(camera, baseTopic, settings.prefix, settings.retain));
    }
  }

  return entries;
}

function reconcileOwnedDiscoveryTopics(mqtt: MQTTWrapper, nextEntries: DiscoveryEntry[]) {
  const nextTopics = new Set(nextEntries.map((entry) => entry.topic));

  for (const topic of ownedHomeAssistantTopics) {
    if (!nextTopics.has(topic)) {
      mqtt.publishRaw(topic, '', { retain: true });
    }
  }

  for (const entry of nextEntries) {
    mqtt.publishRaw(entry.topic, entry.payload, { retain: entry.retain });
  }

  ownedHomeAssistantTopics = nextTopics;
}

export async function publishHomeAssistantDiscovery(cfg: AppConfig, mqtt: MQTTWrapper) {
  const settings = getHomeAssistantSettings(cfg);
  const entries = buildDiscoveryEntries(cfg);

  try {
    reconcileOwnedDiscoveryTopics(mqtt, entries);

    if (settings.enabled) {
      logInfo(`[INFO] Home Assistant discovery published cameras=${cfg.cameras.length} prefix=${settings.prefix}`);
    }
  } catch (err) {
    logError('[ERROR] Failed to publish Home Assistant discovery', err);
  }
}

export function resetHomeAssistantDiscoveryStateForTests() {
  ownedHomeAssistantTopics = new Set<string>();
}
