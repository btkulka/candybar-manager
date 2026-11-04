/**
 * Store-cart plumbing shared by the Sources and Upgrades tabs: which matches
 * may be pre-selected, the cart-add payload, pushing batches into the Qobuz
 * and Beatport carts, and reporting how that went.
 *
 * Only lossless matches ever reach a cart: payloads carry each match's real
 * `lossless`, callers filter on it, and the main process refuses anything that
 * isn't `true` and re-reads the Qobuz tier before every add.
 */

import type { QobuzCartMatch } from '../lib/qobuzCart';
import type { StoreCartProgress, StoreMatch } from '../types';
import { showToast, getErrorMessage, escapeHtml, isReleaseMatch } from './shared';

export type Store = 'qobuz' | 'beatport';
export const STORE_LABEL: Record<Store, string> = { qobuz: 'Qobuz', beatport: 'Beatport' };

/** Matches at or above this are pre-selected (when also lossless and the right version). */
export const AUTO_SELECT_CONFIDENCE = 0.75;
/** At or above this a match reads as "Exact match". */
export const EXACT_MATCH_CONFIDENCE = 0.9;

/** The match is for a different version than the one asked for: a remix of an
 *  original, the original of a remix, a sped-up edit. Still offered, flagged. */
export function isOtherVersion(m: QobuzCartMatch): boolean {
  return (m.scoreParts?.penalty ?? 0) > 0;
}

// ---------- Row wording shared by Find and buy and Upgrade quality ----------

/**
 * How sure the match is, as a word with the number in its tooltip:
 * "Exact match", "Close match", "Close match — check", plus the two flags that
 * always need a look before buying (a different version, a whole release).
 */
export function matchPillHtml(m: QobuzCartMatch): string {
  const pct = Math.round((m.confidence ?? 0) * 100);
  const sure = `Track Lab is ${pct}% sure this is the same track.`;
  const pill = (tone: string, label: string, tip: string) =>
    `<span class="status-pill status-pill--${tone} buy-match" tabindex="0" data-tooltip="${escapeHtml(tip)}">${escapeHtml(label)}</span>`;
  if (isOtherVersion(m)) {
    return pill('warn', 'Different version?', `This looks like a different version from the one in your list: a remix, the original or a sped-up edit. Listen before you buy. ${sure}`);
  }
  if (isReleaseMatch(m)) {
    return pill('warn', 'Whole release — check', `Qobuz matched the whole release, not this one track, so the name and price may be the release's. Open it on Qobuz before buying. ${sure}`);
  }
  if (m.confidence >= EXACT_MATCH_CONFIDENCE) return pill('ok', 'Exact match', sure);
  if (m.confidence >= AUTO_SELECT_CONFIDENCE) return pill('info', 'Close match', `${sure} Worth a quick listen.`);
  return pill('warn', 'Close match — check', `${sure} Listen before you buy.`);
}

/** "Full quality · 24-bit" with a plain explanation in its tooltip. */
export function qualityHtml(m: QobuzCartMatch): string {
  const raw = m.source === 'qobuz' ? m.qobuzTrack?.quality ?? '' : '';
  const bits = raw.match(/(\d+)\s*-?\s*bit/i)?.[1];
  const rate = raw.match(/([\d.]+)\s*kHz/i)?.[1];
  const label = bits ? `Full quality · ${bits}-bit` : 'Full quality';
  const detail = bits === '24'
    ? `Studio quality: 24-bit${rate ? `, ${rate} kHz` : ''}. Better than a CD.`
    : bits === '16'
      ? `CD quality: 16-bit${rate ? `, ${rate} kHz` : ''}.`
      : m.source === 'beatport' ? 'Beatport sells it as a full-quality (lossless) file.' : '';
  const tip = `Full quality (lossless) means nothing was thrown away to make the file smaller, unlike an MP3. ${detail}`.trim();
  return `<span class="term" tabindex="0" data-tooltip="${escapeHtml(tip)}">${escapeHtml(label)}</span>`;
}

/** The only copy for sale is compressed (MP3, AAC): shown, never carted. */
export function isCompressedOnly(m: QobuzCartMatch): boolean {
  return m.status === 'matched' && !m.lossless;
}

