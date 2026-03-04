#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STF_DIR="${STF_DIR:-$SCRIPT_DIR}"
IOS_SUPPORT_DIR="${IOS_SUPPORT_DIR:-$HOME/Projects/STF iOS/stf_ios_support}"
LOG_DIR="${LOG_DIR:-$STF_DIR/tmp/restart-all}"
COMPOSE_FILE="${COMPOSE_FILE:-$STF_DIR/docker-compose.yaml}"
STF_PUBLIC_IP="${STF_PUBLIC_IP:-}"
IOS_PROVIDER_IP="${IOS_PROVIDER_IP:-}"

IOS_COORDINATOR_EVENT_SUB="${IOS_COORDINATOR_EVENT_SUB:-tcp://127.0.0.1:9394}"
IOS_COORDINATOR_EVENT_TOPIC="${IOS_COORDINATOR_EVENT_TOPIC:-devEvent}"
detect_local_ipv4() {
  local iface=""
  local ip=""
  # Prefer a physical/en* interface address over VPN tunnel routes.
  ip="$(ifconfig 2>/dev/null | awk '
    /^[a-zA-Z0-9]+:/{ iface=$1; sub(":", "", iface) }
    /inet /{
      addr=$2
      if (iface ~ /^en[0-9]+$/ && addr !~ /^127\./ && addr !~ /^169\.254\./) {
        print addr
        exit
      }
    }
  ')"
  if [[ -n "$ip" ]]; then
    echo "$ip"
    return
  fi

  iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  if [[ -n "$iface" ]]; then
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  echo "$ip"
}

if [[ -z "$IOS_PROVIDER_IP" ]]; then
  IOS_PROVIDER_IP="$(detect_local_ipv4)"
fi
if [[ -z "$IOS_PROVIDER_IP" ]]; then
  IOS_PROVIDER_IP="127.0.0.1"
fi

if [[ -z "$STF_PUBLIC_IP" ]]; then
  STF_PUBLIC_IP="$IOS_PROVIDER_IP"
fi
if [[ -z "$STF_PUBLIC_IP" ]]; then
  STF_PUBLIC_IP="127.0.0.1"
fi

STF_BASE_URL="http://$STF_PUBLIC_IP:7100/"
STF_WEBSOCKET_URL="http://$STF_PUBLIC_IP:7110/"
STF_AUTH_URL="${STF_BASE_URL}auth/mock/"
STF_DEVICES_URL="${STF_BASE_URL}#!/devices"

if [[ -z "${IOS_SCREEN_WS_URL_PATTERN:-}" ]]; then
  IOS_SCREEN_WS_URL_PATTERN="ws://\${providerIp}:\${videoPort}/echo"
fi
FLASH_SAMSUNG_EXECUTION_MODE="${FLASH_SAMSUNG_EXECUTION_MODE:-dry-run}"
FLASH_SAMSUNG_EXECUTION_BACKEND="${FLASH_SAMSUNG_EXECUTION_BACKEND:-mac-dev-local}"
RETHINKDB_BACKEND="${RETHINKDB_BACKEND:-auto}"
CLEANUP_ATTEMPTS="${CLEANUP_ATTEMPTS:-30}"
CLEANUP_INTERVAL="${CLEANUP_INTERVAL:-0.25}"
STRICT_CLEANUP="${STRICT_CLEANUP:-0}"
POST_START_STABILITY_SECONDS="${POST_START_STABILITY_SECONDS:-8}"
CLEANUP_ISSUES=0

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local attempts="${3:-60}"
  local delay="${4:-0.5}"
  local label="${5:-service}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if (echo >"/dev/tcp/$host/$port") >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  echo "$label did not become ready on $host:$port after $attempts attempts." >&2
  return 1
}

wait_for_pid_stability() {
  local pid="$1"
  local seconds="$2"
  local label="$3"
  local i

  for ((i = 1; i <= seconds; i++)); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "$label exited during post-start stabilization window (${seconds}s)." >&2
      return 1
    fi
    sleep 1
  done
  return 0
}

