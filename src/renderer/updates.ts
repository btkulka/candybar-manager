import type { UpdateState } from '../types';

// Top-bar update button. The app checks GitHub on launch (main.ts); the button
// gets a dot whenever a check finds newer commits, and clicking it checks again
// and offers the same Update & Restart prompt.

let btn: HTMLButtonElement | null = null;

function render(state: UpdateState): void {
  if (!btn) return;
  btn.classList.toggle('has-update', !!state.available);
  btn.dataset.tooltip = state.available
    ? `Update available: ${state.available}. Click to update.`
    : 'Check GitHub for a newer Track Lab';
  btn.setAttribute('aria-label', state.available ? 'Update available' : 'Check for updates');
}

export function initUpdates(): void {
  btn = document.getElementById('check-updates') as HTMLButtonElement | null;
  if (!btn) return;

  // Subscribe before asking, so a launch check that finishes in between isn't missed.
  window.candybar.onUpdateState(render);
  window.candybar.getUpdateState()
    .then(render)
    .catch((err) => console.error('[Updates] getUpdateState failed:', err));

  btn.addEventListener('click', async () => {
    if (!btn || btn.disabled) return;
    btn.classList.add('loading');
    btn.disabled = true;
    try {
      await window.candybar.checkForUpdates();
    } catch (err) {
      console.error('[Updates] checkForUpdates failed:', err);
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });
}
