import type { ClaudeAskResult, ClaudeSoundcloudParams, ClaudeSoundcloudResult, ClaudeStatus, ClaudeTrackTagsResult, TrackTagField } from '../types';
import { escapeHtml, showToast, plural } from './shared';
import {
  claudeBridge, startClaudeJob, getClaudeStatus, describeClaudeStatus, ensureClaudeReady, ClaudeJobError,
  type ClaudeJobHandle, type JobLogEntry,
} from './claudeJobs';
import { ensureSourcingReviewButton, SPINNER_SVG } from './claudeReview';

// The Claude page (Ask, SoundCloud free downloads), the Claude section in
// Settings, and the "Ask Claude" button in the track info editor. Every job
// runs headless Claude Code on the user's Claude subscription.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

// ========== Sign-in status ==========

let lastStatus: ClaudeStatus | null = null;

async function refreshStatus(force = false): Promise<void> {
  try {
    await getClaudeStatus(force); // claude-status-changed updates the views
  } catch (err) {
    const pill = $('claude-status-pill');
    if (pill) {
      pill.className = 'status-pill status-pill--danger';
      pill.textContent = 'Couldn\'t check Claude';
    }
    console.error('[Claude] status check failed:', err);
  }
}

function renderStatus(status: ClaudeStatus): void {
  lastStatus = status;
  const view = describeClaudeStatus(status);
  const tone = view.tone === 'ok' ? 'ok' : view.tone === 'warn' ? 'warn' : 'danger';

  const pill = $('claude-status-pill');
  if (pill) {
    pill.className = `status-pill status-pill--${tone}`;
    pill.textContent = view.label;
    pill.dataset.tooltip = view.detail;
  }

  const callout = $('claude-setup-callout');
  if (callout) {
    callout.hidden = view.ready;
    callout.className = `callout callout--${tone === 'danger' ? 'danger' : 'warn'}`;
    const title = $('claude-setup-title');
    const detail = $('claude-setup-detail');
    if (title) title.textContent = status.installed ? 'Connect Claude first' : 'Install Claude Code first';
    if (detail) detail.textContent = view.detail;
    const signIn = $<HTMLButtonElement>('claude-setup-signin');
    if (signIn) signIn.hidden = !status.installed;
  }

  for (const id of ['claude-ask-send', 'claude-sc-start']) {
    const btn = $<HTMLButtonElement>(id);
    if (btn && !btn.classList.contains('is-busy')) btn.disabled = !view.ready;
  }

  renderSettingsStatus(status);
}

async function signIn(): Promise<void> {
  try {
    const { opened, command } = await claudeBridge.claudeOpenLogin();
    if (opened) {
      showToast('info', 'Finish signing in in Terminal', 'A Terminal window opened. Sign in with your Claude account in the browser, then click Check again.', 10000);
    } else {
      showToast('info', 'Sign in from a terminal', `Run this, sign in with your Claude account, then click Check again: ${command}`, 15000);
    }
  } catch (err) {
    showToast('error', 'Couldn\'t start sign-in', err instanceof Error ? err.message : String(err));
  }
}

// ========== Settings → Claude ==========

const MODEL_OPTIONS: [string, string][] = [
  ['', 'Default (Claude Code decides)'],
  ['opus', 'Opus: most careful'],
  ['sonnet', 'Sonnet: faster, uses less of your plan'],
  ['haiku', 'Haiku: fastest, uses the least'],
];

