# Shared helpers for install.sh / update.sh. Sourced, not executed.

# Apps launched from Finder/Dock (or the updater, spawned from the app) get a
# bare PATH without Homebrew or nvm, so find node/npm ourselves. Homebrew goes
# last so a node the shell already chose wins; if that's too old, nvm's 22.
candybar_setup_path() {
  export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
  if ! candybar_node_ok && [ -s "$HOME/.nvm/nvm.sh" ]; then
    # nvm isn't safe under set -eu, which both callers use.
    set +eu
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
    nvm use "$CANDYBAR_MIN_NODE_MAJOR" >/dev/null 2>&1
    set -eu
  fi
}

# .nvmrc and the shared packages' engines both say 22. Electron's installer
# also fails on older 20.x (it require()s an ES module).
CANDYBAR_MIN_NODE_MAJOR=22

candybar_node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  [ "$major" -ge "$CANDYBAR_MIN_NODE_MAJOR" ]
}

# Clone a btkulka repo: the gh CLI's sign-in if there is one, else git's.
candybar_clone() { # owner/repo dir
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo clone "$1" "$2"
  else
    git clone "https://github.com/$1.git" "$2"
  fi
}

# The shared packages (Benhäus's BPM) that package.json links as
# file:../packages/<name>. They sit beside this repo, the same ~/source layout
# Benhäus uses, and build into dist/, which isn't committed, so every install
# and update builds them. Needs REPO_DIR.
CANDYBAR_PACKAGES_REPO="btkulka/packages"

candybar_sync_packages() {
  local dir rc=0
  dir="$(cd "$REPO_DIR/.." && pwd)/packages"
  if [ -d "$dir/.git" ]; then
    echo "==> Updating shared packages in $dir"
    git -C "$dir" pull --ff-only origin main \
      || echo "!! $dir has local changes or a diverged branch; building it as it is."
  else
    echo "==> Cloning shared packages into $dir"
    candybar_clone "$CANDYBAR_PACKAGES_REPO" "$dir" || return 1
  fi
  # packages/README: one npm install there at a time, guarded by .npm-lock.
  local tries=0
  until mkdir "$dir/.npm-lock" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 150 ] || { echo "!! $dir/.npm-lock held for 5 minutes; remove it if nothing is installing."; return 1; }
    sleep 2
  done
  (cd "$dir" && npm install --no-fund --no-audit && npm run build) || rc=$?
  rmdir "$dir/.npm-lock"
  return $rc
}

# Install deps, build the app and the MCP server.
candybar_build() {
  echo "==> Installing dependencies (npm ci)"
  npm ci
  candybar_build_only
}

candybar_build_only() {
  echo "==> Building app"
  npm run build
  echo "==> Building MCP server"
  npm run build:mcp
}

# Start the app detached from this shell (survives the terminal closing).
candybar_launch() {
  local log_dir="$HOME/Library/Logs/candybar-manager"
  mkdir -p "$log_dir"
  echo "==> Launching Candy Bar Manager"
  nohup npm start -- --skipBuild >>"$log_dir/app-stdout.log" 2>&1 &
  disown || true
}

# A clickable "Track Lab" in Applications (and so Launchpad and Spotlight) with
# the record icon. It holds no code of its own: it starts this checkout through
# candybar_launch, so updates never leave it stale. Rewritten when its stamp
# (checkout path + icon) changes, and never written over another app of the
# same name. --refresh-only updates one that's there but never makes one: the
# app runs it that way on launch, so a Track Lab someone deleted stays deleted.
# CANDYBAR_APPS_DIR overrides /Applications (for trying it out). Needs REPO_DIR.
CANDYBAR_APP_NAME="Track Lab"
CANDYBAR_APP_ID="com.btkulka.tracklab.launcher"

candybar_make_app() {
  local refresh_only=0 apps app stamp id tmp
  [ "${1:-}" = "--refresh-only" ] && refresh_only=1
  local icon="$REPO_DIR/assets/AppIcon.icns"
  [ -f "$icon" ] || { echo "!! $icon is missing, so there's no Applications shortcut."; return 0; }
  apps="${CANDYBAR_APPS_DIR:-/Applications}"
  [ -w "$apps" ] || apps="$HOME/Applications"
  app="$apps/$CANDYBAR_APP_NAME.app"
  stamp="$REPO_DIR $(shasum "$icon" | cut -c1-12)"
  if [ -d "$app" ]; then
    id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null || true)"
    [ "$id" = "$CANDYBAR_APP_ID" ] || { echo "!! $app isn't Track Lab's shortcut; leaving it alone."; return 0; }
    [ "$(cat "$app/Contents/Resources/stamp" 2>/dev/null || true)" = "$stamp" ] && return 0
  elif [ "$refresh_only" = 1 ]; then
    return 0
  fi

  mkdir -p "$apps"
  tmp="$apps/.$CANDYBAR_APP_NAME.app.$$"
  rm -rf "$tmp"
  mkdir -p "$tmp/Contents/MacOS" "$tmp/Contents/Resources"
  cp "$icon" "$tmp/Contents/Resources/AppIcon.icns"
  printf '%s' "$stamp" >"$tmp/Contents/Resources/stamp"
  cat >"$tmp/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$CANDYBAR_APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$CANDYBAR_APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$CANDYBAR_APP_ID</string>
  <key>CFBundleExecutable</key><string>track-lab</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!-- Starts the app and exits; the app itself shows in the Dock. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
  {
    printf '#!/bin/bash\n# Starts Track Lab from its checkout. Written by scripts/_common.sh (candybar_make_app).\n'
    printf 'REPO_DIR=%q\n' "$REPO_DIR"
    cat <<'EOF'
alert() { osascript -e "display alert \"Track Lab can't open\" message \"$1\" as critical" >/dev/null 2>&1; }
if [ ! -f "$REPO_DIR/scripts/_common.sh" ]; then
  alert "Its files aren't in $REPO_DIR any more. Run its install script again."
  exit 1
fi
. "$REPO_DIR/scripts/_common.sh"
set -eu
candybar_setup_path
candybar_node_ok || { alert "It needs Node.js $CANDYBAR_MIN_NODE_MAJOR or newer. Run its install script again to set that up."; exit 1; }
[ -f "$REPO_DIR/dist/main/main.js" ] || { alert "It hasn't been built yet. Run its install script again."; exit 1; }
cd "$REPO_DIR"
candybar_launch
EOF
  } >"$tmp/Contents/MacOS/track-lab"
  chmod +x "$tmp/Contents/MacOS/track-lab"
  rm -rf "$app"
  mv "$tmp" "$app"
  # Finder and the Dock cache icons; make them read this one.
  touch "$app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" >/dev/null 2>&1 || true
  echo "==> Track Lab is in $apps: open it from there, Launchpad or Spotlight"
}
