import { escapeHtml, showToast, getErrorMessage, requestOpenSettings } from './shared';

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

const toReviewBtn = document.getElementById('restore-to-review') as HTMLButtonElement | null;
const backToConfigureBtn = document.getElementById('restore-back-to-configure') as HTMLButtonElement | null;
const startBtn = document.getElementById('restore-start') as HTMLButtonElement | null;
const abortBtn = document.getElementById('restore-abort') as HTMLButtonElement | null;
const newRunBtn = document.getElementById('restore-new-run') as HTMLButtonElement | null;

// Running stage
const timelineEl = document.getElementById('restore-timeline') as HTMLElement | null;
const kpiRecovered = document.getElementById('kpi-recovered');
const kpiStillMissing = document.getElementById('kpi-still-missing');
const kpiRate = document.getElementById('kpi-rate');
const kpiEta = document.getElementById('kpi-eta');
const kpiElapsed = document.getElementById('kpi-elapsed');
const progressBarEl = document.getElementById('restore-progress-bar') as HTMLDivElement | null;
const phaseCurrentEl = document.getElementById('restore-phase-current');
const currentTrackEl = document.getElementById('restore-current-track');
const accountsEl = document.getElementById('restore-accounts') as HTMLDivElement | null;
const logEl = document.getElementById('restore-log') as HTMLDivElement | null;
const logCountEl = document.getElementById('restore-log-count');

// Review stage
const reviewXmlCount = document.getElementById('review-xml-count');
const reviewLibCount = document.getElementById('review-lib-count');
const reviewMissingCount = document.getElementById('review-missing-count');
const reviewPlanEl = document.getElementById('review-plan') as HTMLUListElement | null;
const reviewEtaEl = document.getElementById('review-eta');
const reviewWarningsCard = document.getElementById('review-warnings-card');
const reviewWarningsEl = document.getElementById('review-warnings') as HTMLUListElement | null;

// Report stage
const reportHero = document.getElementById('restore-report-hero');
const reportBySourceEl = document.getElementById('report-by-source');
const reportByAccountEl = document.getElementById('report-by-account');
const reportFailuresEl = document.getElementById('report-failures');
const reportFailureCard = document.getElementById('report-failure-card');
const reportXmlEl = document.getElementById('report-xml');
const reportXmlCard = document.getElementById('report-xml-card');
const reportTable = document.getElementById('restore-report-table') as HTMLTableElement | null;
const reportExportBtn = document.getElementById('report-export') as HTMLButtonElement | null;
const reportOpenStageBtn = document.getElementById('report-open-stage') as HTMLButtonElement | null;
const reportRetryBtn = document.getElementById('report-retry-failed') as HTMLButtonElement | null;

// Source status pills (on Configure stage)
const statusEls: Record<string, HTMLElement | null> = {
  usb: document.getElementById('restore-status-usb'),
  beatport: document.getElementById('restore-status-beatport'),
  qobuz: document.getElementById('restore-status-qobuz'),
};

// ========== State ==========

let detectedVolumes: Volume[] = [];
let currentStage: Stage = 'configure';
let running = false;
let currentReport: Report | null = null;
let currentReportPath: string | null = null;
let reportFilter: 'all' | 'recovered' | 'still_missing' = 'all';
let logEntries: LogEntry[] = [];
const MAX_LOG_ENTRIES = 500;

// Cached live progress state used by the renderer-local ticker between real
// backend events so KPIs (elapsed / rate / ETA) keep ticking even when the
// main process is busy doing something that doesn't emit for several seconds
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
// typical time share — not perfect, but a huge UX upgrade over "0% until the
// first download lands".
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

// Account status cache populated on Configure / Review entry.
type AccountStatus = { qobuz: { connected: number; total: number }; beatport: { connected: number; total: number } };
let accountStatus: AccountStatus = { qobuz: { connected: 0, total: 0 }, beatport: { connected: 0, total: 0 } };

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
      btn.classList.toggle('is-active', btn.dataset.step === next);
      btn.classList.toggle('is-done', stageOrder(btn.dataset.step as Stage) < stageOrder(next));
    });
  }
}

function stageOrder(s: Stage): number {
  return { configure: 0, review: 1, running: 2, report: 3 }[s];
}

// ========== Configure stage ==========

