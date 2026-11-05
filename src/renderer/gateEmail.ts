// "Email for download pages", asked where the free downloads start (Upgrade
// quality and Find & buy) instead of only in Settings. Some gates (Hypeddit,
// Droploud, Influence Planner) won't hand over the file without an address,
// and a run with none saved just reports "needs an email" for each of them.
// The box is filled from Settings (gateEmail) and saves back to it when a run
// starts, so every run after — the app's, Claude's, the CLI's — has it too.

import { escapeHtml, showToast } from './shared';

let saved: string | null = null;
let loading: Promise<string> | null = null;
/** What's been typed in each box and not saved yet, so a re-render keeps it. */
const drafts = new Map<string, string>();

/** The email saved in Settings ("" when none), read once and kept. */
export function savedGateEmail(): Promise<string> {
  if (saved !== null) return Promise.resolve(saved);
  loading ??= window.candybar.getConfig()
    .then(c => (saved = (c.gateEmail || '').trim()))
    .catch(() => (saved = ''))
    .finally(() => { loading = null; });
  return loading;
}

/** The saved email if it's been read already, else null (for synchronous renders). */
export function knownGateEmail(): string | null {
  return saved;
}

// Settings saves fire this; read the address again next time.
window.addEventListener('store-account-changed', () => { saved = null; void savedGateEmail(); });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The box's markup. `needing` is how many of the ticked downloads are known
 *  to ask for an email (from their gate's own step list). */
export function gateEmailFieldHtml(id: string, needing: number): string {
  const value = drafts.get(id) ?? saved ?? '';
  const warn = needing > 0 && !value;
  return `
    <label class="free-email${warn ? ' free-email--warn' : ''}" for="${id}">
      <span>
        <strong>Email for download pages</strong>
        <span>${warn
          ? `${needing === 1 ? 'One of these asks' : `${needing} of these ask`} for an email before ${needing === 1 ? 'it gives' : 'they give'} the file. Without one, ${needing === 1 ? "it's" : "they're"} skipped.`
          : "Some download pages won't give the file without one. It's only typed into those pages, and saved in Settings → SoundCloud."}</span>
      </span>
      <input type="email" id="${id}" value="${escapeHtml(value)}" placeholder="you@example.com" autocomplete="email" spellcheck="false" />
    </label>`;
}

/** Fill the box once the saved email has been read (the first render may come first). */
export function fillGateEmailField(root: HTMLElement, id: string): void {
  const input = root.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) return;
  input.addEventListener('input', () => drafts.set(id, input.value));
  if (saved !== null) return;
  void savedGateEmail().then(v => { if (!input.value && !drafts.has(id)) input.value = v; });
}

/**
 * Before a run: save what's in the box to Settings if it changed. Returns the
 * address ("" when left empty), or null when it isn't a valid address — the
 * run shouldn't start then.
 */
export async function commitGateEmail(root: ParentNode, id: string): Promise<string | null> {
  const input = root.querySelector<HTMLInputElement>(`#${id}`);
  const value = (input?.value ?? '').trim();
  if (value && !EMAIL_RE.test(value)) {
    showToast('error', "That email doesn't look right", 'Check the address for download pages, or leave it empty to skip the pages that ask for one.');
    input?.focus();
    return null;
  }
  if (value !== (await savedGateEmail())) {
    try {
      await window.candybar.updateConfig({ gateEmail: value });
      saved = value;
      drafts.delete(id);
    } catch (err) {
      showToast('error', "Couldn't save the email", err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  return value;
}
