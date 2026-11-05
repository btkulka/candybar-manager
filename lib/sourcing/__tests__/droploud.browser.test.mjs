// Drives the Droploud walker through a local copy of Droploud's gate, in a
// real (headless) Chrome. The markup and words are Droploud's own, as its
// gate scripts render them (read 2026-11-04): the "Free download" opener,
// email + consent → "Continue →", follow rows with "Open" → "I've done it",
// a comment then "Connect with SoundCloud", an optional Spotify step whose
// "Connect Spotify" must never be pressed, "Skip" on the Droploud follow, and
// "Download unlocked" → "Download". The SoundCloud grant is simulated.
//
// Needs Google Chrome: CANDYBAR_BROWSER_TESTS=1 npx vitest run droploud

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { walkDroploud } from '../gates/droploud.mjs';

const RUN = !!process.env.CANDYBAR_BROWSER_TESTS;

const STEPS = [
  { id: 'email', type: 'email', label: 'Email' },
  { id: 'instagram', type: 'instagram_follow', label: 'Follow @jor_music on Instagram', url: 'https://instagram.com/jor_music' },
  { id: 'sc_follow', type: 'soundcloud_follow', label: 'Follow on SoundCloud' },
  { id: 'sc_like', type: 'soundcloud_like', label: 'Like on SoundCloud' },
  { id: 'sc_repost', type: 'soundcloud_repost', label: 'Repost on SoundCloud' },
  { id: 'sc_comment', type: 'soundcloud_comment', label: 'Comment on SoundCloud' },
  { id: 'spotify', type: 'spotify_follow', label: 'Follow on Spotify' },
  { id: 'droploud_follow', type: 'droploud_follow', label: 'Follow JOR on Droploud' },
];

function gatePage(steps = STEPS) {
  const gateData = { track: { id: 't1', title: 'DISPARATE YOUTH (Trance Remix)', soundcloud_url: 'https://soundcloud.com/jor_musicc/disparate-youth' }, artist: { display_name: 'JOR', username: 'jor_music' }, steps, fan_prefill: null, advertise_droploud_follow: true, sc_optional: false };
  // As the Next.js payload carries it: inside a script string, quotes escaped.
  const payload = JSON.stringify(`9:["$","$L1",null,{"gateData":${JSON.stringify(gateData)},"trackId":"t1"}]`);
  return `<!doctype html><html><body>
<section class="ds-panel ds-gate-card"><div class="ds-gate-pane" id="pane"></div></section>
<script>self.__next_f = self.__next_f || []; self.__next_f.push([1, ${payload}]);</script>
<script>
const steps = ${JSON.stringify(steps.map(s => s.type))};
const log = window.__log = [];
const pane = document.getElementById('pane');
let phase = 'open', i = 0;
const groups = [];
for (const t of steps) {
  const g = t.startsWith('soundcloud_') ? 'sc' : t.endsWith('_follow') && !['spotify_follow','droploud_follow'].includes(t) ? 'honor' : t === 'spotify_follow' || t === 'spotify_save' ? 'spotify' : t;
  if (!groups.includes(g)) groups.push(g);
}
function next() { i++; render(); }
function btn(cls, text, on, disabled) { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.innerHTML = text; b.disabled = !!disabled; if (disabled) b.classList.add('ds-disabled'); b.onclick = on; return b; }
function render() {
  pane.innerHTML = '';
  if (phase === 'open') { pane.append(btn('ds-btn ds-h40 ds-solid ds-gate-wide', 'Free download', () => { phase = 'steps'; render(); })); return; }
  const g = groups[i];
  if (!g) {
    pane.innerHTML = '<h2 class="ds-gate-t">Download unlocked</h2>';
    pane.append(btn('ds-btn ds-h40 ds-solid ds-gate-wide', '<svg></svg>Download', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([new Uint8Array([82,73,70,70,36,0,0,0,87,65,86,69])], { type: 'audio/wav' }));
      a.download = 'DISPARATE YOUTH (Trance Remix).wav'; document.body.append(a); a.click(); log.push('download');
    }));
    return;
  }
  if (g === 'email') {
    pane.innerHTML = '<div class="dtr-email-wrap"><div class="ds-field"><label>Your email</label><input type="email" class="ds-input" placeholder="your@email.com"></div><label class="ds-check dtr-check-block"><input type="checkbox"><span class="ds-box"></span><span class="dtr-check-text">I agree to receive this track and occasional artist updates. Droploud stores my email per the privacy policy.</span></label></div>';
    const input = pane.querySelector('input[type=email]'), box = pane.querySelector('input[type=checkbox]');
    const go = btn('ds-btn ds-solid', 'Continue →', () => { log.push('email:' + input.value + ':' + box.checked); next(); }, true);
    const sync = () => { go.disabled = !(input.value && box.checked); go.classList.toggle('ds-disabled', go.disabled); };
    input.oninput = sync; box.onchange = sync; pane.querySelector('.dtr-email-wrap').append(go);
  } else if (g === 'honor') {
    pane.innerHTML = '<p class="ds-gate-sub">Open the link, complete the action, then press I\\'ve done it.</p><ul class="ds-honor-list"><li class="ds-honor-row"><span class="ds-honor-n"><a href="#">@jor_music</a></span><span class="ds-honor-act"></span></li></ul>';
    const row = pane.querySelector('li');
    const done = btn('ds-btn ds-h40 ds-gate-wide', "I've done it", () => { log.push('honor-done'); next(); }, true);
    row.querySelector('.ds-honor-act').append(btn('ds-btn ds-h32', 'Open<span class="ds-sr-only"> Instagram, @jor_music</span>', () => {
      window.open('about:blank', '_blank'); row.classList.add('is-open'); log.push('honor-open'); done.disabled = false; done.classList.remove('ds-disabled');
    }));
    pane.append(done);
  } else if (g === 'sc') {
    pane.innerHTML = '<h2>Connect SoundCloud</h2><div class="ds-field"><label>Your comment</label><input type="text" class="ds-input" placeholder="Type your comment"></div>';
    const input = pane.querySelector('input');
    const go = btn('ds-btn ds-h40 ds-sc-btn', 'Connect with <svg><title>SoundCloud</title></svg>', () => { log.push('sc-connect:' + input.value); setTimeout(next, 400); }, true);
    input.oninput = () => { go.disabled = input.value.trim().length < 2; go.classList.toggle('ds-disabled', go.disabled); };
    pane.append(go);
  } else if (g === 'spotify') {
    pane.innerHTML = '<div class="dtr-social-wrap"><p class="dtr-sc-copy">Optional: connect Spotify to follow + save, or skip. Your download isn\\'t blocked either way.</p></div>';
    const w = pane.querySelector('.dtr-social-wrap');
    w.append(btn('ds-btn ds-solid', 'Connect with Spotify', () => { log.push('SPOTIFY-CONNECT'); }));
    w.append(btn('ds-btn dtr-dlfollow-skip', 'Skip', () => { log.push('spotify-skip'); next(); }));
  } else if (g === 'droploud_follow') {
    pane.innerHTML = '<div class="dtr-dlfollow-wrap"><p class="dtr-dlfollow-copy">Follow JOR on Droploud so their next release lands in your feed. Recommended. You can skip.</p></div>';
    pane.querySelector('.dtr-dlfollow-wrap').append(btn('ds-btn dtr-dlfollow-skip', 'Skip', () => { log.push('dlfollow-skip'); next(); }));
  }
}
render();
</script></body></html>`;
}