print_access_urls() {
  echo "  STF base: ${STF_BASE_URL%/}"
  echo "  STF login: ${STF_AUTH_URL%/}"
  echo "  STF devices: $STF_DEVICES_URL"
}

on_restart_exit() {
  local exit_code=$?
  trap - EXIT
  if [[ "$exit_code" -eq 0 ]]; then
    return
  fi
  echo
  echo "Restart ended with errors (exit code: $exit_code)."
  echo "Expected STF access URLs:"
  print_access_urls
  echo "  Logs: $LOG_DIR"
}

trap on_restart_exit EXIT

stop_if_running() {
  local pattern="$1"
  local label="${2:-$pattern}"
  local matches
  local i

  matches="$(pgrep -fal "$pattern" || true)"
  if [[ -z "$matches" ]]; then
    return 0
  fi

  echo "  stopping $label"
  echo "$matches" | sed 's/^/    /'
  pkill -f "$pattern" >/dev/null 2>&1 || true
  for ((i = 1; i <= CLEANUP_ATTEMPTS; i++)); do
    if ! pgrep -f "$pattern" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$CLEANUP_INTERVAL"
  done

  echo "  forcing $label"
  pkill -9 -f "$pattern" >/dev/null 2>&1 || true
  for ((i = 1; i <= CLEANUP_ATTEMPTS; i++)); do
    if ! pgrep -f "$pattern" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$CLEANUP_INTERVAL"
  done

  echo "  warning: $label survived SIGKILL"
  pgrep -fal "$pattern" | sed 's/^/    /' || true
  CLEANUP_ISSUES=1
  return 0
}

clear_stale_pidfiles() {
  local pidfile
  local pid

  for pidfile in "$LOG_DIR/stf-local.pid" "$LOG_DIR/ios-coordinator.pid"; do
    if [[ ! -f "$pidfile" ]]; then
      continue
    fi

    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      echo "  terminating pid from $pidfile ($pid)"
      kill "$pid" >/dev/null 2>&1 || true
      sleep 0.3
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$pidfile"
  done
}

report_cleanup_leftovers() {
  local proc_regex="(ios_video_stream|video_enabler|ivf_pull|ios_video_pull|h264_to_jpeg|stf_device_ios|wdaproxy|runmod\\.js provider|runmod\\.js device-ios|bin/coordinator|ios-deploy -c -t 0)"
  local leftovers
  local port
  local port_pids
  local ports=(7100 7110 7879 8000 8100 9240 9920)

  leftovers="$(pgrep -fal "$proc_regex" || true)"
  if [[ -n "$leftovers" ]]; then
    CLEANUP_ISSUES=1
    echo "Warning: leftover STF/iOS processes after cleanup:"
    echo "$leftovers" | sed 's/^/  /'
  fi

  for port in "${ports[@]}"; do
    port_pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$port_pids" ]]; then
      CLEANUP_ISSUES=1
      echo "Warning: port $port still has listener(s):"
      lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sed 's/^/  /' || true
    fi
  done

  if [[ "$CLEANUP_ISSUES" -eq 1 ]]; then
    if [[ "$STRICT_CLEANUP" == "1" ]]; then
      echo "STRICT_CLEANUP=1 and cleanup left leftovers. Aborting restart." >&2
      exit 1
    fi
    echo "Cleanup completed with warnings. Continuing restart."
  fi
}

cleanup_ios_video_procs() {
  stop_if_running "ios_video_stream" "ios_video_stream"
  stop_if_running "video_enabler" "video_enabler"
  stop_if_running "ivf_pull" "ivf_pull"
  stop_if_running "ios_video_pull" "ios_video_pull"
  stop_if_running "h264_to_jpeg" "h264_to_jpeg"
  stop_if_running "stf_device_ios" "stf_device_ios"
  stop_if_running "wdaproxy" "wdaproxy"
  stop_if_running "ios-deploy -c -t 0" "ios-deploy trigger loop"
  # WDA build/test runners can remain orphaned and block new wdaproxy sessions.
  stop_if_running "xcodebuild.*WebDriverAgent" "xcodebuild WebDriverAgent"
  stop_if_running "WebDriverAgentRunner" "WebDriverAgentRunner"
  stop_if_running "xctest.*WebDriverAgent" "xctest WebDriverAgent"
}

