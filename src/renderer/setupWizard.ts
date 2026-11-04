/**
 * Setup guide.
 *
 * Walks someone through everything Track Lab needs before it's useful: where
 * their music lives, where new downloads land and set-aside tracks go,
 * whether they use Rekordbox (and where its safety backups go), Spotify, and
 * the Qobuz/Beatport sign-ins. Every step can be skipped, and each one saves
 * as soon as you move on, so closing halfway keeps what's done.
 *
 * A first launch opens it before the tour. It reopens from the side nav
 * ("Setup guide"), Settings → Library, and any page that calls
 * requestOpenSetup(step). The side-nav badge counts what's still not set up.
 */

import type { AppConfig, SoundCloudSignIn, StoreAccount } from '../types';
import { escapeHtml, getErrorMessage, plural, setActiveTab, setValue, showToast, trapDialogFocus, captureFocusReturn, checkSpotifyConnection, checkSoundCloudConnection, checkStoreConnections } from './shared';
import { setCurrentArchivePath, setLibraryRootDisplay, setRekordboxBackupDir, setRekordboxEnabled, setStoreCredentials } from './settings';
import { autoRefreshLibrary } from './library';
import { startTour } from './tour';

type StepId = 'welcome' | 'library' | 'folders' | 'rekordbox' | 'spotify' | 'stores' | 'done';
type Store = 'qobuz' | 'beatport';
/** The backup folder is added by the Rekordbox swap engine; read it either way. */
type SetupConfig = AppConfig & { rekordboxBackupDir?: string };

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'library', label: 'Your music' },
  { id: 'folders', label: 'Folders' },
  { id: 'rekordbox', label: 'Rekordbox' },
  { id: 'spotify', label: 'Spotify' },
  { id: 'stores', label: 'Stores' },
  { id: 'done', label: 'All set' },
];

const SPOTIFY_DASHBOARD = 'https://developer.spotify.com/dashboard';

const ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  yes: '<svg class="choice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>',
  no: '<svg class="choice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  warn: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  ok: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  info: '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

// ========== State ==========

let root: HTMLElement | null = null;
let config: SetupConfig | null = null;
let current: StepId = 'welcome';
let firstRun = false;
let libraryChanged = false;
let restoreFocus: (() => void) | null = null;
let inerted: HTMLElement[] = [];

/** Results the last step sums up. 'done' = set up, 'skipped' = left for later. */
const outcome: Partial<Record<StepId, 'done' | 'skipped'>> = {};

// Live checks, re-run when the step is shown.
let rekordboxCheck: { state: 'idle' | 'checking' | 'ok' | 'error'; message: string } = { state: 'idle', message: '' };
let spotifyCheck: { state: 'idle' | 'checking' | 'ok' | 'error'; message: string } = { state: 'idle', message: '' };
let storeSignedIn: Record<Store, number> = { qobuz: 0, beatport: 0 };
let storeBusy: Store | null = null;
let soundcloudStatus: SoundCloudSignIn | null = null;
let soundcloudBusy = false;
// Where Rekordbox safety backups go when nothing's been chosen (next to the
// library); saved only if someone picks a different folder.
let defaultBackupDir = '';
let backupsPicked = false;

// ========== Public API ==========

export function initSetupWizard(): void {
  document.getElementById('open-setup')?.addEventListener('click', () => void openSetupWizard());
  document.addEventListener('candybar:open-setup', (e) => {
    const step = (e as CustomEvent<{ step?: string }>).detail?.step;
    void openSetupWizard({ step: isStep(step) ? step : undefined });
  });
}

/** A first launch: the guide, then the tour. */
export function startFirstRunSetup(): void {
  void openSetupWizard({ firstRun: true });
}