describe.skipIf(!RUN)('the Droploud walker, in Chrome', () => {
  let browser, tmpDir;
  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'droploud-walk-'));
  }, 30000);
  afterAll(async () => { await browser?.close(); }, 30000);

  async function walk(opts, steps) {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    await page.setContent(gatePage(steps));
    const result = await walkDroploud(ctx, page, { scId: 1 }, { tmpDir, gateTimeoutMs: 40000, ...opts });
    const log = await page.evaluate(() => window.__log).catch(() => []);
    await ctx.close();
    return { result, log };
  }

  it('walks every step in order and lands the file, skipping Spotify and the Droploud follow', async () => {
    const { result, log } = await walk({ email: 'gates@example.com', comment: 'dis shit nasty', scActions: ['follow', 'like', 'comment'] });
    expect(result, JSON.stringify({ result, log })).toMatchObject({ status: 'downloaded' });
    expect(fs.existsSync(result.tmpPath)).toBe(true);
    expect(log).toEqual(['email:gates@example.com:true', 'honor-open', 'honor-done', 'sc-connect:dis shit nasty', 'spotify-skip', 'dlfollow-skip', 'download']);
    expect(log).not.toContain('SPOTIFY-CONNECT');
  }, 60000);

  it('asks before touching the account, the email or a comment it was not given', async () => {
    expect((await walk({ email: 'a@b.c', comment: 'dis shit nasty', scActions: [] })).result.status).toBe('needs-you');
    expect((await walk({ email: null, comment: 'dis shit nasty', scActions: ['follow'] })).result.status).toBe('needs-email');
    const noComment = await walk({ email: 'a@b.c', comment: null, scActions: ['follow'] });
    expect(noComment.result).toMatchObject({ status: 'needs-you', reason: expect.stringMatching(/comment/) });
    expect(noComment.log).toEqual([]);
  }, 60000);

  it('in a dry run, walks what touches nothing and stops at the first step that would', async () => {
    const noEmail = STEPS.filter(s => s.type !== 'email');
    const { result, log } = await walk({ dryRun: true, comment: 'dis shit nasty' }, noEmail);
    expect(result).toEqual({ status: 'dry-run', reason: 'reached the SoundCloud step' });
    expect(log).toEqual(['honor-open', 'honor-done']);
    expect((await walk({ dryRun: true })).result.reason).toBe('reached the email step');
  }, 60000);
});
