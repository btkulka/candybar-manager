# SoundCloud likes and sets → free downloads

The same pipeline pointed at a likes list, or at a SoundCloud set (playlist), instead of a Spotify playlist: read the tracks, drop what Rekordbox already has, find the free file, fetch it. Nothing is bought. The deliverable is files in the intake folder plus a review page of what needs a human.

## Run

```bash
cd "$TRACK_LAB_ROOT"
node bin/source-soundcloud-likes.mjs                      # your likes, via the signed-in Chrome profile
node bin/source-soundcloud-likes.mjs --user <name>        # a public profile's likes — no browser needed to read
node bin/source-soundcloud-likes.mjs --set <url>          # a set (playlist); repeat --set to pool several
node bin/source-soundcloud-likes.mjs --list-only          # classify and report; fetch nothing
```

A set link is anything with `/sets/` in it, pasted as is — `?si=…` share junk, the `m.soundcloud.com` host and `on.soundcloud.com` short links are all cleaned up. A public set (or a secret `…/s-TOKEN` link) is read with no browser; one of the user's own private sets answers 401/403/404 publicly, and the run then opens the signed-in session and reads it there. api-v2 hands back the first five tracks whole and the rest as id stubs, hydrated 50 at a time in the set's order (verified live 2026-10-29 on a 407-track set). A track that never hydrates (deleted, blocked, private to its owner) is counted in `source.unavailable`, not silently dropped.

| Flag | Default | Does |
|---|---|---|
| `--user NAME` | — | read a public profile's likes instead of the signed-in session |
| `--set URL` | — | source a set instead of likes; repeatable, tracks from every set are pooled into one session |
| `--limit N` | all | newest N likes, or the first N tracks of each set |
| `--since DATE` | — | likes made on/after an ISO date (`2026-09-01`); a set has no liked-at date, so it is ignored with a note |
| `--list-only` | off | classify and report, download nothing |
| `--no-gates` | off | native SoundCloud downloads only; gates are listed, not walked |
| `--drop-lossy` | off | delete lossy files (MP3 &c) the moment they arrive instead of parking them under `lossy/`; rows land in a `dropped` bucket and the ledger remembers them, so the gate is never walked again for them. Ben asked for this on 2026-10-30 ("delete MP3s as we get them and hold onto the rest") |
| `--dest DIR` | `<organizeSourceDir>` itself (today `/Volumes/Candy Bar/tracks_to_organize`), or `~/Downloads/soundcloud-likes` when the volume is unmounted | where files land |
| `--out PATH` | `~/Library/Application Support/candybar-manager/sourcing-sessions/soundcloud-likes-<ms>.json` (`soundcloud-set-<ms>.json` for `--set`) | session JSON |
| `--resume PATH` | — | reuse an earlier session's rows; pending rows are fetched and gates that stalled (`needs-you`, `stalled`, `failed`, plus `needs-email` once `--email` is given) are retried — this is how a Hypeddit Arcade round is finished: run, rate in the window, resume |
| `--assist SEC` | 0 | when a gate stalls, bring the tab forward and wait this long for the user to finish it |
| `--gate-timeout SEC` | 90 | per-gate automation budget |
| `--email ADDR` | the one saved in Track Lab's Settings → SoundCloud | fill gates that demand an address; never sent anywhere else |
| `--no-email` | — | give gates no address this run, even if one is saved |
| `--sc-actions LIST` | `follow,like,comment` | account actions a gate may do **for real** through the session; add `repost` (opt-in — it is public on the profile) or `none` |
| `--comment TEXT` | the saved one | the comment left when a gate asks for one, for this run only. By default it's `gateComment` from Settings → SoundCloud (Ben's is `dis shit nasty`); with none saved, gates that insist on a comment are left for a person. Don't override it |
| `--login-timeout SEC` | 300 | when the profile is signed out, wait this long for a sign-in on the window (`0` = fail instead) |
| `--headless` | off | fine for reading likes; gates may refuse it |

The MCP tool `source_soundcloud_likes` takes the same options in camelCase (`set` — one URL or a list — `listOnly`, `noGates`, `assistSeconds`, `scActions`, …) and blocks up to an hour.

