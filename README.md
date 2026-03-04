
**STF** (or Smartphone Test Farm) is a web application for debugging smartphones, smartwatches and other gadgets remotely, from the comfort of your browser.

## Overview

![Close-up of device shelf](https://raw.githubusercontent.com/DeviceFarmer/stf/master/doc/shelf_closeup_790x.jpg)

![Super short screencast showing usage](https://raw.githubusercontent.com/DeviceFarmer/stf/master/doc/7s_usage.gif)

## Fork-specific changes from vanilla DeviceFarmer STF

This fork keeps Android behavior from upstream STF and adds an experimental iOS path that is disabled by default unless explicitly enabled.

### What was added in this fork

* New iOS provider command:
  - `stf ios-provider` (`lib/cli/ios-provider/index.js`)
  - runtime unit (`lib/units/ios-provider/index.js`)
* `stf local` iOS flags:
  - `--ios-enable`
  - `--ios-provider-mode` (`disabled` or `host-bridge`)
  - `--ios-coordinator-event-connect-sub` and `--ios-coordinator-event-topic`
  - `--ios-storage-url`, `--ios-ios-deploy-path`, `--ios-xcode-developer-dir`, `--ios-wda-host`
* Control-plane wiring for iOS device identity/actions (wire/websocket/API path updates).
* iOS actions currently wired in STF:
  - lifecycle from coordinator events (`connect/present/heartbeat/disconnect`)
  - touch/home/type via WDA when WDA is available
  - app install (`.ipa`), uninstall, launch-by-bundle-id
  - screenshot capture and upload path for iOS devices
* UI update:
  - install pane now includes iOS launch-by-bundle-id action.
* Storage reliability hardening:
  - image storage plugin now preserves `Content-Type` from blob retrieval.
  - if neither GraphicsMagick nor ImageMagick is installed, image responses degrade to source passthrough instead of broken screenshot output.
* iOS provider-side screenshot capture path was updated in the companion iOS support repo (`stf_ios_support`) with `idevicescreenshot` and WDA fallback behavior.
* Samsung flash workflow (MVP scaffolding and guarded execution path):
  - new CLI command `stf flash-samsung` with actions: `worker`, `enqueue`, `list`, `get`, `cancel`.
  - `stf local` worker flags: `--enable-flash-samsung`, `--flash-samsung-execution-mode`, `--flash-samsung-execution-backend`, and policy guardrail options.
  - new DB-backed `flashJobs` workflow for queueing, status, logs, and cancellation.
  - REST API surface under `/api/v1/samsung/flash-jobs` and `/api/v1/samsung/flash-service/status`.
  - websocket actions for enqueue/status and UI integration in maintenance and the Samsung updater service view.
  - safety defaults to non-destructive mode (`dry-run` by default), with explicit opt-in guardrails for execute mode.

### What remains different from full Android parity

* iOS still requires a companion macOS stack (`stf_ios_support`) for coordinator/video/WDA orchestration.
* Full right-panel parity is not complete; Android-only controls are still unsupported for iOS.
* iOS in this fork is still marked experimental.
* Samsung flashing execution flow is intentionally guarded and currently centered on controlled lab workflows.

Current implementation notes and rollout status are tracked in [doc/IOS_SUPPORT_PORT_PLAN.md](doc/IOS_SUPPORT_PORT_PLAN.md).
Samsung workflow references:
* [doc/SAMSUNG_FLASHING_WORKFLOW_PLAN.md](doc/SAMSUNG_FLASHING_WORKFLOW_PLAN.md)
* [doc/SAMSUNG_FLASHING_TEST_PLAN.md](doc/SAMSUNG_FLASHING_TEST_PLAN.md)
