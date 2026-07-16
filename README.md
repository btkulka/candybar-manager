# Candy Bar Manager

Tiny Electron + TypeScript app that organizes and audits your library.

## Setup

```bash
npm install
npm start
```

## How it works

- Organize by Artist reads audio metadata and moves files into artist folders.
- Missing Track Check compares your library against a CSV list and logs gaps.
- Splice sample recovery — re-download missing Splice samples from an old Ableton project. See [docs/splice-recovery.md](docs/splice-recovery.md).

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
