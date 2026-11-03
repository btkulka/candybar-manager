// ========== Tooltips ==========
// One floating tooltip for the whole app. Any element with data-tooltip, or a
// native title (adopted so it looks the same), shows it on hover or keyboard
// focus. It renders into <body> with fixed positioning, so a scrolling card
// can't clip it and it works on <input>/<select>, which can't host the
// ::after pseudo-elements the old CSS-only tooltips used.
//
//   data-tooltip="…"            text to show; "" turns it off for that element
//   data-tooltip-pos="bottom"   preferred side: top (default) | bottom | left | right
//   data-tooltip-disabled="…"   shown instead while the control is disabled;
//                               say what the user has to do to unlock it

type Side = 'top' | 'bottom' | 'left' | 'right';

const SHOW_DELAY_MS = 450;
// Moving straight from one control to the next shows the next one at once.
const WARM_WINDOW_MS = 350;
const GAP = 8;
const EDGE = 8;
const ANCHOR_SELECTOR = '[data-tooltip], [data-tooltip-disabled], [title], [data-tip-title]';
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

let tipEl: HTMLDivElement | null = null;
let anchor: HTMLElement | null = null;
let pending: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let lastHiddenAt = 0;
// After a click, stay quiet until the pointer leaves that control.
let suppressed: HTMLElement | null = null;
let anchorObserver: MutationObserver | null = null;
let removalObserver: MutationObserver | null = null;

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
}

// Chromium draws its own tooltip for title="…" on top of ours, so move the text
// aside. Checked on every hover because code keeps assigning el.title later.
function adoptTitle(el: HTMLElement): void {
  const title = el.getAttribute('title');
  if (title === null) return;
  el.setAttribute('data-tip-title', title);
  el.removeAttribute('title');
}

function textFor(el: HTMLElement): string {
  adoptTitle(el);
  if (isDisabled(el)) {
    const why = el.getAttribute('data-tooltip-disabled');
    if (why) return why;
  }
  return (el.getAttribute('data-tooltip') ?? el.getAttribute('data-tip-title') ?? '').trim();
}

function findAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(ANCHOR_SELECTOR);
}

function ensureTip(): HTMLDivElement {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'app-tooltip';
  tipEl.id = 'app-tooltip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  return tipEl;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), Math.max(min, max));
}

