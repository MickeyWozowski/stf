# Samsung Flashing Test Plan (STF)

## 1) Goal

Validate the Samsung flashing workflow as completely as possible across:
- Current implemented functionality (Phase 1 dry-run scaffolding).
- Planned functionality (Phase 2 executors, Phase 3 API/UI).
- Safety controls for `mac-dev-local` development backend.

Primary target device for validation:
- `SM-T830` (`Galaxy Tab S4`)
- Example serial used in current environment: `ce0918299bd3963b047e`

## 2) Scope

In scope:
- DB schema/migration for `flashJobs`.
- CLI lifecycle (`enqueue`, `list`, `get`, `cancel`, `worker`).
- Dry-run worker state transitions and audit fields.
- Guardrail behavior for mac dev backend (planned tests, to be enabled when implemented).
- Reliability/error-path coverage.

Out of scope for this plan iteration:
- Production rollout procedures.
- Full Samsung firmware content validation policy authoring.

## 3) Test Environments

### Env A: macOS Dev + Docker STF (current)
- Purpose: fast iteration and Phase 1 dry-run verification.
- Backend mode: `dry-run` only.

### Env B: Linux Provider Host (planned)
- Purpose: real flashing execution validation.
- Backend mode: `linux-provider`.

### Env C: mac dev local backend (planned, guarded)
- Purpose: developer-only execution path validation.
- Backend mode: `mac-dev-local` with strict safety gates.

## 4) Required Preconditions

- STF stack is running and healthy.
- RethinkDB reachable from STF.
- At least one device is visible to STF provider.
- Migration can be executed (`stf migrate`).
- For Phase 2 tests: known-good Samsung package, manifest, and rollback package.

## 5) Test Data Fixtures

Use these fields for repeatable tests:
- `serial`: `<device-serial>`
- `packageRefValid`: `firmware://sm-t830/xar/u5`
- `packageRefInvalid`: `firmware://does-not-exist`
- `createdByAdmin`: `administrator@fakedomain.com`
- `createdByUser`: `dev-user@example.com`

## 6) Execution Strategy

Run in this order:
1. Smoke tests (critical path, current functionality).
2. Negative tests (invalid input, safety checks).
3. Concurrency and cancel behavior.
4. Future executor tests (linux/mac backends).
5. Future API/UI tests.

Evidence collection for each case:
- command output or logs
- job ID
- final job document snapshot
- pass/fail + notes

## 7) Smoke Tests (Run Now)

### STF-SMOKE-001: Schema migration creates `flashJobs`
- Steps:
  1. Run `stf migrate`.
  2. Verify logs show table/index readiness for `flashJobs`.
- Expected:
  - Table exists.
  - Indexes `status`, `deviceSerial`, `createdBy`, `provider`, `createdAt` exist.

### STF-SMOKE-002: Enqueue valid dry-run job
- Steps:
  1. `stf flash-samsung enqueue --serial <device-serial> --package-ref firmware://sm-t830/xar/u5 --created-by administrator@fakedomain.com`
- Expected:
  - Response `success: true`.
  - Job created with `status: queued`.

### STF-SMOKE-003: Worker processes queued job
- Steps:
  1. `stf flash-samsung worker --provider <provider-name> --execution-mode dry-run --poll-interval 500`
  2. Stop worker after processing.
- Expected:
  - Job transitions to `succeeded`.
  - `result.code = DRY_RUN`.
  - `progress = 100`.

### STF-SMOKE-004: Query job details
- Steps:
  1. `stf flash-samsung get --id <job-id>`
- Expected:
  - Job includes `createdAt`, `updatedAt`, `startedAt`, `finishedAt`.
  - `worker` and `provider` are populated.

### STF-SMOKE-005: List jobs by status
- Steps:
  1. `stf flash-samsung list --status succeeded --limit 20`
- Expected:
  - Returned jobs include completed dry-run.

## 8) Negative and Safety Tests (Current + Planned)

### STF-NEG-001: Enqueue missing serial
- Steps:
  1. `stf flash-samsung enqueue --package-ref firmware://sm-t830/xar/u5`
- Expected:
  - Command fails with required argument message.

### STF-NEG-002: Enqueue missing packageRef
- Steps:
  1. `stf flash-samsung enqueue --serial <device-serial>`
