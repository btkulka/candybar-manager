// ========== Confirm Dialog ==========
// The one way to ask "are you sure?". Replaces window.confirm, whose OS sheet
// can't say what will happen or whether it can be undone. Cancel holds focus
// so Enter never confirms by accident; Escape and the backdrop both cancel.

import { escapeHtml } from './shared';

export type ConfirmTone = 'danger' | 'caution' | 'info';

export type ConfirmOptions = {
  title: string;
  /** Plain-language sentence: what happens if they say yes. */
  message: string;
  /** Labelled facts to check before confirming (files, totals, counts). */
  details?: { label: string; value: string }[];
  /** How to undo it, e.g. "You can put it back from the Trash". */
  safetyNote?: string;
  /** A verb that names the action ("Move to Trash"), never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  /** Keep the confirm button locked this long, for money and wipes. */
  armMs?: number;
};

export type ChoiceOptions = ConfirmOptions & {
  /** Third button on the left, e.g. "Discard changes". */
  secondaryLabel: string;
};

export type Choice = 'confirm' | 'secondary' | 'cancel';

const ICONS: Record<ConfirmTone, string> = {
  danger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  caution: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};
const SAFE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

let dialogSeq = 0;
/** Open dialogs, newest last. Only the top one answers the keyboard, so one
 *  Escape closes one dialog even when two are stacked. */
const openDialogs: string[] = [];

export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  return openDialog(opts).then((choice) => choice === 'confirm');
}

/** Three-way version: confirm, the secondary action, or cancel. */
export function confirmChoice(opts: ChoiceOptions): Promise<Choice> {
  return openDialog(opts);
}

function openDialog(opts: ConfirmOptions & { secondaryLabel?: string }): Promise<Choice> {
  const tone = opts.tone ?? 'caution';
  const id = `confirm-${++dialogSeq}`;
  const returnFocus = document.activeElement as HTMLElement | null;

  const details = opts.details?.length
    ? `<dl class="confirm-details">${opts.details.map(d =>
        `<div class="confirm-detail"><dt>${escapeHtml(d.label)}</dt><dd>${escapeHtml(d.value)}</dd></div>`).join('')}</dl>`
    : '';
  const safety = opts.safetyNote
    ? `<p class="confirm-safety">${SAFE_ICON}<span>${escapeHtml(opts.safetyNote)}</span></p>`
    : '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay confirm-overlay';
  overlay.innerHTML = `
    <div class="modal confirm-dialog tone-${tone}" role="alertdialog" aria-modal="true"
         aria-labelledby="${id}-title" aria-describedby="${id}-message">
      <div class="confirm-body">
        <div class="confirm-icon" aria-hidden="true">${ICONS[tone]}</div>
        <div class="confirm-text">
          <h3 id="${id}-title">${escapeHtml(opts.title)}</h3>
          <p class="confirm-message" id="${id}-message">${escapeHtml(opts.message)}</p>
          ${details}
          ${safety}
        </div>
      </div>
      <div class="modal-actions">
        ${opts.secondaryLabel ? `<button type="button" class="btn-ghost confirm-secondary" data-confirm="secondary">${escapeHtml(opts.secondaryLabel)}</button>` : ''}
        <button type="button" class="btn-ghost" data-confirm="cancel">${escapeHtml(opts.cancelLabel ?? 'Cancel')}</button>
        <button type="button" class="${tone === 'danger' ? 'btn-danger' : 'btn-primary'} confirm-go" data-confirm="go">
          <span class="confirm-go-label">${escapeHtml(opts.confirmLabel)}</span>
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const cancelBtn = overlay.querySelector<HTMLButtonElement>('[data-confirm="cancel"]')!;
  const goBtn = overlay.querySelector<HTMLButtonElement>('[data-confirm="go"]')!;
  const secondaryBtn = overlay.querySelector<HTMLButtonElement>('[data-confirm="secondary"]');

  let armTimer: ReturnType<typeof setTimeout> | null = null;
  if (opts.armMs && opts.armMs > 0) {
    goBtn.disabled = true;
    goBtn.classList.add('is-arming');
    goBtn.style.setProperty('--arm-ms', `${opts.armMs}ms`);
    goBtn.setAttribute('data-tooltip-disabled', 'Unlocks in a moment. Check the details above first.');
    armTimer = setTimeout(() => {
      goBtn.disabled = false;
      goBtn.classList.remove('is-arming');
      goBtn.removeAttribute('data-tooltip-disabled');
    }, opts.armMs);
  }

  return new Promise<Choice>((resolve) => {
    let done = false;
    const finish = (result: Choice) => {
      if (done) return;
      done = true;
      if (armTimer) clearTimeout(armTimer);
      document.removeEventListener('keydown', onKey, true);
      openDialogs.splice(openDialogs.indexOf(id), 1);
      overlay.remove();
      returnFocus?.focus?.();
      resolve(result);
    };

    // Capture phase + stopImmediatePropagation so Escape doesn't also close
    // whatever sits underneath (the Settings modal, the tag editor, a stacked
    // dialog's own listener on the same document).
    function onKey(e: KeyboardEvent) {
      if (openDialogs[openDialogs.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish('cancel');
      } else if (e.key === 'Tab') {
        const focusables = [secondaryBtn, cancelBtn, goBtn].filter((b): b is HTMLButtonElement => !!b && !b.disabled);
        const i = focusables.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        focusables[(i + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length]?.focus();
      }
    }

    openDialogs.push(id);
    document.addEventListener('keydown', onKey, true);
    cancelBtn.addEventListener('click', () => finish('cancel'));
    goBtn.addEventListener('click', () => finish('confirm'));
    secondaryBtn?.addEventListener('click', () => finish('secondary'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish('cancel'); });
    cancelBtn.focus();
  });
}

// ========== Move to Trash ==========
// Every delete in the app goes through safeDelete → OS Trash, so say so.

const LISTED_FILES = 6;

export function confirmMoveToTrash(
  files: { fileName: string; filePath: string }[],
  opts: { title?: string; message?: string } = {},
): Promise<boolean> {
  const n = files.length;
  const details = n === 1
    ? [{ label: 'File', value: files[0].fileName }, { label: 'Location', value: files[0].filePath }]
    : [
        ...files.slice(0, LISTED_FILES).map((f, i) => ({ label: i === 0 ? 'Files' : '', value: f.fileName })),
        ...(n > LISTED_FILES ? [{ label: '', value: `…and ${n - LISTED_FILES} more` }] : []),
      ];
  return confirmAction({
    title: opts.title ?? (n === 1 ? 'Move this track to the Trash?' : `Move ${n} tracks to the Trash?`),
    message: opts.message ?? (n === 1
      ? 'It will disappear from your library.'
      : 'They will disappear from your library.'),
    details,
    safetyNote: `Nothing is erased. You can put ${n === 1 ? 'it' : 'them'} back from the Trash in Finder.`,
    confirmLabel: 'Move to Trash',
    tone: 'danger',
  });
}
