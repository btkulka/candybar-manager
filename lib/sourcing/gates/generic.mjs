// Fallback for gate hosts without their own walker (ToneDen, gaterush,
// pumpyoursound, valorizd, plain file hosts). Most only need the link opened and
// their obvious buttons pressed, so that is all this does: wait for a file,
// press each download or follow-style control, then report the page for a
// human. It only fills comment boxes, and never presses anything that spends
// money. ToneDen shuts down on 2026-12-01.

import { saveDownload } from './index.mjs';
import { fillName, fillAddress, fillPhone } from './forms.mjs';
import { hostOf } from '../soundcloud.mjs';

const GO = /\b(free\s*download|download|unlock|get\s*(the\s*)?(track|file|it)|continue|next|skip|follow|connect|like|repost)\b/i;
const STOP = /\b(buy|purchase|pay|checkout|subscribe|sign\s*up|log\s*in|sign\s*in|register|add to cart|pre-?save|cookie|follow us|privacy|powered by|terms|dmca|facebook|instagram|twitter|tiktok|youtube|create your gate|skip to main|make a drop|go to laylo)\b/i;

export async function walkGeneric(ctx, page, row, opts) {
  const { tmpDir, early, comment = null, gateTimeoutMs = 90000 } = opts;
  const deadline = Date.now() + Math.min(gateTimeoutMs, 75000);
  let commented = false;
  let emailed = false;
  const clicked = new Set();
  let file = null;
  early?.then(d => { file = d; });
  await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});

  while (Date.now() < deadline) {
    if (file) return saveDownload(file, tmpDir, 'generic');
    await page.waitForTimeout(2000).catch(() => {});
    if (file) return saveDownload(file, tmpDir, 'generic');
    if (page.isClosed()) break;
    // The gate handed the file to Dropbox or Drive (here or in a new tab):
    // their walker takes the direct-download link from there.
    const fileHost = [page, ...ctx.pages()].find(p => !p.isClosed() && /(^|\.)(dropbox\.com|drive\.google\.com)$/i.test(hostOf(p.url()) || ''));
    if (fileHost) {
      const { walkerFor } = await import('./index.mjs');
      return walkerFor(fileHost.url())(ctx, fileHost, row, opts);
    }
    // An email box gets the saved address, and the name boxes beside it the saved name.
    if (opts.email && !emailed) {
      const box = page.locator('input[type=email]:visible, input[name*=email i]:not([name$=name i]):visible').first();
      if (await box.isVisible().catch(() => false) && !(await box.inputValue().catch(() => ''))) {
        await box.fill(opts.email).catch(() => {});
        await fillName(page, opts.name, opts.email);
        await fillAddress(page, opts.address);
        await fillPhone(page, opts.phone);
        emailed = true;
      }
    }
    // A comment box gets the configured text and nothing else.
    if (comment && !commented) {
      const box = page.locator('input[placeholder*=comment i]:visible, textarea[placeholder*=comment i]:visible').first();
      if (await box.isVisible().catch(() => false)) { await box.fill(comment).catch(() => {}); commented = true; }
    }
    const hit = await page.evaluate(({ go, stop, seen }) => {
      const goRe = new RegExp(go, 'i'), stopRe = new RegExp(stop, 'i');
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
      for (const el of document.querySelectorAll('a, button, [role=button], input[type=submit]')) {
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (!text || seen.includes(text) || !vis(el) || !goRe.test(text) || stopRe.test(text)) continue;
        el.click();
        return text;
      }
      return null;
    }, { go: GO.source, stop: STOP.source, seen: [...clicked] }).catch(() => null);
    if (hit) {
      clicked.add(hit);
      // A social step answers in a pop-up. Let it finish, then allow Download
      // to be pressed again, since it may have been locked the first time.
      if (!/download/i.test(hit)) {
        const until = Date.now() + 20000;
        while (Date.now() < until && !file && ctx.pages().some(p => p !== page && !p.isClosed() && /soundcloud\.com|spotify\.com/i.test(p.url()))) {
          await page.waitForTimeout(1000).catch(() => {});
        }
        for (const c of [...clicked]) if (/download/i.test(c)) clicked.delete(c);
      }
    }
  }
  if (file) return saveDownload(file, tmpDir, 'generic');
  let state = '';
  if (!page.isClosed()) {
    const url = page.url();
    const hasEmail = await page.locator('input[type=email]:visible').count().catch(() => 0);
    state = `${hasEmail ? 'asks for an email' : 'no file after opening'} at ${url}`;
  }
  return { status: 'needs-you', reason: `${state}${clicked.size ? ` (pressed: ${[...clicked].join(', ')})` : ''}` };
}
