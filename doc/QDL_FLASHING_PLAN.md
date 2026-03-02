# QDL Flashing Capability Plan for STF

## 1) Objective

Add a reliable, auditable way to flash full Android OS images from STF using QDL/EDL flows (Sahara/Firehose), while preserving STF's existing multi-user safety model.

Primary outcomes:

- Trigger a flash job from STF (UI/API) for a selected device.
- Run QDL on the provider host with controlled inputs (no arbitrary command injection).
- Stream progress and logs back to STF users.
- Persist job history and outcomes for traceability.
- Keep macOS + Docker workflows usable for development by supporting dry-run/non-destructive validation paths.

## 2) Scope for First Release (MVP)

In scope:

- Single-device flash jobs initiated by privileged users.
- Pre-uploaded flash package + manifest (firehose programmer + rawprogram/patch + image blobs).
- Provider-host execution of `qdl` via a managed flash worker.
- Job states, logs, and result persisted in DB.
- Basic UI action under device maintenance.
- Real QDL execution on Linux provider hosts with direct USB access.

Out of scope (MVP):

- Parallel bulk flashing campaigns.
- Auto-discovery/download of firmware from external URLs.
- Arbitrary user-supplied QDL arguments.
- Full fleet scheduler optimization.
- Treating Docker Desktop on macOS as a production-grade QDL execution environment.

## 3) Current STF Integration Points

STF already has a clear pattern for device actions:

- UI emits websocket events (e.g. `device.reboot`, `device.install`) via `res/app/components/stf/control/control-service.js`.
- Websocket unit translates events into wire transactions in `lib/units/websocket/index.js`.
- Device-side plugins execute actions (e.g. `install.js`, `reboot.js`) in `lib/units/device/plugins/`.
- DB schema/setup lives in `lib/db/tables.js` and `lib/db/setup.js`.

Important architectural constraint:

- QDL flashing can outlive ADB connectivity (device disappears from ADB while in EDL), so long-running flash orchestration should not depend only on a short-lived device worker lifecycle.

## 4) Recommended Architecture

Use a dedicated provider-side flash orchestrator unit.

- New unit: `lib/units/flash-qdl/index.js`
- New CLI command: `lib/cli/flash-qdl/index.js`
- Registered in `lib/cli/index.js`
- Started in local mode from `lib/cli/local/index.js` (optional flag for first iteration is fine)

Why this approach:

- Keeps flashing logic isolated from normal device interaction plugins.
- Survives temporary ADB disconnect during EDL mode.
- Enables queueing, retries, and safer host-level execution controls.

## 4.1) Execution Environment Constraints

- Real QDL flashing requires direct low-level USB control on the execution host.
- Recommended production path: Linux provider host with direct USB ownership.
- macOS + Docker Desktop can be used for development/testing of control-plane logic (API/DB/UI/dry-run), but is not the reliability target for real EDL flashing.
- If macOS is used in development for executor experiments, gate it as dev-only and require explicit policy opt-in.
- If STF UI/API is running on macOS, destructive flash jobs must still be routed to a Linux provider host for execution.

## 5) Data Model and State Machine

Add `flashJobs` table in `lib/db/tables.js` with indexes:

- `deviceSerial`
- `status`
- `createdBy`
- `providerChannel` (or provider name)
- `createdAt`

Suggested job status flow:

- `queued`
- `validating`
- `preparing`
- `entering_edl`
- `flashing`
- `reboot_wait`
- `verifying`
- `succeeded`
- `failed`
- `canceled`

Suggested job fields:

- `id`, `deviceSerial`, `provider`, `createdBy`, `createdAt`, `updatedAt`
- `packageRef` (storage URL/id), `manifestVersion`, `targetBuild`
- `status`, `progress`, `step`, `message`
- `logRef` (stored log artifact) or `logLines` (bounded)
- `result` (`success`, `errorCode`, `errorDetail`)

## 6) Flash Package Contract

Define a strict manifest schema (JSON/YAML), for example:

- `programmer`: file path/id
- `rawprogram`: file path/id
- `patch`: file path/id (optional)
- `images`: list of named blobs with checksums
- `deviceConstraints`: board/model/hwrev constraints
- `expectedPostFlash`: optional properties for verification

Safety rules:

- Validate checksums before execution.
- Reject manifests that fail schema validation.
- Reject packages incompatible with target device metadata.

## 7) API and Websocket Surface

REST (recommended for job lifecycle):

- `POST /api/v1/devices/{serial}/flash/qdl` -> create job
- `GET /api/v1/flash/jobs/{id}` -> status/details
- `GET /api/v1/devices/{serial}/flash/jobs` -> history
- `POST /api/v1/flash/jobs/{id}/cancel` -> cancel queued/running job

