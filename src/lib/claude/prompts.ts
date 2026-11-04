import path from 'path';
import type { ClaudeTrackTagsParams, FinderTrack, SourcingReviewRow, TrackTagField } from '../../types';

// Prompts and result schemas for the Claude jobs. The review rules come from
// the playlist-sourcing skill's past reviews, so they hold for anyone running
// the app, not just whoever has that skill installed.

const HOUSE_RULES = `House rules: lossless only (never suggest buying an MP3/AAC copy); for an upgrade, look for a SoundCloud free download first, then Bandcamp (free, or a cheap name-your-price), and only then Beatport or Qobuz; Rekordbox decides what is owned; Beatport is preferred over Qobuz unless Qobuz is clearly the better match; anything the user deleted stays deleted.`;

// ---------- Ask ----------

export const ASK_SYSTEM_PROMPT = `You are Claude inside Candy Bar Manager, a DJ's library app: a Rekordbox collection, lossless purchases from Beatport and Qobuz, and SoundCloud free downloads.
You can read files, search the web, and use the candybar-audio-tools tools to check tracks against the Rekordbox library, search Beatport and Qobuz, read a file's tags and health, and list purchases and sourcing history.
You cannot change anything: no file edits, downloads, conversions, cart adds or account actions. When the user wants one of those, say which part of the app does it (Sources for buying a playlist, Organize for filing new downloads, Library for tags and fixes, Lossless Upgrades for replacing MP3s, the Claude page for SoundCloud free downloads).
${HOUSE_RULES}
Answer in short plain prose; lists are fine.`;

// ---------- Sourcing review ----------

const VERDICTS = ['buy', 'skip', 'wrong', 'flag'] as const;

export const SOURCING_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: [...VERDICTS] },
          note: { type: 'string' },
        },
        required: ['id', 'verdict', 'note'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['verdicts', 'summary'],
  additionalProperties: false,
};

export function buildSourcingReviewPrompt(rows: SourcingReviewRow[]): string {
  return `Review these playlist-sourcing rows for a DJ and return one verdict per row id.

Each row is a track from a playlist with the lossless store copy the matching engine picked. A row with \`library\` might already be owned: the engine found a similar track in the Rekordbox collection but wasn't sure.

Verdicts:
- "buy": the store link is the record wanted, and it isn't already owned.
- "skip": already owned. The library match is the same record.
- "wrong": the store linked a different record (another artist, another remix or version, another track with the same title).
- "flag": the data can't settle it; a human should listen.

How to judge, from past reviews:
- Rows with \`library\` are usually duplicates. Spotify writes "Title - X Remix" where the library has "Title (X Remix)", and Spotify lists collaborators the library tag leaves out, which drags the score down. Decide from the titles, not the score:
  - same remix, spelled differently → skip
  - library has the Extended or Club mix, playlist wants the bare title or Original Mix → skip (the extended covers it)
  - library has the original or radio edit, playlist wants the Extended mix → buy (a DJ wants the long one)
  - library has the original, playlist wants a remix, or the reverse → buy (a different record)
  - same track, the library tag just omits a featured artist → skip
  - same short title by a different artist → not owned; judge the store link on its own
  - reason "file on disk, not in Rekordbox" → skip, and say to import that file rather than buy it
- For every store link, check the artist before the score. A perfect title can still be the wrong record: "Vaultage 003" once linked "Vaultage 004", and "Hidden" linked a different artist's "Hidden". Compare store.artists with wanted.artist, and the version in store.title with the version wanted. versionFlag means the engine already suspects another version; releaseLevel means the link is a whole release, not the track.

Each note is one short sentence the DJ can act on, like "Same remix; the library has 'Title (X Remix)'." Use "" for a plain buy.
The summary is at most two sentences: how many to buy, and what needed judgment.

Rows:
${JSON.stringify(rows, null, 1)}`;
}

// ---------- Store finder ----------

export const STORE_FINDER_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          ref: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          note: { type: 'string' },
        },
        required: ['key', 'ref', 'confidence', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks'],
  additionalProperties: false,
};

/** One finder session's prompt: a few wanted tracks, each with the candidates
 *  the plain search saw. Without `canSearch` (the app's tools aren't built)
 *  Claude judges those candidates only. */
