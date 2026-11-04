import { escapeHtml, showToast, getErrorMessage, requestOpenSettings, plural } from './shared';

// ========== Types ==========

type Volume = { name: string; mountPath: string; scanRoot: string };

type Totals = {
  totalXmlTracks: number;
  alreadyInLibrary: number;
  missing: number;
  recovered: number;
  stillMissing: number;
  /** Missing on disk but left out on purpose: tracks Ben deleted. Not missing, not failed. */
  deletedSkipped?: number;
};

type PerAccountCounter = {
  accountId: string;
  service: 'qobuz' | 'beatport';
  label?: string;
  email?: string;
  ownedCount?: number;
  matchedCount?: number;
  downloadedCount?: number;
  failedCount?: number;
};

type LogEntry = {
  level: 'info' | 'warn' | 'error';
  phase: string;
  message: string;
  timestamp: number;
  currentTrack?: string;
};

type Progress = {
  phase: string;
  phaseStatus?: 'start' | 'update' | 'end' | 'skipped';
  message: string;
  currentTrack?: string;
  totals: Totals;
  elapsedSec: number;
  estRemainingSec?: number;
  rate?: number;
  perAccount?: PerAccountCounter[];
  log?: LogEntry;
};

type TrackResult = {
  track: { trackId: string; artist: string; title: string; album: string };
  status: 'pending' | 'in_progress' | 'recovered' | 'still_missing' | 'failed';
  source: 'usb' | 'beatport' | 'qobuz' | 'soundcloud' | null;
  sourceAccountId?: string;
  destPath?: string;
  detail?: string;
  failureCategory?: 'no_match' | 'login' | 'download' | 'copy' | 'rewrite' | 'other';
};

/** A track the restore leaves out on purpose (Ben deleted it). */
type SkippedTrack = { trackId: string; artist: string; title: string; reason: string };

type Report = {
  totals: Totals;
  bySource: Record<string, number>;
  results: TrackResult[];
  // Optional: reports saved before these fields existed don't have them.
  deletedSkipped?: SkippedTrack[];
  /** "Couldn't check Qobuz/Beatport account X: …" purchase-history read errors. */
  storeErrors?: string[];
  xmlRewrite?: { backupPath: string | null; updated: number; notFound: number };
  durationSec: number;
  options: {
    xmlPath: string;
    libraryRoot: string;
    stageDir: string;
    rewriteXml?: boolean;
    sources: { usb: boolean; beatport: boolean; qobuz: boolean; soundcloud: boolean };
  };
};

type Stage = 'configure' | 'review' | 'running' | 'report';
type Store = 'beatport' | 'qobuz';

// ========== DOM ==========

const stepper = document.getElementById('restore-stepper') as HTMLElement | null;

const xmlInput = document.getElementById('restore-xml-path') as HTMLInputElement | null;
const pickXmlBtn = document.getElementById('restore-pick-xml') as HTMLButtonElement | null;
const libRootInput = document.getElementById('restore-library-root') as HTMLInputElement | null;
const volumesEl = document.getElementById('restore-volumes') as HTMLDivElement | null;
const refreshVolumesBtn = document.getElementById('restore-refresh-volumes') as HTMLButtonElement | null;
const srcUsb = document.getElementById('restore-src-usb') as HTMLInputElement | null;
const srcBeatport = document.getElementById('restore-src-beatport') as HTMLInputElement | null;
const srcQobuz = document.getElementById('restore-src-qobuz') as HTMLInputElement | null;
const srcSoundcloud = document.getElementById('restore-src-soundcloud') as HTMLInputElement | null;
const concurrencyInput = document.getElementById('restore-concurrency') as HTMLInputElement | null;
const usbTagMatchingInput = document.getElementById('restore-usb-tag-matching') as HTMLInputElement | null;
const rewriteXmlInput = document.getElementById('restore-rewrite-xml') as HTMLInputElement | null;

const stepBackup = document.getElementById('restore-step-backup');
const stepSources = document.getElementById('restore-step-sources');

const toReviewBtn = document.getElementById('restore-to-review') as HTMLButtonElement | null;
const backToConfigureBtn = document.getElementById('restore-back-to-configure') as HTMLButtonElement | null;
const startBtn = document.getElementById('restore-start') as HTMLButtonElement | null;
const abortBtn = document.getElementById('restore-abort') as HTMLButtonElement | null;
const newRunBtn = document.getElementById('restore-new-run') as HTMLButtonElement | null;

// Running stage
const timelineEl = document.getElementById('restore-timeline') as HTMLElement | null;
const kpiRecovered = document.getElementById('kpi-recovered');
const kpiStillMissing = document.getElementById('kpi-still-missing');
const kpiEta = document.getElementById('kpi-eta');
const kpiElapsed = document.getElementById('kpi-elapsed');
const progressBarEl = document.getElementById('restore-progress-bar') as HTMLDivElement | null;
const phaseCurrentEl = document.getElementById('restore-phase-current');
const runLineEl = document.getElementById('restore-run-line');
const currentTrackEl = document.getElementById('restore-current-track');
const accountsEl = document.getElementById('restore-accounts') as HTMLDivElement | null;
const logEl = document.getElementById('restore-log') as HTMLDivElement | null;
const logCountEl = document.getElementById('restore-log-count');

// Review stage
const reviewLeadEl = document.getElementById('review-lead');
const reviewLeadSubEl = document.getElementById('review-lead-sub');
const reviewStatsEl = document.getElementById('restore-review-hero');
const reviewPlanEl = document.getElementById('review-plan') as HTMLOListElement | null;
const reviewWarningsCard = document.getElementById('review-warnings-card');
const reviewWarningsEl = document.getElementById('review-warnings');

// Report stage
const reportHeadline = document.getElementById('restore-report-headline');
const reportHero = document.getElementById('restore-report-hero');
const reportBySourceEl = document.getElementById('report-by-source');
const reportByAccountEl = document.getElementById('report-by-account');
const reportSourcesHint = document.getElementById('report-sources-hint');
const reportFailuresEl = document.getElementById('report-failures');
const reportFailureCard = document.getElementById('report-failure-card');
const reportXmlEl = document.getElementById('report-xml');
const reportXmlCard = document.getElementById('report-xml-card');
const reportTable = document.getElementById('restore-report-table') as HTMLTableElement | null;
const reportTracksHint = document.getElementById('report-tracks-hint');
const reportEmpty = document.getElementById('restore-report-empty');
const reportExportBtn = document.getElementById('report-export') as HTMLButtonElement | null;
const reportOpenStageBtn = document.getElementById('report-open-stage') as HTMLButtonElement | null;
const reportRetryBtn = document.getElementById('report-retry-failed') as HTMLButtonElement | null;

// Source status (pill + Sign in) on the Configure stage
const statusEls: Record<'usb' | Store, HTMLElement | null> = {
  usb: document.getElementById('restore-status-usb'),
  beatport: document.getElementById('restore-status-beatport'),
  qobuz: document.getElementById('restore-status-qobuz'),
};

