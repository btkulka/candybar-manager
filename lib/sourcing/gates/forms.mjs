// Form boxes several gates share: the name beside an email.

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
