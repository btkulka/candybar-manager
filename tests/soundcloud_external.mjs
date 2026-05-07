// Path B: fetch descriptions for SC matches, find external free-download hosts.
// Phase 1 — discovery only: categorize hosts, don't try to drive them yet.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CONCURRENCY = 8;

const prev = JSON.parse(fs.readFileSync('/tmp/soundcloud_native_result.json', 'utf8'));
const missing = JSON.parse(fs.readFileSync('/tmp/still_missing_after_qobuz.json', 'utf8'));

// Candidates: all missing tracks — redo search to get fresh results + fetch each best match's description.
// (The previous run returned `match` as string; we don't have the SC id. Easiest: re-search.)

const fuzzball = await import('fuzzball');
let clientId = null;
async function getClientId() {
  if (clientId) return clientId;
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
  const home = await (await fetch('https://soundcloud.com/', { headers: { 'User-Agent': UA } })).text();
  for (const m of [...home.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^\s"']+\.js/g)].reverse()) {
    try {
      const js = await (await fetch(m[0], { headers: { 'User-Agent': UA } })).text();
      const sm = js.match(/client_id:\s*"([a-zA-Z0-9]{20,})"/);
      if (sm) { clientId = sm[1]; return clientId; }
    } catch {}
  }
  throw new Error('No client_id');
}

async function searchSC(query) {
  const id = await getClientId();
  const res = await fetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${id}&limit=10`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  if (!res.ok) return [];
  return (await res.json()).collection || [];
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/feat\.?|ft\.?|featuring/g, ' ')
    .replace(/original mix|extended mix|radio edit|club mix/g, ' ').replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function score(a, b) {
  const aN = normalize(a), bN = normalize(b);
  if (!aN || !bN) return 0;
  return Math.max(fuzzball.ratio(aN, bN), fuzzball.token_set_ratio(aN, bN)) / 100;
}

const KNOWN_HOSTS = [
  { host: 'hypeddit.com',      regex: /https?:\/\/(?:www\.)?hypeddit\.com\/[^\s)"']+/gi },
  { host: 'toneden.io',        regex: /https?:\/\/(?:www\.)?toneden\.io\/[^\s)"']+/gi },
  { host: 'fanlink.to',        regex: /https?:\/\/(?:www\.)?fanlink\.to\/[^\s)"']+/gi },
  { host: 'lnk.to',            regex: /https?:\/\/[^\s)"']*lnk\.to\/[^\s)"']+/gi },
  { host: 'smarturl.it',       regex: /https?:\/\/[^\s)"']*smarturl\.it\/[^\s)"']+/gi },
  { host: 'ffm.to',            regex: /https?:\/\/(?:www\.)?ffm\.to\/[^\s)"']+/gi },
  { host: 'linktr.ee',         regex: /https?:\/\/(?:www\.)?linktr\.ee\/[^\s)"']+/gi },
  { host: 'bandcamp.com',      regex: /https?:\/\/[^\s)"']*bandcamp\.com\/[^\s)"']+/gi },
  { host: 'dropbox.com',       regex: /https?:\/\/(?:www\.)?dropbox\.com\/[^\s)"']+/gi },
  { host: 'drive.google.com',  regex: /https?:\/\/drive\.google\.com\/[^\s)"']+/gi },
  { host: 'mediafire.com',     regex: /https?:\/\/(?:www\.)?mediafire\.com\/[^\s)"']+/gi },
  { host: 'mega.nz',           regex: /https?:\/\/(?:www\.)?mega\.nz\/[^\s)"']+/gi },
  { host: 'wetransfer.com',    regex: /https?:\/\/(?:www\.)?wetransfer\.com\/[^\s)"']+/gi },
  { host: 'zippyshare.com',    regex: /https?:\/\/(?:www\.)?[a-z0-9-]+\.zippyshare\.com\/[^\s)"']+/gi },
  { host: 'soundclick.com',    regex: /https?:\/\/(?:www\.)?soundclick\.com\/[^\s)"']+/gi },
  { host: 'pillowcase.su',     regex: /https?:\/\/(?:www\.)?pillowcase\.su\/[^\s)"']+/gi },
];

function findLinks(text) {
  if (!text) return [];
  const hits = [];
  for (const { host, regex } of KNOWN_HOSTS) {
    const matches = text.match(regex) || [];
    for (const u of matches) hits.push({ host, url: u.trim().replace(/[.,;)\]]+$/, '') });
  }
  return hits;
}

const rows = [];
let next = 0;
async function worker() {
  while (next < missing.length) {
    const idx = next++;
    const m = missing[idx];
    try {
      const results = await searchSC(`${m.artist} ${m.title}`);
      let best = null, bestScore = 0;
      for (const r of results) {
        const rTitle = r.title || '';
        const rArtist = r.publisher_metadata?.artist || r.user?.username || '';
        const combined = score(m.title, rTitle) * 0.6 + score(m.artist, rArtist) * 0.4;
        if (combined > bestScore) { bestScore = combined; best = r; }
      }
      if (!best || bestScore < 0.75) {
        rows.push({ missing: m, status: 'no_match' });
        continue;
      }
      const links = findLinks(best.description || '');
      rows.push({
        missing: m,
        scId: best.id,
        scUrl: best.permalink_url,
        scTitle: `${best.user?.username || ''} — ${best.title}`,
        score: +bestScore.toFixed(3),
        downloadable: !!best.downloadable,
        description: (best.description || '').slice(0, 500),
        links,
      });
    } catch (e) {
      rows.push({ missing: m, status: 'error', error: e.message });
    }
    if (idx % 20 === 0) console.log(`[${idx + 1}/${missing.length}]`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// Categorize
const hasLinks = rows.filter(r => r.links?.length > 0);
const byHost = {};
for (const r of hasLinks) {
  for (const l of r.links) {
    byHost[l.host] = (byHost[l.host] || 0) + 1;
  }
}
const downloadable = rows.filter(r => r.downloadable);

console.log(`\nTotal processed: ${rows.length}`);
console.log(`Rows with external links: ${hasLinks.length}`);
console.log(`Rows with SC-native downloadable: ${downloadable.length}`);
console.log(`\nLink hosts found:`);
Object.entries(byHost).sort((a, b) => b[1] - a[1]).forEach(([h, n]) => console.log(`  ${n}\t${h}`));

fs.writeFileSync('/tmp/soundcloud_external_links.json', JSON.stringify(rows, null, 2));
console.log('\nWrote /tmp/soundcloud_external_links.json');