// ========== State ==========

let detectedVolumes: Volume[] = [];
let volumesChecked = false;
let currentStage: Stage = 'configure';
let running = false;
let currentReport: Report | null = null;
let currentReportPath: string | null = null;
let reportFilter: 'all' | 'recovered' | 'still_missing' = 'all';
let logEntries: LogEntry[] = [];
const MAX_LOG_ENTRIES = 500;
/** Account names seen during the run, so the results can say "Qobuz · ben@…" instead of an id. */
const accountNames = new Map<string, string>();

// Cached live progress state used by the renderer-local ticker between real
// backend events so the counts and time keep ticking even when the main
// process is busy doing something that doesn't emit for several seconds
// (e.g. sniffing play.qobuz.com credentials, walking the library).
type LiveState = {
  startWallTime: number;          // when running started, in ms (Date.now())
  latestElapsedSec: number;       // most recent elapsed reported by main
  latestRate: number | undefined; // most recent rate reported by main
  totals: Totals;
  phaseStatus: Map<string, 'active' | 'done' | 'skipped'>;
  activePhase: string;
};
let live: LiveState | null = null;
let liveTicker: ReturnType<typeof setInterval> | null = null;

// Rough weights used for phase-aware progress. Numbers add to 100. They reflect
// typical time share — not perfect, but far better than "0% until the first
// download lands".
const PHASE_WEIGHTS: Record<string, number> = {
  parsing: 2,
  scanning_library: 8,
  computing_missing: 3,
  usb_scan: 22,
  beatport_fetch: 6,
  beatport_download: 14,
  qobuz_fetch: 10,
  qobuz_download: 28,
  xml_rewrite: 5,
  complete: 2,
};
const PHASE_ORDER = [
  'parsing', 'scanning_library', 'computing_missing',
  'usb_scan', 'beatport_fetch', 'beatport_download',
  'qobuz_fetch', 'qobuz_download', 'xml_rewrite', 'complete',
];

/** What Track Lab is doing right now, as the running headline. */
const PHASE_HEADLINE: Record<string, string> = {
  init: 'Getting started…',
  parsing: 'Reading your backup file…',
  scanning_library: 'Checking your library folder…',
  computing_missing: 'Working out what\'s missing…',
  usb_scan: 'Looking on your USB sticks…',
  beatport_fetch: 'Checking your Beatport purchases…',
  beatport_download: 'Downloading from Beatport…',
  qobuz_fetch: 'Checking your Qobuz purchases…',
  qobuz_download: 'Downloading from Qobuz…',
  xml_rewrite: 'Updating your backup file…',
  complete: 'Finishing up…',
};

/** Short names for the activity log. */
const PHASE_SHORT: Record<string, string> = {
  init: 'Start',
  parsing: 'Backup file',
  scanning_library: 'Library',
  computing_missing: 'What\'s missing',
  usb_scan: 'USB sticks',
  beatport_fetch: 'Beatport',
  beatport_download: 'Beatport',
  qobuz_fetch: 'Qobuz',
  qobuz_download: 'Qobuz',
  xml_rewrite: 'Backup file',
  complete: 'Done',
};

const SOURCE_NAME: Record<string, string> = {
  usb: 'USB stick',
  beatport: 'Beatport',
  qobuz: 'Qobuz',
  soundcloud: 'SoundCloud',
};

const STORE_NAME: Record<Store, string> = { beatport: 'Beatport', qobuz: 'Qobuz' };

// Account status cache populated on Configure / Review entry.
type AccountStatus = Record<Store, { connected: number; total: number }>;
let accountStatus: AccountStatus = { qobuz: { connected: 0, total: 0 }, beatport: { connected: 0, total: 0 } };
let accountsChecked = false;

// ========== Icons ==========

const svg = (body: string) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const WARN_BODY = '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>';
const CHECK_CIRCLE_BODY = '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>';
const SEARCH_BODY = '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>';

// ========== Small helpers ==========

const isAre = (n: number) => (n === 1 ? 'is' : 'are');

/** "about 6 minutes", "less than a minute", "1 hour 20 minutes". */
function humanDuration(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return 'less than a minute';
  const m = Math.round(s / 60);
  if (m < 60) return plural(m, 'minute');
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? plural(h, 'hour') : `${plural(h, 'hour')} ${plural(mm, 'minute')}`;
}

/** Clock-style time for the "Time so far" tile: 0:42, 12:05, 1:02:09. */
function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