require_cmd node
require_cmd pkill

COMPOSE_CMD=()
if has_cmd docker-compose; then
  COMPOSE_CMD=(docker-compose)
elif has_cmd docker && docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
fi

COMPOSE_USABILITY_ERROR=""
compose_backend_ready() {
  COMPOSE_USABILITY_ERROR=""

  if [[ ${#COMPOSE_CMD[@]} -eq 0 ]]; then
    COMPOSE_USABILITY_ERROR="docker compose command is not available."
    return 1
  fi

  if [[ ! -f "$COMPOSE_FILE" ]]; then
    COMPOSE_USABILITY_ERROR="compose file not found: $COMPOSE_FILE"
    return 1
  fi

  local compose_out=""
  if ! compose_out="$("${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" ps 2>&1)"; then
    compose_out="$(echo "$compose_out" | head -n 1)"
    if [[ -z "$compose_out" ]]; then
      COMPOSE_USABILITY_ERROR="docker compose command failed."
    else
      COMPOSE_USABILITY_ERROR="$compose_out"
    fi
    return 1
  fi

  return 0
}

DB_BACKEND=""
case "$RETHINKDB_BACKEND" in
  local)
    if ! has_cmd rethinkdb; then
      echo "RETHINKDB_BACKEND=local but rethinkdb binary is not installed." >&2
      exit 1
    fi
    DB_BACKEND="local"
    ;;
  docker)
    if ! compose_backend_ready; then
      echo "RETHINKDB_BACKEND=docker but docker compose is not usable." >&2
      echo "Details: $COMPOSE_USABILITY_ERROR" >&2
      echo "Start Docker, or switch to RETHINKDB_BACKEND=local with a local rethinkdb binary." >&2
      exit 1
    fi
    DB_BACKEND="docker"
    ;;
  auto)
    if has_cmd rethinkdb; then
      DB_BACKEND="local"
    elif compose_backend_ready; then
      DB_BACKEND="docker"
    else
      echo "Could not auto-select a working RethinkDB backend." >&2
      echo "Local rethinkdb binary not found, and docker compose is not usable." >&2
      echo "Details: $COMPOSE_USABILITY_ERROR" >&2
      echo "Install rethinkdb, or start Docker and retry." >&2
      exit 1
    fi
    ;;
  *)
    echo "Invalid RETHINKDB_BACKEND: $RETHINKDB_BACKEND (expected: auto|local|docker)" >&2
    exit 1
    ;;
esac

if [[ ! -d "$STF_DIR" || ! -f "$STF_DIR/bin/stf" ]]; then
  echo "Invalid STF_DIR: $STF_DIR" >&2
  exit 1
fi

if [[ ! -d "$IOS_SUPPORT_DIR" || ! -x "$IOS_SUPPORT_DIR/run" ]]; then
  echo "Invalid IOS_SUPPORT_DIR or missing run script: $IOS_SUPPORT_DIR" >&2
  echo "Set IOS_SUPPORT_DIR to your stf_ios_support directory and retry." >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

echo "Expected STF access URLs:"
print_access_urls
echo

