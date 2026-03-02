# iOS Support Port Plan (STF)

## Goal
Add first-class iOS device support to this STF fork using `dryark/stf_ios_support` as a reference implementation, while preserving current Android and Samsung updater workflows.

## Current State
- This repo has Android provider/runtime flow in `lib/units/*`.
- UI already has minor iOS traces (for example `.ipa` upload branch), but no complete iOS backend pipeline.
- We currently cannot inspect `dryark/stf_ios_support` from this environment due intermittent DNS/network issues to GitHub, so this plan assumes external code review on a machine with access.

## Scope
- In scope:
  - iOS device discovery and lifecycle state in STF.
  - iOS install/uninstall and app launch primitives.
  - Live screen/interaction path (as supported by chosen backend).
  - Logs/status/events exposed via existing API/websocket patterns.
  - UI adjustments for iOS capability differences.
- Out of scope (initial release):
  - Full parity with every Android control feature.
  - Cloud-scale iOS farm orchestration.
  - Automated signing/provisioning management for enterprise deployment.

## Host Architecture
- Android provider host remains Linux/macOS as today.
- iOS provider host should be macOS (required for Xcode stack and common tooling like WebDriverAgent).
- STF core remains in Docker, but iOS provider execution should run on host-side process/service (similar to current mac-dev-local strategy for Samsung updater).

## Proposed Phases

## Phase 0: Reference Intake
- Pull and inspect `dryark/stf_ios_support` on a network-enabled machine.
- Produce a delta map:
  - Added/changed backend units.
  - API/websocket contract changes.
  - Frontend modules/routes/components.
  - External runtime dependencies.
- Output:
  - `doc/IOS_SUPPORT_REFERENCE_DIFF.md`

## Phase 1: Backend Scaffolding
- Create `lib/units/ios-provider/` with interfaces matching existing unit conventions.
- Define iOS device model fields in db/event payloads without breaking Android paths.
- Add feature flags:
  - `STF_IOS_ENABLE`
  - `STF_IOS_PROVIDER_MODE` (e.g. `disabled|host-bridge`)
- Output:
  - Compilable backend with iOS provider disabled by default.

## Phase 2: Device Lifecycle
- Implement:
  - iOS device discovery
  - connect/disconnect events
  - heartbeat/presence updates
  - status mapping to STF device states
- Add robust error codes for:
  - missing toolchain
  - pairing/trust issues
  - transport/session failures
- Output:
  - iOS devices appear in STF list with stable presence/state.

## Phase 3: Core Actions
- Implement minimal action set:
  - install `.ipa`
  - uninstall app
  - launch app by bundle id
  - reboot (if supported)
  - fetch basic device info
- Reuse existing command execution logging pattern (stdout/stderr/exit code capture).
- Output:
  - action endpoints available and auditable.

## Phase 4: Streaming + Input
- Integrate selected iOS screen/input backend.
- Expose stream URL and control channel with capability guards.
- Ensure degraded-but-safe behavior if stream backend is unavailable.
- Output:
  - view/control available for supported iOS versions/devices.

## Phase 5: API/Websocket + UI Integration
- Add/extend API endpoints for iOS actions using existing style in:
  - `lib/units/api/swagger/api_v1.yaml`
- Wire websocket events for iOS state and action progress.
- Update UI:
  - platform-aware controls
  - unsupported feature messaging
  - clear operator copy
- Output:
  - end-to-end UI flow for iOS device operations.

## Phase 6: Validation + Hardening
- Add test plan and runbook:
  - `doc/IOS_SUPPORT_TEST_PLAN.md`
  - `doc/IOS_SUPPORT_RUNBOOK.md`
- Validate:
  - reconnect behavior
  - provider restart recovery
  - concurrency limits
  - failure observability
- Output:
  - production-readiness checklist and known limitations.

## Acceptance Criteria (MVP)
- iOS device appears/disappears in STF in near real-time.
- Operator can install and launch an app on iOS device from STF.
- Job/action logs are visible and retained in existing history patterns.
- Android functionality and Samsung updater functionality remain unaffected.
- Feature is disabled by default and can be enabled explicitly.

## Risks
- Tooling drift across iOS/Xcode versions.
- Device trust/pairing edge cases.
- Higher maintenance burden than Android path.
- Docker-host boundary complexity for USB passthrough and stream/input channels.

## Mitigations
- Strict version matrix in runbook (macOS, Xcode, iOS, tooling).
- Capability probing and explicit unsupported-state UX.
- Isolate iOS provider behind feature flags and clear interfaces.
- Add detailed operational logging from day one.

## Immediate Next Step
- Create `doc/IOS_SUPPORT_REFERENCE_DIFF.md` after reviewing `dryark/stf_ios_support` on a machine with GitHub access, then begin Phase 1 scaffolding.
