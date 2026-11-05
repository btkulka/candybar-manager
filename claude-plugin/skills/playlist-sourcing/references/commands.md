# Commands, flags and tools

Everything runs from the repo: `cd "$TRACK_LAB_ROOT"`. Node 20, plain ESM, no build step. Progress goes to stderr; the one path you need next goes to stdout.

## Playlist → buy list

```bash
node bin/source-playlist.mjs --playlist <spotify url> | --csv <file> [flags]
```

| Flag | Does | Use it when |
|---|---|---|
| `--playlist URL` | public Spotify playlist via the Web API (client-credentials from `secrets.json`) | the playlist is public |
| `--csv PATH` | any CSV with artist and title columns (header rules below) | private playlist (walker output), Exportify, a typed list |
| `--limit N` | only the first N tracks | smoke test before a long run |
| `--out PATH` | session JSON destination (default `~/Library/Application Support/candybar-manager/sourcing-sessions/session-<ms>.json`) | always, for a run you'll come back to |
| `--resume PATH` | reuse the store results of an earlier session; only unresolved tracks are searched | an interrupted run, or re-running after Beatport was down |
| `--prefer cd` | link the CD-quality Qobuz tier instead of Hi-Res | a cheaper cart |
| `--skip-beatport` | Qobuz only, no browser | Chrome is unavailable, or a quick second opinion |
| `--headless` | try headless Chrome | don't — Cloudflare blocks it; it exists for experiments |

Phases on stderr: `[1/4]` playlist · `[2/4]` library (`index: N in Rekordbox, M on disk only`) · `[3/4]` stores, one line per track, 500 ms apart · `[4/4]` write. Duplicate tracks in the playlist are dropped before any network work (`stats.duplicatesDropped`). Tracks on the app's ignore list leave the pipeline into `ignored`. The session is rewritten after every track.

### CSV headers the loader accepts

Headers are matched after lowercasing and stripping everything but letters, so `Artist Name(s)`, `artist_names` and `ArtistNames` all read as the artist column.

| Field | Accepted headers |
|---|---|
| artist (required, or title) | artist, artist name, artist name(s), artists, album artist |
| title (required, or artist) | title, track name, track, name, song |
| album | album, album name |
| year | year, release date (first four characters) |
| duration | duration_s, duration, length (seconds) · Duration (ms) |
| cover | artwork_url, Album Image URL, image_url, image, cover_url, cover |
| link | spotify_url, track_url, Track URI, spotify_uri, url, uri (`spotify:track:…` becomes an open.spotify.com link) |

Exportify exports and the walker's CSV both work unchanged. Rows with neither artist nor title are skipped. Cover and link columns only feed the review page; matching uses artist and title.

## Private playlist → CSV (Spotify desktop walk)

```bash
node "$SKILL/scripts/spotify-walk-playlist.mjs" <playlist url or id> [--out file.csv] [--max N]
```

- Needs the Spotify desktop app running and signed in to the account that owns the playlist, and macOS Automation permission for whatever runs the script (Terminal, the IDE) → Spotify. A `-1743` / "not authorized" error means that permission is missing.
- Mutes the app, turns shuffle off and **repeat on**, plays the playlist, reads `spotify url / artist / name / album / duration / artwork url` of each track, then restores volume, shuffle, repeat, the track that was playing and its position. The playback context (which album or playlist that track came from) cannot be restored by AppleScript.
- Stops on the **WRAP** — the app coming back round to track 1, confirmed by peeking at track 2 so a mid-list duplicate of track 1 doesn't end it early. `#wrapped=false` means the walk hit `--max` (default 1000) first: raise it, or Spotify drifted into Autoplay. The file is then named `-unverified.csv`; don't source from it.
- Default output: `~/Library/Application Support/candybar-manager/sourcing-sessions/spotify-<id>-<date>.csv`.
- About 0.7 s per track (a 73-track list took about 55 s). `artist` is the primary artist only — that is all the app exposes.
- Verified live 2026-10-29 on a 73-track playlist: all rows, WRAP confirmed, playback restored to the same track and position.

## Review verdicts → session

```bash
node "$SKILL/scripts/apply-review.mjs" <session.json> <decisions.json> [--dry-run]
```

Decisions schema, verdict semantics and what each one moves: `session-format.md`. All-or-nothing; the first run keeps `*.pre-review.json` beside the session; a second run with the same file is a no-op.

## Preview clips

```bash
node lib/sourcing/previews.mjs <session.json> [--force]
```

30-second, 96 kbps clips written to `<session>.previews/<hash>.mp3` and recorded as `previewPath` on each buy row. Qobuz clips come over plain HTTP from the album page; Beatport clips need the track page's `__NEXT_DATA__`, so this opens the real Chrome. Each clip is about 300 KB and the published page must stay under 16 MB, so skip previews past roughly 40 buy rows. `--force` refetches clips that already exist.

## Render the page

```bash
node lib/sourcing/review.mjs <session.json> <out.html>        # playlist session
node lib/sourcing/likesReview.mjs <session.json> <out.html>   # soundcloud-likes session (likes or a set)
```

