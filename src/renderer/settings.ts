import type { ScriptOutput } from './shared';
import type { StoreAccount } from '../types';
import { showToast, getValue, setValue, getErrorMessage } from './shared';
import { autoRefreshLibrary } from './library';

type StoreService = 'qobuz' | 'beatport';

// ========== DOM Elements ==========

const settingsModal = document.getElementById('settings-modal') as HTMLDivElement;
const openSettingsBtn = document.getElementById('open-settings') as HTMLButtonElement;
const closeSettingsBtn = document.getElementById('close-settings') as HTMLButtonElement;
const saveSettingsBtn = document.getElementById('save-settings') as HTMLButtonElement;
const floatingConsoleToggle = document.getElementById('setting-floating-console') as HTMLInputElement;
const libraryRootChooseBtn = document.getElementById('library-root-choose') as HTMLButtonElement | null;
// ========== State ==========

let currentArchivePath = '';

// ========== Public API ==========

export function setCurrentArchivePath(path: string): void {
  currentArchivePath = path;
  setValue('setting-archive-path', path);
}

export function setLibraryRootDisplay(root: string): void {
  const el = document.getElementById('library-root-display');
  if (el) el.textContent = root || '(not set)';
}

export function setFloatingConsoleEnabled(enabled: boolean): void {
  if (floatingConsoleToggle) floatingConsoleToggle.checked = enabled;
  applyFloatingConsoleVisibility();
}

export function openSettingsTo(sectionKey: string): void {
  if (!settingsModal) return;
  settingsModal.classList.add('visible');
  const nav = settingsModal.querySelector<HTMLElement>('.settings-nav');
  const sectionsRoot = settingsModal.querySelector<HTMLElement>('.settings-sections');
  if (nav && sectionsRoot) {
    for (const item of nav.querySelectorAll<HTMLButtonElement>('.settings-nav-item')) {
      item.classList.toggle('is-active', item.dataset.target === sectionKey);
    }
    for (const section of sectionsRoot.querySelectorAll<HTMLElement>('.settings-section')) {
      section.classList.toggle('is-active', section.dataset.section === sectionKey);
    }
    sectionsRoot.scrollTop = 0;
  }
  void refreshAccountConnectionStates();
}

function getFloatingConsole(): HTMLElement | null {
  return document.getElementById('floating-console');
}

function applyFloatingConsoleVisibility(): void {
  const consoleEl = getFloatingConsole();
  if (!consoleEl) return;
  const enabled = floatingConsoleToggle?.checked ?? true;
  consoleEl.style.display = enabled ? 'flex' : 'none';
}

export async function setStoreCredentials(config: {
  qobuzAccounts?: StoreAccount[];
  beatportAccounts?: StoreAccount[];
  spotifyClientId?: string;
  spotifyClientSecret?: string;
}): Promise<void> {
  let statuses: { qobuzAccounts: Record<string, boolean>; beatportAccounts: Record<string, boolean> } = {
    qobuzAccounts: {}, beatportAccounts: {}
  };
  try {
    statuses = await window.candybar.storeLoginStatus();
  } catch {
    // status check failures shouldn't block rendering — treat all as disconnected
  }
  if (config.qobuzAccounts !== undefined) renderAccountsList('qobuz', config.qobuzAccounts, statuses.qobuzAccounts);
  if (config.beatportAccounts !== undefined) renderAccountsList('beatport', config.beatportAccounts, statuses.beatportAccounts);
  if (config.spotifyClientId !== undefined) setValue('setting-spotify-client-id', config.spotifyClientId);
  if (config.spotifyClientSecret !== undefined) setValue('setting-spotify-client-secret', config.spotifyClientSecret);
}

function renderAccountsList(service: StoreService, accounts: StoreAccount[], statuses: Record<string, boolean>): void {
  const container = document.getElementById(`${service}-accounts-list`);
  if (!container) return;
  container.innerHTML = '';
  if (accounts.length === 0) {
    appendAccountRow(service, { id: newAccountId(), label: 'Account 1' }, false);
    return;
  }
  for (const account of accounts) appendAccountRow(service, account, !!statuses[account.id]);
}

