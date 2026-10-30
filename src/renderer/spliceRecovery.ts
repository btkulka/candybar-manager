import { escapeHtml, showToast, getErrorMessage } from './shared';
import type {
  SpliceLoginStatus,
  SpliceScanResult,
  SpliceBuckets,
  SpliceOwnedItem,
  SpliceCreditsItem,
  SpliceNotFoundItem,
  SpliceProgressEvent,
  SpliceDownloadReport,
} from './shared';

type Stage = 'configure' | 'scan' | 'review' | 'download' | 'report';

const STAGE_ORDER: Record<Stage, number> = { configure: 0, scan: 1, review: 2, download: 3, report: 4 };

// Module state
let currentStage: Stage = 'configure';
let alsPath: string | null = null;
let loginStatus: SpliceLoginStatus | null = null;
let scanResult: SpliceScanResult | null = null;
let buckets: SpliceBuckets | null = null;
let downloadReport: SpliceDownloadReport | null = null;

// DOM lookups (lazy — page may not be in DOM at module-load time on hot reload)
function $(id: string) { return document.getElementById(id); }

function setStage(next: Stage) {
  currentStage = next;
  document.querySelectorAll<HTMLElement>('#page-splice-recovery .wiz-stage').forEach((el) => {
    const active = el.dataset.stage === next;
    el.classList.toggle('is-active', active);
    el.style.display = active ? '' : 'none';
  });
  const stepper = $('splice-stepper');
  if (stepper) {
    stepper.querySelectorAll<HTMLButtonElement>('.wiz-step').forEach((btn) => {
      const stepStage = btn.dataset.step as Stage;
      btn.classList.toggle('is-active', stepStage === next);
      btn.classList.toggle('is-done', STAGE_ORDER[stepStage] < STAGE_ORDER[next]);
    });
  }
}

// --- Configure stage -----------------------------------------------------

async function pickAls() {
  const res = await window.candybar.splicePickAls();
  if (res.success && res.path) {
    alsPath = res.path;
    const input = $('splice-als-path') as HTMLInputElement | null;
    if (input) input.value = res.path;
    updateScanButton();
  }
}

async function refreshLoginStatus() {
  const res = await window.candybar.spliceLoginStatus();
  if (res.success && res.status) {
    loginStatus = res.status;
    renderLoginPill();
    updateScanButton();
  }
}

function renderLoginPill() {
  const pill = $('splice-status-pill');
  const text = $('splice-status-text');
  const connectBtn = $('splice-connect-btn') as HTMLButtonElement | null;
  if (!pill || !text) return;

  pill.classList.remove('is-connected', 'is-disconnected');
  if (loginStatus?.connected) {
    pill.classList.add('is-connected');
    text.textContent = 'Connected';
    if (connectBtn) connectBtn.style.display = 'none';
  } else {
    pill.classList.add('is-disconnected');
    text.textContent = 'Not connected';
    if (connectBtn) connectBtn.style.display = '';
  }
}

async function startLogin() {
  const btn = $('splice-connect-btn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Opening Chrome…'; }
  showToast('info', 'Splice Login', 'A Chrome window will open at splice.com. Log in, then close the window.');
  try {
    const res = await window.candybar.spliceStartLogin();
    if (!res.ok) {
      showToast('error', 'Login Failed', res.error || 'Could not open browser.');
    }
  } catch (err) {
    showToast('error', 'Login Failed', getErrorMessage(err));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
    await refreshLoginStatus();
    if (loginStatus?.connected) showToast('success', 'Connected', 'Splice is ready.');
  }
}

function updateScanButton() {
  const btn = $('splice-to-scan') as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = !alsPath || !loginStatus?.connected;
}

// --- Scan stage ----------------------------------------------------------

