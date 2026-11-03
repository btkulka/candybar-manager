/**
 * What a downloaded file really is, from its first bytes. A store's URL or
 * filename can say ".aiff" for a WAV, or nothing at all; the bytes can't lie.
 * Mirrors sniffFormat in lib/sourcing/downloads.mjs.
 */

export type SniffedAudio = {
  /** Extension to save under, or null when the bytes aren't a known container. */
  ext: string | null;
  /** null when the container alone can't say (an .m4a may be AAC or ALAC). */
  lossless: boolean | null;
};

export function sniffAudio(buf: Uint8Array): SniffedAudio {
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  const s4 = ascii(0, 4);
  const s8 = ascii(8, 12);
  if (s4 === 'RIFF' && s8 === 'WAVE') return { ext: 'wav', lossless: true };
  if (s4 === 'FORM' && (s8 === 'AIFF' || s8 === 'AIFC')) return { ext: s8 === 'AIFC' ? 'aifc' : 'aiff', lossless: true };
  if (s4 === 'fLaC') return { ext: 'flac', lossless: true };
  if (s4 === 'OggS') return { ext: 'ogg', lossless: false };
  if (s4.startsWith('ID3')) return { ext: 'mp3', lossless: false };
  if (buf[0] === 0xff && (buf[1] & 0xe6) === 0xe2) return { ext: 'mp3', lossless: false };
  if (ascii(4, 8) === 'ftyp') return { ext: 'm4a', lossless: null };
  return { ext: null, lossless: null };
}

const TYPE_EXT: Record<string, string> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
};

/** Extension from a download URL's PATH (signed URLs end in a query string,
 *  so matching the whole URL never sees it), else from the Content-Type. */
export function extFromUrlOrType(url: string, contentType?: string | null): string | null {
  try {
    const m = new URL(url).pathname.match(/\.(wav|aiff?|aifc|flac|mp3|m4a)$/i);
    if (m) return m[1].toLowerCase() === 'aif' ? 'aiff' : m[1].toLowerCase();
  } catch { /* not a URL */ }
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  return TYPE_EXT[type] ?? null;
}
