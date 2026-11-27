// ============================================================
// Track Lab on the phone (mobile.html): Find and buy, and only that.
// Pick a playlist (search Spotify, paste a Spotify or SoundCloud set
// link, or one of Your playlists), let the Mac check it against the
// library and the stores, tick what to buy, put it in the real Beatport
// and Qobuz carts, then open each store's cart to check out on the phone.
//
// Every call is the desktop app's own handler, over the web host
// (src/lib/webHost.ts), with the same rules: only lossless matches are
// ticked or carted, nothing in the library is nudged into a re-buy, and
// nothing is bought until checkout in the store.
// ============================================================

window.addEventListener('error', (e) => console.error('[Mobile] Uncaught error:', e.error?.message || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[Mobile] Unhandled rejection:', e.reason));

import type { QobuzCartMatch } from './lib/qobuzCart';
import type { LibraryMatchedRow, LibraryProbableRow, SavedSource, SavedSourceCounts, SavedSourceKind, SourcePlaylistInfo, StoreMatch } from './types';
import { cartUrl } from './lib/storeUrls';
import { queueKey, type CartQueueState } from './lib/cartQueue';
import { escapeHtml, formatPriceTotal, getErrorMessage, isReleaseMatch, plural, showToast } from './renderer/shared';
import {
  STORE_LABEL, addToStoreCarts, autoSelectable, isOtherVersion, isAddingToCart, mergeAdded, notForSaleReason, parsePriceDollars,
  toStoreMatch, toastCartOutcome, uniqueByTrack, type Store,
} from './renderer/storeCart';

type Source = { kind: SavedSourceKind; ref: string; name: string };
type RunResult = { matched: LibraryMatchedRow[]; probable: LibraryProbableRow[]; storeMatches: QobuzCartMatch[] };
/** What the phone keeps between visits: the last check, its ticks, and what went in the carts. */
type Saved = {
  source: Source;
  info: SourcePlaylistInfo | null;
  result: RunResult;
  selected: string[];
  added: Record<Store, StoreMatch[]>;
  /** Beatport tracks this phone queued for Track Lab's Beatport sign-in (queueKey). */
  queued?: string[];
  at: number;
};

const STATE_KEY = 'tracklab.mobile.v1';
const SPOTIFY_PLAYLIST = /open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/[a-zA-Z0-9]+|^spotify:playlist:[a-zA-Z0-9]+$/;
const SOUNDCLOUD_SET = /^(https?:\/\/)?(www\.|m\.)?soundcloud\.com\/[^/?#\s]+\/sets\/[^/?#\s]+|^(https?:\/\/)?on\.soundcloud\.com\/[A-Za-z0-9]+/i;
const LINKISH = /^[a-z][a-z0-9+.-]*:\/\/|^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/\S|^spotify:/i;
const NOTE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const OPEN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let state: Saved | null = null;
let selected = new Set<string>();
let added: Record<Store, StoreMatch[]> = { qobuz: [], beatport: [] };
/** What this phone put in the cart queue and hasn't seen go in yet (queueKey). */
let queued = new Set<string>();
/** The Mac's cart queue, as last read. */
let cartQueue: CartQueueState = { pending: [], added: [], failed: [] };
let savedSources: SavedSource[] = [];
let running = false;
let signedIn: Record<Store, boolean | null> = { qobuz: null, beatport: null };
let storesChecked = false;

// ---------- Small helpers ----------

const keyOf = (m: QobuzCartMatch) => m.trackInput.key;
const storeOf = (m: QobuzCartMatch): Store | null =>
  m.source === 'qobuz' && m.qobuzTrack ? 'qobuz' : m.source === 'beatport' && m.beatportTrack ? 'beatport' : null;
const hasLossless = (m: QobuzCartMatch) => m.status === 'matched' && m.lossless === true && storeOf(m) !== null;
const freeFailed = (m: QobuzCartMatch) => !!m.freeOutcome && !m.freeOutcome.filePath;
const inFreeGroup = (m: QobuzCartMatch) => !!m.free && m.libraryStatus !== 'probable' && !freeFailed(m);

/** The page's groups, as the desktop's Find and buy draws them. */
function groups(matches: QobuzCartMatch[]) {
  return {
    toBuy: matches.filter(m => hasLossless(m) && m.libraryStatus !== 'probable' && !inFreeGroup(m)),
    maybe: matches.filter(m => hasLossless(m) && m.libraryStatus === 'probable'),
    free: matches.filter(m => inFreeGroup(m)),
    notForSale: matches.filter(m => !hasLossless(m) && !inFreeGroup(m)),
  };
}

function countsFor(r: RunResult): SavedSourceCounts {
  const g = groups(r.storeMatches);
  return { toBuy: g.toBuy.length, maybeOwned: g.maybe.length, owned: r.matched.length, notForSale: g.notForSale.length };
}

/** Ticked, lossless, one entry per store track. */
function cartBatch(store: Store): StoreMatch[] {
  if (!state) return [];
  return uniqueByTrack(state.result.storeMatches
    .filter(m => selected.has(keyOf(m)) && hasLossless(m) && storeOf(m) === store)
    .map(m => toStoreMatch(m, store)));
}

function total(items: StoreMatch[]): string {
  return formatPriceTotal(items.reduce((s, t) => s + parsePriceDollars(t.price), 0), items.map(t => t.price));
}

function ago(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** Spotify sends playlist descriptions HTML-escaped ("Covers &amp; Remixes"). */
function decodeEntities(text: string): string {
  return new DOMParser().parseFromString(`<!doctype html><body>${text}`, 'text/html').body.textContent ?? text;
}

function art(url: string | null | undefined, cls = 'm-art'): string {
  return url
    ? `<img class="${cls}" src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<div class="${cls} m-art--empty">${NOTE_SVG}</div>`;
}

function show(screen: 'pick' | 'run' | 'results') {
  $('m-pick').hidden = screen !== 'pick';
  $('m-run').hidden = screen !== 'run';
  $('m-results').hidden = screen !== 'results';
  window.scrollTo({ top: 0 });
  renderBar();
}

function persist() {
  if (!state) return localStorage.removeItem(STATE_KEY);
  state.selected = [...selected];
  state.added = added;
  state.queued = [...queued];
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[Mobile] Could not keep the check on this phone:', err);
  }
}

function restore(): boolean {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw) as Saved;
    if (!s?.result?.storeMatches || !s.source) return false;
    state = s;
    selected = new Set(s.selected ?? []);
    added = { qobuz: s.added?.qobuz ?? [], beatport: s.added?.beatport ?? [] };
    queued = new Set(s.queued ?? []);
    return true;
  } catch {
    return false;
  }
}

// ---------- Store sign-in ----------

/**
 * Whether Track Lab's store accounts on the Mac are signed in. Beatport's is
 * read from the session itself (a cart check, which also hands Track Lab the
 * token its search and cart need); the login status alone counts a session
 * Beatport has since ended. A Qobuz shop session that lapsed reads signed out
 * but usually renews itself when a cart add opens Qobuz on the Mac.
 */
async function refreshStores() {
  try {
    const s = await window.candybar.storeLoginStatus();
    signedIn = { qobuz: s.qobuz, beatport: s.beatport };
    if (s.beatport) {
      const check = await window.candybar.storeCartCheck('beatport', [{ trackId: '0' }]);
      if (!check.known && /not signed in/i.test(check.reason)) signedIn.beatport = false;
    }
  } catch {
    signedIn = { qobuz: null, beatport: null };
  }
  storesChecked = true;
  renderStores();
  renderBar();
}

function renderStores() {
  $('m-stores').innerHTML = (['beatport', 'qobuz'] as const).map(store => {
    const on = signedIn[store];
    const tone = on === true ? 'ok' : on === false ? 'warn' : 'info';
    const tip = on === true ? 'signed in'
      : on === false ? (store === 'qobuz' ? 'signed out: Track Lab renews it on the Mac when it adds to the cart' : 'signed out: sign in to Beatport in Track Lab on the Mac, once each time it starts')
      : storesChecked ? "couldn't tell" : 'checking…';
    return `<span class="status-pill status-pill--${tone} m-store-pill" title="${STORE_LABEL[store]}: ${tip}">${STORE_LABEL[store]}</span>`;
  }).join('');
}

// ---------- Pick a playlist ----------

let searchTimer: number | undefined;
let searchSeq = 0;

function onInput() {
  const v = $<HTMLInputElement>('m-input').value.trim();
  const help = $('m-help');
  const runLink = $<HTMLButtonElement>('m-run-link');
  const results = $('m-search-results');
  window.clearTimeout(searchTimer);
  runLink.hidden = true;
  help.className = 'm-help';
  if (!v) {
    results.hidden = true;
    help.textContent = 'A Spotify playlist or a SoundCloud set. Track Lab checks it against your library and finds full-quality copies on Beatport and Qobuz.';
    return;
  }
  if (SPOTIFY_PLAYLIST.test(v) || SOUNDCLOUD_SET.test(v)) {
    results.hidden = true;
    help.textContent = SOUNDCLOUD_SET.test(v) ? 'SoundCloud set. Ready to check.' : 'Spotify playlist. Ready to check.';
    help.classList.add('m-help--ok');
    runLink.hidden = false;
    return;
  }
  if (LINKISH.test(v)) {
    results.hidden = true;
    help.textContent = /soundcloud/i.test(v)
      ? "That's a SoundCloud link, but not to a set. A set link has /sets/ in it."
      : /spotify/i.test(v)
        ? "That's a Spotify link, but not to a playlist. Share the playlist's link instead."
        : 'Paste a link to a Spotify playlist or a SoundCloud set.';
    help.classList.add('m-help--error');
    return;
  }
  help.textContent = 'Searching Spotify playlists…';
  searchTimer = window.setTimeout(() => void searchSpotify(v), 350);
}

async function searchSpotify(q: string) {
  const seq = ++searchSeq;
  const results = $('m-search-results');
  const help = $('m-help');
  try {
    const res = await window.candybar.spotifySearch(q, { types: ['playlist'], limit: 12, offset: 0 });
    if (seq !== searchSeq) return;
    const items = (res.playlist?.items ?? []) as Array<{ url: string; name: string; subtitle: string; meta: string; imageUrl: string | null }>;
    help.textContent = items.length ? 'Pick a playlist, or paste a link.' : 'No playlists found. Paste the playlist\'s link instead.';
    results.innerHTML = items.map((it, i) => `
      <li><button class="m-item" data-i="${i}">
        ${art(it.imageUrl)}
        <span class="m-item-text"><span class="m-item-title">${escapeHtml(decodeEntities(it.name))}</span>
        <span class="m-item-sub">${escapeHtml(decodeEntities([it.subtitle, it.meta].filter(Boolean).join(' · ')))}</span></span>
      </button></li>`).join('');
    results.hidden = items.length === 0;
    results.querySelectorAll<HTMLButtonElement>('.m-item').forEach(btn => btn.addEventListener('click', () => {
      const it = items[Number(btn.dataset.i)];
      void run({ kind: 'spotify', ref: it.url, name: it.name });
    }));
  } catch (err) {
    if (seq !== searchSeq) return;
    results.hidden = true;
    help.textContent = /credentials/i.test(getErrorMessage(err))
      ? "Spotify search needs Track Lab's Spotify keys (Settings on the Mac). Paste the playlist's link instead."
      : `Couldn't search Spotify: ${getErrorMessage(err)}`;
    help.classList.add('m-help--error');
  }
}

function runPasted() {
  const v = $<HTMLInputElement>('m-input').value.trim();
  if (SOUNDCLOUD_SET.test(v)) void run({ kind: 'soundcloud', ref: v, name: '' });
  else if (SPOTIFY_PLAYLIST.test(v)) void run({ kind: 'spotify', ref: v, name: '' });
}

async function loadSaved() {
  const list = $('m-saved');
  try {
    const res = await window.candybar.savedSourcesList();
    savedSources = (res.success && res.sources ? res.sources : []).sort((a, b) => b.lastCheckedAt - a.lastCheckedAt);
  } catch (err) {
    list.innerHTML = `<li class="m-empty">Couldn't read your playlists: ${escapeHtml(getErrorMessage(err))}</li>`;
    return;
  }
  if (savedSources.length === 0) {
    list.innerHTML = '<li class="m-empty">Playlists you check show up here, to check again in one tap.</li>';
    return;
  }
  list.innerHTML = savedSources.map(s => `
    <li><button class="m-item" data-id="${s.id}">
      ${art(s.imageUrl)}
      <span class="m-item-text"><span class="m-item-title">${escapeHtml(s.name)}</span>
      <span class="m-item-sub">${escapeHtml([plural(s.trackCount, 'track'), s.counts.toBuy > 0 ? `${s.counts.toBuy.toLocaleString()} to buy` : 'nothing new', ago(s.lastCheckedAt)].join(' · '))}</span></span>
      <span class="m-kind m-kind--${s.kind}">${s.kind === 'csv' ? 'CSV' : s.kind === 'soundcloud' ? 'SoundCloud' : 'Spotify'}</span>
    </button></li>`).join('');
  list.querySelectorAll<HTMLButtonElement>('.m-item').forEach(btn => btn.addEventListener('click', () => {
    const s = savedSources.find(x => x.id === Number(btn.dataset.id));
    if (s) void run({ kind: s.kind, ref: s.ref, name: s.name });
  }));
}

// ---------- Check ----------

function playlistCard(info: SourcePlaylistInfo | null, source: Source, extra = ''): string {
  const name = info?.name || source.name || (source.kind === 'soundcloud' ? 'SoundCloud set' : source.kind === 'csv' ? 'Spreadsheet' : 'Spotify playlist');
  const bits = [info?.owner ? `by ${info.owner}` : '', info ? plural(info.fetchedCount || info.trackCount, 'track') : ''].filter(Boolean).join(' · ');
  return `${art(info?.imageUrl, 'm-cover')}<div class="m-card-text"><div class="m-card-title">${escapeHtml(name)}</div>
    ${bits ? `<div class="m-card-sub">${escapeHtml(bits)}</div>` : ''}${extra}</div>`;
}

async function run(source: Source) {
  if (running) return;
  if (isAddingToCart()) return;
  running = true;
  // Filled by the playlist-info event while the check runs.
  const got: { info: SourcePlaylistInfo | null } = { info: null };
  const card = $('m-run-card');
  const bar = $('m-run-bar');
  const msg = $('m-run-msg');
  const sub = $('m-run-sub');
  card.innerHTML = playlistCard(null, source);
  bar.style.width = '0%';
  msg.textContent = source.kind === 'spotify' ? 'Getting the playlist from Spotify…' : source.kind === 'soundcloud' ? 'Getting the set from SoundCloud…' : 'Reading the spreadsheet…';
  sub.textContent = 'Then the Mac checks it against your library and looks for full-quality copies on Beatport and Qobuz.';
  show('run');

  const offs: Array<() => void> = [];
  const on = (fn: unknown) => { if (typeof fn === 'function') offs.push(fn as () => void); };
  on(window.candybar.onLibrarySourcingPlaylistInfo((i) => { got.info = i; card.innerHTML = playlistCard(i, source); }));
  on(window.candybar.onLibrarySourcingPhase1Progress((p) => {
    if (p.message) msg.textContent = p.message;
    if (p.total > 0) bar.style.width = `${Math.round((p.current / p.total) * 30)}%`;
  }));
  on(window.candybar.onLibrarySourcingPhase2Progress((p) => {
    msg.textContent = `Looking in the stores: ${p.current.toLocaleString()} of ${p.total.toLocaleString()}`;
    sub.textContent = p.currentTrack || '';
    if (p.total > 0) bar.style.width = `${30 + Math.round((p.current / p.total) * 70)}%`;
  }));

  try {
    const res = await window.candybar.librarySourcingRun(
      source.kind === 'spotify' ? { spotifyPlaylistUrl: source.ref }
        : source.kind === 'soundcloud' ? { soundcloudSetUrl: source.ref }
        : { csvPath: source.ref });
    if (!res.success || !res.result) throw new Error(res.error || 'The check stopped without saying why.');
    const result: RunResult = { matched: res.result.matched, probable: res.result.probable, storeMatches: res.result.storeMatches };
    const info = got.info;
    const fresh = state?.source.ref !== source.ref;
    state = { source, info, result, selected: [], added: fresh ? { qobuz: [], beatport: [] } : added, at: Date.now() };
    if (fresh) added = { qobuz: [], beatport: [] };
    // Ticked: sure, full-quality matches of the same version that aren't in the library.
    selected = new Set(result.storeMatches
      .filter(m => autoSelectable(m) && !inFreeGroup(m) && m.libraryStatus !== 'confirmed' && m.libraryStatus !== 'probable' && !m.inLibrary)
      .map(keyOf));
    persist();
    void window.candybar.savedSourcesSave({
      kind: source.kind,
      ref: source.ref,
      name: info?.name || source.name || source.ref,
      imageUrl: info?.imageUrl ?? null,
      owner: info?.owner ?? '',
      trackCount: info ? (info.fetchedCount || info.trackCount) : result.matched.length + result.storeMatches.length,
      counts: countsFor(result),
    }).then(() => loadSaved()).catch(() => undefined);
    renderResults();
    show('results');
  } catch (err) {
    show('pick');
    const help = $('m-help');
    help.textContent = getErrorMessage(err);
    help.className = 'm-help m-help--error';
  } finally {
    for (const off of offs) off();
    running = false;
  }
}

// ---------- Results ----------

function rowHtml(m: QobuzCartMatch, opts: { tickable: boolean; note?: string }): string {
  const store = storeOf(m);
  const qt = m.qobuzTrack;
  const bt = m.beatportTrack;
  const title = store === 'qobuz' ? qt!.name : store === 'beatport' ? bt!.name : m.trackInput.title;
  const artist = store === 'qobuz' ? qt!.artists.join(', ') : store === 'beatport' ? bt!.artists.join(', ') : m.trackInput.artist;
  const url = store === 'qobuz' ? qt!.url : store === 'beatport' ? bt!.url : m.free?.url;
  const price = store === 'qobuz' ? qt!.price : store === 'beatport' ? bt!.price : null;
  const bits = qt?.quality?.match(/(\d+)\s*-?\s*bit/i)?.[1];
  const meta: string[] = [];
  if (store) meta.push(`<span class="m-store m-store--${store}">${STORE_LABEL[store]}</span>`);
  if (store === 'qobuz' && bits) meta.push(`${bits}-bit`);
  if (price) meta.push(escapeHtml(price));
  const flags: string[] = [];
  if (hasLossless(m) && isOtherVersion(m)) flags.push('<span class="status-pill status-pill--warn">Different version?</span>');
  else if (hasLossless(m) && isReleaseMatch(m)) flags.push('<span class="status-pill status-pill--warn">Whole release</span>');
  else if (hasLossless(m) && !autoSelectable(m)) flags.push('<span class="status-pill status-pill--info">Check it</span>');
  const asked = `${m.trackInput.artist} – ${m.trackInput.title}`;
  const differs = store && `${artist} – ${title}`.toLowerCase() !== asked.toLowerCase();
  const tick = opts.tickable
    ? `<input class="m-tick" type="checkbox" data-key="${escapeHtml(keyOf(m))}" ${selected.has(keyOf(m)) ? 'checked' : ''} aria-label="Buy ${escapeHtml(title)}" />`
    : '';
  return `<li class="m-row${opts.tickable ? ' m-row--tick' : ''}">
    ${tick}
    ${art(store === 'qobuz' ? qt!.image : null)}
    <div class="m-row-text">
      <div class="m-row-title">${escapeHtml(title)}</div>
      <div class="m-row-sub">${escapeHtml(artist)}</div>
      ${meta.length || flags.length ? `<div class="m-row-meta">${meta.join('<span class="m-dot">·</span>')}${flags.join('')}</div>` : ''}
      ${differs ? `<div class="m-row-note">For ${escapeHtml(asked)}</div>` : ''}
      ${opts.note ? `<div class="m-row-note">${escapeHtml(opts.note)}</div>` : ''}
    </div>
    ${url ? `<a class="m-open" href="${escapeHtml(url)}" target="_blank" rel="noopener" aria-label="Open in the store">${OPEN_SVG}</a>` : ''}
  </li>`;
}

function group(title: string, hint: string, rows: string[], opts: { open?: boolean; id?: string } = {}): string {
  if (rows.length === 0) return '';
  return `<details class="m-group" ${opts.open ? 'open' : ''} ${opts.id ? `id="${opts.id}"` : ''}>
    <summary><span class="m-group-title">${escapeHtml(title)}</span><span class="m-group-count">${rows.length.toLocaleString()}</span></summary>
    ${hint ? `<p class="m-group-hint">${escapeHtml(hint)}</p>` : ''}
    <ul class="m-rows">${rows.join('')}</ul>
  </details>`;
}

function renderResults() {
  if (!state) return;
  const { result, info, source } = state;
  const g = groups(result.storeMatches);
  const counts = countsFor(result);
  const summary = [
    `${counts.toBuy.toLocaleString()} to buy`,
    counts.maybeOwned ? `${counts.maybeOwned.toLocaleString()} maybe owned` : '',
    `${counts.owned.toLocaleString()} in your library`,
    counts.notForSale ? `${counts.notForSale.toLocaleString()} not for sale` : '',
  ].filter(Boolean).join(' · ');
  $('m-result-card').innerHTML = playlistCard(info, source, `<div class="m-card-sub">${escapeHtml(summary)}</div><div class="m-card-sub m-card-when">Checked ${escapeHtml(ago(state.at))}</div>`);

  const probableFile = new Map(result.probable.map(p => [`${p.artist} – ${p.title}`.toLowerCase(), p.suspectedFilePath]));
  const fileName = (p?: string) => (p ? p.split('/').pop() ?? p : '');
  const html = [
    group('To buy', 'Full-quality copies. The sure ones are ticked; the rest need a look first (tap ↗ to listen in the store).', g.toBuy.map(m => rowHtml(m, { tickable: true })), { open: true, id: 'm-g-buy' }),
    group('Maybe in your library', "Something close is already in your library. Tick it only if that one isn't it.", g.maybe.map(m => rowHtml(m, {
      tickable: true,
      note: `You may have: ${fileName(m.libraryMatchPath ?? probableFile.get(`${m.trackInput.artist} – ${m.trackInput.title}`.toLowerCase()))}`,
    }))),
    group('Free on SoundCloud', 'The set gives these away. Get free downloads in Track Lab on the Mac; a track that comes through compressed shows up here to buy.', g.free.map(m => rowHtml(m, { tickable: false }))),
    group('Not for sale in full quality', '', g.notForSale.map(m => rowHtml(m, { tickable: false, note: notForSaleReason(m) }))),
    group('Already in your library', '', result.matched.map(r => `<li class="m-row"><div class="m-art m-art--empty">${NOTE_SVG}</div>
      <div class="m-row-text"><div class="m-row-title">${escapeHtml(r.title)}</div><div class="m-row-sub">${escapeHtml(r.artist)}</div></div></li>`)),
  ].join('');
  const box = $('m-groups');
  box.innerHTML = html || '<p class="m-empty">Nothing in this playlist to show.</p>';
  box.querySelectorAll<HTMLInputElement>('.m-tick').forEach(cb => cb.addEventListener('change', () => {
    const k = cb.dataset.key!;
    if (cb.checked) selected.add(k); else selected.delete(k);
    persist();
    renderBar();
  }));
  // A tap on the row's text ticks it too; the ↗ opens the store page.
  box.querySelectorAll<HTMLElement>('.m-row--tick .m-row-text').forEach(el => el.addEventListener('click', () => {
    const cb = el.parentElement?.querySelector<HTMLInputElement>('.m-tick');
    if (!cb) return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
  }));
}

// ---------- Carts ----------

function renderBar() {
  const onResults = !$('m-results').hidden;
  const waiting = cartQueue.pending.filter(q => q.store === 'beatport');
  const inCarts = added.qobuz.length + added.beatport.length + waiting.length > 0;
  const bar = $('m-bar');
  bar.hidden = !(onResults || inCarts) || $('m-run').hidden === false;
  document.body.classList.toggle('m-has-bar', !bar.hidden);

  const q = cartBatch('qobuz');
  const b = cartBatch('beatport');
  const n = q.length + b.length;
  const addBtn = $<HTMLButtonElement>('m-add');
  const sum = $('m-bar-sum');
  const row = addBtn.parentElement as HTMLElement;
  row.hidden = !onResults;
  addBtn.disabled = n === 0 || isAddingToCart();
  addBtn.textContent = n === 0 ? 'Add to carts' : `Add ${n.toLocaleString()} to carts`;
  const note = $('m-bar-note');
  note.hidden = !(onResults && b.length > 0 && signedIn.beatport === false);
  note.textContent = "Track Lab on the Mac isn't signed in to Beatport right now: ticked Beatport tracks wait there and go in the cart once it is.";
  sum.innerHTML = n === 0
    ? '<span class="m-bar-none">Tick tracks to buy</span>'
    : `<strong>${escapeHtml(total([...q, ...b]))}</strong><span>${[b.length ? `${b.length} Beatport` : '', q.length ? `${q.length} Qobuz` : ''].filter(Boolean).join(' · ')}</span>`;

  const carts = $('m-carts');
  carts.hidden = !inCarts;
  carts.innerHTML = (['beatport', 'qobuz'] as const).filter(s => added[s].length > 0).map(s => `
    <a class="m-cart m-cart--${s}" href="${cartUrl(s)}" target="_blank" rel="noopener">
      <span class="m-cart-text"><span class="m-cart-title">${STORE_LABEL[s]} cart</span>
      <span class="m-cart-sub">${plural(added[s].length, 'track')} · ${escapeHtml(total(added[s]))}</span></span>
      <span class="m-cart-go">Check out ${OPEN_SVG}</span>
    </a>`).join('') + (waiting.length ? `
    <div class="m-cart m-cart--waiting">
      <span class="m-cart-text"><span class="m-cart-title">Beatport · ${plural(waiting.length, 'track')} waiting</span>
      <span class="m-cart-sub">They go in the cart when Track Lab on the Mac signs in to Beatport (open its Beatport cart there). ${escapeHtml(total(waiting.map(q => q.match)))}</span></span>
    </div>` : '') + `<p class="m-cart-hint">Check out opens the store on this phone. Sign in there with the same account Track Lab uses to see the cart.</p>`;
}

async function addToCarts() {
  if (isAddingToCart()) return;
  const qobuz = cartBatch('qobuz');
  let beatport = cartBatch('beatport');
  if (qobuz.length + beatport.length === 0) return;
  const box = $('m-adding');
  const fill = $('m-add-bar');
  const msg = $('m-add-msg');
  box.hidden = false;
  fill.style.width = '0%';
  msg.textContent = 'Checking your store sign-ins…';
  $<HTMLButtonElement>('m-add').disabled = true;

  // Without a Beatport token Track Lab would open a sign-in window on the Mac
  // and wait. Beatport's Cloudflare check lets a window-less Track Lab read the
  // token only just after a sign-in there, so the tracks wait in the Mac's cart
  // queue instead and go in by themselves once it signs in.
  let queuedNow = 0;
  if (beatport.length > 0) {
    await refreshStores();
    if (signedIn.beatport === false) {
      try {
        const res = await window.candybar.storeCartQueueAdd('beatport', beatport);
        cartQueue = res.state;
        for (const m of beatport) { queued.add(queueKey('beatport', m)); selected.delete(m.input.key); }
        queuedNow = beatport.length;
      } catch (err) {
        showToast('error', "Couldn't keep the Beatport tracks for later", getErrorMessage(err));
      }
      beatport = [];
    }
  }

  // Signing in can mean a window on the Mac (Qobuz renews a lapsed session
  // there by itself, mostly). Say so if it takes a while.
  let signingIn: Store | null = null;
  let hint: number | undefined;
  const outcome = await addToStoreCarts({ qobuz, beatport }, (store, p) => {
    fill.style.width = `${p.total > 0 ? Math.round((p.current / p.total) * 100) : 0}%`;
    msg.textContent = `${STORE_LABEL[store]}: ${p.currentTrack ? `adding ${p.currentTrack}` : p.message}`;
    const waiting = p.current === 0 && /signing in/i.test(p.message) ? store : null;
    if (waiting !== signingIn) {
      window.clearTimeout(hint);
      signingIn = waiting;
      if (waiting) {
        hint = window.setTimeout(() => {
          msg.textContent = `${STORE_LABEL[waiting]} wants a sign-in on the Mac: sign in in the window Track Lab opened there, or close it to skip ${STORE_LABEL[waiting]}.`;
        }, 20_000);
      }
    }
  });
  window.clearTimeout(hint);
  box.hidden = true;
  if (qobuz.length + beatport.length > 0) toastCartOutcome(outcome);
  if (queuedNow > 0) {
    showToast('info', `${plural(queuedNow, 'Beatport track')} waiting for the Mac`,
      "Track Lab on the Mac isn't signed in to Beatport. They go in the cart the next time it is: open Track Lab's Beatport cart there.", 9000);
  }
  for (const s of ['qobuz', 'beatport'] as const) {
    if (outcome.added[s].length === 0) continue;
    added[s] = mergeAdded(added[s], outcome.added[s]);
    // In the cart now: untick, so a second Add doesn't send them again.
    const inCart = new Set(outcome.added[s].map(m => m.input.key));
    for (const k of inCart) selected.delete(k);
  }
  persist();
  renderResults();
  renderBar();
  if (outcome.added.qobuz.length + outcome.added.beatport.length > 0) {
    $('m-carts').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  void refreshStores();
}

/** The Mac's cart queue: what's still waiting, and which of this phone's
 *  queued tracks went in (they join the Beatport cart here) or were refused. */
async function refreshQueue(fresh?: CartQueueState & { drained?: { added: number } }) {
  try {
    cartQueue = fresh ?? await window.candybar.storeCartQueueList();
  } catch {
    return;
  }
  const wentIn = cartQueue.added.filter(q => queued.has(queueKey(q.store, q.match)));
  const refused = cartQueue.failed.filter(q => queued.has(queueKey(q.store, q.match)));
  if (wentIn.length) {
    added.beatport = mergeAdded(added.beatport, wentIn.map(q => q.match));
    // It just put them in: Track Lab has a Beatport token right now.
    signedIn.beatport = true;
    renderStores();
    showToast('success', `${plural(wentIn.length, 'waiting Beatport track')} in the cart`, 'Track Lab signed in to Beatport on the Mac and added them. Check out from the Beatport cart.');
  }
  if (refused.length) {
    showToast('warning', `Beatport refused ${plural(refused.length, 'track')}`, refused.map(q => `${q.match.title}: ${q.error}`).join(' · '), 9000);
  }
  for (const q of [...wentIn, ...refused]) queued.delete(queueKey(q.store, q.match));
  // Taken out of the queue on the Mac (or by Claude): nothing to wait for.
  const stillWaiting = new Set(cartQueue.pending.map(q => queueKey(q.store, q.match)));
  for (const k of [...queued]) if (!stillWaiting.has(k)) queued.delete(k);
  persist();
  renderBar();
}

// ---------- Start ----------

function init() {
  $('m-input').addEventListener('input', onInput);
  $('m-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runPasted(); });
  $('m-run-link').addEventListener('click', runPasted);
  $('m-back').addEventListener('click', () => { show('pick'); void loadSaved(); });
  $('m-rerun').addEventListener('click', () => { if (state) void run(state.source); });
  $('m-add').addEventListener('click', () => void addToCarts());
  renderStores();
  void refreshStores();
  void refreshQueue();
  void loadSaved();
  window.candybar.onStoreCartQueue((s) => void refreshQueue(s));
  if (restore()) {
    renderResults();
    show('results');
  } else {
    show('pick');
  }
  // Back from checking out in the store: the sign-in may have changed.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refreshStores(); void refreshQueue(); } });
}

if (!window.candybar) {
  document.body.innerHTML = '<p class="m-empty m-fatal">Open Track Lab from Benhäus: this page needs the app running on the Mac.</p>';
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
