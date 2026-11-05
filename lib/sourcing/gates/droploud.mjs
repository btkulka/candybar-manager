// Droploud gate walker.
//
// Rewritten 2026-11-04 from the live site: 31 gates read signed out, two
// rendered in a throwaway browser, and the gate's own scripts. The page ships
// its steps in "gateData" (gates/inspect.mjs reads it), so the walk knows up
// front what it will be asked for. Two step UIs are live; both are handled by
// their visible words, the class names only narrowing the search:
//
//   open        button.ds-gate-wide "Free download"           opens the steps
//   email       input[type=email] + a consent checkbox        "Continue →"
//   disclaimer  "I have the right to download…" checkbox      "I confirm →"
//   follows     ul.ds-honor-list > li.ds-honor-row, each with  "I've done it"
//   (Instagram, .ds-honor-act button "Open"; the confirm stays
//    TikTok…)   disabled until every row has been opened (honor system)
//   SoundCloud  a comment box ("Type your comment") first, then
//               button.ds-sc-btn "Connect with SoundCloud" (older UI:
//               "Connect SoundCloud"). Droploud follows, likes, reposts and
//               posts the comment itself through the grant, and its server
//               refuses the download until it has ("SoundCloud comment step
//               not completed").
//   verify      after the grant (seen live 2026-11-05): steps Droploud does NOT
//   steps       do through the grant, one card each — "Repost the track":
//               "1 · Tap Repost, 2 · Come back here and tap Verify", with
//               "Open track on SoundCloud". Its server then checks the account.
//               Done here as the signed-in account (opts.sc), then Verify.
//   Spotify,    optional: a "Skip" button (.dtr-dlfollow-skip). Never connected.
//   Droploud
//   follow
//   download    "Download unlocked" + button "Download". The file comes as a
//               download, or (an "external" file) opens in a new tab, which
//               the generic walker then tries.
//
// The SoundCloud grant was not walked live (it acts on the signed-in
// account), so that step leans on approveSoundCloudConnect like the others.
// `dryRun` walks every step that touches no account and submits nothing —
// it stops short of an email, the SoundCloud grant and the download.

import { saveDownload, awaitDownload, approveSoundCloudConnect, visible, jsClick } from './index.mjs';
import { parseDroploudGate, summarizeDroploudGate } from './inspect.mjs';
import { walkGeneric } from './generic.mjs';
import { hostOf, resolveInSession, followUser, likeTrack, repostTrack, commentTrack } from '../soundcloud.mjs';
import { fillPhone } from './forms.mjs';

const textRe = s => new RegExp(`^\\s*${s}\\s*$`, 'i');

/** The visible, enabled button whose words match, or null. */
async function button(page, words, { scope = '' } = {}) {
  const loc = page.locator(`${scope} button:visible, ${scope} a.ds-btn:visible`).filter({ hasText: words });
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    const off = await el.evaluate(b => b.disabled || b.classList.contains('ds-disabled') || b.getAttribute('aria-disabled') === 'true').catch(() => true);
    if (!off) return el;
  }
  return null;
}

/** SoundCloud's connect button, enabled (it waits for the comment), and never
 *  Spotify's: the popup janitor agrees to whatever OAuth opens, and on
 *  Droploud Spotify is always skipped. The newer UI's button reads "Connect
 *  with" plus a SoundCloud logo; the older one "Connect SoundCloud". */
async function soundCloudConnect(page) {
  const loc = page.locator('button.ds-sc-btn:visible, button:visible').filter({ hasText: /connect/i });
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    const ok = await el.evaluate(b => !b.disabled
      && (b.classList.contains('ds-sc-btn') || /soundcloud/i.test(`${b.innerText} ${b.getAttribute('aria-label') || ''} ${b.innerHTML}`))
      && !/spotify/i.test(`${b.innerText} ${b.getAttribute('aria-label') || ''}`)).catch(() => false);
    if (ok) return el;
  }
  return null;
}

