/**
 * Rekordbox XML parser — extracts <TRACK> entries from an exported collection XML.
 * Used by Restore Library to compute the authoritative owned-track list.
 */
import fs from 'fs/promises';
import { recordWrite } from './writeJournal';

export type RekordboxTrack = {
  trackId: string;
  artist: string;
  title: string;
  album: string;
  label: string;
  genre: string;
  year: string;
  bpm: string;
  key: string;
  /** Decoded absolute path from the original Location attribute (no URI encoding). */
  origPath: string;
  /** Track length in seconds (TotalTime), when the XML carries it. */
  totalTime?: number;
};

/** Decode the XML entities an attribute value can carry (&amp; &apos; &#39; ...). */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, ent: string) => {
    const e = ent.toLowerCase();
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/** Escape a string for use inside a double-quoted XML attribute. */
function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeLocation(loc: string): string {
  try {
    const u = new URL(loc);
    return decodeURIComponent(u.pathname);
  } catch {
    try {
      return decodeURIComponent((loc || '').replace(/^file:\/\/localhost/, ''));
    } catch {
      return (loc || '').replace(/^file:\/\/localhost/, '');
    }
  }
}

/** Encode an absolute file path for a Rekordbox Location attribute (file://localhost + encodeURI). */
export function pathToLocation(absPath: string): string {
  // encodeURI leaves '#' and '?' unencoded, but in a file:// URL those begin the
  // fragment/query and would silently truncate the Location. Encode them explicitly.
  return 'file://localhost' + encodeURI(absPath).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

// One TRACK start tag. Quoted values may legally contain '>', so match quoted
// runs as units instead of stopping at the first '>'.
const TRACK_TAG_RE = /<TRACK\b((?:[^>"]|"[^"]*")*)>/g;
const ATTR_RE = /([\w:-]+)="([^"]*)"/g;

export type LocationUpdate = { trackId: string; newPath: string };
export type RewriteResult = {
  backupPath: string | null;
  updated: string[]; // trackIds whose Location was replaced
  notFound: string[]; // trackIds that didn't match any TRACK element
};

/**
 * Rewrite Location attributes for specific Rekordbox TrackIDs in-place.
 *
 * Uses targeted regex replacement (not DOM serialization) to minimize diff
 * against Rekordbox's exact output format — preserves ordering, whitespace,
 * and unrelated attributes. Backup is written to `<xmlPath>.backup-<iso>`
 * unless `{ backup: false }` is passed (useful for tests).
 */
export async function rewriteLocations(
  xmlPath: string,
  updates: LocationUpdate[],
  options: { backup?: boolean } = {},
): Promise<RewriteResult> {
  const backup = options.backup !== false;
  let xmlText = await fs.readFile(xmlPath, 'utf8');

  let backupPath: string | null = null;
  if (backup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${xmlPath}.backup-${stamp}`;
    await fs.writeFile(backupPath, xmlText);
  }

  // One pass over the TRACK start tags: look each TrackID up in the update map
  // and swap its Location within that tag only (never across elements). The
  // new value is XML-escaped and inserted via a function, so '&' or '$1' in a
  // path can't corrupt the document.
  const wanted = new Map<string, string>();
  for (const u of updates) wanted.set(u.trackId, escapeXmlAttr(pathToLocation(u.newPath)));
  const done = new Set<string>();
  xmlText = xmlText.replace(TRACK_TAG_RE, (tag) => {
    const idMatch = tag.match(/\bTrackID="([^"]*)"/);
    if (!idMatch) return tag;
    const trackId = decodeXmlEntities(idMatch[1]);
    const newLoc = wanted.get(trackId);
    if (newLoc === undefined || done.has(trackId)) return tag;
    if (!/\bLocation="[^"]*"/.test(tag)) return tag;
    done.add(trackId);
    return tag.replace(/\bLocation="[^"]*"/, () => `Location="${newLoc}"`);
  });
  const updated = updates.map(u => u.trackId).filter(id => done.has(id));
  const notFound = updates.map(u => u.trackId).filter(id => !done.has(id));

  if (updated.length > 0) {
    try {
      // Temp + rename so a crash mid-write can't leave a truncated collection.
      const tmp = `${xmlPath}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, xmlText);
      await fs.rename(tmp, xmlPath).catch(async (err) => { await fs.unlink(tmp).catch(() => {}); throw err; });
    } catch (err) {
      recordWrite({
        op: 'xml-rewrite', src: xmlPath, outcome: 'error', error: err instanceof Error ? err.message : String(err),
        detail: { backupPath, updated: updated.length, notFound: notFound.length },
      });
      throw err;
    }
    recordWrite({
      op: 'xml-rewrite', src: xmlPath, outcome: 'ok',
      detail: { backupPath, updated: updated.length, notFound: notFound.length, trackIds: updated },
    });
  }
  return { backupPath, updated, notFound };
}

const MAX_REKORDBOX_XML_BYTES = 500 * 1024 * 1024; // 500MB

export async function parseRekordboxXml(xmlPath: string): Promise<RekordboxTrack[]> {
  const stat = await fs.stat(xmlPath);
  if (stat.size > MAX_REKORDBOX_XML_BYTES) {
    throw new Error(
      `Rekordbox XML is too large to parse (${Math.round(stat.size / 1024 / 1024)}MB > 500MB). ` +
      `Split your collection or increase MAX_REKORDBOX_XML_BYTES.`
    );
  }
  const xml = await fs.readFile(xmlPath, 'utf8');
  const trackRe = new RegExp(TRACK_TAG_RE.source, 'g');
  const tracks: RekordboxTrack[] = [];
  let m: RegExpExecArray | null;
  while ((m = trackRe.exec(xml))) {
    const attrs: Record<string, string> = {};
    let a: RegExpExecArray | null;
    const block = m[1];
    const attrRe = new RegExp(ATTR_RE.source, 'g');
    // Attribute values are XML-escaped ("Above &amp; Beyond"); decode them.
    while ((a = attrRe.exec(block))) attrs[a[1]] = decodeXmlEntities(a[2]);
    if (!attrs.TrackID) continue;
    tracks.push({
      trackId: attrs.TrackID,
      artist: attrs.Artist || '',
      title: attrs.Name || '',
      album: attrs.Album || '',
      label: attrs.Label || '',
      genre: attrs.Genre || '',
      year: attrs.Year || '',
      bpm: attrs.AverageBpm || '',
      key: attrs.Tonality || '',
      origPath: decodeLocation(attrs.Location || ''),
      totalTime: Number(attrs.TotalTime) > 0 ? Number(attrs.TotalTime) : undefined,
    });
  }
  return tracks;
}
