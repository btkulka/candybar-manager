// Store sessions via plain browser navigation.
//
// Everything that needs the user's account — purchase history, downloads —
// happens by driving their real logged-in Chrome, not by storing credentials or
// rebuilding a private API. The credential paths kept dying silently (the MCP
// server's `legacyCreds` returns "use the desktop app"; Beatport 403s every
// non-browser client), and a real session is the only thing that stays valid.
//
// Rather than scrape SPA markup — which changes without warning — we navigate
// to the page and read the JSON responses the page fetches for itself. The
// endpoint names are the site's own contract with its front-end, so they're far
// more stable than DOM selectors, and the browser does all the authenticating.

import { launchSiteBrowser } from '../launchBrowser.mjs';

const SETTLE_MS = 3000;

export async function openStore({ profile, homeUrl, headless = false }) {
  const ctx = await launchSiteBrowser({ profile, headless });
  const page = ctx.pages()[0] || (await ctx.newPage());
  if (homeUrl) {
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  return { ctx, page, close: async () => { try { await ctx.close(); } catch { /* already gone */ } } };
}

/**
 * Navigate to `url` and collect JSON bodies from responses whose URL matches
 * `match`. Resolves once the page has been quiet for `settleMs`.
 *
 * `onPayload` may return true to signal "keep waiting" for more pages.
 */
export async function collectJson(page, { url, match, settleMs = SETTLE_MS, timeoutMs = 60000, scroll = 0 }) {
  const payloads = [];
  const seen = new Set();

  const onResponse = async (res) => {
    const u = res.url();
    if (!match.test(u) || seen.has(u)) return;
    seen.add(u);
    try {
      const body = await res.json();
      payloads.push({ url: u, status: res.status(), body });
    } catch {
      // Not JSON (redirect, HTML error page) — nothing to collect.
    }
  };

  page.on('response', onResponse);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(settleMs);

    // Some libraries lazy-load further pages as you scroll.
    for (let i = 0; i < scroll; i++) {
      const before = payloads.length;
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      if (payloads.length === before) break;
    }
  } finally {
    page.off('response', onResponse);
  }

  return { payloads, finalUrl: page.url() };
}

// ---------- Qobuz ----------

const QOBUZ_PLAYER = 'https://play.qobuz.com';

export async function openQobuz(opts = {}) {
  return openStore({ profile: 'qobuz', homeUrl: QOBUZ_PLAYER, ...opts });
}

/** True when the web player has a live session. */
export async function isQobuzSignedIn(page) {
  const { payloads } = await collectJson(page, {
    url: `${QOBUZ_PLAYER}/`,
    match: /\/api\.json\/0\.2\/(user\/me|purchase)/,
    settleMs: 2500,
  });
  return payloads.some(p => p.status === 200);
}

/** Wait for an interactive sign-in in the visible window.
 *
 *  This must never navigate while it waits. isQobuzSignedIn() drives a fresh
 *  navigation to the player, so polling it in a loop reloaded the page out from
 *  under whoever was typing their password every few seconds — the login could
 *  not be completed at all. Instead, listen for the auth calls the app makes
 *  for itself and leave the window alone.
 *
 *  Returns false rather than throwing when the window is closed: someone
 *  shutting the browser is an answer ("not signed in"), not a crash. */
export async function waitForQobuzLogin(page, { timeoutMs = 300000 } = {}) {
  let signedIn = false;
  const onResponse = res => {
    if (signedIn) return;
    if (/api\.json\/0\.2\/user\/(login|me)/.test(res.url()) && res.status() === 200) signedIn = true;
  };
  page.on('response', onResponse);
  try {
    // Attach first, then navigate: an already-live session fires user/me on load.
    await page.goto(`${QOBUZ_PLAYER}/login`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signedIn) return true;
      if (page.isClosed()) return false;
      try { await page.waitForTimeout(1000); } catch { return false; }
    }
    return false;
  } finally {
    try { page.off('response', onResponse); } catch { /* page already gone */ }
  }
}

/**
 * Purchased tracks, read from the responses the purchases page fetches.
 * Returns { tracks, signedIn, diagnostic }.
 */
export async function qobuzPurchases(page) {
  const { payloads } = await collectJson(page, {
    url: `${QOBUZ_PLAYER}/purchases`,
    match: /purchase\/getUserPurchases|\/purchases\?/,
    scroll: 6,
  });

  if (payloads.length === 0) {
    return {
      tracks: [],
      signedIn: false,
      diagnostic: 'The purchases page made no purchase request — the Qobuz profile is probably signed out.',
    };
  }

  const tracks = [];
  const seen = new Set();
  for (const { body } of payloads) {
    for (const t of body?.tracks?.items || []) {
      const id = String(t.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      tracks.push({
        source: 'qobuz',
        trackId: id,
        title: t.title || '',
        artist: t.performer?.name || t.album?.artist?.name || '',
        album: t.album?.title || '',
        purchasedAt: t.purchased_at ? new Date(t.purchased_at * 1000).toISOString() : undefined,
      });
    }
    for (const a of body?.albums?.items || []) {
      for (const t of a.tracks?.items || []) {
        const id = String(t.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        tracks.push({
          source: 'qobuz',
          trackId: id,
          title: t.title || '',
          artist: t.performer?.name || a.artist?.name || '',
          album: a.title || '',
        });
      }
    }
  }

  return { tracks, signedIn: true, diagnostic: `${payloads.length} purchase response(s) read` };
}

// ---------- Beatport ----------

const BEATPORT = 'https://www.beatport.com';

export async function openBeatportSession(opts = {}) {
  return openStore({ profile: 'beatport', homeUrl: BEATPORT, ...opts });
}

/** Purchased/downloadable tracks, read from the library page's own requests. */
export async function beatportPurchases(page) {
  const { payloads, finalUrl } = await collectJson(page, {
    url: `${BEATPORT}/library`,
    match: /\/v4\/my\/(downloads|purchases)|\/api\/my\//,
    scroll: 6,
  });

  if (payloads.length === 0) {
    // Beatport bounces a signed-out visitor to `/?next=/library`.
    const signedOut = /login|account|[?&]next=/i.test(finalUrl);
    return {
      tracks: [],
      signedIn: false,
      diagnostic: signedOut
        ? 'Beatport redirected to sign-in — the profile is signed out.'
        : 'The library page made no downloads request — the Beatport profile is probably signed out.',
    };
  }

  const tracks = [];
  const seen = new Set();
  for (const { body } of payloads) {
    for (const row of body?.results || body?.data || []) {
      const t = row.track || row;
      const id = String(t.id ?? t.track_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const mix = t.mix_name && t.mix_name !== 'Original Mix' ? ` (${t.mix_name})` : '';
      tracks.push({
        source: 'beatport',
        trackId: id,
        title: `${t.name || t.track_name || ''}${mix}`,
        artist: (t.artists || []).map(a => a.name || a.artist_name).filter(Boolean).join(', '),
        album: t.release?.name || '',
        purchasedAt: row.date_purchased || row.created_at || undefined,
        downloadId: row.id ? String(row.id) : undefined,
      });
    }
  }

  return { tracks, signedIn: true, diagnostic: `${payloads.length} library response(s) read` };
}

/**
 * Download a purchased track through the browser session: click/navigate the
 * store's own download URL and capture the file Chrome receives.
 * Returns the saved path.
 */
export async function downloadViaBrowser(page, downloadUrl, destPath) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.evaluate(u => { window.location.href = u; }, downloadUrl),
  ]);
  await download.saveAs(destPath);
  return destPath;
}
