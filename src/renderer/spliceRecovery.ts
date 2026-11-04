import { escapeHtml, showToast, getErrorMessage, plural } from './shared';
import { confirmAction } from './confirmDialog';
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
// Each scan gets a token. Back bumps it, so a scan that finishes after the user
// left is dropped instead of pulling them into Review with stale buckets.
let scanToken = 0;
// Main can't cancel a Splice search, so a new scan waits for the last one to settle.
let classifyInFlight = false;

const isAre = (n: number) => (n === 1 ? 'is' : 'are');

/** What a search found for one sample, in plain words. */
const RESULT_WORD: Record<'owned' | 'credits' | 'notFound', string> = {
  owned: 'free to download again',
  credits: 'costs a credit',
  notFound: 'not on Splice',
};

// DOM lookups (lazy — page may not be in DOM at module-load time on hot reload)
function $(id: string) { return document.getElementById(id); }

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

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
      if (stepStage === next) btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current');
    });
  }
}

// --- Choose project ------------------------------------------------------

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

// Signed in already? Step 2 answers itself and steps out of the way.
function renderLoginPill() {
  const pill = $('splice-status-pill');
  const text = $('splice-status-text');
  const connectBtn = $('splice-connect-btn') as HTMLButtonElement | null;
  const step = $('splice-step-account');
  const desc = step?.querySelector('.card-desc');
  if (!pill || !text) return;

  pill.classList.remove('status-pill--ok', 'status-pill--warn');
  if (loginStatus?.connected) {
    pill.classList.add('status-pill--ok');
    text.textContent = 'Signed in';
    if (connectBtn) connectBtn.style.display = 'none';
    step?.classList.add('is-done');
    if (desc) desc.textContent = 'You\'re signed in, so Track Lab can see which samples are already in your Splice library.';
  } else {
    pill.classList.add('status-pill--warn');
    text.textContent = 'Not signed in';
    if (connectBtn) connectBtn.style.display = '';
    step?.classList.remove('is-done');
    if (desc) desc.textContent = 'So Track Lab can tell which samples are already in your Splice library. You sign in once in the window that opens, and Track Lab remembers you next time.';
  }
  updateStepCards();
}

function updateStepCards() {
  const project = $('splice-step-project');
  const account = $('splice-step-account');
  const projectDesc = project?.querySelector('.card-desc');
  const pickBtn = $('splice-pick-als');
  project?.classList.toggle('is-done', !!alsPath);
  project?.classList.toggle('is-current', !alsPath);
  account?.classList.toggle('is-current', !!alsPath && !loginStatus?.connected);
  if (pickBtn) pickBtn.textContent = alsPath ? 'Choose another…' : 'Choose project…';
  if (projectDesc) {
    projectDesc.textContent = alsPath
      ? `Using ${baseName(alsPath)}. Track Lab only reads it; the project itself isn't changed.`
      : 'It\'s in your project folder. Track Lab only reads it; the project itself isn\'t changed.';
  }
}

async function startLogin() {
  const btn = $('splice-connect-btn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Opening Splice…'; }
  showToast('info', 'Sign in to Splice', 'A window opens at splice.com. Sign in there, then close the window.');
  try {
    const res = await window.candybar.spliceStartLogin();
    if (!res.ok) {
      showToast('error', 'Couldn\'t open Splice', res.error || 'The sign-in window didn\'t open. Try again.');
    }
  } catch (err) {
    showToast('error', 'Couldn\'t open Splice', getErrorMessage(err));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in to Splice'; }
    await refreshLoginStatus();
    if (loginStatus?.connected) showToast('success', 'Signed in to Splice', 'Track Lab can look up your samples now.');
  }
}

function updateScanButton() {
  const btn = $('splice-to-scan') as HTMLButtonElement | null;
  updateStepCards();
  if (!btn) return;
  btn.disabled = !alsPath || !loginStatus?.connected || classifyInFlight;
  btn.dataset.tooltipDisabled = classifyInFlight
    ? 'Still finishing the last search on Splice. This unlocks in a moment.'
    : !alsPath ? 'Choose your Ableton project first' : 'Sign in to Splice first';
}

// --- Find samples --------------------------------------------------------