export async function openSetupWizard(opts: { step?: StepId; firstRun?: boolean } = {}): Promise<void> {
  if (root) {
    if (opts.step) go(opts.step);
    return;
  }
  try {
    config = await window.candybar.getConfig();
  } catch (err) {
    showToast('error', 'Couldn\'t open the setup guide', getErrorMessage(err));
    return;
  }
  firstRun = !!opts.firstRun;
  libraryChanged = false;
  current = opts.step ?? 'welcome';
  rekordboxCheck = { state: 'idle', message: '' };
  spotifyCheck = { state: 'idle', message: '' };
  backupsPicked = false;
  try { defaultBackupDir = (await window.candybar.upgradeSwapPreflight()).backupDir; } catch { defaultBackupDir = ''; }
  restoreFocus = captureFocusReturn();

  root = document.createElement('div');
  root.className = 'setup-overlay';
  root.innerHTML = `
    <div class="setup-panel" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <aside class="setup-rail">
        <p class="setup-rail-title">Setup guide</p>
        <ol class="setup-rail-steps"></ol>
        <button type="button" class="btn-ghost btn-sm setup-wizard-skip">Finish later</button>
      </aside>
      <section class="setup-main">
        <div class="setup-body" id="setup-body"></div>
        <footer class="setup-footer"></footer>
      </section>
    </div>
  `;
  document.body.appendChild(root);
  inerted = Array.from(document.body.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el !== root && !el.inert && !el.classList.contains('app-tooltip') && !el.classList.contains('toast-container'),
  );
  inerted.forEach((el) => { el.inert = true; });

  root.querySelector('.setup-wizard-skip')?.addEventListener('click', () => void close());
  root.addEventListener('keydown', onKeydown);
  await refreshStoreCounts();
  render();
}

/** How many things still aren't set up; drives the side-nav badge. */
export async function refreshSetupBadge(cfg?: AppConfig): Promise<void> {
  const badge = document.getElementById('setup-badge');
  if (!badge) return;
  let c: AppConfig;
  try { c = cfg ?? await window.candybar.getConfig(); } catch { return; }
  const missing: string[] = [];
  if (!c.spotifyClientId || !c.spotifyClientSecret) missing.push('Spotify');
  if ((c.qobuzAccounts?.length ?? 0) === 0 && (c.beatportAccounts?.length ?? 0) === 0) missing.push('a store sign-in');
  // Counts only what's genuinely not set up, so someone who's set up but never
  // opened the guide isn't nagged.
  badge.textContent = missing.length ? String(missing.length) : '';
  const link = document.getElementById('open-setup');
  if (link) {
    link.setAttribute('data-tooltip', missing.length
      ? `Still to set up: ${missing.join(' and ')}. The guide walks you through it.`
      : 'Walk through choosing your folders and connecting Rekordbox, Spotify and the stores');
  }
}

// ========== Navigation ==========

function isStep(s: string | undefined): s is StepId {
  return !!s && STEPS.some((x) => x.id === s);
}

function stepIndex(id: StepId): number {
  return STEPS.findIndex((s) => s.id === id);
}

function go(id: StepId): void {
  current = id;
  render();
}

function next(): void {
  const i = stepIndex(current);
  if (i < STEPS.length - 1) go(STEPS[i + 1].id);
}

function back(): void {
  const i = stepIndex(current);
  if (i > 0) go(STEPS[i - 1].id);
}

async function close(): Promise<void> {
  if (!root) return;
  const startTourAfter = firstRun;
  root.removeEventListener('keydown', onKeydown);
  root.remove();
  root = null;
  inerted.forEach((el) => { el.inert = false; });
  inerted = [];
  try {
    const saved = await window.candybar.updateConfig({ setupCompleted: true });
    void refreshSetupBadge(saved);
  } catch { /* the badge just stays */ }
  if (libraryChanged) void autoRefreshLibrary();
  restoreFocus?.();
  restoreFocus = null;
  // A first launch still gets the tour; finishing it offers it as a button.
  if (startTourAfter && current !== 'done') startTour();
}

function onKeydown(e: KeyboardEvent): void {
  if (!root) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    void close();
    return;
  }
  trapDialogFocus(root, e);
}

// ========== Rendering ==========

