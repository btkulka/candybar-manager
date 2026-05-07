import { chromium } from 'playwright';

const FIXTURES = [
  { title: 'Acid Strobe (Original Mix)', artist: 'Laurent Garnier', album: 'F Communications', bpm: 128, dur: '6:24', format: 'AIFF', healthy: true, art: '#5ce0b8' },
  { title: 'Plastik', artist: 'Charlotte de Witte', album: 'Formula', bpm: 138, dur: '5:52', format: 'MP3', healthy: false, warn: true, action: 'Re-encode to 320kbps', art: '#f1c40f' },
  { title: 'Turn Me Down (Unreleased)', artist: 'KiNK', album: '', bpm: null, dur: '6:02', format: 'MP3', healthy: false, error: true, action: 'Populate Tags', art: '#e74c3c' },
  { title: 'Second Life', artist: 'Maceo Plex', album: 'Ellum', bpm: 124, dur: '8:01', format: 'FLAC', healthy: true, art: '#a78bfa' },
];

function mockRow(t, i) {
  const healthCls = t.healthy ? '' : (t.error ? ' has-error' : ' has-warning');
  const formatCls = (t.format === 'AIFF' || t.format === 'WAV') ? 'fmt-lossless' : t.format === 'FLAC' ? 'fmt-flac' : 'fmt-lossy';
  const dot = t.healthy ? '' : `<span class="bv4-health-dot ${t.error ? 'error' : 'warning'}"></span>`;
  const action = (!t.healthy && t.action) ? `<button class="bv4-inline-action">${t.action}</button>` : '';
  const subtitle = t.album ? `${t.artist}<span class="bv4-sep">·</span>${t.album}` : t.artist;
  return `<div class="bv4-row${healthCls}" data-id="${i}">
      <span class="bv4-num">${i + 1}</span>
      <div class="bv4-art-wrap" style="background:${t.art}"></div>
      <div class="bv4-title-group">
        <span class="bv4-title">${t.title}</span>
        <span class="bv4-artist">${subtitle}</span>
      </div>
      <div class="bv4-right">
        ${dot}${action}
        <span class="fmt-badge ${formatCls}">${t.format}</span>
        <span class="bv4-bpm">${t.bpm ?? '—'}</span>
        <span class="bv4-dur">${t.dur}</span>
      </div>
    </div>`;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 600 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto('http://localhost:5173');
await page.waitForLoadState('domcontentloaded');
await page.evaluate(() => {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const lib = document.getElementById('page-library');
  if (lib) { lib.classList.add('active'); lib.style.display = 'block'; }
});
await page.evaluate((rows) => {
  const list = document.getElementById('browse-compact-list');
  if (list) list.innerHTML = rows;
}, FIXTURES.map((t, i) => mockRow(t, i)).join(''));
await page.waitForTimeout(200);
// Hover over row 1 (Plastik - warning)
const rows = await page.$$('#browse-compact-list .bv4-row');
await rows[1].hover();
await page.waitForTimeout(250);
const listEl = await page.$('.library-health-panels');
await listEl.screenshot({ path: '/tmp/cb_library_hover.png' });
console.log('saved /tmp/cb_library_hover.png');
await browser.close();
