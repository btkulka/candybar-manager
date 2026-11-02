/**
 * Key / BPM / remixer, as the app should see them from a parsed file.
 *
 * music-metadata maps the standard ID3 frames to `common.key`, `common.bpm`
 * and `common.remixer` (TKEY / TBPM / TPE4). Two things went wrong here before:
 *
 *  - The app read `common.remixedBy`, a field music-metadata has never had, so
 *    the remixer never came back from any file, MP3 included.
 *  - On AIFF the ffmpeg write passed `initialkey=` / `bpm=` / `remixer=`, keys
 *    ffmpeg has no ID3 mapping for, so they were written as TXXX custom frames
 *    that neither music-metadata nor Rekordbox treat as key / BPM / remixer.
 *
 * Files tagged during that window still carry the values in those TXXX frames.
 * Reading them as a fallback keeps what the user typed visible; the next save
 * rewrites them into the proper frames (see updateTagsFfmpeg).
 */
import type { IAudioMetadata } from 'music-metadata';

export interface DjTags {
  key: string;
  bpm: string;
  remixer: string;
}

/** TXXX descriptions the legacy ffmpeg write produced, per field. */
const LEGACY_TXXX: Record<keyof DjTags, string> = {
  key: 'initialkey',
  bpm: 'bpm',
  remixer: 'remixer',
};

function legacyTxxx(meta: IAudioMetadata): Map<string, string> {
  const out = new Map<string, string>();
  for (const [format, tags] of Object.entries(meta.native || {})) {
    if (!format.startsWith('ID3v2')) continue;
    for (const tag of tags) {
      // music-metadata reports a user frame as id "TXXX:<description>" with a
      // string value; older shapes carried { description, text }. Take both.
      let description: string | undefined;
      let text: unknown;
      if (tag.id.startsWith('TXXX:')) {
        description = tag.id.slice(5);
        text = tag.value;
      } else if (tag.id === 'TXXX') {
        const v = tag.value as { description?: string; text?: unknown } | null;
        description = v?.description;
        text = v?.text;
      }
      if (description && text != null && text !== '') out.set(description.toLowerCase(), String(text));
    }
  }
  return out;
}

function first(value: unknown): string {
  const v = Array.isArray(value) ? value[0] : value;
  return v == null || v === '' ? '' : String(v);
}

export function readDjTags(meta: IAudioMetadata): DjTags {
  const common = meta.common as unknown as Record<string, unknown>;
  let legacy: Map<string, string> | null = null;
  const pick = (field: keyof DjTags): string => {
    const standard = first(common[field]);
    if (standard) return standard;
    legacy ??= legacyTxxx(meta);
    return legacy.get(LEGACY_TXXX[field]) || '';
  };
  return { key: pick('key'), bpm: pick('bpm'), remixer: pick('remixer') };
}