function settingsSectionHtml(): string {
  return `
    <h4>Claude</h4>
    <p class="card-desc claude-settings-intro">Claude jobs (Ask Claude, checking matches, looking up track info, SoundCloud downloads) run on Claude Code and use your Claude subscription. They never use API credits.</p>
    <div class="callout" id="claude-settings-status" role="status">
      <div class="callout-body"><strong>Checking Claude…</strong><p></p></div>
    </div>
    <div class="fields">
      <div class="field">
        <label for="claude-setting-model">Model</label>
        <select id="claude-setting-model">
          ${MODEL_OPTIONS.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('')}
        </select>
        <span class="field-help">Used for every Claude job. Saved as soon as you pick one.</span>
      </div>
      <details class="disclosure">
        <summary>Use a token instead <span class="disclosure-hint">For a computer where Claude Code isn't signed in</span></summary>
        <div class="disclosure-body">
          <div class="field">
            <label for="claude-setting-token">Claude Code token</label>
            <span class="field-desc">In Terminal, run <code>claude setup-token</code>, sign in, and paste the token it prints. It's kept in this computer's secrets file, not in the app's settings.</span>
            <div class="input-row">
              <input type="password" id="claude-setting-token" placeholder="sk-ant-oat01-…" autocomplete="off" spellcheck="false" />
              <button type="button" class="btn-secondary" id="claude-setting-token-save">Save token</button>
            </div>
            <span class="field-help" id="claude-setting-token-help"></span>
          </div>
          <button type="button" class="btn-link" id="claude-setting-token-clear" hidden>Remove the saved token</button>
        </div>
      </details>
    </div>`;
}

/** Add the Claude tab to Settings. Safe to call again; the dialog's tabs are
 *  delegated, so an added item switches like the built-in ones. */
function ensureSettingsSection(): void {
  const modal = $('settings-modal');
  const nav = modal?.querySelector<HTMLElement>('.settings-nav');
  const sections = modal?.querySelector<HTMLElement>('.settings-sections');
  if (!nav || !sections) return;

  if (!nav.querySelector('.settings-nav-item[data-target="claude"]')) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'settings-nav-item';
    item.dataset.target = 'claude';
    item.setAttribute('role', 'tab');
    item.dataset.tooltip = 'Connect your Claude subscription for Claude jobs';
    item.dataset.tooltipPos = 'right';
    item.textContent = 'Claude';
    nav.appendChild(item);
  }

  if (sections.querySelector('.settings-section[data-section="claude"]')) return;
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.dataset.section = 'claude';
  section.setAttribute('role', 'tabpanel');
  section.setAttribute('aria-label', 'Claude');
  section.innerHTML = settingsSectionHtml();
  sections.appendChild(section);

  const model = section.querySelector<HTMLSelectElement>('#claude-setting-model')!;
  const token = section.querySelector<HTMLInputElement>('#claude-setting-token')!;
  const help = section.querySelector<HTMLElement>('#claude-setting-token-help')!;
  const clear = section.querySelector<HTMLButtonElement>('#claude-setting-token-clear')!;

  void window.candybar.getConfig().then((config) => {
    model.value = config.claudeModel ?? '';
    clear.hidden = !config.claudeOauthToken;
    help.textContent = config.claudeOauthToken ? 'A token is saved. Jobs use it instead of Claude Code\'s own sign-in.' : '';
    help.className = 'field-help';
  }).catch(() => {});

  model.addEventListener('change', async () => {
    try {
      await window.candybar.updateConfig({ claudeModel: model.value });
      showToast('success', 'Model saved', model.value ? `Claude jobs use ${model.selectedOptions[0]?.textContent?.split(':')[0]}.` : 'Claude jobs use Claude Code\'s default model.');
    } catch (err) {
      showToast('error', 'Couldn\'t save the model', err instanceof Error ? err.message : String(err));
    }
  });

  section.querySelector('#claude-setting-token-save')!.addEventListener('click', async () => {
    const value = token.value.trim();
    if (!value) {
      help.textContent = 'Paste the token from claude setup-token first.';
      help.className = 'field-help is-warn';
      return;
    }
    if (value.startsWith('sk-ant-api')) {
      help.textContent = 'That\'s an API key, which would bill API credits. Use the token from claude setup-token instead.';
      help.className = 'field-help is-error';
      return;
    }
    try {
      await window.candybar.updateConfig({ claudeOauthToken: value });
      token.value = '';
      clear.hidden = false;
      help.textContent = value.startsWith('sk-ant-oat')
        ? 'Token saved. Jobs use it instead of Claude Code\'s own sign-in.'
        : 'Saved, but it doesn\'t look like a Claude Code token (those start with sk-ant-oat). If jobs fail, run claude setup-token again.';
      help.className = value.startsWith('sk-ant-oat') ? 'field-help is-ok' : 'field-help is-warn';
      void refreshStatus(true);
    } catch (err) {
      showToast('error', 'Couldn\'t save the token', err instanceof Error ? err.message : String(err));
    }
  });

  clear.addEventListener('click', async () => {
    try {
      await window.candybar.updateConfig({ claudeOauthToken: '' });
      clear.hidden = true;
      help.textContent = 'Token removed. Jobs use Claude Code\'s own sign-in.';
      help.className = 'field-help';
      void refreshStatus(true);
    } catch (err) {
      showToast('error', 'Couldn\'t remove the token', err instanceof Error ? err.message : String(err));
    }
  });

  if (lastStatus) renderSettingsStatus(lastStatus);
}