async function runScan() {
  if (!alsPath || classifyInFlight) return;
  const token = ++scanToken;
  const projectPath = alsPath;
  setStage('scan');
  const title = $('splice-scan-title');
  const counts = $('splice-scan-counts');
  const current = $('splice-scan-current');
  const progress = $('splice-scan-progress') as HTMLElement | null;

  if (title) title.textContent = 'Reading your project…';
  if (counts) counts.innerHTML = '&nbsp;';
  if (current) current.textContent = '';
  if (progress) { progress.style.width = '0%'; progress.classList.add('is-indeterminate'); }

  const scanRes = await window.candybar.spliceScan(projectPath);
  if (token !== scanToken) return;
  if (!scanRes.success || !scanRes.result) {
    showToast('error', 'Couldn\'t read this project', scanRes.error || 'Track Lab couldn\'t read this .als file. Check it opens in Ableton, then try again.');
    setStage('configure');
    return;
  }
  scanResult = scanRes.result;
  const missingN = scanResult.missing.length;
  if (counts) {
    counts.textContent = `Your project uses ${plural(scanResult.totalRefs, 'sample')}. ${missingN === 0 ? 'None' : missingN.toLocaleString()} ${isAre(missingN)} missing from your computer.`;
  }

  if (missingN === 0) {
    if (title) title.textContent = 'Nothing\'s missing';
    if (progress) { progress.classList.remove('is-indeterminate'); progress.style.width = '100%'; }
    buckets = { owned: [], credits: [], notFound: [] };
    setTimeout(() => { if (token === scanToken) renderReview(); }, 800);
    return;
  }

  // Now look each one up on Splice — listen to progress events
  if (title) title.textContent = `Looking up ${plural(missingN, 'missing sample')} on Splice…`;
  if (progress) progress.classList.remove('is-indeterminate');
  const offProgress = window.candybar.onSpliceProgress((p) => {
    if (token !== scanToken || p.phase !== 'searching') return;
    if (progress) progress.style.width = `${Math.round(((p.index + 1) / p.total) * 100)}%`;
    if (current) current.textContent = `Sample ${p.index + 1} of ${p.total}: ${p.sample.basename}${p.result ? `, ${RESULT_WORD[p.result]}` : ''}`;
  });

  classifyInFlight = true;
  try {
    const classifyRes = await window.candybar.spliceClassify(scanResult.missing);
    if (token !== scanToken) return;
    if (!classifyRes.success || !classifyRes.buckets) {
      showToast('error', 'Couldn\'t search Splice', classifyRes.error || 'Check you\'re still signed in to Splice, then try again.');
      setStage('configure');
      return;
    }
    buckets = classifyRes.buckets;
    renderReview();
  } finally {
    classifyInFlight = false;
    updateScanButton();
    offProgress?.();
  }
}

// Back from the search: drop whatever this scan returns. The search itself keeps
// running in main until it finishes, so the button stays locked until then.
function cancelScan() {
  scanToken++;
  setStage('configure');
  updateScanButton();
}

// --- Review --------------------------------------------------------------