function appendAccountRow(service: StoreService, account: StoreAccount, connected: boolean): void {
  const container = document.getElementById(`${service}-accounts-list`);
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'account-row';
  row.dataset.accountId = account.id;
  row.dataset.service = service;
  renderAccountRowContents(row, account, connected);
  container.appendChild(row);
}

function renderAccountRowContents(row: HTMLDivElement, account: StoreAccount, connected: boolean): void {
  const service = row.dataset.service as StoreService;
  row.classList.toggle('is-connected', connected);

  if (connected) {
    row.innerHTML = `
      <div class="account-row-header">
        <span class="account-connected-badge" title="Login succeeded">✓ Connected</span>
        <input type="text" class="account-label" placeholder="Label (optional)" value="${escapeHtml(account.label ?? '')}" />
        <button type="button" class="btn-ghost account-disconnect" data-tooltip="Sign out and clear this session">Disconnect</button>
        <button type="button" class="btn-ghost account-remove" data-tooltip="Remove this account">Remove</button>
      </div>
      ${account.email ? `<div class="account-connected-email">${escapeHtml(account.email)}</div>` : ''}
      <input type="hidden" class="account-email" value="${escapeHtml(account.email ?? '')}" />
    `;
  } else {
    row.innerHTML = `
      <div class="account-row-header">
        <input type="text" class="account-label" placeholder="Label (optional)" value="${escapeHtml(account.label ?? '')}" />
        <button type="button" class="btn-secondary account-connect" data-tooltip="Open the store's login page in a window">Connect</button>
        <button type="button" class="btn-ghost account-remove" data-tooltip="Remove this account">Remove</button>
      </div>
      <div class="setting-row">
        <div class="setting-info">
          <label>Identifier (optional)</label>
          <p class="setting-desc">Shown in the connected card to tell accounts apart.</p>
        </div>
        <input type="text" class="account-email" placeholder="e.g. ben@forcemajeure.vip" value="${escapeHtml(account.email ?? '')}" />
      </div>
      <div class="account-error" style="display:none;"></div>
    `;
  }

  row.querySelector('.account-remove')?.addEventListener('click', async () => {
    if (connected) {
      try { await window.candybar.storeLogoutAccount(service, account.id); } catch { /* ignore */ }
    }
    row.remove();
    window.dispatchEvent(new CustomEvent('store-account-changed', { detail: { service } }));
  });

  row.querySelector('.account-connect')?.addEventListener('click', () => {
    void handleConnect(row, service);
  });

  row.querySelector('.account-disconnect')?.addEventListener('click', () => {
    void handleDisconnect(row, service, account.id);
  });
}

async function handleConnect(row: HTMLDivElement, service: StoreService): Promise<void> {
  const emailInput = row.querySelector<HTMLInputElement>('.account-email');
  const labelInput = row.querySelector<HTMLInputElement>('.account-label');
  const connectBtn = row.querySelector<HTMLButtonElement>('.account-connect');
  const errorEl = row.querySelector<HTMLDivElement>('.account-error');
  if (!connectBtn) return;

  const email = emailInput?.value.trim() || '';
  const label = (labelInput?.value || '').trim();
  const id = row.dataset.accountId || newAccountId();
  const account: StoreAccount = { id, ...(email ? { email } : {}), ...(label ? { label } : {}) };

  connectBtn.disabled = true;
  connectBtn.textContent = 'Waiting for sign-in…';
  if (errorEl) { errorEl.textContent = ''; errorEl.style.display = 'none'; }

  try {
    const result = await window.candybar.storeLoginAccount(service, account);
    if (result.success) {
      row.dataset.accountId = id;
      renderAccountRowContents(row, account, true);
      showToast('success', `${serviceLabel(service)} Connected`, email || label || 'Account');
      window.dispatchEvent(new CustomEvent('store-account-changed', { detail: { service } }));
    } else {
      if (errorEl) {
        errorEl.textContent = result.error || 'Login failed';
        errorEl.style.display = '';
      }
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect';
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = getErrorMessage(err);
      errorEl.style.display = '';
    }
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
  }
}

