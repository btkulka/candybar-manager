/**
 * First-run tour.
 *
 * Dims the app and spotlights one area at a time with a short card explaining
 * it, switching pages as it goes. Starts on a machine's first launch (config
 * `tutorialCompleted` is false) and replays from the ? button in the topbar or
 * Settings → Library. Someone whose config predates the tour gets a one-time
 * toast offering it instead (`tourOffered`).
 * Finishing or skipping marks it completed; quitting mid-tour does not, so it
 * comes back next launch.
 */

import { setActiveTab, showToast, requestOpenSetup } from './shared';
import { closeSettings } from './settings';

interface TourStep {
  /** Selector for the area to spotlight; several matches are spotlit as one box.
   *  Omit for a centered card. Steps whose target isn't visible are dropped. */
  target?: string;
  /** Page to show behind the step. */
  page?: string;
  title: string;
  body: string;
  /** Primary button on the last step; runs after the tour closes. */
  action?: { label: string; run: () => void };
}

const STEPS: TourStep[] = [
  {
    title: 'Welcome to Track Lab',
    body: 'A one-minute look at what each page does. The arrow keys move through it, and Esc skips it.',
  },
  {
    target: '.topbar-nav',
    title: 'Everything lives in the side bar',
    body: 'Pages are grouped by what you\'re doing: looking after your library, getting new music, getting ready for a gig, and fixing things.',
  },
  {
    target: '.nav-link[data-page="library"]',
    page: 'library',
    title: 'Library',
    body: 'Your whole collection at a glance: what\'s ready to play, what could use a fix (like missing cover art or a lower-quality file), and any drives plugged in. Track Lab checks it again every time it opens.',
  },
  {
    target: '.nav-link[data-page="organize"]',
    page: 'organize',
    title: 'Sort new music',
    body: 'Point it at the folder your downloads land in, and it files each track into your library, one folder per artist. Nothing moves until you say so.',
  },
  {
    target: '.nav-link[data-page="source"]',
    page: 'source',
    title: 'Find & buy',
    body: 'Add a Spotify playlist, a SoundCloud set or a spreadsheet. Track Lab shows which tracks you already have and finds full-quality copies of the rest on Qobuz and Beatport. Playlists are saved, so you can check one again in a click.',
  },
  {
    target: '.nav-link[data-page="upgrade"]',
    page: 'upgrade',
    title: 'Upgrade quality',
    body: 'Pick a Rekordbox playlist. Track Lab finds the MP3s and streaming tracks, helps you buy full-quality copies, then swaps them in for you — keeping your cue points, play counts and date added.',
  },
  {
    target: '.nav-link[data-page="usb-health"]',
    page: 'usb-health',
    title: 'Check a USB',
    body: 'Before a gig, plug in your USB stick and make sure every track on it will play on Pioneer CDJs and XDJs.',
  },
  {
    target: '.nav-link[data-page="restore"]',
    page: 'restore',
    title: 'Restore library',
    body: 'Lost your library? Rebuild it from a Rekordbox backup file, your USB sticks, and the tracks you\'ve bought on Beatport and Qobuz.',
  },
  {
    target: '.nav-link[data-page="splice-recovery"]',
    page: 'splice-recovery',
    title: 'Splice samples',
    body: 'Ableton project missing sounds? Track Lab finds them on Splice and downloads them back into place.',
  },
  {
    target: '#connections-toggle',
    title: 'Your connections',
    body: 'This says whether Spotify, SoundCloud, Qobuz and Beatport are working, in a few words. Click it to see each one and sign in.',
  },
  {
    target: '#open-setup, #start-tour, #open-settings',
    title: 'Setup and help',
    body: 'The setup guide, this tour and Settings are always down here. Anything you skipped during setup can be finished from the setup guide.',
    action: { label: 'Open the setup guide', run: () => requestOpenSetup() },
  },
];

const PAD = 6;     // spotlight padding around the target
const GAP = 14;    // spotlight to card
const MARGIN = 16; // card to window edge

// ========== State ==========

let root: HTMLElement | null = null;
let steps: TourStep[] = [];
let index = 0;
let pageBeforeTour: string | null = null;
let focusBeforeTour: HTMLElement | null = null;
let inerted: HTMLElement[] = [];

// ========== Public API ==========

export function startTour(): void {
  if (root) return;
  steps = STEPS.filter((s) => !s.target || targetRect(s.target));
  index = 0;
  pageBeforeTour = document.querySelector('.page.active')?.id.replace(/^page-/, '') ?? null;
  focusBeforeTour = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = `
    <div class="tour-spotlight"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
      <div class="tour-step-count"></div>
      <h3 class="tour-title" id="tour-title"></h3>
      <p class="tour-body" id="tour-body"></p>
      <div class="tour-actions">
        <button type="button" class="btn-ghost btn-sm tour-skip">Skip tour</button>
        <button type="button" class="btn-secondary btn-sm tour-back">Back</button>
        <button type="button" class="btn-secondary btn-sm tour-done">Done</button>
        <button type="button" class="btn-primary btn-sm tour-next"></button>
      </div>
    </div>
  `;
  document.body.append(root);
  button('skip').addEventListener('click', endTour);
  button('done').addEventListener('click', endTour);
  button('back').addEventListener('click', back);
  button('next').addEventListener('click', next);

  // Everything outside the tour ignores clicks, focus and hover until it ends.
  inerted = Array.from(document.body.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el !== root && !el.inert
  );
  inerted.forEach((el) => { el.inert = true; });

  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', layout);
  render();
  // Transitions only once the first step is in place, so nothing slides in from the corner.
  requestAnimationFrame(() => root?.classList.add('is-live'));
}

