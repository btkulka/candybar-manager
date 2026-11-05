import type { ClaudeAskResult, ClaudeProfile, ClaudeSoundcloudParams, ClaudeSoundcloudResult, ClaudeStatus, ClaudeTrackTagsResult, TrackTagField } from '../types';
import { PROFILE_QUESTIONS } from '../lib/claude/userProfile';
import { escapeHtml, showToast, plural, setActiveTab } from './shared';
import { sourceWithClaude } from './source';
import { upgradeWithClaude } from './upgrade';
import {
  claudeBridge, startClaudeJob, getClaudeStatus, describeClaudeStatus, ensureClaudeReady, ClaudeJobError,
  type ClaudeJobHandle, type JobLogEntry,
} from './claudeJobs';
import { ensureSourcingReviewButton, SPINNER_SVG } from './claudeReview';

// Ask Claude (the round button and its chat drawer: first-run questions, the
// chat, and Claude's settings behind the gear), the Claude skills page (its skill picker and the SoundCloud downloads form),
// and the "Ask Claude" button in the track info editor. Every job runs
// headless Claude Code on the user's Claude subscription.

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
  renderFab();
}

/** The round button's badge: a spinner while Claude is answering (so closing
 *  the drawer doesn't hide that it's working), a dot when it needs setting up. */
