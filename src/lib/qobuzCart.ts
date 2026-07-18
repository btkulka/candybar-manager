/**
 * Qobuz cart integration:
 * - Batch search missing tracks on Qobuz with fuzzy match scoring
 * - Playwright automation to add tracks to Qobuz shopping cart
 */

import type { Browser } from 'playwright';
import { searchQobuzTracks, QobuzTrack } from './qobuz';
import { searchBeatportTracks, BeatportTrack } from './beatport';
import { normalizeForComparison } from './stringUtils';
import { createScopedLogger } from './logger';
import { getErrorMessage } from './errorUtils';
import fuzzball from 'fuzzball';

const log = createScopedLogger('QobuzCart');

// ========== Types ==========

export type QobuzCartTrackInput = {
  key: string;
  artist: string;
  title: string;
  album?: string;
  duration?: number;
};

export type QobuzCartMatch = {
  trackInput: QobuzCartTrackInput;
  qobuzTrack: QobuzTrack | null;
  beatportTrack: BeatportTrack | null;
  confidence: number;
  source: 'qobuz' | 'beatport' | null;
  /** True iff we're confident the store offers a lossless version of this
   *  specific track. The user's library is DJ-grade; lossy matches must be
   *  flagged in the UI and excluded from cart-add. */
  lossless: boolean;
  status: 'matched' | 'no_match' | 'error';
  error?: string;
  /** True when a track with this artist+title already exists in the user's
   *  local music library (per the most recent cached Check scan). The UI uses
   *  this to skip auto-select and surface an "IN LIBRARY" badge so we don't
   *  nudge the user to re-buy what they already own on disk.
   *
   *  @deprecated Prefer `libraryStatus === 'confirmed'`. Kept for one release
   *  while renderer code transitions. */
  inLibrary?: boolean;
  /** Result of the library-match pre-pass. `confirmed` = high-confidence local
   *  file (≥0.90 fuzzy score), `probable` = uncertain (0.60-0.89 — store match
   *  still runs but the UI surfaces an amber "probable library match" chip),
   *  `missing` = not in library. Unset when the sourcing flow didn't do a
   *  library pre-pass. */
  libraryStatus?: 'confirmed' | 'probable' | 'missing';
  /** Path to the suspected library file (for `confirmed` and `probable`
   *  statuses). Used by the UI to show which file a probable match thinks it
   *  hit, so the user can decide whether to treat the row as missing. */
  libraryMatchPath?: string;
  /** Fuzzy score of the best library match (0..1). Only set when
   *  libraryStatus is 'confirmed' or 'probable'. */
  libraryMatchConfidence?: number;
};

export type CartTrack = {
  id: string;
  url: string;
  name: string;
  artists: string[];
};

export type CartAddProgress = {
  current: number;
  total: number;
  currentTrack: string;
  phase: 'launching' | 'logging_in' | 'adding' | 'complete' | 'error';
  message: string;
};

export type CartResult = {
  added: string[];
  failed: Array<{ id: string; error: string }>;
};

// ========== Batch Search ==========

/** Parse a quality string into a comparable numeric score (bit_depth * sampling_rate).
 *  Handles both "24/96" (search results: bitDepth/samplingRate) and "24bit/96kHz"
 *  (album API) — the search path feeds the former, so the bit/kHz-only regex never matched. */
function parseQualityScore(quality: string | null): number {
  if (!quality) return 0;
  const match = quality.match(/(\d+)\s*(?:bit)?\s*\/\s*([\d.]+)\s*(?:khz)?/i);
  if (!match) return 0;
  return Number(match[1]) * Number(match[2]);
}

function scoreMatch(track: QobuzCartTrackInput, candidateArtists: string[], candidateTitle: string): number {
  const trackArtist = normalizeForComparison(track.artist);
  const trackTitle = normalizeForComparison(track.title);
  const otherArtists = candidateArtists.map(a => normalizeForComparison(a)).join(' ');
  const otherTitle = normalizeForComparison(candidateTitle);

  const artistScore = Math.max(
    fuzzball.ratio(trackArtist, otherArtists),
    fuzzball.token_set_ratio(trackArtist, otherArtists),
    fuzzball.partial_ratio(trackArtist, otherArtists)
  ) / 100;

  const titleScore = Math.max(
    fuzzball.ratio(trackTitle, otherTitle),
    fuzzball.token_set_ratio(trackTitle, otherTitle),
    fuzzball.partial_ratio(trackTitle, otherTitle)
  ) / 100;

  const base = titleScore * 0.6 + artistScore * 0.4;
  // Cap at 1 so UI percentages don't show 108% for extended-mix winners.
  return Math.min(1, base + extendedMixBoost(track.title, candidateTitle));
}

