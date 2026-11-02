// Droploud gate walker.
//
// Markup as observed live on 2026-11-02 (droploud.com/track/<uuid>, signed out):
//   button.dtr-card-cta                   "Free download" — opens the steps
//   "STEP n OF m" card, one step at a time:
//     button.ds-solid (sibling)           opens the link (Instagram follow &c.)
//     button.dtr-confirm-btn              "I did it →" — the honor-system confirm
//     button "Connect SoundCloud"         Droploud asks for SoundCloud OAuth and
//                                         runs the follow / like itself
// The steps after "Connect SoundCloud" were not seen (it needs the grant), so
// the rest is generic: comment and email boxes, then any Download button.

import { saveDownload, awaitDownload, approveSoundCloudConnect, visible, jsClick } from './index.mjs';

export async function walkDroploud(ctx, page, row, opts) {
  const { tmpDir, early, email = null, comment = null, scActions = [], gateTimeoutMs = 90000, log = () => {} } = opts;
  const deadline = Date.now() + gateTimeoutMs;
  let file = null;
  early?.then(d => { file = d; });
  const done = new Set();
  let idle = 0, connects = 0, ctas = 0;

  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500).catch(() => {});
  await jsClick(page.locator('button:has-text("Reject non-essential"):visible'));

  while (Date.now() < deadline) {
    if (file) return saveDownload(file, tmpDir, 'droploud');
    if (page.isClosed()) break;
    // Connect can happen in this tab instead of a pop-up.
    if (await approveSoundCloudConnect(page)) { await page.waitForTimeout(2000).catch(() => {}); continue; }
    let acted = false;
    const step = ((await page.evaluate(() => (document.body.innerText.match(/STEP \d+ OF \d+[^\n]*\n?[^\n]*/i) || [''])[0]).catch(() => '')) || '').replace(/\s+/g, ' ').trim();

    // 1. Honor-system steps: open the link, then confirm.
    const confirm = page.locator('button.dtr-confirm-btn:visible');
    if (await visible(confirm) && !done.has('confirm|' + step)) {
      done.add('confirm|' + step);
      await page.evaluate(() => {
        const c = document.querySelector('button.dtr-confirm-btn');
        const open = c?.parentElement?.querySelector('button.ds-solid, a.ds-solid');
        if (open && open !== c) open.click();
      }).catch(() => {});
      await page.waitForTimeout(2500).catch(() => {});
      await jsClick(confirm);
      log(`          ${step.slice(0, 60)}: confirmed`);
      acted = true;
    }

    // 2. SoundCloud connect: an OAuth grant on the account, so only when
    //    account actions are allowed at all.
    const connect = page.locator('button:has-text("Connect SoundCloud"):visible');
    if (!acted && await visible(connect)) {
      if (!scActions.length) return { status: 'needs-you', reason: 'Droploud wants SoundCloud connected (account actions are off: --sc-actions none)' };
      if (connects >= 2) return { status: 'stalled', reason: 'SoundCloud connect did not finish on Droploud' };
      connects++;
      await jsClick(connect);
      log('          connecting SoundCloud for Droploud…');
      const until = Date.now() + 25000;
      await page.waitForTimeout(3000).catch(() => {});
      while (Date.now() < until && ctx.pages().some(p => p !== page && !p.isClosed() && /soundcloud\.com/i.test(p.url()))) {
        await page.waitForTimeout(1000).catch(() => {});
      }
      acted = true;
    }

    // 3. Comment and email boxes.
    if (!acted && comment && !done.has('comment')) {
      const box = page.locator('textarea:visible, input[placeholder*=comment i]:visible');
      if (await visible(box)) { await box.first().fill(comment).catch(() => {}); done.add('comment'); acted = true; }
    }
    const emailBox = page.locator('input[type=email]:visible');
    if (!acted && await visible(emailBox) && !done.has('email')) {
      if (!email) return { status: 'needs-email', reason: 'Droploud asks for an email address (pass --email)' };
      await emailBox.first().fill(email).catch(() => {});
      done.add('email');
      acted = true;
    }

    // 4. Download — a button in the gate card, never the "FREE DL" links to
    //    other tracks lower on the page.
    const dl = page.locator('button:visible').filter({ hasText: /download|unlock|get (the )?file/i });
    if (!acted && await visible(dl)) {
      const isCta = await dl.first().evaluate(el => el.classList.contains('dtr-card-cta')).catch(() => false);
      if (!isCta || ctas++ < 3) {
        const pending = awaitDownload(ctx, { timeoutMs: 45000 }).catch(() => null);
        await jsClick(dl);
        if (!isCta) {
          const d = await pending;
          if (d) return saveDownload(d, tmpDir, 'droploud');
        }
        acted = true;
      }
    }

    if (acted) { idle = 0; await page.waitForTimeout(1500).catch(() => {}); continue; }
    if (++idle >= 6) return { status: 'stalled', reason: `no actionable step on Droploud${step ? ` (at "${step.slice(0, 60)}")` : ''}` };
    await page.waitForTimeout(1500).catch(() => {});
  }
  if (file) return saveDownload(file, tmpDir, 'droploud');
  return { status: 'stalled', reason: 'Droploud gate timed out' };
}
