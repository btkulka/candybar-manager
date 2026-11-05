// Influence Planner gate walker, and a read-only look at a gate before it is
// walked.
//
// Links are ipln.io/<code>, which 301 to gate.influenceplanner.com/<code>
// (first seen 2026-11-04 on Shizz Lo's Go Back flip). The page is a Next.js
// app that ships the gate's whole config in its server payload, signed out:
//
//   "gate":{"trackUrn":"soundcloud:tracks:1862016720",
//           "trackArtists":"John Summit & Sub Focus","trackTitle":"Go Back (Shizz Lo Flip)",
//           "trackFilename":"3IlngjlG.wav", "active":true,
//           "superfanRequired":true, "emailRequired":true, "commentRequired":true, …}
//
// so the file's format and every step are known before anything is clicked.
// The markup, as served on 2026-11-04:
//   form > input#input-superfan-email[type=email]
//   form > button[type=submit] "Connect with SoundCloud"   disabled until the
//          email is filled; it sends the account through SoundCloud's OAuth
//          ("becoming a Superfan": Influence Planner then follows/comments
//          through the grant)
//   button "Download"                                      the file
// The steps after the SoundCloud grant were not seen (that needs the grant on
// Ben's account), so after it this does what the other walkers do: approve the
// connect page, fill a comment box with the configured text, press Download.

import { saveDownload, awaitDownload, approveSoundCloudConnect, visible, jsClick } from './index.mjs';
import { parseInfluencePlannerGate, summarizeInfluencePlannerGate } from './inspect.mjs';

export async function walkInfluencePlanner(ctx, page, row, opts) {
  const { tmpDir, early, email = null, comment = null, scActions = [], dropLossy = false, gateTimeoutMs = 90000, log = () => {} } = opts;
  const deadline = Date.now() + gateTimeoutMs;
  let file = null;
  early?.then(d => { file = d; });
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});

  // Decide from the config before touching the account.
  const info = summarizeInfluencePlannerGate(parseInfluencePlannerGate(await page.content().catch(() => '')));
  if (info) {
    log(`          Influence Planner: ${info.format || 'unknown format'}; asks for ${info.needs.join(', ') || 'nothing'}`);
    if (!info.active) return { status: 'not-free', reason: 'the Influence Planner gate is switched off' };
    if (info.lossless === false && dropLossy) return { status: 'skipped', reason: `the gate gives an ${info.format}, which would be deleted on arrival` };
    if (info.scTrackId && row.scId && String(row.scId) !== info.scTrackId) {
      log(`          note: this gate is for SoundCloud track ${info.scTrackId}, the row is ${row.scId}`);
    }
    if (info.needs.includes('email') && !email) return { status: 'needs-email', reason: 'Influence Planner asks for an email address (save one in Settings, or pass --email)' };
    if ((info.needs.includes('soundcloud-connect') || info.needs.includes('comment')) && !scActions.length) {
      return { status: 'needs-you', reason: 'Influence Planner wants SoundCloud connected so it can follow and comment (account actions are off)' };
    }
    if (info.needs.includes('comment') && !comment) return { status: 'needs-you', reason: 'Influence Planner wants a comment and no comment text is set' };
  }

  const done = new Set();
  let idle = 0, connects = 0, downloads = 0;
  while (Date.now() < deadline) {
    if (file) return saveDownload(file, tmpDir, 'influenceplanner');
    if (page.isClosed()) break;
    // The grant can open in this tab instead of a pop-up.
    if (await approveSoundCloudConnect(page)) { await page.waitForTimeout(2000).catch(() => {}); continue; }
    let acted = false;

    const emailBox = page.locator('#input-superfan-email:visible, input[type=email]:visible');
    if (await visible(emailBox) && !done.has('email')) {
      if (!email) return { status: 'needs-email', reason: 'Influence Planner asks for an email address' };
      await emailBox.first().fill(email).catch(() => {});
      done.add('email');
      acted = true;
    }

    // The comment is always the configured text, never a preset.
    const commentBox = page.locator('textarea:visible, input[placeholder*=comment i]:visible, input[name*=comment i]:visible');
    if (!acted && comment && !done.has('comment') && await visible(commentBox)) {
      await commentBox.first().fill(comment).catch(() => {});
      done.add('comment');
      acted = true;
    }

    const connect = page.locator('button:visible').filter({ hasText: /connect with soundcloud/i });
    if (!acted && await visible(connect) && await connect.first().isEnabled().catch(() => false)) {
      if (!scActions.length) return { status: 'needs-you', reason: 'Influence Planner wants SoundCloud connected (account actions are off)' };
      if (connects >= 2) return { status: 'stalled', reason: 'SoundCloud connect did not finish on Influence Planner' };
      connects++;
      log('          connecting SoundCloud for Influence Planner…');
      await jsClick(connect);
      // A pop-up grant is approved by the popup janitor; a same-tab one above.
      const until = Date.now() + 30000;
      await page.waitForTimeout(3000).catch(() => {});
      while (Date.now() < until && ctx.pages().some(p => p !== page && !p.isClosed() && /soundcloud\.com/i.test(p.url()))) {
        await page.waitForTimeout(1000).catch(() => {});
      }
      acted = true;
    }

    const dl = page.locator('button:visible, a:visible').filter({ hasText: /^\s*(free\s+)?download\s*$/i });
    if (!acted && await visible(dl) && await dl.first().isEnabled().catch(() => false) && downloads < 3) {
      downloads++;
      const pending = awaitDownload(ctx, { timeoutMs: 45000 }).catch(() => null);
      await jsClick(dl);
      const d = await pending;
      if (d) return saveDownload(d, tmpDir, 'influenceplanner');
      acted = true;
    }

    if (acted) { idle = 0; await page.waitForTimeout(1500).catch(() => {}); continue; }
    if (++idle >= 8) {
      const left = info?.needs?.length ? ` (it asks for ${info.needs.join(', ')})` : '';
      return { status: 'stalled', reason: `no step left to take on Influence Planner${left}` };
    }
    await page.waitForTimeout(1500).catch(() => {});
  }
  if (file) return saveDownload(file, tmpDir, 'influenceplanner');
  return { status: 'stalled', reason: 'Influence Planner gate timed out' };
}
