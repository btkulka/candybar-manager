// Renders a sourcing session into a review page you operate:
// buy list first, then the calls only a human can make.
//
// Every buy button opens the store's own page for the track. Qobuz's
// /v4/ajax/add-cart answers only to an XHR from qobuz.com (a link click 404s —
// verified live), so a web page cannot fill that cart; lib/sourcing/cart.mjs
// does it through Track Lab's Qobuz account instead. Beatport has no GET cart
// endpoint either — its cart API takes a Bearer token a page can't hold — so
// cart.mjs fills that cart too, and rows it added render as already "in cart".

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const money = s => {
  const n = parseFloat(String(s || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// A published artifact runs under a CSP that blocks every external host, so
// remote cover art silently fails to load there — the page has to carry its own
// pixels. Each cover is fetched once, downscaled, and inlined as a data: URI.
//
// Beatport's search scrape carries no artwork at all, so the Spotify cover from
// the playlist is the fallback for those rows; without it 18 of 22 rows render
// as empty placeholders.
let ART = new Map();

// Preview clips, inlined for the same reason: the CSP blocks the store's
// media hosts too. Keyed by row key; see previews.mjs for how they are made.
let PREVIEWS = new Map();

const artFor = (m, r) => m.image || r.image || '';

const ART_PX = 128;   // rows draw at 48px; 128 covers 2x displays

function downscale(buf, url) {
  const ext = /\.png(\?|$)/i.test(url) ? '.png' : '.jpg';
  const base = path.join(os.tmpdir(), 'cbart-' + process.pid + '-' + Math.abs(hashStr(url)));
  const inPath = base + ext;
  const outPath = base + '.out.jpg';
  try {
    fs.writeFileSync(inPath, buf);
    execFileSync('sips', ['-Z', String(ART_PX), '--setProperty', 'format', 'jpeg',
                          inPath, '--out', outPath], { stdio: 'ignore' });
    const small = fs.readFileSync(outPath);
    // Only take the resized copy if it actually helped.
    return small.length < buf.length ? { buf: small, mime: 'image/jpeg' } : null;
  } catch {
    return null;   // no sips, or an image it cannot read — inline the original
  } finally {
    for (const f of [inPath, outPath]) { try { fs.unlinkSync(f); } catch {} }
  }
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}

/** Fetch every cover the page needs and return url -> data: URI.
 *  A cover that will not download is left as its remote URL: broken under the
 *  artifact CSP, but still correct for a locally opened file. */
export async function loadArt(session, log = () => {}) {
  const urls = new Set();
  for (const r of session.buy || []) {
    const u = artFor(r.match || {}, r);
    if (u && /^https?:/i.test(u)) urls.add(u);
  }
  const cover = session.playlist?.imageUrl || session.playlist?.image;
  if (cover && /^https?:/i.test(cover)) urls.add(cover);

  const list = [...urls];
  const out = new Map();
  let done = 0, failed = 0;
  const CONCURRENCY = 8;

  async function one(url) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const raw = Buffer.from(await res.arrayBuffer());
      const smaller = downscale(raw, url);
      const buf = smaller ? smaller.buf : raw;
      const mime = smaller ? smaller.mime
        : (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
      out.set(url, 'data:' + mime + ';base64,' + buf.toString('base64'));
    } catch {
      failed++;
    } finally {
      done++;
    }
  }

  const queue = list.slice();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await one(queue.shift());
  }));

  log('      art: inlined ' + out.size + '/' + list.length + ' cover(s)'
      + (failed ? ' (' + failed + ' failed, left as remote URLs)' : ''));
  return out;
}