async function handleDisconnect(row: HTMLDivElement, service: StoreService, accountId: string): Promise<void> {
  const emailInput = row.querySelector<HTMLInputElement>('.account-email');
  const labelInput = row.querySelector<HTMLInputElement>('.account-label');
  const email = emailInput?.value || '';
  const label = (labelInput?.value || '').trim();

  try {
    await window.candybar.storeLogoutAccount(service, accountId);
  } catch {
    // best-effort — still flip back to form
  }
  renderAccountRowContents(row, { id: accountId, ...(email ? { email } : {}), ...(label ? { label } : {}) }, false);
  window.dispatchEvent(new CustomEvent('store-account-changed', { detail: { service } }));
}

function serviceLabel(service: StoreService): string {
  return service === 'qobuz' ? 'Qobuz' : 'Beatport';
}

async function refreshAccountConnectionStates(): Promise<void> {
  let statuses: { qobuzAccounts: Record<string, boolean>; beatportAccounts: Record<string, boolean> };
  try {
    statuses = await window.candybar.storeLoginStatus();
  } catch {
    return;
  }
  for (const service of ['qobuz', 'beatport'] as StoreService[]) {
    const container = document.getElementById(`${service}-accounts-list`);
    if (!container) continue;
    const map = service === 'qobuz' ? statuses.qobuzAccounts : statuses.beatportAccounts;
    for (const row of container.querySelectorAll<HTMLDivElement>('.account-row')) {
      const id = row.dataset.accountId;
      if (!id) continue;
      const shouldBeConnected = !!map[id];
      const isConnected = row.classList.contains('is-connected');
      if (shouldBeConnected === isConnected) continue;
      // Rerender this row preserving current field values
      const email = (row.querySelector<HTMLInputElement>('.account-email')?.value || '').trim();
      const label = (row.querySelector<HTMLInputElement>('.account-label')?.value || '').trim();
      renderAccountRowContents(row, { id, ...(email ? { email } : {}), ...(label ? { label } : {}) }, shouldBeConnected);
    }
  }
}

function collectAccounts(service: StoreService): StoreAccount[] {
  const container = document.getElementById(`${service}-accounts-list`);
  if (!container) return [];
  const accounts: StoreAccount[] = [];
  for (const row of container.querySelectorAll<HTMLDivElement>('.account-row')) {
    const email = (row.querySelector<HTMLInputElement>('.account-email')?.value || '').trim();
    const label = (row.querySelector<HTMLInputElement>('.account-label')?.value || '').trim();
    // Keep a row if it has *any* identifying data; empty rows are dropped.
    if (!email && !label) continue;
    accounts.push({
      id: row.dataset.accountId || newAccountId(),
      ...(email ? { email } : {}),
      ...(label ? { label } : {}),
    });
  }
  return accounts;
}

