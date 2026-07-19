// Canonical store cart URLs, in one place so main + renderer can't drift.
//
// Qobuz's cart lives at the domain-root `/shopping-cart` (NO locale prefix). The
// locale-prefixed `/us-en/shopping-cart` is a hard 404 — verified live: the
// real cart link in Qobuz's own header is `<a href="/shopping-cart">`, and
// `https://www.qobuz.com/shopping-cart` returns 200 (redirecting to /signin when
// the session isn't warm), whereas `/us-en/shopping-cart` returns 404.
// Beatport's cart is `/cart` (auth-gated: redirects to home when logged out).
export const QOBUZ_CART_URL = 'https://www.qobuz.com/shopping-cart';
export const BEATPORT_CART_URL = 'https://www.beatport.com/cart';

export function cartUrl(store: 'qobuz' | 'beatport'): string {
  return store === 'qobuz' ? QOBUZ_CART_URL : BEATPORT_CART_URL;
}
