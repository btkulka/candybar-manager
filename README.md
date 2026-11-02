# Candy Bar Manager

Tiny Electron + TypeScript app that organizes and audits your library, plus a few CLI tools for one-off recovery jobs.

## Setup

### Mac

The repo is private, so you need collaborator access and the GitHub CLI signed in
(`brew install gh && gh auth login`). The shared packages it links as
`file:../packages/*` come from the public `btkulka/packages`. Then:

```bash
gh repo clone btkulka/candybar-manager ~/source/candybar-manager
~/source/candybar-manager/scripts/install.sh
```

It checks for the Xcode Command Line Tools, Node 22 (it offers Homebrew), and
Chrome. It clones and builds the shared packages into `~/source/packages`, builds
the app and the MCP server, and can register the MCP server with Claude Code.
Start the app with `npm start`.

On launch the app checks GitHub. When `origin/main` has commits you don't, it
lists them and offers **Update & Restart**, which runs
[scripts/update.sh](scripts/update.sh). You get the manual commands instead when
the checkout has uncommitted edits, local commits, or another branch checked
out. Set `CANDYBAR_SKIP_UPDATE_CHECK=1` to turn the check off; `npm run dev`
never checks.

### Windows

```powershell
# Default: just enough to run the splice-recovery CLI
powershell scripts/install.ps1

# Full app: also build the Electron renderer
powershell scripts/install.ps1 -App

# With rekordbox Python tools
powershell scripts/install.ps1 -Full
```

After install, `npm run dev` for development or `npm start` to preview a production build.

## What's in here

- **`src/`** — the Electron app (main, preload, renderer). Organize-by-artist, library health, missing-track check, store purchases, restore-from-rekordbox.
- **`splice-recover.mjs`** + `lib/` — standalone CLI for re-downloading missing Splice samples from an old `.als` project. See [docs/splice-recovery.md](docs/splice-recovery.md).
- **XML repair scripts** in repo root (`apply-xml-matches.mjs`, `dedupe-xml.mjs`, `find-missing.mjs`, `match-xml-missing.mjs`, `refine-missing.mjs`, `rename-to-xml.mjs`, `xml-scan-missing.mjs`, `audit-present.mjs`) — work against rekordbox export.xml.
- **`scripts/`** — installer, rekordbox Python tools, and legacy one-offs. See [scripts/README.md](scripts/README.md).
- **`tests/e2e/`** — vitest end-to-end suite (`npm run test:e2e`).

## Defaults

- Edit `config.json` for initial defaults.
- Saved defaults are stored in the app's user data directory.

## Write journal

Every destructive file operation (move, delete, ffmpeg conversion, tag rewrite,
AIFC header repair, Rekordbox XML rewrite) is appended to a JSONL journal so
file history can be traced for recovery:

```text
~/Library/Application Support/candybar-manager/write-journal/YYYY-MM.jsonl
```

One JSON object per line: `ts`, `op`, `src`, and where relevant `dest`, `bytes`
(size before the operation), `context` (which feature triggered it, e.g.
`organize`, `archive`, `convert-cleanup`), `outcome` (`ok`/`error`), and
`detail`. Failed operations are journaled too — including the
copied-but-source-not-removed case that leaves a duplicate behind.

Trace a file's history:

```bash
grep 'Artist - Title' ~/Library/Application\ Support/candybar-manager/write-journal/*.jsonl | jq .
```

The MCP server (`candybar-audio-tools`) writes to the same journal. Files are
rotated monthly and never pruned automatically.
