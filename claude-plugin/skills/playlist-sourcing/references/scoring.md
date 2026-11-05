# Scoring — for when a bucket needs explaining

Source: `lib/sourcing/matching.mjs`, locked by `lib/sourcing/__tests__/matching.test.mjs` (`npx vitest run lib/sourcing`). The desktop app shares the store rules in `src/lib/storeMatching.ts`, and `src/lib/__tests__/storeMatching.test.ts` asserts the two engines score identically. **Change both together or the parity test fails.**

## Library match (do I own this?)

`artist × 0.6 + title × 0.4`, each field the better of `ratio` and `token_sort_ratio`, computed raw and again after normalization (diacritics, bracketed version tags, "feat." clauses, `&` → "and" stripped). Bonuses: +0.10 for an identical normalized artist, +0.15 for an identical normalized title. Then two caps:

- a title under 0.40 similarity caps the whole thing below 0.60 — a strong artist match can't drag an unrelated title into "maybe owned";
- a different **version signature** caps it at 0.89 — same song, different version is still a track a DJ has to buy, so a remix can never hide behind the original.

Thresholds: ≥ 0.90 owned (only if the match is in Rekordbox; a disk-only file at ≥ 0.90 goes to probable with `reason: "file on disk, not in Rekordbox"`), 0.60–0.89 probable, below missing. An exact key hit is 1.0; an exact normalized key with the same version is 0.98.

`partial_ratio` and `token_set_ratio` are deliberately absent here: both score 100 when one string's tokens are a subset of the other's, which collapses "Home" onto "Home (Nobody Is Not Loved)".

Why probable is full of duplicates: Spotify writes `Title - X Remix` and lists every collaborator; the library has `Title (X Remix)` and often just the lead artist. Both drag the number down while the version signatures still agree, so the row lands at 0.72–0.89 instead of ≥ 0.90.

## Store match (is this the right record?)

`title × 0.6 + artist × 0.4` — weights flipped, because store catalogs credit collaborators inconsistently and the title carries more signal there. Each field is the better of `ratio` and `token_set_ratio` on normalized strings.

- **Floor 0.50** (`STORE_MATCH_FLOOR`): below it a hit isn't a match.
- **Artist floor 0.45** (`STORE_ARTIST_FLOOR`): an artist that barely matches holds the score just under the match floor no matter how well the titles align — short, common titles would otherwise buy a stranger's record. `scoreParts.artistFloored` says when it fired.
- **+0.08** for an Extended / Club mix when the request named no version (DJ workflow: prefer the long one).
- **−0.12** when the candidate carries version descriptors the request didn't ask for — compared by **version signature**, not a keyword list, because any name can precede "Mix" ("Charles D Epic Mix"); plus a guard for remix compilations that say so in the title body ("Your Mind Remixes"). A penalized row never gets the extended boost.
- **No `partial_ratio`.** It slides the shorter string across the longer and rewards incidental letter overlap — it scored "zzzz nonexistent artist" against "ten years after" at 0.62. `token_set_ratio` already covers subset artists ("Fred again.." inside "Delilah Montagu, Fred again..") and reordered names.

Store choice (`pickStore`): both stores must clear 0.50; Beatport wins unless Qobuz is better by more than 0.10 (`BEATPORT_PRECEDENCE_MARGIN`); whichever store loses is kept as `runnerUp`. Qobuz search returns album hits; `resolveCart` then finds the track id on the album page and picks a lossless cart tier (`--prefer cd` takes the last lossless option instead of the first). Qobuz marks a release lossless only when it publishes bit depth and sample rate; Beatport is always lossless (WAV/AIFF/FLAC on every track).

The app additionally uses `ownedVersionSatisfies` for purchase-history matching: owning the original doesn't satisfy a remix request or vice versa, but an owned Extended / Club mix does satisfy an unversioned request.

## Reading `scoreParts`

Every store match carries `{ score, artistScore, titleScore, boost, penalty, artistFloored }`. When the user asks why a row looks wrong, read those before guessing: a high `titleScore` with a middling `artistScore` is the "same title, different artist" trap; `penalty: 0.12` means the store offered a version the playlist didn't ask for; `boost: 0.08` means the engine preferred an extended cut.

## Known weak spots

- A one- or two-word title shared across artists ("Hidden", "Confessions") can clear both floors on another artist's record when the artist names overlap in a token. Check the artist by eye on every buy row.
- The library scorer weights artist 0.6, so a collab whose lead artist matches can reach 0.90 on a different song with a short title (the "Starjunk 95 — Grimestar" case). Scan `owned` for titles that don't match.
- Mix series and numbered releases ("Vaultage 003" vs "Vaultage 004") differ by one token; the fuzzy ratio barely notices.
