import fs from 'fs';

const missing = JSON.parse(fs.readFileSync('/tmp/still_missing_final.json', 'utf8'));

const MAJOR_LABEL_KEYWORDS = [
  'warner', 'universal', 'sony', 'columbia', 'rca', 'atlantic', 'polydor', 'emi',
  'def jam', 'republic', 'interscope', 'capitol', 'parlophone', 'epic', 'virgin',
  'mca', 'island', 'geffen', 'mercury', 'roc nation', 'top dawg', 'cash money',
  'young money', 'motown', 'roadrunner', 'xl recordings', 'domino', '4ad',
  'bmg', 'ninja tune', 'warp', 'sub pop', 'kemosabe', 'beggars',
];
const COMMERCIAL_GENRE_RE = /pop|rock|country|rap|hip-?hop|r&b|soul|folk|indie|alternative|metal|jazz|classical|reggae|singer|songwriter|adult contemporary/i;
const ELECTRONIC_GENRE_RE = /house|techno|electro|trance|dubstep|bass|dnb|drum.?and.?bass|garage|grime|trap|wave|electronica|idm|dance|progressive|mainstage|hardstyle|club/i;
const BOOTLEG_TITLE_RE = /\b(edit|bootleg|flip|vip|mashup|rework|id|intro|outro|acapella)\b/i;

function classify(t) {
  const label = (t.label || '').toLowerCase();
  const genre = (t.genre || '').toLowerCase();
  const title = (t.title || '').toLowerCase();

  const isMajor = MAJOR_LABEL_KEYWORDS.some(k => label.includes(k));
  const isCommercialGenre = COMMERCIAL_GENRE_RE.test(genre);
  const isElectronicGenre = ELECTRONIC_GENRE_RE.test(genre);
  const isBootlegTitle = BOOTLEG_TITLE_RE.test(title);

  if (isMajor || (isCommercialGenre && !isElectronicGenre)) return 'commercial';
  if (isBootlegTitle || (!label && isElectronicGenre)) return 'bootleg_edit';
  if (label && isElectronicGenre) return 'release';
  return 'unknown';
}

const categorized = missing.map(t => ({ ...t, category: classify(t) }));
const counts = categorized.reduce((acc, t) => { acc[t.category] = (acc[t.category] || 0) + 1; return acc; }, {});
console.log('Category counts:', counts);

// Fetch album art from iTunes Search API (public, no auth, direct CDN)
async function deezerSearch(artist, title) {
  try {
    const q = `artist:"${artist.replace(/"/g, '')}" track:"${title.replace(/"/g, '')}"`;
    const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=1`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const first = (data.data || [])[0];
    if (!first) return null;
    return first.album?.cover_medium || first.album?.cover || null;
  } catch { return null; }
}
async function itunesSearch(q) {
  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=1`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const first = (data.results || [])[0];
    if (!first) return null;
    return (first.artworkUrl100 || '').replace('100x100', '300x300');
  } catch { return null; }
}

function stripEdits(title) {
  return (title || '')
    .replace(/\([^)]*\b(remix|edit|bootleg|flip|mix|version|feat|ft|featuring|vip|mashup|remaster|rework)[^)]*\)/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ').trim();
}

async function fetchArtwork(artist, title) {
  const firstArtist = (artist || '').split(/[,&]|feat\.?|ft\.?/i)[0].trim();
  const cleanTitle = stripEdits(title);
  // Deezer first (structured query is precise)
  const deezer = await deezerSearch(firstArtist, cleanTitle || title);
  if (deezer) return deezer;
  // iTunes fallback
  const q = `${firstArtist} ${cleanTitle}`.replace(/&/g, 'and').trim();
  if (!q) return null;
  return await itunesSearch(q);
}

