# mqtt-camera-controller

Small Node + TypeScript service that converts ONVIF camera events into MQTT topics and publishes snapshots.

## Transparency

This project was created with AI assistance.

- GitHub Raptor Mini (Preview)
- ChatGPT-5.3-Codex

## What this service does

- Ingests ONVIF events using PullPoint polling (default) or Push/Notify (optional)
- Publishes event state topics to MQTT (`ON` / `OFF`)
- Publishes per-camera and app status topics (retained)
- Publishes snapshot images on demand, on event, or on a schedule

## Quick start

1. Copy `config.yaml.example` to `config.yaml`.
2. Edit camera, MQTT, and credential values.
3. Run locally:

```bash
npm install
npm run dev
```

Production run:

```bash
npm run build
npm start
```

Docker run:

```bash
docker build -t mqtt-camera-controller .
docker run -v $(pwd)/config.yaml:/app/config.yaml:ro -e NODE_ENV=production -e CONFIG_PATH=/app/config.yaml mqtt-camera-controller
```

You can also use `docker-compose.yml`.

## Configuration basics

Runtime config load order (highest to lowest):

1. Path passed directly to `loadConfig()`
2. `CONFIG_PATH` environment variable
3. `./config.yaml`

`config.yaml.example` is for editing/reference only. In tests, `NODE_ENV=test` allows fallback to the example config.

### MQTT

```yaml
mqtt:
  server: "localhost"
  port: 1883
  basetopic: "mqtt"
  client: "mqtt-client"
  password_file: /run/secrets/mqtt_password
```

- Base topic key is `mqtt.basetopic` (fallback: `mqtt.baseTopic`).
- Use password files (`password_file`) instead of plaintext passwords where possible.

### Logging

```yaml
logging:
  level: info
```

- Valid levels: `debug`, `info`, `warn`, `error`
- `LOG_LEVEL` environment variable is also supported
- If both config and env are set, config level is used

### Home Assistant Discovery

```yaml
homeassistant:
  enabled: true
  prefix: homeassistant
  retain: true
  components:
    events: true
    snapshot: true
    snapshotCommand: true
    appReloadCommand: true
```

- Discovery is enabled by default.
- Set `homeassistant.enabled: false` to disable discovery publication.
- Discovery publishes entities for event binary sensors, snapshot camera, per-camera command select, and an app command select.
- Discovery entities use dual availability topics (`<baseTopic>/<camera>/status` and `<baseTopic>/status`) with `availability_mode: all`.
- Discovery includes retained camera metadata on `<baseTopic>/<camera>/meta` with camera IP, ONVIF port, and event mode.
- `homeassistant.components.appReloadCommand` controls the app-level command select entity (enabled by default).

### Event Snapshot Cooldown

```yaml
rateLimit:
  enabled: true
  cooldownMs: 3000
```

- `rateLimit` is a root-level setting and applies globally to all cameras.
- Cooldown applies only to event-triggered snapshots (`snapshot.onEvent`), not periodic or manual command snapshots.
- During cooldown, event snapshots are ignored and logged at debug level.
- `cooldownMs: 0` disables cooldown behavior.

### Camera configuration contract

Use separate ONVIF and snapshot settings:

```yaml
cameras:
  frontdoor:
    host: 192.168.1.10
    port: 80
    username: admin
    password_file: /run/secrets/frontdoor_password
    snapshot:
      type: url
      address: "http://192.168.1.10/snapshot.jpg"
      onEvent:
        types: [motion]
        delay: 0
      interval: 60000
    event:
      mode: pull
      pull:
        endpointSelection: auto
    durations:
      motion: 10
```

- ONVIF calls use camera root `host` + `port` (`/onvif/device_service`).
- Pull endpoint selection (`event.pull.endpointSelection`) controls event endpoint usage:
  - `auto` (default): try camera-reported endpoint first, then fallback to configured host/port
  - `camera`: always use camera-reported endpoint
  - `configured`: always force configured host/port
- Snapshot retrieval uses `snapshot.address` as the source endpoint.
- If `snapshot` is omitted for a camera, periodic and on-event snapshots are disabled for that camera.
- `snapshot.interval` is in milliseconds and defaults to `0` when omitted (`0` means disabled).
- `snapshot.onEvent` must be an object with required `types` and optional `delay` in milliseconds (default `0`).
  - Valid `types`: `motion`, `line`, `people`, `vehicle`, `animal`, `all`
  - If `types` contains `all`, it must be the only value in the list.
- `snapshot.enabled` is not used by runtime and should be omitted.

Snapshot credentials priority (applies to both `snapshot.type: url` and `snapshot.type: stream`):