async function pickXml() {
  const res = await window.candybar.restorePickXml();
  if (res.success && res.path && xmlInput) xmlInput.value = res.path;
  updateReviewButton();
}

// Review needs a backup to read; the button says why while it's locked.
function updateReviewButton() {
  const hasXml = !!xmlInput?.value.trim();
  if (toReviewBtn) toReviewBtn.disabled = !hasXml;
  const hint = document.getElementById('restore-xml-hint');
  if (hint) hint.style.display = hasXml ? 'none' : '';
}

async function pickLibraryRoot() {
  const chosen = await window.candybar.selectPath('dir');
  if (chosen && libRootInput) libRootInput.value = chosen;
}

async function refreshVolumes() {
  if (!volumesEl) return;
  volumesEl.innerHTML = '<span class="wiz-hint">Detecting…</span>';
  const res = await window.candybar.restoreListVolumes();
  if (!res.success || !res.volumes) {
    volumesEl.innerHTML = `<span class="wiz-hint">Error: ${escapeHtml(res.error || 'unknown')}</span>`;
    return;
  }
  detectedVolumes = res.volumes;
  if (detectedVolumes.length === 0) {
    volumesEl.innerHTML = '<span class="wiz-hint">No external volumes mounted.</span>';
  } else {
    volumesEl.innerHTML = detectedVolumes.map(v =>
      `<label class="wiz-volume"><input type="checkbox" class="restore-volume" value="${escapeHtml(v.name)}" checked> <b>${escapeHtml(v.name)}</b> <span class="wiz-hint">${escapeHtml(v.scanRoot)}</span></label>`,
    ).join('');
  }
  updateSourceStatuses();
}

function selectedVolumeNames(): string[] {
  if (!volumesEl) return [];
  return Array.from(volumesEl.querySelectorAll('input.restore-volume:checked'))
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
  updateSourceStatuses();
}

function updateSourceStatuses() {
  if (statusEls.usb) {
    const n = detectedVolumes.length;
    statusEls.usb.textContent = n === 0 ? 'No volumes detected' : `${n} volume${n === 1 ? '' : 's'} detected`;
    statusEls.usb.className = `wiz-source-status ${n === 0 ? 'is-warn' : 'is-ok'}`;
  }
  updateStoreSource('beatport', srcBeatport);
  updateStoreSource('qobuz', srcQobuz);
  // SoundCloud has no status line; its label carries the "experimental, lossy" badge.
}

// Stores this page switched off because no account was signed in. They come
// back on once one connects, so a choice the user made themselves is kept.
const autoDisabledStores = new Set<'beatport' | 'qobuz'>();

function updateStoreSource(service: 'beatport' | 'qobuz', input: HTMLInputElement | null) {
  const statusEl = statusEls[service];
  const { connected, total } = accountStatus[service];
  if (input) {
    if (connected === 0) {
      if (!input.disabled && input.checked) autoDisabledStores.add(service);
      input.checked = false;
      input.disabled = true;
    } else if (input.disabled) {
      input.disabled = false;
      if (autoDisabledStores.delete(service)) input.checked = true;
    }
  }
  if (!statusEl) return;
  if (connected === 0) {
    const what = total === 0 ? 'No account' : 'Not signed in';
    statusEl.innerHTML = `${what} · <button type="button" class="wiz-source-link" data-settings-section="${service}">Connect in Settings</button>`;
    statusEl.className = 'wiz-source-status is-warn';
  } else {
    statusEl.textContent = `${connected} of ${total} connected`;
    statusEl.className = `wiz-source-status ${connected < total ? 'is-warn' : 'is-ok'}`;
  }
}

// ========== Review stage ==========

async function goToReview() {
  const xmlPath = xmlInput?.value.trim() || '';
  if (!xmlPath) { showToast('error', 'Missing XML', 'Choose a Rekordbox XML first.'); return; }

  // We don't yet have a cheap "dry-run scan" IPC; show "—" for now and let
  // the actual run fill these in live. The plan + source summary still
  // gives plenty of pre-flight value.
  if (reviewXmlCount) reviewXmlCount.textContent = '—';
  if (reviewLibCount) reviewLibCount.textContent = '—';
  if (reviewMissingCount) reviewMissingCount.textContent = '—';

  renderPlan();
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
      ? `${n} track${n === 1 ? '' : 's'} you deleted will be left out again. They aren't counted as missing.`
      : '';
  }
}

