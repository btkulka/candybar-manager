import { chromium } from 'playwright';

const rows = [];
const artists = ['Laurent Garnier', 'DJ Tennis', 'Charlotte de Witte', 'Maceo Plex', 'Derrick May', 'KiNK', 'Aux 88', 'Floating Points', 'Tiga', 'M.A.N.D.Y.', 'Daft Punk', 'Robert Hood', 'Boris Brejcha', 'Paul Kalkbrenner', 'Nina Kraviz', 'Jeff Mills', 'Carl Cox', 'Adam Beyer', 'Amelie Lens', 'I Hate Models'];
const colors = ['#5ce0b8', '#7fffd4', '#f1c40f', '#a78bfa', '#4cd6b0', '#e74c3c', '#88f0d0', '#c084fc', '#70e0c0'];
for (let i = 0; i < 40; i++) {
  const a = artists[i % artists.length];
  rows.push({ title: `Track #${i + 1} — Extended Mix`, artist: a, album: 'Catalog Ref ' + (100 + i), bpm: 115 + (i % 30), dur: `${4 + (i%6)}:${String(10 + (i*7) % 50).padStart(2,'0')}`, format: ['AIFF','WAV','MP3','FLAC'][i%4], healthy: i % 7 !== 0, warn: i % 14 === 0, error: i % 21 === 0, art: colors[i % colors.length] });
}

function mockRow(t, i) {
  const healthCls = t.healthy ? '' : (t.error ? ' has-error' : ' has-warning');
  const formatCls = (t.format === 'AIFF' || t.format === 'WAV') ? 'fmt-lossless' : t.format === 'FLAC' ? 'fmt-flac' : 'fmt-lossy';
  const dot = t.healthy ? '' : `<span class="bv4-health-dot ${t.error ? 'error' : 'warning'}"></span>`;
  const subtitle = `${t.artist}<span class="bv4-sep">·</span>${t.album}`;
  return `<div class="bv4-row${healthCls}" data-id="${i}">
    <span class="bv4-num">${i + 1}</span>
    <div class="bv4-art-wrap" style="background:${t.art}"></div>
    <div class="bv4-title-group">
      <span class="bv4-title">${t.title}</span>
      <span class="bv4-artist">${subtitle}</span>
    </div>
    <div class="bv4-right">
      ${dot}
      <span class="fmt-badge ${formatCls}">${t.format}</span>
      <span class="bv4-bpm">${t.bpm}</span>
      <span class="bv4-dur">${t.dur}</span>
    </div>
  </div>`;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto('http://localhost:5173');
await page.waitForLoadState('domcontentloaded');
await page.evaluate(() => {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const lib = document.getElementById('page-library');
  if (lib) lib.classList.add('active');
});
await page.evaluate((html) => {
  const list = document.getElementById('browse-compact-list');
  if (list) list.innerHTML = html;
}, rows.map((t, i) => mockRow(t, i)).join(''));
await page.waitForTimeout(300);
const scrollable = await page.evaluate(() => {
  const el = document.getElementById('browse-compact-list');
  return { scrollH: el.scrollHeight, clientH: el.clientHeight, canScroll: el.scrollHeight > el.clientHeight };
});
console.log('scroll check:', JSON.stringify(scrollable));
await page.screenshot({ path: '/tmp/cb_scroll_check.png' });
await browser.close();