**First real signed-in run** (see "What is proven" below): `--limit 10 --list-only`, read the classification, then `--limit 5` headed with Chrome visible, then the full run.

## What it needs

- **Reading your own likes, every native download, and every account action** need the signed-in session: `/tracks/<id>/download` answers 401 without the OAuth header (verified 2026-09-23). The profile lives at `~/.cache/candybar-manager/playwright-profiles/soundcloud`. If it is signed out, the run opens the window and waits up to `--login-timeout` for the sign-in, then carries on; `store_login` with `store: soundcloud` does the same on its own.
- **A public profile's likes** need nothing: `--user <name>` reads `/users/<id>/track_likes` with the public client id.
- **A public set** needs nothing either: `/resolve` + `/tracks?ids=…` with the public client id. Only a set private to the account goes through the session.
- If a Chrome with a DevTools port is running, the run attaches to it ("attached to the Chrome you already have open") instead of opening a window.

## Rules that carry over, and one that changes

1. **Rekordbox is still the source of truth.** Liked tracks already in the collection are skipped; `probable` rows are fetched anyway and shown as "maybe already yours · N%".
2. **Lossless only, applied to files instead of carts.** api-v2 carries no format field (verified 2026-09-23), so the file is identified after it arrives — ffprobe's codec, magic bytes as fallback. Lossless goes to the intake folder; **lossy is kept under `<dest>/lossy/` and reported as flagged** — never mixed in. With `--drop-lossy` it is deleted instead and listed under "Lossy only — deleted by request"; that is Ben's standing preference for his likes (2026-10-30). Either way say which ones were lossy; a DJ may still want a bootleg that only exists as a 320.
3. **No store precedence — there is one source.** Instead each row is classified by where its free link lives (`free.kind`):
   - `native` — `downloadable` and downloads left: SoundCloud's own button.
   - `gate` — `purchase_url` points at a known gate host (hypeddit, toneden, hitsdistrict, sicktaste, unlockyoursound, thmatc, fanlink, lnk.to, bandcamp, dropbox, Google Drive, mediafire, mega, wetransfer, gumroad, …) or its `purchase_title` says free/download/DL/grab/unlock without saying buy/stream/pre-save; or the description links to a gate host.
   - `none` — a buy/stream link, a download limit reached, or nothing. `free.reason` says which.

## Gates

Walkers live in `lib/sourcing/gates/`, picked by the host the link lands on (`walkerFor`). Besides Hypeddit (below), added 2026-11-02 and run live against real links up to the boundaries noted:

- **Bandcamp** (`bandcamp.mjs`) — reads `data-tralbum`; a minimum price → `not-free` (never pays). Name-your-price → $0 → "download to your computer". Signed out with `require_email` (every one seen so far) → `needs-email`, or with `--email` (+ `--postcode` for the US) → `emailed`. Signed in, it should land on `bandcamp.com/download` and fetch WAV › AIFF › FLAC; that path is **unverified** (the profile has never been signed in to Bandcamp).
- **Droploud** (`droploud.mjs`) — honor-system steps (open link → "I did it →") are confirmed automatically; then "Connect SoundCloud", an OAuth grant after which Droploud follows/likes itself. Only pressed when `--sc-actions` isn't `none`; the steps after the grant are **unverified**.
- **Sublair** (`sublair.mjs`) — fills the required comment, then "Connect & Unlock" (SoundCloud OAuth, same rule). Post-grant steps **unverified**.
- **Store pickers** (`smartlink.mjs`: lnk.to, smarturl.it, ffm.to, fanlink, artist.link) — follows a real gate link if the picker lists one, else `not-free` with the stores named (Beatport in the list = buyable lossless).
- **Facebook `…/app_<id>`** — dead page-app gates → `not-free`.

A `not-free` outcome moves the row into `notFree` with the walker's reason. `generic.mjs` still covers everything else (ToneDen, gaterush, file hosts).

Hypeddit's walker (`lib/sourcing/gates/hypeddit.mjs`): fill any comment box with the configured text, click each support step once (follow / like / repost / comment — the gate only counts the click; with `--sc-actions` the follow, like and comment are also done for real through the session), skip the rest, press Download, catch the file. Clicks are JS clicks because the gate overlay intercepts pointer events. If the gate tab closes itself before Playwright's copy finishes, the signed file URL is fetched directly (`via: hypeddit+url`). Social pop-ups the gate opens are closed after a moment unless a download starts on them.

