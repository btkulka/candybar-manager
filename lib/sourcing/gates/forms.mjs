// Form boxes several gates share: the name and address beside an email.

/**
 * Name boxes beside a gate's email, each given what its own name, placeholder,
 * autocomplete or label asks for: a first name ("First name" over Hypeddit's
 * #email_name), a last name, or the whole name where the form has one box.
 * Boxes already filled are left alone. With no name saved, the email's local
 * part stands in for the first name. Used by the Hypeddit and generic walkers.
 */
export async function fillName(page, name, email) {
  const first = (name?.first || '').trim() || (email || '').split('@')[0];
  const last = (name?.last || '').trim();
  const full = [first, last].filter(Boolean).join(' ');
  const boxes = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const labelOf = el => el.labels?.[0]?.innerText
      || el.closest('.hype-form-group, .form-group, .ds-field, .field')?.querySelector('label')?.innerText || '';
    return [...document.querySelectorAll('input[type=text], input:not([type])')].filter(vis).map((el, i) => {
      el.setAttribute('data-tl-name-box', String(i));
      const hint = `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('autocomplete') || ''} ${labelOf(el)}`.toLowerCase();
      const kind = /first|given/.test(hint) ? 'first'
        : /last|family|surname/.test(hint) ? 'last'
        : /(^|[\s_-])(full\s*)?name\b/.test(hint) && !/user|comment|artist|track/.test(hint) ? 'full'
        : null;
      return { i, kind, empty: !el.value };
    }).filter(b => b.kind && b.empty);
  }).catch(() => []);
  const split = boxes.some(b => b.kind === 'first');
  for (const b of boxes) {
    const value = b.kind === 'first' ? first : b.kind === 'last' ? last : split ? '' : full;
    if (value) await page.locator(`[data-tl-name-box="${b.i}"]`).fill(value).catch(() => {});
  }
}

/**
 * Address boxes beside a gate's email: street, city, state/region, ZIP and
 * country, each by what its name, placeholder, autocomplete or label asks for.
 * A country <select> is matched by option text or value. Boxes already
 * filled, and parts with nothing saved, are left alone.
 */
export async function fillAddress(page, address) {
  const a = address || {};
  if (!Object.values(a).some(v => (v || '').trim())) return;
  const boxes = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const labelOf = el => el.labels?.[0]?.innerText
      || el.closest('.hype-form-group, .form-group, .ds-field, .field')?.querySelector('label')?.innerText || '';
    return [...document.querySelectorAll('input[type=text], input:not([type]), input[type=tel], select')].filter(vis).map((el, i) => {
      el.setAttribute('data-tl-addr-box', String(i));
      const hint = `${el.name} ${el.id} ${el.placeholder || ''} ${el.getAttribute('autocomplete') || ''} ${labelOf(el)}`.toLowerCase();
      const kind = /postal|post\s*code|postcode|\bzip/.test(hint) ? 'postcode'
        : /country/.test(hint) ? 'country'
        : /address-level1|\bstate\b|province|region|county/.test(hint) ? 'region'
        : /address-level2|\bcity\b|\btown\b|locality/.test(hint) ? 'city'
        : /address-line1|street|address(?!.*e-?mail)|addr\b/.test(hint) && !/e-?mail/.test(hint) ? 'line1'
        : null;
      return { i, kind, empty: el.tagName === 'SELECT' ? !el.value || el.selectedIndex <= 0 : !el.value, select: el.tagName === 'SELECT' };
    }).filter(b => b.kind && b.empty);
  }).catch(() => []);
  for (const b of boxes) {
    const value = (a[b.kind] || '').trim();
    if (!value) continue;
    const loc = page.locator(`[data-tl-addr-box="${b.i}"]`);
    if (b.select) {
      await loc.evaluate((el, v) => {
        const want = v.toLowerCase();
        const opt = [...el.options].find(o => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
          || [...el.options].find(o => o.text.toLowerCase().includes(want));
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
      }, value).catch(() => {});
    } else {
      await loc.fill(value).catch(() => {});
    }
  }
}