Both inline cover art (downscaled with `sips`) and, for the playlist page, the preview clips — a published artifact runs under a CSP that blocks every external host. The playlist page shows: buy rows with price, store chip, "in cart" when `cartAdded`, "maybe already yours · N%" for probable rows, "different version?" when `scoreParts.penalty > 0`, "weak match — check" under 0.75, "also on <other store> · N%" from `runnerUp`, and your `reviewNote`; review rows (probable, flagged) with their `reason` or `flag`, the library match and its path, "not in Rekordbox" when applicable; owned rows with their filename; not-found rows. Buy buttons open the store's page and tick the row; they cannot fill a cart.

Publish with the Artifact tool: `file_path` the HTML, `icon` `cart` for a playlist page or `cloud` for a likes page, and let the page's `<title>` stand.

## Fill the carts

```bash
node lib/sourcing/cart.mjs <session.json> [--store beatport|qobuz] [--force]
```

| Store | How | Sign-in | Notes |
|---|---|---|---|
| Beatport | Track Lab's Beatport account (the first in Settings): `api.beatport.com` with that account's token; WAV, then AIFF, then FLAC | Track Lab's account; none signed in → nothing added, says so | reads the cart first, so re-runs never double-add; `AlreadyPurchased` moves the row `buy → flagged` ("download it from your Beatport library and import it") |
| Qobuz | Track Lab's Qobuz account: it re-reads the track's tiers and adds a lossless one with the XHR the site's own button sends | Track Lab opens its own sign-in window if the account is signed out | a plain link to the add-cart URL is a 404 (verified 2026-09-07), which is why the page can't do this |

The adds go through Track Lab (lib/storeBridge.mjs), which is started if it's closed. Each added row gets `cartAdded` (ISO time) and the session is rewritten afterwards; `--force` re-adds rows already marked. Output on stdout: `{"beatport": {added, failed, purchased, signedIn}, "qobuz": {added, failed, purchased, signedIn}}`. Re-render the page afterwards.

## Store sign-in (once per store)

MCP: `store_login { store: "qobuz" | "beatport" | "soundcloud", timeoutSeconds? }`.

- **Qobuz and Beatport** sign in through Track Lab (started if it's closed): it opens its own sign-in window for each of its accounts in Settings, making the first one if there are none. The app, `list_purchases`, `download_track` and `cart.mjs` all use those accounts, so a sign-in anywhere counts everywhere. Shell equivalent: sign in from Track Lab's Settings → Qobuz / Beatport.
- **SoundCloud** opens its Chrome profile (`~/.cache/candybar-manager/playwright-profiles/soundcloud`) and waits for the sign-in. Track Lab's Settings → SoundCloud and its Connections pill use the same profile.

Nothing account-shaped ever uses stored passwords or a private API login: Qobuz and Beatport run on Track Lab's signed-in sessions, SoundCloud on the real Chrome profile.

## Browser: attach or launch

`lib/launchBrowser.mjs` first looks for a Chrome already running with a DevTools port (`CANDYBAR_CHROME_CDP`, default `http://127.0.0.1:9222`). When one answers, the scripts work in tabs of that browser — the one that is already signed in — touch only tabs they opened, and never quit it. Chrome 136+ refuses a debugging port on its default profile, so this needs a Chrome started with `--remote-debugging-port=9222 --user-data-dir=<a dedicated dir>`. Otherwise it launches the installed Google Chrome on the per-site persistent profile. `CANDYBAR_CHROME_CDP=never` forces the launch path. Playwright's bundled Chromium is never used against a store: Cloudflare fingerprints it.

## MCP tools (`candybar-audio-tools`)

| Tool | Parameters | Notes |
|---|---|---|
| `check_library_for_tracks` | `tracks: [{artist, title}]` | library only; fast; no browser; returns owned / probable / missing with `stats` |
| `source_playlist` | `playlistUrl` or `csvPath`, `limit`, `prefer`, `skipBeatport` | runs `bin/source-playlist.mjs`; blocks up to 30 min; no `--out` / `--resume`; returns `sessionPath`, `stats`, trimmed buckets |
| `render_sourcing_review` | `sessionPath`, `outPath?` | detects the session kind; returns the HTML path |
| `source_soundcloud_likes` | `user`, `set` (URL or list), `limit`, `since`, `listOnly`, `noGates`, `dest`, `assistSeconds`, `email`, `scActions`, `comment`, `resume` | runs `bin/source-soundcloud-likes.mjs`; blocks up to 60 min |
| `search_qobuz` | `artist`, `title`, `prefer?` | public HTTP; returns the best match with tier, price and cart link |
| `search_beatport` | `artist`, `title` | opens the real Chrome; no login needed for search |
| `list_purchases` | `source: qobuz|beatport|both`, `hoursAgo?` | reads the signed-in session; says `signedIn: false` rather than returning an empty list |
| `store_login` | `store`, `timeoutSeconds?` | one-time sign-in per store |
| `download_track` | `source`, `trackId`, `artist`, `title`, `destDir?` | downloads a purchased track through the session, converts to AIFF, saves to the organize folder |