What it cannot do, and reports instead of pretending:

- **Hypeddit Arcade.** After two or three downloads from one browser the gate is replaced by a hot-or-not rating game → `needs-you`. The user rates a few tracks in the Chrome window; `--assist 180` makes the run wait for that instead of moving on. A batch of gates in one sitting will hit it — plan to run, rate, resume.
- **Other hosts** have no walker → `needs-you` with an "Open gate" link on the page; `--assist` lets the user click through while the run waits for the file.
- A gate that mails the link → `emailed`. One that wants an address → `needs-email` unless `--email` was given. No file within the budget → `stalled`.

## Re-runs are a sync

`~/Library/Application Support/candybar-manager/sourcing-sessions/soundcloud-downloads.json` records every track id fetched and keeps it even after the file is gone, because a deleted track must stay deleted, so running the command again fetches only new likes; the rest land in `alreadyDownloaded`.

## Reading the result

Buckets: `downloaded` (every file lossless), `flagged` (lossy files, stalled or unknown gates, emailed, needs-email, failed — each row's `outcome.reason` says which), `queue` (not fetched: `--list-only` or interrupted), `notFree`, `probable`, `owned`, `alreadyDownloaded`. The session `kind` is `soundcloud-likes` for both inputs; `source.kind` is `set` for a set (with `set`, `user`, `trackCount`, `unavailable`, and `sets[]` when several were pooled) and absent for likes. Set rows carry `position` (1-based, the set's order) and no `likedAt`. Titles were parsed from SoundCloud's "Artist - Title *FREE DL*" convention; `artistSource` says whether the artist came from the title, the publisher metadata or the uploader, which is why a podcast or mix can show a strange split. Files are named `<Artist> - <Title>.<ext>` and left in their original format; conversion to AIFF is the app's organize step (or `convert_to_aiff`), not this tool's job.

Render with `node lib/sourcing/likesReview.mjs <session.json> <out.html>` (or `render_sourcing_review`, which detects the session kind) and publish it with the Artifact tool, `icon` `cloud`.

## What is proven (as of 2026-10-29)

Verified live on 2026-09-23 without an account: the public likes read, library bucketing, classification from `purchase_url` / `purchase_title`, the Hypeddit walker end to end, zip unpacking and the ffprobe lossy check. Verified live on 2026-10-29: the public set read end to end in `--list-only` (resolve, stub hydration, library check, classification on a 25-track set) and that a missing set fails with a 404 the session fallback catches. Verified live with the user's signed-in session on 2026-10-29: the session capture (token read off the web app's own request), reading his own likes, and the Hypeddit walker inside the signed-in profile (one file fetched, MP3, filed under `lossy/`, ledger written). Three of the four Hypeddit gates in his newest likes asked for an email address, so expect `needs-email` unless `--email` is given — ask before handing an address to gates. `gaterush.me` turned up as a gate host with no walker. **Still unverified:** the native `/tracks/<id>/download` path (none of the newest likes offered one), the real follow / like / comment / repost calls (every run so far used `--sc-actions none`), and reading a private set through the session (same `/resolve` and `/tracks?ids=…` calls with the OAuth header; `playlistId` + `playlistSecretToken` are added when the set carries a secret token). 

## Chrome profile gotchas (2026-10-30)

- **Spotify gates** need the `soundcloud` profile signed in to Spotify. Their OAuth pop-up must be left to finish; a gate with a `step_sp` step stalls at the final Download otherwise.
- **Never open this profile in plain Chrome without `--use-mock-keychain`.** Playwright encrypts cookies with a mock key, so a plain launch makes every session unreadable and logs SoundCloud out. Facebook sign-in refuses the automated window, so a plain window with that flag is how to sign in. The cookie file is `Default/Cookies`, not `Default/Network/Cookies`.
- **After a run, remove copies Rekordbox already has.** Library filenames match the gate's original filename, and a decoded-audio hash confirms it. The fuzzy score misses these: on 2026-10-30, 11 of 23 fetched tracks were already owned under a different tag. Record them as `duplicate-removed` and mark the ledger so they aren't fetched again.