function renderReview() {
  if (!buckets) return;
  setStage('review');
  const owned = buckets.owned.length;
  const credits = buckets.credits.length;
  const notFound = buckets.notFound.length;
  const total = owned + credits + notFound;

  const lead = $('splice-review-lead');
  const sub = $('splice-review-sub');
  if (lead) {
    lead.textContent = total === 0
      ? 'Nothing\'s missing'
      : owned === total
        ? `All ${plural(total, 'missing sample')} are free to download again`
        : `${plural(total, 'sample')} ${isAre(total)} missing from this project`;
  }
  if (sub) {
    if (total === 0) {
      sub.textContent = 'Every sample this project uses is on your computer. Open it in Ableton and carry on.';
    } else {
      const parts: string[] = [];
      if (owned) parts.push(`${owned.toLocaleString()} ${owned === 1 ? 'is' : 'are'} free to download again`);
      if (credits) parts.push(`${credits.toLocaleString()} would cost credits`);
      if (notFound) parts.push(`${notFound.toLocaleString()} ${notFound === 1 ? 'isn\'t' : 'aren\'t'} on Splice`);
      const sentence = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
      sub.textContent = `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.${owned ? ' Nothing costs credits unless you choose to buy.' : ''}`;
    }
  }

  const setCount = (id: string, n: number) => { const el = $(id); if (el) el.textContent = n.toLocaleString(); };
  setCount('splice-owned-count', owned);
  setCount('splice-credits-count', credits);
  setCount('splice-notfound-count', notFound);

  // Only the groups that have something in them; the free ones open, since that's the next step.
  const show = (id: string, n: number, open: boolean) => {
    const el = $(id) as HTMLDetailsElement | null;
    if (!el) return;
    el.hidden = n === 0;
    el.open = open && n > 0;
  };
  show('splice-bucket-owned', owned, owned <= 12);
  show('splice-bucket-credits', credits, false);
  show('splice-bucket-notfound', notFound, false);

  const ownedList = $('splice-owned-list');
  if (ownedList) { ownedList.innerHTML = renderOwnedList(buckets.owned); wireCoverFallbacks(ownedList); }

  const creditsList = $('splice-credits-list');
  if (creditsList) { creditsList.innerHTML = renderCreditsList(buckets.credits); wireCoverFallbacks(creditsList); }

  const notFoundList = $('splice-notfound-list');
  if (notFoundList) notFoundList.innerHTML = renderNotFoundList(buckets.notFound);

  const downloadBtn = $('splice-download-owned') as HTMLButtonElement | null;
  if (downloadBtn) {
    downloadBtn.disabled = owned === 0;
    downloadBtn.style.display = total === 0 ? 'none' : '';
    downloadBtn.textContent = owned > 0 ? `Download ${plural(owned, 'free sample')}` : 'Download free samples';
  }
  const note = $('splice-review-note');
  if (note) {
    note.textContent = total === 0
      ? ''
      : owned > 0 ? 'Free samples download into the folders your project expects.' : 'None of the missing samples are free to download.';
  }
  const back = $('splice-review-back');
  if (back) {
    back.textContent = total === 0 ? 'Choose another project' : 'Back';
    back.className = total === 0 ? 'btn-primary' : 'btn-ghost';
  }

  const buyAllBtn = $('splice-buy-all') as HTMLButtonElement | null;
  if (buyAllBtn) {
    buyAllBtn.disabled = credits === 0;
    buyAllBtn.textContent = credits > 0 ? `Buy ${credits.toLocaleString()} with credits` : 'Buy with credits';
  }

  // Fetch the credits balance without blocking the render.
  if (credits > 0) void refreshCreditsBalance();
}

let creditsBalance: number | null = null;

async function refreshCreditsBalance() {
  const el = $('splice-credits-balance');
  if (!el) return;
  el.textContent = 'Checking your credits…';
  try {
    const res = await window.candybar.spliceCreditsBalance();
    if (res.success && res.balance) {
      creditsBalance = res.balance.credits;
      el.textContent = `You have ${plural(res.balance.credits, 'credit')}.`;
    } else {
      el.textContent = '';
    }
  } catch {
    el.textContent = '';
  }
}

// Splice paths look like .../Splice/Samples/packs/<Pack Name>/<...>/file.wav.
// Plucking the pack name gives a fallback "this came from X" signal when
// Splice's API didn't return one (notFound rows, mostly).
function packNameFromPath(p: string): string | null {
  const m = p.match(/[\\/]packs[\\/]([^\\/]+)/i);
  return m ? m[1].replace(/_/g, ' ') : null;
}

// Cover art rendered as <img>; wireCoverFallbacks swaps a 404'd cover for the
// empty placeholder so the browser's broken-image icon never shows.
function renderCover(url: string | null): string {
  if (!url) return '<div class="splice-bucket-cover splice-bucket-cover-empty"></div>';
  return `<img class="splice-bucket-cover" src="${escapeHtml(url)}" alt="" loading="lazy">`;
}

// Listeners, not inline onerror: the page CSP (script-src 'self') blocks inline handlers.
function wireCoverFallbacks(container: HTMLElement) {
  container.querySelectorAll<HTMLImageElement>('img.splice-bucket-cover').forEach((img) => {
    img.addEventListener('error', () => {
      img.classList.add('splice-bucket-cover-empty');
      img.removeAttribute('src');
    }, { once: true });
  });
}

function renderOwnedList(items: SpliceOwnedItem[]): string {
  if (items.length === 0) return '<p class="card-desc">None of the missing samples are in your Splice library.</p>';
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
  if (items.length === 0) return '<p class="card-desc">Nothing here would cost credits.</p>';
  return items.map((it) => {
    const pack = it.asset.packName ?? packNameFromPath(it.originalPath);
    return `
    <div class="splice-bucket-row" title="${escapeHtml(it.originalPath)}">
      ${renderCover(it.asset.coverUrl)}
      <span class="splice-bucket-name">${escapeHtml(it.basename)}</span>
      ${pack ? `<span class="splice-bucket-pack">${escapeHtml(pack)}</span>` : ''}
      <a href="${escapeHtml(it.spliceUrl)}" target="_blank" rel="noopener">See it on Splice</a>
    </div>
  `;
  }).join('');
}

