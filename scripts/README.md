# scripts/

Out-of-tree automation that the Electron app does not import at runtime.

## install.ps1

Idempotent setup. Default mode installs npm deps + Playwright Chromium (enough for splice recovery). Flags:

- `-App` also runs `npm run build` (Electron app).
- `-Rbx` also creates `.venv-rbx/` at repo root and installs `pyrekordbox` for the rekordbox scripts under `rekordbox/`.
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
