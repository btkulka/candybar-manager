// ============================================================
// Pure policy checks the main process applies at its trust
// boundaries: which <webview> guests may attach, where they may
// navigate, which URLs leave the app for the system browser, and
// what the scripted checkout may click.
//
// Electron-free so every rule here is unit tested.
// ============================================================

/** Session partitions the store-cart <webview> may bind to: the legacy
 *  `persist:qobuz` / `persist:beatport` jars and the per-account ones. */
const STORE_PARTITION_RE = /^persist:(?:qobuz|beatport)(?:-[\w.@-]+)?$/;

export function isStorePartition(partition: string | undefined | null): boolean {
  return typeof partition === 'string' && STORE_PARTITION_RE.test(partition);
}

/** The parts of an Electron cookie the keep rule below reads. */
export type JarCookie = {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
};

/** The stores' own domains. Third-party cookies in the same jar (trackers,
 *  payment providers) are never kept past the launch. */
const STORE_COOKIE_DOMAIN_RE = /(?:^|\.)(?:qobuz|beatport)\.com$/;
export const KEPT_SESSION_COOKIE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The copy of a store's session cookie to write back with an expiry, or null
 * to leave the cookie alone. Chromium only writes cookies that have an expiry
 * to disk, and Qobuz's shop session (`qobuz-session`) has none, so every
 * relaunch came back signed out of the shop. A host-only cookie stays
 * host-only: naming its domain would widen it to every subdomain.
 */
export function persistentCookieCopy(cookie: JarCookie, nowSeconds: number) {
  if (!cookie.session || !cookie.domain || !STORE_COOKIE_DOMAIN_RE.test(cookie.domain)) return null;
  const host = cookie.domain.replace(/^\./, '');
  return {
    url: `https://${host}${cookie.path || '/'}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: nowSeconds + KEPT_SESSION_COOKIE_SECONDS,
  };
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The renderer only ever points the guest at a store cart (or blank while it mounts). */
export function isAllowedWebviewSrc(src: string | undefined | null): boolean {
  if (!src || src === 'about:blank') return true;
  return /^https:\/\/(www\.)?(qobuz|beatport)\.com\//.test(src);
}

/** Top-level navigation inside the guest. Checkout can hop to a bank's 3DS page
 *  or a payment provider, so the host isn't pinned — but it must stay https. */
export function isAllowedGuestNavigation(url: string): boolean {
  if (url === 'about:blank') return true;
  return parseUrl(url)?.protocol === 'https:';
}

/** URLs the app hands to the OS (`open-external`). */
export function isAllowedExternalUrl(url: string, protocols: readonly string[] = ['https:', 'http:', 'mailto:']): boolean {
  const parsed = parseUrl(url);
  return !!parsed && protocols.includes(parsed.protocol);
}

const STORE_HOST_RE: Record<'qobuz' | 'beatport', RegExp> = {
  qobuz: /(^|\.)qobuz\.com$/i,
  beatport: /(^|\.)beatport\.com$/i,
};

/** Path segments that mark a cart or checkout step on either store. */
const CHECKOUT_SEGMENT_RE = /^(?:shopping-cart|cart|checkout|payment|paiement|order|basket|panier|commande)$/i;

/** True when the guest is on the store's own cart or checkout pages — the only
 *  place the scripted checkout may click anything. */
export function isStoreCheckoutUrl(store: 'qobuz' | 'beatport', url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== 'https:') return false;
  if (!STORE_HOST_RE[store].test(parsed.hostname)) return false;
  return parsed.pathname.split('/').some(seg => CHECKOUT_SEGMENT_RE.test(seg));
}

/** Checkout proper, past the cart: the step every real order goes through
 *  before its confirmation page. */
const CHECKOUT_STEP_SEGMENT_RE = /^(?:checkout|payment|paiement|commande)$/i;

export function isStoreCheckoutStep(store: 'qobuz' | 'beatport', url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== 'https:') return false;
  if (!STORE_HOST_RE[store].test(parsed.hostname)) return false;
  return parsed.pathname.split('/').some(seg => CHECKOUT_STEP_SEGMENT_RE.test(seg));
}

/** A store's sign-in page: Qobuz's /signin, Beatport's account.beatport.com
 *  or a /login path. A signed-out cart redirects here. */
export function isStoreSignInUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  if (!/(^|\.)(qobuz|beatport)\.com$/i.test(parsed.hostname)) return false;
  if (/^account\.beatport\.com$/i.test(parsed.hostname)) return true;
  return /\/(?:signin|sign-in|login|log-in)(?:\/|$)/i.test(parsed.pathname);
}

/** Electron's user agent without the tokens that name the app and Electron
 *  ("candybar-manager/0.1.0", "Electron/39.8.8"): what Chrome itself sends.
 *  Stores behind Cloudflare challenge a browser that announces itself as an
 *  embedded shell far more often. */
export function plainChromeUserAgent(ua: string, appName: string): string {
  const name = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return ua.replace(new RegExp(`\\s(?:${name}|Electron)/\\S+`, 'g'), '');
}

/** The final commit button. Seeing one means "stop and ask the user"; only the
 *  separate place-order IPC (after an in-app confirm) clicks it. */
export const PLACE_ORDER_RE = /^(?:place order|place your order|confirm (?:order|purchase|and pay)|pay now|commander|valider la commande)$/i;

/** Buttons that only move to the next checkout step. Anchored, and free of any
 *  verb that could commit a purchase ("complete order", "payer", a bare
 *  "checkout" that also matches "PayPal Checkout"). A trailing arrow is allowed. */
export const ADVANCE_RE = /^(?:proceed to checkout|go to checkout|continue to (?:checkout|payment|review)|next step)\s*[›→>]*$/i;

/** Below this share of the current index, a resync is treated as a broken XML
 *  (wrong drive name, partial export) rather than a smaller library. */
export const RESYNC_MIN_FRACTION = 0.5;

/** Why a Rekordbox-XML resync must not wipe the library index, or null when it
 *  is safe. `inRoot` is the number of XML tracks under the library root (what
 *  the import would put back); `existing` is the index's current row count. */
export function resyncRefusal(inRoot: number, existing: number, xmlTotal: number, libraryRoot: string): string | null {
  if (xmlTotal === 0) return 'The Rekordbox XML parsed to zero tracks; refusing to wipe the library index.';
  if (inRoot === 0) {
    return `None of the XML's ${xmlTotal} tracks are under ${libraryRoot}, so a resync would empty the library index. ` +
      'Check that the XML’s paths use the same drive and folder as your library.';
  }
  if (existing >= 100 && inRoot < existing * RESYNC_MIN_FRACTION) {
    return `The XML has only ${inRoot} tracks under ${libraryRoot}, against ${existing} in the library index; refusing to wipe it. ` +
      'Re-export the XML from Rekordbox (or fix its paths) and try again.';
  }
  return null;
}

/** Best-effort item count from the checkout page's text ("3 items", "Panier (2)").
 *  Self-contained so it can be serialized into the injected checkout script. */
export function scrapeItemCount(text: string): number | null {
  const patterns = [
    /\b(\d{1,3})\s+(?:items?|tracks?|articles?|titres?|products?)\b/i,
    /\b(?:items?|articles?|cart|panier|basket)\s*\(\s*(\d{1,3})\s*\)/i,
  ];
  for (const re of patterns) {
    const m = (text || '').match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