console.log(`Fetching album art for ${categorized.length} tracks from iTunes...`);
let done = 0;
let next = 0;
const CONCURRENCY = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function worker() {
  while (next < categorized.length) {
    const idx = next++;
    const t = categorized[idx];
    t.artworkUrl = await fetchArtwork(t.artist, t.title);
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${categorized.length} fetched, hits=${categorized.filter(x => x.artworkUrl).length}`);
    await sleep(250);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const withArt = categorized.filter(t => t.artworkUrl).length;
console.log(`  Got artwork for ${withArt}/${categorized.length}`);

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function searchUrl(base, q) {
  return base + encodeURIComponent(q);
}

const CATEGORY_COLORS = {
  commercial: '#8b95a7',
  bootleg_edit: '#e8a547',
  release: '#4a90d9',
  unknown: '#b862cc',
};

const rows = categorized.map((t, i) => {
  const q = `${t.artist} ${t.title}`;
  const links = [
    ['Beatport', searchUrl('https://www.beatport.com/search?q=', q)],
    ['Qobuz',    searchUrl('https://www.qobuz.com/us-en/search?q=', q)],
    ['SoundCloud', searchUrl('https://soundcloud.com/search?q=', q)],
    ['Bandcamp', searchUrl('https://bandcamp.com/search?q=', q)],
    ['Spotify',  searchUrl('https://open.spotify.com/search/', q)],
    ['YouTube',  searchUrl('https://www.youtube.com/results?search_query=', q)],
  ];
  const art = t.artworkUrl ? `<img class="art" src="${esc(t.artworkUrl)}" loading="lazy" alt="">` : `<div class="art noart"></div>`;
  return `<tr data-cat="${t.category}" data-idx="${i}">
    <td class="cat" style="background:${CATEGORY_COLORS[t.category]}">${t.category.replace('_', ' ')}</td>
    <td class="artcell">${art}</td>
    <td class="track">
      <div class="at"><b>${esc(t.artist)}</b> — ${esc(t.title)}</div>
      <div class="meta">${[t.label, t.genre, t.year, t.bpm && `${t.bpm} bpm`, t.key].filter(Boolean).map(esc).join(' · ')}</div>
    </td>
    <td class="links">
      ${links.map(([name, url]) => `<a href="${url}" target="_blank" rel="noopener">${name}</a>`).join(' ')}
    </td>
    <td class="decision">
      <label><input type="radio" name="d${i}" value="hunt"> Hunt</label>
      <label><input type="radio" name="d${i}" value="found"> Found</label>
      <label><input type="radio" name="d${i}" value="lost"> Lost</label>
      <label><input type="radio" name="d${i}" value="skip"> Skip</label>
    </td>
  </tr>`;
}).join('\n');

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Missing Tracks Review (${categorized.length})</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f5f5f7; color: #1c1c1e; font-size: 13px; }
  header { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #ddd; padding: 12px 20px; z-index: 10; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  header h1 { margin: 0 0 8px 0; font-size: 16px; }
  .filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .filters button { border: 1px solid #ccc; background: #fff; padding: 4px 10px; border-radius: 12px; cursor: pointer; font-size: 12px; }
  .filters button.active { background: #1c1c1e; color: #fff; border-color: #1c1c1e; }
  .stats { margin-left: auto; color: #666; font-size: 12px; }
  .export { background: #0a84ff; color: #fff; border: 0; padding: 5px 12px; border-radius: 12px; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; }
  tr { border-bottom: 1px solid #e5e5e7; vertical-align: middle; }
  tr:hover { background: rgba(0,0,0,.02); }
  td { padding: 8px 10px; }
  td.cat { color: #fff; font-weight: 600; font-size: 10px; text-transform: uppercase; text-align: center; width: 90px; padding: 4px; }
  td.artcell { width: 52px; padding: 4px; }
  img.art, div.art { width: 48px; height: 48px; border-radius: 4px; object-fit: cover; display: block; background: #e5e5e7; }
  div.art.noart::after { content: '♫'; display: flex; align-items: center; justify-content: center; height: 100%; color: #bbb; font-size: 20px; }
  td.track .at { font-size: 13px; }
  td.track .meta { color: #777; font-size: 11px; margin-top: 2px; }
  td.links a { color: #0a84ff; text-decoration: none; margin-right: 8px; font-size: 11px; }
  td.links a:hover { text-decoration: underline; }
  td.decision label { margin-right: 6px; font-size: 11px; white-space: nowrap; }
  tr[data-decided="hunt"]  { background: #fff6e0; }
  tr[data-decided="found"] { background: #e0f7e0; }
  tr[data-decided="lost"]  { background: #f0f0f0; opacity: .6; }
  tr[data-decided="skip"]  { opacity: .4; }
</style></head>
<body>
<header>
  <h1>Missing Tracks Review — ${categorized.length} tracks</h1>
  <div class="filters">
    <button data-f="all" class="active">All (${categorized.length})</button>
    <button data-f="bootleg_edit">Bootleg/Edit (${counts.bootleg_edit || 0})</button>
    <button data-f="release">Release (${counts.release || 0})</button>
    <button data-f="unknown">Unknown (${counts.unknown || 0})</button>
    <button data-f="commercial">Commercial (${counts.commercial || 0})</button>
    <span class="stats" id="stats"></span>
    <button class="export" id="exportBtn">Export decisions</button>
  </div>
</header>
<table>${rows}</table>
<script>
const STORAGE_KEY = 'missing-review-v1';
const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
// Apply saved state
for (const [idx, val] of Object.entries(state)) {
  const r = document.querySelector('tr[data-idx="' + idx + '"]');
  if (r) {
    r.dataset.decided = val;
    const inp = r.querySelector('input[value="' + val + '"]');
    if (inp) inp.checked = true;
  }
}
function updateStats() {
  const counts = { hunt: 0, found: 0, lost: 0, skip: 0 };
  for (const v of Object.values(state)) counts[v] = (counts[v] || 0) + 1;
  const total = Object.keys(state).length;
  document.getElementById('stats').textContent =
    \`Decided: \${total} (\${counts.hunt} hunt · \${counts.found} found · \${counts.lost} lost · \${counts.skip} skip)\`;
}
updateStats();
document.querySelectorAll('input[type=radio]').forEach(inp => {
  inp.addEventListener('change', e => {
    const row = e.target.closest('tr');
    const idx = row.dataset.idx;
    state[idx] = e.target.value;
    row.dataset.decided = e.target.value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    updateStats();
  });
});
document.querySelectorAll('.filters button[data-f]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.filters button[data-f]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const f = b.dataset.f;
    document.querySelectorAll('tr[data-cat]').forEach(r => {
      r.style.display = (f === 'all' || r.dataset.cat === f) ? '' : 'none';
    });
  });
});
document.getElementById('exportBtn').addEventListener('click', () => {
  const rows = Array.from(document.querySelectorAll('tr[data-idx]')).map(r => {
    const idx = parseInt(r.dataset.idx, 10);
    return { idx, decision: state[idx] || null };
  });
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'missing-review-decisions.json';
  a.click();
});
</script>
</body></html>`;

const OUT = '/Volumes/Time Machin/missing_review.html';
fs.writeFileSync(OUT, html);
console.log(`Wrote ${OUT}`);
console.log(`Open with: open "${OUT}"`);