echo "Stopping existing local STF/iOS processes..."
clear_stale_pidfiles
stop_if_running "node ./bin/stf local" "stf local"
stop_if_running "/bin/stf local" "stf local"
stop_if_running "stf ios-provider" "stf ios-provider"
stop_if_running "stf flash-samsung worker" "flash-samsung worker"
stop_if_running "$IOS_SUPPORT_DIR/run" "ios coordinator run wrapper"
stop_if_running "bin/coordinator" "ios coordinator"
stop_if_running "runmod.js provider" "ios provider runmod"
stop_if_running "runmod.js device-ios" "ios device runmod"
stop_if_running "bin/osx_ios_device_trigger" "ios device trigger"
cleanup_ios_video_procs
if [[ "$DB_BACKEND" == "local" ]]; then
  stop_if_running "rethinkdb" "rethinkdb"
else
  "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" stop rethinkdb >/dev/null 2>&1 || true
fi
sleep 1
# A second sweep catches orphaned workers that survive the first coordinator shutdown signal.
cleanup_ios_video_procs
sleep 0.5
# A third sweep catches procs that were respawned between the first two passes.
cleanup_ios_video_procs
report_cleanup_leftovers

RETHINKDB_PID=""
RETHINKDB_CONTAINER_ID=""
RETHINKDB_LABEL=""
RETHINKDB_READY_HOST="127.0.0.1"
RETHINKDB_READY_PORT="28015"
if [[ "$DB_BACKEND" == "local" ]]; then
  echo "Starting RethinkDB (local binary)..."
  nohup rethinkdb >"$LOG_DIR/rethinkdb.log" 2>&1 &
  RETHINKDB_PID=$!
  RETHINKDB_LABEL="pid:$RETHINKDB_PID"