function renderNotFoundList(items: SpliceNotFoundItem[]): string {
  if (items.length === 0) return '<p class="card-desc">Every missing sample was found on Splice.</p>';
  return items.map((it) => {
    const pack = packNameFromPath(it.originalPath);
    return `
    <div class="splice-bucket-row" title="${escapeHtml(it.error ? `${it.originalPath}\n${it.error}` : it.originalPath)}">
      <div class="splice-bucket-cover splice-bucket-cover-empty"></div>
      <span class="splice-bucket-name">${escapeHtml(it.basename)}</span>
      ${pack ? `<span class="splice-bucket-pack">${escapeHtml(pack)}</span>` : ''}
    </div>
  `;
  }).join('');
}

// --- Download ------------------------------------------------------------

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
    showToast('info', 'Nothing to copy', 'The activity log is empty.');
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
    showToast('error', 'Couldn\'t copy the log', getErrorMessage(err));
  }
}

/** Show the download stage and follow its progress. Returns the unsubscribe. */
function followDownload(heading: string, count: number): () => void {
  setStage('download');
  logEntries = [];
  appendLog(`${heading} (${plural(count, 'sample')})`);
  const logDisclosure = $('splice-log-disclosure') as HTMLDetailsElement | null;
  if (logDisclosure) logDisclosure.open = false;

  const title = $('splice-download-title');
  const counts = $('splice-download-counts');
  const current = $('splice-download-current');
  const progress = $('splice-download-progress') as HTMLElement | null;

  if (title) title.textContent = `${heading}…`;
  if (counts) counts.textContent = `0 of ${plural(count, 'sample')} done`;
  if (current) current.textContent = '';
  if (progress) progress.style.width = '0%';

  let succeeded = 0;
  let failed = 0;
  const off = window.candybar.onSpliceProgress((p: SpliceProgressEvent) => {
    if (p.phase !== 'downloading') return;
    if (progress) progress.style.width = `${Math.round(((p.index + 1) / p.total) * 100)}%`;
    if (current) current.textContent = `Now: ${p.sample.basename}`;
    if (p.status === 'ok') {
      succeeded++;
      appendLog(`Downloaded ${p.sample.basename}`);
    } else if (p.status === 'fail') {
      failed++;
      appendLog(`Couldn't download ${p.sample.basename}: ${p.error || 'no reason given'}`);
    }
    const left = p.total - p.index - 1;
    if (counts) {
      counts.textContent = [
        `${succeeded.toLocaleString()} downloaded`,
        failed ? `${failed.toLocaleString()} didn't download` : '',
        left > 0 ? `${left.toLocaleString()} to go` : '',
      ].filter(Boolean).join(' · ');
    }
  });
  return off;
}