export function buildStoreFinderPrompt(tracks: FinderTrack[], canSearch: boolean): string {
  const search = canSearch
    ? `When no candidate is the record, search again with search_store_catalog before giving up: the artist and the title without the version, the title alone, the remixer with the title, or the other store. Two or three searches per track at most. Refs from those searches are valid picks.`
    : `You can't search; pick from the candidates given, or answer "" when none is the record.`;
  return `Find the store record a DJ wants for each track below: the one to buy on Beatport or Qobuz. Answer with one pick per track key.

Each track lists candidates from the app's own search: a ref, the store, artists, title, label, release date, and the plain search's 0-1 score. searchPick is what that string-matching search chose. It is often right, so keep it when it is, but check it like any other candidate.

How to tell the right record:
- Artist first. A main artist (or, for a remix, the remixer) has to be on the candidate. The same title by someone else is another record, however high its score.
- Then the version. A bare title, "Original Mix" and "Extended Mix" are the same recording; for a bare or Original request pick the Extended Mix when there is one, because a DJ wants the long cut. A request that names a remix, edit, bootleg, VIP or dub wants exactly that version (its extended cut is fine); the original, or another remixer's mix, is a different record. A Radio Edit request is happy with the Extended or Original Mix.
- Wanted titles from SoundCloud carry noise like "[FREE DL]", "*Premiere*", "OUT NOW" or a label tag in brackets. Ignore it.
- Qobuz candidates are releases (a single, EP or album), not tracks. Pick one only when it carries the track; the app finds the track on it and checks it's sold lossless. A Qobuz quality of null means the release may only be sold compressed, so prefer a lossless candidate of the same record.
- Beatport sells every track lossless. When both stores have the same record, pick Beatport.

${search}

For every key:
- ref: the chosen candidate's ref, or "" when neither store sells this record (searchPick is another record and nothing else fits). If you can't tell because a search failed, keep searchPick with low confidence and say so in the note.
- confidence: "high" when artist, title and version all agree; "medium" when one detail is a judgment call; "low" for a best guess.
- note: one short sentence for the DJ when your pick differs from searchPick, when you made a version call, or when nothing is sold ("Beatport only has the Radio Edit; picked the Extended Mix on Qobuz."). Use "" when you simply kept searchPick.

${HOUSE_RULES}

Tracks:
${JSON.stringify(tracks, null, 1)}`;
}

// ---------- Track tags ----------

export const TAG_FIELDS: TrackTagField[] = ['title', 'artist', 'remixer', 'album', 'genre', 'year', 'bpm', 'key', 'label'];

export const TRACK_TAGS_SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'object',
      properties: Object.fromEntries(TAG_FIELDS.map(f => [f, { type: 'string' }])),
      required: TAG_FIELDS,
      additionalProperties: false,
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    source: { type: 'string' },
    sourceUrl: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['fields', 'confidence', 'source', 'sourceUrl', 'notes'],
  additionalProperties: false,
};

export function buildTrackTagsPrompt(p: ClaudeTrackTagsParams): string {
  const current = Object.fromEntries(Object.entries(p.tags).map(([k, v]) => [k, v || '']));
  return `Find the correct tags for this audio file in a DJ's library.

File: ${path.basename(p.filePath)}
Path: ${p.filePath}
Current tags: ${JSON.stringify(current)}

Work out which record this is from the current tags and the file name, then look it up. Beatport has the best data for dance music (BPM, key, label, genre), so try search_beatport first, then search_qobuz or the web. get_metadata reads the file itself if the tags are thin.

Rules:
- Only use values from a real listing of this exact record: same artist, same mix. If you can't pin the record down, leave the fields empty and say why in notes.
- Give a value for every field you're sure of, even when the file already has one, so differences can be shown. Use "" for anything you're unsure of.
- title: the track name with its mix in parentheses as the store lists it, e.g. "Jolean (Extended Mix)".
- artist: the main artists as the store credits them, comma-separated. remixer: only the remixer's name, when it's a remix.
- album: the release title. label: the record label. genre: the store's genre.
- year: the four-digit year of the original release. bpm: a whole number.
- key: a Camelot code like "8A", unless the current key uses note names like "Am"; then use that style.
- confidence: high when the listing clearly matches, medium when one detail is uncertain, low otherwise.
- source: where the values came from ("Beatport", "Qobuz", "Discogs", ...); sourceUrl: the listing's URL, or "".
- notes: one or two sentences, e.g. which release you matched and anything that disagrees with the current tags.`;
}

// ---------- SoundCloud free-download review ----------