function trackRow(r, i) {
  const m = r.match || {};
  const store = r.store || 'none';
  const isQobuz = store === 'qobuz';
  const href = (isQobuz ? (m.trackUrl || m.url) : (m.url || m.trackUrl)) || '#';
  const action = isQobuz ? 'Open on Qobuz' : 'Open on Beatport';
  const artUrl = artFor(m, r);
  const artImg = artUrl
    ? `<img class="art" src="${esc(ART.get(artUrl) || artUrl)}" alt="" loading="lazy" />`
    : `<div class="art art--empty" aria-hidden="true"></div>`;

  // Listen before you buy. Both stores put a preview player on the page this
  // points at. It carries no .btn class, so it never ticks the row.
  const previewUrl = isQobuz ? (m.trackUrl || m.url) : m.url;
  const previewLabel = 'Preview ' + (m.title || r.title) + ' on ' + store;
  const clip = PREVIEWS.get(r.key || String(i));
  // With an inlined clip the overlay plays right here — no tab, no store
  // player — and the store page moves to a small link beside the chips.
  const art = clip ? `<div class="artwrap">${artImg}
      <button class="play play--inline" type="button" data-src="${clip}"
         title="${esc('Play 30s of ' + (m.title || r.title))}" aria-label="${esc('Play 30 seconds of ' + (m.title || r.title))}" aria-pressed="false">
        <svg class="ring" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle cx="24" cy="24" r="21" pathLength="100"/></svg>
        <svg class="ico ico-play" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5.5v13l11-6.5z"/></svg>
        <svg class="ico ico-pause" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>
      </button></div>` : `<div class="artwrap">${artImg}${previewUrl ? `
      <a class="play" href="${esc(previewUrl)}" target="_blank" rel="noopener noreferrer"
         title="${esc(previewLabel)}" aria-label="${esc(previewLabel)}">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5.5v13l11-6.5z"/></svg>
      </a>` : ''}</div>`;
  const pageLink = clip && previewUrl
    ? `<a class="pagelink" href="${esc(previewUrl)}" target="_blank" rel="noopener noreferrer">${esc(store)} page ↗</a>`
    : '';
  const quality = isQobuz ? (m.cartLabel || m.quality || 'Lossless') : 'WAV / AIFF';
  const conf = Math.round((m.score ?? 0) * 100);
  const runner = r.runnerUp
    ? `<span class="runner">also on ${esc(r.runnerUp.store)} · ${Math.round(r.runnerUp.score * 100)}%</span>`
    : '';
  const probable = r.libraryStatus === 'probable'
    ? `<span class="chip chip--warn" title="${esc(r.libraryMatch?.filePath || '')}">maybe already yours</span>`
    : '';

  // Surface the two ways a confident-looking match can still be the wrong
  // record, so they're arguable rather than buried in the JSON.
  const parts = m.scoreParts || {};
  const versionFlag = parts.penalty > 0
    ? '<span class="chip chip--warn" title="This looks like a different version from the one you asked for">different version?</span>'
    : '';
  const weakFlag = (m.score ?? 1) < 0.75
    ? '<span class="chip chip--warn">weak match — check</span>'
    : '';

  return `
  <li class="row" data-price="${money(m.price)}" data-id="${esc(r.key || i)}" data-store="${esc(store)}"${r.cartAdded ? ' data-incart="1"' : ''}>
    <label class="check">
      <input type="checkbox" class="added" aria-label="Mark as added to cart" />
      <span class="box" aria-hidden="true"></span>
    </label>
    ${art}
    <div class="meta">
      <p class="title">${esc(m.title || r.title)}</p>
      <p class="artist">${esc((m.artists || []).join(', ') || r.artist)}</p>
      <p class="tags">
        <span class="chip chip--${esc(store)}">${esc(store)}</span>
        <span class="chip">${esc(quality)}</span>
        <span class="chip chip--match" title="store match confidence">${conf}%</span>
        ${r.cartAdded ? '<span class="chip chip--ok">in cart</span>' : ''}${probable}${versionFlag}${weakFlag}${runner}${pageLink}
      </p>
      ${r.reviewNote ? `<p class="note">${esc(r.reviewNote)}</p>` : ''}
    </div>
    <p class="price">${esc(m.price || '—')}</p>
    <a class="btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(action)}</a>
    <button class="kill" type="button" title="Remove from the buy list" aria-label="Remove ${esc(m.title || r.title)} from the buy list">&times;</button>
  </li>`;
}

function reviewRow(r) {
  const lm = r.libraryMatch || {};
  const where = lm.filePath ? `<code>${esc(lm.filePath)}</code>` : '<span class="muted">no file</span>';
  return `
  <li class="rrow">
    <div>
      <p class="title">${esc(r.artist)} — ${esc(r.title)}</p>
      <p class="sub">${esc(r.reason || r.flag || '')}${r.libraryConfidence != null ? ` · ${Math.round(r.libraryConfidence * 100)}% to ${esc(lm.artist || '?')} — ${esc(lm.title || '?')}` : ''}</p>
      <p class="path">${where}${lm.inRekordbox === false && lm.filePath ? ' <span class="chip chip--warn">not in Rekordbox</span>' : ''}</p>
    </div>
  </li>`;
}

function ownedRow(r) {
  const lm = r.libraryMatch || {};
  return `<li class="orow"><span>${esc(r.artist)} — ${esc(r.title)}</span><code>${esc((lm.filePath || '').split('/').pop() || '')}</code></li>`;
}

