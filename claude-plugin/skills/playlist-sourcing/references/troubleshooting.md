# When something breaks

The engine degrades instead of dying: a store that fails costs that store's coverage, not the run, and the session records why. The job here is to notice the degradation and say it — a clean-looking result built on a broken library read is the worst outcome.

## Playlist run

| Symptom | Cause | Fix |
|---|---|---|
| `Spotify playlist fetch failed: 404` | the playlist is private (the client-credentials API can't see it) | walk it: `scripts/spotify-walk-playlist.mjs <url>` → `--csv` |
| `Spotify credentials missing` | no `secrets.json` | add `spotifyClientId` / `spotifyClientSecret` to `~/Library/Application Support/candybar-manager/secrets.json` |
| `Not a Spotify playlist URL` | an album, track or artist link | ask for the playlist link, or a CSV |
| `WARNING Beatport unavailable (…)` and `stats.beatportStatus: "unavailable: …"` | Chrome missing or refused to start | the run continued Qobuz-only; say so, then fix Chrome and `--resume` the session to fill in Beatport |
| `Beatport session: signed out (page scrape; cart adds go through Track Lab either way)` | the `beatport` search profile isn't signed in | nothing to fix: search reads the page, and carts use Track Lab's Beatport account |
| per-track `beatport search failed` / `qobuz search failed` (also in `searchErrors`) | a transient store error | `--resume` the session; only those tracks are retried |
| `rekordbox: …` in `stats.library.errors`, `stats.library.rekordbox: 0` | Rekordbox open, the DB moved, or `.venv-rbx` lacks pyrekordbox | close Rekordbox and re-run; ownership was under-reported and **every** track looked missing — never present that run |
| `stats.library.candybar: 0` | the app's library scan hasn't run | only the "file on disk, not in Rekordbox" case is hidden; ownership itself is fine |
| everything lands in `buy` | library index empty | same as above — check `stats.library` first |
| Qobuz `no lossless tier offered` in `match.cartError` | MP3-only release | correct: it belongs in `flagged` |
| Qobuz `no track id on album page` | the album page changed shape or the track isn't on that edition | the row is flagged; the album `url` still opens; try `search_qobuz` by hand |
| a buy row's store title matches but the artist doesn't | short common title, token overlap in the artist | verdict `wrong`; search by hand before calling it unavailable |
| published page refused or huge | too many inlined previews (16 MB cap) | re-render without running `previews.mjs`, or trim the buy list first |

## Spotify desktop walk

| Symptom | Cause | Fix |
|---|---|---|
| `macOS refused to automate Spotify` (`-1743`) | no Automation permission | System Settings → Privacy & Security → Automation → allow the terminal/IDE → Spotify, then re-run |
| `Spotify would not play that playlist` | the app isn't signed in to the account that owns it, or the id is wrong | check the app; paste the link from Spotify's Share menu |
| `the walk produced no tracks` | empty playlist, or the app didn't start it | open it in the app once by hand, then re-run |
| `WARNING: no WRAP` | longer than `--max`, or Autoplay took over | raise `--max`; if it still won't wrap, repeat is being overridden — set Repeat on by hand in the app and re-run. Never source from a `-unverified.csv` |
| a collab shows one artist | AppleScript exposes the primary artist only | expected; the matcher tolerates it |

## Review applier

| Symptom | Cause | Fix |
|---|---|---|
| `no row matches "…"` | the key isn't a row's `key` or its exact `Artist - Title` | copy `key` from the session JSON |
| `is a lossy store match — it cannot be moved to the buy list` | rule 1 | leave it flagged; say so |
| `was never searched (it sat in owned)` | a false-owned row has no store hit | give the decision a hand-found `match` (`lossless: true`), or re-run the search |
| nothing written | any error is all-or-nothing | fix the listed problems and re-run; `--dry-run` to preview |

## Carts

| Symptom | Cause | Fix |
|---|---|---|
| `cart: No Qobuz account in Track Lab yet… — nothing added` (or Beatport) | no account in Track Lab's Settings for that store | `store_login` for the store (makes the account and opens Track Lab's sign-in window), then re-run |
| `cart: Not signed in to Qobuz…` / `Beatport session token not found…` | Track Lab's account is signed out | sign in from Track Lab's Settings or `store_login`, then re-run |
| `Track Lab didn't come up within 90 s` | the app couldn't be started, or an older build without the store bridge is open | open Track Lab by hand (update it if it's old) and re-run |
| `cart: ALREADY PURCHASED … moved to flagged` | the account owns it on Beatport but it isn't in Rekordbox | download it from the Beatport library and import it; `download_track` does the download |
| `Beatport returned no usable cart id` | the API shape moved | report it; the track pages on the review page still work by hand |

## SoundCloud likes

| Symptom | Cause | Fix |
|---|---|---|
| `SoundCloud is signed out — sign in on the Chrome window` (waits 5 min) | profile has no session | sign in on that window; or `--user <name>` for a public profile; or `store_login` with `store: soundcloud` |
| `SoundCloud profile is signed out — run the store_login tool…` | `--login-timeout 0` or `--headless` | run headed, or sign in first |
| `HTTP 401/403 — SoundCloud refused the download (limit reached or followers-only)` | the uploader's download cap, or a follow gate on SoundCloud itself | follow by hand, or come back later; the row is `failed` |
| every gate row `needs-you` with "Hypeddit Arcade" | after 2–3 downloads from one browser Hypeddit swaps the gate for a hot-or-not game | rate a few tracks in the Chrome window, then `--resume <session.json> --assist 180` |
| `no walker for <host>` → `needs-you` | only Hypeddit is automated | `--assist 180` and click through the gate by hand while it waits; the page lists an "Open gate" link |
| `needs-email` | the gate wants an address and none is saved | the user can save one in Track Lab's Settings → SoundCloud (then every run uses it), or pass `--email ADDR` for one run; only an address they want given out |
| `emailed` | Hypeddit mailed the link instead of serving the file | the user fetches it from the mail; nothing more to automate |
| `stalled: gate timed out` / `no actionable step found` | the gate's markup changed or it is waiting on a captcha | `--assist` for a human pass; report the host |
| a file landed in `lossy/` | the uploader only offers an MP3 | correct — flagged, not lost; decide per track |
| `--since is not a date` | wrong format | ISO, e.g. `2026-09-01` |