function renderPlan() {
  if (!reviewPlanEl) return;
  const parts: string[] = [];
  if (srcUsb?.checked) {
    const vols = selectedVolumeNames();
    parts.push(`USB · ${vols.length ? vols.join(', ') : 'no volumes selected'}`);
  }
  if (srcBeatport?.checked) {
    const { connected, total } = accountStatus.beatport;
    parts.push(`Beatport · ${connected} of ${total} accounts connected`);
  }
  if (srcQobuz?.checked) {
    const { connected, total } = accountStatus.qobuz;
    parts.push(`Qobuz · ${connected} of ${total} accounts connected`);
  }
  if (srcSoundcloud?.checked) parts.push('SoundCloud (experimental, lossy)');
  if (usbTagMatchingInput?.checked) parts.push('USB tag-matching enabled (slower, higher recall)');
  if (rewriteXmlInput?.checked) parts.push('Rekordbox XML will be rewritten (backup first)');
  const c = concurrencyInput?.value || '5';
  parts.push(`Concurrency: ${c}`);
  reviewPlanEl.innerHTML = parts.map(p => `<li>${escapeHtml(p)}</li>`).join('');
  if (reviewEtaEl) reviewEtaEl.textContent = 'Run the job to see live progress, ETA, and per-account recovery counts.';
}

function renderWarnings() {
  if (!reviewWarningsEl || !reviewWarningsCard) return;
  const warnings: string[] = [];
  if (srcQobuz?.checked && accountStatus.qobuz.total === 0) warnings.push('Qobuz is enabled but no Qobuz accounts are configured.');
  if (srcBeatport?.checked && accountStatus.beatport.total === 0) warnings.push('Beatport is enabled but no Beatport accounts are configured.');
  if (srcQobuz?.checked && accountStatus.qobuz.total > 0 && accountStatus.qobuz.connected < accountStatus.qobuz.total) {
    warnings.push(`${accountStatus.qobuz.total - accountStatus.qobuz.connected} Qobuz account(s) are not connected — they'll open a login window during the run.`);
  }
  if (srcBeatport?.checked && accountStatus.beatport.total > 0 && accountStatus.beatport.connected < accountStatus.beatport.total) {
    warnings.push(`${accountStatus.beatport.total - accountStatus.beatport.connected} Beatport account(s) are not connected — they'll open a login window during the run.`);
  }
  if (srcUsb?.checked && detectedVolumes.length === 0) warnings.push('USB is enabled but no volumes are mounted.');
  if (warnings.length === 0) {
    reviewWarningsCard.style.display = 'none';
    return;
  }
  reviewWarningsCard.style.display = '';
  reviewWarningsEl.innerHTML = warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('');
}

// ========== Running stage ==========

function resetRunState() {
  logEntries = [];
  if (logEl) logEl.innerHTML = '';
  if (logCountEl) logCountEl.textContent = '0 entries';
  if (accountsEl) accountsEl.innerHTML = '<p class="wiz-hint">No store accounts active yet.</p>';
  if (progressBarEl) {
    progressBarEl.style.width = '0%';
    progressBarEl.classList.remove('is-indeterminate');
  }
  if (kpiRecovered) kpiRecovered.textContent = '0';
  if (kpiStillMissing) kpiStillMissing.textContent = '0';
  if (kpiRate) kpiRate.textContent = '—';
  if (kpiEta) kpiEta.textContent = '—';
  if (kpiElapsed) kpiElapsed.textContent = '0s';
  if (phaseCurrentEl) phaseCurrentEl.textContent = 'Starting…';
  if (currentTrackEl) currentTrackEl.textContent = '';
  if (timelineEl) {
    timelineEl.querySelectorAll<HTMLElement>('.wiz-phase').forEach(li => {
      li.classList.remove('is-active', 'is-done', 'is-skipped', 'is-failed');
    });
  }

  live = {
    startWallTime: Date.now(),
    latestElapsedSec: 0,
    latestRate: undefined,
    totals: { totalXmlTracks: 0, alreadyInLibrary: 0, missing: 0, recovered: 0, stillMissing: 0 },
    phaseStatus: new Map(),
    activePhase: 'parsing',
  };
  if (liveTicker) clearInterval(liveTicker);
  // 500ms ticker: refresh elapsed, ETA, rate, and phase-weighted progress bar
  // even when the main process is silent between events. Keeps the UI "alive"
  // during the multi-second sniff / scan / fetch phases.
  liveTicker = setInterval(tickLive, 500);
}