function newAccountId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `acct-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}


// ========== Init ==========

export function initSettings(): void {
  openSettingsBtn?.addEventListener('click', () => {
    settingsModal.classList.add('visible');
    void refreshAccountConnectionStates();
  });

  closeSettingsBtn?.addEventListener('click', () => {
    settingsModal.classList.remove('visible');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal.classList.contains('visible')) {
      settingsModal.classList.remove('visible');
    }
  });

  libraryRootChooseBtn?.addEventListener('click', async () => {
    try {
      const selected = await window.candybar.selectPath('dir');
      if (!selected) return;
      const existing = await window.candybar.getConfig();
      if (existing.libraryRoot === selected) return;
      await window.candybar.setConfig({ ...existing, libraryRoot: selected });
      setLibraryRootDisplay(selected);
      showToast('info', 'Library Root Updated', `Scanning ${selected}…`);
      settingsModal.classList.remove('visible');
      await autoRefreshLibrary();
    } catch (err) {
      showToast('error', 'Update Failed', getErrorMessage(err));
    }
  });

  settingsModal?.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.classList.remove('visible');
  });

  saveSettingsBtn?.addEventListener('click', async () => {
    try {
      const archivePath = getValue('setting-archive-path');
      const rekordboxXmlPath = getValue('setting-rekordbox-xml-path');
      const floatingConsoleEnabled = floatingConsoleToggle?.checked ?? true;
      const qobuzAccounts = collectAccounts('qobuz');
      const beatportAccounts = collectAccounts('beatport');
      const spotifyClientId = getValue('setting-spotify-client-id');
      const spotifyClientSecret = getValue('setting-spotify-client-secret');

      const existing = await window.candybar.getConfig();
      await window.candybar.setConfig({
        ...existing,
        archivePath,
        rekordboxXmlPath,
        floatingConsoleEnabled,
        qobuzAccounts,
        beatportAccounts,
        spotifyClientId,
        spotifyClientSecret,
      });

      currentArchivePath = archivePath;
      settingsModal.classList.remove('visible');
      showToast('success', 'Settings Saved', 'Your settings have been saved.');
      window.dispatchEvent(new CustomEvent('store-account-changed', { detail: { service: 'all' } }));
    } catch (err) {
      showToast('error', 'Save Failed', getErrorMessage(err));
    }
  });

  document.getElementById('add-qobuz-account')?.addEventListener('click', () => {
    const existing = document.querySelectorAll('#qobuz-accounts-list .account-row').length;
    appendAccountRow('qobuz', { id: newAccountId(), label: `Account ${existing + 1}` }, false);
  });
  document.getElementById('add-beatport-account')?.addEventListener('click', () => {
    const existing = document.querySelectorAll('#beatport-accounts-list .account-row').length;
    appendAccountRow('beatport', { id: newAccountId(), label: `Account ${existing + 1}` }, false);
  });

  initRekordboxButtons();
  initLibraryScanStatus();
  initSettingsNav();
  initPasswordToggles();

  // Script output listener (floating console)
  initScriptOutputListener();
}

function initSettingsNav(): void {
  const nav = settingsModal?.querySelector<HTMLElement>('.settings-nav');
  const sectionsRoot = settingsModal?.querySelector<HTMLElement>('.settings-sections');
  if (!nav || !sectionsRoot) return;

  nav.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.settings-nav-item');
    if (!target) return;
    const sectionKey = target.dataset.target;
    if (!sectionKey) return;
    for (const item of nav.querySelectorAll<HTMLButtonElement>('.settings-nav-item')) {
      item.classList.toggle('is-active', item === target);
    }
    for (const section of sectionsRoot.querySelectorAll<HTMLElement>('.settings-section')) {
      section.classList.toggle('is-active', section.dataset.section === sectionKey);
    }
    sectionsRoot.scrollTop = 0;
  });
}

function initPasswordToggles(): void {
  // Delegated so dynamically-added account rows work without rebinding.
  settingsModal?.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('.password-toggle');
    if (!btn) return;

    // Prefer an explicit target id (static inputs); else the sibling input (account rows).
    const targetId = btn.dataset.passwordToggle;
    const input: HTMLInputElement | null = targetId
      ? document.getElementById(targetId) as HTMLInputElement | null
      : btn.parentElement?.querySelector<HTMLInputElement>('input') ?? null;
    if (!input) return;

    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.classList.toggle('is-showing', !showing);
    const nextLabel = showing ? 'Show password' : 'Hide password';
    btn.setAttribute('aria-label', nextLabel);
    btn.setAttribute('title', nextLabel);
  });
}

function initLibraryScanStatus(): void {
  const statusEl = document.getElementById('library-scan-status');
  if (!statusEl) return;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  window.candybar.onHealthScanProgress((payload) => {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    const { phase, current, total } = payload;
    statusEl.style.display = '';
    if (phase === 'discovering') {
      statusEl.textContent = total > 0 ? `Discovering tracks… ${total} found` : 'Discovering tracks…';
    } else if (phase === 'scanning') {
      statusEl.textContent = `Scanning ${current} / ${total}…`;
    } else if (phase === 'duplicates') {
      statusEl.textContent = 'Checking for duplicates…';
    } else if (phase === 'complete') {
      statusEl.textContent = `Scan complete · ${total} tracks`;
      clearTimer = setTimeout(() => {
        statusEl.style.display = 'none';
        statusEl.textContent = '';
      }, 4000);
    }
  });
}

function initRekordboxButtons(): void {
  const scanBtn = document.getElementById('rekordbox-scan-btn') as HTMLButtonElement | null;
  const importBtn = document.getElementById('rekordbox-import-btn') as HTMLButtonElement | null;
  const resyncBtn = document.getElementById('rekordbox-resync-btn') as HTMLButtonElement | null;
  const statusEl = document.getElementById('rekordbox-status');
  const listEl = document.getElementById('rekordbox-missing-list');

  const resyncModal = document.getElementById('rekordbox-resync-modal') as HTMLDivElement | null;
  const resyncModalClose = document.getElementById('rekordbox-resync-modal-close') as HTMLButtonElement | null;
  const resyncModalCancel = document.getElementById('rekordbox-resync-modal-cancel') as HTMLButtonElement | null;
  const resyncModalConfirm = document.getElementById('rekordbox-resync-modal-confirm') as HTMLButtonElement | null;

  const setStatus = (text: string) => {
    if (statusEl) statusEl.textContent = text;
  };

  const hideResyncModal = () => {
    if (resyncModal) resyncModal.style.display = 'none';
  };
  const showResyncModal = () => {
    if (resyncModal) resyncModal.style.display = 'flex';
  };

  scanBtn?.addEventListener('click', async () => {
    scanBtn.disabled = true;
    setStatus('Scanning…');
    if (listEl) listEl.innerHTML = '';
    try {
      // Save the current XML path first so the main process sees it
      const existing = await window.candybar.getConfig();
      const rekordboxXmlPath = getValue('setting-rekordbox-xml-path');
      if (rekordboxXmlPath !== existing.rekordboxXmlPath) {
        await window.candybar.setConfig({ ...existing, rekordboxXmlPath });
      }
      const result = await window.candybar.rekordboxScan();
      setStatus(`${result.total} tracks in XML · ${result.missing.length} missing under ${result.libraryRoot}`);
      if (listEl) {
        if (result.missing.length === 0) {
          listEl.textContent = 'No missing files under the library root.';
        } else {
          listEl.innerHTML = result.missing
            .slice(0, 500)
            .map(m => {
              const artist = escapeHtml(m.artist || '?');
              const title = escapeHtml(m.title || '?');
              const file = escapeHtml(m.filePath);
              return `<div><strong>${artist}</strong> — ${title}<br><span style="opacity:0.6;font-size:0.85em;">${file}</span></div>`;
            })
            .join('');
          if (result.missing.length > 500) {
            listEl.innerHTML += `<div style="margin-top:8px;opacity:0.6;">…and ${result.missing.length - 500} more</div>`;
          }
        }
      }
      showToast('success', 'Scan Complete', `${result.missing.length} missing out of ${result.total}.`);
    } catch (err) {
      setStatus('Scan failed.');
      showToast('error', 'Scan Failed', getErrorMessage(err));
    } finally {
      scanBtn.disabled = false;
    }
  });

  importBtn?.addEventListener('click', async () => {
    importBtn.disabled = true;
    setStatus('Importing…');
    try {
      const existing = await window.candybar.getConfig();
      const rekordboxXmlPath = getValue('setting-rekordbox-xml-path');
      if (rekordboxXmlPath !== existing.rekordboxXmlPath) {
        await window.candybar.setConfig({ ...existing, rekordboxXmlPath });
      }
      const summary = await window.candybar.rekordboxImport();
      setStatus(`Imported ${summary.imported} · ${summary.missingOnDisk} missing on disk · ${summary.totalInXml} in XML`);
      showToast('success', 'Import Complete', `Upserted ${summary.imported} tracks into the library.`);
    } catch (err) {
      setStatus('Import failed.');
      showToast('error', 'Import Failed', getErrorMessage(err));
    } finally {
      importBtn.disabled = false;
    }
  });

  resyncBtn?.addEventListener('click', () => {
    showResyncModal();
  });

  resyncModalClose?.addEventListener('click', hideResyncModal);
  resyncModalCancel?.addEventListener('click', hideResyncModal);
  resyncModal?.addEventListener('click', (e) => {
    if (e.target === resyncModal) hideResyncModal();
  });

  resyncModalConfirm?.addEventListener('click', async () => {
    hideResyncModal();
    if (!resyncBtn) return;
    resyncBtn.disabled = true;
    setStatus('Resyncing… (wiping candybar.db, then re-importing from rekordbox XML)');
    if (listEl) listEl.innerHTML = '';
    try {
      const existing = await window.candybar.getConfig();
      const rekordboxXmlPath = getValue('setting-rekordbox-xml-path');
      if (rekordboxXmlPath !== existing.rekordboxXmlPath) {
        await window.candybar.setConfig({ ...existing, rekordboxXmlPath });
      }
      const summary = await window.candybar.rekordboxResync();
      setStatus(`Resynced ${summary.imported} · ${summary.missingOnDisk} missing on disk · ${summary.totalInXml} in XML`);
      showToast('success', 'Resync Complete', `Candybar database wiped and rebuilt with ${summary.imported} tracks from rekordbox XML.`);
      autoRefreshLibrary();
    } catch (err) {
      setStatus('Resync failed.');
      showToast('error', 'Resync Failed', getErrorMessage(err));
    } finally {
      resyncBtn.disabled = false;
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const CONSOLE_MAX_LINES = 10;
const CONSOLE_LINGER_MS = 7000;
const CONSOLE_FADE_MS = 600;

function fadeOutConsoleLine(line: HTMLElement): void {
  if (line.classList.contains('is-fading')) return;
  line.classList.add('is-fading');
  setTimeout(() => line.remove(), CONSOLE_FADE_MS);
}

function appendFloatingConsoleLine(stream: ScriptOutput['stream'], text: string): void {
  if (!floatingConsoleToggle?.checked) return;
  const consoleEl = getFloatingConsole();
  const body = document.getElementById('floating-console-body');
  const target = body ?? consoleEl;
  if (!target) return;
  if (consoleEl && consoleEl.style.display === 'none') consoleEl.style.display = 'flex';

  target.querySelectorAll('.console-line.is-fresh').forEach(el => el.classList.remove('is-fresh'));

  const line = document.createElement('div');
  line.className = `console-line console-line--${stream} is-fresh`;
  line.textContent = text;
  target.appendChild(line);

  const overflow = target.querySelectorAll<HTMLElement>('.console-line:not(.is-fading)');
  if (overflow.length > CONSOLE_MAX_LINES) {
    for (let i = 0; i < overflow.length - CONSOLE_MAX_LINES; i++) fadeOutConsoleLine(overflow[i]);
  }

  setTimeout(() => fadeOutConsoleLine(line), CONSOLE_LINGER_MS);
}

export function pushFloatingConsole(text: string, stream: ScriptOutput['stream'] = 'status'): void {
  appendFloatingConsoleLine(stream, text);
}

function initScriptOutputListener(): void {
  floatingConsoleToggle?.addEventListener('change', applyFloatingConsoleVisibility);
  window.candybar.onOutput?.((output: ScriptOutput) => {
    appendFloatingConsoleLine(output.stream, output.text);
  });
}
