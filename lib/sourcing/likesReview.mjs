// Renders a SoundCloud likes (or set) session into a review page: what landed in the
// intake folder, what still needs a hand (gates that stalled, files that came
// back lossy), and what was not free at all. Same visual language as the
// playlist review; different buckets, because nothing here is bought.

import fs from 'fs';
import { loadArt } from './review.mjs';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let ART = new Map();
const art = r => {
  const u = r.image || '';
  return u ? `<img class="art" src="${esc(ART.get(u) || u)}" alt="" loading="lazy" />` : '<div class="art art--empty" aria-hidden="true"></div>';
};
const pct = n => `${Math.round((n ?? 0) * 100)}%`;

function fileChips(o) {
  return (o?.files || []).map(f => `<span class="chip ${f.lossless ? 'chip--ok' : 'chip--warn'}">${esc((f.codec || f.ext || '?').toUpperCase())}${f.lossless ? '' : ' · lossy'}</span>`).join('');
}

function downloadedRow(r) {
  const o = r.outcome || {};
  return `
  <li class="row">
    ${art(r)}
    <div class="meta">
      <p class="title">${esc(r.title)}</p>
      <p class="artist">${esc(r.artist)}${r.uploader && r.uploader !== r.artist ? ` <span class="muted">· via ${esc(r.uploader)}</span>` : ''}</p>
      <p class="tags"><span class="chip chip--sc">${esc(o.via || r.free?.kind || '')}</span>${fileChips(o)}${r.libraryStatus === 'probable' ? `<span class="chip chip--warn" title="${esc(r.libraryMatch?.filePath || '')}">maybe already yours · ${pct(r.libraryConfidence)}</span>` : ''}</p>
      ${(o.files || []).map(f => `<p class="path"><code>${esc(f.path)}</code></p>`).join('')}
    </div>
    <a class="btn btn--ghost" href="${esc(r.url || '#')}" target="_blank" rel="noopener noreferrer">SoundCloud ↗</a>
  </li>`;
}

// A page can be shared, so an address a gate was given shows masked.
const maskEmails = t => String(t).replace(/([\w.+-])[\w.+-]*@([\w-]+\.[\w.]+)/g, '$1…@$2');

/** A row whose file arrived but is lossy (MP3 &c): kept under lossy/. */
const isLossy = r => r.outcome?.status === 'downloaded' && (r.outcome.files || []).some(f => f.lossless !== true);

function pendingRow(r) {
  const g = r.free?.gate;
  const o = r.outcome;
  const why = o && o.status !== 'pending' && !isLossy(r) ? `<p class="note">${esc(maskEmails(o.reason || o.status))}</p>` : '';
  const files = fileChips(o);
  return `
  <li class="row">
    ${art(r)}
    <div class="meta">
      <p class="title">${esc(r.title)}</p>
      <p class="artist">${esc(r.artist)}${r.uploader && r.uploader !== r.artist ? ` <span class="muted">· via ${esc(r.uploader)}</span>` : ''}</p>
      <p class="tags"><span class="chip chip--sc">${esc(r.free?.kind === 'native' ? 'SoundCloud download' : (g?.host || 'gate'))}</span>${o?.status ? `<span class="chip ${o.status === 'downloaded' ? 'chip--warn' : ''}">${esc(o.status)}</span>` : ''}${files}${r.libraryStatus === 'probable' ? `<span class="chip chip--warn" title="${esc(r.libraryMatch?.filePath || '')}">maybe already yours · ${pct(r.libraryConfidence)}</span>` : ''}</p>
      ${why}
      ${(o?.files || []).map(f => `<p class="path"><code>${esc(f.path)}</code></p>`).join('')}
    </div>
    ${g?.url ? `<a class="btn" href="${esc(g.url)}" target="_blank" rel="noopener noreferrer">Open gate ↗</a>` : `<a class="btn" href="${esc(r.url || '#')}" target="_blank" rel="noopener noreferrer">SoundCloud ↗</a>`}
  </li>`;
}

function plainRow(r, sub) {
  return `
  <li class="rrow">
    <div>
      <p class="title">${esc(r.artist)} — ${esc(r.title)}</p>
      <p class="sub">${esc(sub)}</p>
      ${r.url ? `<p class="path"><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a></p>` : ''}
    </div>
  </li>`;
}

