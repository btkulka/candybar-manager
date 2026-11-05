// The name boxes beside a gate's email, filled in a real (headless) Chrome.
// Hypeddit's markup is as its gate pages served it on 2026-11-04.
//
// Needs Google Chrome: CANDYBAR_BROWSER_TESTS=1 npx vitest run forms

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fillName } from '../gates/forms.mjs';

const RUN = !!process.env.CANDYBAR_BROWSER_TESTS;

describe.skipIf(!RUN)('fillName, in Chrome', () => {
  let browser, page;
  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage();
  }, 30000);
  afterAll(async () => { await browser?.close(); }, 30000);

  const values = () => page.$$eval('input', els => Object.fromEntries(els.map(e => [e.id || e.name || e.placeholder, e.value])));

  it("gives Hypeddit's first-name box the first name, not the email or the whole name", async () => {
    await page.setContent(`
      <div class="hype-form-group"><label class="hype-form-label">First name</label>
        <div class="hype-form-select"><input type="text" class="hype-form-control" name="email_name" id="email_name" autocomplete="off"></div></div>
      <div class="hype-form-group"><label class="hype-form-label">Email address</label>
        <div class="hype-form-select"><input type="text" class="hype-form-control" name="email_address" id="email_address" autocomplete="off"></div></div>`);
    await fillName(page, { first: 'Sam', last: 'Rivera' }, 'sam@example.com');
    expect(await values()).toEqual({ email_name: 'Sam', email_address: '' });
  });

  it('splits a first/last form, and gives a single name box the whole name', async () => {
    await page.setContent('<input name="fname" placeholder="First name"><input name="lname" placeholder="Last name"><input type="text" placeholder="Comment">');
    await fillName(page, { first: 'Sam', last: 'Rivera' }, 'sam@example.com');
    expect(await values()).toEqual({ fname: 'Sam', lname: 'Rivera', Comment: '' });
    await page.setContent('<label for="n">Your name</label><input id="n" type="text"><input id="u" name="username" type="text">');
    await fillName(page, { first: 'Sam', last: 'Rivera' }, 'sam@example.com');
    expect(await values()).toEqual({ n: 'Sam Rivera', u: '' });
  });

  it('falls back to the email for a first name when none is saved, and leaves filled boxes alone', async () => {
    await page.setContent('<input id="first" autocomplete="given-name"><input id="last" autocomplete="family-name" value="Kept">');
    await fillName(page, { first: '', last: '' }, 'sam.gates@example.com');
    expect(await values()).toEqual({ first: 'sam.gates', last: 'Kept' });
  });
});