function renderFab(): void {
  const fab = $('claude-fab');
  const badge = $('claude-fab-badge');
  if (!fab || !badge) return;
  const needsSetup = !!lastStatus && !describeClaudeStatus(lastStatus).ready;
  const state = askJob ? 'busy' : needsSetup ? 'setup' : '';
  badge.hidden = !state;
  badge.dataset.state = state;
  fab.dataset.tooltip = askJob ? 'Claude is answering' : needsSetup ? 'Ask Claude: connect it first' : 'Ask Claude about your music';
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
    <h4>Connection</h4>
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
      <div class="field">
        <label class="checkbox-label"><input type="checkbox" id="claude-setting-find-matches" checked /> <span>Find store matches with Claude</span></label>
        <span class="field-help">On Find &amp; buy, small fast Claude sessions (Haiku) pick the exact record for each track on Beatport and Qobuz, and search again when the first results don't have it. Off, or when Claude isn't connected, the plain search's matches are used.</span>
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

/** About you: the first-run answers, changeable here. */
function profileSettingsHtml(): string {
  return `
    <h4>About you</h4>
    <p class="card-desc">Claude fits its answers to these, on top of what it already remembers.</p>
    <div class="fields">
      ${PROFILE_QUESTIONS.map((q) => `
        <div class="field">
          <label for="claude-profile-${q.key}">${escapeHtml(q.question)}</label>
          <select id="claude-profile-${q.key}" data-profile-key="${q.key}">
            <option value="">Rather not say</option>
            ${q.options.map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('')}
          </select>
        </div>`).join('')}
    </div>`;
}

/** Claude's settings, behind the chat drawer's gear: the connection, model and
 *  token, then About you. Mounted once into `container`. */
function mountClaudeSettings(container: HTMLElement): void {
  if (container.querySelector('.claude-settings')) {
    syncProfileSelects(container);
    return;
  }
  const section = document.createElement('div');
  section.className = 'claude-settings';
  section.innerHTML = settingsSectionHtml() + profileSettingsHtml();
  container.appendChild(section);

  syncProfileSelects(section);
  for (const select of section.querySelectorAll<HTMLSelectElement>('select[data-profile-key]')) {
    select.addEventListener('change', async () => {
      const key = select.dataset.profileKey as keyof Omit<ClaudeProfile, 'answeredAt'>;
      const next = { ...(profile ?? {}), answeredAt: profile?.answeredAt ?? new Date().toISOString() } as ClaudeProfile;
      if (select.value) (next as Record<string, string>)[key] = select.value;
      else delete next[key];
      if (await saveProfile(next)) showToast('success', 'Saved', 'Claude uses it from your next question.');
    });
  }

  const model = section.querySelector<HTMLSelectElement>('#claude-setting-model')!;
  const token = section.querySelector<HTMLInputElement>('#claude-setting-token')!;
  const help = section.querySelector<HTMLElement>('#claude-setting-token-help')!;
  const clear = section.querySelector<HTMLButtonElement>('#claude-setting-token-clear')!;

  const findMatches = section.querySelector<HTMLInputElement>('#claude-setting-find-matches')!;
  findMatches.addEventListener('change', async () => {
    try {
      await window.candybar.updateConfig({ claudeFindMatches: findMatches.checked });
      showToast('success', 'Saved', findMatches.checked
        ? 'Find & buy has Claude pick the records from your next check.'
        : 'Find & buy uses the plain search from your next check.');
    } catch (err) {
      findMatches.checked = !findMatches.checked;
      showToast('error', 'Couldn\'t save that', err instanceof Error ? err.message : String(err));
    }
  });

  void window.candybar.getConfig().then((config) => {
    findMatches.checked = config.claudeFindMatches !== false;
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

function syncProfileSelects(root: HTMLElement): void {
  for (const select of root.querySelectorAll<HTMLSelectElement>('select[data-profile-key]')) {
    select.value = (profile?.[select.dataset.profileKey as keyof ClaudeProfile] as string | undefined) ?? '';
  }
}

// ========== The chat drawer ==========

type ChatView = 'intro' | 'chat' | 'settings';

/** The first-run answers; undefined until read from settings, null when the
 *  questions haven't been answered or skipped yet. */
let profile: ClaudeProfile | null | undefined;
let chatView: ChatView = 'chat';
let chatReturnFocus: HTMLElement | null = null;

async function saveProfile(next: ClaudeProfile): Promise<boolean> {
  try {
    await window.candybar.updateConfig({ claudeProfile: next });
    profile = next;
    return true;
  } catch (err) {
    showToast('error', 'Couldn\'t save that', err instanceof Error ? err.message : String(err));
    return false;
  }
}

function chatIsOpen(): boolean {
  const drawer = $('claude-chat-drawer');
  return !!drawer && drawer.style.display !== 'none';
}

async function openChat(view?: ChatView): Promise<void> {
  const drawer = $('claude-chat-drawer');
  const scrim = $('claude-chat-scrim');
  if (!drawer || !scrim) return;
  if (!chatIsOpen()) chatReturnFocus = document.activeElement as HTMLElement | null;
  scrim.style.display = '';
  drawer.style.display = 'flex';
  $('claude-fab')?.setAttribute('aria-expanded', 'true');
  if (profile === undefined) {
    try { profile = (await window.candybar.getConfig()).claudeProfile ?? null; } catch { profile = null; }
  }
  // The questions come first, once; after that the chat (or what was asked for).
  showChatView(!profile && view !== 'settings' ? 'intro' : view ?? 'chat');
  void refreshStatus();
}

function closeChat(): void {
  const drawer = $('claude-chat-drawer');
  const scrim = $('claude-chat-scrim');
  if (!drawer || !scrim || !chatIsOpen()) return;
  drawer.style.display = 'none';
  scrim.style.display = 'none';
  $('claude-fab')?.setAttribute('aria-expanded', 'false');
  if (chatReturnFocus?.isConnected) chatReturnFocus.focus({ preventScroll: true });
  chatReturnFocus = null;
}

function showChatView(view: ChatView): void {
  chatView = view;
  for (const el of document.querySelectorAll<HTMLElement>('#claude-chat-drawer .claude-chat-view')) el.hidden = el.dataset.view !== view;
  const compose = $('claude-chat-compose');
  if (compose) compose.hidden = view !== 'chat';
  $('claude-chat-settings')?.setAttribute('aria-pressed', String(view === 'settings'));
  const title = $('claude-chat-title');
  if (title) title.textContent = view === 'settings' ? 'Claude settings' : 'Ask Claude';
  if (view === 'settings') {
    const box = $('claude-chat-settings-view');
    if (box) mountClaudeSettings(box);
    $('claude-chat-close')?.focus({ preventScroll: true });
  } else if (view === 'intro') {
    renderIntro();
  } else {
    renderAsk();
    $<HTMLTextAreaElement>('claude-ask-input')?.focus({ preventScroll: true });
  }
}

/** The three questions, the first time Ask Claude opens. */
function renderIntro(): void {
  const box = $('claude-chat-intro');
  if (!box) return;
  box.innerHTML = `
    <div class="claude-intro">
      <h4>Before your first question</h4>
      <p class="card-desc">Three quick questions so Claude answers at the right level. You can change them any time under the gear.</p>
      ${PROFILE_QUESTIONS.map((q) => `
        <fieldset class="claude-intro-q">
          <legend>${escapeHtml(q.question)}</legend>
          <div class="claude-intro-options">
            ${q.options.map((o) => `
              <label class="claude-intro-option">
                <input type="radio" name="claude-intro-${q.key}" value="${o.value}"${profile?.[q.key] === o.value ? ' checked' : ''} />
                <span><strong>${escapeHtml(o.label)}</strong><span>${escapeHtml(o.hint)}</span></span>
              </label>`).join('')}
          </div>
        </fieldset>`).join('')}
      <div class="claude-intro-actions">
        <button type="button" class="btn-ghost" id="claude-intro-skip" data-tooltip="Claude answers without knowing these">Skip</button>
        <button type="button" class="btn-primary" id="claude-intro-save">Start chatting</button>
      </div>
    </div>`;
  box.querySelector('#claude-intro-save')?.addEventListener('click', async () => {
    const next: ClaudeProfile = { answeredAt: new Date().toISOString() };
    for (const q of PROFILE_QUESTIONS) {
      const picked = box.querySelector<HTMLInputElement>(`input[name="claude-intro-${q.key}"]:checked`)?.value;
      if (picked) (next as Record<string, string>)[q.key] = picked;
    }
    if (await saveProfile(next)) showChatView('chat');
  });
  box.querySelector('#claude-intro-skip')?.addEventListener('click', async () => {
    if (await saveProfile({ answeredAt: new Date().toISOString() })) showChatView('chat');
  });
  box.querySelector<HTMLInputElement>('input[type="radio"]')?.focus({ preventScroll: true });
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
  const empty = $('claude-chat-empty');
  if (empty) empty.hidden = items.length > 0;
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
  renderFab();
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
    ensureTagEditorButton();
    ensureSourcingReviewButton();
    // A note belongs to the track it was found for; drop it when the editor
    // closes or opens on another file.
    const note = $('tag-editor-claude-note');
    const modal = $('tag-editor-modal');
    if (note && (!modal || modal.style.display === 'none' || note.dataset.file !== tagValue('edit-file-path'))) note.remove();
  });
}

// ---------- Claude skills: the picker ----------
//
// Each card hands a job to the page that owns its results, then has Claude
// review them there with Track Lab's skill: Find & buy for a playlist,
// Upgrade quality for a Rekordbox playlist. The SoundCloud card opens the
// downloads form below.

const SPOTIFY_PLAYLIST_RE = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/[A-Za-z0-9]+|^spotify:playlist:[A-Za-z0-9]+/i;
const SOUNDCLOUD_SET_RE = /(?:^|\/\/)(?:www\.|m\.)?soundcloud\.com\/[^/\s]+\/sets\/[^/\s?]+|on\.soundcloud\.com\//i;

let skillCsv: string | null = null;
let skillPlaylistsLoaded = false;

/** What the "Source a playlist" card would check, or null with why. */
function skillSourceSpec(): { spec: { kind: 'spotify' | 'soundcloud' | 'csv'; ref: string } | null; help: string } {
  if (skillCsv) return { spec: { kind: 'csv', ref: skillCsv }, help: `Spreadsheet: ${skillCsv.split('/').pop()}` };
  const link = ($<HTMLInputElement>('skill-source-link')?.value ?? '').trim();
  if (!link) return { spec: null, help: '' };
  if (SPOTIFY_PLAYLIST_RE.test(link)) return { spec: { kind: 'spotify', ref: link }, help: 'A Spotify playlist.' };
  if (SOUNDCLOUD_SET_RE.test(link)) return { spec: { kind: 'soundcloud', ref: link }, help: 'A SoundCloud set.' };
  return { spec: null, help: "That isn't a Spotify playlist or a SoundCloud set link." };
}

function refreshSkillSource(): void {
  const { spec, help } = skillSourceSpec();
  const run = $<HTMLButtonElement>('skill-source-run');
  if (run) run.disabled = !spec;
  const el = $('skill-source-help');
  if (el) { el.textContent = help; el.classList.toggle('is-error', !spec && !!help); }
}

async function loadSkillPlaylists(): Promise<void> {
  if (skillPlaylistsLoaded) return;
  const select = $<HTMLSelectElement>('skill-upgrade-playlist');
  const run = $<HTMLButtonElement>('skill-upgrade-run');
  if (!select) return;
  try {
    const res = await window.candybar.upgradeListPlaylists();
    if (!res.success || !res.playlists) throw new Error(res.error || "Couldn't read Rekordbox");
    const usable = res.playlists.filter(p => !p.unreadable && (p.count > 0 || p.countUnknown));
    select.innerHTML = `<option value="">Choose a Rekordbox playlist…</option>${usable.map(p =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.path ? `${p.path} / ${p.name}` : p.name)}${p.count ? ` (${p.count})` : ''}</option>`).join('')}`;
    skillPlaylistsLoaded = true;
  } catch (err) {
    select.innerHTML = `<option value="">${escapeHtml(err instanceof Error ? err.message : String(err))}</option>`;
  }
  if (run) run.disabled = !select.value;
}

function initSkillsPage(): void {
  const page = document.getElementById('page-claude');
  if (!page) return;
  const onShown = () => { if (page.classList.contains('active')) void loadSkillPlaylists(); };
  new MutationObserver(onShown).observe(page, { attributes: true, attributeFilter: ['class'] });
  onShown();

  $<HTMLInputElement>('skill-source-link')?.addEventListener('input', () => { skillCsv = null; refreshSkillSource(); });
  $('skill-source-csv')?.addEventListener('click', async () => {
    const picked = await window.candybar.selectPath('file').catch(() => null);
    if (typeof picked !== 'string' || !picked) return;
    if (!/\.csv$/i.test(picked)) { showToast('warning', 'Choose a CSV file', 'A spreadsheet saved as CSV, like an Exportify export.'); return; }
    skillCsv = picked;
    const link = $<HTMLInputElement>('skill-source-link');
    if (link) link.value = '';
    refreshSkillSource();
  });
  $('skill-source-run')?.addEventListener('click', () => {
    const { spec } = skillSourceSpec();
    if (!spec) return;
    setActiveTab('source');
    void sourceWithClaude(spec);
  });
  $<HTMLSelectElement>('skill-upgrade-playlist')?.addEventListener('change', (e) => {
    const run = $<HTMLButtonElement>('skill-upgrade-run');
    if (run) run.disabled = !(e.target as HTMLSelectElement).value;
  });
  $('skill-upgrade-run')?.addEventListener('click', () => {
    const id = $<HTMLSelectElement>('skill-upgrade-playlist')?.value;
    if (!id) return;
    setActiveTab('upgrade');
    void upgradeWithClaude(id);
  });
  $('skill-soundcloud-open')?.addEventListener('click', () => {
    const card = document.getElementById('claude-sc-card');
    card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card?.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true });
  });
  refreshSkillSource();
}

export function initClaude(): void {
  window.addEventListener('claude-status-changed', (e) => renderStatus((e as CustomEvent<ClaudeStatus>).detail));
  initSkillsPage();

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

  // The SoundCloud form starts with the gate email saved in Settings.
  void window.candybar.getConfig().then((config) => {
    const email = $<HTMLInputElement>('claude-sc-email');
    if (email && !email.value) email.value = config.gateEmail ?? '';
  }).catch(() => {});

  // Ask Claude: the round button, the drawer, and anything that opens it
  // (data-claude-open="settings", or the claude-chat:open event from jobs that
  // find Claude isn't set up).
  $('claude-fab')?.addEventListener('click', () => (chatIsOpen() ? closeChat() : void openChat()));
  $('claude-chat-close')?.addEventListener('click', closeChat);
  $('claude-chat-scrim')?.addEventListener('click', closeChat);
  $('claude-chat-settings')?.addEventListener('click', () => {
    if (chatView === 'settings') showChatView(profile ? 'chat' : 'intro');
    else showChatView('settings');
  });
  document.addEventListener('click', (e) => {
    const opener = (e.target as HTMLElement).closest<HTMLElement>('[data-claude-open]');
    if (opener) void openChat((opener.dataset.claudeOpen || undefined) as ChatView | undefined);
  });
  document.addEventListener('claude-chat:open', (e) => void openChat((e as CustomEvent<{ view?: ChatView }>).detail?.view));
  document.addEventListener('keydown', (e) => {
    // Only when nothing sits above the drawer (a confirm dialog, the tag editor).
    if (e.key !== 'Escape' || !chatIsOpen()) return;
    const covered = [...document.querySelectorAll<HTMLElement>('.modal-overlay, .drawer-overlay')].some((el) => getComputedStyle(el).display !== 'none');
    if (!covered) closeChat();
  });
  $('claude-chat-view')?.addEventListener('click', (e) => {
    const example = (e.target as HTMLElement).closest<HTMLElement>('[data-claude-example]');
    const input = $<HTMLTextAreaElement>('claude-ask-input');
    if (!example || !input || input.disabled) return;
    input.value = example.textContent?.trim() ?? '';
    input.focus();
  });

  ensureTagEditorButton();
  new MutationObserver(ensureInjected).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  void refreshStatus();
}
