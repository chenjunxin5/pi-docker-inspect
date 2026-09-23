#!/usr/bin/env bash
#
# setup.sh — one-shot bootstrap for docker-logs-agent on a fresh checkout.
#
# Idempotent: re-running on an already-set-up machine is a no-op (or just
# re-affirms existing config). Safe to run after `git pull`.
#
# What it does:
#   1. npm install                              node deps
#   2. verify @earendil-works/pi-coding-agent resolves    PI library
#   3. npm run skill:link                        symlink skill to ~/.pi/agent/skills/
#   4. ./scripts/setup-pi-auth.sh               prompt for LLM key (unless already configured)
#   5. ./scripts/setup-projects.sh              clone / pull source repos from config/projects.json
#   6. (optional) ./scripts/restart.sh          start the server
#
# Usage:
#   ./scripts/setup.sh                  # interactive: prompts for key + start
#   ./scripts/setup.sh --no-start       # set up, don't start
#   ./scripts/setup.sh --key <api-key>  # non-interactive key entry
#   PI_KEY=... ./scripts/setup.sh       # same, via env

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NO_START=0
KEY_ARG=""
for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    --key)      shift; KEY_ARG="${1:-}" ;;
    --key=*)    KEY_ARG="${arg#--key=}" ;;
    -h|--help)
      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Pretty section header.
step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
step "1/5 · node deps"
# ---------------------------------------------------------------------------
if [ -d node_modules ] && [ -f node_modules/express/package.json ]; then
  ok "node_modules already present (skipping npm install; run it manually to refresh)"
else
  npm install --no-audit --no-fund
  ok "npm install complete"
fi

# ---------------------------------------------------------------------------
step "2/5 · PI library"
# ---------------------------------------------------------------------------
# The server no longer spawns a `pi` binary; it imports the SDK from
# node_modules. Verify the package is actually installed (npm install step
# above should have ensured this; we re-check in case it was skipped).
if node -e "require.resolve('@earendil-works/pi-coding-agent')" >/dev/null 2>&1; then
  LIB_VER=$(node -e "console.log(require('@earendil-works/pi-coding-agent/package.json').version)" 2>/dev/null || echo unknown)
  ok "@earendil-works/pi-coding-agent resolves (version $LIB_VER)"
else
  die "package '@earendil-works/pi-coding-agent' not installed; run 'npm install' and retry"
fi

# ---------------------------------------------------------------------------
step "3/5 · skill:link"
# ---------------------------------------------------------------------------
SKILL_LINK="$HOME/.pi/agent/skills/docker-logs"
SKILL_SRC="$ROOT/skill"
if [ -L "$SKILL_LINK" ] && [ "$(readlink "$SKILL_LINK")" = "$SKILL_SRC" ]; then
  ok "skill already linked: $SKILL_LINK → $SKILL_SRC"
else
  npm run --silent skill:link
  ok "skill linked: $SKILL_LINK → $SKILL_SRC"
fi

# ---------------------------------------------------------------------------
step "4/5 · LLM provider + key"
# ---------------------------------------------------------------------------
# Quick probe: is auth.json already configured for the default provider?
PROVIDER="${PI_PROVIDER:-minimax}"
AUTH_FILE="$HOME/.pi/agent/auth.json"
NEEDS_KEY=1
if [ -f "$AUTH_FILE" ]; then
  if python3 -c "
import json, sys
try:
    d = json.load(open('$AUTH_FILE'))
    sys.exit(0 if (d.get('$PROVIDER') or {}).get('key') else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
    ok "auth.json already has an entry for '$PROVIDER'"
    NEEDS_KEY=0
  fi
fi

if [ "$NEEDS_KEY" -eq 1 ]; then
  echo
  echo "  Need your LLM API key for provider '$PROVIDER'."
  echo "  It will be written to: $AUTH_FILE (chmod 600)"
  echo "  Endpoint defaults to: https://api.minimax.cn/v1"
  echo
  if [ -n "$KEY_ARG" ]; then
    PI_KEY="$KEY_ARG" ./scripts/setup-pi-auth.sh
  elif [ -n "${PI_KEY:-}" ]; then
    ./scripts/setup-pi-auth.sh
  else
    ./scripts/setup-pi-auth.sh
  fi
  ok "auth.json configured"
else
  echo "  Re-run with PI_KEY=... ./scripts/setup-pi-auth.sh to change."
fi

# ---------------------------------------------------------------------------
# 5/5 · project source repos (optional)
# ---------------------------------------------------------------------------
if [ -f "$ROOT/config/projects.json" ]; then
  step "5/5 · project repos"
  if [ -x "$ROOT/scripts/setup-projects.sh" ]; then
    "$ROOT/scripts/setup-projects.sh" || warn "setup-projects.sh failed; continue anyway"
  else
    warn "scripts/setup-projects.sh not executable; skipping"
  fi
else
  printf '\n\033[2m  (no config/projects.json — skipping project repo sync)\033[0m\n'
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n\033[1;32m✓ setup complete\033[0m\n\n'

cat <<'NEXT'
  Next steps:
    ./scripts/restart.sh           # start the server, tail logs
    open http://localhost:3000     # browser UI

  Or use it from PI directly:
    pi
    > /skill:docker-logs
    > why is my nginx container restarting?

  To start without tailing logs:
    ./scripts/restart.sh --no-tail
NEXT

if [ "$NO_START" -eq 0 ]; then
  printf '\n  Starting the server now (Ctrl-C to detach; server keeps running)...\n\n'
  exec ./scripts/restart.sh
fi