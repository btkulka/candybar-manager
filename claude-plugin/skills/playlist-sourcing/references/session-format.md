# Session files

A sourcing run writes one JSON file and rewrites it after every track, so an interrupted run keeps its work. Everything downstream — the review page, the cart filler, the previews, the review applier — reads and rewrites that one file.

## Playlist session (`bin/source-playlist.mjs`)

```
createdAt, complete            ISO time; false while a run is still going
playlist   { name, owner, imageUrl, trackCount, fetchedCount, url }
stats      see below
owned[]    library rows, confidence ≥ 0.90 and in Rekordbox — never searched
probable[] library rows, 0.60–0.89, or ≥ 0.90 but only a file on disk — searched anyway
ignored[]  rows on the app's ignore list (candybar.db ignored_tracks) — left alone
buy[]      search results with a lossless match and a usable link
flagged[]  search results that are lossy (`flag`), or whose cart link failed (`match.cartError`)
notFound[] search results with no acceptable match (`status: "not_found"`)
```

The four library buckets plus `missing` always add up to the input; `probable` rows also appear once among the search results, because they are searched.

**Every row** carries the playlist fields: `artist, title, album, year, duration (s), image, spotifyUrl, key`. `key` is the normalized `"artist - title"` the engine dedupes and matches on; use it to name a row in a decisions file.

**Library rows** (`owned`, `probable`, and copied onto search results): `libraryStatus` (`owned | probable | missing`), `libraryConfidence`, `libraryMatch { artist, title, filePath, inRekordbox, lossless, container }`, and for probable `reason` (`"uncertain match"` or `"file on disk, not in Rekordbox"`).

**Search results** (`buy`, `flagged`, `notFound`):

```
store        "beatport" | "qobuz" | null
status       "matched" | "not_found"
match        the winning store hit, or null:
             { id, title, artists[], mix, label, price, url, image, lossless, score,
               scoreParts { score, artistScore, titleScore, boost, penalty, artistFloored },
               Qobuz only: trackId, cartUrl, cartLabel, quality, cartError }
runnerUp     { store, title, artists, score, url, price } — the store that lost
candidates   { beatport: {score, title} | null, qobuz: {…} | null } — what each store found
searchErrors ["beatport: …", "qobuz: …"] — a store that threw for this track
flag         (flagged only) why it isn't in the buy list
```

Added later by the tools: `cartAdded` (ISO time, `cart.mjs`), `previewPath` + `previewSource` (`previews.mjs`), `reviewNote` / `reason` / `rejectedMatch` (the review applier, below).

**`stats`**

```
total, duplicatesDropped, owned, probable, missing, ignored, searched, toSearch,
buy, flagged, notFound,
beatportStatus     "searched" | "skipped by flag" | "not needed" | "unavailable: <why>"
beatportLoggedIn   true when the profile had a token (API search; cart add possible)
beatportSkipped    beatportStatus !== "searched"
library            { rekordbox, candybar, disk_only, errors[] } — rekordbox: 0 means the read failed
storeMatchFloor    0.5
reviewed           { at, by, note, applied } — written by the review applier
```

## Review decisions (`scripts/apply-review.mjs`)

```json
{
  "note": "18 probable rows were duplicates; 3 store links were wrong records",
  "rows": [
    { "key": "tate mcrae moore kismet - slower moore kismet remix",
      "verdict": "skip",  "note": "same remix is already in Rekordbox" },
    { "key": "Jai Wolf - All Your Love",
      "verdict": "skip",  "note": "you own the Extended Mix, which covers this" },
    { "key": "pitchblack - confessions",
      "verdict": "buy",   "note": "the 63% library hit was Usher's Confessions" },
    { "key": "lafaye - hidden",
      "verdict": "wrong", "library": "missing",
      "note": "store and library both matched Dylan Fogarty's Hidden, a different track" },
    { "key": "space laces - vaultage 003",
      "verdict": "wrong", "note": "Qobuz linked Vaultage 004; 003 is a continuous mix nobody sells" },
    { "key": "starjunk 95 - grimestar",
      "verdict": "buy", "library": "missing",
      "note": "false owned — the library hit was State Your Name",
      "match": { "store": "beatport", "title": "Grimestar (Extended Mix)", "artists": ["Starjunk 95"],
                 "url": "https://www.beatport.com/track/grimestar/123", "price": "$1.49", "lossless": true } }
  ]
}
```

`key` is the row's `key`, or `"Artist - Title"` as the playlist spells it (matched case- and punctuation-insensitively).

| Verdict | Store side | Library side (default) |
|---|---|---|
| `skip` | leaves `buy` / `flagged` / `notFound` | `owned` — probable → owned, `reason` and `reviewNote` set |
| `buy` | stays in or returns to `buy`, `reviewNote` set; refused if the match is lossy or there is none | `missing` — leaves `probable` |
| `wrong` | `buy` / `flagged` → `notFound`, `status: "not_found"`, the old hit kept as `rejectedMatch`, `reason` set | unchanged |
| `flag` | `buy` → `flagged`, `flag` = note | unchanged |

`"library": "owned" | "missing"` overrides the library side for any verdict. A `match` on a `buy` verdict supplies a store hit found by hand (`store`, `title`, `url` required, `lossless: true` required — a hand-added lossy match is refused like any other) and is marked `byHand: true`.

The applier is all-or-nothing: an unknown key or a refused move writes nothing and lists every problem. The first run copies the untouched session to `<session>.pre-review.json`. It recomputes `stats` (`owned`, `probable`, `missing`, `buy`, `flagged`, `notFound`) and stamps `stats.reviewed`. It refuses a SoundCloud-likes session — those buckets are outcomes, not judgments.

## SoundCloud-likes session (`bin/source-soundcloud-likes.mjs`)

```
kind       "soundcloud-likes"   (render_sourcing_review switches on this)
source     { user, … }          whose likes, and how they were read
destDir    where files land
stats      total, owned, probable, ignored, alreadyDownloaded,
           free { native, gate, none }, downloaded, flagged, pending, notFree,
           listOnly, gatesSkipped, signedIn, scActions[], library {…}
owned[], probable[], ignored[], alreadyDownloaded[]   library-side rows (as above; alreadyDownloaded carries `ledger`)
downloaded[]   every file lossless
flagged[]      a lossy file (kept under lossy/), or an outcome that needs a human
queue[]        not fetched yet (--list-only, or interrupted) — `outcome` missing or pending
notFree[]      free.kind === "none"
```

**Each row**: the track (`scId, url, artist, title, scTitle, uploader, artistSource, image, likedAt, purchaseUrl, purchaseTitle`), the library fields, `free { kind: "native" | "gate" | "none", gate: { host, url, title } | null, reason }`, and after fetching `outcome`:

```
{ status: "downloaded", via: "native" | "hypeddit" | "hypeddit+url" | "assisted", files: [{ path, ext, codec, lossless }], original, bytes }
{ status: "emailed" | "needs-email" | "needs-you" | "stalled" | "failed" | "skipped", reason }
```

`artistSource` says where the artist came from (`title` — the "Artist - Title *FREE DL*" convention, `publisher`, or `uploader`); when a podcast or mix shows an odd split, that is why.