export function initTour(): void {
  document.getElementById('start-tour')?.addEventListener('click', startTour);
  document.getElementById('settings-start-tour')?.addEventListener('click', async () => {
    if (await closeSettings()) startTour();
  });
}

/** One-time nudge for someone who was using the app before the tour existed:
 *  their config reads as tour-completed, so it never starts on its own. */
export function offerTour(): void {
  showToast(
    'info',
    'New: a quick tour',
    'Pages have plainer names, there\'s a setup guide, and Find & buy remembers your playlists. The one-minute tour shows where everything lives — it\'s also at the bottom of the side bar.',
    15000,
    { label: 'Take the tour', onClick: startTour }
  );
  void window.candybar.updateConfig({ tourOffered: true }).catch((err: unknown) => {
    console.error('[Tour] failed to save the offer:', err);
  });
}

// ========== Steps ==========

function next(): void {
  if (index < steps.length - 1) {
    index++;
    render();
    return;
  }
  const action = steps[index].action;
  endTour();
  action?.run();
}

function back(): void {
  if (index === 0) return;
  index--;
  render();
}

function endTour(): void {
  if (!root) return;
  root.remove();
  root = null;
  inerted.forEach((el) => { el.inert = false; });
  inerted = [];
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', layout);
  if (pageBeforeTour) setActiveTab(pageBeforeTour);
  focusBeforeTour?.focus();
  void markCompleted();
}

async function markCompleted(): Promise<void> {
  try {
    // Merge-write the one key, so a Settings save racing this can't undo it.
    await window.candybar.updateConfig({ tutorialCompleted: true, tourOffered: true });
  } catch (err) {
    console.error('[Tour] failed to save completion:', err);
  }
}

// Capture phase, so Esc and the arrows don't also reach the drawer and modal handlers.
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') endTour();
  else if (e.key === 'ArrowRight' && index < steps.length - 1) next();
  else if (e.key === 'ArrowLeft') back();
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

// ========== Rendering ==========

function button(name: 'skip' | 'back' | 'done' | 'next'): HTMLButtonElement {
  return root!.querySelector<HTMLButtonElement>(`.tour-${name}`)!;
}

function render(): void {
  if (!root) return;
  const step = steps[index];
  const first = index === 0;
  const last = index === steps.length - 1;
  if (step.page) setActiveTab(step.page);

  root.querySelector('.tour-step-count')!.textContent = `${index + 1} of ${steps.length}`;
  root.querySelector('.tour-title')!.textContent = step.title;
  root.querySelector('.tour-body')!.textContent = step.body;
  button('skip').classList.toggle('hidden', last);
  button('back').classList.toggle('hidden', first);
  button('done').classList.toggle('hidden', !(last && step.action));
  button('next').textContent = first ? 'Start tour' : last ? step.action?.label ?? 'Done' : 'Next';

  layout();
  button('next').focus();
}

function layout(): void {
  if (!root) return;
  const step = steps[index];
  const rect = step.target ? targetRect(step.target) : null;
  const spotlight = root.querySelector<HTMLElement>('.tour-spotlight')!;
  const card = root.querySelector<HTMLElement>('.tour-card')!;

  // A zero-size spotlight in the middle leaves the whole window dimmed.
  const spot = rect
    ? new DOMRect(rect.left - PAD, rect.top - PAD, rect.width + PAD * 2, rect.height + PAD * 2)
    : new DOMRect(innerWidth / 2, innerHeight / 2, 0, 0);
  spotlight.classList.toggle('is-empty', !rect);
  spotlight.style.left = `${spot.left}px`;
  spotlight.style.top = `${spot.top}px`;
  spotlight.style.width = `${spot.width}px`;
  spotlight.style.height = `${spot.height}px`;

  const pos = placeCard(rect ? spot : null, card.offsetWidth, card.offsetHeight);
  card.style.left = `${pos.left}px`;
  card.style.top = `${pos.top}px`;
}

/** Bounding box of every visible match, or null if nothing matching is on screen. */
function targetRect(selector: string): DOMRect | null {
  const rects = Array.from(document.querySelectorAll(selector))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/** Beside the spotlight on the first side with room (right, below, left, above),
 *  otherwise centered in the window. */
function placeCard(spot: DOMRect | null, w: number, h: number): { left: number; top: number } {
  const maxLeft = innerWidth - w - MARGIN;
  const maxTop = innerHeight - h - MARGIN;
  const clamp = (v: number, max: number) => Math.max(MARGIN, Math.min(v, max));
  if (spot) {
    const alongX = clamp(spot.left + spot.width / 2 - w / 2, maxLeft);
    const alongY = clamp(spot.top + spot.height / 2 - h / 2, maxTop);
    if (spot.right + GAP <= maxLeft) return { left: spot.right + GAP, top: alongY };
    if (spot.bottom + GAP <= maxTop) return { left: alongX, top: spot.bottom + GAP };
    if (spot.left - GAP - w >= MARGIN) return { left: spot.left - GAP - w, top: alongY };
    if (spot.top - GAP - h >= MARGIN) return { left: alongX, top: spot.top - GAP - h };
  }
  return { left: clamp((innerWidth - w) / 2, maxLeft), top: clamp((innerHeight - h) / 2, maxTop) };
}