const EXTENDED_MIX_RE = /\b(extended|club)\s*(mix|version|edit|remix)?\b/i;
const EXPLICIT_NON_EXTENDED_RE = /\b(radio|short|clean|single|album|instrumental|dub|acapella|a\s*cappella|intro|outro)\s*(edit|mix|version|cut)?\b/i;

/** DJ workflow: when the user's input title doesn't specify a version, prefer
 *  the Extended/Club Mix over the radio edit. Returns a small additive bonus
 *  that nudges ordering without overriding a significantly better base match. */
function extendedMixBoost(inputTitle: string, candidateTitle: string): number {
  if (!EXTENDED_MIX_RE.test(candidateTitle)) return 0;
  // If the user asked for a radio edit (or other explicit non-extended variant),
  // don't reward extended.
  if (EXPLICIT_NON_EXTENDED_RE.test(inputTitle)) return 0;
  // If the user explicitly asked for the extended mix, let the base score do
  // its job — don't double-count.
  if (EXTENDED_MIX_RE.test(inputTitle)) return 0;
  return 0.08;
}

export async function batchSearchQobuz(
  tracks: QobuzCartTrackInput[],
  onProgress?: (current: number, total: number, currentTrack: string) => void,
  onMatch?: (match: QobuzCartMatch) => void
): Promise<QobuzCartMatch[]> {
  const results: QobuzCartMatch[] = [];

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const label = `${track.artist} - ${track.title}`;
    onProgress?.(i + 1, tracks.length, label);

    try {
      const query = `${track.artist} ${track.title}`;

      // Query Qobuz and Beatport in parallel — we need to compare both to avoid
      // locking in a mediocre Qobuz match when Beatport has a better one (common
      // for EDM releases Beatport carries but Qobuz doesn't).
      const [qobuzTracks, beatportTracks] = await Promise.all([
        searchQobuzTracks(query).catch(err => {
          log.warn('Qobuz search failed for', label, err);
          return [] as QobuzTrack[];
        }),
        searchBeatportTracks(query).catch(err => {
          log.warn('Beatport search failed for', label, err);
          return [] as BeatportTrack[];
        }),
      ]);

      let bestQobuzMatch: QobuzTrack | null = null;
      let bestQobuzScore = 0;
      for (const qt of qobuzTracks) {
        const score = scoreMatch(track, qt.artists, qt.name);
        const quality = parseQualityScore(qt.quality);
        if (score > bestQobuzScore || (score === bestQobuzScore && quality > (bestQobuzMatch ? parseQualityScore(bestQobuzMatch.quality) : 0))) {
          bestQobuzScore = score;
          bestQobuzMatch = qt;
        }
      }

      let bestBeatportMatch: BeatportTrack | null = null;
      let bestBeatportScore = 0;
      for (const bt of beatportTracks) {
        const score = scoreMatch(track, bt.artists, bt.name);
        if (score > bestBeatportScore) {
          bestBeatportScore = score;
          bestBeatportMatch = bt;
        }
      }

      // Take whichever source has the strictly higher confidence match. We
      // always search both stores (above) so that an imperfect hit on one
      // source can't lock out a better hit on the other — e.g. a 100% Qobuz
      // match must never be overridden by a lower Beatport score. Beatport
      // only wins an exact tie (both stores lossless; Beatport's WAV is
      // RX3-compatible without conversion, so it's the better default when
      // confidence is genuinely equal).
      const qobuzOk = bestQobuzMatch && bestQobuzScore >= 0.50;
      const beatportOk = bestBeatportMatch && bestBeatportScore >= 0.50;
      const preferBeatport =
        beatportOk && (!qobuzOk || bestBeatportScore >= bestQobuzScore);
      const preferQobuz =
        qobuzOk && !preferBeatport;

      if (preferQobuz) {
        results.push({
          trackInput: track,
          qobuzTrack: bestQobuzMatch,
          beatportTrack: null,
          confidence: bestQobuzScore,
          source: 'qobuz',
          // Qobuz exposes `quality` (bitDepth/samplingRate) only for lossless
          // releases; null quality means we can't confirm lossless → flag it.
          lossless: Boolean(bestQobuzMatch!.quality),
          status: 'matched'
        });
      } else if (preferBeatport) {
        results.push({
          trackInput: track,
          qobuzTrack: null,
          beatportTrack: bestBeatportMatch,
          confidence: bestBeatportScore,
          source: 'beatport',
          // Beatport's catalog is primarily WAV; treat matches as lossless by
          // default. When per-track format data becomes available we should
          // verify instead of trust.
          lossless: true,
          status: 'matched'
        });
      } else {
        results.push({
          trackInput: track,
          qobuzTrack: bestQobuzMatch,
          beatportTrack: bestBeatportMatch,
          confidence: Math.max(bestQobuzScore, bestBeatportScore),
          source: null,
          lossless: false,
          status: 'no_match'
        });
      }
    } catch (err) {
      log.error('Batch search failed for track:', label, err);
      results.push({
        trackInput: track,
        qobuzTrack: null,
        beatportTrack: null,
        confidence: 0,
        source: null,
        lossless: false,
        status: 'error',
        error: getErrorMessage(err, 'Search failed')
      });
    }

    // Fire per-match event so the UI can render progress as tracks resolve
    // (running counts, preview art, etc.) rather than waiting for the full
    // batch.
    try { onMatch?.(results[results.length - 1]); } catch { /* non-fatal */ }

    // Rate-limit between requests
    if (i < tracks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return results;
}

// ========== Playwright Cart Automation ==========

let activeBrowser: Browser | null = null;

/** Dismiss the Qobuz CMP cookie-consent modal if it appears. Best-effort — the
 *  modal blocks clicks on the page beneath, so we must click it before doing
 *  anything else. The exact markup varies between Didomi and a custom overlay,
 *  so we try several selectors and fall back to matching button text. */
async function dismissQobuzConsent(page: import('playwright').Page): Promise<void> {
  const selectors = [
    '#didomi-notice-agree-button',
    'button#didomi-notice-agree-button',
    'button:has-text("Agree and close")',
    'button:has-text("Accept all")',
    'button:has-text("I agree")',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(500);
        return;
      }
    } catch { /* try next selector */ }
  }
}

