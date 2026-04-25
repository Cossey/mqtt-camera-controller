# AGENTS.md

This file defines repository-specific guidance for coding agents working in this project.

## Project Summary

- Service: ONVIF to MQTT bridge for camera events and snapshots.
- Language: TypeScript (Node.js).
- Key areas: ONVIF pull/push event ingestion, MQTT topic publishing, status/LWT semantics, snapshot publishing.

## Working Rules

- Keep changes minimal and scoped to the task.
- Preserve existing public behavior unless the task explicitly changes behavior.
- Prefer adding tests for behavior changes.
- Do not add or rely on `snapshot.enabled`; runtime does not use it.

## Build and Test

- Run tests: `npm test -- --runInBand`
- Build: `npm run build`

Always run both after code changes when feasible.

## Configuration Contracts

- ONVIF connection uses camera root fields:
  - `cameras.<name>.host`
  - `cameras.<name>.port`
- Snapshot retrieval uses:
  - `cameras.<name>.snapshot.address`
- Pull mode requires valid camera host/port.
- Push mode auto-subscribe also requires valid ONVIF host/port.
- Pull endpoint source policy is configurable via `cameras.<name>.event.pull.endpointSelection`:
  - `auto` (default): camera endpoint first, fallback to configured host/port
  - `camera`: always use camera-reported endpoint
  - `configured`: always use configured host/port

## MQTT Topic Contracts

- Base topic: `mqtt.basetopic` (fallback `mqtt.baseTopic`).
- Event topics: `<baseTopic>/<cameraName>/{motion|line|people|vehicle|animal}`
- Snapshot topic: `<baseTopic>/<cameraName>/image`
- Camera status topic: `<baseTopic>/<cameraName>/status` (retained)
- Global status topic: `<baseTopic>/status` (retained, with LWT)

## Status and Retain Behavior

- Startup baseline publishes retained `OFF` for event topics per camera.
- Status payloads use uppercase `ONLINE` / `OFFLINE` for both camera and global status topics.
- Camera status starts `OFFLINE` and transitions based on event-channel health.
- Pull mode should only show `ONLINE` after healthy polling.
- Global app status uses MQTT Last Will on `<baseTopic>/status`.

## ONVIF Event Mapping Rules

Use topic-aware mapping, not broad keyword heuristics.

Canonical mappings:

- `RuleEngine/MotionRegionDetector/Motion` -> `motion`
- `RuleEngine/CellMotionDetector/Motion` -> `motion`
- `RuleEngine/PeopleDetector/People` -> `people`
- `RuleEngine/LineCrossDetector/LineCross` -> `line`
- `RuleEngine/TPSmartEventDetector/TPSmartEvent`:
  - `IsVehicle` -> `vehicle`
  - `IsPet` -> `animal`

Unknown topics and unknown TPLink smart sub-events should be logged at debug level with topic and extracted params.

## ONVIF Security and Fallback Policy

Use most secure method first.

- Try WS-Security UsernameToken first when credentials exist.
- Only fall back to Basic auth if WS-Security fails.
- Per-attempt fallback failures should be debug-level.
- If all fallbacks are exhausted, log error-level.
- Warn if falling back to Basic auth over non-TLS (`http://`).

## Logging Policy

- Supported levels: `error`, `warn`, `info`, `debug`.
- Configure with `logging.level` in config or `LOG_LEVEL` env var.
- Keep success-path operational messages at info level.
- Reserve error level for real failures (terminal or connection failures).

## Files to Check for Related Changes

- `src/onvif/pullPoint.ts`
- `src/onvif/push.ts`
- `src/cameras/camera.ts`
- `src/cameras/cameraManager.ts`
- `src/index.ts`
- `src/config.ts`
- `src/logger.ts`
- `README.md`

## Safety

- Never log plaintext secrets.
- Redact credentials in URLs and auth details in logs.
- Do not use destructive git commands unless explicitly requested.
