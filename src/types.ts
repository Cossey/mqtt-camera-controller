export interface MqttConfig {
  // mqtt-ai-tool style
  server?: string; // host
  port?: number;
  basetopic?: string; // note: mqtt-ai-tool uses 'basetopic'
  client?: string;

  // legacy/alternate
  username?: string;
  password?: string;
  password_file?: string;
  baseTopic?: string; // keep older key supported
}

export interface ChannelConfig {
  id: number;
  name?: string;
  onDuration?: number;
}

export interface SnapshotConfig {
  enabled?: boolean;
  interval?: number; // seconds
  onEvent?: boolean;
  // snapshot type: 'url' to fetch HTTP snapshot, 'stream' to grab a frame via ffmpeg from a stream
  type?: 'url' | 'stream';
  // unified address for snapshot (HTTP or stream). This replaces separate url/stream fields.
  address?: string;
  // credentials specific to snapshot (optional). If present these take precedence over credentials embedded in the address.
  username?: string;
  password?: string;
  password_file?: string;
}

export type RawCameraEntry = string | {
  host?: string;
  port?: number;
  url?: string;
  username?: string;
  password?: string;
  password_file?: string;
  snapshot?: SnapshotConfig;
  durations?: { [key: string]: number };
};

export interface CameraConfig {
  name: string;
  // internal normalized form
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  snapshot?: SnapshotConfig;
  // map of event name (motion, line, people, vehicle, animal) to on-duration seconds
  eventDurations?: { [event: string]: number };
  // event subscription options: mode can be 'pull' (default) or 'push' (notify POSTs)
  event?: {
    mode?: 'pull' | 'push';
    push?: {
      // if provided, the camera will be asked to POST events to notifyBaseUrl + notifyPath
      autoSubscribe?: boolean;
      // path on the notify server, e.g. '/onvif/notify/front-door'; if not provided one will be generated
      notifyPath?: string;
    };
  };
}

export interface AppConfig {
  mqtt: MqttConfig;
  cameras: CameraConfig[];
  // optional HTTP notify server configuration for ONVIF push mode
  notify?: {
    // external URL base used when requesting camera to POST events back (e.g. https://myhost.example)
    baseUrl?: string;
    // port to listen on for incoming notifications (default: 8080)
    port?: number;
    // base path prefix for notifications (default: /onvif/notify)
    basePath?: string;
  };
}

export interface EventNotification {
  type: string;
  // true = ON, false = OFF, undefined = not specified (pulse)
  state?: boolean | null;
}  

export interface AppConfig {
  mqtt: MqttConfig;
  cameras: CameraConfig[];
}
