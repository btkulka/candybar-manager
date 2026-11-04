#!/usr/bin/env bash
# Install Candy Bar Manager on a Mac.
#
# From a checkout:   ./scripts/install.sh
# Standalone:        bash install.sh      (clones into $CANDYBAR_DIR first)
#
# btkulka/candybar-manager is private: you need collaborator access and to be
# signed in with the GitHub CLI (`gh auth login`) or git credentials. The
# shared packages it links, btkulka/packages, are public and get cloned
# beside it into ~/source/packages.
#
# Env:
#   CANDYBAR_DIR   where to clone (default ~/source/candybar-manager)
set -euo pipefail

REPO_SLUG="btkulka/candybar-manager"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m!!  %s\033[0m\n' "$1"; }
die()  { printf '\033[31mxx  %s\033[0m\n' "$1" >&2; exit 1; }
ask()  { local r; read -r -p "$1 [y/N] " r </dev/tty || true; [[ "$r" =~ ^[Yy] ]]; }

[ "$(uname -s)" = "Darwin" ] || die "Candy Bar Manager only supports macOS."

# --- Xcode Command Line Tools (git + compiler for native modules) ---
if ! xcode-select -p >/dev/null 2>&1; then
  say "Installing Xcode Command Line Tools"
  xcode-select --install || true
  die "Finish the Command Line Tools installer that just opened, then re-run this script."
fi

# --- Get the code (standalone mode) ---
if [ -f "$SCRIPT_DIR/_common.sh" ] && [ -d "$SCRIPT_DIR/../.git" ]; then
  REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  REPO_DIR="${CANDYBAR_DIR:-$HOME/source/candybar-manager}"
  if [ -d "$REPO_DIR/.git" ]; then
    say "Using existing checkout at $REPO_DIR"
  else
    say "Cloning $REPO_SLUG into $REPO_DIR"
    mkdir -p "$(dirname "$REPO_DIR")"
    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
      gh repo clone "$REPO_SLUG" "$REPO_DIR"
    else
      git clone "https://github.com/$REPO_SLUG.git" "$REPO_DIR" \
        || die "Clone failed. The repo is private: ask Ben for access, then run 'gh auth login' (brew install gh) and retry."
    fi
  fi
  # Runs the checkout's own copy, which has _common.sh beside it.
  exec bash "$REPO_DIR/scripts/install.sh"
fi

cd "$REPO_DIR"
# shellcheck source=_common.sh
. "$REPO_DIR/scripts/_common.sh"
candybar_setup_path

# --- Node.js ---
if ! candybar_node_ok; then
  have="$(node -v 2>/dev/null || echo none)"
  warn "Node.js $CANDYBAR_MIN_NODE_MAJOR+ is required (found: $have)."
  if ! command -v brew >/dev/null 2>&1 && ask "Homebrew (brew.sh) is the easy way to get Node. Install Homebrew?"; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/null
    if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; else eval "$(/usr/local/bin/brew shellenv)"; fi
  fi
  if command -v brew >/dev/null 2>&1 && ask "Install Node.js 22 with Homebrew?"; then
    brew install node@22
    brew link --overwrite --force node@22
    export PATH="$(brew --prefix node@22)/bin:$PATH"
    hash -r
  fi
  candybar_node_ok || die "Install Node.js $CANDYBAR_MIN_NODE_MAJOR+ (https://nodejs.org or 'brew install node@22'), then re-run."
fi
echo "Node $(node -v), npm $(npm -v)"

# --- Google Chrome (store sign-in/carts drive the real Chrome) ---
if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "$HOME/Applications/Google Chrome.app" ]; then
  warn "Google Chrome not found. Beatport/Qobuz features need it: https://www.google.com/chrome/"
fi

# --- Shared packages (must exist before npm ci resolves file:../packages/*) ---
say "Fetching and building the shared packages"
candybar_sync_packages \
  || die "Couldn't set up the shared packages in ~/source/packages (see above), then re-run."

# --- Build ---
say "Building Candy Bar Manager (first run takes a few minutes)"
candybar_build

# --- Applications shortcut ---
say "Adding Track Lab to Applications"
candybar_make_app

# --- Optional: Claude Code MCP server ---
if command -v claude >/dev/null 2>&1 && ask "Register the candybar-audio-tools MCP server with Claude Code?"; then
  claude mcp add candybar-audio-tools -s user -- node "$REPO_DIR/dist/mcp/mcp-server.js" \
    || warn "MCP registration failed; you can retry later with the same 'claude mcp add' command."
fi

say "Installed to $REPO_DIR"
cat <<EOF
Open Track Lab from Applications, Launchpad or Spotlight like any other app.
Or from Terminal:
  cd "$REPO_DIR" && npm start

The app checks GitHub on launch and offers "Update & Restart" when a newer
version is out. To update by hand:  "$REPO_DIR/scripts/update.sh"

First run: open Settings and point the Library / organize folders at your own
drive.
EOF

if ask "Launch it now?"; then
  candybar_launch
fi
