#!/usr/bin/env bash
#
# restart.sh — kill any running server and start a fresh one.
#
# Usage:
#   ./scripts/restart.sh          # restart + exit (server keeps running)
#   ./scripts/restart.sh --tail   # restart + tail logs (Ctrl-C to detach)

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_FILE="${LOG_FILE:-$ROOT/server.log}"
PID_FILE="${PID_FILE:-$ROOT/server.pid}"

# 1. Kill anything listening on PORT (default 3000) or with a saved PID.
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[restart] killing pid $OLD_PID"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# Also reap port-bound stragglers.
PORT="${PORT:-3000}"
PIDS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "[restart] killing port $PORT holders: $PIDS"
  kill $PIDS 2>/dev/null || true
  sleep 1
  kill -9 $PIDS 2>/dev/null || true
fi

# 2. Start fresh.
# Resolve npm's absolute path up front: under `sudo` the safe PATH often
# drops node toolchains (nvm, /usr/local/lib/node_modules, ...), so a bare
# `npm start` via nohup fails with "No such file or directory".
NPM_BIN="$(command -v npm 2>/dev/null || true)"
if [ -z "$NPM_BIN" ] && [ -n "${SUDO_USER:-}" ]; then
  NPM_BIN="$(sudo -u "$SUDO_USER" command -v npm 2>/dev/null || true)"
fi
if [ -z "$NPM_BIN" ]; then
  echo "[restart] npm not found in PATH (tried current PATH and \$SUDO_USER's)." >&2
  echo "[restart] hint: install Node.js or invoke this script without sudo." >&2
  exit 1
fi

echo "[restart] starting: $NPM_BIN start  (log → $LOG_FILE)"
: > "$LOG_FILE"
nohup "$NPM_BIN" start > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
NEW_PID=$(cat "$PID_FILE")
echo "[restart] started pid $NEW_PID"

# 3. Wait for /api/health.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo "[restart] ready on http://localhost:$PORT"
    break
  fi
  sleep 0.5
done

# 4. Best-effort sync of source repos in config/projects.json. Never blocks.
if [ -x "$ROOT/scripts/setup-projects.sh" ] && [ -f "$ROOT/config/projects.json" ]; then
  "$ROOT/scripts/setup-projects.sh" || echo "[restart] setup-projects.sh failed (continuing)"
fi

# 4. Optionally tail the log.
if [ "${1:-}" = "--tail" ]; then
  echo "[restart] tailing $LOG_FILE (Ctrl-C to detach; server keeps running)"
  trap 'echo; echo "[restart] detached. server pid=$NEW_PID, log=$LOG_FILE"; exit 0' INT TERM
  tail -f "$LOG_FILE"
fi