# iOS Support Port Plan (STF)

## Goal
Add first-class iOS device support to this STF fork using the actual `dryark/stf_ios_support` implementation model, while preserving Android and Samsung flash workflows.

## Reference Baseline (Verified)
Reference inspected from local clone at `/Users/naokiogishi/Projects/STF iOS/stf_ios_support`.

### Runtime Topology
- Linux STF server is still standard STF (docker-compose) with dev triproxy ports exposed at `7250` (PUB) and `7270` (PULL).
- macOS provider host runs a Go `coordinator` process, not Dockerized provider logic.
- `coordinator` launches Node-based STF iOS provider components from `repos/stf-ios-provider`:
  - global provider process: `runmod.js provider`
  - per-device process: `runmod.js device-ios`
- `coordinator` also orchestrates `wdaproxy`, WDA lifecycle, device detection, and video pipeline subprocesses.

### Protocol/Port Contracts
- STF provider connection contract:
  - `--connect-sub tcp://<server-ip>:7250`
  - `--connect-push tcp://<server-ip>:7270`
- Local coordinator event bridge:
  - ZMQ PUB bind: `tcp://127.0.0.1:9394` in the currently tested local clone (`7294` is the upstream default).
  - ZMQ PULL bind: `tcp://127.0.0.1:9400` in the currently tested local clone (`7300` is the upstream default).
  - events include `connect`, `present`, `heartbeat`, `disconnect`
- Default per-device port pools in config:
  - WDA proxy: `8100-8105`
  - stream ingress/egress: `8000-8005`
  - device node inspect: `9240-9250`
  - VNC: `5901-5911`
  - decode: `7878-7888`
  - usbmuxd forwarding: `9920-9930`

### Device Lifecycle in Reference
- Device detection is configurable:
  - `device_detector=api` in this local clone currently uses `ios-deploy -c -t 0` output parsing to derive connect events.
  - otherwise uses `osx_ios_device_trigger`
- Lifecycle sequence:
  - detect device
  - start video path
  - wait for first frame/interface signals
  - start `wdaproxy`/WDA
  - start `device-ios` unit
  - publish heartbeat every 10s
  - on disconnect, stop procs and emit absent event

### Video/Input Model in Reference
- Multiple video methods are supported:
  - `avfoundation` (`ios_video_stream` + `video_enabler` + `ivf_pull`)
  - `ivp` (`ios_video_pull` + `h264_to_jpeg` + `ios_video_stream`)
  - `app` (broadcast app + WDA launch flow)
- Screen URL is proxied via HTTPS nginx route:
  - `/frames/<client_ip>/<client_port>/x` -> provider websocket `/echo`
- Optional VNC proxy path exists via `iproxy`.

### Control/Actions Model in Reference
- Control path uses WDA REST (`/session`, touch, swipe, unlock, app launch, homescreen).
- STF reservation/release is done over STF API (`/api/v1/user/devices`) with bearer admin token.
- IPA/app operations are delegated to `device-ios` unit with explicit `--ios-deploy-path`.

### Dependency Reality
- Reference build chain explicitly depends on Node `12`, Xcode signing, WDA build, and several helper repos (`stf-ios-provider`, `wdaproxy`, `ios_video_stream`, `ios_video_pull`, `ios_avf_pull`, `h264_to_jpeg`, `ios_video_enabler`, `ios-deploy`, `libimobiledevice`).
- HTTPS is treated as mandatory in the reference server setup.
- Local run reality in this environment:
  - coordinator was patched to invoke `node` (PATH) instead of a fixed Node 12 path;
  - `wdaproxy` binary is currently missing, which blocks WDA-ready actions;
  - STF lifecycle ingest works without WDA when `devEvent` connect/present/heartbeat are emitted.

