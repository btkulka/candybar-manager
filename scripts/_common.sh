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
