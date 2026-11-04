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

import { setActiveTab, showToast } from './shared';
import { openSettingsTo, closeSettings } from './settings';

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
    body: 'A one-minute tour of what each page is for. Arrow keys move through it, Esc skips it.',
  },
  {
    target: '.topbar-nav',
    title: 'Pages',
    body: 'Every tool lives in this sidebar: Rekordbox tools on top, Ableton tools below.',
  },
  {
    target: '.nav-link[data-page="library"]',
    page: 'library',
    title: 'Library',
    body: 'Your whole collection at a glance: health counts, problems like missing files, lossy or unplayable formats and missing tags, possible duplicates, and connected drives. It rescans in the background each time the app opens.',
  },
  {
    target: '.nav-link[data-page="organize"]',
    page: 'organize',
    title: 'Organize',
    body: 'Point it at a folder of new downloads and it moves each track into an artist folder in your library, based on its artist tag.',
  },
  {
    target: '.nav-link[data-page="source"]',
    page: 'source',
    title: 'Sourcing',
    body: 'Add a Spotify playlist, a SoundCloud set or a CSV. It checks which tracks you already own, then finds lossless copies of the rest on Qobuz and Beatport and builds a cart.',
  },
  {
    target: '.nav-link[data-page="upgrade"]',
    page: 'upgrade',
    title: 'Upgrades',
    body: 'Pick a Rekordbox playlist and it finds the tracks you only have as MP3, AAC or a streaming link, then looks for full-quality copies to buy.',
  },
  {
    target: '.nav-link[data-page="usb-health"]',
    page: 'usb-health',
    title: 'USB',
    body: 'Before a gig, plug in your USB stick and check it for files a Pioneer XDJ-RX3 won’t play.',
  },
  {
    target: '.nav-link[data-page="restore"]',
    page: 'restore',
    title: 'Restore',
    body: 'Rebuild a library from a Rekordbox XML, pulling files from connected drives and re-downloading your Beatport and Qobuz purchases.',
  },
  {
    target: '.nav-link[data-page="splice-recovery"]',
    page: 'splice-recovery',
    title: 'Splice Recovery',
    body: 'Open an Ableton .als project and re-download the Splice samples it can’t find.',
  },
  {
    target: '#spotify-status, #soundcloud-status, #qobuz-status, #beatport-status',
    title: 'Connections',
    body: 'These show whether Spotify, SoundCloud, Qobuz and Beatport are connected. Click one to refresh it or sign in.',
  },
  {
    target: '#start-tour, #open-settings',
    title: 'Start in Settings',
    body: 'Choose your library folder first. Rekordbox XML, Spotify keys and store sign-ins can wait until a page asks for them. The ? button replays this tour.',
    action: { label: 'Open Settings', run: () => openSettingsTo('library') },
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
    'Upgrades, SoundCloud sets in Sourcing and more. The one-minute tour shows where everything lives. It\'s also under ? in the top bar.',
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