## Current STF Fork Status (2026-03-02)
- Implemented in this fork:
  - iOS provider CLI + local-mode wiring (`lib/cli/ios-provider`, `lib/cli/local`)
  - iOS host-bridge runtime (`lib/units/ios-provider`)
  - iOS protocol fields in wire/db/group change flow (`lib/wire/wire.proto`, `lib/db/api.js`, `lib/units/groups-engine/watchers/devices.js`)
  - websocket + UI path for iOS app launch (`lib/units/websocket`, install pane controller/view)
- Runtime capability level:
  - lifecycle and core actions are wired (`connect/present/heartbeat/disconnect`, install/uninstall/launch)
  - touch/home/type control hooks are wired through WDA
  - screen URL contract is published, but full video pipeline remains coordinator-side
- Validation executed in this environment:
  - `node --check` passed for all touched JS files
  - `npm test` could not run because `gulp` is not installed in this environment (`sh: gulp: command not found`)
  - real coordinator-originated lifecycle events were observed when a physical iOS device was attached (`connect/present/heartbeat`)
  - STF iOS host-bridge subscribed and introduced the real UDID during that run
  - websocket launch path (`device.launchApp`) is end-to-end wired and reaches iOS host execution
  - launch now includes fallback from `ios-deploy` to `xcrun devicectl device process launch` for modern Xcode/runtime combinations
  - with Developer Mode enabled, launch action now returns `tx.done.success=true` on real device through `devicectl` fallback
  - launch transaction returns explicit failure codes (e.g. `DEVELOPER_MODE_DISABLED`) when prerequisites are missing
  - websocket uninstall path (`device.uninstall`) returns `tx.done.success=true` on real device via `devicectl` fallback semantics (including nonexistent bundle IDs)
  - websocket install path (`device.install`) executes on real device and returns `INSTALL_ERROR_UNKNOWN` for intentionally invalid `.ipa` payload (expected negative test)
  - coordinator heartbeat in this run reports `WDAPort: "0"` for the real UDID, confirming WDA-dependent controls remain blocked at coordinator/toolchain level
  - WDA stack remains blocked by host dependencies (`mobiledevice`/`iproxy` availability and Xcode/WDA readiness), not STF message wiring

## Updated Port Plan (With Execution State)

## Phase 0: Reference Delta Document
Status: In progress.
- Create `doc/IOS_SUPPORT_REFERENCE_DIFF.md` with concrete mapping from reference components to this fork:
  - `coordinator` responsibilities
  - `stf-ios-provider` provider/device-ios interfaces
  - ZMQ event payloads and API dependencies
  - process and port contracts
- Output: signed-off technical delta baseline.

## Phase 1: Host-Bridge Runtime (Foundation)
Status: Completed for MVP.
- Keep iOS execution host-side on macOS; STF core remains unchanged.
- Expand `lib/units/ios-provider/` from scaffold to real host-bridge runtime manager.
- Add explicit configuration for:
  - server triproxy endpoints (`7250`/`7270`)
  - local bridge ports (`7294`/`7300` upstream; `9394`/`9400` in this local validation setup)
  - per-device port pool allocation
  - detector mode (`api` vs trigger)
- Output: deterministic process supervisor with restart/backoff and structured logs.

## Phase 2: Device Lifecycle Integration
Status: Completed for host-bridge events; spot-validated with real device attach.
- Implement lifecycle equivalent to reference:
  - detect/connect/disconnect
  - present/absent/heartbeat event publication
  - WDA start readiness gating
  - per-device `device-ios` worker lifecycle
- Preserve Android provider behavior with strict feature flag isolation.
- Output: iOS devices appear/disappear reliably in STF with heartbeat-driven presence.
- Tryability at end of Phase 2:
  - yes, device presence/identity flow is testable in STF when coordinator events are available on `devEvent`.
  - no app install/launch guarantee unless Phase 3 dependencies (`ios-deploy`, storage URL, WDA reachability) are configured.

## Phase 3: Core Action Surface
Status: Implemented in STF; partially hardware-validated on real device.
- Implement minimum action parity with reference-backed components:
  - install `.ipa`
  - uninstall app
  - launch app by bundle id
  - unlock/home/reboot-if-supported hooks
  - reserve/release API flow
