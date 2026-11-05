# Upgrades: lossless copies of tracks already in Rekordbox

Upgrade quality is sourcing with the question turned round. Sourcing asks "is this playlist's track in the library, and where do I get it?"; an upgrade starts from a track that *is* in Rekordbox, as an MP3, AAC or a streaming link, and asks for a lossless copy of **that exact record**. Everything in SKILL.md still holds — lossless only, Beatport before Qobuz, account actions wait for a yes — and so does the review discipline: the engine narrows, you decide. This file is what changes.

## Why the bar is higher

The swap engine keeps the Rekordbox entry: its cue points, loops, beatgrid, play count, date added and playlists stay, and only the file underneath changes. A different cut under those cues is worse than no upgrade at all — every hot cue lands on the wrong beat. So:

- **Same version, always.** "Go Back (Shizz Lo Flip)" is not "Go Back", not "Go Back (Original Mix)", not "Go Back (FloZone Flip)". A flip, rework, refix, edit, bootleg, VIP or mashup by someone else is another record. The same reworker under another word ("Shizz Lo Flip" vs "Shizz Lo Remix") at the same length is the same track — uploaders are loose with the word.
- **Same length.** Within about 10 seconds of the entry's `duration`. An extended mix for a radio edit (or the reverse) is another cut even when the title agrees.
- **Read the tags the way they were written.** A track saved from SoundCloud is often tagged with the uploader (the reworker) as the artist and either a bare title ("Shizz Lo" / "Go Back") or the whole listing as the title ("Shizz Lo" / "John Summit & Sub Focus – Go Back (Shizz Lo Flip)"). Read it as the upload it came from.

## Where a copy comes from, in order

1. **SoundCloud, free.** The upload's own download button, or a gate: Hypeddit, Droploud, Influence Planner (ipln.io), and others. The `find_free_sources` tool reads gates signed out and says what they give: an Influence Planner page names its file ("3IlngjlG.wav" → lossless, known before anything is clicked); a page that gives an MP3 is never an upgrade. Free links hide in descriptions ("FREE DOWNLOAD - https://ipln.io/…") as often as in the buy button; the tool reads both.
2. **Bandcamp**, free or name-your-price first, then a cheap minimum. Bandcamp serves the artist's lossless master.
3. **Beatport, then Qobuz**, by the store rules in SKILL.md.

A gate's steps are fine to report — "asks for your email, a SoundCloud connect and a comment", "asks for a Spotify connect" — but you never walk one. The person runs the downloads from the app.

## Start from a Rekordbox playlist

In a terminal session the input is a Rekordbox playlist, and Track Lab does the reading and the first search through its `lossless_upgrade` MCP tool (it starts the app if it's closed):

1. `lossless_upgrade` `list_playlists` — the collection's playlists with their ids and track counts. Match the one the user named; ask when two are close.
2. `lossless_upgrade` `check_playlist` with its `playlistId` — Track Lab reads the playlist from Rekordbox, sorts out what's already lossless or owned lossless elsewhere in the collection (those need relinking, not buying), and searches the rest free first (SoundCloud, then Bandcamp) and then the stores. It takes a few seconds a track; the result's rows are the shape below.
3. Judge every row by the rules in this file.
4. Hand your answers back to the app so its Upgrade quality page shows them: `lossless_upgrade` `use_link` with the row's `rbId` and the free copy's link (the app checks it against the entry and keeps it across checks). A store pick is reported, not bought.
5. Report: what's free (and what each download page asks for), what to buy and where, what has no lossless copy of that cut, and what needs relinking. Getting the free downloads (`lossless_upgrade` `fetch_free`, with a yes for the follow/like/comment steps) and the swap itself (`upgrade_swap`) wait for the user, like a cart.

When Track Lab runs you itself ("Check with Claude" on Upgrade quality, or the Claude skills page), steps 1–2 are done already and the rows come in the prompt.

## What the app hands you

One row per Rekordbox entry: `rbId`, the tags (`artist`, `title`), `duration` (s), what it is now (`formatLabel`, e.g. "MP3 320"), and what the app's own search found:

- `free.soundcloud` / `free.bandcamp` — the engine's free hit (with `gateInfo` when the page was read), or null
- `free.nearMisses` — close SoundCloud uploads passed over, each with why (`no-download`, `other-version`, `other-length`, `gate-lossy`, `gate-off`)
- `store` — the store match (`source`, `title`, `artists`, `price`, `lossless`, `confidence`, `ref` when it has one), or null
- `candidates` — what each store's search returned, with refs

## Judge each row

- **A free hit:** is it this exact version and length? A free copy of another cut is "none" for free, even at 100% title match.
- **No free hit:** read `nearMisses`. "No download" on the exact upload means no free copy from it; "other version" means keep looking. When the track is a SoundCloud-only flip or edit, search with `find_free_sources` again with a better reading of the tags (the listing's real artist, the bare title plus the reworker).
- **The store match:** the same artist-before-score check as a sourcing buy row, plus the version and length rule above. Replace a wrong record with a `ref` from `search_store_catalog`; a store copy of another cut is "none", not a purchase.
- **Nothing fits:** say what's likely — a SoundCloud-only bootleg with no download, a continuous mix, a label that never released it lossless.

## Answer

One verdict per `rbId`, in the job's schema:

- `free` with `freeUrl` — the SoundCloud track page (or the gate link itself) of the exact copy. The app checks it against the entry, saves it as the row's free link and fetches it with the others.
- `store` with `ref` — the exact store record. Use the row's own `store.ref` to confirm the engine's pick, or a `ref` from your own search to replace it.
- `none` — no lossless copy of this cut anywhere you could see.
- `keep` — the app's own result stands as it is (a confirmed free hit, a right store match).

Every verdict gets a one-sentence `note` the person can act on: "Same flip, WAV on Influence Planner; it asks for an email and a SoundCloud connect", "Beatport's is the Extended Mix (6:12) — your copy is the 3:05 radio edit".