export function renderReview(session, art, previews, { sessionPath = '<session.json>' } = {}) {
  ART = art instanceof Map ? art : new Map();
  PREVIEWS = previews instanceof Map ? previews : new Map();
  const p = session.playlist || {};
  const s = session.stats || {};
  const total = (session.buy || []).reduce((sum, r) => sum + money(r.match?.price), 0);
  const byStore = (session.buy || []).reduce((acc, r) => {
    acc[r.store] = (acc[r.store] || 0) + 1;
    return acc;
  }, {});

  const beatportNote = s.beatportSkipped
    ? 'Beatport was skipped for this run.'
    : s.beatportLoggedIn
      ? 'Beatport session is signed in.'
      : 'Beatport was searched signed out — prices and availability are public, but adding to that cart happens on the track page.';
  const cartNote = 'These buttons open store pages; they can’t fill a cart. To add everything in one go, run node lib/sourcing/cart.mjs <session.json>.';

  return `<title>${esc(p.name || 'Playlist')} Crate</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root {
    --ground: #EEF0F3;
    --surface: #FFFFFF;
    --surface-2: #F6F7F9;
    --line: #D8DCE3;
    --ink: #101418;
    --muted: #616A76;
    --accent: #1F4FD8;
    --accent-ink: #FFFFFF;
    --ok: #0F7A55;
    --warn: #A75418;
    --beatport: #007F5F;
    --qobuz: #0B5FB0;
    --shadow: 0 1px 2px rgba(16, 20, 24, .06), 0 8px 24px -16px rgba(16, 20, 24, .3);
    --radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #0E1116;
      --surface: #161B22;
      --surface-2: #1C222B;
      --line: #2A323D;
      --ink: #E6EAF0;
      --muted: #8A94A3;
      --accent: #6E96FF;
      --accent-ink: #0B0E13;
      --ok: #4CC08D;
      --warn: #E0A26A;
      --beatport: #35D6A4;
      --qobuz: #6BB4F5;
      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 30px -18px rgba(0,0,0,.8);
    }
  }
  :root[data-theme="dark"] {
    --ground: #0E1116;
    --surface: #161B22;
    --surface-2: #1C222B;
    --line: #2A323D;
    --ink: #E6EAF0;
    --muted: #8A94A3;
    --accent: #6E96FF;
    --accent-ink: #0B0E13;
    --ok: #4CC08D;
    --warn: #E0A26A;
    --beatport: #35D6A4;
    --qobuz: #6BB4F5;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 30px -18px rgba(0,0,0,.8);
  }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 40px 24px 96px; display: flex; flex-direction: column; gap: 32px; }

  h1, h2, h3 { font-family: Archivo, ui-sans-serif, system-ui, sans-serif; margin: 0; text-wrap: balance; letter-spacing: -.015em; }
  h1 { font-size: clamp(28px, 4vw, 40px); font-weight: 700; }
  h2 { font-size: 19px; font-weight: 600; }
  p { margin: 0; }
  code { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px; color: var(--muted); word-break: break-all; }
  .muted { color: var(--muted); }

  header { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
  .cover { width: 88px; height: 88px; border-radius: 8px; object-fit: cover; box-shadow: var(--shadow); }
  .eyebrow { font-family: "IBM Plex Mono", monospace; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; display: flex; flex-direction: column; gap: 2px; }
  .tile .n { font-family: Archivo, sans-serif; font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tile .l { font-size: 12px; color: var(--muted); }
  .tile--spend .n { color: var(--accent); }

  .panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  .phead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .phead .note { font-size: 13px; color: var(--muted); }

  ul { list-style: none; margin: 0; padding: 0; }
  .row { display: grid; grid-template-columns: auto 48px 1fr auto auto auto; gap: 14px; align-items: center; padding: 12px 18px; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: 0; }
  .row.done { opacity: .45; }
  .artwrap { position: relative; width: 48px; height: 48px; }
  .art { width: 48px; height: 48px; border-radius: 6px; object-fit: cover; background: var(--surface-2); display: block; }
  /* Always visible, so the preview is discoverable without a hover to find it
     — which also makes it work on touch, where there is no hover at all. */
  .play { position: absolute; inset: 0; display: grid; place-items: center; border-radius: 6px; background: rgba(0,0,0,.42); opacity: .85; transition: opacity .12s ease, background-color .12s ease; }
  .play svg { width: 18px; height: 18px; fill: #fff; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
  .artwrap:hover .play { opacity: 1; background: rgba(0,0,0,.6); }
  .play:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; opacity: 1; }
  .art--empty { border: 1px dashed var(--line); }
  .play--inline { border: 0; padding: 0; cursor: pointer; font: inherit; color: inherit; }
  .play--inline .ico { position: absolute; inset: 0; margin: auto; }
  .play--inline .ico-pause { display: none; }
  .play--inline[aria-pressed="true"] .ico-play { display: none; }
  .play--inline[aria-pressed="true"] .ico-pause { display: block; }
  .play--inline[aria-pressed="true"] { opacity: 1; background: rgba(0,0,0,.55); }
  /* Progress ring: pathLength=100 so dasharray is a percentage. */
  .play--inline .ring { position: absolute; inset: 0; width: 48px; height: 48px; transform: rotate(-90deg); pointer-events: none; }
  .play--inline .ring circle { fill: none; stroke: #fff; stroke-width: 2.5; stroke-dasharray: var(--p, 0) 100; opacity: .95; }
  .row.playing .title { color: var(--accent); }
  .pagelink { font-size: 11px; color: var(--muted); text-decoration: none; border-bottom: 1px dotted currentColor; }
  .pagelink:hover { color: var(--ink); }
  .meta { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .title { font-weight: 600; overflow-wrap: anywhere; }
  .artist { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .price { font-family: "IBM Plex Mono", monospace; font-variant-numeric: tabular-nums; font-size: 14px; }

  .chip { font-size: 11px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); background: var(--surface-2); white-space: nowrap; }
  .chip--beatport { color: var(--beatport); border-color: color-mix(in srgb, var(--beatport) 40%, var(--line)); font-weight: 600; }
  .chip--qobuz { color: var(--qobuz); border-color: color-mix(in srgb, var(--qobuz) 40%, var(--line)); font-weight: 600; }
  .chip--warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
  .chip--ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); font-weight: 600; }
  .chip--match { font-variant-numeric: tabular-nums; }
  .runner { font-size: 11px; color: var(--muted); }
  .note { font-size: 12px; color: var(--muted); border-left: 2px solid var(--line); padding-left: 8px; margin-top: 2px; }

  .btn { display: inline-block; background: var(--accent); color: var(--accent-ink); text-decoration: none; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px; white-space: nowrap; }
  .btn:hover { filter: brightness(1.08); }
  .btn:focus-visible, .check input:focus-visible + .box { outline: 2px solid var(--accent); outline-offset: 2px; }
  .btn[disabled] { opacity: .45; cursor: not-allowed; filter: none; }
  .btn--ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  .btn--ghost:hover { background: var(--surface-2); filter: none; }

  /* Add-all cluster: one primary action, per-store fallbacks, and a status
     line that has to carry the popup-blocker case honestly. */
  .addall { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .addall .btn { border: none; cursor: pointer; font-family: inherit; }
  .addall .btn--ghost { border: 1px solid var(--line); }
  .barnote { flex-basis: 100%; font-size: 12px; color: var(--muted); line-height: 1.5; margin: 0; }
  .barnote:empty { display: none; }
  .barnote strong { color: var(--ink); }
  .barnote.warn { color: var(--warn); }

  /* Removing a track is a review decision, so it has to be undoable — the row
     is hidden, never dropped, and the removed list can put it back. */
  .kill { background: none; border: none; cursor: pointer; color: var(--muted); font-size: 18px; line-height: 1; padding: 4px 6px; border-radius: 6px; font-family: inherit; }
  .kill:hover { color: var(--warn); background: var(--surface-2); }
  .kill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .row.removed { display: none; }
  .links-box { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 18px; }
  .links-box ul { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 4px; }
  .links-box li { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .links-box a { color: var(--accent); }
  .links-box .who { color: var(--muted); }
  .removed-box { margin-top: 10px; }
  .removed-box ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
  .removed-box li { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px; color: var(--muted); padding: 6px 10px; background: var(--surface-2); border-radius: 8px; }
  .removed-box .restore { background: none; border: 1px solid var(--line); color: var(--ink); font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-family: inherit; }
  .removed-box .restore:hover { background: var(--surface); }

  .check { display: inline-flex; cursor: pointer; }
  .check input { position: absolute; opacity: 0; width: 0; height: 0; }
  .box { width: 20px; height: 20px; border: 1.5px solid var(--line); border-radius: 6px; background: var(--surface-2); display: block; position: relative; }
  .check input:checked + .box { background: var(--ok); border-color: var(--ok); }
  .check input:checked + .box::after { content: ""; position: absolute; left: 6px; top: 2px; width: 5px; height: 10px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(42deg); }

  details.panel > summary { padding: 16px 18px; cursor: pointer; font-family: Archivo, sans-serif; font-weight: 600; font-size: 17px; display: flex; justify-content: space-between; gap: 12px; }
  details.panel > summary::-webkit-details-marker { display: none; }
  details.panel[open] > summary { border-bottom: 1px solid var(--line); }
  .count { color: var(--muted); font-family: "IBM Plex Mono", monospace; font-size: 13px; font-weight: 400; }
  .rrow { padding: 12px 18px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 3px; }
  .rrow:last-child, .orow:last-child { border-bottom: 0; }
  .sub { font-size: 13px; color: var(--muted); }
  .path { margin-top: 2px; }
  .orow { display: flex; justify-content: space-between; gap: 12px; padding: 9px 18px; border-bottom: 1px solid var(--line); font-size: 14px; flex-wrap: wrap; }

  .bar { position: sticky; bottom: 0; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 18px; display: flex; justify-content: space-between; align-items: center; gap: 16px; box-shadow: var(--shadow); flex-wrap: wrap; }
  .bar strong { font-family: "IBM Plex Mono", monospace; font-variant-numeric: tabular-nums; }
  footer { font-size: 12px; color: var(--muted); }
  .banner { background: color-mix(in srgb, var(--warn) 12%, var(--surface)); border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line)); color: var(--ink); border-radius: var(--radius); padding: 12px 16px; font-size: 14px; }
  @media (max-width: 640px) {
    .row { grid-template-columns: auto 40px 1fr auto; row-gap: 8px; }
    .price, .btn { grid-column: 3; justify-self: start; }
    .kill { grid-column: 4; grid-row: 1; align-self: start; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>

<div class="wrap">
  <header>
    ${p.imageUrl ? `<img class="cover" src="${esc(ART.get(p.imageUrl) || p.imageUrl)}" alt="" />` : ''}
    <div>
      <p class="eyebrow">Sourcing review · ${esc((session.createdAt || '').slice(0, 10))}</p>
      <h1>${esc(p.name || 'Playlist')}</h1>
      <p class="muted">${esc(p.fetchedCount ?? s.total)} tracks${p.owner ? ` · ${esc(p.owner)}` : ''} · checked against ${esc(s.library?.rekordbox ?? 0)} Rekordbox tracks</p>
    </div>
  </header>

  <div class="tiles">
    <div class="tile tile--spend"><span class="n" id="tile-spend">$${total.toFixed(2)}</span><span class="l">to buy${byStore.beatport ? ` · ${byStore.beatport} Beatport` : ''}${byStore.qobuz ? ` · ${byStore.qobuz} Qobuz` : ''}</span></div>
    <div class="tile"><span class="n">${s.buy ?? 0}</span><span class="l">tracks to buy</span></div>
    <div class="tile"><span class="n">${s.owned ?? 0}</span><span class="l">already in Rekordbox</span></div>
    <div class="tile"><span class="n">${s.probable ?? 0}</span><span class="l">need your call</span></div>
    <div class="tile"><span class="n">${(s.notFound ?? 0) + (s.flagged ?? 0)}</span><span class="l">no clean match</span></div>
  </div>

  ${session.complete === false ? `
  <p class="banner">This run was interrupted — ${esc(s.searched ?? 0)} of ${esc(s.toSearch ?? 0)} tracks were searched. Re-run with <code>--resume</code> to finish it.</p>` : ''}

  <section class="panel">
    <div class="phead">
      <h2>Buy list</h2>
      <p class="note">${esc(beatportNote)} ${esc(cartNote)}</p>
    </div>
    <ul id="buy">
      ${(session.buy || []).map(trackRow).join('')}
      ${(session.buy || []).length === 0 ? '<li class="rrow"><p class="sub">Nothing to buy — every track resolved to your library.</p></li>' : ''}
    </ul>
  </section>

  ${(session.probable || []).length ? `
  <details class="panel">
    <summary>Need your call <span class="count">${session.probable.length}</span></summary>
    <ul>${session.probable.map(reviewRow).join('')}</ul>
  </details>` : ''}

  ${(session.flagged || []).length ? `
  <details class="panel">
    <summary>Flagged <span class="count">${session.flagged.length}</span></summary>
    <ul>${session.flagged.map(reviewRow).join('')}</ul>
  </details>` : ''}

  ${(session.notFound || []).length ? `
  <details class="panel">
    <summary>No store match <span class="count">${session.notFound.length}</span></summary>
    <ul>${session.notFound.map(reviewRow).join('')}</ul>
  </details>` : ''}

  ${(session.owned || []).length ? `
  <details class="panel">
    <summary>Already yours <span class="count">${session.owned.length}</span></summary>
    <ul>${session.owned.map(ownedRow).join('')}</ul>
  </details>` : ''}

  <div class="bar">
    <span><strong id="left-count">${s.buy ?? 0}</strong> left to add · <strong id="left-spend">$${total.toFixed(2)}</strong></span>
    <div class="addall">
      <button class="btn" id="add-all" type="button">Open all</button>
      <button class="btn btn--ghost" id="step" type="button">Open next</button>
      <button class="btn btn--ghost" id="add-qobuz" type="button">Qobuz only</button>
      <button class="btn btn--ghost" id="add-beatport" type="button">Beatport only</button>
      <button class="btn btn--ghost" id="copy-links" type="button">Copy links</button>
      <button class="btn btn--ghost" id="reset" type="button">Clear ticks</button>
    </div>
    <p class="barnote" id="addall-note"></p>
  </div>

  <details class="links-box" id="links-box">
    <summary>All remaining links <span class="count" id="links-count">0</span></summary>
    <p class="barnote">If a bulk button is blocked by the viewer, these plain links always work — open them in order and each row ticks itself off.</p>
    <ul id="links-list"></ul>
  </details>

  <div class="removed-box" id="removed-box" hidden>
    <details open>
      <summary>Removed from the buy list <span class="count" id="removed-count">0</span></summary>
      <ul id="removed-list"></ul>
      <p class="barnote">This page can only remember a removal in this browser. To keep these out of the carts, fill them with this command: <code id="skip-cmd"></code> <button type="button" class="restore" id="copy-skip">Copy</button></p>
    </details>
  </div>

  <footer>Ticks are remembered in this browser only.${PREVIEWS.size ? ' Click a cover to hear 30 seconds; Esc stops it.' : ''} Every link opens the store's page for the track; the last click is yours. Neither store's cart accepts adds from another site, so run <code>node lib/sourcing/cart.mjs ${esc(sessionPath)}</code> to fill both carts from your Track Lab store accounts (removed rows need the command in the Removed box).${(s.duplicatesDropped || s.ignored) ? ` ${esc(s.duplicatesDropped || 0)} duplicate${s.duplicatesDropped === 1 ? '' : 's'} and ${esc(s.ignored || 0)} ignored track${s.ignored === 1 ? '' : 's'} were left out.` : ''}</footer>
</div>

<script>
  (function () {
    var SLUG = ${JSON.stringify(String(p.url || p.name || 'session'))};
    var KEY = 'sourcing:' + SLUG;
    var KEY_REMOVED = 'sourcing:removed:' + SLUG;
    var rows = Array.prototype.slice.call(document.querySelectorAll('#buy .row'));
    var addAllBtn = document.getElementById('add-all');
    var noteEl = document.getElementById('addall-note');
    var removedBox = document.getElementById('removed-box');
    var removedList = document.getElementById('removed-list');
    var removedCount = document.getElementById('removed-count');
    var SESSION_PATH = ${JSON.stringify(String(sessionPath))};
    var skipCmd = document.getElementById('skip-cmd');

    function read(key) {
      try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
    }
    function write(key, state) {
      try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) { /* private window */ }
    }

    function note(msg, warn) {
      noteEl.textContent = msg || '';
      noteEl.className = 'barnote' + (warn ? ' warn' : '');
    }

    function isRemoved(row) { return row.classList.contains('removed'); }
    function isTicked(row) { return row.querySelector('.added').checked; }

    // The buy list a button acts on: still on the list, not already ticked off.
    function pending(store) {
      return rows.filter(function (row) {
        if (isRemoved(row) || isTicked(row)) return false;
        return !store || row.dataset.store === store;
      });
    }

    function refresh() {
      var left = 0, spend = 0;
      rows.forEach(function (row) {
        var on = isTicked(row);
        row.classList.toggle('done', on);
        if (!on && !isRemoved(row)) { left++; spend += parseFloat(row.dataset.price || '0'); }
      });
      document.getElementById('left-count').textContent = String(left);
      document.getElementById('left-spend').textContent = '$' + spend.toFixed(2);
      addAllBtn.textContent = 'Open all' + (left ? ' (' + left + ')' : '');
      addAllBtn.disabled = left === 0;
      document.getElementById('step').disabled = left === 0;
      document.getElementById('copy-links').disabled = left === 0;
      document.getElementById('add-qobuz').disabled = pending('qobuz').length === 0;
      document.getElementById('add-beatport').disabled = pending('beatport').length === 0;
      renderLinks();
    }

    function tick(row) {
      var box = row.querySelector('.added');
      if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change')); }
    }

    // --- opening tabs -------------------------------------------------------
    // Every tab is the store's track page; the last click stays manual. (Qobuz's
    // add-cart URL 404s unless it is an XHR from qobuz.com, so there is no
    // one-click path from here — cart.mjs fills that cart through Track Lab.)
    //
    // This page can be viewed inside a sandboxed iframe, where programmatic
    // window.open is refused no matter what the user's pop-up setting says.
    // Activating the row's real anchor is the mechanism that demonstrably
    // works there — it is exactly what a manual click on the row does — so it
    // is the primary path, with window.open kept only as a second attempt.
    function openOne(row) {
      var a = row.querySelector('a.btn');
      if (!a) return false;
      try {
        a.click();          // same code path as clicking the row's own button
        tick(row);
        return true;
      } catch (e) { /* fall through */ }
      try {
        var w = window.open(a.href, '_blank');
        if (w) { try { w.opener = null; } catch (e2) {} tick(row); return true; }
      } catch (e3) { /* blocked */ }
      return false;
    }

    function describe(list) {
      var q = list.filter(function (r) { return r.dataset.store === 'qobuz'; }).length;
      var b = list.length - q;
      var bits = [];
      if (q) bits.push(q + ' Qobuz page' + (q === 1 ? '' : 's') + ' opened — click Buy on each');
      if (b) bits.push(b + ' Beatport track page' + (b === 1 ? '' : 's') + ' opened — click Add to cart on each, or run cart.mjs to add them all');
      return bits.join(' · ');
    }

    // A viewer can refuse bulk opening in ways the page cannot detect: a
    // sandboxed iframe rejects window.open outright, and activating an anchor
    // reports nothing either way. Rather than guess and narrate a diagnosis
    // that might be wrong, every route stays permanently available — open them
    // all, step one at a time, copy the URLs, or click the plain links below.
    // Whatever the viewer permits, one of these gets there.
    function startBatch(list) {
      if (!list.length) { note('Nothing left to add.'); refresh(); return; }
      var opened = [];
      for (var i = 0; i < list.length; i++) {
        if (openOne(list[i])) opened.push(list[i]);
      }
      var missed = list.length - opened.length;
      if (!opened.length) {
        note('This viewer refused to open tabs. Use "Copy links" or the plain links below.', true);
      } else {
        note('Asked the browser for ' + opened.length + ' tab' + (opened.length === 1 ? '' : 's') + '. ' + describe(opened)
             + (missed ? ' ' + missed + ' could not be opened — try "Open next" or the links below.' : '')
             + ' If a tab opened but the cart stayed empty, that store is signed out in this browser.',
             missed > 0);
      }
      refresh();
    }

    function stepOnce() {
      var list = pending();
      if (!list.length) { note('Nothing left to add.'); refresh(); return; }
      if (openOne(list[0])) {
        var left = pending().length;
        note(left ? left + ' still to open.' : 'That was the last one.');
      } else {
        note('This viewer refused to open that tab. Use the plain link below instead.', true);
      }
      refresh();
    }

    // Clipboard API is missing in some embedded viewers; select-and-copy is not.
    function fallbackCopy(text, ok) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var worked = false;
      try { worked = document.execCommand('copy'); } catch (e) { worked = false; }
      document.body.removeChild(ta);
      if (worked) ok(); else note('Could not reach the clipboard. Use the plain links below.', true);
    }

    function renderLinks() {
      var list = pending();
      document.getElementById('links-count').textContent = String(list.length);
      var ul = document.getElementById('links-list');
      ul.innerHTML = '';
      list.forEach(function (row) {
        var a0 = row.querySelector('a.btn');
        var li = document.createElement('li');
        var who = document.createElement('span');
        who.className = 'who';
        who.textContent = row.dataset.store + ' · ';
        var a = document.createElement('a');
        a.href = a0.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = label(row);
        a.addEventListener('click', function () { tick(row); });
        li.appendChild(who);
        li.appendChild(a);
        ul.appendChild(li);
      });
    }

    addAllBtn.addEventListener('click', function () { startBatch(pending()); });
    document.getElementById('step').addEventListener('click', stepOnce);
    document.getElementById('add-qobuz').addEventListener('click', function () { startBatch(pending('qobuz')); });
    document.getElementById('add-beatport').addEventListener('click', function () { startBatch(pending('beatport')); });
    document.getElementById('copy-links').addEventListener('click', function () {
      var list = pending();
      if (!list.length) { note('Nothing left to copy.'); return; }
      var urls = list.map(function (r) { return r.querySelector('a.btn').href; }).join(String.fromCharCode(10));
      function ok() { note('Copied ' + list.length + ' link(s). Paste them into your browser.'); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(urls).then(ok, function () { fallbackCopy(urls, ok); });
      } else { fallbackCopy(urls, ok); }
    });

    // --- removing tracks ----------------------------------------------------
    // A removed row is hidden, never dropped, so a mis-click is one click back.
    function label(row) {
      var t = row.querySelector('.title');
      var a = row.querySelector('.artist');
      return ((a && a.textContent) || '') + ' — ' + ((t && t.textContent) || '');
    }

    function cartCommand(gone) {
      var keys = gone.map(function (row) { return row.dataset.id; }).join(',');
      return 'node lib/sourcing/cart.mjs ' + JSON.stringify(SESSION_PATH) + ' --skip ' + JSON.stringify(keys);
    }

    function renderRemoved() {
      var gone = rows.filter(isRemoved);
      removedCount.textContent = String(gone.length);
      removedBox.hidden = gone.length === 0;
      skipCmd.textContent = gone.length ? cartCommand(gone) : '';
      removedList.innerHTML = '';
      gone.forEach(function (row) {
        var li = document.createElement('li');
        var span = document.createElement('span');
        span.textContent = label(row);
        var btn = document.createElement('button');
        btn.className = 'restore';
        btn.type = 'button';
        btn.textContent = 'Put back';
        btn.addEventListener('click', function () { setRemoved(row, false); });
        li.appendChild(span);
        li.appendChild(btn);
        removedList.appendChild(li);
      });
    }

    function setRemoved(row, on) {
      row.classList.toggle('removed', on);
      var st = read(KEY_REMOVED);
      if (on) st[row.dataset.id] = 1; else delete st[row.dataset.id];
      write(KEY_REMOVED, st);
      renderRemoved();
      refresh();
    }

    document.getElementById('copy-skip').addEventListener('click', function () {
      var text = skipCmd.textContent;
      var ok = function () { note('Cart command copied — it leaves the removed rows out.'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, function () { fallbackCopy(text, ok); });
      } else { fallbackCopy(text, ok); }
    });

    // --- wiring -------------------------------------------------------------
    var ticks = read(KEY);
    var removed = read(KEY_REMOVED);

    rows.forEach(function (row) {
      var box = row.querySelector('.added');
      box.checked = !!ticks[row.dataset.id] || row.dataset.incart === '1';
      if (removed[row.dataset.id]) row.classList.add('removed');
      box.addEventListener('change', function () {
        var st = read(KEY);
        if (box.checked) st[row.dataset.id] = 1; else delete st[row.dataset.id];
        write(KEY, st);
        refresh();
      });
      // Clicking the buy link is the moment it lands in the cart — tick it.
      var link = row.querySelector('.btn');
      if (link) link.addEventListener('click', function () { tick(row); });
      var kill = row.querySelector('.kill');
      if (kill) kill.addEventListener('click', function () { setRemoved(row, true); });
    });

    document.getElementById('reset').addEventListener('click', function () {
      write(KEY, {});
      rows.forEach(function (row) { row.querySelector('.added').checked = row.dataset.incart === '1'; });
      note('');
      refresh();
    });

    // --- previews -----------------------------------------------------------
    // One <audio> for the whole page: starting a clip stops whatever else was
    // playing. Clips are 30 s data: URIs, so playback is instant and offline.
    var player = new Audio();
    var current = null;
    function setPlaying(btn, on) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      var row = btn.closest('.row');
      if (row) row.classList.toggle('playing', on);
      if (!on) btn.style.setProperty('--p', 0);
    }
    function stopCurrent() {
      if (!current) return;
      setPlaying(current, false);
      current = null;
      player.pause();
    }
    player.addEventListener('timeupdate', function () {
      if (!current || !player.duration) return;
      current.style.setProperty('--p', (100 * player.currentTime / player.duration).toFixed(1));
    });
    player.addEventListener('ended', stopCurrent);
    player.addEventListener('error', stopCurrent);
    Array.prototype.forEach.call(document.querySelectorAll('.play--inline'), function (btn) {
      btn.addEventListener('click', function () {
        if (current === btn) { stopCurrent(); return; }
        stopCurrent();
        current = btn;
        setPlaying(btn, true);
        player.src = btn.getAttribute('data-src');
        player.play().catch(stopCurrent);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') stopCurrent();
    });

    renderRemoved();
    refresh();
  })();
</script>`;
}

