// Bandcamp walker: name-your-price at $0.
//
// Markup as observed live on 2026-11-02 (signed out):
//   [data-tralbum]                         JSON; current.minimum_price, current.require_email
//   button.download-link.buy-link          "Buy Digital Track" / "Buy Digital Album" opens the dialog
//   #userPrice                             the amount; "0" reveals the free link
//   a.download-panel-free-download-link    "download to your computer"
//   #fan_email_address, #fan_email_country, #fan_email_postalcode, button.download-panel-checkout-button
//                                          signed out with require_email: the link is mailed
// Signed in to Bandcamp, the free link goes to bandcamp.com/download, whose
// #pagedata[data-blob] lists a URL per encoding (unverified live — the profile
// has never been signed in to Bandcamp).
//
// Never pays: a release with a minimum price is reported as not free.

import { saveDownload, visible, jsClick } from './index.mjs';
import { downloadUrlToFile } from '../downloads.mjs';
import { hostOf } from '../soundcloud.mjs';

// Lossless first, in the order the library wants them.
const ENCODINGS = ['wav', 'aiff-lossless', 'flac', 'alac', 'mp3-320', 'mp3-v0'];

const isDownloadPage = url => hostOf(url) === 'bandcamp.com' && /^\/download\b/.test(new URL(url).pathname);

export async function walkBandcamp(ctx, page, row, opts) {
  const { tmpDir, early, email = null, postcode = null } = opts;
  let file = null;
  early?.then(d => { file = d; });
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});

  if (isDownloadPage(page.url())) return fromDownloadPage(page, tmpDir);

  const tralbum = await page.evaluate(() => {
    try { return JSON.parse(document.querySelector('[data-tralbum]').getAttribute('data-tralbum')); } catch { return null; }
  }).catch(() => null);
  if (!tralbum) return { status: 'needs-you', reason: `not a Bandcamp track or album page: ${page.url()}` };
  if (tralbum.freeDownloadPage) {
    await page.goto(tralbum.freeDownloadPage, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return fromDownloadPage(page, tmpDir);
  }
  const min = Number(tralbum.current?.minimum_price || 0);
  if (min > 0) return { status: 'not-free', reason: `Bandcamp sells it for $${min.toFixed(2)} minimum — no name-your-price` };

  await jsClick(page.locator('button.buy-link:has-text("Buy Digital")'));
  const price = page.locator('#userPrice');
  if (!await price.waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false)) {
    return { status: 'stalled', reason: 'Bandcamp buy dialog did not open' };
  }
  await price.fill('0');
  await page.waitForTimeout(800);
  const freeLink = page.locator('a.download-panel-free-download-link');
  if (!await visible(freeLink)) return { status: 'stalled', reason: 'no "download to your computer" link at $0' };
  await jsClick(freeLink);
  await page.waitForTimeout(2500);

  if (file) return saveDownload(file, tmpDir, 'bandcamp');
  if (isDownloadPage(page.url())) return fromDownloadPage(page, tmpDir);

  // Signed out and the artist wants an address: Bandcamp mails the link.
  const emailBox = page.locator('#fan_email_address');
  if (await visible(emailBox)) {
    if (!email) return { status: 'needs-email', reason: 'Bandcamp mails free downloads to an address when signed out (pass --email, and --postcode for the US)' };
    await emailBox.fill(email);
    if (postcode) await page.locator('#fan_email_postalcode').fill(postcode).catch(() => {});
    await jsClick(page.locator('button.download-panel-checkout-button'));
    await page.waitForTimeout(3000);
    const dialog = ((await page.locator('.ui-dialog:visible').first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    if (/zip|postal/i.test(dialog) && /required|invalid|enter/i.test(dialog) && !postcode) {
      return { status: 'needs-email', reason: 'Bandcamp also wants a zip code (pass --postcode)' };
    }
    return { status: 'emailed', reason: `Bandcamp emailed the download link to ${email}` };
  }
  return { status: 'stalled', reason: 'free download chosen but neither a file nor an email form appeared' };
}

/** bandcamp.com/download: pick the best encoding, wait for Bandcamp to
 *  prepare it (statdownload), then fetch the signed URL directly. */
async function fromDownloadPage(page, tmpDir) {
  const downloads = await page.evaluate(() => {
    try {
      const blob = JSON.parse(document.querySelector('#pagedata').getAttribute('data-blob'));
      const item = (blob.digital_items || blob.download_items || [])[0];
      return item?.downloads || null;
    } catch { return null; }
  }).catch(() => null);
  if (!downloads) return { status: 'needs-you', reason: `Bandcamp download page without a file list: ${page.url()}` };
  const enc = ENCODINGS.find(e => downloads[e]?.url);
  if (!enc) return { status: 'needs-you', reason: `Bandcamp offers only ${Object.keys(downloads).join(', ')}` };

  let url = downloads[enc].url;
  const stat = url.replace('/download/', '/statdownload/');
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${stat}&.vrs=1&.rand=${Date.now()}`).then(res => res.text()).catch(() => '');
    const m = r.match(/\{[\s\S]*\}/);
    let j = null;
    try { j = m ? JSON.parse(m[0]) : null; } catch { /* still preparing */ }
    if (j?.result === 'ok') { url = j.download_url || url; break; }
    if (j?.retry_url) url = j.retry_url.replace('/statdownload/', '/download/');
    await new Promise(res => setTimeout(res, 2000));
  }
  const dl = await downloadUrlToFile(url, tmpDir);
  return { status: 'downloaded', tmpPath: dl.tmpPath, filename: dl.filename, via: `bandcamp:${enc}` };
}
