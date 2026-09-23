#!/usr/bin/env bash
#
# stop.sh — kill the running server (and any stray PI child processes).
#
# Usage:
#   ./scripts/stop.sh           # stop + exit
#   ./scripts/stop.sh --quiet   # exit 0 even if nothing was running
#
# Symmetric with restart.sh: that script kills + starts; this one only kills.
# Use restart.sh to start again afterwards.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

LOG_FILE="${LOG_FILE:-$ROOT/server.log}"
PID_FILE="${PID_FILE:-$ROOT/server.pid}"
PORT="${PORT:-3000}"
QUIET=0
for arg in "$@"; do
  case "$arg" in
    -q|--quiet) QUIET=1 ;;
    -h|--help)
      sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

STOPPED=0

# 1. Saved pid (what restart.sh writes).
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[stop] killing pid $OLD_PID (from $PID_FILE)"
    kill "$OLD_PID" 2>/dev/null || true
    # Give it a moment for the SIGINT handler to kill its PI children.
    for _ in 1 2 3 4 5; do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "[stop] still alive after 1s, sending SIGKILL"
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    STOPPED=1
  fi
  rm -f "$PID_FILE"
fi

# 2. Anything still bound to PORT.
PIDS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "[stop] killing port $PORT holders: $PIDS"
  kill $PIDS 2>/dev/null || true
  sleep 1
  kill -9 $PIDS 2>/dev/null || true
  STOPPED=1
fi

# 3. No child processes to reap in the library-API world (the SDK runs
#    in-process via createAgentSession; no spawned `pi` subprocesses).
#    Kept as a comment marker so the section numbering stays consistent.

if [ "$STOPPED" -eq 0 ]; then
  if [ "$QUIET" -eq 1 ]; then
    exit 0
  fi
  echo "[stop] nothing to stop (no $PID_FILE, nothing on port $PORT, no pi children)"
  exit 1
fi

echo "[stop] done"