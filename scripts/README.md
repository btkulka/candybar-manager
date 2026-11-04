# scripts/

Out-of-tree automation that the Electron app does not import at runtime.

## install.sh (Mac)

Full setup on a Mac. It works from a checkout, or standalone, where it clones into
`$CANDYBAR_DIR` (default `~/source/candybar-manager`) first. In order, it covers:

- the Command Line Tools
- Node 22 (nvm's if the shell's node is older, else it offers Homebrew)
- the shared packages: `btkulka/packages` cloned beside this repo, then
  `npm install` and `npm run build` there under its `.npm-lock`
- `npm ci`, the app build, and the MCP build
- `.venv-rbx/` at the repo root, on the Command Line Tools' `python3`, with
  `requirements-rbx.txt` (pyrekordbox, mutagen) installed: the interpreter the
  app runs its Rekordbox scripts with (`candybar_python_env` in `_common.sh`)
- a clickable **Track Lab** in `/Applications` (or `~/Applications`), with the
  record icon, that starts this checkout (`candybar_make_app` in `_common.sh`).
  The app also makes it once on launch for installs from before it existed, and
  refreshes it after that, but never brings back one that was deleted
- optionally, `claude mcp add`

## update.sh (Mac)

A fast-forward pull of `origin/main`. When that brings anything new, it updates
and rebuilds the shared packages, runs `npm ci` if `package.json` or the lock
changed, and rebuilds. Every run also brings `.venv-rbx/` up to
`requirements-rbx.txt`, creating it if it's missing, so installs from before it
was part of setup get pyrekordbox. A failure there is logged but doesn't stop
the update. `--relaunch` starts the app afterwards. The app runs it
itself, detached, from the **Update & Restart** prompt
(`--wait-pid <pid> --relaunch`), and the log goes to
`~/Library/Logs/candybar-manager/update.log`. `_common.sh` holds what the two
scripts share.

## make-icons.mjs (Mac)

`node scripts/make-icons.mjs` draws the app icon and the sidebar mark from the
record graphic and writes `assets/app-icon.png` (the window and Dock icon),
`assets/AppIcon.icns` (the Applications shortcut) and their SVG sources in
`assets/icon/`. It uses macOS's own `sips` and `iconutil`, so nothing needs
installing. The sidebar's inline copy of the mark is in `index.html`.

## install.ps1

Idempotent setup. Default mode installs npm deps + Playwright Chromium (enough for splice recovery). Flags:

- `-App` also runs `npm run build` (Electron app).
- `-Rbx` also creates `.venv-rbx/` at repo root and installs `requirements-rbx.txt` (pyrekordbox, mutagen) for the rekordbox scripts under `rekordbox/`.
- `-Full` is `-App -Rbx`.
- `-Force` reinstalls even if a target already exists.

## rekordbox/

Python utilities that read and mutate the rekordbox `master.db` via [pyrekordbox](https://github.com/dylanljones/pyrekordbox). They run on the machine that owns the rekordbox library — not this one. Activate `.venv-rbx/` at repo root, then run a script directly:

```
.venv-rbx\Scripts\activate
python scripts/rekordbox/rbx-smoke-read.py
```

Scripts write rollback / report files (`rbx-rollback-*.json`, `rbx-merge-log*.json`, etc.) next to themselves; those globs are gitignored.

| Script | Purpose |
|---|---|
| `rbx-smoke-read.py` | Read-only sanity check: SQLCipher key works, DjmdContent rows read. |
| `rbx-inspect-cues.py` | Print cue-point info for a track. |
| `rbx-find-cued-candidates.py` | Surface duplicates where one side has cues set. |
| `rbx-analyze-dirty-clusters.py` | Cluster-level dedupe analysis. |
| `rbx-audit-losers.py` | Audit which side of each duplicate would lose. |
| `rbx-merge-batch.py` | Batched dedupe merge with rollback log. |
| `rbx-write-single.py` | Rewrite one track's path. Writes a rollback file. |
| `rbx-delete-single.py` | Delete one track. Writes a rollback file. |

Most scripts have hardcoded paths to a JSON report or a target track ID near the top of the file. Edit before running.

## legacy/

Older one-off scripts kept for reference but no longer in any active workflow:

- `_probe_main.js` — one-liner that lists Electron's exported APIs.
- `copy-missing.mjs`, `copy-onhold.mjs` — early library-rebuild copy passes.
- `filter-review.mjs` — filtered an XML review list.
- `qobuz-login-watch.mjs` — watched a Qobuz login flow during recon.

Nothing here is imported by the running app. Cherry-pick from git history if you ever need one again.