async function runScan() {
  if (!alsPath) return;
  setStage('scan');
  const title = $('splice-scan-title');
  const counts = $('splice-scan-counts');
  const current = $('splice-scan-current');
  const progress = $('splice-scan-progress') as HTMLElement | null;

  if (title) title.textContent = 'Parsing project…';
  if (counts) counts.textContent = '—';
  if (current) current.textContent = '—';
  if (progress) progress.style.width = '0%';

  const scanRes = await window.candybar.spliceScan(alsPath);
  if (!scanRes.success || !scanRes.result) {
    showToast('error', 'Scan Failed', scanRes.error || 'Could not parse .als');
    setStage('configure');
    return;
  }
  scanResult = scanRes.result;
  if (counts) counts.textContent = `${scanResult.totalRefs} sample refs · ${scanResult.missing.length} missing on disk · ${scanResult.spliceRefs} from Splice folders`;

  if (scanResult.missing.length === 0) {
    if (title) title.textContent = 'Nothing to recover';
    if (current) {
      current.textContent = `All ${scanResult.totalRefs} samples are present on disk.`;
    }
    buckets = { owned: [], credits: [], notFound: [] };
    setTimeout(() => renderReview(), 800);
    return;
  }

  // Now classify — listen to progress events
  if (title) title.textContent = `Searching ${scanResult.missing.length} samples on Splice…`;
  const offProgress = window.candybar.onSpliceProgress((p) => {
    if (p.phase !== 'searching') return;
    if (progress) progress.style.width = `${Math.round(((p.index + 1) / p.total) * 100)}%`;
    if (current) current.textContent = `[${p.index + 1}/${p.total}] ${p.sample.basename}${p.result ? ` — ${p.result}` : ''}`;
  });

  try {
    const classifyRes = await window.candybar.spliceClassify(scanResult.missing);
    if (!classifyRes.success || !classifyRes.buckets) {
      showToast('error', 'Search Failed', classifyRes.error || 'Splice search failed');
      setStage('configure');
      return;
    }
    buckets = classifyRes.buckets;
    renderReview();
  } finally {
    offProgress?.();
  }
}

// --- Review stage --------------------------------------------------------

function renderReview() {
  if (!buckets) return;
  setStage('review');

  const ownedCount = $('splice-owned-count');
  const creditsCount = $('splice-credits-count');
  const notFoundCount = $('splice-notfound-count');
  if (ownedCount) ownedCount.textContent = String(buckets.owned.length);
  if (creditsCount) creditsCount.textContent = String(buckets.credits.length);
  if (notFoundCount) notFoundCount.textContent = String(buckets.notFound.length);

  const ownedList = $('splice-owned-list');
  if (ownedList) ownedList.innerHTML = renderOwnedList(buckets.owned);

  const creditsList = $('splice-credits-list');
  if (creditsList) creditsList.innerHTML = renderCreditsList(buckets.credits);

  const notFoundList = $('splice-notfound-list');
  if (notFoundList) notFoundList.innerHTML = renderNotFoundList(buckets.notFound);

  const downloadBtn = $('splice-download-owned') as HTMLButtonElement | null;
  if (downloadBtn) downloadBtn.disabled = buckets.owned.length === 0;

  const buyAllBtn = $('splice-buy-all') as HTMLButtonElement | null;
  if (buyAllBtn) {
    buyAllBtn.disabled = buckets.credits.length === 0;
    buyAllBtn.textContent = `Buy all (${buckets.credits.length})`;
  }

  // Fetch credits balance asynchronously — don't block render. Balance
  // appears in the Credits card header once the call resolves.
  void refreshCreditsBalance();
}

let creditsBalance: number | null = null;

async function refreshCreditsBalance() {
  const el = $('splice-credits-balance');
  if (!el) return;
  el.textContent = 'Balance: …';
  try {
    const res = await window.candybar.spliceCreditsBalance();
    if (res.success && res.balance) {
      creditsBalance = res.balance.credits;
      el.textContent = `Balance: ${res.balance.credits} credit${res.balance.credits === 1 ? '' : 's'}`;
    } else {
      el.textContent = 'Balance: —';
    }
  } catch {
    el.textContent = 'Balance: —';
  }
}

