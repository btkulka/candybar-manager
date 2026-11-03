// Fill the real store carts (Qobuz and Beatport) from a sourcing session.
//
// Verified live (2026-09-07): /v4/ajax/add-cart?articleId=N answers
//   {"success":true}  when the request carries X-Requested-With: XMLHttpRequest
//   404               for a plain navigation — a link click, a new tab, curl
// Qobuz's own addtocart bundle does `$.get(cartLink + "?articleId=" + id)`, and
// jQuery adds that header. So a cart link on a web page can never work; the add
// has to be an XHR from a page on www.qobuz.com, which means the user's own
// signed-in profile. The cart is server-side on the account, so whatever this
// adds shows up in every browser signed in to it.
//
// The shop (www.qobuz.com) and the web player (play.qobuz.com) keep separate
// sessions. A profile that can read purchases may still be signed out of the
// shop; this waits for a shop sign-in when it hits one.
//
// Beatport is the other half: api.beatport.com takes cart adds over plain HTTP
// once the signed-in profile hands over its Bearer token (see beatport.mjs).
// A web page can't reach that API either, so the review page only opens track
// pages and this script does the actual add for both stores.

import fs from 'fs';
import { launchSiteBrowser } from '../launchBrowser.mjs';
import { openBeatport, getAccessToken, waitForLogin, getCartId, getCartTrackIds, addToCart } from './beatport.mjs';
import path from 'path';
import { recordEvent, eventFromCart } from './history.mjs';

const BEATPORT_FORMATS = { 4: 'FLAC', 5: 'AIFF', 14: 'WAV' };

const SHOP = 'https://www.qobuz.com';
const CART = `${SHOP}/shopping-cart`;   // locale-prefixed /us-en/shopping-cart is a 404

/** True when the shop session is live: the cart page stays on the cart. */
async function shopSignedIn(page) {
  await page.goto(CART, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return !/\/signin/.test(page.url());
}

/** Wait, without navigating, for the user to finish signing in on the visible page. */
async function waitForShopLogin(page, { timeoutMs = 300000, log = () => {} } = {}) {
  log('      cart: Qobuz shop is signed out — sign in on the Chrome window that just opened (waiting up to ' + Math.round(timeoutMs / 60000) + ' min)');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return false;
    // Where Qobuz lands after sign-in varies (cart, shop home, discover…), so
    // any page that is not the sign-in form is a candidate; the cart page then
    // confirms it — a still-signed-out session bounces straight back to /signin.
    if (!/\/signin/.test(page.url())) {
      if (await shopSignedIn(page)) return true;
    }
    try { await page.waitForTimeout(1000); } catch { return false; }
  }
  return false;
}