function stopLiveTicker() {
  if (liveTicker) { clearInterval(liveTicker); liveTicker = null; }
}

function tickLive() {
  if (!live) return;
  // Elapsed: count from the renderer's start wall-clock when main hasn't
  // spoken recently, but prefer main's authoritative elapsed when available.
  const wallElapsed = (Date.now() - live.startWallTime) / 1000;
  const elapsed = Math.max(wallElapsed, live.latestElapsedSec);
  if (kpiElapsed) kpiElapsed.textContent = formatDuration(elapsed);

  // Rate / ETA: only show once main has reported one, since tracks/min needs
  // recovery data we can't derive locally.
  if (kpiRate) kpiRate.textContent = live.latestRate ? (live.latestRate * 60).toFixed(1) : '—';
  if (kpiEta) {
    if (live.latestRate && live.latestRate > 0 && live.totals.stillMissing > 0) {
      const est = live.totals.stillMissing / live.latestRate;
      kpiEta.textContent = formatDuration(est);
    } else {
      kpiEta.textContent = '—';
    }
  }

  // Phase-weighted overall progress: completed phases contribute full weight,
  // the active phase contributes half + track-based fraction if we're in a
  // download phase with real recoveries happening.
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
          // Blend phase-baseline with track-level ratio within this phase
          frac = 0.2 + 0.6 * (live.totals.recovered / live.totals.missing);
        }
        score += weight * Math.min(1, frac);
      }
    }
    const pct = Math.min(100, Math.max(0, (score / totalWeight) * 100));
    progressBarEl.style.width = pct.toFixed(1) + '%';

    // Show indeterminate stripe when a phase is active but we haven't had any
    // recovery movement in the last few seconds (sniff / fetch / indexing).
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

  // Timeline UI
  if (timelineEl) {
    const li = timelineEl.querySelector<HTMLElement>(`.wiz-phase[data-phase="${CSS.escape(p.phase)}"]`);
    if (li) {
      if (p.phaseStatus === 'start') {
        timelineEl.querySelectorAll<HTMLElement>('.wiz-phase.is-active').forEach(el => {
          if (el !== li) { el.classList.remove('is-active'); el.classList.add('is-done'); }
        });
        li.classList.add('is-active');
        li.classList.remove('is-done', 'is-skipped');
      } else if (p.phaseStatus === 'end') {
        li.classList.remove('is-active');
        li.classList.add('is-done');
      } else if (p.phaseStatus === 'skipped') {
        li.classList.remove('is-active');
        li.classList.add('is-skipped');
      }
    }
  }

  // Authoritative totals / rate from main
  live.totals = p.totals;
  live.latestElapsedSec = p.elapsedSec;
  if (p.rate) live.latestRate = p.rate;

  // KPIs that depend on real counts (ticker handles the smoothing/animation)
  if (kpiRecovered) kpiRecovered.textContent = String(p.totals.recovered);
  if (kpiStillMissing) kpiStillMissing.textContent = String(p.totals.stillMissing);
  // Phase + current track
  if (phaseCurrentEl) phaseCurrentEl.textContent = `${humanPhase(p.phase)} · ${p.message}`;
  if (currentTrackEl) currentTrackEl.textContent = p.currentTrack || '';
  // Per-account cards
  if (p.perAccount && p.perAccount.length > 0) renderAccounts(p.perAccount);
  // Log stream
  if (p.log) appendLog(p.log);

  // Immediate re-tick so the progress bar doesn't lag a beat behind the event
  tickLive();
}