// Splice paths look like .../Splice/Samples/packs/<Pack Name>/<...>/file.wav.
// Plucking the pack name gives a fallback "this came from X" signal when
// Splice's API didn't return one (notFound rows, mostly).
function packNameFromPath(p: string): string | null {
  const m = p.match(/[\\/]packs[\\/]([^\\/]+)/i);
  return m ? m[1].replace(/_/g, ' ') : null;
}

// Cover art rendered as <img> with broken-image fallback to a transparent
// placeholder so a 404'd cover doesn't show the browser's default icon.
function renderCover(url: string | null): string {
  if (!url) return '<div class="splice-bucket-cover splice-bucket-cover-empty"></div>';
  return `<img class="splice-bucket-cover" src="${escapeHtml(url)}" alt="" loading="lazy" onerror="this.classList.add('splice-bucket-cover-empty');this.removeAttribute('src');">`;
}

function renderOwnedList(items: SpliceOwnedItem[]): string {
  if (items.length === 0) return '<span class="wiz-hint">No owned matches.</span>';
  return items.map((it) => {
    const pack = it.asset.packName ?? packNameFromPath(it.originalPath);
    return `
    <div class="splice-bucket-row" title="${escapeHtml(it.originalPath)}">
      ${renderCover(it.asset.coverUrl)}
      <span class="splice-bucket-name">${escapeHtml(it.basename)}</span>
      ${pack ? `<span class="splice-bucket-pack">${escapeHtml(pack)}</span>` : ''}
    </div>
  `;
  }).join('');
}

function renderCreditsList(items: SpliceCreditsItem[]): string {
  if (items.length === 0) return '<span class="wiz-hint">No catalog matches that would cost credits.</span>';
  return items.map((it) => {
    const pack = it.asset.packName ?? packNameFromPath(it.originalPath);
    return `
    <div class="splice-bucket-row" title="${escapeHtml(it.originalPath)}">
      ${renderCover(it.asset.coverUrl)}
      <span class="splice-bucket-name">${escapeHtml(it.basename)}</span>
      ${pack ? `<span class="splice-bucket-pack">${escapeHtml(pack)}</span>` : ''}
      <a href="${escapeHtml(it.spliceUrl)}" target="_blank" rel="noopener">Open on Splice</a>
    </div>
  `;
  }).join('');
}

function renderNotFoundList(items: SpliceNotFoundItem[]): string {
  if (items.length === 0) return '<span class="wiz-hint">Every missing sample matched something.</span>';
  return items.map((it) => {
    const detail = it.error ?? packNameFromPath(it.originalPath) ?? '';
    return `
    <div class="splice-bucket-row" title="${escapeHtml(it.originalPath)}">
      <div class="splice-bucket-cover splice-bucket-cover-empty"></div>
      <span class="splice-bucket-name">${escapeHtml(it.basename)}</span>
      ${detail ? `<span class="splice-bucket-pack">${escapeHtml(detail)}</span>` : ''}
    </div>
  `;
  }).join('');
}

// --- Download stage ------------------------------------------------------

const MAX_LOG_LINES = 500;
let logEntries: string[] = [];

function appendLog(line: string) {
  logEntries.push(line);
  if (logEntries.length > MAX_LOG_LINES) logEntries.splice(0, logEntries.length - MAX_LOG_LINES);
  const log = $('splice-download-log');
  if (log) log.innerHTML = logEntries.map((l) => `<div class="wiz-log-line">${escapeHtml(l)}</div>`).join('');
  if (log) log.scrollTop = log.scrollHeight;
}

async function copyLog() {
  const btn = $('splice-log-copy') as HTMLButtonElement | null;
  const text = logEntries.join('\n');
  if (!text) {
    showToast('info', 'Nothing to copy', 'Log is empty.');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('is-copied');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('is-copied');
      }, 1500);
    }
  } catch (err) {
    showToast('error', 'Copy Failed', getErrorMessage(err));
  }
}