/** Tick a checkbox whose label says `words`, if it isn't ticked. */
async function tick(page, words) {
  const box = page.locator('label:visible').filter({ hasText: words }).locator('input[type=checkbox]');
  if (!(await box.count().catch(() => 0))) return false;
  if (await box.first().isChecked().catch(() => true)) return false;
  await box.first().evaluate(el => el.click()).catch(() => {});
  return true;
}

export async function walkDroploud(ctx, page, row, opts) {
  const { tmpDir, early, email = null, comment = null, scActions = [], dryRun = false, gateTimeoutMs = 90000, log = () => {} } = opts;
  const deadline = Date.now() + gateTimeoutMs;
  let file = null;
  early?.then(d => { file = d; });

  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500).catch(() => {});
  // Only if it's there: a click on a missing element waits out its timeout.
  const cookies = page.locator('button:has-text("Reject non-essential"):visible');
  if (await visible(cookies)) await jsClick(cookies);

  // What the gate will ask for, before anything is pressed.
  const info = summarizeDroploudGate(parseDroploudGate(await page.content().catch(() => '')));
  if (info) {
    log(`          Droploud asks for ${info.needs.join(', ') || 'nothing'}${info.optional.length ? ` (optional, skipped: ${info.optional.join(', ')})` : ''}`);
    if (!dryRun) {
      if (info.needs.includes('email') && !email) return { status: 'needs-email', reason: 'Droploud asks for an email address (save one in Settings, or pass --email)' };
      if (info.needs.includes('soundcloud-connect') && !scActions.length) {
        return { status: 'needs-you', reason: 'Droploud wants SoundCloud connected so it can follow, like, repost and comment (account actions are off)' };
      }
      if (info.needs.includes('comment') && !comment) return { status: 'needs-you', reason: 'Droploud wants a comment and no comment text is set' };
    }
  }

  const done = new Set();
  let idle = 0, connects = 0, downloads = 0, opens = 0;
  while (Date.now() < deadline) {
    if (file) return saveDownload(file, tmpDir, 'droploud');
    if (page.isClosed()) break;
    // The SoundCloud grant can open in this tab instead of a pop-up.
    if (!dryRun && await approveSoundCloudConnect(page)) { await page.waitForTimeout(2000).catch(() => {}); continue; }
    let acted = false;

    // The download itself, once unlocked.
    const dl = await button(page, textRe('download'));
    if (dl) {
      if (dryRun) return { status: 'dry-run', reason: 'every step done; the download is unlocked' };
      if (downloads++ >= 3) return { status: 'stalled', reason: 'Droploud\'s Download button gave no file' };
      const before = new Set(ctx.pages());
      const pending = awaitDownload(ctx, { timeoutMs: 45000 }).catch(() => null);
      await jsClick(dl);
      log('          Droploud: download unlocked');
      const d = await Promise.race([pending, page.waitForTimeout(8000).then(() => 'tab')]);
      if (d && d !== 'tab') return saveDownload(d, tmpDir, 'droploud');
      // An "external" file opens in a new tab (a Drive or Dropbox page, say).
      const tab = ctx.pages().find(p => !before.has(p) && !p.isClosed() && !/(^|\.)droploud\.com$/.test(hostOf(p.url()) || ''));
      if (tab) {
        log(`          Droploud handed the file to ${hostOf(tab.url())}`);
        return walkGeneric(ctx, tab, row, { ...opts, early: pending, gateTimeoutMs: Math.max(20000, deadline - Date.now()) });
      }
      const late = await pending;
      if (late) return saveDownload(late, tmpDir, 'droploud');
      acted = true;
    }

    // Open the steps.
    const cta = !acted && await button(page, textRe('free download'));
    if (cta && opens < 3) { opens++; await jsClick(cta); acted = true; }

    // Email, with its consent box.
    const emailBox = page.locator('input[type=email]:visible');
    if (!acted && await visible(emailBox) && !done.has('email')) {
      if (dryRun) return { status: 'dry-run', reason: 'reached the email step' };
      if (!email) return { status: 'needs-email', reason: 'Droploud asks for an email address' };
      await emailBox.first().fill(email).catch(() => {});
      await fillPhone(page, opts.phone);
      await tick(page, /agree to receive|store my email|privacy/i);
      const go = await button(page, /continue/i);
      if (go) await jsClick(go);
      done.add('email');
      acted = true;
    }

    // The rights checkbox.
    if (!acted && await tick(page, /right to download/i)) {
      const go = await button(page, /i confirm/i);
      if (go) await jsClick(go);
      log('          Droploud: rights confirmed');
      acted = true;
    }

    // Follows on other sites: open each link, then "I've done it".
    if (!acted) {
      const rows = page.locator('li.ds-honor-row:visible');
      const n = await rows.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const r = rows.nth(i);
        const cls = (await r.getAttribute('class').catch(() => '')) || '';
        if (/\bis-(open|done)\b/.test(cls)) continue;
        const open = r.locator('.ds-honor-act button, .ds-honor-act .ds-btn').first();
        if (await visible(open)) {
          await jsClick(open);
          const name = ((await r.locator('.ds-honor-n a').first().innerText().catch(() => '')) || '').trim();
          log(`          Droploud: opened ${name || 'a follow link'}`);
          acted = true;
          await page.waitForTimeout(1200).catch(() => {});
        }
      }
      const confirm = await button(page, /i[’']ve done it|i did it/i);
      if (confirm) { await jsClick(confirm); acted = true; }
    }

    // SoundCloud: the comment first, then the grant.
    if (!acted) {
      const box = page.locator('textarea[placeholder*=comment i]:visible, input[placeholder*=comment i]:visible');
      // A dry run stops at the card, before typing: Droploud may save the
      // comment as it's typed.
      if (dryRun && (await visible(box) || await visible(page.locator('button.ds-sc-btn:visible')))) {
        return { status: 'dry-run', reason: 'reached the SoundCloud step' };
      }
      if (comment && !done.has('comment') && await visible(box)) {
        await box.first().fill(comment).catch(() => {});
        done.add('comment');
        acted = true;
      }
      const connect = !acted && (await soundCloudConnect(page));
      if (connect) {
        if (dryRun) return { status: 'dry-run', reason: 'reached the SoundCloud step' };
        if (!scActions.length) return { status: 'needs-you', reason: 'Droploud wants SoundCloud connected (account actions are off)' };
        if (connects >= 2) return { status: 'stalled', reason: 'SoundCloud connect did not finish on Droploud' };
        connects++;
        log('          connecting SoundCloud for Droploud…');
        await jsClick(connect);
        // The grant runs in a pop-up the popup janitor approves; wait it out.
        const until = Date.now() + 30000;
        await page.waitForTimeout(3000).catch(() => {});
        while (Date.now() < until && ctx.pages().some(p => p !== page && !p.isClosed() && /soundcloud\.com|droploud\.com\/api\/soundcloud/i.test(p.url()))) {
          await page.waitForTimeout(1000).catch(() => {});
        }
        acted = true;
      }
    }

    // Verify steps: do the action as the signed-in account, then Verify.
    if (!acted) {
      const v = await verifyStep(page, row, opts, done, log);
      if (v && typeof v === 'object') return v;
      if (v) acted = true;
    }

    // Optional steps (Spotify, following on Droploud): skip them.
    if (!acted) {
      const skip = await button(page, textRe('skip'));
      if (skip) { await jsClick(skip); log('          Droploud: skipped an optional step'); acted = true; }
    }

    if (acted) { idle = 0; await page.waitForTimeout(1500).catch(() => {}); continue; }
    // Droploud re-checks a repost on its own ("Checking again in 5s"), so a
    // quiet spell isn't a stall straight away.
    const waiting = await page.locator('text=/checking again|skip this step|confirming|starting your download/i').first().isVisible().catch(() => false);
    if (waiting) { await page.waitForTimeout(2000).catch(() => {}); continue; }
    if (++idle >= 8) return { status: 'stalled', reason: `no step left to take on Droploud${await stepHint(page)}` };
    await page.waitForTimeout(1500).catch(() => {});
  }
  if (file) return saveDownload(file, tmpDir, 'droploud');
  return { status: 'stalled', reason: 'Droploud gate timed out' };
}