/** Inline every clip previews.mjs recorded on a buy row: row key -> data: URI. */
export function loadPreviews(session, log = () => {}) {
  const out = new Map();
  let bytes = 0;
  (session.buy || []).forEach((r, i) => {
    if (!r.previewPath) return;
    try {
      const buf = fs.readFileSync(r.previewPath);
      bytes += buf.length;
      out.set(r.key || String(i), 'data:audio/mpeg;base64,' + buf.toString('base64'));
    } catch { /* clip missing on disk — the row falls back to the store link */ }
  });
  if (out.size) log('      previews: inlined ' + out.size + ' clip(s), ' + (bytes / 1048576).toFixed(1) + ' MB');
  return out;
}

export async function writeReview(sessionPath, outPath, log = () => {}) {
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const art = await loadArt(session, log);
  const previews = loadPreviews(session, log);
  const html = renderReview(session, art, previews, { sessionPath: path.resolve(sessionPath) });
  fs.writeFileSync(outPath, html);
  return outPath;
}

// CLI: node lib/sourcing/review.mjs <session.json> <out.html>
if (process.argv[1] && process.argv[1].endsWith('review.mjs')) {
  const [, , sessionPath, outPath] = process.argv;
  if (!sessionPath || !outPath) {
    console.error('usage: node lib/sourcing/review.mjs <session.json> <out.html>');
    process.exit(1);
  }
  console.log(await writeReview(sessionPath, outPath, m => console.error(m)));
}