else
  echo "Starting RethinkDB (docker compose)..."
  if ! "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" up -d rethinkdb >"$LOG_DIR/rethinkdb.log" 2>&1; then
    echo "Failed to start rethinkdb via docker compose. Check $LOG_DIR/rethinkdb.log" >&2
    exit 1
  fi
  RETHINKDB_CONTAINER_ID="$("${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" ps -q rethinkdb | head -n 1)"
  if [[ -z "$RETHINKDB_CONTAINER_ID" ]]; then
    echo "RethinkDB container ID was not found after docker compose start." >&2
    echo "Check $LOG_DIR/rethinkdb.log" >&2
    exit 1
  fi
  RETHINKDB_BINDING="$("${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" port rethinkdb 28015 2>/dev/null | head -n 1 || true)"
  if [[ -z "$RETHINKDB_BINDING" ]]; then
    echo "RethinkDB port 28015 is not published to host in $COMPOSE_FILE." >&2
    echo "Add a ports mapping for 28015 on the rethinkdb service." >&2
    exit 1
  fi
  RETHINKDB_READY_PORT="$(echo "$RETHINKDB_BINDING" | sed -E 's/^.*:([0-9]+)$/\1/')"
  RETHINKDB_READY_HOST="$(echo "$RETHINKDB_BINDING" | sed -E 's/^([0-9.]+):[0-9]+$/\1/')"
  if [[ "$RETHINKDB_READY_HOST" == "$RETHINKDB_BINDING" || "$RETHINKDB_READY_HOST" == "0.0.0.0" ]]; then
    RETHINKDB_READY_HOST="127.0.0.1"
  fi
  RETHINKDB_LABEL="container:$RETHINKDB_CONTAINER_ID"
fi

echo "Waiting for RethinkDB endpoint tcp://$RETHINKDB_READY_HOST:$RETHINKDB_READY_PORT ..."
if ! wait_for_tcp "$RETHINKDB_READY_HOST" "$RETHINKDB_READY_PORT" 80 0.5 "RethinkDB"; then
  echo "RethinkDB did not become ready. Check $LOG_DIR/rethinkdb.log" >&2
  exit 1
fi

echo "Starting STF local (iOS + Samsung worker enabled)..."
(
  cd "$STF_DIR"
  RETHINKDB_PORT_28015_TCP="tcp://$RETHINKDB_READY_HOST:$RETHINKDB_READY_PORT" nohup node ./bin/stf local \
    --public-ip "$STF_PUBLIC_IP" \
    --app-url "$STF_BASE_URL" \
    --auth-url "$STF_AUTH_URL" \
    --websocket-url "$STF_WEBSOCKET_URL" \
    --ios-storage-url "$STF_BASE_URL" \
    --ios-enable \
    --ios-provider-mode host-bridge \
    --ios-coordinator-event-connect-sub "$IOS_COORDINATOR_EVENT_SUB" \
    --ios-coordinator-event-topic "$IOS_COORDINATOR_EVENT_TOPIC" \
    --ios-screen-ws-url-pattern "$IOS_SCREEN_WS_URL_PATTERN" \
    --enable-flash-samsung \
    --flash-samsung-execution-mode "$FLASH_SAMSUNG_EXECUTION_MODE" \
    --flash-samsung-execution-backend "$FLASH_SAMSUNG_EXECUTION_BACKEND" \
    >"$LOG_DIR/stf-local.log" 2>&1 &
  echo $! >"$LOG_DIR/stf-local.pid"
)
STF_PID="$(cat "$LOG_DIR/stf-local.pid")"

echo "Starting iOS coordinator..."
(
  cd "$IOS_SUPPORT_DIR"
  nohup ./run >"$LOG_DIR/ios-coordinator.log" 2>&1 &
  echo $! >"$LOG_DIR/ios-coordinator.pid"
)
IOS_COORD_PID="$(cat "$LOG_DIR/ios-coordinator.pid")"

sleep 2

if [[ "$DB_BACKEND" == "local" ]]; then
  if ! kill -0 "$RETHINKDB_PID" >/dev/null 2>&1; then
    echo "RethinkDB failed to stay running. Check $LOG_DIR/rethinkdb.log" >&2
    exit 1
  fi
else
  if ! docker inspect -f '{{.State.Running}}' "$RETHINKDB_CONTAINER_ID" 2>/dev/null | grep -q true; then
    echo "RethinkDB container is not running. Check $LOG_DIR/rethinkdb.log" >&2
    exit 1
  fi
fi

if ! kill -0 "$STF_PID" >/dev/null 2>&1; then
  echo "STF local failed to stay running. Check $LOG_DIR/stf-local.log" >&2
  exit 1
fi

if ! kill -0 "$IOS_COORD_PID" >/dev/null 2>&1; then
  echo "iOS coordinator failed to stay running. Check $LOG_DIR/ios-coordinator.log" >&2
  exit 1
fi

if ! wait_for_tcp "127.0.0.1" "7100" 40 0.25 "STF web endpoint"; then
  echo "STF web endpoint failed to come up on 127.0.0.1:7100. Check $LOG_DIR/stf-local.log" >&2
  exit 1
fi

if ! wait_for_pid_stability "$STF_PID" "$POST_START_STABILITY_SECONDS" "STF local"; then
  echo "STF local failed post-start stability check. Check $LOG_DIR/stf-local.log" >&2
  exit 1
fi

if ! wait_for_pid_stability "$IOS_COORD_PID" "$POST_START_STABILITY_SECONDS" "iOS coordinator"; then
  echo "iOS coordinator failed post-start stability check. Check $LOG_DIR/ios-coordinator.log" >&2
  exit 1
fi

echo
echo "Restart complete."
echo "STF access URLs:"
print_access_urls
echo "  RethinkDB ($DB_BACKEND): $RETHINKDB_LABEL"
echo "  RethinkDB endpoint: tcp://$RETHINKDB_READY_HOST:$RETHINKDB_READY_PORT"
echo "  STF local PID: $STF_PID"
echo "  iOS coordinator PID: $IOS_COORD_PID"
echo "  iOS frame provider IP: $IOS_PROVIDER_IP"
echo "  Logs: $LOG_DIR"
echo "  Note: Open STF using the exact host above (do not mix localhost and 127.0.0.1)."
echo
echo "Tail logs with:"
echo "  tail -f \"$LOG_DIR/rethinkdb.log\" \"$LOG_DIR/stf-local.log\" \"$LOG_DIR/ios-coordinator.log\""
