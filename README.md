# mqtt-camera-controller

A small, focused Node + TypeScript service that translates ONVIF camera events into MQTT messages and can capture snapshots on demand, on event, or periodically. The project aims to be easy to configure, secure by default (favoring secret files), and friendly for Docker deployments.

**Development note:** This repository was vibe-coded using GitHub Raptor Mini (Preview). 

## At a glance

- Input: ONVIF camera events (PullPoint polling by default, or optional Push/Notify)
- Output: MQTT topics for event states and binary snapshot payloads
- Snapshot modes: HTTP snapshot (URL) or stream frame capture with `ffmpeg`
- Configuration: YAML (`config.yaml`); see `config.yaml.example` as an editable starting template

## Quick start

1. Copy `config.yaml.example` to `config.yaml` and edit it with your settings (do not leave secrets in the example file).

1. Install and run locally in development:

```bash
npm install
npm run dev
```

1. Build for production and run:

```bash
npm run build
node dist/index.js
```

Docker (recommended):

```bash
# build
docker build -t mqtt-camera-controller .

# run with config mounted (use Docker secrets for passwords)
docker run -v $(pwd)/config.yaml:/app/config.yaml:ro -e NODE_ENV=production -e CONFIG_PATH=/app/config.yaml mqtt-camera-controller
```

Or use the provided `docker-compose.yml`.

## Configuration (concise)

Load order (highest → lowest):

1. Path passed to `loadConfig()` (programmatic)
2. `CONFIG_PATH` env var
3. `./config.yaml`

Note: `config.yaml.example` is not used as a runtime fallback. It is intended only as an editable example for development and tests. Jest uses `NODE_ENV=test` so the loader will fall back to the example during unit tests.

### MQTT

Key fields:

```yaml
mqtt:
  server: "localhost"
  port: 1883
  basetopic: "mqtt"
  client: "mqtt-client"
  # prefer Docker secret file for credentials
  password_file: /run/secrets/mqtt_password
```

### Camera entries

Two supported formats:

- Mapping form (compact):

```yaml
cameras:
  frontdoor: "http://user:pass@192.168.1.10/snapshot.jpg"
```

- Expanded form (recommended):

```yaml
cameras:
  frontdoor:
    host: 192.168.1.10
    username: admin
    password_file: /run/secrets/frontdoor_password
    snapshot:
      type: url
      address: "http://192.168.1.10/snapshot.jpg"
      onEvent: true
      interval: 60
    durations:
      motion: 10
```

Snapshot credentials

- Preferred: `snapshot.password_file` (uses Docker secrets)
- Alternates: `snapshot.username` and `snapshot.password`, or embedded credentials in `snapshot.address` (e.g. `http://user:pass@host/...`) — explicit snapshot credentials take precedence.

## Events, detection, and topics

Canonical event types published by the service:

- motion — detected by `IsMotion` flags, `Motion` topics (e.g., `RuleEngine/.../Motion`) or `motion` keywords
- line — detected by `Line`/`LineCross` indications or `line`/`linecross` text
- people — detected by `person`/`people` indicators
- vehicle — detected by `vehicle` indicators
- animal — detected by `pet`/`animal` indicators

How events are published:

- Topic: `<baseTopic>/<cameraName>/<event>`
- Payload: `ON` for active (and `OFF` when the configured duration expires or when OFF is explicitly reported)
- Duration: per-camera `durations` map (seconds) controls how long to keep an event ON before publishing OFF. If absent/zero, the service follows the reported ON/OFF state from ONVIF if available.

## Push / Notify mode (optional)

Some cameras support ONVIF push notifications. When enabled the controller will start a small HTTP server and optionally attempt a CreateSubscription request on the camera so it will POST events back.

Config example (camera):

```yaml
cameras:
  driveway:
    snapshot:
      address: rtsp://192.168.1.11/stream
    event:
      mode: push
      push:
        autoSubscribe: true
        # notifyPath: /onvif/notify/driveway  # optional custom path
```

App-level notify config:

```yaml
notify:
  baseUrl: "https://my-host.example"  # reachable by camera
  port: 8080
  basePath: "/onvif/notify"
```

When `notify` is present, the app listens for POSTs on `${notify.basePath}/${cameraName}` and forwards normalized events into MQTT.

## Snapshots

- `snapshot.type` may be `url` (HTTP snapshot) or `stream` (use ffmpeg to capture a frame). Use `snapshot.address` for the address in both cases.
- Triggers: on-demand (`<camera>/command/snapshot`), on-event (if `snapshot.onEvent` true), periodic (`snapshot.interval` > 0)
- For HTTP snapshots the service will use Basic Auth when `snapshot.username`/`snapshot.password` (or `snapshot.password_file`) are set or when credentials are embedded in the `address`.
- For stream snapshots `ffmpeg` must be available in the runtime image.

## Tests & Development

- Unit tests: `npm test` (Jest). The loader will fall back to `config.yaml.example` during tests via `NODE_ENV=test`.
- Lint: `npm run lint` (ESLint + TypeScript rules).

## Troubleshooting & tips

- If you see `No configuration file found`, ensure `CONFIG_PATH` or `config.yaml` exists in the working directory.
- For subscription discovery issues enable debug logs: `DEBUG=mqtt-camera-controller*`.
- Use Docker secrets (`password_file`) to avoid storing plaintext credentials in files.

## License

BSD 3-Clause — see `LICENSE` for details.
