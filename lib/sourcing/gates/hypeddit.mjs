// Hypeddit gate walker.
//
// Markup as observed live on 2026-09-23 (hypeddit.com/<artist>/<slug>, which
// redirects to a short /<uid> URL):
//   #downloadProcess            the green "Download" button; opens the steps
//   #myCarousel .all_steps      one slide per step
//   #step_sc                    "Please support the artist to unlock…"
//     a.hype-btn-social.undone[data-step=follow|like|repost][data-url]
//                               each opens a SoundCloud pop-up (PopupCenterDual)
//                               and marks itself done on click — the gate only
//                               counts the click, it cannot see the account
//   #skipper_sc_next / #skipper_sc_channel   "Next" (skips the step)
//   .button-next                the generic advance button on other steps
//   input[type=email]           the email step, when the gate has one
//   #gateDownloadButton         the final "Download"
//   #download-started           "your download has started"
//   #download-link-sent         the file went to your inbox instead
//
// The account actions the gate asks for (follow / like / repost) are done
// through the SoundCloud session for real when `scActions` names them, then
// the gate's own button is clicked so its step counter advances either way.

import { awaitDownload, saveDownload } from './index.mjs';
import { fillName } from './forms.mjs';
import { resolveInSession, followUser, likeTrack, repostTrack, commentTrack } from '../soundcloud.mjs';

const visible = async loc => { try { return await loc.first().isVisible(); } catch { return false; } };

// Every gate button is an <a href="javascript:void(0)"> with an onclick
// handler, and the carousel slide sits over the download button, so a real
// pointer click is "intercepted" and Playwright waits forever. Firing the
// element's own click() runs the handler regardless (verified live).
const jsClick = async loc => { try { await loc.first().evaluate(el => el.click()); return true; } catch { return false; } };
const clickIf = async (page, sel) => {
  const loc = page.locator(sel);
  if (await visible(loc)) return jsClick(loc);
  return false;
};