- Expected:
  - Command fails with required argument message.

### STF-NEG-003: Enqueue unknown serial
- Steps:
  1. `stf flash-samsung enqueue --serial UNKNOWN --package-ref firmware://sm-t830/xar/u5`
- Expected:
  - Command fails (`Device not found`).

### STF-NEG-004: Worker non-dry-run mode rejected safely
- Steps:
  1. Enqueue valid job.
  2. Start worker with execution mode that is not dry-run.
- Expected:
  - Job ends `failed`.
  - `result.code = EXECUTOR_NOT_IMPLEMENTED` (until real executor lands).

### STF-NEG-005: Cancel non-cancellable terminal job
- Steps:
  1. Pick a `succeeded` job.
  2. `stf flash-samsung cancel --id <job-id>`
- Expected:
  - Command reports non-cancellable state.

### STF-NEG-006 (planned): Invalid manifest rejected
- Steps:
  1. Submit job with malformed manifest.
- Expected:
  - Fails at `validating`.
  - Actionable error code + details.

### STF-NEG-007 (planned): Model/CSC mismatch rejected
- Steps:
  1. Submit package manifest not matching `SM-T830/XAR/U5`.
- Expected:
  - Job rejected before execution.
  - No flash command invoked.

## 9) Concurrency and Queue Tests

### STF-CON-001: Multiple enqueue ordering
- Steps:
  1. Enqueue 3 jobs with known sequence.
  2. Run one worker.
- Expected:
  - Jobs are claimed FIFO by `createdAt`.

### STF-CON-002: Cancel queued job before claim
- Steps:
  1. Enqueue job.
  2. Cancel before worker starts.
- Expected:
  - Job `status = canceled`.
  - Worker does not process canceled job.

### STF-CON-003: Worker singleton behavior (planned hardening)
- Steps:
  1. Start two workers for same provider.
  2. Enqueue one job.
- Expected:
  - Exactly one claim/processing path.
  - No duplicate execution.

## 10) Phase 2 Executor Tests (mac-dev-local Executed, linux Deferred)

### STF-LNX-001: Linux backend happy path
- Steps:
  1. Run job with `executionBackend=linux-provider`.
  2. Observe prepare -> flashing -> verify states.
- Expected:
  - Device flashes successfully.
  - Progress + logs persisted.
- Status:
  - Deferred (Linux provider-host execution is out of scope for this cycle).

### STF-LNX-002: USB disconnect during flashing
- Steps:
  1. Start flash.
  2. Trigger USB disconnect mid-process.
- Expected:
  - Job fails with explicit error code.
  - Recovery guidance in result details.
- Status:
  - Deferred (Linux provider-host execution is out of scope for this cycle).

### STF-MAC-001: mac dev backend blocked by default
- Steps:
  1. Attempt `executionBackend=mac-dev-local` without global enable flag.
- Expected:
  - Immediate policy rejection.
  - No host command execution.
- Execution result:
  - Passed.
  - Job `00c6f8d28106470a8a5e65d6b156a3fc` failed with `result.code = MAC_DEV_LOCAL_DISABLED`.

### STF-MAC-002: mac dev backend enabled path
- Steps:
  1. Set `STF_FLASH_SAMSUNG_ENABLE_MAC_DEV_LOCAL=true`.
  2. Submit job with `executionBackend=mac-dev-local`.
- Expected:
  - Job executes in dev backend.
  - Job result includes explicit `DEV_ONLY_BACKEND` marker.
- Execution result:
  - Passed.
  - Job `76ef7710ca0d4aeea9647a5ea6e63f2b` succeeded with `result.code = DEV_ONLY_BACKEND`.
  - `logLines` persisted executor status/command output.

### STF-MAC-003: mac dev backend blocked outside dev policy
- Steps:
  1. Use non-dev environment profile.
  2. Submit mac backend job.
- Expected:
  - Policy rejection with clear reason.
- Status:
  - Planned (not run in this pass).

### STF-MAC-004: strict compatibility checks reject CSC mismatch
- Steps:
  1. Submit execute-mode job where `metadata.deviceInfo.csc` does not match manifest target CSC.
- Expected:
  - Job fails before command execution.
  - Explicit `CSC_MISMATCH` result code with expected/actual details.