/** One XHR add, exactly the way the site's own button does it. */
export async function addArticle(page, articleId) {
  return page.evaluate(async (id) => {
    const r = await fetch(`/v4/ajax/add-cart?articleId=${encodeURIComponent(id)}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' },
      credentials: 'include',
    });
    const text = await r.text();
    try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, body: text.slice(0, 200) }; }
  }, String(articleId));
}

/** The article id behind a row's chosen cart tier (the review page's link). */
function articleIdOf(row) {
  const u = row.match?.cartUrl || '';
  return (u.match(/articleId=(\d+)/) || [])[1] || null;
}

/** Rewrite the session atomically: a crash mid-write must not leave half a file. */
function writeSession(sessionPath, session) {
  const tmp = `${sessionPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 1));
  fs.renameSync(tmp, sessionPath);
}

/**
 * Take the rows removed on the review page out of the buy list. The page can
 * only remember a removal in its own browser, so it hands over the keys as
 * `--skip`; they move to `session.removed`, and stay out of every later run.
 * Returns true when the session changed.
 */
export function applyRemovals(session, skip, log = () => {}) {
  if (!skip || skip.size === 0) return false;
  const keep = [], gone = [];
  for (const r of session.buy || []) (skip.has(r.key) ? gone : keep).push(r);
  if (gone.length === 0) return false;
  const at = new Date().toISOString();
  session.buy = keep;
  (session.removed ||= []).push(...gone.map(r => ({ ...r, removedAt: at })));
  if (session.stats) session.stats.buy = keep.length;
  log(`      cart: left out ${gone.length} row(s) removed on the review page`);
  return true;
}

/**
 * Add every Qobuz buy row that has not been added yet. Records `cartAdded`
 * on each row and rewrites the session, so a re-run only adds what is missing.
 * Returns { added, failed, skipped, signedIn }.
 */
export async function fillQobuzCart(sessionPath, { log = () => {}, only = null, skip = null, force = false, loginTimeoutMs = 300000 } = {}) {
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  if (applyRemovals(session, skip, log)) writeSession(sessionPath, session);
  // Lossless only: articleIdOf() is set only from a lossless tier, and a row
  // whose match says otherwise never goes in, whatever else it carries.
  const rows = (session.buy || []).filter(r => r.store === 'qobuz' && articleIdOf(r)
    && r.match?.lossless !== false
    && (force || !r.cartAdded) && (!only || only.has(r.key)));
  if (!rows.length) { log('      cart: no Qobuz rows to add'); return { added: [], failed: [], skipped: [], signedIn: null }; }

  const ctx = await launchSiteBrowser({ profile: 'qobuz', headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const added = [], failed = [];
  let signedIn = false;
  try {
    signedIn = await shopSignedIn(page);
    if (!signedIn) signedIn = await waitForShopLogin(page, { timeoutMs: loginTimeoutMs, log });
    if (!signedIn) {
      log('      cart: not signed in to the Qobuz shop — nothing added');
      return { added, failed, skipped: rows.map(r => r.key), signedIn: false };
    }
    // Every XHR must originate from a www.qobuz.com page; the cart page is one.
    if (!/shopping-cart/.test(page.url())) await page.goto(CART, { waitUntil: 'domcontentloaded', timeout: 60000 });

    for (const r of rows) {
      const id = articleIdOf(r);
      const label = `${r.artist} - ${r.title}`;
      try {
        const res = await addArticle(page, id);
        if (res.success) {
          r.cartAdded = new Date().toISOString();
          added.push(r.key);
          recordEvent(eventFromCart(r, 'qobuz', { origin: session.playlist?.name, session: path.basename(sessionPath) }));
          log(`      cart: added ${label} (${r.match.cartLabel || 'lossless'}, ${r.match.price || ''})`);
        } else {
          failed.push({ key: r.key, reason: res.message || `HTTP ${res.status}` });
          log(`      cart: FAILED ${label}: ${res.message || res.body || res.status}`);
        }
      } catch (err) {
        failed.push({ key: r.key, reason: err.message });
        log(`      cart: FAILED ${label}: ${err.message}`);
      }
      writeSession(sessionPath, session);
    }
    // Leave the cart on screen for a moment so the count is visible in the window.
    await page.goto(CART, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const summary = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200)).catch(() => '');
    log(`      cart: ${added.length} added, ${failed.length} failed · ${CART} · "${summary.slice(0, 120)}"`);
  } finally {
    try { await ctx.close(); } catch { /* already gone */ }
  }
  return { added, failed, skipped: [], signedIn };
}

/**
 * Add every Beatport buy row that has not been added yet, the same contract as
 * fillQobuzCart: `cartAdded` on each row, session rewritten after every add.
 * A track the account already owns moves from `buy` to `flagged` — it needs a
 * download and a Rekordbox import, not a second purchase.
 * Returns { added, failed, purchased, signedIn }.
 */
export async function fillBeatportCart(sessionPath, { log = () => {}, only = null, skip = null, force = false, loginTimeoutMs = 300000 } = {}) {
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  if (applyRemovals(session, skip, log)) writeSession(sessionPath, session);
  const rows = (session.buy || []).filter(r => r.store === 'beatport' && r.match?.id
    && r.match?.lossless !== false
    && (force || !r.cartAdded) && (!only || only.has(r.key)));
  if (!rows.length) { log('      cart: no Beatport rows to add'); return { added: [], failed: [], purchased: [], signedIn: null }; }

  const bp = await openBeatport();
  const added = [], failed = [], purchased = [];
  let token = null;
  try {
    token = await getAccessToken(bp.page);
    if (!token) {
      log('      cart: Beatport is signed out — sign in on the Chrome window that just opened (waiting up to ' + Math.round(loginTimeoutMs / 60000) + ' min)');
      token = await waitForLogin(bp.page, { timeoutMs: loginTimeoutMs });
    }
    if (!token) {
      log('      cart: not signed in to Beatport — nothing added');
      return { added, failed, purchased, signedIn: false };
    }
    const cartId = await getCartId(token);
    const inCart = await getCartTrackIds(token, cartId);

    let authExpired = false;
    for (const r of rows) {
      const id = String(r.match.id);
      const label = `${r.artist} - ${r.title}`;
      if (authExpired) {
        failed.push({ key: r.key, reason: 'Beatport sign-in expired' });
        continue;
      }
      if (inCart.has(id)) {
        r.cartAdded = r.cartAdded || new Date().toISOString();
        added.push(r.key);
        recordEvent(eventFromCart(r, 'beatport', { origin: session.playlist?.name, session: path.basename(sessionPath) }));
        log(`      cart: already in cart ${label}`);
        continue;
      }
      try {
        const res = await addToCart(token, cartId, id);
        if (res.ok) {
          r.cartAdded = new Date().toISOString();
          inCart.add(id);
          added.push(r.key);
          recordEvent(eventFromCart(r, 'beatport', { origin: session.playlist?.name, session: path.basename(sessionPath) }));
          log(`      cart: ${res.alreadyInCart ? 'already in cart' : 'added'} ${label} (${BEATPORT_FORMATS[res.format] || res.format}, ${r.match.price || ''})`);
        } else if (res.authExpired) {
          authExpired = true;
          failed.push({ key: r.key, reason: res.error });
          log('      cart: Beatport sign-in expired — sign in on the Chrome window and re-run; nothing more added');
        } else if (res.alreadyPurchased) {
          session.buy = session.buy.filter(x => x !== r);
          (session.flagged ||= []).push({ ...r, flag: 'already purchased on Beatport — download it from your Beatport library and import it; it isn\'t in Rekordbox' });
          purchased.push(r.key);
          log(`      cart: ALREADY PURCHASED ${label} — moved to flagged`);
        } else {
          failed.push({ key: r.key, reason: res.error });
          log(`      cart: FAILED ${label}: ${res.error}`);
        }
      } catch (err) {
        failed.push({ key: r.key, reason: err.message });
        log(`      cart: FAILED ${label}: ${err.message}`);
      }
      if (session.stats) {
        session.stats.buy = session.buy.length;
        session.stats.flagged = (session.flagged || []).length;
      }
      writeSession(sessionPath, session);
    }
    log(`      cart: Beatport ${added.length} in cart, ${purchased.length} already owned, ${failed.length} failed · https://www.beatport.com/cart`);
  } finally {
    await bp.close();
  }
  return { added, failed, purchased, signedIn: true };
}

// CLI: node lib/sourcing/cart.mjs <session.json> [--store beatport|qobuz] [--force]
//                                   [--skip key,key…] [--only key,key…]
// --skip is what the review page's "Removed from the buy list" box hands over.
if (process.argv[1] && process.argv[1].endsWith('cart.mjs')) {
  const [, , sessionPath, ...flags] = process.argv;
  if (!sessionPath) {
    console.error('usage: node lib/sourcing/cart.mjs <session.json> [--store beatport|qobuz] [--force] [--skip key,key…] [--only key,key…]');
    process.exit(1);
  }
  const flag = name => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : null);
  const keys = v => (v ? new Set(v.split(',').map(k => k.trim()).filter(Boolean)) : null);
  const store = flag('--store');
  const opts = { log: m => console.error(m), force: flags.includes('--force'), skip: keys(flag('--skip')), only: keys(flag('--only')) };
  const out = {};
  if (!store || store === 'beatport') out.beatport = await fillBeatportCart(sessionPath, opts);
  if (!store || store === 'qobuz') out.qobuz = await fillQobuzCart(sessionPath, opts);
  console.log(JSON.stringify(out));
}