async function runDownload() {
  if (!buckets || buckets.owned.length === 0) return;
  const offProgress = followDownload('Downloading your free samples', buckets.owned.length);
  try {
    const res = await window.candybar.spliceDownloadOwned(buckets.owned);
    if (!res.success || !res.report) {
      showToast('error', 'The download didn\'t finish', res.error || 'Check you\'re still signed in to Splice, then try again.');
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
  if (creditsBalance !== null && creditsBalance < count) {
    showToast('error', 'Not enough credits', `You have ${plural(creditsBalance, 'credit')} and need ${count.toLocaleString()}. Top up on Splice, then try again.`);
    return;
  }
  const s = count === 1 ? '' : 's';
  const ok = await confirmAction({
    title: `Spend ${count.toLocaleString()} Splice credit${s}?`,
    message: 'Each sample costs one credit. Splice doesn\'t refund credits once they\'re spent.',
    details: [
      { label: 'Samples', value: count.toLocaleString() },
      ...(creditsBalance !== null
        ? [{ label: 'Credits now', value: creditsBalance.toLocaleString() },
           { label: 'Credits after', value: (creditsBalance - count).toLocaleString() }]
        : []),
    ],
    safetyNote: 'You keep these samples for good. They download into your Splice folder, where the project expects them.',
    confirmLabel: `Spend ${count.toLocaleString()} credit${s}`,
    tone: 'caution',
    armMs: 1500,
  });
  if (!ok) return;

  const offProgress = followDownload('Buying and downloading samples', count);
  try {
    const res = await window.candybar.spliceBuyCredits(buckets.credits);
    if (!res.success || !res.report) {
      showToast('error', 'The purchase didn\'t finish', res.error || 'Check you\'re still signed in to Splice, then try again.');
      setStage('review');
      return;
    }
    downloadReport = res.report;
    renderReport();
  } finally {
    offProgress?.();
  }
}

// --- Done ----------------------------------------------------------------

function renderReport() {
  if (!downloadReport || !buckets) return;
  setStage('report');
  const { succeeded, attempted } = downloadReport;

  const hero = $('splice-report-hero');
  if (hero) {
    hero.textContent = succeeded === attempted
      ? 'All done! Every sample is back'
      : succeeded === 0
        ? 'None of the samples downloaded'
        : `${succeeded.toLocaleString()} of ${plural(attempted, 'sample')} are back`;
  }
  const icon = $('splice-report-icon');
  if (icon) {
    const ok = succeeded > 0;
    icon.classList.toggle('is-ok', ok);
    icon.classList.toggle('is-warn', !ok);
    icon.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ok
      ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'
      : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}</svg>`;
  }
  const sub = $('splice-report-sub');
  if (sub) {
    sub.textContent = succeeded > 0
      ? 'Reopen the project in Ableton. The recovered samples should load on their own.'
      : 'See why below, then try again.';
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
          <span class="splice-bucket-reason">${escapeHtml(friendly)}</span>
        </div>
      `;
      }).join('');
    }
  } else if (failedWrap) {
    failedWrap.style.display = 'none';
  }
}

// Splice surfaces raw GraphQL/HTTP errors in download failures. The full
// payload is useful when filing a bug, but it makes the UI unreadable when
// every row is a 200-char JSON blob. Collapse known shapes to a short, plain
// reason and keep the original in the row's `title` for debugging.
function humanizeDownloadError(raw: string): string {
  if (!raw) return 'Something went wrong';

  if (/Local Splice samples folder not found/i.test(raw)) {
    return 'Your Splice samples folder wasn\'t found. Install the Splice app, then try again.';
  }

  const gqlMatch = raw.match(/GraphQL\s+(\w+)\s+returned errors:\s*(.+)$/i);
  if (gqlMatch) {
    let msg = '';
    try {
      const errs = JSON.parse(gqlMatch[2]);
      if (Array.isArray(errs) && errs[0]?.message) msg = String(errs[0].message);
    } catch { /* fall through */ }
    return msg ? `Splice said: ${msg}` : 'Splice turned the request down';
  }

  const httpMatch = raw.match(/GraphQL\s+(\w+)\s+failed:\s*(\d{3})/i);
  if (httpMatch) return `Splice didn't respond (error ${httpMatch[2]})`;

  const s3Match = raw.match(/S3 download failed for [^:]+:\s*(\d{3})/i);
  if (s3Match) return `The download failed (error ${s3Match[1]})`;

  if (/No source file in SampleAssetFiles/i.test(raw)) return 'Splice has no file to download for this sample';

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
  $('splice-status-pill')?.addEventListener('click', () => { if (loginStatus && !loginStatus.connected) void startLogin(); });
  $('splice-connect-btn')?.addEventListener('click', () => void startLogin());
  $('splice-to-scan')?.addEventListener('click', () => void runScan());
  $('splice-scan-back')?.addEventListener('click', () => cancelScan());
  $('splice-review-back')?.addEventListener('click', () => {
    // With nothing missing, "Choose another project" starts over.
    if (buckets && buckets.owned.length + buckets.credits.length + buckets.notFound.length === 0) restart();
    else setStage('configure');
  });
  $('splice-download-owned')?.addEventListener('click', () => void runDownload());
  $('splice-buy-all')?.addEventListener('click', () => void runBuyAll());
  $('splice-log-copy')?.addEventListener('click', () => void copyLog());
  $('splice-report-restart')?.addEventListener('click', () => restart());

  // Refresh sign-in status whenever the page becomes active.
  const page = $('page-splice-recovery');
  if (page) {
    const observer = new MutationObserver(() => {
      if (page.classList.contains('active') && currentStage === 'configure') void refreshLoginStatus();
    });
    observer.observe(page, { attributes: true, attributeFilter: ['class'] });
  }
  // Also kick off an initial check so the pill isn't stuck on "Checking…".
  updateStepCards();
  void refreshLoginStatus();
}