- Execution result:
  - Passed.
  - Job `ad7c9a1b87c54f7aac9882a3c4d8b7a9` failed with `result.code = CSC_MISMATCH`.

## 11) Phase 3 API/UI Tests (Executed In This Pass)

### STF-API-001: Create job endpoint
- Expected:
  - Returns 201 + job object.
- Execution result:
  - Passed.
  - Controller integration run created a job for `ce0918299bd3963b047e` with `createFlashJob -> 201 true`.

### STF-API-002: Get/list/cancel endpoints
- Expected:
  - Correct status codes and payload schema.
- Execution result:
  - Passed.
  - Controller integration run returned:
    - `listFlashJobs -> 200`
    - `getFlashJob -> 200`
    - `cancelFlashJob -> 200`
    - `getFlashServiceStatus -> 200`
  - Unauthenticated route check returned `401` for:
    - `/api/v1/samsung/flash-jobs`
    - `/api/v1/samsung/flash-service/status`

### STF-UI-001: Maintenance panel action visibility
- Expected:
  - Flash action is visible and routes to an operator workflow entry.
- Execution result:
  - Passed.
  - Samsung service card click now routes to `#!/services/samsung-updater`.

### STF-UI-002: Live progress rendering
- Expected:
  - UI updates by job state and shows terminal outcome.
- Execution result:
  - Passed.
  - Samsung service card polling interval updated to 2s.
  - Dedicated updater page refreshes service status + job list every 2s.

### STF-UI-003: Strong confirmation flows
- Expected:
  - Destructive actions require explicit confirmations.
- Execution result:
  - Passed.
  - Updater page requires destructive confirmation text when `executionMode=execute`.

## 12) Security Test Cases

### STF-SEC-001: Command injection attempt in manifest
- Expected:
  - Blocked by schema/allowlist validation.

### STF-SEC-002: Unauthorized user attempts flash
- Expected:
  - Request requires authentication (`401` unauthenticated).
  - Authenticated users are controlled by non-admin policy gates (environment, backend enable flag, allowlists, destructive confirmation).

### STF-SEC-003: Audit completeness
- Expected:
  - Job stores actor, backend, package reference, result code, timestamps.

## 13) Performance/Capacity Tests (Planned)

### STF-PERF-001: Queue throughput baseline
- Measure:
  - Jobs/min under dry-run and executor modes.

### STF-PERF-002: RethinkDB query latency
- Measure:
  - List/get operations under load.

## 14) Pass Criteria

Phase 1 pass criteria:
- All smoke tests pass.
- Negative tests for missing inputs and safety behavior pass.
- No duplicate claims in queue processing for tested scenarios.

Phase 2 pass criteria:
- Linux backend flashes at least one target device successfully. (Deferred for current cycle)
- Failure scenarios produce actionable error codes.
- mac dev backend obeys all guardrails.

Phase 3 pass criteria:
- API and UI flows functional with authentication and realtime updates.

## 15) Phase 2 Run Record (Executed)

- Run ID: `phase2-mac-dev-local-2026-03-01`
- Date/Time: `2026-03-01`
- Environment: `Docker rethinkdb + STF CLI container (local source mounted)`
- Device serial/model: `phase2-smt830 / SM-T830`
- Cases executed:
  - Dry-run success (`7e890fa3c0c443b5b4fff50db10b4d1e`)
  - `STF-MAC-001` (`00c6f8d28106470a8a5e65d6b156a3fc`)
  - `STF-MAC-002` (`76ef7710ca0d4aeea9647a5ea6e63f2b`)
  - `STF-MAC-004` (`ad7c9a1b87c54f7aac9882a3c4d8b7a9`)
  - `STF-API-001` / `STF-API-002` (controller integration + unauthenticated route checks)
  - `STF-UI-001` / `STF-UI-002` / `STF-UI-003` (route wiring + 2s live refresh + execute confirmation)
- Summary:
  - Phase 2 mac-dev-local backend, guardrails, manifest/checksum validation, and compatibility checks are validated.
  - Linux execution tests remain deferred.

## 16) Test Run Template

Use this template per run:

- Run ID:
- Date/Time:
- Commit SHA:
- Environment: (Env A/B/C)
- Device serial/model:
- Cases executed:
- Passed:
- Failed:
- Blocked:
- Job IDs:
- Log/artifact links:
- Summary:
