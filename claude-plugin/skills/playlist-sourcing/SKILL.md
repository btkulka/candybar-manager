---
name: playlist-sourcing
description: Source a playlist or your SoundCloud likes, or upgrade a Rekordbox playlist's MP3s to lossless — find which tracks aren't already in Rekordbox and where to get each one lossless. Takes a Spotify playlist URL, one of your own private playlists (walked through the Spotify desktop app), or any CSV (Exportify, a typed list); checks it against Rekordbox, searches Beatport and Qobuz, publishes a review page, records your verdicts, and can fill the real Beatport and Qobuz carts. For SoundCloud it walks your likes or a SoundCloud set (playlist), fetches the free downloads (native button or Hypeddit-style gates) into the intake folder and quarantines anything lossy. Use for "source this playlist", "what do I need to buy from this set", "check this playlist against my library", "build me a cart", "add this playlist to my library", "fill my Beatport/Qobuz cart", "re-review that sourcing session", "grab the free downloads from my likes", "source this soundcloud set/playlist", "upgrade this playlist to lossless", "find lossless copies of my MP3s", or a pasted Spotify playlist link plus "what's missing". Same rules as Track Lab's Find & buy and Upgrade quality, which also load this skill for their "Review with Claude".
---

# Playlist sourcing

Turn a playlist into a buy list: what is already in the collection, what is genuinely missing, and a lossless purchase link for each missing track — Beatport first, Qobuz where Beatport can't deliver.

The engine is `$TRACK_LAB_ROOT/lib/sourcing/` (plain Node, no build step; see **Paths** below). This skill drives it and owns the judgment calls, and the judgment is where the value is: in the October 2026 run the engine put 18 tracks in "probable" and every one of them was a duplicate, while three perfect-scoring store links pointed at the wrong record. The machine narrows; you decide.

**Paths.** `$TRACK_LAB_ROOT` is Track Lab's code: the engine (`lib/sourcing/`) and its CLIs (`bin/`). Track Lab sets it when it runs this skill; in a terminal session it's the candybar-manager checkout (`export TRACK_LAB_ROOT=~/source/candybar-manager` if it isn't set). `$SKILL` is this skill's own folder (Claude Code shows it as the skill's base directory). `$WORK` is a scratch folder: your scratchpad, or the current folder when Track Lab runs you. `node` is whatever is on PATH — real Node in a terminal, Track Lab's own runtime when the app runs you.

## Whose profile

Track Lab keeps each person's data in a **profile**: library folders, SoundCloud/Spotify/store sign-ins, the email gates get, the download ledger and history. The engine and the MCP tools use the profile Track Lab is running.

- **From Claude Code or Claude Desktop:** before anything that reads or writes a profile's data, call the MCP `profiles` tool with `list`. If there's more than one profile, **always ask which profile to use**, even when the running one looks right, then `switch` to it if it isn't the one running. Running as the wrong person follows artists, sends gate emails and fills carts from the wrong accounts.
- **Inside a Track Lab job** (below), don't ask: the job already belongs to the profile the app is running.

## When Track Lab runs you

Track Lab's own Claude jobs load this skill: "Review with Claude" on Find & buy, and on Upgrade quality (`references/upgrades.md`, which builds on everything here). In those jobs:

- **The app has already run the engine.** The prompt hands you its rows; judge them by the rules below and answer in the job's JSON schema. Don't re-run the engine, write decisions files or render pages — the app applies your answer to its own list, where the person ticks and buys.
- **Read-only tools only:** library checks, store and free-download searches, the acquisition history. Never fill a cart, buy, follow, like or comment; those stay with the person, on the app's own buttons.
- **A wrong store record gets a replacement, not just a "wrong".** Search with `search_store_catalog` and answer with the hit's `ref` (`bp:…` / `qz:…`). A free copy you found goes in as its link — a SoundCloud track page or the download page itself — and the app checks it against the copy before it uses it.

## Rules that never bend

1. **Lossless only.** A lossy match never reaches the buy list; the engine routes it to `flagged`. Never hand over a link to an MP3-only release, and never work around the exclusion — the review helper refuses to move one.
2. **Beatport takes precedence.** It wins every tie and near-tie; Qobuz wins only when it beats Beatport by more than 0.10 or Beatport has nothing acceptable. Beatport's WAV drops onto the XDJ with no conversion step.
3. **Rekordbox decides ownership.** A file on disk that was never imported is not owned — it is a decision to surface ("import it"), not a purchase to skip. The engine reports those separately.
4. **Account actions wait for a yes.** Searching is free. Filling a real cart, or following/liking on SoundCloud, happens only after the user has seen the list and agreed, or asked for it up front.

## Pick the input

| The user has | Do this |
|---|---|
| A public Spotify playlist URL | `--playlist <url>` |
| One of their own playlists (Ben's are private: the API, the embed page and the Spotify connector all 404) | walk it: `node "$SKILL/scripts/spotify-walk-playlist.mjs" <url>` → CSV → `--csv` |
| An Exportify export, or tracks they typed out | a CSV with artist and title columns → `--csv` |
| Their SoundCloud likes, or a SoundCloud set (any `soundcloud.com/…/sets/…` link) | read `references/soundcloud-likes.md` — `--set <url>` for a set |
| A session JSON from an earlier run | skip to **Review** |
| A Rekordbox playlist whose MP3s and streams should become lossless | an upgrade: read `references/upgrades.md` (it starts from the playlist and builds on everything here) |

Don't guess which. A private playlist fails fast (`Spotify playlist fetch failed: 404`) — then walk it. The walk mutes the Spotify desktop app, plays the list on repeat, reads each track by AppleScript, and restores volume, shuffle, repeat, track and position; about 0.7 s per track. Trust it only when it reports a **WRAP** (it came back round to track 1). A WRAP with a track count far below the last walk is false: on 2026-10-30 it reported 1 track while the app was mid-playback; rerun it alone. Without one the tail may be Autoplay recommendations, and the file is named `-unverified.csv` so it isn't sourced by accident. It exposes the primary artist only, so collabs land in `probable` a little more often — that's the scorer being honest, not a bug.

## Run

```bash
cd "$TRACK_LAB_ROOT"
node bin/source-playlist.mjs --playlist 'https://open.spotify.com/playlist/…' \
  --out "$HOME/Library/Application Support/candybar-manager/sourcing-sessions/<playlist-slug>-$(date +%F).json" 2> "$WORK/sourcing.log"
```

- **Name the session with `--out`.** The default name, `session-<ms>.json`, is one nobody finds again; give it the playlist's name in the same `sourcing-sessions/` folder.
- **Run it in the background and tail the log.** About 2 s per unowned track plus a one-off library read; 73 tracks with 25 to search took a minute. Tell the user what is happening rather than sitting silent.
- **A Chrome window opens for Beatport.** Cloudflare 403s plain HTTP and headless Chrome alike; only headed real Chrome gets through. Not optional — explain it, don't fight it. If a Chrome with a DevTools port is already running, the engine uses its tabs instead of opening a window (see `references/commands.md`).
- **`--limit 5` first** on a playlist you haven't seen, then the full run. Interrupted? `--resume <session.json>` searches only what's unresolved; the file is rewritten after every track so nothing is lost.
- Every flag, the CSV header rules, and the MCP equivalents: `references/commands.md`.

**Check the stats before reading the buckets.** `stats.library.rekordbox` should be in the low thousands (1,980 in October 2026). Zero means the Rekordbox read failed — `stats.library.errors` says why, usually Rekordbox is open or the DB moved — and every track will look missing. Never present that as a result; fix it and re-run. `stats.library.candybar` is the app's scan reflection; zero there only hides the "file on disk, never imported" case. `stats.beatportStatus` other than `searched` means Qobuz-only results, which changes the answer because Beatport is the preferred store — say so.

## Review — this is the part that matters

The session has `owned`, `probable`, `ignored`, and the search results `buy`, `flagged`, `notFound`. A probable row is searched anyway, so it appears twice: in `probable` with its library match, and in `buy` or `notFound` with its store match. Field-by-field reference: `references/session-format.md`.

Read every probable row and every buy row. What the last three reviews taught:

**Probable rows are usually duplicates.** Spotify writes `Title - X Remix`; the library has `Title (X Remix)`; the fuzzy score drops to 0.72–0.85 and the track is the same. Spotify also lists every collaborator while the library tag omits features, which depresses the artist score. Decide from the titles, not the number:

| Library has | Playlist wants | Verdict |
|---|---|---|
| the same remix | the same remix, spelled differently | skip |
| Extended / Club mix | the bare title or Original Mix | skip — the extended covers it |
| the original or radio edit | the Extended mix | buy — a DJ wants the long one |
| the original | a remix (or the other way round) | buy — a different record |
| the same track, tag omits a feature or collab | | skip — the tag differs, the track doesn't |
| the same short title, a different artist | | no match at all — treat as missing |

`reason: "file on disk, not in Rekordbox"` is not a purchase either: tell the user to import the file.

**Buy rows: check the artist before the score.** The title can match perfectly and the record still be wrong — "Vaultage 003" linked Vaultage 004, "Spit It Out" linked an unrelated track by a different artist, "Hidden" linked Dylan Fogarty's Hidden. The score and the artist floor both passed them. For every buy row compare `match.artists` with the wanted artist and `match.title`'s version with the wanted version. `candidates` shows what the other store found: two stores agreeing on artist and title is strong, one store with a different artist is suspect. `runnerUp` is the alternative link. Anything under 0.75 or with `scoreParts.penalty > 0` ("different version?" on the page) gets a sentence of its own.

**Owned rows deserve a glance.** A ≥0.90 match can still be wrong when a one-word title lands on another artist's track. Scan the `owned` list for a matched title or artist that differs materially from the wanted one; the memory records "Starjunk 95 — Grimestar" being marked owned by "State Your Name".

**notFound** usually means a bootleg, an edit, a SoundCloud- or Spotify-only release, or a continuous mix. Name the likely reason per track. When a release plainly should exist, look by hand with the `search_beatport` / `search_qobuz` MCP tools before calling it unavailable.

**flagged** is lossy-only releases (correct — leave them there) and rows whose cart link couldn't be resolved (`match.cartError`). Say which and why.

### Record the verdicts

Write a decisions file and apply it; don't hand-edit the session — three past reviews each invented their own format and the page and stats drifted apart.

```bash
H="$SKILL/scripts"
node $H/apply-review.mjs <session.json> <decisions.json> --dry-run   # shows every move, writes nothing
node $H/apply-review.mjs <session.json> <decisions.json>
```

Verdicts are `skip` (already owned → leaves the buy list, probable → owned), `buy` (confirmed, note attached), `wrong` (store linked the wrong record → notFound, the rejected match kept on the row), `flag` (keep it, but for a human). `library: owned|missing` overrides the library side; `match: {…, lossless: true}` adds a store hit you found by hand. It is all-or-nothing, keeps `*.pre-review.json` beside the session, and refuses a lossy match. Schema and examples: `references/session-format.md`.

## Publish the review page

```bash
node lib/sourcing/previews.mjs <session.json>          # optional: 30 s clips, opens Chrome for Beatport rows
node lib/sourcing/review.mjs <session.json> "$WORK/review.html"
```

Publish the HTML with the Artifact tool: `file_path` is the page, `icon` is `cart`, and the page's own `<title>` ("<Playlist> Crate") stands. It carries cover art, store chips, prices, a running total, "different version?" and "weak match" chips, your review notes, and buy buttons that open the store page and tick the row. Previews are inlined (the artifact CSP blocks store media), about 300 KB each against a 16 MB page limit — skip them past roughly 40 buy rows. Re-render after `cart.mjs` or `previews.mjs`, since both rewrite the session.

## Fill the carts

Only after the user has seen the buy list and said yes, or asked for it up front.

```bash
node lib/sourcing/cart.mjs <session.json> [--store beatport|qobuz]
```

The adds run in Track Lab (started if it's closed), on the first Qobuz and Beatport account in its Settings, through the same cart code as the app's own Buy step: anything not marked lossless is refused, Qobuz gets a lossless tier only, and a re-run never double-adds. A Beatport track the account already owns moves to `flagged` with "download it from your Beatport library and import it". If a store has no signed-in account in Track Lab, nothing is added and the run says so: sign in from Settings or with `store_login`, which opens Track Lab's own sign-in window. Each added row gets `cartAdded`; re-render so the page shows "in cart". Checkout is theirs.

## Report back

Lead with how many tracks to buy and the total, then:

- the buy list — artist, title, store, price, one note where the match needed judgment
- probable verdicts — one line each, skip or buy, with the reason
- flagged and not-found rows, each with its likely cause
- any degradation: Beatport unavailable, library read failed, walk without a WRAP
- the artifact link, and the one question left: fill the carts, yes or no

## SoundCloud likes and sets

The same pipeline pointed at a likes list or a SoundCloud set (`--set <url>`): read the tracks, drop what Rekordbox has, find the free file, fetch it. Nothing is bought; lossless files land in the intake folder, lossy ones are kept under `lossy/` and flagged, and gates (Hypeddit is automated) can hand the tab to the user. Everything — flags, buckets, gate outcomes, the sign-in it needs, what is still unproven — is in `references/soundcloud-likes.md`.

## MCP tools

The `candybar-audio-tools` server wraps the same engine: `check_library_for_tracks` (fast, no browser), `source_playlist`, `source_soundcloud_likes`, `render_sourcing_review`, `search_beatport`, `search_qobuz`, `list_purchases`, `store_login`, `download_track`. The sourcing tools block for the whole run and take no `--out` or `--resume`, so prefer the CLI in the background for a real playlist and the tools for one-off lookups. Store tools drive the browser, not an API; `signedIn: false` is a real answer — offer `store_login`, never present it as "no results".

## Where things live

Paths below are the main profile's. Another profile keeps the same files under `~/Library/Application Support/candybar-manager/profiles/<id>/`, with its browser sign-ins in that folder's `cache/` instead of `~/.cache/candybar-manager`. The store socket stays at the top level whichever profile is running.

| What | Where |
|---|---|
| Engine, CLIs, tests | `$TRACK_LAB_ROOT/lib/sourcing/`, `$TRACK_LAB_ROOT/bin/`, `npx vitest run lib/sourcing` |
| Skill helpers | `$SKILL/scripts/` (walker, review applier) |
| Acquisition history (every download, lossy drop, cart add, purchase, across all runs) | `~/Library/Application Support/candybar-manager/sourcing-history.jsonl`; read with `node lib/sourcing/history.mjs` or the `sourcing_history` MCP tool. Written automatically; purchases land when `list_purchases` runs, so run it after a checkout |
| Named sessions | `$TRACK_LAB_ROOT/sourcing-sessions/` (gitignored); unnamed ones under `~/Library/Application Support/candybar-manager/sourcing-sessions/` |
| Preview clips | `<session>.previews/` beside the session |
| Spotify API credentials | `~/Library/Application Support/candybar-manager/secrets.json` (`spotifyClientId`, `spotifyClientSecret`) |
| Store sign-ins | Qobuz and Beatport: Track Lab's own accounts (Settings → Qobuz / Beatport), reached through its socket `~/Library/Application Support/candybar-manager/store-bridge.sock`. SoundCloud: the Chrome profile `~/.cache/candybar-manager/playwright-profiles/soundcloud` (Beatport search still opens a `beatport` profile, signed in or not) |
| Gate email | `gateEmail` in `~/Library/Application Support/candybar-manager/secrets.json` (Settings → SoundCloud); every SoundCloud run uses it unless given `--no-email` |
| Library config the app shares | `~/Library/Application Support/candybar-manager/config.json` (`libraryRoot`, `organizeSourceDir`) |

## When something breaks

The three you'll meet most: a 404 on the playlist means it's private (walk it); `stats.library.rekordbox: 0` means close Rekordbox and re-run; `Beatport unavailable` means the run continued Qobuz-only and the summary must say so. The full symptom table is `references/troubleshooting.md`; the scoring internals, for when the user asks why a row looks wrong, are `references/scoring.md`.