function baseName(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

function callout(tone: 'warn' | 'info' | 'danger', title: string, body: string): string {
  return `<div class="callout callout--${tone}" role="status">${svg(tone === 'info' ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>' : WARN_BODY).replace('<svg', '<svg class="callout-icon"')}<div class="callout-body"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p></div></div>`;
}

// ========== Stage switching ==========

function setStage(next: Stage) {
  currentStage = next;
  // Scoped: Splice Recovery uses the same .wiz-stage sections.
  document.querySelectorAll<HTMLElement>('#page-restore .wiz-stage').forEach(el => {
    const active = el.dataset.stage === next;
    el.classList.toggle('is-active', active);
    el.style.display = active ? '' : 'none';
  });
  if (stepper) {
    stepper.querySelectorAll<HTMLButtonElement>('.wiz-step').forEach(btn => {
      const isCurrent = btn.dataset.step === next;
      btn.classList.toggle('is-active', isCurrent);
      btn.classList.toggle('is-done', stageOrder(btn.dataset.step as Stage) < stageOrder(next));
      if (isCurrent) btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current');
    });
  }
  // The scroller is the shared content column; start each stage at the top.
  if (document.getElementById('page-restore')?.classList.contains('active')) document.querySelector('.content')?.scrollTo({ top: 0 });
}

function stageOrder(s: Stage): number {
  return { configure: 0, review: 1, running: 2, report: 3 }[s];
}

// ========== Configure stage: a guided, one-question-at-a-time flow ==========

async function pickXml() {
  const res = await window.candybar.restorePickXml();
  if (res.success && res.path && xmlInput) xmlInput.value = res.path;
  updateReviewButton();
}

// Step 1 answers itself once a backup is chosen; step 2 unlocks.
function updateReviewButton() {
  const xml = xmlInput?.value.trim() || '';
  const hasXml = !!xml;
  if (toReviewBtn) toReviewBtn.disabled = !hasXml;
  const hint = document.getElementById('restore-xml-hint');
  if (hint) hint.style.display = hasXml ? 'none' : '';
  if (pickXmlBtn) pickXmlBtn.textContent = hasXml ? 'Choose another…' : 'Choose file…';
  const backupDesc = document.getElementById('restore-step-backup-desc');
  if (backupDesc) {
    backupDesc.textContent = hasXml
      ? `Using ${baseName(xml)}. Track Lab reads it to see which tracks your library should have.`
      : 'Track Lab reads it to see which tracks your library should have.';
  }
  stepBackup?.classList.toggle('is-done', hasXml);
  stepBackup?.classList.toggle('is-current', !hasXml);
  stepSources?.classList.toggle('is-locked', !hasXml);
  stepSources?.classList.toggle('is-current', hasXml);
  const sourcesDesc = document.getElementById('restore-step-sources-desc');
  if (sourcesDesc) {
    sourcesDesc.textContent = hasXml
      ? 'Track Lab has ticked the places it can use right now. It tries them in this order.'
      : 'Choose your backup first.';
  }
}

async function pickLibraryRoot() {
  const chosen = await window.candybar.selectPath('dir');
  if (chosen && libRootInput) libRootInput.value = chosen;
}

// Sources the person ticked or unticked themselves keep their choice; the rest
// follow what's plugged in and signed in.
const userTouched = new Set<'usb' | Store>();

async function refreshVolumes() {
  if (!volumesEl) return;
  volumesEl.innerHTML = '<p class="restore-volumes-note">Looking for USB sticks…</p>';
  const res = await window.candybar.restoreListVolumes();
  volumesChecked = true;
  if (!res.success || !res.volumes) {
    detectedVolumes = [];
    volumesEl.innerHTML = `<p class="restore-volumes-note is-error">Track Lab couldn't look for USB sticks. Press Look again.</p>`;
    if (res.error) volumesEl.title = res.error;
    updateSourceStatuses();
    return;
  }
  // A stick the person unticked stays unticked across a Look again.
  const unticked = new Set(Array.from(volumesEl.querySelectorAll<HTMLInputElement>('input.restore-volume-check:not(:checked)')).map(el => el.value));
  detectedVolumes = res.volumes;
  if (detectedVolumes.length === 0) {
    volumesEl.innerHTML = '<p class="restore-volumes-note">No USB sticks plugged in. Plug them in, then press Look again.</p>';
  } else {
    volumesEl.innerHTML = detectedVolumes.map(v =>
      `<label class="restore-volume" title="${escapeHtml(v.scanRoot)}"><input type="checkbox" class="restore-volume-check" value="${escapeHtml(v.name)}"${unticked.has(v.name) ? '' : ' checked'}><span>${escapeHtml(v.name)}</span></label>`,
    ).join('');
  }
  if (srcUsb && !userTouched.has('usb')) srcUsb.checked = detectedVolumes.length > 0;
  updateSourceStatuses();
}

function selectedVolumeNames(): string[] {
  if (!volumesEl) return [];
  return Array.from(volumesEl.querySelectorAll('input.restore-volume-check:checked'))
    .map(el => (el as HTMLInputElement).value);
}

async function refreshAccountStatuses() {
  try {
    const s = await window.candybar.storeLoginStatus();
    const q = Object.values(s.qobuzAccounts);
    const b = Object.values(s.beatportAccounts);
    accountStatus = {
      qobuz: { connected: q.filter(Boolean).length, total: q.length },
      beatport: { connected: b.filter(Boolean).length, total: b.length },
    };
  } catch {
    accountStatus = { qobuz: { connected: 0, total: 0 }, beatport: { connected: 0, total: 0 } };
  }
  accountsChecked = true;
  updateSourceStatuses();
}

function pill(tone: 'ok' | 'warn' | 'danger' | 'info' | '', text: string): string {
  return `<span class="status-pill${tone ? ` status-pill--${tone}` : ''}">${escapeHtml(text)}</span>`;
}

function updateSourceStatuses() {
  if (statusEls.usb) {
    const n = detectedVolumes.length;
    statusEls.usb.innerHTML = !volumesChecked
      ? pill('', 'Looking…')
      : n === 0 ? pill('warn', 'None plugged in') : pill('ok', `${plural(n, 'stick')} found`);
  }
  document.querySelector('.restore-source[data-source="usb"]')?.classList.toggle('is-off', !srcUsb?.checked);
  updateStoreSource('beatport', srcBeatport);
  updateStoreSource('qobuz', srcQobuz);
  // SoundCloud isn't part of a restore yet; its row says so.
}

// Stores this page switched off because no account was signed in. They come
// back on once one connects, so a choice the user made themselves is kept.
const autoDisabledStores = new Set<Store>();

function updateStoreSource(service: Store, input: HTMLInputElement | null) {
  const statusEl = statusEls[service];
  const { connected, total } = accountStatus[service];
  if (input && accountsChecked) {
    if (connected === 0) {
      if (!input.disabled && input.checked) autoDisabledStores.add(service);
      input.checked = false;
      input.disabled = true;
    } else if (input.disabled) {
      input.disabled = false;
      if (autoDisabledStores.delete(service) || !userTouched.has(service)) input.checked = true;
    }
  }
  document.querySelector(`.restore-source[data-source="${service}"]`)?.classList.toggle('is-off', !input?.checked);
  if (!statusEl) return;
  if (!accountsChecked) { statusEl.innerHTML = pill('', 'Checking…'); return; }
  const signIn = (label: string) =>
    `<button type="button" class="btn-secondary btn-sm wiz-source-link" data-settings-section="${service}" data-tooltip="Open Settings to ${label === 'Add account' ? 'add' : 'sign in to'} your ${STORE_NAME[service]} account">${label}</button>`;
  if (connected === 0) {
    statusEl.innerHTML = total === 0
      ? `${pill('', 'No account added')}${signIn('Add account')}`
      : `${pill('warn', 'Not signed in')}${signIn('Sign in')}`;
  } else if (connected < total) {
    statusEl.innerHTML = `${pill('warn', `${connected} of ${total} signed in`)}${signIn('Sign in')}`;
  } else {
    statusEl.innerHTML = pill('ok', total === 1 ? 'Signed in' : `${total} accounts signed in`);
  }
}

// ========== Review stage ==========

async function goToReview() {
  const xmlPath = xmlInput?.value.trim() || '';
  if (!xmlPath) { showToast('error', 'Choose your backup file', 'Pick the Rekordbox backup file (.xml) first.'); return; }

  let libraryRoot = libRootInput?.value.trim() || '';
  if (!libraryRoot) {
    try { libraryRoot = await window.candybar.getLibraryRoot(); } catch { /* shown as "your library folder" */ }
  }
  renderPlan(xmlPath, libraryRoot);
  renderWarnings();
  renderLastRunNotes();
  setStage('review');
}

/** What the last run (same backup) learned that this one will hit again:
 *  store accounts it couldn't check, and the deleted tracks it leaves out. */
function renderLastRunNotes() {
  const xmlPath = xmlInput?.value.trim() || '';
  const last = currentReport && currentReport.options.xmlPath === xmlPath ? currentReport : null;
  const errors = last?.storeErrors ?? [];
  const hint = 'Last time these couldn\'t be read, so tracks bought there may come up missing. Sign in again in Settings first.';
  renderStoreErrors(document.getElementById('restore-store-errors'), errors, hint);
  renderStoreErrors(document.getElementById('review-store-errors'), errors, hint);

  const note = document.getElementById('review-deleted-note');
  if (note) {
    const n = last ? deletedCount(last) : 0;
    note.hidden = n === 0;
    note.textContent = n > 0
      ? `${plural(n, 'track')} you deleted will be left out again. They aren't counted as missing.`
      : '';
  }
}

function placesToLook(): string[] {
  const places: string[] = [];
  if (srcUsb?.checked && selectedVolumeNames().length > 0) places.push('usb');
  if (srcBeatport?.checked) places.push('beatport');
  if (srcQobuz?.checked) places.push('qobuz');
  return places;
}

function renderPlan(xmlPath: string, libraryRoot: string) {
  const places = placesToLook();
  const vols = selectedVolumeNames();
  const signedIn = (s: Store) => accountStatus[s].connected;

  if (reviewLeadEl) {
    reviewLeadEl.textContent = places.length === 0
      ? 'Track Lab has nowhere to look yet'
      : `Track Lab will look for your missing tracks in ${plural(places.length, 'place')}`;
  }
  if (reviewLeadSubEl) {
    reviewLeadSubEl.textContent = places.length === 0
      ? 'Go back and plug in a USB stick, or sign in to Beatport or Qobuz. Track Lab can still tell you what\'s missing.'
      : 'It compares your backup with your library first, so only the tracks you\'ve lost are recovered.';
  }
  if (reviewStatsEl) {
    const tiles: string[] = [];
    tiles.push(`<div class="stat-tile${vols.length && srcUsb?.checked ? ' stat-tile--accent' : ''}"><span class="stat-value">${srcUsb?.checked ? vols.length : 0}</span><span class="stat-label">${srcUsb?.checked && vols.length === 1 ? 'USB stick' : 'USB sticks'}</span><span class="stat-hint">${srcUsb?.checked ? (vols.length ? escapeHtml(vols.slice(0, 2).join(', ') + (vols.length > 2 ? '…' : '')) : 'None plugged in') : 'Not looking here'}</span></div>`);
    for (const s of ['beatport', 'qobuz'] as const) {
      const on = s === 'beatport' ? srcBeatport?.checked : srcQobuz?.checked;
      const n = on ? signedIn(s) : 0;
      tiles.push(`<div class="stat-tile${n ? ' stat-tile--accent' : ''}"><span class="stat-value">${n}</span><span class="stat-label">${STORE_NAME[s]} ${n === 1 ? 'account' : 'accounts'}</span><span class="stat-hint">${on ? 'Signed in' : 'Not looking here'}</span></div>`);
    }
    reviewStatsEl.innerHTML = tiles.join('');
  }

  if (!reviewPlanEl) return;
  const steps: Array<{ title: string; detail?: string }> = [];
  steps.push({ title: 'Read your backup file', detail: baseName(xmlPath) });
  steps.push({ title: 'Check your library folder for the tracks you still have', detail: libraryRoot || 'The library folder from Settings' });
  if (srcUsb?.checked) {
    steps.push(vols.length
      ? { title: `Look on your USB ${vols.length === 1 ? 'stick' : 'sticks'}`, detail: `${vols.join(', ')}${usbTagMatchingInput?.checked ? '. Also matching by artist and title (slower).' : ''}` }
      : { title: 'Look on your USB sticks', detail: 'None are plugged in, so Track Lab skips this.' });
  }
  for (const s of ['beatport', 'qobuz'] as const) {
    const on = s === 'beatport' ? srcBeatport?.checked : srcQobuz?.checked;
    if (!on) continue;
    const { connected, total } = accountStatus[s];
    steps.push({
      title: `Download what you've bought on ${STORE_NAME[s]} again`,
      detail: connected === total ? `${plural(total, 'account')}, all signed in.` : `${connected} of ${plural(total, 'account')} signed in.`,
    });
  }
  if (rewriteXmlInput?.checked) {
    steps.push({ title: 'Update your backup file to point at the recovered tracks', detail: 'A copy of the original file is saved first.' });
  }
  steps.push({ title: 'Save everything it finds in restore_recovered', detail: 'A new folder inside tracks_to_organize. Your library isn\'t touched.' });

  reviewPlanEl.innerHTML = steps.map((st, i) => `
    <li><span class="how-step-num">${i + 1}</span><div><strong>${escapeHtml(st.title)}</strong>${st.detail ? `<span>${escapeHtml(st.detail)}</span>` : ''}</div></li>`,
  ).join('');
}

function renderWarnings() {
  if (!reviewWarningsEl || !reviewWarningsCard) return;
  const warnings: Array<{ title: string; body: string }> = [];
  for (const s of ['qobuz', 'beatport'] as const) {
    const on = s === 'qobuz' ? srcQobuz?.checked : srcBeatport?.checked;
    const { connected, total } = accountStatus[s];
    if (on && total === 0) {
      warnings.push({ title: `No ${STORE_NAME[s]} account added`, body: `Add one in Settings, or Track Lab can't check what you bought there.` });
    } else if (on && connected < total) {
      const n = total - connected;
      warnings.push({
        title: `${plural(n, `${STORE_NAME[s]} account`)} ${n === 1 ? 'isn\'t' : 'aren\'t'} signed in`,
        body: `A sign-in window opens for ${n === 1 ? 'it' : 'them'} during the restore. Sign in there, or in Settings now, so nothing is missed.`,
      });
    }
  }
  if (srcUsb?.checked && detectedVolumes.length === 0) {
    warnings.push({ title: 'No USB sticks plugged in', body: 'Plug in any sticks you\'ve exported to before, then go back and press Look again.' });
  }
  if (warnings.length === 0) {
    reviewWarningsCard.style.display = 'none';
    reviewWarningsEl.innerHTML = '';
    return;
  }
  reviewWarningsCard.style.display = '';
  reviewWarningsEl.innerHTML = warnings.map(w => callout('warn', w.title, w.body)).join('');
}

// ========== Running stage ==========

function setPhaseState(li: HTMLElement, state: 'active' | 'done' | 'skipped' | null) {
  li.classList.toggle('is-active', state === 'active');
  li.classList.toggle('is-done', state === 'done');
  li.classList.toggle('is-skipped', state === 'skipped');
  const word = li.querySelector('.wiz-phase-state');
  if (word) word.textContent = state === 'active' ? 'Now' : state === 'done' ? 'Done' : state === 'skipped' ? 'Skipped' : '';
}

function resetRunState() {
  logEntries = [];
  if (logEl) logEl.innerHTML = '';
  if (logCountEl) logCountEl.textContent = 'Nothing yet';
  if (accountsEl) accountsEl.innerHTML = '<p class="card-desc">Your Beatport and Qobuz accounts show up here when Track Lab gets to them.</p>';
  if (progressBarEl) {
    progressBarEl.style.width = '0%';
    progressBarEl.classList.remove('is-indeterminate');
  }
  if (kpiRecovered) kpiRecovered.textContent = '0';
  if (kpiStillMissing) kpiStillMissing.textContent = '—';
  if (kpiEta) kpiEta.textContent = 'Since you pressed Start';
  if (kpiElapsed) kpiElapsed.textContent = '0:00';
  if (phaseCurrentEl) phaseCurrentEl.textContent = PHASE_HEADLINE.init;
  if (runLineEl) runLineEl.textContent = 'Track Lab is working out which tracks are missing.';
  if (currentTrackEl) currentTrackEl.textContent = '';
  if (timelineEl) {
    timelineEl.querySelectorAll<HTMLElement>('.wiz-phase').forEach(li => setPhaseState(li, null));
  }
  const logDisclosure = document.getElementById('restore-log-disclosure') as HTMLDetailsElement | null;
  if (logDisclosure) logDisclosure.open = false;

  live = {
    startWallTime: Date.now(),
    latestElapsedSec: 0,
    latestRate: undefined,
    totals: { totalXmlTracks: 0, alreadyInLibrary: 0, missing: 0, recovered: 0, stillMissing: 0 },
    phaseStatus: new Map(),
    activePhase: 'parsing',
  };
  if (liveTicker) clearInterval(liveTicker);
  // 500ms ticker: refresh time, time left and the phase-weighted progress bar
  // even when the main process is silent between events.
  liveTicker = setInterval(tickLive, 500);
}

function stopLiveTicker() {
  if (liveTicker) { clearInterval(liveTicker); liveTicker = null; }
}

function missingKnown(): boolean {
  if (!live) return false;
  const st = live.phaseStatus.get('computing_missing');
  return st === 'done' || st === 'skipped' || live.totals.missing > 0;
}

function tickLive() {
  if (!live) return;
  // Elapsed: count from the renderer's start wall-clock when main hasn't
  // spoken recently, but prefer main's authoritative elapsed when available.
  const wallElapsed = (Date.now() - live.startWallTime) / 1000;
  const elapsed = Math.max(wallElapsed, live.latestElapsedSec);
  if (kpiElapsed) kpiElapsed.textContent = clock(elapsed);

  // Time left: only once main has reported a rate, since tracks per minute
  // needs recovery data we can't derive locally.
  let left = '';
  if (live.latestRate && live.latestRate > 0 && live.totals.stillMissing > 0) {
    left = `about ${humanDuration(live.totals.stillMissing / live.latestRate)} left`;
  }

  if (runLineEl) {
    const t = live.totals;
    if (!missingKnown()) {
      runLineEl.textContent = 'Track Lab is working out which tracks are missing.';
    } else if (t.missing === 0) {
      runLineEl.textContent = 'Nothing is missing from your library.';
    } else {
      runLineEl.textContent = `${t.recovered.toLocaleString()} of ${plural(t.missing, 'missing track')} recovered${left ? ` · ${left}` : ''}`;
    }
  }

  // Phase-weighted overall progress: completed phases contribute full weight,
  // the active phase contributes part of its weight, more as tracks come back.
  if (progressBarEl) {
    const totalWeight = Object.values(PHASE_WEIGHTS).reduce((a, b) => a + b, 0);
    let score = 0;
    for (const phase of PHASE_ORDER) {
      const status = live.phaseStatus.get(phase);
      const weight = PHASE_WEIGHTS[phase] ?? 0;
      if (status === 'done' || status === 'skipped') {
        score += weight;
      } else if (status === 'active') {
        let frac = 0.35; // baseline for "phase started, no track-level progress yet"
        if ((phase === 'usb_scan' || phase === 'beatport_download' || phase === 'qobuz_download')
            && live.totals.missing > 0) {
          frac = 0.2 + 0.6 * (live.totals.recovered / live.totals.missing);
        }
        score += weight * Math.min(1, frac);
      }
    }
    const pct = Math.min(100, Math.max(0, (score / totalWeight) * 100));
    progressBarEl.style.width = pct.toFixed(1) + '%';

    // Stripe while a phase is busy without countable progress (reading, fetching).
    const isFetchy = live.activePhase === 'parsing' || live.activePhase === 'scanning_library' ||
      live.activePhase === 'computing_missing' || live.activePhase === 'beatport_fetch' ||
      live.activePhase === 'qobuz_fetch' || live.activePhase === 'xml_rewrite';
    progressBarEl.classList.toggle('is-indeterminate', isFetchy);
  }
}

function onProgress(p: Progress) {
  if (!live) return; // called after run ended

  // Track phase lifecycle for weighted progress
  if (p.phaseStatus === 'start') {
    // Any previously-active phase transitions to done (monotonic pipeline).
    for (const [ph, st] of live.phaseStatus) {
      if (st === 'active') live.phaseStatus.set(ph, 'done');
    }
    live.phaseStatus.set(p.phase, 'active');
    live.activePhase = p.phase;
  } else if (p.phaseStatus === 'end') {
    live.phaseStatus.set(p.phase, 'done');
  } else if (p.phaseStatus === 'skipped') {
    live.phaseStatus.set(p.phase, 'skipped');
  } else {
    live.activePhase = p.phase;
  }

  // Steps checklist
  if (timelineEl) {
    const li = timelineEl.querySelector<HTMLElement>(`.wiz-phase[data-phase="${CSS.escape(p.phase)}"]`);
    if (li) {
      if (p.phaseStatus === 'start') {
        timelineEl.querySelectorAll<HTMLElement>('.wiz-phase.is-active').forEach(el => {
          if (el !== li) setPhaseState(el, 'done');
        });
        setPhaseState(li, 'active');
      } else if (p.phaseStatus === 'end') {
        setPhaseState(li, 'done');
      } else if (p.phaseStatus === 'skipped') {
        setPhaseState(li, 'skipped');
      }
    }
  }

  // Authoritative totals / rate from main
  live.totals = p.totals;
  live.latestElapsedSec = p.elapsedSec;
  if (p.rate) live.latestRate = p.rate;

  if (kpiRecovered) kpiRecovered.textContent = p.totals.recovered.toLocaleString();
  if (kpiStillMissing) kpiStillMissing.textContent = missingKnown() ? p.totals.stillMissing.toLocaleString() : '—';
  if (phaseCurrentEl) phaseCurrentEl.textContent = PHASE_HEADLINE[live.activePhase] ?? PHASE_HEADLINE.init;
  if (currentTrackEl) currentTrackEl.textContent = p.currentTrack ? `Now: ${p.currentTrack}` : '';
  if (p.perAccount && p.perAccount.length > 0) renderAccounts(p.perAccount);
  if (p.log) appendLog(p.log);

  // Immediate re-tick so the progress bar doesn't lag a beat behind the event
  tickLive();
}

function accountName(r: PerAccountCounter): string {
  return r.label || r.email || `Account ${r.accountId.slice(0, 6)}`;
}

function renderAccounts(rows: PerAccountCounter[]) {
  if (!accountsEl) return;
  for (const r of rows) accountNames.set(r.accountId, accountName(r));
  accountsEl.innerHTML = rows.map(r => {
    const owned = r.ownedCount ?? 0;
    const matched = r.matchedCount ?? 0;
    const downloaded = r.downloadedCount ?? 0;
    const failed = r.failedCount ?? 0;
    return `
      <div class="wiz-account">
        <div class="wiz-account-head">
          <strong class="wiz-account-name" title="${escapeHtml(r.email || r.accountId)}">${escapeHtml(accountName(r))}</strong>
          <span class="status-pill">${escapeHtml(STORE_NAME[r.service] ?? r.service)}</span>
        </div>
        <div class="wiz-account-stats">
          <span><b>${owned.toLocaleString()}</b> bought</span>
          <span><b>${matched.toLocaleString()}</b> missing tracks found</span>
          <span class="wiz-ok"><b>${downloaded.toLocaleString()}</b> downloaded</span>
          ${failed ? `<span class="wiz-bad"><b>${failed.toLocaleString()}</b> couldn't download</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

function appendLog(entry: LogEntry) {
  logEntries.push(entry);
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
  if (!logEl) return;
  const line = document.createElement('div');
  line.className = `wiz-log-line wiz-log-${entry.level}`;
  const t = new Date(entry.timestamp);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  line.innerHTML = `<span class="wiz-log-time">${hh}:${mm}:${ss}</span><span class="wiz-log-phase">${escapeHtml(PHASE_SHORT[entry.phase] ?? entry.phase)}</span><span class="wiz-log-msg">${escapeHtml(entry.message)}</span>`;
  logEl.appendChild(line);
  // Cap DOM to last N lines
  while (logEl.childElementCount > MAX_LOG_ENTRIES) logEl.removeChild(logEl.firstChild!);
  logEl.scrollTop = logEl.scrollHeight;
  if (logCountEl) logCountEl.textContent = plural(logEntries.length, 'line');
}

// ========== Run ==========

async function startRestore() {
  if (running) return;
  const xmlPath = xmlInput?.value.trim() || '';
  if (!xmlPath) { showToast('error', 'Choose your backup file', 'Pick the Rekordbox backup file (.xml) first.'); return; }

  running = true;
  if (startBtn) startBtn.disabled = true;
  // A previous run's Stop leaves the button disabled.
  if (abortBtn) { abortBtn.disabled = false; abortBtn.textContent = 'Stop'; }
  accountNames.clear();
  resetRunState();
  setStage('running');

  const offProgress = window.candybar.onRestoreProgress(onProgress);

  try {
    const res = await window.candybar.restoreRun({
      xmlPath,
      libraryRoot: libRootInput?.value.trim() || '',
      stageDir: '',
      sources: {
        usb: !!srcUsb?.checked,
        beatport: !!srcBeatport?.checked,
        qobuz: !!srcQobuz?.checked,
        soundcloud: !!srcSoundcloud?.checked,
      },
      concurrency: parseInt(concurrencyInput?.value || '5', 10) || 5,
      usbVolumesAllowlist: selectedVolumeNames(),
      usbTagMatching: !!usbTagMatchingInput?.checked,
      rewriteXml: !!rewriteXmlInput?.checked,
    });
    if (!res.success) {
      // Back to the plan either way, so the page never strands on a dead run.
      if (res.aborted) {
        showToast('info', 'Restore stopped', 'Tracks recovered before you stopped are in the restore_recovered folder.');
      } else {
        showToast('error', 'The restore didn\'t finish', res.error || 'Something went wrong. Check your backup file and drives, then try again.');
      }
      setStage('review');
    } else {
      currentReport = res.report as Report;
      currentReportPath = res.reportPath ?? null;
      const t = currentReport.totals;
      showToast('success', 'Restore finished', t.missing === 0
        ? 'Nothing was missing from your library.'
        : `Track Lab got back ${t.recovered.toLocaleString()} of ${plural(t.missing, 'missing track')}.`);
      renderReport(currentReport);
      setStage('report');
    }
  } catch (err) {
    showToast('error', 'The restore didn\'t finish', getErrorMessage(err));
    setStage('review');
  } finally {
    offProgress?.();
    stopLiveTicker();
    live = null;
    running = false;
    if (startBtn) startBtn.disabled = false;
  }
}

// ========== Report stage ==========

const FAILURE: Record<string, { label: string; next: string }> = {
  no_match: {
    label: 'Not found anywhere Track Lab looked',
    next: 'Plug in any other USB sticks you have and run again, or buy the track again from Find and buy.',
  },
  login: {
    label: 'A store sign-in didn\'t work, so some purchases couldn\'t be checked',
    next: 'Sign in again in Settings, then run again.',
  },
  download: {
    label: 'Found, but the download didn\'t finish',
    next: 'Run again. Downloads that fail once often work the second time.',
  },
  copy: {
    label: 'Found on a USB stick, but copying it failed',
    next: 'Check the stick is still plugged in and has no errors, then run again.',
  },
  rewrite: {
    label: 'Couldn\'t update the backup file for these',
    next: 'The tracks themselves may still be in restore_recovered. Check the full details in the track list.',
  },
  other: {
    label: 'Some places couldn\'t be checked',
    next: 'Sign in to every store account in Settings, then run again.',
  },
};

function failureLabel(c: string): string {
  return FAILURE[c]?.label ?? c;
}

function renderReport(report: Report) {
  const t = report.totals;
  const deleted = deletedCount(report);
  const took = report.durationSec ? ` It took ${humanDuration(report.durationSec)}.` : '';

  let tone: 'ok' | 'warn' = 'ok';
  let headline: string;
  let sentence: string;
  if (t.missing === 0) {
    headline = 'Nothing was missing';
    sentence = `Your library already has every track in this backup${deleted ? ', apart from the ones you deleted' : ''}.${took}`;
  } else if (t.recovered === t.missing) {
    headline = 'All done! Every missing track is back';
    sentence = `Track Lab recovered ${plural(t.recovered, 'track')} into the restore_recovered folder.${took}`;
  } else if (t.recovered === 0) {
    tone = 'warn';
    headline = `Track Lab couldn't find any of the ${plural(t.missing, 'missing track')}`;
    sentence = `Still missing, below, says what got in the way and what to try next.${took}`;
  } else {
    headline = `Track Lab got back ${t.recovered.toLocaleString()} of ${plural(t.missing, 'missing track')}`;
    sentence = `They're in the restore_recovered folder. ${plural(t.stillMissing, 'track')} ${isAre(t.stillMissing)} still missing; see why below.${took}`;
  }

  if (reportHeadline) {
    reportHeadline.innerHTML = `
      <span class="restore-verdict-icon is-${tone}">${svg(tone === 'ok' ? CHECK_CIRCLE_BODY : SEARCH_BODY)}</span>
      <div>
        <h3 class="restore-lead">${escapeHtml(headline)}</h3>
        <p class="restore-lead-sub">${escapeHtml(sentence)}</p>
      </div>`;
  }
  if (reportHero) {
    reportHero.innerHTML = `
      <div class="stat-tile stat-tile--ok"><span class="stat-value">${t.recovered.toLocaleString()}</span><span class="stat-label">Recovered</span><span class="stat-hint">In restore_recovered</span></div>
      <div class="stat-tile${t.stillMissing ? ' stat-tile--warn' : ''}"><span class="stat-value">${t.stillMissing.toLocaleString()}</span><span class="stat-label">Still missing</span><span class="stat-hint">${t.stillMissing ? 'See why below' : 'None'}</span></div>
      <div class="stat-tile"><span class="stat-value">${t.alreadyInLibrary.toLocaleString()}</span><span class="stat-label">Already in your library</span><span class="stat-hint">Left as they are</span></div>
      ${deleted > 0 ? `<div class="stat-tile restore-stat-quiet"><span class="stat-value">${deleted.toLocaleString()}</span><span class="stat-label">Left out</span><span class="stat-hint">You deleted these</span></div>` : ''}`;
  }

  renderStoreErrors(document.getElementById('report-store-errors'), report.storeErrors ?? [],
    'Tracks bought there may show as still missing. Sign in again in Settings, then run again.');
  renderDeletedGroup(report.deletedSkipped ?? []);
  renderLastRunNotes(); // the Configure stage's store rows show it too

  const sourceEntries = Object.entries(report.bySource);
  if (reportBySourceEl) {
    reportBySourceEl.innerHTML = sourceEntries.length === 0
      ? '<p class="card-desc">Nothing was recovered.</p>'
      : sourceEntries.map(([src, n]) => `<div class="wiz-breakdown-row"><span class="wiz-breakdown-label">${escapeHtml(src === 'usb' ? 'USB sticks' : SOURCE_NAME[src] ?? src)}</span><span class="wiz-breakdown-value"><b>${n.toLocaleString()}</b></span></div>`).join('');
  }
  if (reportSourcesHint) {
    reportSourcesHint.textContent = sourceEntries.length === 0
      ? 'Nothing recovered'
      : sourceEntries.map(([src, n]) => `${src === 'usb' ? 'USB' : SOURCE_NAME[src] ?? src} ${n.toLocaleString()}`).join(' · ');
  }

  if (reportByAccountEl) {
    // Per-account counts from report.results; names from what the run reported.
    const byAccount = new Map<string, { service: string; count: number; accountId: string }>();
    for (const r of report.results) {
      if (r.status !== 'recovered' || !r.sourceAccountId || !r.source) continue;
      const key = `${r.source}:${r.sourceAccountId}`;
      const existing = byAccount.get(key);
      byAccount.set(key, { service: r.source, count: (existing?.count ?? 0) + 1, accountId: r.sourceAccountId });
    }
    reportByAccountEl.innerHTML = byAccount.size === 0
      ? '<p class="card-desc">Nothing came from a store account.</p>'
      : Array.from(byAccount.values()).map(a =>
        `<div class="wiz-breakdown-row"><span class="wiz-breakdown-label">${escapeHtml(SOURCE_NAME[a.service] ?? a.service)} · ${escapeHtml(accountNames.get(a.accountId) ?? `account ${a.accountId.slice(0, 6)}`)}</span><span class="wiz-breakdown-value"><b>${a.count.toLocaleString()}</b></span></div>`,
      ).join('');
  }

  if (reportFailuresEl && reportFailureCard) {
    const counts: Record<string, number> = {};
    for (const r of report.results) {
      if (r.status === 'still_missing') {
        const cat = r.failureCategory || 'other';
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }
    const entries = Object.entries(counts);
    if (entries.length === 0) {
      reportFailureCard.style.display = 'none';
    } else {
      reportFailureCard.style.display = '';
      reportFailuresEl.innerHTML = entries
        .sort((a, b) => b[1] - a[1])
        .map(([cat, n]) => `
          <div class="restore-why">
            <span class="restore-why-count">${n.toLocaleString()}</span>
            <div class="restore-why-body">
              <strong>${escapeHtml(failureLabel(cat))}</strong>
              <p><span class="restore-why-next">Try this:</span> ${escapeHtml(FAILURE[cat]?.next ?? 'Run again.')}</p>
            </div>
          </div>`)
        .join('');
    }
  }

  if (reportXmlCard && reportXmlEl) {
    if (report.xmlRewrite) {
      reportXmlCard.style.display = '';
      reportXmlEl.innerHTML = `
        <div class="wiz-breakdown-row"><span class="wiz-breakdown-label">Tracks updated in the backup file</span><span class="wiz-breakdown-value"><b>${report.xmlRewrite.updated.toLocaleString()}</b></span></div>
        ${report.xmlRewrite.notFound > 0 ? `<div class="wiz-breakdown-row"><span class="wiz-breakdown-label">Not found in the backup file</span><span class="wiz-breakdown-value"><b>${report.xmlRewrite.notFound.toLocaleString()}</b></span></div>` : ''}
        ${report.xmlRewrite.backupPath ? `<div class="wiz-breakdown-row"><span class="wiz-breakdown-label">Copy of the original</span><span class="wiz-breakdown-value restore-path" title="${escapeHtml(report.xmlRewrite.backupPath)}">${escapeHtml(baseName(report.xmlRewrite.backupPath))}</span></div>` : ''}
      `;
    } else {
      reportXmlCard.style.display = 'none';
    }
  }

  // Filter counts and the track list
  const n = (f: typeof reportFilter) => f === 'all' ? report.results.length : report.results.filter(r => r.status === f).length;
  for (const f of ['all', 'recovered', 'still_missing'] as const) {
    const el = document.getElementById(`report-count-${f}`);
    if (el) el.textContent = n(f).toLocaleString();
  }
  if (reportTracksHint) {
    reportTracksHint.textContent = `${plural(n('recovered'), 'recovered track')} · ${n('still_missing').toLocaleString()} still missing`;
  }
  const tracksDisclosure = document.getElementById('report-tracks-disclosure') as HTMLDetailsElement | null;
  if (tracksDisclosure) tracksDisclosure.open = false;
  drawReportRows(report.results);
}

function deletedCount(report: Report): number {
  return report.totals.deletedSkipped ?? report.deletedSkipped?.length ?? 0;
}

/** Warning callout for store accounts whose purchase history couldn't be read. */
function renderStoreErrors(el: HTMLElement | null, errors: string[], hint: string) {
  if (!el) return;
  if (errors.length === 0) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `
    ${svg(WARN_BODY).replace('<svg', '<svg class="callout-icon"')}
    <div class="callout-body">
      <strong>Track Lab couldn't check ${errors.length === 1 ? 'one store account' : `${errors.length} store accounts`}</strong>
      <p>${escapeHtml(hint)}</p>
      <details class="restore-callout-details"><summary>Show details</summary><ul>${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></details>
    </div>
    <div class="callout-actions"><button type="button" class="btn-secondary btn-sm" data-settings-section="${/qobuz/i.test(errors[0]) ? 'qobuz' : 'beatport'}">Open Settings</button></div>`;
}

/** Quiet, collapsed list of tracks left out because Ben deleted them. */
function renderDeletedGroup(skipped: SkippedTrack[]) {
  const card = document.getElementById('report-deleted-card') as HTMLDetailsElement | null;
  const summary = document.getElementById('report-deleted-summary');
  const list = document.getElementById('report-deleted-list');
  if (!card || !summary || !list) return;
  card.hidden = skipped.length === 0;
  card.open = false;
  summary.textContent = `Left out because you deleted them (${skipped.length.toLocaleString()})`;
  list.innerHTML = skipped.map(t =>
    `<li><b>${escapeHtml(t.artist || 'Unknown artist')}</b> — ${escapeHtml(t.title || 'Untitled')}</li>`,
  ).join('');
}

/** Plain words for where a recovered track came from; the raw detail stays in the tooltip. */
function recoveredDetail(r: TrackResult): string {
  if (r.source === 'usb') {
    const vol = r.detail?.split(': ').pop();
    const close = r.detail?.startsWith('fuzzy');
    return `${close ? 'Close match, copied' : 'Copied'}${vol ? ` from ${vol}` : ' from a USB stick'}`;
  }
  if (r.source === 'beatport' || r.source === 'qobuz') return 'Downloaded again from your purchases';
  return r.detail || '';
}

function drawReportRows(results: TrackResult[]) {
  if (!reportTable) return;
  const body = reportTable.querySelector('tbody') as HTMLTableSectionElement | null;
  if (!body) return;
  const filtered = reportFilter === 'all' ? results : results.filter(r => r.status === reportFilter);
  body.innerHTML = filtered.map(r => {
    const recovered = r.status === 'recovered';
    const result = recovered
      ? '<span class="status-pill status-pill--ok">Recovered</span>'
      : '<span class="status-pill status-pill--warn">Still missing</span>';
    const acct = r.sourceAccountId ? accountNames.get(r.sourceAccountId) : '';
    const found = r.source ? `${SOURCE_NAME[r.source] ?? r.source}${acct ? ` · ${acct}` : ''}` : '—';
    const details = recovered
      ? `<span title="${escapeHtml(r.detail || '')}">${escapeHtml(recoveredDetail(r))}</span>`
      : r.failureCategory
        ? `<span class="restore-reason" title="${escapeHtml(r.detail || '')}">${escapeHtml(failureLabel(r.failureCategory))}</span>${r.detail ? `<span class="restore-detail">${escapeHtml(r.detail)}</span>` : ''}`
        : escapeHtml(r.detail || '');
    return `
      <tr data-status="${escapeHtml(r.status)}">
        <td><b>${escapeHtml(r.track.artist || 'Unknown artist')}</b> — ${escapeHtml(r.track.title || 'Untitled')}</td>
        <td>${result}</td>
        <td class="source" data-source="${r.source || ''}">${escapeHtml(found)}</td>
        <td>${details}</td>
      </tr>
    `;
  }).join('');

  const empty = filtered.length === 0;
  const wrap = reportTable.closest('.table-container') as HTMLElement | null;
  if (wrap) wrap.style.display = empty ? 'none' : '';
  if (reportEmpty) {
    reportEmpty.hidden = !empty;
    reportEmpty.innerHTML = empty
      ? `<h4>${reportFilter === 'still_missing' ? 'Nothing is still missing' : reportFilter === 'recovered' ? 'Nothing was recovered' : 'No tracks to show'}</h4>`
      : '';
  }
}

async function exportReport() {
  // The backend already writes the report file to userData on every run; just
  // reveal it in Finder rather than re-serializing client-side.
  if (!currentReportPath) {
    showToast('info', 'No report file yet', 'Run a restore first.');
    return;
  }
  try {
    await window.candybar.showInFinder(currentReportPath);
  } catch {
    showToast('error', 'Couldn\'t open the report file', currentReportPath);
  }
}

async function openStageFolder() {
  if (!currentReport) return;
  const p = currentReport.options.stageDir;
  if (p) await window.candybar.showInFinder(p).catch(() => {
    showToast('error', 'Couldn\'t open the folder', p);
  });
}

async function runAgain() {
  // The backend can't yet limit a run to the still-missing tracks, so this
  // goes back to the plan for a full re-run with the same settings.
  if (!currentReport) return;
  await goToReview();
}

// ========== Init ==========

export function initRestore() {
  if (!pickXmlBtn || !stepper) return;

  pickXmlBtn.addEventListener('click', () => void pickXml());
  document.getElementById('restore-pick-library-root')?.addEventListener('click', () => void pickLibraryRoot());
  refreshVolumesBtn?.addEventListener('click', () => void refreshVolumes());

  toReviewBtn?.addEventListener('click', () => { void goToReview(); });
  backToConfigureBtn?.addEventListener('click', () => setStage('configure'));
  startBtn?.addEventListener('click', () => void startRestore());
  abortBtn?.addEventListener('click', () => {
    // Cooperative cancellation: restore stops at the next phase boundary and,
    // crucially, before the destructive XML rewrite. In-flight downloads finish.
    void window.candybar.abortRestore();
    if (abortBtn) { abortBtn.disabled = true; abortBtn.textContent = 'Stopping…'; }
    showToast('info', 'Stopping the restore…', 'Track Lab stops at the next safe point. Downloads already under way finish first.');
  });
  newRunBtn?.addEventListener('click', () => setStage('configure'));

  reportExportBtn?.addEventListener('click', () => void exportReport());
  reportOpenStageBtn?.addEventListener('click', () => void openStageFolder());
  reportRetryBtn?.addEventListener('click', () => void runAgain());

  // Report filter tabs (within the Results stage)
  document.querySelectorAll<HTMLButtonElement>('#restore-stage-report .restore-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLButtonElement>('#restore-stage-report .restore-filter').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      reportFilter = btn.dataset.filter as typeof reportFilter;
      if (currentReport) drawReportRows(currentReport.results);
    });
  });

  // Look up drives and store accounts on every visit, so the ticks match what's plugged in now.
  const page = document.getElementById('page-restore');
  if (page) {
    const observer = new MutationObserver(() => {
      if (page.classList.contains('active') && currentStage === 'configure' && !running) {
        void refreshVolumes();
        void refreshAccountStatuses();
      }
    });
    observer.observe(page, { attributes: true, attributeFilter: ['class'] });
  }

  // Remember which sources the person chose themselves.
  ([['usb', srcUsb], ['beatport', srcBeatport], ['qobuz', srcQobuz]] as const).forEach(([key, el]) => {
    el?.addEventListener('change', () => { userTouched.add(key); updateSourceStatuses(); });
  });

  // "Sign in" / "Add account" / "Open Settings" buttons on this page.
  page?.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-settings-section]');
    if (!link?.dataset.settingsSection) return;
    e.preventDefault();
    requestOpenSettings(link.dataset.settingsSection);
  });
  window.addEventListener('store-account-changed', () => {
    if (document.getElementById('page-restore')?.classList.contains('active')) void refreshAccountStatuses();
  });

  updateReviewButton();
  updateSourceStatuses();
}
