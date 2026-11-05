# Candy Bar Manager

Tiny Electron + TypeScript app that organizes and audits your library, plus a few CLI tools for one-off recovery jobs.

## Download (Mac)

Get the `.dmg` for your Mac from the
[latest release](https://github.com/btkulka/candybar-manager/releases/latest):
**arm64** for Apple silicon, **x64** for Intel. Open it and drag Track Lab onto
Applications. It isn't notarized by Apple yet, so the first time it opens macOS
refuses: click **Done**, then **Open Anyway** in System Settings → Privacy &
Security. After that it offers each new release itself, on launch or from the
arrow in the top bar.

### Releasing

Bump `version` in `package.json`, commit, then push a matching tag
(`git tag v0.2.0 && git push origin v0.2.0`).
[.github/workflows/release.yml](.github/workflows/release.yml) builds both
`.dmg`s with electron-builder ([electron-builder.yml](electron-builder.yml)) and
publishes the release. `npm run dist` builds them locally into `release/`.

## Setup from source

### Mac

The shared packages it links as `file:../packages/*` come from `btkulka/packages`.

```bash
git clone https://github.com/btkulka/candybar-manager.git ~/source/candybar-manager
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

## Profiles

Track Lab can hold several people's data, one profile each: library folders,
SoundCloud/Spotify/store sign-ins, gate email and address, download ledger,
sourcing history and Track Lab's library database. Switch from the profile chip
under the logo or in Settings → Profiles. Switching restarts the app in that
profile. The **default** profile is the one Track Lab opens in. It starts as the
original profile and stays that way until another is made default.

```text
~/Library/Application Support/candybar-manager/              main (the original) + profiles.json + store-bridge.sock
~/Library/Application Support/candybar-manager/profiles/<id>/ every other profile (its own config.json, secrets.json, candybar.db, logs…)
~/.cache/candybar-manager/                                    main's browser sign-ins (SoundCloud, Splice)
…/profiles/<id>/cache/                                        another profile's browser sign-ins
```

Only one Track Lab runs at a time, whichever profile it's in. Processes the app
starts get the profile in their environment (`CANDYBAR_PROFILE`,
`CANDYBAR_USER_DATA`, `CANDYBAR_CACHE_DIR`, `CANDYBAR_PROFILES_ROOT`). The MCP
server and the sourcing CLI otherwise read `profiles.json` for the profile the
app is running. A new profile starts with Rekordbox off, because the Rekordbox
collection on the Mac belongs to whoever set it up. With Rekordbox off,
ownership checks leave the collection out and the Rekordbox-only features
refuse. From Claude Code or Claude Desktop, Claude asks which profile to use
whenever there's more than one (the MCP server's instructions and the
`profiles` tool).

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

## Logs

Track Lab keeps a record of everything it does, where Claude can read it back
to answer "what happened?" and pick up work. All of it is under the app's data
folder:

```text
~/Library/Application Support/candybar-manager/logs/
  main.log            the app's log, debug and up; 10 MB per file, last 5 kept
  mcp.log             the same for the MCP server
  ops/YYYY-MM-DD.jsonl       every operation the app ran
  ops/YYYY-MM-DD.mcp.jsonl   every MCP tool call
  results/            MCP results too big to return inline
```

An **operation** is one piece of work: a window action (source `ui`), an MCP
tool call and the app work it caused (`claude`), a script over the app's socket
(`cli`), a queue job (`job:<type>`), or an app event (`app:start`, `app:quit`,
`window:crashed`). Each is a run of JSON lines sharing an `op` id: `start`
(name, who asked, arguments, parent operation), `label`, `progress` (at most one
a second per channel, the last always kept), `output` (the log panel's lines),
`log` (every logger line written while it ran), and `end` (outcome, duration,
result summary or error). Arguments and results are summarized, and anything
named like a secret is redacted. Every `main.log` line written during an
operation starts with its id, so the two cross-reference. Operations are kept 30
days. Quick reads the window makes constantly (album art, polling) are only
kept when they fail or take longer than 3 seconds.

The MCP tools `app_status`, `list_operations`, `get_operation`, `app_logs` and
`write_journal` read all of this from disk, so they answer even while the app
is closed or after a crash. To read the logs yourself:

```bash
jq -c 'select(.ev=="end" and .outcome=="error")' ~/Library/Application\ Support/candybar-manager/logs/ops/*.jsonl
```

## MCP parity

Everything the app can do, Claude can do over MCP. Every IPC action is
registered with `handleIpc` in `src/main.ts` (which logs it), and the app's
socket runs any of them for the MCP server (`invoke` in `src/lib/storeBridge.ts`
and `src/lib/ipcOps.ts`). [src/lib/mcpParity.ts](src/lib/mcpParity.ts) maps each
action to the MCP tool(s) that do the same thing, or says why it is window-only
(pickers, the store panel's checkout) or internal. `src/lib/__tests__/mcpParity.test.ts`
fails when an action is unmapped, a mapped tool doesn't exist, or a handler is
registered with `ipcMain.handle` directly. When you add an IPC action, add or
extend an MCP tool in `src/mcp-server.ts` that runs it with `runApp`, then list
it in the map.