Likely files:

- `lib/units/api/swagger/api_v1.yaml`
- `lib/units/api/controllers/devices.js` (or a new `flash.js` controller)

Websocket (for live updates):

- Emit job progress/events to subscribed clients (new event namespace like `flash.qdl.*`).
- Hook in `lib/units/websocket/index.js` and frontend listeners.

## 8) Execution Flow (End-to-End)

1. User with proper privilege requests flash for a reserved device.
2. API validates permission, package manifest, and device eligibility.
3. API creates `flashJobs` record with `queued`.
4. `flash-qdl` worker claims job and acquires device lock.
5. Worker stages artifacts to local temp directory.
6. Worker transitions device to EDL (if configured) or waits for manual EDL entry.
7. Worker invokes `qdl` with allowlisted arguments derived from manifest.
8. Worker parses stdout/stderr for progress and updates job state.
9. After flash, worker waits for reboot/ADB reappearance and runs post-flash checks.
10. Worker finalizes job (`succeeded`/`failed`), stores logs, releases device lock.

## 9) Frontend Changes

Start in maintenance panel:

- `res/app/control-panes/advanced/maintenance/maintenance.pug`
- `res/app/control-panes/advanced/maintenance/maintenance-controller.js`
- `res/app/components/stf/control/control-service.js`

MVP UI:

- "Flash OS (QDL)" action
- package/profile selector
- confirmation dialog with strong warnings
- progress modal and final result

## 10) Security and Safety Requirements

Authorization:

- Restrict to admin/provider-level roles (not general users).
- Require device ownership/lock before starting.

Input hardening:

- No raw shell args from UI.
- Build command only from validated manifest and allowlist.

Operational safety:

- One flash job per device at a time.
- Timeouts per step.
- Clear cancel behavior.
- Full audit logs (who, when, what package, result).

## 11) Reliability and Recovery

Failure handling cases:

- Device never enters EDL
- QDL command non-zero exit
- USB disconnect mid-flash
- Device fails to return to ADB after flash
- Post-flash verification mismatch

Recovery strategy:

- Mark job `failed` with actionable error code.
- Keep logs and artifact references.
- Allow controlled retry.
- Keep device unavailable until operator acknowledges.

## 12) Implementation Phases

### Phase 0: Discovery/PoC

- Verify `qdl` tooling availability on provider hosts.
- Validate serial-to-USB/EDL targeting strategy for your hardware.
- Dry-run one known-good package outside STF and capture expected logs.
- Confirm Linux provider host USB path remains stable across mode switches (ADB -> EDL -> post-flash reboot).
- Document macOS/Docker limitations and define dev-only guardrails before enabling any destructive execution outside Linux.

### Phase 1: Backend Scaffolding

- Add `flashJobs` table/indexes.
- Add API endpoints + swagger contracts.
- Add basic job creation/status flow (no execution yet).

### Phase 2: Flash Orchestrator

- Implement `flash-qdl` unit loop, locking, artifact staging.
- Execute QDL command and persist progress/logs.
- Add cancel/timeout behavior.

### Phase 3: UI + Realtime

- Add maintenance-pane workflow.
- Show live job progress and terminal result.
- Add history view (device scoped).

### Phase 4: Hardening

- Manifest signing/checksum policy.
- Permission and audit refinements.
- Failure-injection and resilience tests.

## 13) Test Plan

Unit tests:

- manifest validation
- job state transitions
- permission checks
- command builder allowlist

Integration tests:

- API -> job queue -> orchestrator handoff
- websocket progress propagation
- cancel path and timeout path

Lab tests:

- success flash on target board
- bad manifest rejection
- wrong programmer rejection
- mid-flash disconnect behavior
- post-flash boot verification

## 14) Open Decisions (Need Team Input)

- Should MVP require manual EDL entry first, or support automatic `adb reboot edl`?
- Which QDL implementation/binary is standardized on provider hosts?
- How is device compatibility encoded (board ID, hwrev, SKU)?
- Is signed manifest verification required in MVP or Phase 4?
- Do we need per-group package allowlists from day one?

## 15) Definition of Done (MVP)

- Privileged user can flash one device from STF UI/API with a validated package.
- Job lifecycle and logs are visible and persisted.
- Failure modes are explicit and recoverable.
- No arbitrary host command execution path is exposed.
- End-to-end lab test passes on at least one production-target hardware SKU.
- Production validation is demonstrated on Linux provider host(s), while macOS/Docker usage is limited to approved development/testing scope.