- Keep command audit trail in existing STF logging patterns.
- Output: auditable core actions reachable from API/websocket/UI path.
- Current scope note:
  - implemented: install/uninstall/launch + home/tap/type through WDA.
  - validated: launch and uninstall actions return `tx.done.success=true` on real UDID through websocket/API/device channel path.
  - validated (negative): install action returns `INSTALL_ERROR_UNKNOWN` with intentionally invalid `.ipa`, confirming error-path handling.
  - pending: reserve/release API parity and reboot/unlock semantics.
  - environment note: on this host, direct `ios-deploy` launch still fails with DeviceSupport detection mismatch, but `devicectl` fallback succeeds.

## Phase 4: Streaming + Input
Status: Partially completed.
- Implement one primary video method for MVP:
  - default to `avfoundation` path for first integration pass.
- Add fallback/experimental method wiring for `ivp` later.
- Integrate frame route contract compatible with `/frames/<client_ip>/<port>/x`.
- Output: stable live screen + basic touch input for supported devices.
- Current scope note:
  - implemented: screen URL publication + touch/home/type actions.
  - validation block: current coordinator heartbeat reports `WDAPort=0` on real device, so WDA-backed touch/home/type execution cannot be verified yet.
  - pending: full host video process orchestration in this fork.

## Phase 5: API/Websocket/UI
Status: Implemented for launch-action MVP; websocket action-path validation executed on real device.
- Finalize iOS-capability-aware payloads in API and websocket messages.
- Add UI platform gating:
  - show iOS-only actions
  - hide unsupported Android controls
  - clear unsupported-state messaging
- Output: complete operator flow for iOS devices in existing STF UI.
- Current scope note:
  - implemented: websocket `device.launchApp`, control service method, iOS-gated launch UI in install pane.
  - validated: websocket transaction path returns device-targeted `tx.done` for iOS launch/uninstall requests on real UDID.
  - validated (negative): websocket install transaction returns expected failure (`INSTALL_ERROR_UNKNOWN`) with invalid `.ipa`.
  - validated: API device payload includes iOS identity block (`platform=iOS`, `platformFamily=ios`, `ios.udid`) and active device channel for action routing.
  - pending: broader iOS capability gating across all dashboard panes.

## Right Panel Capability Matrix (iOS)
Reference source for iOS equivalents: `stf_ios_support/repos/stf-ios-provider/lib/units/device-ios/index.js` currently enables `service`, `touch`, `install`, `capture`, `logcat`, and `connect`; Android-centric plugins remain disabled (`shell`, `store`, `forward`, `wifi`, `ringer`, `sd`, `filesystem`, `reboot`, `account`).

| Panel (Control UI right side) | iOS equivalent should exist? | Current state in this fork | Decision / Target |
| --- | --- | --- | --- |
| Dashboard: App Upload (`.ipa`) | Yes | Implemented and validated through websocket/device channel path | Keep enabled |
| Dashboard: Launch App (bundle id) | Yes | Implemented and validated on real device | Keep enabled |
| Dashboard: Uninstall | Yes | Backend action works, but install card uninstall depends on Android manifest package | Add explicit iOS bundle-id uninstall input |
| Dashboard: Navigation (`browser.open`) | Partial | No iOS handler yet | Implement open URL via WDA-style endpoint; hide reset/clear until supported |
| Dashboard: Clipboard | Yes | No iOS handler yet | Implement copy/paste via WDA pasteboard calls |
| Dashboard: Shell | No practical iOS equivalent | Android shell only | Hide for iOS |
| Dashboard: Apps shortcuts (Settings/WiFi/Developer) | No practical iOS equivalent | Android intent + shell only | Hide for iOS |
| Dashboard: Remote debug | Optional | No iOS handler yet; current UX says `adb connect` | Hide for MVP; later replace with iOS-specific tunnel workflow |
| Screenshots tab | Yes | No iOS `screen.capture` handler | Implement `ScreenCaptureMessage` handling |
| Logs tab | Yes | No iOS `logcat.start/stop` handler | Implement iOS log stream adapter (`idevicesyslog` or `devicectl`) |
| Automation: Store Account | No (not realistically automatable on iOS) | No iOS handler | Hide for iOS |
| Automation: Device Settings (WiFi/Bluetooth/Ringer) | No (iOS restrictions) | No iOS handler | Hide for iOS |
| Advanced: Input | Partial | Home key only; touch/type already routed via WDA | Show only supported key set for iOS (start with Home) |
| Advanced: Port Forwarding | No current iOS plugin equivalent | No iOS handler | Hide for iOS |
| Advanced: Maintenance (Reboot/Samsung updater) | No for iOS | No iOS handler | Hide for iOS |
| File Explorer | No current iOS plugin equivalent | No iOS handler | Hide for iOS |
| Info tab | Partial | Identity/display data present; SD-card query is Android-specific | Keep tab, gate Android-only cards/fields on iOS |

