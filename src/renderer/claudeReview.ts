import type { QobuzCartMatch } from '../lib/qobuzCart';
import type { LibraryProbableRow, SourcingReviewResult, SourcingReviewRow, SourcingVerdict, SourcingVerdictKind } from '../types';
import { escapeHtml, showToast, plural, isReleaseMatch } from './shared';
import { isOtherVersion } from './storeCart';
import { startClaudeJob, ensureClaudeReady, ClaudeJobError, type ClaudeJobHandle } from './claudeJobs';

// "Check with Claude" on Find & buy: Claude reads every row that has a
// full-quality store match and says buy, skip (already yours), wrong record,
// or listen first. Its verdicts tick and untick rows; nothing reaches a cart
// until the user presses Add to carts.

/** What Find & buy hands over: its rows, and a way to apply verdicts to them. */
export type SourcingReviewHost = {
  /** Rows with a full-quality store match: New to buy plus Maybe already owned. */
  rows: () => { match: QobuzCartMatch; probable?: LibraryProbableRow }[];
  /** Untick skip / wrong / flag rows and tick confirmed full-quality buys, then re-render. */
  apply: (items: { match: QobuzCartMatch; verdict: SourcingVerdict }[]) => void;
};

const STORAGE_KEY = 'candybar-claude-verdicts';
const MAX_KEPT = 2000;

let host: SourcingReviewHost | null = null;
let running: ClaudeJobHandle<SourcingReviewResult> | null = null;
let verdicts = loadVerdicts();

/** A verdict belongs to one wanted track and one store link, so a later list
 *  that links the same track to another record doesn't inherit it. */
function rowKey(m: QobuzCartMatch): string {
  const storeId = m.source === 'qobuz' ? m.qobuzTrack?.id : m.beatportTrack?.id;
  return `${m.trackInput.key}|${m.source}:${storeId ?? ''}`;
}

function loadVerdicts(): Map<string, SourcingVerdict> {
  try {
    return new Map(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return new Map();
  }
}

function saveVerdicts(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...verdicts].slice(-MAX_KEPT)));
  } catch {
    // Storage full or unavailable: verdicts just won't survive a reload.
  }
}

const VERDICT_LABEL: Record<SourcingVerdictKind, string> = {
  buy: 'Right record',
  skip: 'You already have this',
  wrong: 'Wrong record',
  flag: 'Listen before buying',
};

/** The verdict line for a row, or '' when Claude hasn't checked it. */
export function claudeVerdictHtml(m: QobuzCartMatch): string {
  const v = verdicts.get(rowKey(m));
  if (!v) return '';
  return `<span class="sub claude-verdict claude-verdict--${v.verdict}">Claude: ${VERDICT_LABEL[v.verdict]}.${v.note ? ` ${escapeHtml(v.note)}` : ''}</span>`;
}

function toReviewRow(id: string, m: QobuzCartMatch, probable?: LibraryProbableRow): SourcingReviewRow | null {
  const track = m.source === 'qobuz' ? m.qobuzTrack : m.source === 'beatport' ? m.beatportTrack : null;
  if (!track || !m.source) return null;
  return {
    id,
    wanted: { artist: m.trackInput.artist, title: m.trackInput.title, album: m.trackInput.album },
    library: probable
      ? { ownedArtist: probable.suspectedFileArtist, ownedTitle: probable.suspectedFileTitle, confidence: probable.confidence, reason: probable.reason }
      : undefined,
    store: {
      source: m.source,
      artists: track.artists,
      title: track.name,
      remixers: m.beatportTrack?.remixers,
      release: m.qobuzTrack?.album,
      label: m.beatportTrack?.label,
      confidence: Math.round(m.confidence * 100) / 100,
      versionFlag: isOtherVersion(m),
      releaseLevel: isReleaseMatch(m),
      note: m.note,
    },
  };
}

function setButtonState(btn: HTMLButtonElement, busy: boolean): void {
  btn.classList.toggle('is-busy', busy);
  btn.innerHTML = busy
    ? `${SPINNER_SVG}<span>Checking… stop</span>`
    : `${CHECK_SVG}<span>Check with Claude</span>`;
  btn.dataset.tooltip = busy
    ? 'Claude is reading each match. Click to stop.'
    : 'Claude reads each match and spots tracks you already have, wrong records and other versions. Nothing is added to a cart.';
}

async function runReview(btn: HTMLButtonElement): Promise<void> {
  if (running) {
    running.cancel();
    return;
  }
  if (!host) return;
  const items = host.rows();
  const rows: SourcingReviewRow[] = [];
  const byId = new Map<string, QobuzCartMatch>();
  items.forEach(({ match, probable }, i) => {
    const row = toReviewRow(`r${i + 1}`, match, probable);
    if (!row) return;
    rows.push(row);
    byId.set(row.id, match);
  });
  if (rows.length === 0) {
    showToast('info', 'Nothing to check', 'There are no full-quality matches in this list for Claude to check.');
    return;
  }
  if (!await ensureClaudeReady()) return;

  setButtonState(btn, true);
  try {
    running = await startClaudeJob<SourcingReviewResult>('claude-sourcing-review', { rows });
    const result = await running.result;
    const applied: { match: QobuzCartMatch; verdict: SourcingVerdict }[] = [];
    for (const v of result.verdicts) {
      const match = byId.get(v.id);
      if (!match) continue;
      verdicts.set(rowKey(match), v);
      applied.push({ match, verdict: v });
    }
    saveVerdicts();
    host.apply(applied);
    const count = (k: SourcingVerdictKind) => applied.filter(a => a.verdict.verdict === k).length;
    const unticked = count('skip') + count('wrong') + count('flag');
    showToast(
      'success',
      `Claude checked ${plural(applied.length, 'track')}`,
      `${result.summary}${unticked ? ` ${plural(unticked, 'track')} unticked.` : ''} Nothing is in a cart until you add it.`,
      10000,
    );
  } catch (err) {
    if (!(err instanceof ClaudeJobError && err.cancelled)) {
      showToast('error', 'Claude couldn\'t check the matches', err instanceof Error ? err.message : String(err));
    }
  } finally {
    running = null;
    if (btn.isConnected) setButtonState(btn, false);
  }
}

/** Put the button beside Add to carts. Safe to call again after a re-render. */
export function ensureSourcingReviewButton(): void {
  if (!host) return;
  const anchor = document.getElementById('source-add-to-cart');
  if (!anchor?.parentElement) return;
  let btn = document.getElementById('source-claude-review') as HTMLButtonElement | null;
  if (btn && btn.nextElementSibling === anchor) return;
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'source-claude-review';
    btn.className = 'btn-secondary btn-sm claude-review-btn';
    setButtonState(btn, !!running);
    btn.addEventListener('click', () => void runReview(btn!));
  }
  anchor.parentElement.insertBefore(btn, anchor);
}

/** Called once by Find & buy to hand over its rows. */
export function attachSourcingReview(h: SourcingReviewHost): void {
  host = h;
  ensureSourcingReviewButton();
}

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/><polyline points="9 11 11 13 15 9"/></svg>';
export const SPINNER_SVG = '<svg class="claude-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>';