async function runDownload() {
  if (!buckets || buckets.owned.length === 0) return;
  setStage('download');
  logEntries = [];
  appendLog(`Downloading ${buckets.owned.length} samples…`);

  const title = $('splice-download-title');
  const counts = $('splice-download-counts');
  const current = $('splice-download-current');
  const progress = $('splice-download-progress') as HTMLElement | null;

  if (title) title.textContent = 'Downloading owned samples';
  if (counts) counts.textContent = `0 / ${buckets.owned.length}`;
  if (current) current.textContent = '—';
  if (progress) progress.style.width = '0%';

  let succeeded = 0;
  let failed = 0;

  const offProgress = window.candybar.onSpliceProgress((p: SpliceProgressEvent) => {
    if (p.phase !== 'downloading') return;
    if (progress) progress.style.width = `${Math.round(((p.index + 1) / p.total) * 100)}%`;
    if (current) current.textContent = `[${p.index + 1}/${p.total}] ${p.sample.basename}`;
    if (p.status === 'ok') {
      succeeded++;
      appendLog(`OK   ${p.sample.basename}`);
    } else if (p.status === 'fail') {
      failed++;
      appendLog(`FAIL ${p.sample.basename}: ${p.error || 'unknown'}`);
    }
    if (counts) counts.textContent = `${succeeded} ok · ${failed} failed · ${p.total - p.index - 1} remaining`;
  });

  try {
    const res = await window.candybar.spliceDownloadOwned(buckets.owned);
    if (!res.success || !res.report) {
      showToast('error', 'Download Failed', res.error || 'Splice download failed');
      setStage('review');
      return;
    }
    downloadReport = res.report;
    renderReport();
  } finally {
    offProgress?.();
  }
}

async function runBuyAll() {
  if (!buckets || buckets.credits.length === 0) return;

  // Confirm before spending credits — once licensed, you can't get a refund.
  const count = buckets.credits.length;
  const balanceLine = creditsBalance !== null
    ? `\n\nYou have ${creditsBalance} credits. After this purchase: ${creditsBalance - count}.`
    : '';
  if (creditsBalance !== null && creditsBalance < count) {
    showToast('error', 'Not enough credits', `You have ${creditsBalance} credits but ${count} are needed. Top up on Splice and retry.`);
    return;
  }
  const ok = window.confirm(`Spend ${count} credit${count === 1 ? '' : 's'} to license and download these samples?${balanceLine}`);
  if (!ok) return;

  setStage('download');
  logEntries = [];
  appendLog(`Purchasing & downloading ${count} samples…`);

  const title = $('splice-download-title');
  const counts = $('splice-download-counts');
  const current = $('splice-download-current');
  const progress = $('splice-download-progress') as HTMLElement | null;

  if (title) title.textContent = 'Purchasing & downloading samples';
  if (counts) counts.textContent = `0 / ${count}`;
  if (current) current.textContent = '—';
  if (progress) progress.style.width = '0%';

  let succeeded = 0;
  let failed = 0;

  const offProgress = window.candybar.onSpliceProgress((p: SpliceProgressEvent) => {
    if (p.phase !== 'downloading') return;
    if (progress) progress.style.width = `${Math.round(((p.index + 1) / p.total) * 100)}%`;
    if (current) current.textContent = `[${p.index + 1}/${p.total}] ${p.sample.basename}`;
    if (p.status === 'ok') {
      succeeded++;
      appendLog(`OK   ${p.sample.basename}`);
    } else if (p.status === 'fail') {
      failed++;
      appendLog(`FAIL ${p.sample.basename}: ${p.error || 'unknown'}`);
    }
    if (counts) counts.textContent = `${succeeded} ok · ${failed} failed · ${p.total - p.index - 1} remaining`;
  });

  try {
    const res = await window.candybar.spliceBuyCredits(buckets.credits);
    if (!res.success || !res.report) {
      showToast('error', 'Purchase Failed', res.error || 'Splice purchase failed');
      setStage('review');
      return;
    }
    downloadReport = res.report;
    renderReport();
  } finally {
    offProgress?.();
  }
}

// --- Report stage --------------------------------------------------------