export async function addTracksToQobuzCart(
  tracks: CartTrack[],
  onProgress?: (progress: CartAddProgress) => void
): Promise<CartResult> {
  // Close any previously leaked browser before launching a new one
  if (activeBrowser) {
    try { await activeBrowser.close(); } catch { /* already closed */ }
    activeBrowser = null;
  }

  const added: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  onProgress?.({
    current: 0, total: tracks.length,
    currentTrack: '', phase: 'launching',
    message: 'Launching browser...'
  });

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  activeBrowser = browser;

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    onProgress?.({
      current: 0, total: tracks.length,
      currentTrack: '', phase: 'logging_in',
      message: 'Please log in to Qobuz in the browser window...'
    });

    // /us-en/login 404s; /signin is the canonical Qobuz sign-in URL.
    await page.goto('https://www.qobuz.com/signin', { waitUntil: 'domcontentloaded' });
    await dismissQobuzConsent(page);

    // Wait for user to log in (up to 5 minutes). The sign-in page redirects to
    // an account area on success; the canonical signal is losing the /signin
    // (or legacy /login) segment.
    await page.waitForFunction(() => {
      const p = window.location.pathname;
      return !p.includes('/signin') && !p.includes('/login');
    }, { timeout: 300000 });

    // Add each track to cart
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const trackLabel = `${track.artists.join(', ')} - ${track.name}`;

      onProgress?.({
        current: i + 1, total: tracks.length,
        currentTrack: trackLabel, phase: 'adding',
        message: `Adding to cart: ${trackLabel}`
      });

      try {
        await page.goto(track.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await dismissQobuzConsent(page);
        await page.waitForTimeout(1000);

        // Look for "Add to cart" / "Buy" button
        const addButton = page.locator(
          'button:has-text("Add to cart"), ' +
          'button:has-text("Buy"), ' +
          '[data-testid="add-to-cart"], ' +
          '.purchasable-track button'
        ).first();

        if (await addButton.isVisible({ timeout: 5000 })) {
          await addButton.click();
          await page.waitForTimeout(1500);
          added.push(track.id);
        } else {
          failed.push({ id: track.id, error: 'Add to cart button not found' });
        }
      } catch (err) {
        log.error('Failed to add track to cart:', track.id, err);
        failed.push({
          id: track.id,
          error: getErrorMessage(err, 'Failed to add to cart')
        });
      }
    }

    onProgress?.({
      current: tracks.length, total: tracks.length,
      currentTrack: '', phase: 'complete',
      message: `Done: ${added.length} added, ${failed.length} failed`
    });
  } catch (err) {
    log.error('Browser automation failed:', err);
    onProgress?.({
      current: 0, total: tracks.length,
      currentTrack: '', phase: 'error',
      message: getErrorMessage(err, 'Browser automation failed')
    });
  } finally {
    // Ensure browser is always cleaned up
    try { await browser.close(); } catch { /* already closed */ }
    activeBrowser = null;
  }

  return { added, failed };
}

export async function closeQobuzBrowser(): Promise<void> {
  if (activeBrowser) {
    await activeBrowser.close();
    activeBrowser = null;
  }
}

export function isQobuzBrowserOpen(): boolean {
  return activeBrowser !== null && activeBrowser.isConnected();
}
