#!/usr/bin/env bash
# Pull the latest Candy Bar Manager from GitHub, rebuild, and (optionally) relaunch.
#
#   scripts/update.sh                 # update in place
#   scripts/update.sh --relaunch      # ...then start the app
#
# The app runs this itself (detached, with --wait-pid <its pid> --relaunch)
# when you click "Update & Restart". Output goes to
# ~/Library/Logs/candybar-manager/update.log in that case.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=_common.sh
. "$REPO_DIR/scripts/_common.sh"

WAIT_PID=""
RELAUNCH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --wait-pid) WAIT_PID="$2"; shift 2 ;;
    --relaunch) RELAUNCH=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() {
  echo "!! $1" >&2
  # When run by the app there's no terminal to read, so surface the failure.
  if [ -n "$WAIT_PID" ]; then
    osascript -e "display alert \"Candy Bar Manager update failed\" message \"$1

Details: ~/Library/Logs/candybar-manager/update.log\" as critical" >/dev/null 2>&1 || true
  fi
  exit 1
}

echo
echo "===== update $(date '+%Y-%m-%d %H:%M:%S') ====="
cd "$REPO_DIR"
candybar_setup_path
candybar_node_ok || fail "Node.js $CANDYBAR_MIN_NODE_MAJOR+ not found on PATH."

if [ -n "$WAIT_PID" ]; then
  echo "==> Waiting for app (pid $WAIT_PID) to exit"
  for _ in $(seq 1 60); do
    kill -0 "$WAIT_PID" 2>/dev/null || break
    sleep 0.5
  done
fi

before="$(git rev-parse HEAD)"
echo "==> Pulling origin/main"
git pull --ff-only origin main || fail "git pull failed (local changes or diverged history). Pull by hand in $REPO_DIR."
after="$(git rev-parse HEAD)"

if [ "$before" = "$after" ]; then
  echo "==> Already up to date"
else
  # New code may lean on newer shared packages, so bring those along first.
  candybar_sync_packages || fail "Updating the shared packages (../packages) failed."
  if ! git diff --quiet "$before" "$after" -- package.json package-lock.json; then
    candybar_build || fail "npm install/build failed."
  else
    candybar_build_only || fail "Build failed."
  fi
fi

echo "==> Now at $(git log -1 --format='%h %s')"
[ "$RELAUNCH" = 1 ] && candybar_launch
echo "==> Done"
