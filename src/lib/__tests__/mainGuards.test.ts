import { describe, it, expect } from 'vitest';
import {
  isStorePartition, isAllowedWebviewSrc, isAllowedGuestNavigation, isAllowedExternalUrl,
  isStoreCheckoutUrl, PLACE_ORDER_RE, ADVANCE_RE, scrapeItemCount, resyncRefusal,
} from '../mainGuards';

describe('resyncRefusal', () => {
  const root = '/Volumes/Candy Bar/Music';
  it('refuses an XML whose paths are all on another drive', () => {
    // e.g. paths still under /Volumes/Time Machin while the library is on Candy Bar
    expect(resyncRefusal(0, 9000, 9000, root)).toMatch(/would empty the library index/);
  });
  it('refuses an empty XML', () => {
    expect(resyncRefusal(0, 0, 0, root)).toMatch(/zero tracks/);
  });
  it('refuses an XML far smaller than the current index', () => {
    expect(resyncRefusal(1200, 9000, 1500, root)).toMatch(/refusing to wipe/);
  });
  it('allows a normal resync, and any size on a tiny index', () => {
    expect(resyncRefusal(8800, 9000, 9100, root)).toBeNull();
    expect(resyncRefusal(10, 60, 10, root)).toBeNull();
  });
});

describe('store <webview> guards', () => {
  it('accepts only store session partitions', () => {
    expect(isStorePartition('persist:qobuz')).toBe(true);
    expect(isStorePartition('persist:beatport-acct_2')).toBe(true);
    expect(isStorePartition('persist:splice')).toBe(false);
    expect(isStorePartition('')).toBe(false);
    expect(isStorePartition(undefined)).toBe(false);
    // An in-memory (non-persist) partition would lose the login.
    expect(isStorePartition('qobuz')).toBe(false);
  });

  it('lets the guest start only on a store origin', () => {
    expect(isAllowedWebviewSrc('https://www.qobuz.com/shopping-cart')).toBe(true);
    expect(isAllowedWebviewSrc('https://beatport.com/cart')).toBe(true);
    expect(isAllowedWebviewSrc('about:blank')).toBe(true);
    expect(isAllowedWebviewSrc('https://evil.example/qobuz.com/')).toBe(false);
    expect(isAllowedWebviewSrc('http://www.qobuz.com/')).toBe(false);
  });

  it('keeps guest navigation on https (3DS pages may be any host)', () => {
    expect(isAllowedGuestNavigation('https://acs.somebank.example/3ds')).toBe(true);
    expect(isAllowedGuestNavigation('http://www.qobuz.com/')).toBe(false);
    expect(isAllowedGuestNavigation('file:///etc/passwd')).toBe(false);
    expect(isAllowedGuestNavigation('x-apple.systempreferences:')).toBe(false);
  });
});

describe('external URLs', () => {
  it('opens only http(s) and mailto by default', () => {
    expect(isAllowedExternalUrl('https://splice.com/sounds/x')).toBe(true);
    expect(isAllowedExternalUrl('mailto:ben@example.com')).toBe(true);
    expect(isAllowedExternalUrl('file:///Applications/Calculator.app')).toBe(false);
    expect(isAllowedExternalUrl('smb://share')).toBe(false);
    expect(isAllowedExternalUrl('not a url')).toBe(false);
  });

  it('can be narrowed to https only', () => {
    expect(isAllowedExternalUrl('http://example.com', ['https:'])).toBe(false);
    expect(isAllowedExternalUrl('https://example.com', ['https:'])).toBe(true);
  });
});

describe('scripted checkout', () => {
  it('only acts on the store\'s own cart/checkout pages', () => {
    expect(isStoreCheckoutUrl('qobuz', 'https://www.qobuz.com/shopping-cart')).toBe(true);
    expect(isStoreCheckoutUrl('qobuz', 'https://www.qobuz.com/us-en/checkout/payment')).toBe(true);
    expect(isStoreCheckoutUrl('beatport', 'https://www.beatport.com/cart')).toBe(true);
    expect(isStoreCheckoutUrl('beatport', 'https://www.beatport.com/checkout?step=2')).toBe(true);
    // A product page has "Buy" buttons but is not a checkout step.
    expect(isStoreCheckoutUrl('beatport', 'https://www.beatport.com/track/some-track/123')).toBe(false);
    expect(isStoreCheckoutUrl('qobuz', 'https://www.qobuz.com/us-en/album/x/abc')).toBe(false);
    // Wrong store, look-alike host, plain http.
    expect(isStoreCheckoutUrl('qobuz', 'https://www.beatport.com/cart')).toBe(false);
    expect(isStoreCheckoutUrl('qobuz', 'https://qobuz.com.evil.example/cart')).toBe(false);
    expect(isStoreCheckoutUrl('qobuz', 'http://www.qobuz.com/shopping-cart')).toBe(false);
  });

  it('never treats a commit button as an advance step', () => {
    for (const label of ['Complete order', 'Payer', 'Valider et payer', 'PayPal Checkout', 'Checkout with PayPal', 'Buy now', 'Place order']) {
      expect(ADVANCE_RE.test(label), label).toBe(false);
    }
    for (const label of ['Proceed to checkout', 'Go to checkout', 'Continue to payment', 'Continue to review →', 'Next step']) {
      expect(ADVANCE_RE.test(label), label).toBe(true);
    }
  });

  it('recognises the final commit button exactly, and not "Buy now"', () => {
    expect(PLACE_ORDER_RE.test('Place order')).toBe(true);
    expect(PLACE_ORDER_RE.test('Valider la commande')).toBe(true);
    expect(PLACE_ORDER_RE.test('Buy now')).toBe(false);
    expect(PLACE_ORDER_RE.test('Place order and subscribe')).toBe(false);
  });

  it('scrapes an item count when the page states one', () => {
    expect(scrapeItemCount('Your cart\n3 items\nTotal $5.97')).toBe(3);
    expect(scrapeItemCount('Panier (2)')).toBe(2);
    expect(scrapeItemCount('1 track · $1.49')).toBe(1);
    expect(scrapeItemCount('Order total $4.00')).toBeNull();
  });

  it('survives serialization into the injected script', () => {
    // eslint-disable-next-line no-new-func
    const revived = new Function(`return (${scrapeItemCount.toString()})`)() as typeof scrapeItemCount;
    expect(revived('4 items')).toBe(4);
  });
});
