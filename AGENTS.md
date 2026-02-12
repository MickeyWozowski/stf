# AGENTS.md

Practical onboarding notes for contributors learning this STF codebase.

## What this project is

STF (Smartphone Test Farm) manages Android devices over ADB and exposes them through a web UI/API for remote testing and control.

## Build (local source)

### 1) Prerequisites

- Node.js: use `22.11.0` for this repo (`.nvmrc` and `.tool-versions` pin this).
- npm (bundled with Node)
- ADB available in PATH
- RethinkDB
- Native deps used by this repo: ZeroMQ, Protocol Buffers, GraphicsMagick, yasm, pkg-config, cmake

Note: `README.md` still mentions older Node guidance, but current repo configuration and Docker build are on Node 22.

### 2) Install dependencies

```bash
npm install
```

Optional, for direct `stf` CLI command in your shell:

```bash
npm link
```

### 3) Run locally (non-Docker)

Start RethinkDB first:

```bash
rethinkdb
```

Then start STF:

```bash
stf local
```

Alternative if you did not run `npm link`:

```bash
npm run local
```

Default local UI URL: `http://localhost:7100`

## Deployment (local Docker)

This repo already includes `docker-compose.yaml` for a single-host local deployment.

### 1) Review compose values (or override via env)

File: `docker-compose.yaml`

- Defaults are now local-friendly:
  - `STF_PUBLIC_IP=localhost`
  - `STF_ADMIN_EMAIL=administrator@fakedomain.com`
  - `STF_ADMIN_NAME=administrator`
- Override as needed, for example:

```bash
STF_PUBLIC_IP=192.168.1.50 STF_ADMIN_EMAIL=you@example.com STF_ADMIN_NAME='Your Name' docker compose up -d
```

- Confirm mapped ports fit your machine/network:
  - `7100` (main UI)
  - `7110` (websocket)
  - `7400-7500` (provider worker range)

### 2) Start stack

```bash
docker compose up -d
```

### 3) Verify

```bash
docker compose ps
docker compose logs -f stf
```

Open: `http://localhost:7100`

### 4) Stop stack

```bash
docker compose down
```

RethinkDB data persists in the named volume `rethinkdb-data`.

### 5) Important Docker caveats

- USB passthrough is required for real devices (`/dev/bus/usb` mount on the `adb` service).
- `adb` service is `privileged: true` by design in this compose file.
- Linux hosts are the most reliable for device passthrough.

### 6) Retained bring-up notes

- If `--public-ip` (or `STF_PUBLIC_IP`) is wrong, UI redirects to that host and login fails in browser.
- Healthy local response is:
  - `curl -I http://localhost:7100` returns `302` to `/auth/mock/`
  - `curl -I http://localhost:7100/auth/mock/` returns `200`
- On Apple Silicon/arm64 hosts, Docker may warn that `devicefarmer/adb:latest` is `linux/amd64`. Container can still run via emulation, but native multi-arch images are preferable for performance.

## Project structure notes

- `bin/`: executable entrypoint (`bin/stf`)
- `lib/cli/`: CLI command definitions (`stf local`, `stf provider`, `stf api`, etc.)
- `lib/units/`: runtime units/services (app, api, provider, websocket, auth, storage, processor, reaper)
- `lib/db/`: RethinkDB schema/setup helpers
- `lib/wire/`: inter-process wire protocol and routing
- `lib/util/`: shared utilities used across units
- `res/`: frontend/app assets, auth views, web modules, test UI resources
- `vendor/`: bundled binaries/resources (e.g., STFService APK, minirev)
- `docker/`: deployment helpers and architecture-specific Docker assets
- `doc/`: extended docs (`DEPLOYMENT.md`, `API.md`, `VNC.md`, etc.)
- `test/`: unit/integration test utilities

## Fast orientation path for new contributors

1. Read `README.md` for requirements and local run flow.
2. Read `lib/cli/local/index.js` to see how `stf local` composes all units.
3. Read `lib/units/provider/index.js` and `lib/units/device/index.js` for device lifecycle.
4. Read `lib/units/app/` and `lib/units/api/` for UI/API surfaces.
5. Use `docker-compose.yaml` when you need a local containerized environment quickly.