1. `snapshot.password_file`
2. `snapshot.username` + `snapshot.password`
3. Credentials embedded in `snapshot.address`

For stream snapshots, resolved credentials are injected into the ffmpeg input URL and encoded safely for reserved characters.

## MQTT topics and behavior

Event topics:

- `<baseTopic>/<cameraName>/motion`
- `<baseTopic>/<cameraName>/line`
- `<baseTopic>/<cameraName>/people`
- `<baseTopic>/<cameraName>/vehicle`
- `<baseTopic>/<cameraName>/animal`

Event publishing behavior:

- Payloads are `ON` and `OFF`
- Event topics are retained
- On startup, each camera publishes retained `OFF` for all canonical event types
- Event `durations` (seconds) control ON hold time before OFF publish

Status topics:

- Camera status: `<baseTopic>/<cameraName>/status` (retained)
- App status: `<baseTopic>/status` (retained)
- Status payloads are `ONLINE` and `OFFLINE`
- App status uses MQTT Last Will (`OFFLINE`) on unexpected disconnect

Snapshot topic:

- `<baseTopic>/<cameraName>/image`
- Payload is binary image data
- Snapshot publishes are non-retained

Camera command topic:

- `<baseTopic>/<cameraName>/command`

Camera command behavior:

- Publish payload `snapshot` (case-insensitive) to request an immediate snapshot
- Unsupported command payloads are ignored (debug log)
- On success, image data is published to `<baseTopic>/<cameraName>/image`
- If snapshot configuration is missing or invalid for that camera, no image will be published

Global app command topic:

- `<baseTopic>/command`

Global app command behavior:

- Publish payload `reload` (case-insensitive) to request a runtime config reload
- Unsupported payloads are ignored (debug log)
- Reload uses the same transactional flow as `SIGHUP` (including rollback on failure)

## Event mapping rules

Mapping is topic-aware (not broad keyword matching):

- `RuleEngine/MotionRegionDetector/Motion` -> `motion`
- `RuleEngine/CellMotionDetector/Motion` -> `motion`
- `RuleEngine/PeopleDetector/People` -> `people`
- `RuleEngine/LineCrossDetector/LineCross` -> `line`
- `RuleEngine/TPSmartEventDetector/TPSmartEvent`:
  - `IsVehicle` -> `vehicle`
  - `IsPet` -> `animal`

Unknown ONVIF topics and unknown TP-Link sub-events are logged at debug level with extracted parameters.

## Pull and push modes

Pull mode (default):

- Polls camera PullPoint endpoint for events
- Endpoint source policy is controlled by `event.pull.endpointSelection` (`auto` by default)
- Camera status transitions to `ONLINE` only after healthy pull activity

Push mode (optional):

- App hosts a notify endpoint and receives camera POST notifications
- Optional auto-subscribe can request camera-side CreateSubscription

Example push config:

```yaml
cameras:
  driveway:
    host: 192.168.1.11
    port: 80
    event:
      mode: push
      push:
        autoSubscribe: true

notify:
  baseUrl: "https://my-host.example"
  port: 8080
  basePath: "/onvif/notify"
```

Notify URL/port reconciliation behavior:

- If `notify.baseUrl` includes a port and `notify.port` is omitted, the app listens on the `baseUrl` port.
- If `notify.baseUrl` omits a port and `notify.port` is set, the app appends `notify.port` to the callback URL used for subscription.
- If both are set and differ, the app keeps split behavior (callback uses `baseUrl` port, listener uses `notify.port`) and logs a warning.
- If neither provides a port, default is `8080`.

Notify path format is `${notify.basePath}/${cameraName}`.

## Security and auth behavior

ONVIF request strategy is secure-first:

- Try WS-Security UsernameToken first when credentials exist
- Fall back to Basic auth only if needed
- Warn when falling back to Basic over non-TLS (`http://`)

## Troubleshooting

- `No configuration file found`: verify `CONFIG_PATH` or `./config.yaml`
- Pull URL/path errors: check logs for attempted ONVIF URL and HTTP status
- Push path mismatch: logs include received path and expected base path
- Unknown events: visible at `debug` log level
- For low-level namespace traces, use `DEBUG=*`
- Send `SIGHUP` to trigger runtime config reload without restarting the process.
- Publish `reload` to `<baseTopic>/command` to trigger runtime config reload through MQTT.
- Set `MQTT_CAM_CONFIG_RELOAD=true` to watch the active config file path and auto-reload when it changes (debounced).

## Development commands

- Tests: `npm test`
- Lint: `npm run lint`
- Build: `npm run build`

## License

BSD 3-Clause. See `LICENSE`.