function renderAccounts(rows: PerAccountCounter[]) {
  if (!accountsEl) return;
  if (rows.length === 0) {
    accountsEl.innerHTML = '<p class="wiz-hint">No store accounts active yet.</p>';
    return;
  }
  accountsEl.innerHTML = rows.map(r => {
    const name = r.label || r.email || r.accountId.slice(0, 8);
    const owned = r.ownedCount ?? 0;
    const matched = r.matchedCount ?? 0;
    const downloaded = r.downloadedCount ?? 0;
    const failed = r.failedCount ?? 0;
    const serviceClass = r.service === 'qobuz' ? 'is-qobuz' : 'is-beatport';
    return `
      <div class="wiz-account ${serviceClass}">
        <div class="wiz-account-head">
          <span class="wiz-account-service">${escapeHtml(r.service)}</span>
          <span class="wiz-account-name" title="${escapeHtml(r.email || r.accountId)}">${escapeHtml(name)}</span>
        </div>
        <div class="wiz-account-stats">
          <span><b>${owned}</b> owned</span>
          <span><b>${matched}</b> matched</span>
          <span class="wiz-ok"><b>${downloaded}</b> downloaded</span>
          ${failed ? `<span class="wiz-bad"><b>${failed}</b> failed</span>` : ''}
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
  line.innerHTML = `<span class="wiz-log-time">${hh}:${mm}:${ss}</span><span class="wiz-log-phase">${escapeHtml(humanPhase(entry.phase))}</span><span class="wiz-log-msg">${escapeHtml(entry.message)}</span>`;
  logEl.appendChild(line);
  // Cap DOM to last N lines
  while (logEl.childElementCount > MAX_LOG_ENTRIES) logEl.removeChild(logEl.firstChild!);
  logEl.scrollTop = logEl.scrollHeight;
  if (logCountEl) logCountEl.textContent = `${logEntries.length} entries`;
}

function humanPhase(p: string): string {
  const map: Record<string, string> = {
    parsing: 'Parse XML',
    scanning_library: 'Scan library',
    computing_missing: 'Find missing',
    usb_scan: 'USB scan',
    beatport_fetch: 'Beatport purchases',
    beatport_download: 'Beatport download',
    qobuz_fetch: 'Qobuz purchases',
    qobuz_download: 'Qobuz download',
    xml_rewrite: 'Rewrite XML',
    complete: 'Complete',
    init: 'Init',
  };
  return map[p] || p;
}

function formatDuration(sec: number | undefined): string {
  if (sec == null) return '—';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

// ========== Run ==========

async function startRestore() {
  if (running) return;
  const xmlPath = xmlInput?.value.trim() || '';
  if (!xmlPath) { showToast('error', 'Missing XML', 'Choose a Rekordbox XML first.'); return; }

  running = true;
  if (startBtn) startBtn.disabled = true;
  // A previous run's Abort leaves the button disabled.
  if (abortBtn) abortBtn.disabled = false;
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
      showToast('error', 'Restore failed', res.error || 'Unknown error');
    } else {
      currentReport = res.report as Report;
      currentReportPath = (res as { reportPath?: string }).reportPath ?? null;
      showToast('success', 'Restore complete',
        `Recovered ${currentReport.totals.recovered} of ${currentReport.totals.missing}`);
      renderReport(currentReport);
      setStage('report');
    }
  } catch (err) {
    showToast('error', 'Restore failed', getErrorMessage(err));
  } finally {
    offProgress?.();
    stopLiveTicker();
    live = null;
    running = false;
    if (startBtn) startBtn.disabled = false;
  }
}

// ========== Report stage ==========

function renderReport(report: Report) {
  const t = report.totals;
  const recoveredPct = t.missing > 0 ? Math.round((t.recovered / t.missing) * 100) : 0;
  if (reportHero) {
    reportHero.innerHTML = `
      <div class="wiz-hero-stat is-primary">
        <div class="wiz-hero-num">${t.recovered}<span class="wiz-hero-total"> / ${t.missing}</span></div>
        <div class="wiz-hero-label">recovered (${recoveredPct}%)</div>
      </div>
      <div class="wiz-hero-stat">
        <div class="wiz-hero-num">${t.stillMissing}</div>
        <div class="wiz-hero-label">still missing</div>
      </div>
      <div class="wiz-hero-stat">
        <div class="wiz-hero-num">${formatDuration(report.durationSec)}</div>
        <div class="wiz-hero-label">duration</div>
      </div>
      ${deletedCount(report) > 0 ? `
      <div class="wiz-hero-stat is-quiet">
        <div class="wiz-hero-num">${deletedCount(report)}</div>
        <div class="wiz-hero-label">left out (you deleted)</div>
      </div>` : ''}
    `;
  }

  renderStoreErrors(document.getElementById('report-store-errors'), report.storeErrors ?? [],
    'Tracks marked "Couldn\'t check" below may be in those purchases. Sign in again in Settings, then run again.');
  renderDeletedGroup(report.deletedSkipped ?? []);
  renderLastRunNotes(); // the Configure stage's store rows show it too

  if (reportBySourceEl) {
    const rows = Object.entries(report.bySource);
    reportBySourceEl.innerHTML = rows.length === 0
      ? '<span class="wiz-hint">No recoveries.</span>'
      : rows.map(([src, n]) => `<div class="wiz-breakdown-row"><span class="wiz-breakdown-label">${escapeHtml(src)}</span><span class="wiz-breakdown-value"><b>${n}</b></span></div>`).join('');
  }

  if (reportByAccountEl) {
    // Derive per-account counts from report.results (post-run the perAccount snapshot isn't on the report yet; this is a fair reconstruction).
    const byAccount = new Map<string, { service: string; count: number; accountId: string }>();
    for (const r of report.results) {
      if (r.status !== 'recovered' || !r.sourceAccountId || !r.source) continue;
      const key = `${r.source}:${r.sourceAccountId}`;
      const existing = byAccount.get(key);
      byAccount.set(key, { service: r.source, count: (existing?.count ?? 0) + 1, accountId: r.sourceAccountId });
    }
    if (byAccount.size === 0) {
      reportByAccountEl.innerHTML = '<span class="wiz-hint">No per-account store recoveries.</span>';
    } else {
      reportByAccountEl.innerHTML = Array.from(byAccount.values()).map(a =>
        `<div class="wiz-breakdown-row"><span class="wiz-breakdown-label">${escapeHtml(a.service)} · ${escapeHtml(a.accountId.slice(0, 8))}</span><span class="wiz-breakdown-value"><b>${a.count}</b></span></div>`,
      ).join('');
    }
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
        .map(([cat, n]) => `<div class="wiz-breakdown-row"><span class="wiz-breakdown-label">${escapeHtml(failureLabel(cat))}</span><span class="wiz-breakdown-value"><b>${n}</b></span></div>`)
        .join('');
    }
  }

  if (reportXmlCard && reportXmlEl) {
    if (report.xmlRewrite) {
      reportXmlCard.style.display = '';
      reportXmlEl.innerHTML = `
        <div class="wiz-breakdown-row"><span class="wiz-breakdown-label">Updated</span><span class="wiz-breakdown-value"><b>${report.xmlRewrite.updated}</b></span></div>
        ${report.xmlRewrite.notFound > 0 ? `<div class="wiz-breakdown-row"><span class="wiz-breakdown-label">Not found in XML</span><span class="wiz-breakdown-value"><b>${report.xmlRewrite.notFound}</b></span></div>` : ''}
        ${report.xmlRewrite.backupPath ? `<div class="wiz-breakdown-row"><span class="wiz-breakdown-label">Backup</span><span class="wiz-breakdown-value">${escapeHtml(report.xmlRewrite.backupPath)}</span></div>` : ''}
      `;
    } else {
      reportXmlCard.style.display = 'none';
    }
  }

  drawReportRows(report.results);
}

function failureLabel(c: string): string {
  return ({
    no_match: 'No match in any enabled source',
    login: 'Store sign-in problem, or purchases couldn\'t be checked',
    download: 'Download failed',
    copy: 'USB copy failed',
    rewrite: 'XML rewrite skipped',
    other: 'Couldn\'t check every source',
  } as Record<string, string>)[c] || c;
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
    <div class="wiz-callout-title">Couldn't check ${errors.length === 1 ? 'one store account' : `${errors.length} store accounts`}</div>
    <ul class="wiz-callout-list">${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
    <p class="wiz-callout-hint">${escapeHtml(hint)}</p>`;
}

/** Quiet, collapsed list of tracks left out because Ben deleted them. */
function renderDeletedGroup(skipped: SkippedTrack[]) {
  const card = document.getElementById('report-deleted-card') as HTMLDetailsElement | null;
  const summary = document.getElementById('report-deleted-summary');
  const list = document.getElementById('report-deleted-list');
  if (!card || !summary || !list) return;
  card.hidden = skipped.length === 0;
  card.open = false;
  summary.textContent = `Left out — you deleted these (${skipped.length})`;
  list.innerHTML = skipped.map(t =>
    `<li><b>${escapeHtml(t.artist || 'Unknown artist')}</b> — ${escapeHtml(t.title || 'Untitled')}</li>`,
  ).join('');
}

function drawReportRows(results: TrackResult[]) {
  if (!reportTable) return;
  const body = reportTable.querySelector('tbody') as HTMLTableSectionElement | null;
  if (!body) return;
  const filtered = reportFilter === 'all' ? results : results.filter(r => r.status === reportFilter);
  body.innerHTML = filtered.map(r => {
    const acct = r.sourceAccountId ? r.sourceAccountId.slice(0, 8) : '';
    return `
      <tr data-status="${escapeHtml(r.status)}">
        <td><b>${escapeHtml(r.track.artist)}</b> — ${escapeHtml(r.track.title)}</td>
        <td class="source" data-source="${r.source || ''}">${escapeHtml(r.source || '—')}</td>
        <td>${escapeHtml(acct || '—')}</td>
        <td>${r.status === 'still_missing' && r.failureCategory
          ? `<span class="restore-reason">${escapeHtml(failureLabel(r.failureCategory))}</span>${r.detail ? `<span class="restore-detail">${escapeHtml(r.detail)}</span>` : ''}`
          : escapeHtml(r.detail || '')}</td>
      </tr>
    `;
  }).join('');
}

async function exportReport() {
  // The backend already writes the report JSON to userData on every run; just
  // reveal it in Finder rather than re-serializing client-side.
  if (!currentReportPath) {
    showToast('info', 'No report on disk', 'Run a restore first.');
    return;
  }
  try {
    await window.candybar.showInFinder(currentReportPath);
  } catch {
    showToast('error', 'Could not open report', currentReportPath);
  }
}

async function openStageFolder() {
  if (!currentReport) return;
  const p = currentReport.options.stageDir;
  if (p) await window.candybar.showInFinder(p).catch(() => { /* ignore */ });
}

function runAgain() {
  // The backend can't yet limit a run to the still-missing tracks, so this
  // goes back to the plan for a full re-run with the same settings.
  if (!currentReport) return;
  renderPlan();
  renderWarnings();
  setStage('review');
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
    if (abortBtn) abortBtn.disabled = true;
    showToast('info', 'Aborting restore…', 'Stopping at the next safe point; in-flight downloads finish.');
  });
  newRunBtn?.addEventListener('click', () => setStage('configure'));

  reportExportBtn?.addEventListener('click', () => void exportReport());
  reportOpenStageBtn?.addEventListener('click', () => void openStageFolder());
  reportRetryBtn?.addEventListener('click', () => runAgain());

  // Report filter buttons (within stage 4)
  document.querySelectorAll<HTMLButtonElement>('#restore-stage-report .restore-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#restore-stage-report .restore-filter').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      reportFilter = btn.dataset.filter as typeof reportFilter;
      if (currentReport) drawReportRows(currentReport.results);
    });
  });

  // Auto-refresh volumes + account status on first visit
  const page = document.getElementById('page-restore');
  if (page) {
    const observer = new MutationObserver(() => {
      if (page.classList.contains('active')) {
        if (detectedVolumes.length === 0) void refreshVolumes();
        void refreshAccountStatuses();
      }
    });
    observer.observe(page, { attributes: true, attributeFilter: ['class'] });
  }

  // Sources checkboxes — update the Configure-stage status summary on toggle
  [srcUsb, srcBeatport, srcQobuz, srcSoundcloud].forEach(el => {
    el?.addEventListener('change', () => updateSourceStatuses());
  });

  // "Connect in Settings" links inside the store source rows.
  document.getElementById('restore-sources')?.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLButtonElement>('.wiz-source-link');
    if (!link?.dataset.settingsSection) return;
    e.preventDefault();
    requestOpenSettings(link.dataset.settingsSection);
  });
  window.addEventListener('store-account-changed', () => {
    if (document.getElementById('page-restore')?.classList.contains('active')) void refreshAccountStatuses();
  });

  updateReviewButton();
}