function renderSettingsStatus(status: ClaudeStatus): void {
  const box = $('claude-settings-status');
  if (!box) return;
  const view = describeClaudeStatus(status);
  const tone = view.ready ? 'success' : view.tone === 'danger' ? 'danger' : 'warn';
  box.className = `callout callout--${tone}`;
  const where = status.installed
    ? `<span class="claude-settings-meta">Claude Code ${escapeHtml(status.version ?? '')} · ${escapeHtml(status.binaryPath ?? '')}</span>`
    : '';
  box.innerHTML = `
    <div class="callout-body">
      <strong>${escapeHtml(view.label)}</strong>
      <p>${escapeHtml(view.detail)}</p>
      ${where}
    </div>
    <div class="callout-actions">
      ${status.installed && !view.ready ? '<button type="button" class="btn-primary btn-sm" data-claude-action="signin">Sign in to Claude</button>' : ''}
      <button type="button" class="btn-ghost btn-sm" data-claude-action="recheck">Check again</button>
    </div>`;
}

// ========== Ask ==========

type AskMessage = { who: 'you' | 'claude' | 'error'; text: string; steps?: string[] };
const ASK_KEY = 'candybar-claude-ask';
let askSession: string | null = null;
let askMessages: AskMessage[] = [];
let askJob: ClaudeJobHandle<ClaudeAskResult> | null = null;

function loadAsk(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(ASK_KEY) || 'null');
    if (saved) {
      askSession = saved.sessionId ?? null;
      askMessages = Array.isArray(saved.messages) ? saved.messages : [];
    }
  } catch { /* nothing saved */ }
}

function saveAsk(): void {
  try {
    localStorage.setItem(ASK_KEY, JSON.stringify({ sessionId: askSession, messages: askMessages.slice(-50) }));
  } catch { /* storage unavailable */ }
}

/** Claude writes light markdown: paragraphs, lists, **bold**, `code`, links. */
function renderClaudeText(text: string): string {
  const inline = (s: string) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-external-link>$1</a>');
  const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+/;
  // Within a block, runs of list lines become a list and the rest a
  // paragraph, so "Two options:" followed by "- a" / "- b" reads right.
  return text.trim().split(/\n{2,}/).map((block) => {
    const out: string[] = [];
    let run: string[] = [];
    let runIsList = false;
    const flush = () => {
      if (!run.length) return;
      if (runIsList) {
        const tag = /^\s*\d/.test(run[0]) ? 'ol' : 'ul';
        out.push(`<${tag}>${run.map(l => `<li>${inline(l.replace(LIST_ITEM, ''))}</li>`).join('')}</${tag}>`);
      } else if (run.length === 1 && /^#{1,4}\s/.test(run[0])) {
        out.push(`<p><strong>${inline(run[0].replace(/^#+\s*/, ''))}</strong></p>`);
      } else {
        out.push(`<p>${run.map(inline).join('<br>')}</p>`);
      }
      run = [];
    };
    for (const line of block.split('\n').filter(l => l.trim())) {
      const isList = LIST_ITEM.test(line);
      if (run.length && isList !== runIsList) flush();
      runIsList = isList;
      run.push(line);
    }
    flush();
    return out.join('');
  }).join('');
}

