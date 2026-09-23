#!/usr/bin/env bash
#
# setup-pi-auth.sh — register the user's minimax endpoint as a custom PI
# provider, then scaffold ~/.pi/agent/auth.json with the matching key.
#
# Why two files:
#   ~/.pi/agent/models.json — overrides the built-in `minimax` provider so its
#                             baseUrl points at https://api.minimax.cn/v1
#                             instead of the built-in api.minimax.io.
#   ~/.pi/agent/auth.json   — holds the API key under that provider name.
#
# Idempotent: existing providers (anthropic, google, …) are left untouched,
# and re-running with a new key only updates the `minimax` entry.
#
# Usage:
#   ./scripts/setup-pi-auth.sh                    # interactive key prompt
#   PI_KEY=... ./scripts/setup-pi-auth.sh         # non-interactive
#   PI_PROVIDER=minimax PI_MODEL=MiniMax-M2.7 \
#     PI_BASE_URL=https://api.minimax.cn/v1 \
#     ./scripts/setup-pi-auth.sh                  # override endpoint

set -eu

PI_PROVIDER="${PI_PROVIDER:-minimax}"
PI_MODEL="${PI_MODEL:-MiniMax-M2.7}"
PI_BASE_URL="${PI_BASE_URL:-https://api.minimax.cn/v1}"

AGENT_DIR="$HOME/.pi/agent"
MODELS_FILE="$AGENT_DIR/models.json"
AUTH_FILE="$AGENT_DIR/auth.json"

mkdir -p "$AGENT_DIR"

# Collect key from arg, env, or prompt.
if [ -z "${PI_KEY:-}" ]; then
  echo "Enter the API key for provider '$PI_PROVIDER' (input hidden):"
  printf "key> "
  stty -echo 2>/dev/null || true
  read -r PI_KEY
  stty echo 2>/dev/null || true
  echo
fi

if [ -z "$PI_KEY" ]; then
  echo "no key provided — aborting" >&2
  exit 1
fi

# Single Python pass: update both models.json and auth.json so we don't
# round-trip through the shell. Each file is treated independently —
# failures in one don't corrupt the other.
python3 - "$MODELS_FILE" "$AUTH_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_BASE_URL" "$PI_KEY" <<'PY'
import json, os, sys

models_path, auth_path, provider, model, base_url, key = sys.argv[1:7]

# ---- models.json: override the provider's catalog ----
try:
    with open(models_path) as f:
        mdata = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    mdata = {}

if not isinstance(mdata, dict):
    mdata = {}
mdata.setdefault("providers", {})
mdata["providers"][provider] = {
    # `api: openai-completions` matches the user's OpenAI-compatible endpoint.
    # The built-in `minimax` provider pointed at api.minimax.io (Anthropic-flavored)
    # — this override redirects it.
    "baseUrl": base_url,
    "api": "openai-completions",
    "apiKey": key,  # fallback if auth.json lookup fails
    "models": [
        # 自定义模型必须声明支持推理，否则 PI 会把 low/high 自动降为 off。
        {"id": model, "name": model, "reasoning": True},
    ],
}

with open(models_path, "w") as f:
    json.dump(mdata, f, indent=2)
    f.write("\n")
os.chmod(models_path, 0o600)

# ---- auth.json: PI reads this with priority over env ----
try:
    with open(auth_path) as f:
        adata = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    adata = {}

if not isinstance(adata, dict):
    adata = {}
entry = adata.get(provider, {})
entry["type"] = "api_key"
entry["key"] = key
adata[provider] = entry

with open(auth_path, "w") as f:
    json.dump(adata, f, indent=2)
    f.write("\n")
os.chmod(auth_path, 0o600)

print(f"wrote {models_path}")
print(f"  providers.{provider}.baseUrl = {base_url}")
print(f"  providers.{provider}.models  = [{model}]")
print()
print(f"wrote {auth_path}")
print(f"  {provider}.type = api_key")
print(f"  {provider}.key  = ({len(key)} chars)")
PY

echo
echo "done. restart the server with:  ./scripts/restart.sh"