/** Why a track has nothing to buy, as a sentence. */
export function notForSaleReason(m: QobuzCartMatch): string {
  if (m.status === 'error') return "Track Lab couldn't search the stores for this one. Check the list again later.";
  if (isCompressedOnly(m)) {
    const store = m.source ? STORE_LABEL[m.source] : 'The store';
    const what = m.qobuzTrack?.quality ? ` (${m.qobuzTrack.quality})` : '';
    return `${store} only sells a compressed copy${what}, so it stays out of your cart.`;
  }
  return m.error || 'Not found in full quality on Qobuz or Beatport.';
}

/** A short status pill for a track with nothing to buy. */
export function notForSalePillHtml(m: QobuzCartMatch): string {
  if (m.status === 'error') return `<span class="status-pill status-pill--danger" tabindex="0" data-tooltip="${escapeHtml(m.error || 'The store search failed.')}">Search didn't work</span>`;
  if (isCompressedOnly(m)) return '<span class="status-pill status-pill--warn">Compressed only</span>';
  return '<span class="status-pill">Not found</span>';
}

/** Safe to pre-select: a confident, lossless match of the same version, by an
 *  artist that actually matched, and — on Qobuz — pinned to the one track on
 *  the release. A release-level Qobuz hit carries the whole release's title
 *  and price ("CRISIS VISION", $12.55), so it's offered but never pre-ticked. */
export function autoSelectable(m: QobuzCartMatch): boolean {
  if (m.status !== 'matched' || m.lossless !== true || m.confidence < AUTO_SELECT_CONFIDENCE) return false;
  if (isOtherVersion(m) || m.scoreParts?.artistFloored) return false;
  if (m.source === 'qobuz' && (m.albumLevel !== false || !m.qobuzTrack?.trackResolved)) return false;
  return true;
}

/** Parse a display price like "$2.99", "€1.29", "1.79 USD" into a number.
 *  Anything unparseable returns 0 so a missing price doesn't break the total. */