export const SOUNDCLOUD_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    needsYou: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          artist: { type: 'string' }, title: { type: 'string' }, reason: { type: 'string' }, action: { type: 'string' },
        },
        required: ['artist', 'title', 'reason', 'action'],
        additionalProperties: false,
      },
    },
    possibleDuplicates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          artist: { type: 'string' }, title: { type: 'string' }, file: { type: 'string' }, ownedAs: { type: 'string' },
        },
        required: ['artist', 'title', 'file', 'ownedAs'],
        additionalProperties: false,
      },
    },
    nextSteps: { type: 'array', items: { type: 'string' } },
    resumeWorthIt: { type: 'boolean' },
  },
  required: ['summary', 'needsYou', 'possibleDuplicates', 'nextSteps', 'resumeWorthIt'],
  additionalProperties: false,
};

type SessionRow = Record<string, any>;

/** Buckets whose rows are worth reading one by one; the rest are only counted. */
const DETAIL_BUCKETS = ['downloaded', 'flagged', 'dropped', 'queue', 'notFree', 'probable', 'byHand'] as const;
const COUNT_BUCKETS = ['owned', 'alreadyDownloaded', 'mine', 'ignored'] as const;

/** A compact view of a soundcloud-likes session for the review prompt. */
export function summarizeSoundcloudSession(session: SessionRow): { counts: Record<string, number>; rows: SessionRow[] } {
  const counts: Record<string, number> = {};
  for (const b of [...DETAIL_BUCKETS, ...COUNT_BUCKETS]) {
    if (Array.isArray(session[b])) counts[b] = session[b].length;
  }
  const rows: SessionRow[] = [];
  for (const bucket of DETAIL_BUCKETS) {
    for (const r of (Array.isArray(session[bucket]) ? session[bucket] : []) as SessionRow[]) {
      const files = Array.isArray(r.outcome?.files)
        ? r.outcome.files.map((f: SessionRow) => `${path.basename(String(f.path ?? ''))} (${f.lossless ? 'lossless' : f.codec || f.ext || 'lossy'})`)
        : undefined;
      rows.push({
        bucket,
        artist: r.artist,
        title: r.title,
        status: r.outcome?.status,
        reason: r.outcome?.reason ?? r.free?.reason,
        gate: r.free?.gate?.host,
        link: r.free?.gate?.url ?? r.url,
        files,
        maybeOwned: r.libraryStatus === 'probable'
          ? { confidence: r.libraryConfidence, match: JSON.stringify(r.libraryMatch ?? '').slice(0, 160) }
          : undefined,
      });
    }
  }
  return { counts, rows };
}

export function buildSoundcloudReviewPrompt(sessionPath: string, session: SessionRow): string {
  const { counts, rows } = summarizeSoundcloudSession(session);
  return `A SoundCloud free-download run just finished in Candy Bar Manager. Review it for the DJ.

Session file: ${sessionPath} (read it if you need a field that isn't below)
Source: ${JSON.stringify(session.source ?? { kind: 'likes' })}
Stats: ${JSON.stringify(session.stats ?? {})}
Bucket counts: ${JSON.stringify(counts)}

Buckets: downloaded = every file lossless, in the intake folder. flagged = needs a look (lossy files kept under lossy/, stalled or unknown gates, emailed, needs-email, failed; the reason says which). dropped = lossy files deleted on purpose. queue = not fetched yet. notFree = no free copy (the reason says why). probable = may already be owned. byHand = the user fetched it themselves.

1. Duplicates: past runs found about half the fetched tracks were already in Rekordbox under different tags. Call check_library_for_tracks with the artist/title of the downloaded and flagged rows, and list the ones it reports owned or probable in possibleDuplicates, with ownedAs naming the library track. Don't delete or move anything; that's the user's call.
2. needsYou: rows a person has to act on, each with one concrete action. needs-email → "add an email in the job options and resume"; needs-you or Hypeddit Arcade → "open the gate in Chrome, finish it, then resume"; emailed → "check your inbox"; stalled or failed → "resume to retry"; lossy-only files → "keep or delete the MP3; it isn't DJ quality".
3. nextSteps: at most four short actions, most useful first. resumeWorthIt is true when any row would be retried by resuming (stalled, needs-you, failed, or needs-email once an email is given).
4. summary: two sentences: what landed, and what needs the user.

${HOUSE_RULES}

Rows:
${JSON.stringify(rows, null, 1)}`;
}
