#!/usr/bin/env bash
#
# setup-projects.sh — clone / fast-forward-pull every project in
# config/projects.json. Idempotent. Never destructive.
#
# Safety rules:
#   - dirty working tree → skip (don't lose local edits)
#   - non-fast-forward pull → skip (don't force-overwrite diverged branches)
#   - missing git → die before doing anything
#
# Usage:
#   ./scripts/setup-projects.sh          # clone / pull all
#   ./scripts/setup-projects.sh <name>   # only one project (matches JSON key)
#
# Wired into setup.sh and restart.sh. Never wired into server start
# (would add a network dependency to the cold-start path).

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/config/projects.json"
ONLY="${1:-}"

if ! command -v git >/dev/null 2>&1; then
  echo "[projects] git not on PATH; nothing to do" >&2
  exit 0
fi
if [ ! -f "$CONFIG" ]; then
  echo "[projects] no $CONFIG — skipping"
  exit 0
fi

# Hand off to Python because parsing + branching + git invocations is too
# awkward in pure bash. Python is already a hard dep of setup.sh.
python3 - "$CONFIG" "$ONLY" <<'PY'
import json, os, subprocess, sys

config_path, only = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(config_path))
except Exception as e:
    print(f"[projects] failed to read {config_path}: {e}", file=sys.stderr)
    sys.exit(0)  # soft-fail: don't break setup.sh / restart.sh

homedir = os.path.expanduser("~")

for name, entry in data.items():
    if only and name != only:
        continue

    # Branch is required (no default fallback — caller must be explicit).
    if "branch" not in entry:
        print(f"[projects] {name}: missing 'branch' field — skipping", file=sys.stderr)
        continue

    raw_path = entry.get("localPath", "")
    if not raw_path:
        print(f"[projects] {name}: missing 'localPath' — skipping", file=sys.stderr)
        continue
    path = os.path.expanduser(raw_path)
    url = entry.get("repo")
    branch = entry["branch"]

    git_dir = os.path.join(path, ".git")

    if not os.path.isdir(git_dir):
        # First-time clone.
        parent = os.path.dirname(path) or "."
        os.makedirs(parent, exist_ok=True)
        print(f"[projects] {name}: cloning {url} → {path}")
        rc = subprocess.call(
            ["git", "clone", "--branch", branch, "--single-branch", url, path],
        )
        if rc != 0:
            print(f"[projects] {name}: clone failed (exit {rc})", file=sys.stderr)
        continue

    # Already cloned — try a fast-forward pull.
    status = subprocess.run(
        ["git", "-C", path, "status", "--porcelain"],
        capture_output=True, text=True,
    )
    if status.stdout.strip():
        print(f"[projects] {name}: working tree dirty — skipping pull "
              f"(commit or stash local changes first)")
        continue

    subprocess.run(["git", "-C", path, "fetch", "--quiet"], check=False)
    rc = subprocess.call(["git", "-C", path, "pull", "--ff-only", "--quiet"])
    if rc == 0:
        head = subprocess.run(
            ["git", "-C", path, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True,
        ).stdout.strip()
        print(f"[projects] {name}: pulled (HEAD {head})")
    else:
        print(f"[projects] {name}: pull --ff-only failed "
              f"(local commits or diverged?) — leaving as-is", file=sys.stderr)
PY