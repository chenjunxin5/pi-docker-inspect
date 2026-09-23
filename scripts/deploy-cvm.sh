#!/usr/bin/env bash

# Quick deployment for an Ubuntu/Debian Tencent Cloud CVM.
# Run as a normal login user from any directory; sudo is used when needed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3000}"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
PI_PROVIDER="${PI_PROVIDER:-minimax}"

die() {
  echo "[deploy] error: $*" >&2
  exit 1
}

if [ "$(id -u)" -eq 0 ]; then
  die "do not run this script with sudo; run it as the normal CVM login user"
fi

command -v apt-get >/dev/null 2>&1 \
  || die "this script currently supports Ubuntu/Debian only"

echo "[deploy] installing system packages"
sudo apt-get update
sudo apt-get install -y ca-certificates curl git lsof python3

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
fi

if [ "$node_major" -lt 22 ]; then
  echo "[deploy] installing Node.js 24 LTS with nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash
  fi
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm install 24
  nvm use 24
fi

echo "[deploy] Node.js $(node --version), npm $(npm --version)"

if ! command -v docker >/dev/null 2>&1; then
  echo "[deploy] installing Docker"
  sudo apt-get install -y docker.io
  sudo systemctl enable --now docker
fi

sudo systemctl start docker

if ! id -nG | tr ' ' '\n' | grep -qx docker; then
  echo "[deploy] granting the current user access to Docker"
  sudo usermod -aG docker "$(id -un)"
fi

cd "$ROOT"

echo "[deploy] installing application dependencies"
npm ci --omit=dev
npm install -g @earendil-works/pi-coding-agent
npm run skill:link

auth_file="$HOME/.pi/agent/auth.json"
if ! python3 - "$auth_file" "$PI_PROVIDER" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as file:
        data = json.load(file)
    raise SystemExit(0 if data.get(sys.argv[2], {}).get("key") else 1)
except (FileNotFoundError, json.JSONDecodeError, AttributeError):
    raise SystemExit(1)
PY
then
  read -r -s -p "MiniMax API Key: " pi_key
  echo
  [ -n "$pi_key" ] || die "API Key cannot be empty"
  PI_KEY="$pi_key" PI_PROVIDER="$PI_PROVIDER" ./scripts/setup-pi-auth.sh
  unset pi_key
else
  echo "[deploy] existing PI credentials found; keeping them"
fi

if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q '^Status: active'; then
  echo "[deploy] allowing TCP port $PORT in UFW"
  sudo ufw allow "$PORT/tcp"
fi

export PORT
echo "[deploy] starting docker-logs-agent"
if docker info >/dev/null 2>&1; then
  ./scripts/restart.sh --no-tail
else
  sg docker -c "cd '$ROOT' && PORT='$PORT' ./scripts/restart.sh --no-tail"
fi

curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null \
  || die "health check failed; inspect $ROOT/server.log"

public_ip="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"

echo
echo "[deploy] deployment complete"
echo "[deploy] local health: http://127.0.0.1:$PORT/api/health"
if [ -n "$public_ip" ]; then
  echo "[deploy] browser URL: http://$public_ip:$PORT"
else
  echo "[deploy] browser URL: http://<CVM-public-IP>:$PORT"
fi
echo "[deploy] Tencent Cloud security group must allow inbound TCP $PORT"
echo "[deploy] application log: $ROOT/server.log"
