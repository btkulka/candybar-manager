/**
 * Rekordbox XML parser — extracts <TRACK> entries from an exported collection XML.
 * Used by Restore Library to compute the authoritative owned-track list.
 */
import fs from 'fs/promises';

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
};

function decodeLocation(loc: string): string {
  try {
    const u = new URL(loc);
    return decodeURIComponent(u.pathname);
  } catch {
    return decodeURIComponent((loc || '').replace(/^file:\/\/localhost/, ''));
  }
}

/** Encode an absolute file path for a Rekordbox Location attribute (file://localhost + encodeURI). */
export function pathToLocation(absPath: string): string {
  return 'file://localhost' + encodeURI(absPath);
}

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

  const updated: string[] = [];
  const notFound: string[] = [];
  for (const u of updates) {
    const newLoc = pathToLocation(u.newPath);
    const escId = u.trackId.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    const rx = new RegExp(
      `(<TRACK\\b[^>]*\\bTrackID="${escId}"[\\s\\S]*?\\bLocation=")[^"]*(")`,
    );
    const before = xmlText;
    xmlText = xmlText.replace(rx, `$1${newLoc}$2`);
    if (xmlText === before) notFound.push(u.trackId);
    else updated.push(u.trackId);
  }

  if (updated.length > 0) await fs.writeFile(xmlPath, xmlText);
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
  const trackRe = /<TRACK\s+([^>]*?)(?:\/>|>)/g;
  const attrRe = /(\w+)="([^"]*)"/g;
  const tracks: RekordboxTrack[] = [];
  let m: RegExpExecArray | null;
  while ((m = trackRe.exec(xml))) {
    const attrs: Record<string, string> = {};
    let a: RegExpExecArray | null;
    const block = m[1];
    while ((a = attrRe.exec(block))) attrs[a[1]] = a[2];
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
    });
  }
  return tracks;
}