function render(): void {
  if (!root || !config) return;
  const rail = root.querySelector<HTMLOListElement>('.setup-rail-steps')!;
  const at = stepIndex(current);
  rail.innerHTML = STEPS.map((s, i) => {
    const state = outcome[s.id];
    const cls = [
      'setup-rail-step',
      i === at ? 'is-current' : '',
      state === 'done' ? 'is-done' : '',
      state === 'skipped' ? 'is-skipped' : '',
    ].filter(Boolean).join(' ');
    // Welcome and "All set" bracket the five numbered steps, so the rail's
    // numbers match the "Step 2 of 5" over each question.
    const bracket = s.id === 'welcome' || s.id === 'done';
    const mark = state === 'done' ? ICON.check : bracket ? '' : String(i);
    return `<li class="${cls}${bracket ? ' is-bracket' : ''}"><button type="button" data-goto="${s.id}" ${i === at ? 'aria-current="step"' : ''}>
      <span class="setup-rail-num">${mark}</span><span>${s.label}</span></button></li>`;
  }).join('');
  rail.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => go(b.dataset.goto as StepId));
  });

  const body = root.querySelector<HTMLElement>('#setup-body')!;
  const footer = root.querySelector<HTMLElement>('.setup-footer')!;
  const view = VIEWS[current]();
  body.innerHTML = view.html;
  footer.innerHTML = '';
  if (at > 0 && current !== 'done') footer.appendChild(button('btn-ghost', 'Back', back));
  const spacer = document.createElement('span');
  spacer.className = 'setup-footer-spacer';
  footer.appendChild(spacer);
  for (const b of view.buttons) footer.appendChild(b);
  view.wire?.(body);
  body.scrollTop = 0;
  // Focus the step heading so screen readers announce the new step.
  body.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}