## Right Panel Execution Plan (Post-Phase 5)
1. Phase 5A: UI gating hardening
   - Hide iOS-unsupported panels/actions to avoid timeouts and gray-state UX.
   - Keep only actionable MVP controls visible for iOS (`App Upload`, `Launch`, core `Info`).
2. Phase 5B: High-value parity
   - Implement iOS handlers for `screen.capture`, `logcat.start/stop`, `browser.open`, clipboard copy/paste.
   - Add iOS bundle-id uninstall control in Dashboard Install panel.
3. Phase 5C: Optional parity
   - Reintroduce iOS-specific remote-debug/connect workflow.
   - Expand advanced input mapping only where behavior is deterministic and testable.

## Right Panel Exit Criteria
- No visible iOS control in right panels performs a guaranteed timeout path.
- `Screenshots`, `Logs`, and `App Upload/Launch/Uninstall` are all real-device validated.
- Unsupported Android-only panels are either hidden or explicitly labeled as unsupported on iOS.

## Phase 6: Validation + Hardening
Status: In progress (active live bring-up).
- Publish:
  - `doc/IOS_SUPPORT_TEST_PLAN.md`
  - `doc/IOS_SUPPORT_RUNBOOK.md`
- Validate:
  - reconnect behavior
  - process crash recovery
  - first-frame/WDA race conditions
  - stale video session recovery (`devreset`-style behavior)
  - mixed Android+iOS concurrency
- Output: production-readiness checklist with known limits.

## MVP Acceptance Criteria
- iOS device presence transitions (`connect/present/heartbeat/disconnect`) are stable.
- Operator can install and launch an iOS app from STF.
- Live screen view works through the configured secure frame route.
- Android/Samsung flows are unaffected when iOS is disabled.
- Feature remains disabled-by-default and explicitly enabled via env/config.

## Key Risks and Mitigations
- Node/runtime drift (reference uses Node 12): isolate iOS provider runtime and validate compatibility matrix.
- WDA/signing/toolchain fragility: pin version matrix and add preflight checks.
- Video session instability on restart: add automatic reset/recovery path and runbook steps.
- HTTPS/WS proxy coupling: test with real TLS topology early, not only localhost.

## Immediate Next Step
- Run end-to-end validation on macOS provider host with real devices:
  - ensure a USB iOS device is connected/unlocked/trusted and visible via `ios-deploy -c`.
  - keep Developer Mode enabled on the physical iOS device (required for `devicectl` launch path).
  - ensure Xcode + matching DeviceSupport for the connected iOS version are installed (`DeveloperDiskImage.dmg` available).
  - provide either `mobiledevice` or `iproxy` on host path for `wdaproxy` transport startup.
  - ensure `wdaproxy` is running from `stf_ios_support` (`bin/wdaproxy`) and coordinator emits non-zero `WDAPort` in heartbeat.
  - confirm lifecycle transitions in UI from coordinator `devEvent`.
  - validate install/uninstall/launch through `ios-deploy` and `devicectl` fallback path.
  - validate WDA touch/home/type controls and frame route availability.