function stepsLine(steps: string[]): string {
  const unique = [...new Set(steps)];
  return unique.length ? `<span class="claude-msg-steps">Checked: ${escapeHtml(unique.join(', '))}</span>` : '';
}

function renderAsk(live?: { steps: string[]; text: string; status: string }): void {
  const thread = $('claude-ask-thread');
  if (!thread) return;
  const items = askMessages.map((m) => {
    if (m.who === 'you') return `<div class="claude-msg claude-msg--you"><span class="claude-msg-who">You</span><div class="claude-msg-body">${renderClaudeText(m.text)}</div></div>`;
    if (m.who === 'error') return `<div class="callout callout--danger claude-msg-error" role="alert"><div class="callout-body"><strong>Claude couldn't answer</strong><p>${escapeHtml(m.text)}</p></div></div>`;
    return `<div class="claude-msg claude-msg--claude"><span class="claude-msg-who">Claude</span><div class="claude-msg-body">${renderClaudeText(m.text)}</div>${stepsLine(m.steps ?? [])}</div>`;
  });
  if (live) {
    items.push(`<div class="claude-msg claude-msg--claude is-live" aria-busy="true"><span class="claude-msg-who">Claude</span>
      <div class="claude-msg-status">${SPINNER_SVG}<span>${escapeHtml(live.status)}</span></div>
      ${live.text ? `<div class="claude-msg-body">${renderClaudeText(live.text)}</div>` : ''}
      ${stepsLine(live.steps)}</div>`);
  }
  thread.innerHTML = items.join('');
  thread.hidden = items.length === 0;
  const fresh = $<HTMLButtonElement>('claude-ask-new');
  if (fresh) fresh.hidden = askMessages.length === 0 || !!askJob;
  thread.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

function setAskBusy(busy: boolean): void {
  const send = $<HTMLButtonElement>('claude-ask-send');
  const input = $<HTMLTextAreaElement>('claude-ask-input');
  if (send) {
    send.textContent = busy ? 'Stop' : askMessages.length ? 'Ask a follow-up' : 'Ask Claude';
    send.className = busy ? 'btn-secondary is-busy' : 'btn-primary';
    send.disabled = !busy && !!lastStatus && !describeClaudeStatus(lastStatus).ready;
  }
  if (input) input.disabled = busy;
}

async function sendAsk(): Promise<void> {
  if (askJob) {
    askJob.cancel();
    return;
  }
  const input = $<HTMLTextAreaElement>('claude-ask-input');
  const prompt = input?.value.trim() ?? '';
  if (!prompt) {
    input?.focus();
    return;
  }
  if (!await ensureClaudeReady()) return;

  askMessages.push({ who: 'you', text: prompt });
  if (input) input.value = '';
  const live = { steps: [] as string[], text: '', status: 'Starting Claude…' };
  renderAsk(live);
  setAskBusy(true);
  try {
    askJob = await startClaudeJob<ClaudeAskResult>('claude-ask', { prompt, sessionId: askSession ?? undefined }, {
      onLog: (e: JobLogEntry) => {
        if (e.stream === 'stdout') live.text = e.text;
        else if (e.stream === 'status' && e.text.startsWith('→ ')) {
          live.steps.push(e.text.slice(2));
          live.status = `Using ${e.text.slice(2)}…`;
        } else if (e.stream === 'status') live.status = 'Thinking…';
        renderAsk(live);
      },
    });
    const result = await askJob.result;
    askSession = result.sessionId ?? askSession;
    askMessages.push({ who: 'claude', text: result.text || live.text || 'Done.', steps: live.steps });
  } catch (err) {
    if (err instanceof ClaudeJobError && err.cancelled) {
      askMessages.push({ who: 'error', text: 'Stopped before Claude finished.' });
    } else {
      askMessages.push({ who: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    askJob = null;
    saveAsk();
    setAskBusy(false);
    renderAsk();
  }
}

function newConversation(): void {
  if (askJob) return;
  askSession = null;
  askMessages = [];
  saveAsk();
  setAskBusy(false);
  renderAsk();
  $('claude-ask-input')?.focus();
}

// ========== SoundCloud free downloads ==========

const SC_KEY = 'candybar-claude-soundcloud';
let scJob: ClaudeJobHandle<ClaudeSoundcloudResult> | null = null;
let scLast: ClaudeSoundcloudResult | null = null;
const scLog: string[] = [];

function scOptions(): ClaudeSoundcloudParams {
  const val = (id: string) => ($<HTMLInputElement>(id)?.value ?? '').trim();
  const checked = (id: string) => !!$<HTMLInputElement>(id)?.checked;
  const limit = Number(val('claude-sc-limit'));
  return {
    setUrl: val('claude-sc-url') || undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    since: val('claude-sc-since') || undefined,
    email: val('claude-sc-email') || undefined,
    listOnly: checked('claude-sc-list-only'),
    dropLossy: checked('claude-sc-drop-lossy'),
    accountActions: checked('claude-sc-actions'),
  };
}

function setScBusy(busy: boolean): void {
  const start = $<HTMLButtonElement>('claude-sc-start');
  if (start) {
    start.className = busy ? 'btn-secondary is-busy' : 'btn-primary';
    start.textContent = busy ? 'Stop' : 'Get free downloads';
    start.disabled = !busy && !!lastStatus && !describeClaudeStatus(lastStatus).ready;
  }
  const resume = $<HTMLButtonElement>('claude-sc-resume');
  if (resume) resume.hidden = busy || !scLast || !(scLast.review?.resumeWorthIt ?? (scLast.counts.flagged ?? 0) > 0);
  const progress = $('claude-sc-progress');
  if (progress) progress.hidden = !busy;
  for (const id of ['claude-sc-url', 'claude-sc-limit', 'claude-sc-since', 'claude-sc-email', 'claude-sc-list-only', 'claude-sc-drop-lossy', 'claude-sc-actions']) {
    const el = $<HTMLInputElement>(id);
    if (el) el.disabled = busy;
  }
}

function scProgress(message: string): void {
  const msg = $('claude-sc-progress-message');
  if (msg) msg.textContent = message;
  const log = $('claude-sc-log');
  if (log) {
    log.textContent = scLog.join('\n');
    log.scrollTop = log.scrollHeight;
  }
}

function scHeadline(r: ClaudeSoundcloudResult): string {
  const c = r.counts;
  const parts = [`${plural(c.downloaded ?? 0, 'track')} downloaded in full quality`];
  if (c.flagged) parts.push(`${plural(c.flagged, 'track')} need a look`);
  if (c.notFree) parts.push(`${plural(c.notFree, 'track')} aren't free`);
  if (c.queue) parts.push(`${c.queue.toLocaleString()} not fetched yet`);
  return `${parts.join(', ')}.`;
}

function renderScResult(): void {
  const box = $('claude-sc-result');
  if (!box) return;
  const r = scLast;
  if (!r) {
    box.innerHTML = '';
    return;
  }
  const review = r.review;
  const warn = (r.counts.flagged ?? 0) > 0 || (review?.needsYou.length ?? 0) > 0;
  const list = <T,>(title: string, items: T[], row: (i: T) => string, tag = 'ul') => items.length
    ? `<div class="claude-sc-list"><h4>${escapeHtml(title)}</h4><${tag}>${items.map(i => `<li>${row(i)}</li>`).join('')}</${tag}></div>`
    : '';
  box.innerHTML = `
    <div class="callout callout--${warn ? 'warn' : 'success'}" role="status">
      <div class="callout-body">
        <strong>${escapeHtml(scHeadline(r))}</strong>
        <p>${escapeHtml(review?.summary ?? (r.reviewError ? `Claude couldn't review the run: ${r.reviewError}` : ''))}</p>
      </div>
    </div>
    ${review ? list(`Needs you (${review.needsYou.length})`, review.needsYou, (n) =>
      `<strong>${escapeHtml(n.artist)} – ${escapeHtml(n.title)}</strong><span>${escapeHtml(n.reason)}</span><span class="claude-sc-action">${escapeHtml(n.action)}</span>`) : ''}
    ${review ? list(`Maybe already in your library (${review.possibleDuplicates.length})`, review.possibleDuplicates, (d) =>
      `<strong>${escapeHtml(d.artist)} – ${escapeHtml(d.title)}</strong><span>You may have it as ${escapeHtml(d.ownedAs)}. Downloaded file: ${escapeHtml(d.file)}</span>`) : ''}
    ${review ? list('What to do next', review.nextSteps, (s) => escapeHtml(s), 'ol') : ''}
    <details class="disclosure">
      <summary>Show details</summary>
      <div class="disclosure-body">
        <p class="field-help">Everything this run found is saved in <code>${escapeHtml(r.sessionPath)}</code>.</p>
        <button type="button" class="btn-link" id="claude-sc-show-session">Show in Finder</button>
      </div>
    </details>`;
  box.querySelector('#claude-sc-show-session')?.addEventListener('click', () => void window.candybar.showInFinder(r.sessionPath));
}

async function startSoundcloud(resume: boolean): Promise<void> {
  if (scJob) {
    scJob.cancel();
    return;
  }
  if (!await ensureClaudeReady()) return;
  const params = scOptions();
  if (resume && scLast) params.resumeSessionPath = scLast.sessionPath;

  scLog.length = 0;
  setScBusy(true);
  scProgress(resume ? 'Retrying the gates that stalled…' : 'Reading SoundCloud…');
  try {
    scJob = await startClaudeJob<ClaudeSoundcloudResult>('claude-soundcloud', params, {
      onLog: (e) => {
        scLog.push(e.text);
        if (scLog.length > 400) scLog.shift();
        scProgress(e.text.startsWith('→ ') ? `Claude is ${e.text.slice(2)}…` : e.text.slice(0, 160));
      },
    });
    scLast = await scJob.result;
    try { localStorage.setItem(SC_KEY, JSON.stringify(scLast)); } catch { /* storage unavailable */ }
    renderScResult();
    showToast('success', 'SoundCloud run finished', scHeadline(scLast));
  } catch (err) {
    if (!(err instanceof ClaudeJobError && err.cancelled)) {
      showToast('error', 'The SoundCloud run stopped', err instanceof Error ? err.message : String(err), 10000);
    }
  } finally {
    scJob = null;
    setScBusy(false);
  }
}

// ========== Track info editor: Ask Claude ==========

const TAG_INPUTS: Record<TrackTagField, string> = {
  title: 'edit-title', artist: 'edit-artist', remixer: 'edit-remixer', album: 'edit-album', genre: 'edit-genre',
  year: 'edit-year', bpm: 'edit-bpm', key: 'edit-key', label: 'edit-label',
};
const TAG_LABELS: Record<TrackTagField, string> = {
  title: 'Title', artist: 'Artist', remixer: 'Remixer', album: 'Album', genre: 'Genre', year: 'Year', bpm: 'BPM', key: 'Key', label: 'Label',
};
let tagJob: ClaudeJobHandle<ClaudeTrackTagsResult> | null = null;

function tagValue(id: string): string {
  return ($<HTMLInputElement>(id)?.value ?? '').trim();
}

function setTagValue(id: string, value: string): void {
  const el = $<HTMLInputElement>(id);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setTagButton(btn: HTMLButtonElement, busy: boolean): void {
  btn.classList.toggle('is-busy', busy);
  btn.innerHTML = busy ? `${SPINNER_SVG}<span>Looking up… stop</span>` : 'Ask Claude';
}

function clearTagNote(): void {
  $('tag-editor-claude-note')?.remove();
}

function showTagNote(filePath: string, r: ClaudeTrackTagsResult): void {
  clearTagNote();
  const body = document.querySelector<HTMLElement>('#tag-editor-modal .drawer-body');
  if (!body) return;
  const filled: string[] = [];
  const differs: TrackTagField[] = [];
  const autoFill = r.confidence !== 'low';
  for (const field of Object.keys(TAG_INPUTS) as TrackTagField[]) {
    const suggestion = r.fields[field];
    if (!suggestion) continue;
    const current = tagValue(TAG_INPUTS[field]);
    if (!current && autoFill) {
      setTagValue(TAG_INPUTS[field], suggestion);
      filled.push(TAG_LABELS[field]);
    } else if (current.toLowerCase() !== suggestion.toLowerCase()) {
      differs.push(field);
    }
  }

  const note = document.createElement('div');
  note.id = 'tag-editor-claude-note';
  note.dataset.file = filePath;
  note.className = `callout callout--${r.confidence === 'high' ? 'success' : 'info'} claude-tag-note`;
  const where = r.source ? ` on ${escapeHtml(r.source)}` : '';
  const sure = r.confidence === 'high' ? '' : r.confidence === 'medium' ? ' (fairly sure)' : ' (not sure, so nothing was filled in)';
  note.innerHTML = `
    <div class="callout-body">
      <strong>${filled.length || differs.length ? `Claude found this track${where}${sure}` : 'Claude couldn\'t pin this track down'}</strong>
      <p>${escapeHtml(r.notes)}</p>
      ${filled.length ? `<p>Filled in: ${escapeHtml(filled.join(', '))}. Nothing is saved until you click Save.</p>` : ''}
      ${differs.length ? `<ul class="claude-tag-diffs">${differs.map(f => `
        <li><span><strong>${TAG_LABELS[f]}:</strong> ${escapeHtml(r.fields[f])}${tagValue(TAG_INPUTS[f]) ? ` <span class="claude-tag-was">(you have ${escapeHtml(tagValue(TAG_INPUTS[f]))})</span>` : ''}</span>
        <button type="button" class="btn-ghost btn-sm" data-claude-use="${f}">Use this</button></li>`).join('')}</ul>` : ''}
    </div>
    ${r.sourceUrl ? '<div class="callout-actions"><button type="button" class="btn-link" data-claude-open>Open the listing</button></div>' : ''}`;
  note.querySelectorAll<HTMLButtonElement>('[data-claude-use]').forEach((b) => {
    b.addEventListener('click', () => {
      const field = b.dataset.claudeUse as TrackTagField;
      setTagValue(TAG_INPUTS[field], r.fields[field]);
      b.closest('li')?.remove();
    });
  });
  note.querySelector('[data-claude-open]')?.addEventListener('click', () => void window.candybar.openExternal(r.sourceUrl));
  body.insertBefore(note, body.firstChild);
}

async function askClaudeForTags(btn: HTMLButtonElement): Promise<void> {
  if (tagJob) {
    tagJob.cancel();
    return;
  }
  const filePath = tagValue('edit-file-path');
  if (!filePath) return;
  if (!await ensureClaudeReady()) return;
  const tags = Object.fromEntries([
    ...(Object.entries(TAG_INPUTS) as [TrackTagField, string][]).map(([f, id]) => [f, tagValue(id)]),
    ['comment', tagValue('edit-comment')],
  ]) as Record<TrackTagField | 'comment', string>;

  setTagButton(btn, true);
  clearTagNote();
  try {
    tagJob = await startClaudeJob<ClaudeTrackTagsResult>('claude-track-tags', { filePath, tags });
    const result = await tagJob.result;
    // The editor may have closed, or moved to another track, while Claude looked.
    const modal = $('tag-editor-modal');
    if (tagValue('edit-file-path') !== filePath || !modal || modal.style.display === 'none') return;
    showTagNote(filePath, result);
  } catch (err) {
    if (!(err instanceof ClaudeJobError && err.cancelled)) {
      showToast('error', 'Claude couldn\'t look this track up', err instanceof Error ? err.message : String(err));
    }
  } finally {
    tagJob = null;
    if (btn.isConnected) setTagButton(btn, false);
  }
}

/** Put "Ask Claude" beside Scan Tags. Safe to call again after a re-render. */
function ensureTagEditorButton(): void {
  const anchor = $('scan-tags');
  if (!anchor?.parentElement) return;
  let btn = $<HTMLButtonElement>('tag-editor-ask-claude');
  if (btn && btn.previousElementSibling === anchor) return;
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'tag-editor-ask-claude';
    btn.className = 'btn-ghost claude-tag-btn';
    btn.dataset.tooltip = 'Claude looks this track up on Beatport, Qobuz and the web and fills in what\'s missing. Nothing is saved until you click Save.';
    setTagButton(btn, !!tagJob);
    btn.addEventListener('click', () => void askClaudeForTags(btn!));
  }
  anchor.insertAdjacentElement('afterend', btn);
}

// ========== Init ==========

/** Re-add injected controls if a screen re-rendered the area they sit in. */
let ensureQueued = false;
function ensureInjected(): void {
  if (ensureQueued) return;
  ensureQueued = true;
  requestAnimationFrame(() => {
    ensureQueued = false;
    ensureSettingsSection();
    ensureTagEditorButton();
    ensureSourcingReviewButton();
    // A note belongs to the track it was found for; drop it when the editor
    // closes or opens on another file.
    const note = $('tag-editor-claude-note');
    const modal = $('tag-editor-modal');
    if (note && (!modal || modal.style.display === 'none' || note.dataset.file !== tagValue('edit-file-path'))) note.remove();
  });
}

export function initClaude(): void {
  window.addEventListener('claude-status-changed', (e) => renderStatus((e as CustomEvent<ClaudeStatus>).detail));

  loadAsk();
  renderAsk();
  setAskBusy(false);
  $('claude-ask-send')?.addEventListener('click', () => void sendAsk());
  $('claude-ask-new')?.addEventListener('click', newConversation);
  $<HTMLTextAreaElement>('claude-ask-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void sendAsk();
    }
  });
  $('claude-ask-thread')?.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-external-link]');
    if (!link) return;
    e.preventDefault();
    void window.candybar.openExternal(link.href);
  });

  try { scLast = JSON.parse(localStorage.getItem(SC_KEY) || 'null'); } catch { scLast = null; }
  renderScResult();
  setScBusy(false);
  $('claude-sc-start')?.addEventListener('click', () => void startSoundcloud(false));
  $('claude-sc-resume')?.addEventListener('click', () => void startSoundcloud(true));

  $('claude-setup-signin')?.addEventListener('click', () => void signIn());
  $('claude-setup-recheck')?.addEventListener('click', () => void refreshStatus(true));
  document.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-claude-action]')?.dataset.claudeAction;
    if (action === 'signin') void signIn();
    else if (action === 'recheck') void refreshStatus(true);
  });
  document.querySelector('.nav-link[data-page="claude"]')?.addEventListener('click', () => void refreshStatus());
  document.querySelector('.settings-nav')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.settings-nav-item[data-target="claude"]')) void refreshStatus();
  });

  ensureSettingsSection();
  ensureTagEditorButton();
  new MutationObserver(ensureInjected).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  void refreshStatus();
}