function button(cls: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** Skip leaves the step for later; Continue marks it done. */
function skipButton(id: StepId, label = 'Skip for now'): HTMLButtonElement {
  return button('btn-ghost', label, () => { outcome[id] = outcome[id] === 'done' ? 'done' : 'skipped'; next(); });
}

function heading(eyebrow: string, title: string, lead: string): string {
  return `
    <p class="page-eyebrow">${escapeHtml(eyebrow)}</p>
    <h2 id="setup-title" tabindex="-1">${escapeHtml(title)}</h2>
    <p class="setup-lead">${lead}</p>
  `;
}

function pathField(id: string, label: string, desc: string, value: string, help = ''): string {
  return `
    <div class="field setup-field">
      <label for="${id}">${escapeHtml(label)}</label>
      <p class="field-desc">${desc}</p>
      <div class="input-row">
        <input type="text" id="${id}" value="${escapeHtml(value)}" readonly title="${escapeHtml(value)}" />
        <button type="button" class="btn-secondary" data-choose="${id}">Choose folder…</button>
      </div>
      ${help ? `<p class="field-help">${help}</p>` : ''}
    </div>
  `;
}

function wireChoose(body: HTMLElement, onPick: (id: string, path: string) => void | Promise<void>): void {
  body.querySelectorAll<HTMLButtonElement>('[data-choose]').forEach((b) => {
    b.addEventListener('click', async () => {
      const picked = await window.candybar.selectPath('dir');
      if (!picked) return;
      const input = body.querySelector<HTMLInputElement>(`#${b.dataset.choose}`);
      if (input) { input.value = picked; input.title = picked; }
      await onPick(b.dataset.choose!, picked);
    });
  });
}

function callout(kind: 'ok' | 'warn' | 'info', title: string, text: string): string {
  const cls = kind === 'ok' ? 'callout--success' : kind === 'warn' ? 'callout--warn' : 'callout--info';
  const icon = kind === 'ok' ? ICON.ok : kind === 'warn' ? ICON.warn : ICON.info;
  return `<div class="callout ${cls}" role="status">${icon}<div class="callout-body"><strong>${escapeHtml(title)}</strong>${text ? `<p>${text}</p>` : ''}</div></div>`;
}

interface StepView {
  html: string;
  buttons: HTMLButtonElement[];
  wire?: (body: HTMLElement) => void;
}

const VIEWS: Record<StepId, () => StepView> = {
  welcome: () => ({
    html: `
      <div class="setup-hero" aria-hidden="true"></div>
      ${heading('Setup guide', 'Welcome to Track Lab', 'Track Lab looks after your DJ library: it sorts new downloads, finds the tracks you\'re missing, swaps low-quality files for full-quality ones and checks your USB sticks before a gig.')}
      <ul class="setup-checklist">
        <li>${ICON.music}<div><strong>Tell Track Lab where your music lives</strong><span>Your library folder, and where new downloads land</span></div></li>
        <li>${ICON.yes.replace('class="choice-icon" ', '')}<div><strong>Connect Rekordbox, if you use it</strong><span>So Track Lab can read your playlists and keep your cue points safe</span></div></li>
        <li>${ICON.external}<div><strong>Connect Spotify and your music stores</strong><span>Optional — for checking playlists and buying full-quality copies</span></div></li>
      </ul>
      <p class="setup-note">${ICON.shield}<span>About 3 minutes. You can skip anything and change it later in Settings.</span></p>
    `,
    buttons: [
      button('btn-ghost', 'Not now', () => void close()),
      button('btn-primary btn-lg', 'Get started', next),
    ],
  }),

  library: () => {
    const root = config!.libraryRoot;
    const isDefault = /\/Music\/?$/.test(root);
    return {
      html: `
        ${heading('Step 1 of 5', 'Where\'s your music?', 'Pick the folder that holds your DJ music — the one Rekordbox plays your tracks from. A folder on an external drive is fine.')}
        ${pathField('setup-library-root', 'Library folder', 'Track Lab checks this folder for problems, and new music gets sorted into it, one folder per artist.', root,
          isDefault ? 'This is your Mac\'s Music folder. Change it if your tracks live somewhere else.' : 'Saved as soon as you pick a folder.')}
        <p class="setup-note">${ICON.shield}<span>Choosing a folder doesn't move or change anything in it.</span></p>
      `,
      buttons: [skipButton('library'), button('btn-primary', 'Continue', () => { outcome.library = 'done'; next(); })],
      wire: (body) => wireChoose(body, async (_id, picked) => {
        if (picked === config!.libraryRoot) return;
        try {
          config = { ...config!, ...(await window.candybar.updateConfig({ libraryRoot: picked })) };
          setLibraryRootDisplay(picked);
          libraryChanged = true;
          outcome.library = 'done';
          render();
        } catch (err) {
          showToast('error', 'Couldn\'t save the library folder', getErrorMessage(err));
        }
      }),
    };
  },

  folders: () => ({
    html: `
      ${heading('Step 2 of 5', 'New music and set-aside tracks', 'Two more folders. The suggestions sit next to your library and work for most people.')}
      ${pathField('setup-organize-source', 'New downloads folder', 'Where your new downloads land. "Sort new music" takes tracks from here and files them into your library.', config!.organizeSourceDir)}
      ${pathField('setup-archive', 'Set-aside folder', 'When you set a track aside, or swap it for a better copy, the old file is moved here instead of being deleted.', config!.archivePath)}
    `,
    buttons: [skipButton('folders'), button('btn-primary', 'Continue', () => void saveFolders())],
    wire: (body) => wireChoose(body, () => undefined),
  }),

  rekordbox: () => {
    const enabled = config!.rekordboxEnabled !== false;
    const backupDir = config!.rekordboxBackupDir || defaultBackupDir;
    let status = '';
    if (enabled) {
      if (rekordboxCheck.state === 'checking') status = callout('info', 'Looking for your Rekordbox collection…', '');
      else if (rekordboxCheck.state === 'ok') status = callout('ok', 'Found your Rekordbox collection', escapeHtml(rekordboxCheck.message));
      else if (rekordboxCheck.state === 'error') status = callout('warn', 'Track Lab couldn\'t read your Rekordbox collection', `${escapeHtml(rekordboxCheck.message)}<br>Upgrades and Restore need it; everything else works without it.`);
    }
    return {
      html: `
        ${heading('Step 3 of 5', 'Do you use Rekordbox?', 'Track Lab can read your Rekordbox playlists to find tracks worth upgrading, and swap in better copies without losing your cue points, play counts or date added.')}
        <div class="choice-grid setup-choice" role="radiogroup" aria-label="Do you use Rekordbox?">
          <button type="button" class="choice-card" role="radio" aria-checked="${enabled}" data-rekordbox="on">${ICON.yes}<strong>Yes, I use Rekordbox</strong><span>Show Upgrade quality and Restore library</span></button>
          <button type="button" class="choice-card" role="radio" aria-checked="${!enabled}" data-rekordbox="off">${ICON.no}<strong>No, I don't</strong><span>Hide the Rekordbox-only pages</span></button>
        </div>
        ${status}
        ${enabled && backupDir ? pathField('setup-rekordbox-backups', 'Safety backups', 'Before Track Lab changes anything in Rekordbox, it saves a copy of your whole collection here, so any change can be undone.', backupDir) : ''}
        ${enabled ? '<p class="setup-note">' + ICON.shield + '<span>Track Lab only reads Rekordbox unless you start an upgrade, and it asks you to close Rekordbox first.</span></p>' : ''}
      `,
      buttons: [skipButton('rekordbox'), button('btn-primary', 'Continue', () => void saveRekordbox())],
      wire: (body) => {
        body.querySelectorAll<HTMLButtonElement>('[data-rekordbox]').forEach((b) => {
          b.addEventListener('click', () => {
            config = { ...config!, rekordboxEnabled: b.dataset.rekordbox === 'on' };
            if (config.rekordboxEnabled) void checkRekordbox(); else render();
          });
        });
        wireChoose(body, (id) => { if (id === 'setup-rekordbox-backups') backupsPicked = true; });
        if (enabled && rekordboxCheck.state === 'idle') void checkRekordbox();
      },
    };
  },

  spotify: () => {
    const has = !!(config!.spotifyClientId && config!.spotifyClientSecret);
    let status = '';
    if (spotifyCheck.state === 'checking') status = callout('info', 'Checking with Spotify…', '');
    else if (spotifyCheck.state === 'ok') status = callout('ok', 'Spotify is connected', 'Track Lab can read your playlists now.');
    else if (spotifyCheck.state === 'error') status = callout('warn', 'Spotify didn\'t accept those keys', escapeHtml(spotifyCheck.message));
    // Already working: lead with that, and fold the how-to away.
    const connected = spotifyCheck.state === 'ok';
    return {
      html: `
        ${heading('Step 4 of 5', 'Connect Spotify', 'Optional. Track Lab reads Spotify playlists so you can see which tracks you don\'t have yet. Spotify asks for a free "app" key to allow that — here\'s how to get one.')}
        ${status}
        <details class="disclosure setup-howto-wrap" ${connected ? '' : 'open'}>
        <summary>${connected ? 'Use different keys' : 'How to get your Spotify keys'}<span class="disclosure-hint">about 2 minutes</span></summary>
        <div class="disclosure-body">
        <ol class="setup-howto">
          <li><span class="step-num">1</span><div><strong>Open the Spotify developer dashboard</strong><span>Sign in with your normal Spotify account.</span>
            <button type="button" class="btn-secondary btn-sm" data-open-dashboard>${ICON.external}Open the dashboard</button></div></li>
          <li><span class="step-num">2</span><div><strong>Click "Create app"</strong><span>Any name and description work. For "Redirect URI" type <code>http://127.0.0.1:8888/callback</code> (Track Lab doesn't use it, but Spotify asks for one), tick "Web API", and save.</span></div></li>
          <li><span class="step-num">3</span><div><strong>Copy the two keys here</strong><span>In your new app, open Settings. Copy the Client ID, then click "View client secret" and copy that too.</span></div></li>
        </ol>
        <div class="setup-two-up">
          <div class="field"><label for="setup-spotify-id">Client ID</label>
            <input type="text" id="setup-spotify-id" value="${escapeHtml(config!.spotifyClientId ?? '')}" placeholder="32 letters and numbers" autocomplete="off" spellcheck="false" /></div>
          <div class="field"><label for="setup-spotify-secret">Client secret</label>
            <input type="password" id="setup-spotify-secret" value="${escapeHtml(config!.spotifyClientSecret ?? '')}" placeholder="Also 32 letters and numbers" autocomplete="off" spellcheck="false" /></div>
        </div>
        </div>
        </details>
      `,
      buttons: [
        skipButton('spotify', has ? 'Keep as is' : 'Skip for now'),
        button('btn-secondary', 'Test connection', () => void saveSpotify(false)),
        button('btn-primary', 'Continue', () => void saveSpotify(true)),
      ],
      wire: (body) => {
        body.querySelector('[data-open-dashboard]')?.addEventListener('click', () => void window.candybar.openExternal(SPOTIFY_DASHBOARD));
        if (has && spotifyCheck.state === 'idle') void testSpotify();
      },
    };
  },

  stores: () => ({
    html: `
      ${heading('Step 5 of 5', 'Sign in to your music stores', 'Optional. Sign in to Qobuz and Beatport to search them, fill your carts and re-download what you\'ve bought, and to SoundCloud for your likes, private sets and free downloads. You can add more store accounts later in Settings.')}
      <div class="setup-stores">
        ${storeCard('qobuz', 'Qobuz', 'Full-quality downloads of almost everything.')}
        ${storeCard('beatport', 'Beatport', 'The DJ store: club mixes, extended versions and remixes.')}
        ${soundcloudCard()}
      </div>
      <p class="setup-note">${ICON.shield}<span>Signing in opens the store's own page. Your password goes to the store, never to Track Lab.</span></p>
    `,
    buttons: [skipButton('stores'), button('btn-primary', 'Continue', () => {
      if (storeSignedIn.qobuz + storeSignedIn.beatport > 0 || soundcloudStatus?.signedIn) outcome.stores = 'done';
      else outcome.stores ??= 'skipped';
      next();
    })],
    wire: (body) => {
      body.querySelectorAll<HTMLButtonElement>('[data-sign-in]').forEach((b) => {
        b.addEventListener('click', () => void signIn(b.dataset.signIn as Store));
      });
      body.querySelector('[data-soundcloud-sign-in]')?.addEventListener('click', () => void signInSoundCloud());
    },
  }),

  done: () => {
    const rows: Array<{ id: StepId; label: string; later: string }> = [
      { id: 'library', label: 'Your music library', later: 'Choose it in Settings → Library' },
      { id: 'folders', label: 'New downloads and set-aside folders', later: 'Change them in Settings → Library' },
      { id: 'rekordbox', label: 'Rekordbox', later: 'Turn it on or off in Settings → Library' },
      { id: 'spotify', label: 'Spotify', later: 'Connect it any time in Settings → Spotify' },
      { id: 'stores', label: 'Qobuz, Beatport and SoundCloud', later: 'Sign in any time in Settings' },
    ];
    return {
      html: `
        <div class="setup-hero setup-hero--small" aria-hidden="true"></div>
        ${heading('All set', 'You\'re ready to go', 'Here\'s what\'s set up. Anything you skipped can be done later — the "Setup guide" link at the bottom of the side bar brings you back here.')}
        <ul class="setup-summary">
          ${rows.map((r) => {
            const done = outcome[r.id] === 'done';
            return `<li class="${done ? 'is-done' : 'is-skipped'}">
              <span class="setup-summary-mark">${done ? ICON.check : ''}</span>
              <div><strong>${escapeHtml(r.label)}</strong><span>${done ? 'Set up' : escapeHtml(outcome[r.id] === 'skipped' ? `Skipped — ${r.later}` : 'Not changed')}</span></div>
              <button type="button" class="btn-ghost btn-sm" data-goto-step="${r.id}">Change</button>
            </li>`;
          }).join('')}
        </ul>
      `,
      buttons: [
        button('btn-secondary', 'Go to my library', () => { setActiveTab('library'); void close(); }),
        button('btn-primary btn-lg', 'Take the 1-minute tour', () => { void close().then(() => startTour()); }),
      ],
      wire: (body) => {
        body.querySelectorAll<HTMLButtonElement>('[data-goto-step]').forEach((b) => b.addEventListener('click', () => go(b.dataset.gotoStep as StepId)));
      },
    };
  },
};

function storeCard(store: Store, name: string, desc: string): string {
  const n = storeSignedIn[store];
  const busy = storeBusy === store;
  return `
    <div class="setup-store setup-store--${store}">
      <div class="setup-store-head">
        <strong>${name}</strong>
        <span class="status-pill ${n > 0 ? 'status-pill--ok' : ''}">${n > 0 ? (n > 1 ? `${n} accounts signed in` : 'Signed in') : 'Not signed in'}</span>
      </div>
      <p>${escapeHtml(desc)}</p>
      <button type="button" class="${n > 0 ? 'btn-ghost' : 'btn-secondary'}" data-sign-in="${store}" ${busy ? 'disabled' : ''}>
        ${busy ? 'Waiting for you to sign in…' : n > 0 ? 'Add another account' : `Sign in to ${name}`}
      </button>
    </div>
  `;
}

/** SoundCloud has one sign-in (the Chrome profile every SoundCloud run
 *  opens), not a list of accounts. */
function soundcloudCard(): string {
  const signedIn = !!soundcloudStatus?.signedIn;
  const who = soundcloudStatus?.username || soundcloudStatus?.permalink || '';
  return `
    <div class="setup-store setup-store--soundcloud">
      <div class="setup-store-head">
        <strong>SoundCloud</strong>
        <span class="status-pill ${signedIn ? 'status-pill--ok' : ''}">${signedIn ? (who ? `Signed in as ${escapeHtml(who)}` : 'Signed in') : 'Not signed in'}</span>
      </div>
      <p>Your likes, private sets and free downloads. Signing in here signs in every SoundCloud run, including Claude's.</p>
      <button type="button" class="${signedIn ? 'btn-ghost' : 'btn-secondary'}" data-soundcloud-sign-in ${soundcloudBusy ? 'disabled' : ''}>
        ${soundcloudBusy ? 'Waiting for you to sign in…' : signedIn ? 'Check again' : 'Sign in to SoundCloud'}
      </button>
    </div>
  `;
}

// ========== Step actions ==========

async function saveFolders(): Promise<void> {
  const body = root?.querySelector<HTMLElement>('#setup-body');
  const organizeSourceDir = body?.querySelector<HTMLInputElement>('#setup-organize-source')?.value.trim() || config!.organizeSourceDir;
  const archivePath = body?.querySelector<HTMLInputElement>('#setup-archive')?.value.trim() || config!.archivePath;
  try {
    config = { ...config!, ...(await window.candybar.updateConfig({ organizeSourceDir, archivePath })) };
    setValue('organize-source', organizeSourceDir);
    setCurrentArchivePath(archivePath);
    outcome.folders = 'done';
    next();
  } catch (err) {
    showToast('error', 'Couldn\'t save those folders', getErrorMessage(err));
  }
}

async function checkRekordbox(): Promise<void> {
  rekordboxCheck = { state: 'checking', message: '' };
  render();
  try {
    const res = await window.candybar.upgradeListPlaylists();
    rekordboxCheck = res.success
      ? { state: 'ok', message: `${plural(res.playlists?.length ?? 0, 'playlist')} found. Nothing in Rekordbox was changed.` }
      : { state: 'error', message: res.error ?? 'Rekordbox didn\'t answer.' };
  } catch (err) {
    rekordboxCheck = { state: 'error', message: getErrorMessage(err) };
  }
  if (current === 'rekordbox') render();
}

async function saveRekordbox(): Promise<void> {
  const enabled = config!.rekordboxEnabled !== false;
  const partial: Partial<SetupConfig> = { rekordboxEnabled: enabled };
  const backups = root?.querySelector<HTMLInputElement>('#setup-rekordbox-backups')?.value.trim();
  if (enabled && backupsPicked && backups) partial.rekordboxBackupDir = backups;
  try {
    config = { ...config!, ...(await window.candybar.updateConfig(partial as Partial<AppConfig>)) };
    setRekordboxEnabled(enabled);
    setRekordboxBackupDir(config.rekordboxBackupDir);
    outcome.rekordbox = 'done';
    next();
  } catch (err) {
    showToast('error', 'Couldn\'t save the Rekordbox setting', getErrorMessage(err));
  }
}

async function testSpotify(): Promise<boolean> {
  spotifyCheck = { state: 'checking', message: '' };
  render();
  let ok = false;
  try {
    ok = await window.candybar.checkSpotify();
    spotifyCheck = ok
      ? { state: 'ok', message: '' }
      : { state: 'error', message: 'Check that both keys were copied in full, with no spaces, from the same app.' };
  } catch (err) {
    spotifyCheck = { state: 'error', message: getErrorMessage(err) };
  }
  if (current === 'spotify') render();
  void checkSpotifyConnection(false);
  return ok;
}

async function saveSpotify(andContinue: boolean): Promise<void> {
  const body = root?.querySelector<HTMLElement>('#setup-body');
  const spotifyClientId = body?.querySelector<HTMLInputElement>('#setup-spotify-id')?.value.trim() ?? '';
  const spotifyClientSecret = body?.querySelector<HTMLInputElement>('#setup-spotify-secret')?.value.trim() ?? '';
  if (!spotifyClientId || !spotifyClientSecret) {
    if (andContinue) { outcome.spotify ??= 'skipped'; next(); return; }
    spotifyCheck = { state: 'error', message: 'Paste both the Client ID and the Client secret first.' };
    render();
    return;
  }
  try {
    config = { ...config!, ...(await window.candybar.updateConfig({ spotifyClientId, spotifyClientSecret })) };
    // Keep Settings' fields in step with what was just saved.
    setValue('setting-spotify-client-id', spotifyClientId);
    setValue('setting-spotify-client-secret', spotifyClientSecret);
  } catch (err) {
    showToast('error', 'Couldn\'t save the Spotify keys', getErrorMessage(err));
    return;
  }
  const ok = await testSpotify();
  if (ok) outcome.spotify = 'done';
  if (ok && andContinue) next();
}

async function refreshStoreCounts(): Promise<void> {
  try {
    const s = await window.candybar.storeLoginStatus();
    storeSignedIn = {
      qobuz: Object.values(s.qobuzAccounts ?? {}).filter(Boolean).length,
      beatport: Object.values(s.beatportAccounts ?? {}).filter(Boolean).length,
    };
  } catch { /* shows as not signed in */ }
  try {
    soundcloudStatus = await window.candybar.soundcloudSignInStatus();
  } catch { /* shows as not signed in */ }
}

async function signInSoundCloud(): Promise<void> {
  if (soundcloudBusy) return;
  soundcloudBusy = true;
  render();
  try {
    const res = await window.candybar.soundcloudSignIn();
    if (!res.success) showToast('error', 'Couldn\'t sign in to SoundCloud', res.error ?? 'Something went wrong.');
    else if (!res.status?.signedIn) showToast('warning', 'Not signed in', 'The sign-in window closed before you finished.');
    soundcloudStatus = res.status ?? soundcloudStatus;
  } catch (err) {
    showToast('error', 'Sign-in didn\'t work', getErrorMessage(err));
  } finally {
    soundcloudBusy = false;
  }
  if (soundcloudStatus?.signedIn) outcome.stores = 'done';
  // The top bar's pill reads the same note, so it updates without a second check.
  void checkSoundCloudConnection(false);
  if (current === 'stores') render();
}

async function signIn(store: Store): Promise<void> {
  if (storeBusy) return;
  const existing = (store === 'qobuz' ? config!.qobuzAccounts : config!.beatportAccounts) ?? [];
  const account: StoreAccount = {
    id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `acct-${Date.now().toString(36)}`,
    label: `Account ${existing.length + 1}`,
  };
  storeBusy = store;
  render();
  try {
    const res = await window.candybar.storeLoginAccount(store, account);
    if (!res.success) showToast('warning', 'Not signed in', res.error ?? 'The sign-in window closed before you finished.');
  } catch (err) {
    showToast('error', 'Sign-in didn\'t work', getErrorMessage(err));
  } finally {
    storeBusy = null;
  }
  try {
    config = await window.candybar.getConfig();
    await setStoreCredentials(config);
  } catch { /* Settings refreshes on open anyway */ }
  await refreshStoreCounts();
  if (storeSignedIn[store] > 0) outcome.stores = 'done';
  window.dispatchEvent(new CustomEvent('store-account-changed', { detail: { service: store } }));
  void checkStoreConnections(false);
  if (current === 'stores') render();
}