/** The step card's heading ("Repost the track"), or ''. */
async function stepHeading(page) {
  return page.evaluate(() => {
    const h = document.querySelector('.ds-gate-card h2, .ds-gate-card h3, .ds-gate-t, .dtr-sc-copy, .ds-gate-sub');
    return h ? h.innerText.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  }).catch(() => '');
}

/** The card's heading, for a stall report: ` (at "Connect SoundCloud")`. */
async function stepHint(page) {
  const t = (await stepHeading(page)).slice(0, 60);
  return t ? ` (at "${t}")` : '';
}

/** Verify-step cards, by heading, and the account action each wants. */
export const VERIFY_STEPS = [
  { re: /\brepost\b/i, step: 'repost' },
  { re: /\blike\b/i, step: 'like' },
  { re: /\bcomment\b/i, step: 'comment' },
  { re: /\bfollow\b/i, step: 'follow' },
];

/**
 * One verify step: the action, once, as the signed-in account (on the track
 * or artist the card's SoundCloud link points at, else the row's track), then
 * "Open track on SoundCloud" (Droploud only shows Verify after it) and Verify.
 * Returns true when it acted, a result object when it can't go on, or null
 * when the card isn't a verify step.
 */
async function verifyStep(page, row, opts, done, log) {
  const heading = await stepHeading(page);
  const v = heading && VERIFY_STEPS.find(s => s.re.test(heading));
  if (!v) return null;
  const { sc, scActions = [], comment = null } = opts;
  const key = `verify|${v.step}`;
  if (!done.has(key)) {
    if (!scActions.includes(v.step)) return { status: 'needs-you', reason: `Droploud wants a ${v.step} on SoundCloud (not allowed in --sc-actions)` };
    if (!sc?.sess?.signedIn || !sc.page) return { status: 'needs-you', reason: `Droploud wants a ${v.step}, and SoundCloud is signed out` };
    if (v.step === 'comment' && !comment) return { status: 'needs-you', reason: 'Droploud wants a comment and no comment text is set' };
    const link = await page.locator('a[href*="soundcloud.com/"]:visible').first().getAttribute('href').catch(() => null);
    const target = link ? await resolveInSession(sc.page, sc.sess, link).catch(() => null) : null;
    const trackId = target?.kind === 'track' ? target.id : row.scId;
    let r;
    try {
      if (v.step === 'repost') r = await repostTrack(sc.page, sc.sess, trackId);
      else if (v.step === 'like') r = await likeTrack(sc.page, sc.sess, trackId);
      else if (v.step === 'comment') r = await commentTrack(sc.page, sc.sess, trackId, comment);
      else {
        const userId = target?.kind === 'user' ? target.id : (target?.user?.id ?? row.uploaderId);
        r = userId ? await followUser(sc.page, sc.sess, userId) : { ok: false, status: 'no artist' };
      }
    } catch (err) { r = { ok: false, status: err.message }; }
    log(`          Droploud: ${v.step} ${r?.ok ? 'done' : `failed (${r?.status})`}`);
    done.add(key);
    const open = await button(page, /open track on soundcloud|open on soundcloud|open soundcloud/i);
    if (open) await jsClick(open);
    await page.waitForTimeout(2500).catch(() => {});
  }
  const verify = await button(page, /^\s*verify/i);
  if (verify) {
    const n = (done[`${key}#n`] = (done[`${key}#n`] || 0) + 1);
    if (n > 4) return { status: 'stalled', reason: `Droploud didn't accept the ${v.step} after 4 tries` };
    await jsClick(verify);
    log(`          Droploud: verify (${v.step})`);
    await page.waitForTimeout(3000).catch(() => {});
  }
  return true;
}
