// Sublair gate walker.
//
// Markup as observed live on 2026-11-02 (sublair.com/download/<id>, a Firebase
// app): input placeholder "Comment required *" and button "CONNECT & UNLOCK",
// which signs in with SoundCloud (OAuth) and posts the comment. What follows
// the connect was not seen (it needs the grant); the walk then waits for the
// file and presses any Download button that appears.

import { saveDownload, awaitDownload, approveSoundCloudConnect, visible, jsClick } from './index.mjs';

export async function walkSublair(ctx, page, row, opts) {
  const { tmpDir, early, comment = null, scActions = [], gateTimeoutMs = 90000, log = () => {} } = opts;
  const deadline = Date.now() + gateTimeoutMs;
  let file = null;
  early?.then(d => { file = d; });
  let connects = 0, idle = 0;
  const pressed = new Set();

  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500).catch(() => {});

  while (Date.now() < deadline) {
    if (file) return saveDownload(file, tmpDir, 'sublair');
    if (page.isClosed()) break;
    if (await approveSoundCloudConnect(page)) { await page.waitForTimeout(2000).catch(() => {}); continue; }

    const box = page.locator('input[placeholder*=comment i]:visible, textarea:visible');
    if (await visible(box) && !(await box.first().inputValue().catch(() => ''))) {
      if (!comment) return { status: 'needs-you', reason: 'Sublair requires a comment and none is configured' };
      await box.first().fill(comment).catch(() => {});
    }

    const connect = page.locator('button:visible').filter({ hasText: /connect|unlock/i });
    if (await visible(connect)) {
      if (!scActions.length) return { status: 'needs-you', reason: 'Sublair wants SoundCloud connected (account actions are off: --sc-actions none)' };
      if (connects >= 2) return { status: 'stalled', reason: 'SoundCloud connect did not finish on Sublair' };
      connects++;
      await jsClick(connect);
      log('          connecting SoundCloud for Sublair…');
      const until = Date.now() + 25000;
      await page.waitForTimeout(3000).catch(() => {});
      while (Date.now() < until && !file && ctx.pages().some(p => p !== page && !p.isClosed() && /soundcloud\.com/i.test(p.url()))) {
        await page.waitForTimeout(1000).catch(() => {});
      }
      idle = 0;
      continue;
    }

    const dl = page.locator('button:visible, a:visible').filter({ hasText: /download/i });
    if (await visible(dl)) {
      const text = ((await dl.first().innerText().catch(() => '')) || '').trim();
      if (!pressed.has(text)) {
        pressed.add(text);
        const pending = awaitDownload(ctx, { timeoutMs: 45000 }).catch(() => null);
        await jsClick(dl);
        const d = await pending;
        if (d) return saveDownload(d, tmpDir, 'sublair');
        continue;
      }
    }

    if (++idle >= 6) return { status: 'stalled', reason: `no actionable step on Sublair (connected ${connects}×)` };
    await page.waitForTimeout(1500).catch(() => {});
  }
  if (file) return saveDownload(file, tmpDir, 'sublair');
  return { status: 'stalled', reason: 'Sublair gate timed out' };
}
