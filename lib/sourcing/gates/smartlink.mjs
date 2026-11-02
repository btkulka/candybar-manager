// Store pickers (Linkfire's lnk.to / smarturl.it, ffm.to, fanlink, artist.link)
// and dead Facebook page apps. Neither is a gate: a picker lists streaming and
// store buttons, so the walker looks for a real gate among them and hands over
// to that host's walker, and otherwise reports the stores it found as not free.
//
// Linkfire markup as observed live on 2026-11-02: a.music-service-list__link
// per service (href is the store URL), text "Play" / "Download" / "Go To".

import { walkerFor } from './index.mjs';
import { hostOf, knownGateHost } from '../soundcloud.mjs';

const PICKER_HOSTS = /(^|\.)(lnk\.to|smarturl\.it|ffm\.to|fanlink\.(to|tv)|artist\.link)$/i;

const STORE_NAMES = [
  [/spotify\.com$/, 'Spotify'], [/apple\.com$/, 'Apple'], [/beatport\.com$/, 'Beatport'],
  [/amazon\.com$|amzn\./, 'Amazon'], [/tidal\.com$/, 'Tidal'], [/deezer\.com$/, 'Deezer'],
  [/youtube\.com$/, 'YouTube'], [/soundcloud\.com$/, 'SoundCloud'], [/traxsource\.com$/, 'Traxsource'],
  [/pandora\./, 'Pandora'], [/junodownload\.com$/, 'Juno'],
];

export async function walkSmartlink(ctx, page, row, opts) {
  await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500).catch(() => {});
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href^="http"]')]
    .map(a => ({ href: a.href, text: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40) }))).catch(() => []);

  // A real gate (or a picker entry that says free) wins: follow it.
  const gate = links.find(l => {
    const h = hostOf(l.href) || '';
    return !PICKER_HOSTS.test(h) && (knownGateHost(l.href) || /free\s*(download|dl)/i.test(l.text));
  });
  if (gate) {
    opts.log?.(`          store picker links a gate: ${hostOf(gate.href)} — following it`);
    await page.goto(gate.href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(err => {
      if (!/download is starting/i.test(err.message)) throw err;
    });
    const walker = walkerFor(page.url());
    if (walker === walkSmartlink) return { status: 'needs-you', reason: `store picker leads to another picker: ${page.url()}` };
    return walker(ctx, page, row, opts);
  }

  const stores = [...new Set(links.map(l => {
    const h = hostOf(l.href) || '';
    return STORE_NAMES.find(([re]) => re.test(h))?.[1];
  }).filter(Boolean))];
  if (!stores.length) return { status: 'needs-you', reason: `store picker with no recognisable links at ${page.url()}` };
  return { status: 'not-free', reason: `store links only (${stores.join(', ')}) — nothing free behind it` };
}

/** Facebook page apps ("…/app_<id>") were download gates once; Facebook
 *  retired page apps, so the link answers 404 and there is nothing to walk. */
export async function walkFacebook(ctx, page, row, opts) {
  if (/\/app_\d+/.test(page.url())) {
    return { status: 'not-free', reason: 'Facebook page-app gate — Facebook no longer runs page apps, the link is dead' };
  }
  return { status: 'needs-you', reason: `Facebook link, not a gate: ${page.url()}` };
}