export function parsePriceDollars(raw: string | null | undefined): number {
  if (!raw) return 0;
  const m = raw.replace(/,/g, '.').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * The cart-add payload for one store's side of a search match. It carries the
 * match's real `lossless`; callers filter on it, and main refuses anything
 * that isn't `true`.
 *
 * A Qobuz match search couldn't pin to a track goes with an empty `trackId`
 * and its `albumId`, and the cart add resolves the track from the request.
 */
export function toStoreMatch(m: QobuzCartMatch, store: Store): StoreMatch {
  const input = { key: m.trackInput.key, artist: m.trackInput.artist, title: m.trackInput.title };
  if (store === 'qobuz') {
    const qt = m.qobuzTrack!;
    // Saved sessions from before track resolution have no albumId: their id IS the album.
    const albumId = qt.albumId ?? qt.id;
    const resolved = qt.trackResolved === true && qt.id !== albumId;
    return {
      input,
      trackId: resolved ? qt.id : '',
      albumId,
      title: qt.name,
      artist: qt.artists.join(', '),
      album: qt.album,
      label: '',
      price: qt.price ?? '',
      quality: qt.quality ?? '',
      format: 'lossless',
      lossless: m.lossless === true,
      rx3Compatible: false,
      confidence: m.confidence,
      url: qt.url,
      source: 'qobuz',
      image: qt.image,
      cartLink: resolved ? qt.cartLink : undefined,
      articleId: resolved ? qt.articleId : undefined,
    };
  }
  const bt = m.beatportTrack!;
  return {
    input,
    trackId: bt.id,
    title: bt.name,
    artist: bt.artists.join(', '),
    album: '',
    label: bt.label,
    price: bt.price ?? '',
    quality: '',
    format: 'lossless',
    lossless: m.lossless === true,
    rx3Compatible: false,
    confidence: m.confidence,
    url: bt.url,
    source: 'beatport',
  };
}

/** A resolved track by its id. An unresolved Qobuz release by release AND
 *  request: two different tracks wanted from one EP are two cart adds, not one. */
const trackKey = (m: StoreMatch) => m.trackId
  ? `${m.source}:${m.trackId}`
  : `${m.source}:album:${m.albumId ?? ''}:${m.input.key}`;

/** One entry per store track — two inputs can resolve to the same track. */
export function uniqueByTrack(items: StoreMatch[]): StoreMatch[] {
  const seen = new Set<string>();
  return items.filter(m => {
    if (seen.has(trackKey(m))) return false;
    seen.add(trackKey(m));
    return true;
  });
}

/** Everything put in a cart so far: earlier batches plus this one, newest last. */
export function mergeAdded(prev: StoreMatch[], added: StoreMatch[]): StoreMatch[] {
  const fresh = new Set(added.map(trackKey));
  return [...prev.filter(m => !fresh.has(trackKey(m))), ...added];
}

export type CartAddOutcome = {
  added: Record<Store, StoreMatch[]>;
  /** "Qobuz Title: reason" for every track that didn't go in. */
  failures: string[];
  /** Tracks the store says you already bought. */
  owned: string[];
};

/** One cart-add at a time across both tabs: they share the store sessions and
 *  the progress channel, and a second click mid-add would send the same
 *  tracks twice. */
let adding = false;
export function isAddingToCart(): boolean {
  return adding;
}

/** Push each store's batch into its cart, Qobuz then Beatport, reporting
 *  per-track progress. Never throws: a failed store is recorded and the other
 *  still runs. Callers check isAddingToCart() first. */
export async function addToStoreCarts(
  batches: Partial<Record<Store, StoreMatch[]>>,
  onProgress: (store: Store, p: { current: number; total: number; message: string; currentTrack?: string }) => void
): Promise<CartAddOutcome> {
  const outcome: CartAddOutcome = { added: { qobuz: [], beatport: [] }, failures: [], owned: [] };
  adding = true;
  try {
    await addBatches(batches, onProgress, outcome);
  } finally {
    adding = false;
  }
  for (const f of outcome.failures) console.log('[cart-fail]', f);
  return outcome;
}

async function addBatches(
  batches: Partial<Record<Store, StoreMatch[]>>,
  onProgress: Parameters<typeof addToStoreCarts>[1],
  outcome: CartAddOutcome
): Promise<void> {
  for (const store of ['qobuz', 'beatport'] as const) {
    const items = uniqueByTrack(batches[store] ?? []);
    if (items.length === 0) continue;
    const label = STORE_LABEL[store];
    onProgress(store, { current: 0, total: items.length, message: `Signing in to ${label}…` });
    const off = window.candybar.onStoreCartProgress((p: StoreCartProgress) => onProgress(store, p));
    try {
      const res = await window.candybar.storeCartAdd(items, store);
      if (res.success && res.result) {
        outcome.added[store] = res.result.added;
        for (const f of res.result.failed) {
          if (/already purchased|you own this track/i.test(f.error)) outcome.owned.push(`${label} ${f.match.title}`);
          else outcome.failures.push(`${label} ${f.match.title}: ${f.error}`);
        }
      } else {
        outcome.failures.push(`${label}: ${res.error ?? 'failed'}`);
      }
    } catch (err) {
      outcome.failures.push(`${label}: ${getErrorMessage(err)}`);
    } finally {
      off();
    }
  }
}

/** One toast summarizing a cart-add. */
export function toastCartOutcome({ added, failures, owned }: CartAddOutcome): void {
  const total = added.qobuz.length + added.beatport.length;
  const n = (k: number) => `${k.toLocaleString()} ${k === 1 ? 'track' : 'tracks'}`;
  const ownedSuffix = owned.length > 0 ? ` ${n(owned.length)} you already bought ${owned.length === 1 ? 'was' : 'were'} left out.` : '';
  if (total > 0 && failures.length === 0) {
    showToast('success', 'Added to your carts', `${n(total)} added. Nothing is bought until you check out.${ownedSuffix}`);
  } else if (total > 0) {
    showToast('warning', "Some tracks didn't go in", `${n(total)} added; ${n(failures.length)} couldn't be added.${ownedSuffix}`);
  } else if (owned.length > 0 && failures.length === 0) {
    showToast('info', 'You already bought these', `The store says you already own all ${n(owned.length)}.`);
  } else {
    showToast('error', "Couldn't add to your carts", failures[0] ?? "The store didn't accept the tracks. Try again in a moment.");
  }
}

/** Scroll the page's own scroller (.content) so `el` shows — never the window
 *  or the app shell, which scrollIntoView can shift. */
export function revealInContent(el: HTMLElement | null, where: 'start' | 'nearest' = 'nearest'): void {
  const box = el?.closest<HTMLElement>('.content');
  if (!el || !box) return;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  let top: number | null = null;
  if (where === 'start' || r.top < b.top) top = box.scrollTop + (r.top - b.top) - 16;
  else if (r.bottom > b.bottom) top = box.scrollTop + Math.min(r.bottom - b.bottom + 16, r.top - b.top - 16);
  if (top !== null) box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}