export function renderLikesReview(session, artMap) {
  ART = artMap instanceof Map ? artMap : new Map();
  const s = session.stats || {};
  const src = session.source || {};
  // A cover that would not inline may still load from a local file; hide it,
  // rather than show a broken-image glyph, when it does not.
  const cover = src.image ? `<img class="cover" src="${esc(ART.get(src.image) || src.image)}" alt="" onerror="this.style.display='none'" />` : '';
  const section = (title, rows, render, open = false) => rows.length ? `
  <details class="panel"${open ? ' open' : ''}>
    <summary>${title} <span class="count">${rows.length}</span></summary>
    <ul>${rows.map(render).join('')}</ul>
  </details>` : '';

  const lossy = (session.flagged || []).filter(isLossy);
  const needs = (session.flagged || []).filter(r => !isLossy(r));
  return `<title>${src.kind === 'set' ? `${esc(src.set || 'SoundCloud')} Set` : `${esc(src.user || 'SoundCloud')} Likes`}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root { --ground:#EEF0F3; --surface:#FFFFFF; --surface-2:#F6F7F9; --line:#D8DCE3; --ink:#101418; --muted:#616A76; --accent:#1F4FD8; --accent-ink:#FFFFFF; --ok:#0F7A55; --warn:#A75418; --sc:#C2410C; --shadow:0 1px 2px rgba(16,20,24,.06),0 8px 24px -16px rgba(16,20,24,.3); --radius:10px; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ground:#0E1116; --surface:#161B22; --surface-2:#1C222B; --line:#2A323D; --ink:#E6EAF0; --muted:#8A94A3; --accent:#6E96FF; --accent-ink:#0B0E13; --ok:#4CC08D; --warn:#E0A26A; --sc:#FB923C; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -18px rgba(0,0,0,.8); } }
  :root[data-theme="dark"] { --ground:#0E1116; --surface:#161B22; --surface-2:#1C222B; --line:#2A323D; --ink:#E6EAF0; --muted:#8A94A3; --accent:#6E96FF; --accent-ink:#0B0E13; --ok:#4CC08D; --warn:#E0A26A; --sc:#FB923C; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -18px rgba(0,0,0,.8); }
  body { margin:0; background:var(--ground); color:var(--ink); font-family:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif; font-size:15px; line-height:1.5; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1040px; margin:0 auto; padding:40px 16px 96px; display:flex; flex-direction:column; gap:28px; }
  h1,h2 { font-family:Archivo,ui-sans-serif,system-ui,sans-serif; margin:0; letter-spacing:-.015em; }
  h1 { font-size:clamp(26px,4vw,38px); font-weight:700; }
  p { margin:0; } code { font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:12px; color:var(--muted); word-break:break-all; }
  .muted { color:var(--muted); }
  header { display:flex; gap:20px; align-items:center; flex-wrap:wrap; }
  .cover { width:88px; height:88px; border-radius:50%; object-fit:cover; box-shadow:var(--shadow); }
  .eyebrow { font-family:"IBM Plex Mono",monospace; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; }
  .tile { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:14px 16px; }
  .tile .n { font-family:Archivo,sans-serif; font-size:26px; font-weight:700; font-variant-numeric:tabular-nums; }
  .tile .l { font-size:12px; color:var(--muted); }
  .tile--ok .n { color:var(--ok); } .tile--warn .n { color:var(--warn); }
  .panel { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); overflow:hidden; }
  summary { cursor:pointer; padding:16px 18px; font-family:Archivo,sans-serif; font-weight:600; font-size:17px; display:flex; align-items:center; gap:10px; }
  .count { font-size:12px; font-weight:500; color:var(--muted); background:var(--surface-2); border:1px solid var(--line); border-radius:999px; padding:1px 8px; }
  ul { list-style:none; margin:0; padding:0; border-top:1px solid var(--line); }
  .row { display:grid; grid-template-columns:48px 1fr auto; gap:14px; align-items:center; padding:12px 18px; border-bottom:1px solid var(--line); }
  .row:last-child { border-bottom:0; }
  .art { width:48px; height:48px; border-radius:6px; object-fit:cover; background:var(--surface-2); display:block; }
  .art--empty { border:1px dashed var(--line); }
  .title { font-weight:600; } .artist { color:var(--muted); font-size:14px; }
  .tags { display:flex; flex-wrap:wrap; gap:6px; margin-top:4px; }
  .chip { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); background:var(--surface-2); color:var(--muted); }
  .chip--ok { color:var(--ok); border-color:color-mix(in srgb,var(--ok) 40%,transparent); }
  .chip--warn { color:var(--warn); border-color:color-mix(in srgb,var(--warn) 40%,transparent); }
  .chip--sc { color:var(--sc); border-color:color-mix(in srgb,var(--sc) 40%,transparent); }
  .note { font-size:13px; color:var(--warn); margin-top:4px; }
  .path { margin-top:2px; }
  .btn { display:inline-block; padding:8px 14px; border-radius:8px; background:var(--accent); color:var(--accent-ink); text-decoration:none; font-weight:600; font-size:13px; white-space:nowrap; }
  .btn--ghost { background:transparent; color:var(--accent); border:1px solid var(--line); }
  .rrow { padding:12px 18px; border-bottom:1px solid var(--line); } .rrow:last-child { border-bottom:0; }
  .rrow .sub { font-size:13px; color:var(--muted); } .rrow a { color:var(--accent); font-size:12px; }
  .intro { color:var(--muted); font-size:14px; }
  @media (max-width:600px) { .row { grid-template-columns:48px 1fr; } .row .btn { grid-column:2; justify-self:start; } }
</style>
<div class="wrap">
  <header>
    ${cover}
    <div>
      <p class="eyebrow">SoundCloud ${src.kind === 'set' ? 'set' : 'likes'} · free downloads</p>
      <h1>${src.kind === 'set' ? esc(src.set || 'Set') : `${esc(src.user || 'Your')} likes`}</h1>
      <p class="muted">${src.kind === 'set'
        ? `${src.user ? `by ${esc(src.user)} · ` : ''}${esc(src.fetchedCount ?? 0)} of ${esc(src.trackCount ?? src.fetchedCount ?? 0)} tracks read${src.unavailable?.length ? ` · ${src.unavailable.length} unavailable` : ''}`
        : `${esc(src.fetchedCount ?? s.total ?? 0)} liked tracks read`}${src.via ? ` via ${esc(src.via)}` : ''} · files land in <code>${esc(session.destDir || '')}</code></p>
    </div>
  </header>
  <section class="tiles">
    <div class="tile tile--ok"><div class="n">${s.downloaded ?? 0}</div><div class="l">downloaded, lossless</div></div>
    ${lossy.length ? `<div class="tile tile--warn"><div class="n">${lossy.length}</div><div class="l">MP3 / lossy, kept</div></div>` : ''}
    <div class="tile tile--warn"><div class="n">${needs.length}</div><div class="l">need your call</div></div>
    <div class="tile"><div class="n">${s.pending ?? 0}</div><div class="l">queued, not fetched</div></div>
    ${s.byHand ? `<div class="tile tile--ok"><div class="n">${s.byHand}</div><div class="l">downloaded by hand</div></div>` : ''}
    ${s.dropped ? `<div class="tile"><div class="n">${s.dropped}</div><div class="l">lossy only, deleted</div></div>` : ''}
    <div class="tile"><div class="n">${s.notFree ?? 0}</div><div class="l">no free download</div></div>
    <div class="tile"><div class="n">${(s.owned ?? 0) + (s.alreadyDownloaded ?? 0)}</div><div class="l">already yours</div></div>
  </section>
  <p class="intro">Lossless files went straight to the intake folder. Anything lossy was kept under <code>lossy/</code> and listed below rather than dropped into the collection.</p>
  ${section('Downloaded', session.downloaded || [], downloadedRow, true)}
  ${section('MP3 / lossy — kept under lossy/', lossy, pendingRow, true)}
  ${section('Need your call', needs, pendingRow, true)}
  ${section('Downloaded by hand', session.byHand || [], r => plainRow(r, maskEmails(r.outcome?.reason || 'finished outside the run')), true)}
  ${section('Queued — not fetched yet', session.queue || [], pendingRow, true)}
  ${section('Deleted — lossy, or already in the library', session.dropped || [], r => plainRow(r, (r.outcome?.dropped || []).map(d => `${d.original || ''} (${(d.codec || d.ext || '?').toUpperCase()})`).join(', ') || r.outcome?.reason || ''))}
  ${section('Not a free download', session.notFree || [], r => plainRow(r, r.free?.reason || ''))}
  ${section('Maybe already yours', session.probable || [], r => plainRow(r, `${r.reason || ''} · ${pct(r.libraryConfidence)} to ${r.libraryMatch?.artist || '?'} — ${r.libraryMatch?.title || '?'}`))}
  ${section('Your own tracks — skipped', session.mine || [], r => plainRow(r, 'uploaded by this account'))}
  ${section('Already in the collection', session.owned || [], r => plainRow(r, r.libraryMatch?.filePath || ''))}
  ${section('Downloaded on an earlier run', session.alreadyDownloaded || [], r => plainRow(r, (r.ledger?.files || []).map(f => f.path).join(', ')))}
</div>`;
}

export async function writeLikesReview(sessionPath, outPath, log = () => {}) {
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  // Reuse the playlist page's cover inliner (artifact CSP blocks remote images):
  // it reads `buy[].image` and `playlist.imageUrl`, so hand it that shape.
  const rows = [...(session.downloaded || []), ...(session.flagged || []), ...(session.queue || [])];
  const artMap = await loadArt({ buy: rows.map(r => ({ image: r.image, match: {} })), playlist: { imageUrl: session.source?.image || null } }, log);
  fs.writeFileSync(outPath, renderLikesReview(session, artMap));
  return outPath;
}

if (process.argv[1] && process.argv[1].endsWith('likesReview.mjs')) {
  const [, , sessionPath, outPath] = process.argv;
  if (!sessionPath || !outPath) {
    console.error('usage: node lib/sourcing/likesReview.mjs <session.json> <out.html>');
    process.exit(1);
  }
  console.log(await writeLikesReview(sessionPath, outPath, m => console.error(m)));
}