function renderReport() {
  if (!downloadReport || !buckets) return;
  setStage('report');

  const hero = $('splice-report-hero');
  if (hero) {
    hero.textContent = `Recovered ${downloadReport.succeeded} of ${downloadReport.attempted} samples`;
  }

  const failedWrap = $('splice-report-failed-wrap');
  const failed = $('splice-report-failed');
  if (downloadReport.failed.length > 0) {
    if (failedWrap) failedWrap.style.display = '';
    if (failed) {
      failed.innerHTML = downloadReport.failed.map((f) => {
        const friendly = humanizeDownloadError(f.error);
        return `
        <div class="splice-bucket-row splice-bucket-row-fail" title="${escapeHtml(f.error)}">
          <span class="splice-bucket-name">${escapeHtml(f.sample.basename)}</span>
          <span class="splice-bucket-pack">${escapeHtml(friendly)}</span>
        </div>
      `;
      }).join('');
    }
  } else {
    if (failedWrap) failedWrap.style.display = 'none';
  }
}

// Splice surfaces raw GraphQL/HTTP errors in download failures. The full
// payload is useful when filing a bug, but it makes the UI unreadable when
// every row is a 200-char JSON blob. Collapse known shapes to a short label
// and keep the original in the row's `title` for debugging.
function humanizeDownloadError(raw: string): string {
  if (!raw) return 'Unknown error';

  const gqlMatch = raw.match(/GraphQL\s+(\w+)\s+returned errors:\s*(.+)$/i);
  if (gqlMatch) {
    const op = gqlMatch[1];
    let msg = '';
    try {
      const errs = JSON.parse(gqlMatch[2]);
      if (Array.isArray(errs) && errs[0]?.message) msg = String(errs[0].message);
    } catch { /* fall through */ }
    if (msg) return `Splice ${op}: ${msg}`;
    return `Splice ${op} error`;
  }

  const httpMatch = raw.match(/GraphQL\s+(\w+)\s+failed:\s*(\d{3})/i);
  if (httpMatch) return `Splice ${httpMatch[1]}: HTTP ${httpMatch[2]}`;

  const s3Match = raw.match(/S3 download failed for [^:]+:\s*(\d{3})\s*(.*)$/i);
  if (s3Match) return `S3 ${s3Match[1]} ${s3Match[2]}`.trim();

  if (/No source file in SampleAssetFiles/i.test(raw)) return 'No source file available';

  return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
}

function restart() {
  alsPath = null;
  scanResult = null;
  buckets = null;
  downloadReport = null;
  logEntries = [];
  const input = $('splice-als-path') as HTMLInputElement | null;
  if (input) input.value = '';
  setStage('configure');
  updateScanButton();
}

// --- Init ----------------------------------------------------------------

export function initSpliceRecovery() {
  $('splice-pick-als')?.addEventListener('click', () => void pickAls());
  $('splice-status-pill')?.addEventListener('click', () => { if (!loginStatus?.connected) void startLogin(); });
  $('splice-connect-btn')?.addEventListener('click', () => void startLogin());
  $('splice-to-scan')?.addEventListener('click', () => void runScan());
  $('splice-scan-back')?.addEventListener('click', () => setStage('configure'));
  $('splice-review-back')?.addEventListener('click', () => setStage('configure'));
  $('splice-download-owned')?.addEventListener('click', () => void runDownload());
  $('splice-buy-all')?.addEventListener('click', () => void runBuyAll());
  $('splice-log-copy')?.addEventListener('click', () => void copyLog());
  $('splice-report-restart')?.addEventListener('click', () => restart());

  // Refresh login status whenever the page becomes active.
  const page = $('page-splice-recovery');
  if (page) {
    const observer = new MutationObserver(() => {
      if (page.classList.contains('active')) void refreshLoginStatus();
    });
    observer.observe(page, { attributes: true, attributeFilter: ['class'] });
  }
  // Also kick off an initial check so the pill isn't stuck on "Checking…".
  void refreshLoginStatus();
}
