#!/bin/sh
# Manage the desktop UI, mobile listeners, and trading worker together.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PATH="$PWD/.tools/node/bin:$PATH"
umask 077
pid_file="$PWD/us_stocks/.varshan-node.lock/pid"
log_file="$PWD/.local/varshan.log"
web_url="http://127.0.0.1:${PORT:-8000}"

usage() {
  echo 'Usage: sh web.sh {start|stop|restart|status}'
  echo 'Start/restart runs in the background; logs: .local/varshan.log'
}

# Return 0 for this server, 1 when stopped, and 2 when identity cannot be verified.
inspect_server() {
  [ -f "$pid_file" ] || return 1
  server_pid=$(cat "$pid_file")
  case "$server_pid" in
    ''|*[!0-9]*|0|1) echo 'Invalid server PID; refusing to manage it.' >&2; return 2 ;;
  esac
  process_list=$(ps -axo pid=,args=) || {
    echo 'Could not inspect processes; check process permissions.' >&2
    return 2
  }
  server_command=$(printf '%s\n' "$process_list" | awk -v target="$server_pid" '$1 == target {$1=""; sub(/^ +/, ""); print}')
  [ -n "$server_command" ] || return 1
  case "$server_command" in
    *node*' server/dist/src/index.js'|*node*" $PWD/server/dist/src/index.js") ;;
    *) echo 'Saved PID is not the Varshan server; refusing to manage it.' >&2; return 2 ;;
  esac
  if ! command -v lsof >/dev/null 2>&1; then
    echo 'lsof is required to verify the server workspace.' >&2
    return 2
  fi
  server_cwd=$(lsof -a -p "$server_pid" -d cwd -Fn | sed -n 's/^n//p')
  if [ "$server_cwd" != "$PWD" ]; then
    echo 'Saved PID belongs to another workspace; refusing to manage it.' >&2
    return 2
  fi
}

status() {
  if inspect_server; then
    echo "Varshan is running (PID $server_pid)."
    if curl --max-time 3 -fsS "$web_url/api/health" > /dev/null 2>&1; then
      echo "Web page is healthy: $web_url"
      return 0
    fi
    echo "Web page is not responding at $web_url. Check $log_file and any custom PORT setting." >&2
    return 2
  else
    result=$?
    [ "$result" = 1 ] && echo 'Varshan is stopped.'
    return "$result"
  fi
}

preflight() {
  for required in node npm curl; do
    if ! command -v "$required" >/dev/null 2>&1; then
      echo "Missing required command: $required. No server was stopped." >&2
      exit 1
    fi
  done
  node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22 || major===22 && minor<12) throw new Error("Node.js 22.12+ is required"); const port=Number(process.env.PORT ?? 8000); if(!Number.isInteger(port) || port<1 || port>65535) throw new Error("PORT must be between 1 and 65535")'
}

serve() {
  preflight
  if [ ! -d server/node_modules ]; then npm ci --prefix server; fi
  if [ ! -d frontend/node_modules ]; then npm ci --prefix frontend; fi
  if [ "${VARSHAN_MOBILE:-1}" != 0 ]; then node scripts/mobile-tls.mjs; fi
  node scripts/build-touch-id.mjs
  npm run build --prefix server
  npm run build --prefix frontend
  exec node server/dist/src/index.js "$@"
}

stop() {
  if inspect_server; then
    echo "Stopping Varshan (PID $server_pid)…"
    kill -TERM "$server_pid"
    attempt=0
    while kill -0 "$server_pid" 2>/dev/null; do
      attempt=$((attempt + 1))
      if [ "$attempt" -ge 30 ]; then
        echo 'Shutdown is still in progress; no force-kill was sent. Check sh web.sh status.' >&2
        return 1
      fi
      sleep 1
    done
    echo 'Varshan stopped.'
  else
    result=$?
    [ "$result" = 1 ] || return "$result"
    echo 'Varshan is already stopped.'
  fi
}

start() {
  if inspect_server; then
    echo 'Varshan is already running; use restart to rebuild it.'
    status
    return
  else
    result=$?
    [ "$result" = 1 ] || return "$result"
  fi
  touch "$log_file"
  chmod 600 "$log_file"
  echo "Starting Varshan; build and server output: $log_file"
  launch_pid=$(node --input-type=module -e '
    import { spawn } from "node:child_process";
    import { openSync, closeSync } from "node:fs";
    const log = openSync(".local/varshan.log", "a", 0o600);
    const child = spawn("/bin/sh", ["./web.sh", "_serve"], {
      cwd: process.cwd(), detached: true, stdio: ["ignore", log, log],
    });
    child.on("error", error => { console.error(error.message); process.exitCode = 1; });
    child.on("spawn", () => { console.log(child.pid); child.unref(); closeSync(log); });
  ')
  attempt=0
  while [ "$attempt" -lt 90 ]; do
    if ! kill -0 "$launch_pid" 2>/dev/null; then
      echo "Varshan exited during startup. Check $log_file." >&2
      tail -n 20 "$log_file" >&2
      return 1
    fi
    if [ -f "$pid_file" ] && [ "$(cat "$pid_file")" = "$launch_pid" ] &&
      curl --max-time 2 -fsS "$web_url/api/health" > /dev/null 2>&1; then
      echo "Varshan is ready: $web_url (PID $launch_pid)."
      echo 'Automatic trading restores its saved on/off choice within the original session expiry.'
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "Startup is taking longer than expected. Check $log_file and sh web.sh status before starting again." >&2
  return 1
}

command=${1:-help}
case "$command" in
  help|--help|-h) usage; exit 0 ;;
  _serve) shift; serve "$@" ;;
  start|stop|restart|status) [ "$#" = 1 ] || { usage >&2; exit 2; } ;;
  *) usage >&2; exit 2 ;;
esac
if [ "$command" = status ]; then status; exit $?; fi
if [ "$command" != stop ]; then preflight; fi
mkdir -p .local
if ! mkdir .local/web.lock 2>/dev/null; then
  echo 'Another web command is in progress. Check .local/web.lock if an earlier command was interrupted.' >&2
  exit 1
fi
trap 'rmdir .local/web.lock 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
case "$command" in
  start) start ;;
  stop) stop ;;
  restart)
    if inspect_server; then
      node scripts/preserve-automation.mjs
    else
      result=$?
      [ "$result" = 1 ] || exit "$result"
    fi
    stop
    start
    ;;
esac
