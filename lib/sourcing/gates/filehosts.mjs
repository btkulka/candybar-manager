// File-host links: the free file sits on Dropbox or Google Drive, behind a
// preview page, not a gate. Both have a direct-download form of the same link:
//
//   Dropbox   www.dropbox.com/s/…?dl=0, /scl/fi/…?rlkey=…&dl=0 (a file) and
//             /sh/…, /scl/fo/… (a folder): the same link with dl=1 answers
//             with the file, or a zip of the folder (the downloader unpacks
//             zips). Asked for live 2026-11-05 ("we need Dropbox support").
//   Drive     drive.google.com/file/d/<id>/view: drive.usercontent.google.com/
//             download?id=<id>&export=download. A file too big to scan for
//             viruses gets a "Download anyway" page first, which is pressed.
//
// A Drive folder has no single download link; it's left for a person.

import { saveDownload, awaitDownload, jsClick, visible } from './index.mjs';
import { walkGeneric } from './generic.mjs';

/** The direct-download form of a Dropbox link, or null if it isn't one. */
export function dropboxDirectUrl(link) {
  let u;
  try { u = new URL(link); } catch { return null; }
  if (!/(^|\.)dropbox\.com$/i.test(u.hostname)) return null;
  if (!/^\/(s|sh|scl|l)\//.test(u.pathname)) return null;
  u.searchParams.set('dl', '1');
  return u.toString();
}

/** The direct-download form of a Google Drive file link, or null. */
export function driveDirectUrl(link) {
  let u;
  try { u = new URL(link); } catch { return null; }
  if (!/(^|\.)drive\.google\.com$/i.test(u.hostname)) return null;
  const id = u.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || u.searchParams.get('id');
  return id ? `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download` : null;
}

async function fetchDirect(ctx, page, direct, opts, via) {
  const { tmpDir, gateTimeoutMs = 90000 } = opts;
  const pending = awaitDownload(ctx, { timeoutMs: Math.min(gateTimeoutMs, 120000) }).catch(() => null);
  await page.goto(direct, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(err => {
    if (!/download is starting/i.test(err.message)) throw err;
  });
  // Drive's virus-scan warning for big files: press "Download anyway".
  const anyway = page.locator('#uc-download-link, form#download-form button, input[type=submit][value*="Download" i], a:has-text("Download anyway")');
  if (await visible(anyway)) await jsClick(anyway);
  const d = await pending;
  if (d) return saveDownload(d, tmpDir, via);
  return null;
}

export async function walkDropbox(ctx, page, row, opts) {
  const direct = dropboxDirectUrl(page.url()) || dropboxDirectUrl(row.free?.gate?.url || '');
  if (!direct) return walkGeneric(ctx, page, row, opts);
  opts.log?.('          Dropbox: fetching the direct download');
  const r = await fetchDirect(ctx, page, direct, opts, 'dropbox');
  return r || { status: 'stalled', reason: 'Dropbox gave no file for the direct-download link (removed, private, or over its bandwidth limit)' };
}

export async function walkDrive(ctx, page, row, opts) {
  if (/\/drive\/folders\//.test(page.url())) return { status: 'needs-you', reason: 'a Google Drive folder: download the track from it by hand' };
  const direct = driveDirectUrl(page.url()) || driveDirectUrl(row.free?.gate?.url || '');
  if (!direct) return walkGeneric(ctx, page, row, opts);
  opts.log?.('          Google Drive: fetching the direct download');
  const r = await fetchDirect(ctx, page, direct, opts, 'drive');
  return r || { status: 'stalled', reason: 'Google Drive gave no file for the direct-download link (private, or over its download quota)' };
}