function place(el: HTMLElement, tip: HTMLDivElement): void {
  const r = el.getBoundingClientRect();
  // offset* ignores the entrance transform, so mid-animation reads stay exact.
  const t = { width: tip.offsetWidth, height: tip.offsetHeight };
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const fits: Record<Side, boolean> = {
    top: r.top - GAP - t.height >= EDGE,
    bottom: r.bottom + GAP + t.height <= vh - EDGE,
    left: r.left - GAP - t.width >= EDGE,
    right: r.right + GAP + t.width <= vw - EDGE,
  };
  const preferred = (el.dataset.tooltipPos as Side | undefined) ?? 'top';
  const side: Side = fits[preferred] ? preferred
    : fits[OPPOSITE[preferred]] ? OPPOSITE[preferred]
    : fits.top ? 'top' : 'bottom';

  let x: number;
  let y: number;
  if (side === 'top' || side === 'bottom') {
    x = r.left + r.width / 2 - t.width / 2;
    y = side === 'top' ? r.top - GAP - t.height : r.bottom + GAP;
  } else {
    x = side === 'left' ? r.left - GAP - t.width : r.right + GAP;
    y = r.top + r.height / 2 - t.height / 2;
  }
  x = clamp(x, EDGE, vw - EDGE - t.width);
  y = clamp(y, EDGE, vh - EDGE - t.height);

  tip.dataset.side = side;
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(y)}px`;
  // Keep the arrow on the control even when the bubble was pushed off-center.
  tip.style.setProperty('--tip-arrow-x', `${Math.round(clamp(r.left + r.width / 2 - x, 12, t.width - 12))}px`);
  tip.style.setProperty('--tip-arrow-y', `${Math.round(clamp(r.top + r.height / 2 - y, 10, t.height - 10))}px`);
}

function show(el: HTMLElement): void {
  const text = textFor(el);
  if (!text) { hide(); return; }

  const tip = ensureTip();
  if (anchor && anchor !== el) detach();
  anchor = el;
  tip.textContent = text;
  tip.classList.remove('is-visible');
  place(el, tip);
  // Next frame so the fade/slide-in runs from the placed position.
  requestAnimationFrame(() => { if (anchor === el) tip.classList.add('is-visible'); });

  if (!el.hasAttribute('aria-describedby')) {
    el.setAttribute('aria-describedby', tip.id);
    el.dataset.tipDescribed = '1';
  }
  watch(el);
}

function detach(): void {
  anchorObserver?.disconnect();
  removalObserver?.disconnect();
  anchorObserver = null;
  removalObserver = null;
  if (anchor?.dataset.tipDescribed) {
    anchor.removeAttribute('aria-describedby');
    delete anchor.dataset.tipDescribed;
  }
}

function hide(): void {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  pending = null;
  if (!anchor) return;
  detach();
  anchor = null;
  lastHiddenAt = Date.now();
  tipEl?.classList.remove('is-visible');
}

// Live-update the text (e.g. "Copy" → "Copied!") and drop the tooltip if its
// control is re-rendered away underneath the pointer.
function watch(el: HTMLElement): void {
  anchorObserver = new MutationObserver(() => {
    if (anchor !== el || !tipEl) return;
    const text = textFor(el);
    if (!text) { hide(); return; }
    if (tipEl.textContent !== text) {
      tipEl.textContent = text;
      place(el, tipEl);
    }
  });
  anchorObserver.observe(el, {
    attributes: true,
    attributeFilter: ['data-tooltip', 'data-tooltip-disabled', 'title', 'disabled', 'aria-disabled'],
  });
  removalObserver = new MutationObserver(() => {
    if (anchor === el && !el.isConnected) hide();
  });
  removalObserver.observe(document.body, { childList: true, subtree: true });
}

// Only a scroll that moves the control hides its tooltip. A log auto-scrolling
// in another panel (Restore, Splice) shouldn't eat the tooltip on Abort.
function onScroll(e: Event): void {
  const target = anchor ?? pending;
  if (!target) return;
  const scroller = e.target;
  if (scroller === document || scroller === document.documentElement || scroller === document.body
      || (scroller instanceof Node && scroller.contains(target))) {
    hide();
  }
}

function schedule(el: HTMLElement): void {
  if (showTimer) clearTimeout(showTimer);
  pending = el;
  const warm = Date.now() - lastHiddenAt < WARM_WINDOW_MS;
  showTimer = setTimeout(() => {
    showTimer = null;
    if (pending === el && el.isConnected) show(el);
    pending = null;
  }, warm ? 0 : SHOW_DELAY_MS);
}

export function initTooltips(): void {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = findAnchor(e.target);
    if (el === anchor || el === pending) return;
    if (anchor || pending) hide();
    if (!el || el === suppressed) return;
    schedule(el);
  });

  document.addEventListener('pointerout', (e) => {
    const leaving = findAnchor(e.target);
    if (!leaving) return;
    const into = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    if (into && leaving.contains(into)) return;
    if (leaving === suppressed) suppressed = null;
    if (leaving === anchor || leaving === pending) hide();
  });

  document.addEventListener('focusin', (e) => {
    const el = findAnchor(e.target);
    // Text fields match :focus-visible even when clicked; only Tab should pop it.
    if (!el || el === suppressed || !(e.target as Element).matches(':focus-visible')) return;
    show(el);
  });
  document.addEventListener('focusout', (e) => {
    if (findAnchor(e.target) === anchor) hide();
  });

  document.addEventListener('pointerdown', (e) => {
    suppressed = findAnchor(e.target);
    hide();
  }, true);
  // "?" badges: a click shows the help instead of hiding it, and is cancelled
  // so an enclosing <label> never toggles or focuses its control.
  document.addEventListener('click', (e) => {
    const tip = e.target instanceof Element ? e.target.closest<HTMLElement>('.help-tip') : null;
    if (!tip) return;
    e.preventDefault();
    suppressed = null;
    show(tip);
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('wheel', hide, { capture: true, passive: true });
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
}