async function doAccountAction(step, dataUrl, row, opts) {
  const { sc, scActions = [], log = () => {} } = opts;
  if (!scActions.includes(step)) return { skipped: true };
  if (!sc?.sess?.signedIn || !sc.page) return { skipped: true, reason: 'signed out' };
  try {
    if (step === 'follow') {
      const target = dataUrl ? await resolveInSession(sc.page, sc.sess, dataUrl) : null;
      if (target?.kind !== 'user') return { ok: false, reason: 'could not resolve artist' };
      return await followUser(sc.page, sc.sess, target.id);
    }
    if (step === 'like' || step === 'repost' || step === 'comment') {
      let trackId = row.scId;
      if (dataUrl && !/^https?:\/\/(www\.)?soundcloud\.com\/[^/]+\/?$/.test(dataUrl)) {
        const target = await resolveInSession(sc.page, sc.sess, dataUrl);
        if (target?.kind === 'track') trackId = target.id;
      }
      if (step === 'like') return await likeTrack(sc.page, sc.sess, trackId);
      if (step === 'repost') return await repostTrack(sc.page, sc.sess, trackId);
      // The comment is always the configured text — never the gate's preset.
      if (!opts.comment) return { skipped: true, reason: 'no comment text' };
      return await commentTrack(sc.page, sc.sess, trackId, opts.comment);
    }
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { skipped: true };
}

export async function walkHypeddit(ctx, page, row, opts) {
  const { log = () => {}, tmpDir, email = null, comment = null, gateTimeoutMs = 90000 } = opts;
  const deadline = Date.now() + gateTimeoutMs;
  const clicked = new Set();
  let idle = 0;
  let opens = 0;

  // The handlers are bound late; clicking before the page's scripts have run
  // does nothing and the walk stalls with the steps still hidden.
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await clickIf(page, 'button.js-cookie-consent-agree');

  // A Hypeddit smart link (Play / Buy / Download per service) is not the gate
  // itself; its Download entry points at the real gate. Seen live 2026-11-02.
  const gateHref = await page.locator('a.smartlink-click-button').filter({ hasText: /download/i }).first().getAttribute('href', { timeout: 1000 }).catch(() => null);
  if (gateHref && /hypeddit\.com\//i.test(gateHref) && gateHref !== page.url()) {
    log('          Hypeddit smart link — following its Download entry to the gate');
    await page.goto(gateHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(err => {
      if (!/download is starting/i.test(err.message)) throw err;
    });
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await clickIf(page, 'button.js-cookie-consent-agree');
  }

  const finalButton = page.locator('#gateDownloadButton');

  while (Date.now() < deadline) {
    let acted = false;

    // 0. A comment box, wherever the gate puts one: it gets the configured
    //    text, replacing whatever the artist pre-filled.
    if (comment) {
      const box = page.locator('textarea:visible, input[type=text][name*=comment i]:visible, input[type=text][id*=comment i]:visible');
      if (await visible(box)) {
        const key = 'comment|' + ((await box.first().getAttribute('id').catch(() => null)) || (await box.first().getAttribute('name').catch(() => null)) || 'box');
        if (!clicked.has(key)) {
          clicked.add(key);
          await box.first().fill(comment).catch(() => {});
          acted = true;
          await page.waitForTimeout(300);
        }
      }
    }

    // 1. Support steps: follow / like / repost / comment (and other networks'
    //    equivalents). Each is clicked once; the gate counts the click.
    const social = page.locator('a.hype-btn-social:visible');
    const n = await social.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = social.nth(i);
      const step = (await el.getAttribute('data-step').catch(() => null)) || '';
      const type = (await el.getAttribute('data-type').catch(() => null)) || '';
      const dataUrl = await el.getAttribute('data-url').catch(() => null);
      const text = ((await el.innerText().catch(() => '')) || '').trim();
      const id = `social|${step}|${type}|${dataUrl}|${text}`;
      if (clicked.has(id)) continue;
      clicked.add(id);
      if (type === 'soundcloud' && step) {
        const r = await doAccountAction(step, dataUrl, row, opts);
        if (r.ok) log(`          ${step}: done`);
        else if (!r.skipped) log(`          ${step}: ${r.reason || 'HTTP ' + r.status} (gate step still counted)`);
      }
      await jsClick(el);
      acted = true;
      await page.waitForTimeout(900);
      // Spotify answers through its own pop-up; give it time to come back
      // before the walk presses on to the final button.
      if (type === 'spotify') {
        const until = Date.now() + 20000;
        while (Date.now() < until && ctx.pages().some(p => !p.isClosed() && /spotify\.com/i.test(p.url()))) {
          await page.waitForTimeout(1000);
        }
        await page.waitForTimeout(1500);
      }
    }

    // 2. Email step.
    // Hypeddit's first-name box is #email_name, so a bare "name contains email"
    // match lands on it and the address never reaches #email_address.
    const emailInput = page.locator('input[type=email]:visible, input[name*=email i]:not([name$=name i]):visible');
    if (await visible(emailInput)) {
      if (!email) return { status: 'needs-email', reason: 'gate asks for an email address (pass --email)' };
      const key = 'email|' + email;
      if (!clicked.has(key)) {
        clicked.add(key);
        await emailInput.first().fill(email).catch(() => {});
        await fillName(page, opts.name, email);
        await clickIf(page, '#email_to_downloads_next:visible, button.button-primary:visible, button[type=submit]:visible');
        acted = true;
        await page.waitForTimeout(1200);
      }
    }

    // 3. Advance buttons, each once.
    const nexts = page.locator('#skipper_sc_next:visible, #skipper_sc_channel:visible, .button-next:visible');
    const nn = await nexts.count().catch(() => 0);
    for (let i = 0; i < nn; i++) {
      const el = nexts.nth(i);
      const key = 'next|' + ((await el.getAttribute('id').catch(() => null)) || ((await el.innerText().catch(() => '')) + '#' + i));
      if (clicked.has(key)) continue;
      clicked.add(key);
      await jsClick(el);
      acted = true;
      await page.waitForTimeout(1000);
    }
    if (acted) { idle = 0; continue; }

    // 4. The finish line — only once every visible step has been clicked.
    if (await visible(finalButton)) {
      // Arm the listener before the click: the file starts within a second.
      const pending = awaitDownload(ctx, { timeoutMs: 60000 }).then(d => ({ download: d }), () => ({ timeout: true }));
      await jsClick(finalButton);
      const emailed = page.locator('#download-link-sent');
      let settled = false;
      const outcome = await Promise.race([
        pending,
        (async () => {
          for (let i = 0; i < 60 && !settled; i++) {
            await page.waitForTimeout(1000).catch(() => {});
            if (await visible(emailed)) return { emailed: true };
          }
          return { timeout: true };
        })(),
      ]);
      settled = true;
      if (outcome.download) return saveDownload(outcome.download, tmpDir, 'hypeddit');
      if (outcome.emailed) return { status: 'emailed', reason: 'Hypeddit sent the download link by email' };
      if (await visible(page.locator('#download-started'))) {
        const late = await pending;
        if (late.download) return saveDownload(late.download, tmpDir, 'hypeddit');
      }
      return { status: 'stalled', reason: 'final Download button clicked but no file arrived' };
    }

    // 5. Nothing to do: the step panel may not have opened yet.
    if (opens < 3 && await visible(page.locator('#downloadProcess'))) {
      opens++;
      await jsClick(page.locator('#downloadProcess'));
      await page.waitForTimeout(1500);
      continue;
    }

    // Hypeddit's "arcade": after a couple of downloads from one browser the
    // gate is replaced by a hot-or-not rating game (seen live on the third
    // download in a row). Nothing to automate — the person rates a few tracks
    // and the gate comes back, which is what --assist waits for.
    if (await visible(page.locator('#hot-music, #not-hot-music, .arcadegate_include, #arcade_previous_download'))) {
      return { status: 'needs-you', reason: 'Hypeddit Arcade: rate a few tracks (hot / not) in the Chrome window before it allows more downloads' };
    }
    const popup = page.locator('.new-popup-container:visible');
    if (await visible(popup)) {
      const text = ((await popup.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (/play to continue|how to play|rate tracks/i.test(text)) {
        return { status: 'needs-you', reason: `Hypeddit wants you to play its rating game before more downloads ("${text}")` };
      }
    }

    idle++;
    if (idle >= 4) {
      const seen = await describeVisible(page);
      if (process.env.CANDYBAR_GATE_DEBUG) log(`          gate state: ${seen}`);
      return { status: 'stalled', reason: `no actionable step found on the gate (visible: ${seen.slice(0, 160)})` };
    }
    await page.waitForTimeout(1000);
  }
  return { status: 'stalled', reason: 'gate timed out' };
}

/** A one-line picture of what the gate is showing, for the stall report. */
async function describeVisible(page) {
  try {
    return await page.evaluate(() => {
      const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const els = [...document.querySelectorAll('a, button, input:not([type=hidden]), .modal, [class*=popup]')].filter(vis);
      return els.map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} "${(e.innerText || e.value || e.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 30)}"`).slice(0, 14).join(' · ');
    });
  } catch { return 'page gone'; }
}
