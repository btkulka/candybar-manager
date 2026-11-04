import type { ScriptOutput } from './shared';
import type { AppConfig, StoreAccount } from '../types';
import { showToast, getValue, setValue, getErrorMessage, setActiveTab, requestOpenSetup } from './shared';
import { autoRefreshLibrary } from './library';
import { confirmAction, confirmChoice } from './confirmDialog';

type StoreService = 'qobuz' | 'beatport';
/** The Rekordbox safety-backup folder comes with the upgrade swap engine. */
type AppConfigWithBackups = AppConfig & { rekordboxBackupDir?: string };

/** Show a value saved elsewhere (setup guide, first load) in the form. */
export function setRekordboxBackupDir(dir: string | undefined): void {
  setValue('setting-rekordbox-backup-dir', dir ?? '');
  // Left empty, backups go next to the library; say where.
  const input = document.getElementById('setting-rekordbox-backup-dir') as HTMLInputElement | null;
  if (input && !dir) {
    void window.candybar.upgradeSwapPreflight()
      .then((p) => { input.placeholder = p.backupDir ? `Next to your library: ${p.backupDir}` : 'Choose a folder'; })
      .catch(() => { /* keeps the generic placeholder */ });
  }
}

// ========== DOM Elements ==========

const settingsModal = document.getElementById('settings-modal') as HTMLDivElement;
const openSettingsBtn = document.getElementById('open-settings') as HTMLButtonElement;
const closeSettingsBtn = document.getElementById('close-settings') as HTMLButtonElement;
const saveSettingsBtn = document.getElementById('save-settings') as HTMLButtonElement;
const floatingConsoleToggle = document.getElementById('setting-floating-console') as HTMLInputElement;
const rekordboxEnabledToggle = document.getElementById('setting-rekordbox-enabled') as HTMLInputElement | null;
const showAdvancedToggle = document.getElementById('setting-show-advanced') as HTMLInputElement | null;
const libraryRootChooseBtn = document.getElementById('library-root-choose') as HTMLButtonElement | null;
// ========== State ==========

let currentArchivePath = '';

// ========== Public API ==========

export function setCurrentArchivePath(path: string): void {
  currentArchivePath = path;
  setValue('setting-archive-path', path);
}

export function setLibraryRootDisplay(root: string): void {
  const el = document.getElementById('library-root-display') as HTMLInputElement | null;
  if (!el) return;
  el.value = root;
  el.title = root || 'Your music library folder'; // the input truncates long paths
  el.removeAttribute('data-tip-title');
}

export function setFloatingConsoleEnabled(enabled: boolean): void {
  if (floatingConsoleToggle) floatingConsoleToggle.checked = enabled;
  applyFloatingConsoleVisibility();
}

export function setShowAdvancedTools(enabled: boolean): void {
  if (showAdvancedToggle) showAdvancedToggle.checked = enabled;
  applyAdvancedToolsVisibility(enabled);
}

function applyAdvancedToolsVisibility(enabled: boolean): void {
  document.body.classList.toggle('show-advanced', enabled);
  // Don't leave Settings showing a tab that just disappeared.
  const activeNav = settingsModal?.querySelector<HTMLElement>('.settings-nav-item.is-active');
  if (!enabled && activeNav?.hasAttribute('data-advanced')) {
    settingsModal.querySelector<HTMLButtonElement>('.settings-nav-item[data-target="library"]')?.click();
  }
}

export function setRekordboxEnabled(enabled: boolean): void {
  if (rekordboxEnabledToggle) rekordboxEnabledToggle.checked = enabled;
  applyRekordboxVisibility(enabled);
}

export function applyRekordboxVisibility(enabled: boolean): void {
  const restoreNav = document.getElementById('nav-restore');
  if (restoreNav) restoreNav.style.display = enabled ? '' : 'none';

  const upgradeNav = document.getElementById('nav-upgrade');
  if (upgradeNav) upgradeNav.style.display = enabled ? '' : 'none';

  const sectionLabel = document.getElementById('nav-section-rekordbox');
  if (sectionLabel) sectionLabel.style.display = enabled ? '' : 'none';

  const settingsNavItem = document.getElementById('settings-nav-rekordbox');
  if (settingsNavItem) settingsNavItem.style.display = enabled ? '' : 'none';

  const settingsSection = document.querySelector<HTMLElement>('.settings-section[data-section="rekordbox"]');
  if (settingsSection) settingsSection.style.display = enabled ? '' : 'none';

  // If the user is currently on a Rekordbox-only page and rekordbox just got
  // disabled, bounce them to a safe default so they're not stuck on a hidden page.
  if (!enabled) {
    const onHiddenPage = ['page-restore', 'page-upgrade']
      .some(id => document.getElementById(id)?.classList.contains('active'));
    if (onHiddenPage) setActiveTab('organize');
  }

  // If the settings modal currently has the rekordbox tab active, switch to library.
  const rekordboxNavActive = document.getElementById('settings-nav-rekordbox')?.classList.contains('is-active');
  if (!enabled && rekordboxNavActive) {
    document.querySelector<HTMLButtonElement>('.settings-nav-item[data-target="library"]')?.click();
  }
}

export function openSettingsTo(sectionKey: string): void {
  if (!settingsModal) return;
  showSettingsModal();
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
  syncSettingsTabs();
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
    appendAccountRow(service, { id: newAccountId(), label: 'Account 1' }, false, true);
    return;
  }
  for (const account of accounts) appendAccountRow(service, account, !!statuses[account.id]);
}

/** A placeholder row is a blank slot with a Connect button. It isn't an account
 *  until a sign-in succeeds (main saves it then), so Save never stores one. */
function appendAccountRow(service: StoreService, account: StoreAccount, connected: boolean, placeholder = false): void {
  const container = document.getElementById(`${service}-accounts-list`);
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'account-row';
  row.dataset.accountId = account.id;
  row.dataset.service = service;
  if (placeholder) row.dataset.placeholder = '1';
  renderAccountRowContents(row, account, connected);
  container.appendChild(row);
}

function renderAccountRowContents(row: HTMLDivElement, account: StoreAccount, connected: boolean): void {
  const service = row.dataset.service as StoreService;
  row.classList.toggle('is-connected', connected);

  if (connected) {
    row.innerHTML = `
      <div class="account-row-header">
        <span class="account-connected-badge" title="You're signed in. Searches, carts and downloads use this account.">✓ Signed in</span>
        <input type="text" class="account-label" placeholder="Label (optional)" value="${escapeHtml(account.label ?? '')}" title="A name for this account, like Personal or Work" />
        <button type="button" class="btn-ghost account-disconnect" data-tooltip="Sign out of this account. You can sign in again any time.">Sign out</button>
        <button type="button" class="btn-ghost account-remove" data-tooltip="Sign out and remove this account from the app. Your store account itself isn't affected.">Remove</button>
      </div>
      ${account.email ? `<div class="account-connected-email">${escapeHtml(account.email)}</div>` : ''}
      <input type="hidden" class="account-email" value="${escapeHtml(account.email ?? '')}" />
    `;
  } else {
    row.innerHTML = `
      <div class="account-row-header">
        <input type="text" class="account-label" placeholder="Label (optional)" value="${escapeHtml(account.label ?? '')}" title="A name for this account, like Personal or Work" />
        <button type="button" class="btn-secondary account-connect" data-tooltip="Opens the store's own sign-in page. Your password goes to the store, not to Track Lab.">Sign in</button>
        <button type="button" class="btn-ghost account-remove" data-tooltip="Remove this account from the app">Remove</button>
      </div>
      <div class="setting-row">
        <div class="setting-info">
          <label>Identifier (optional)</label>
          <p class="setting-desc">Shown in the connected card to tell accounts apart.</p>
        </div>
        <input type="text" class="account-email" placeholder="e.g. you@example.com" value="${escapeHtml(account.email ?? '')}" title="Any note that tells your accounts apart, such as the email you sign in with" />
      </div>
      <div class="account-error" style="display:none;"></div>
    `;
  }

  row.querySelector('.account-remove')?.addEventListener('click', async () => {
    if (connected) {
      const ok = await confirmAction({
        title: `Remove this ${serviceLabel(service)} account?`,
        message: 'You\'ll be signed out of it here, and it won\'t be used for searches, carts or downloads.',
        safetyNote: `Your ${serviceLabel(service)} account and purchases aren't affected. You can add it back any time.`,
        confirmLabel: 'Remove account',
        tone: 'caution',
      });
      if (!ok) return;
      try { await window.candybar.storeLogoutAccount(service, account.id); } catch { /* ignore */ }
    }
    // Saved right away, like the sign-out above, so Discard can't bring it back.
    if (row.dataset.placeholder !== '1') {
      try {
        await removeSavedAccount(service, row.dataset.accountId || account.id);
      } catch (err) {
        showToast('error', 'Couldn\'t remove account', getErrorMessage(err));
        return;
      }
    }
    const wasClean = settingsFormState() === savedFormState;
    row.remove();
    if (wasClean) savedFormState = settingsFormState();
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
      delete row.dataset.placeholder; // main saved it during sign-in
      renderAccountRowContents(row, account, true);
      showToast('success', `Signed in to ${serviceLabel(service)}`, email || label || 'Your account is ready to use.');
      window.dispatchEvent(new CustomEvent('store-account-changed', { detail: { service } }));
    } else {
      if (errorEl) {
        errorEl.textContent = result.error || 'Login failed';
        errorEl.style.display = '';
      }
      connectBtn.disabled = false;
      connectBtn.textContent = 'Sign in';
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = getErrorMessage(err);
      errorEl.style.display = '';
    }
    connectBtn.disabled = false;
    connectBtn.textContent = 'Sign in';
  }
}

async function removeSavedAccount(service: StoreService, accountId: string): Promise<void> {
  const config = await window.candybar.getConfig();
  if (service === 'qobuz') {
    await window.candybar.updateConfig({ qobuzAccounts: config.qobuzAccounts.filter((a) => a.id !== accountId) });
  } else {
    await window.candybar.updateConfig({ beatportAccounts: config.beatportAccounts.filter((a) => a.id !== accountId) });
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
    // Never-connected slots aren't accounts yet; saving one would leave a phantom
    // account that Restore and the store pills treat as "not signed in".
    if (row.dataset.placeholder === '1') continue;
    const email = (row.querySelector<HTMLInputElement>('.account-email')?.value || '').trim();
    const label = (row.querySelector<HTMLInputElement>('.account-label')?.value || '').trim();
    const existingId = row.dataset.accountId;
    // A row with an existing account id is a real (session-authenticated)
    // connection even when email/label are blank — keeping it preserves the
    // store session partition binding.
    if (!email && !label && !existingId) continue;
    accounts.push({
      id: existingId || newAccountId(),
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


// ========== Open / Close / Save ==========
// Settings only persist on Save, so closing with edits asks first instead of
// silently dropping them.

let savedFormState = '';

function settingsFormState(): string {
  // Read-only fields (the library folder) save as soon as they're picked.
  // data-instant controls (the sound wave switch) apply as you flip them.
  const fields = settingsModal?.querySelectorAll<HTMLInputElement>('input:not([readonly]):not([data-instant]), select, textarea') ?? [];
  return JSON.stringify(Array.from(fields, (f) => (f.type === 'checkbox' ? f.checked : f.value)));
}

// Focus moves into the dialog on open, stays inside it while open, and goes
// back to whatever opened it on close.
let focusBeforeSettings: HTMLElement | null = null;

function showSettingsModal(): void {
  if (!settingsModal.classList.contains('visible')) {
    savedFormState = settingsFormState();
    focusBeforeSettings = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  settingsModal.classList.add('visible');
  syncSettingsTabs();
  requestAnimationFrame(() => {
    settingsModal.querySelector<HTMLElement>('.settings-nav-item.is-active')?.focus();
  });
}

function hideSettingsModal(): void {
  settingsModal.classList.remove('visible');
  focusBeforeSettings?.focus();
  focusBeforeSettings = null;
}

/** aria-selected and tabpanel visibility follow the .is-active classes. */
function syncSettingsTabs(): void {
  settingsModal?.querySelectorAll<HTMLElement>('.settings-nav-item').forEach((item) => {
    const active = item.classList.contains('is-active');
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
  });
}

function trapSettingsFocus(e: KeyboardEvent): void {
  if (e.key !== 'Tab' || !settingsModal.classList.contains('visible')) return;
  const focusables = Array.from(settingsModal.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.offsetParent !== null && el.tabIndex >= 0);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const inside = settingsModal.contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
}

/** Close Settings the way the × does (asking about unsaved changes). Resolves
 *  true once it's closed, false if the user chose to keep editing. */
export async function closeSettings(): Promise<boolean> {
  await requestCloseSettings();
  return !settingsModal.classList.contains('visible');
}

async function requestCloseSettings(): Promise<void> {
  if (!settingsModal.classList.contains('visible')) return;
  if (settingsFormState() !== savedFormState) {
    const choice = await confirmChoice({
      title: 'Save your changes?',
      message: 'Changes to settings only take effect once they\'re saved.',
      confirmLabel: 'Save',
      secondaryLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      tone: 'info',
    });
    if (choice === 'cancel') return;
    if (choice === 'confirm') { await saveSettings(); return; }
    await revertSettingsForm();
  }
  hideSettingsModal();
}

// Put the form back to what's on disk so a discarded edit doesn't reappear.
async function revertSettingsForm(): Promise<void> {
  const config = await window.candybar.getConfig();
  setValue('setting-archive-path', config.archivePath);
  setValue('setting-rekordbox-xml-path', config.rekordboxXmlPath ?? '');
  setValue('setting-rekordbox-backup-dir', (config as AppConfigWithBackups).rekordboxBackupDir ?? '');
  if (rekordboxEnabledToggle) rekordboxEnabledToggle.checked = config.rekordboxEnabled ?? true;
  if (floatingConsoleToggle) floatingConsoleToggle.checked = config.floatingConsoleEnabled ?? true;
  applyFloatingConsoleVisibility();
  if (showAdvancedToggle) showAdvancedToggle.checked = config.showAdvancedTools ?? false;
  await setStoreCredentials(config);
}

async function saveSettings(): Promise<void> {
  try {
    const archivePath = getValue('setting-archive-path');
    const rekordboxXmlPath = getValue('setting-rekordbox-xml-path');
    const rekordboxEnabled = rekordboxEnabledToggle?.checked ?? true;
    const floatingConsoleEnabled = floatingConsoleToggle?.checked ?? true;
    const showAdvancedTools = showAdvancedToggle?.checked ?? false;
    const qobuzAccounts = collectAccounts('qobuz');
    const beatportAccounts = collectAccounts('beatport');
    const spotifyClientId = getValue('setting-spotify-client-id');
    const spotifyClientSecret = getValue('setting-spotify-client-secret');
    // Blank keeps the default next to the library rather than saving "".
    const rekordboxBackupDir = getValue('setting-rekordbox-backup-dir').trim();

    saveSettingsBtn.disabled = true;
    await window.candybar.updateConfig({
      archivePath,
      rekordboxXmlPath,
      rekordboxEnabled,
      floatingConsoleEnabled,
      showAdvancedTools,
      qobuzAccounts,
      beatportAccounts,
      spotifyClientId,
      spotifyClientSecret,
      ...(rekordboxBackupDir ? { rekordboxBackupDir } : {}),
    } as Partial<AppConfigWithBackups>);

    currentArchivePath = archivePath;
    applyRekordboxVisibility(rekordboxEnabled);
    applyAdvancedToolsVisibility(showAdvancedTools);
    hideSettingsModal();
    showToast('success', 'Settings saved', 'Your changes are in effect.');
    window.dispatchEvent(new CustomEvent('store-account-changed', { detail: { service: 'all' } }));
  } catch (err) {
    showToast('error', 'Couldn\'t save settings', getErrorMessage(err));
  } finally {
    saveSettingsBtn.disabled = false;
  }
}

// ========== Init ==========

export function initSettings(): void {
  openSettingsBtn?.addEventListener('click', () => {
    showSettingsModal();
    void refreshAccountConnectionStates();
  });

  closeSettingsBtn?.addEventListener('click', () => void requestCloseSettings());

  document.addEventListener('candybar:open-settings', (e) => {
    const sectionKey = (e as CustomEvent<{ sectionKey: string }>).detail?.sectionKey;
    if (sectionKey) openSettingsTo(sectionKey);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal.classList.contains('visible')) {
      void requestCloseSettings();
    }
    trapSettingsFocus(e);
  });

  libraryRootChooseBtn?.addEventListener('click', async () => {
    try {
      const selected = await window.candybar.selectPath('dir');
      if (!selected) return;
      const existing = await window.candybar.getConfig();
      if (existing.libraryRoot === selected) return;
      await window.candybar.updateConfig({ libraryRoot: selected });
      setLibraryRootDisplay(selected);
      showToast('info', 'Library folder changed', `Checking ${selected}…`);
      await requestCloseSettings();
      await autoRefreshLibrary();
    } catch (err) {
      showToast('error', 'Couldn\'t change the library folder', getErrorMessage(err));
    }
  });

  settingsModal?.addEventListener('click', (e) => {
    if (e.target === settingsModal) void requestCloseSettings();
  });

  saveSettingsBtn?.addEventListener('click', () => void saveSettings());

  // The setup guide covers the same ground with instructions; hand over to it.
  const handOverToSetup = async (step?: string) => {
    if (await closeSettings()) requestOpenSetup(step);
  };
  document.getElementById('settings-open-setup')?.addEventListener('click', () => void handOverToSetup());
  document.getElementById('settings-spotify-guide')?.addEventListener('click', () => void handOverToSetup('spotify'));

  document.getElementById('add-qobuz-account')?.addEventListener('click', () => {
    const existing = document.querySelectorAll('#qobuz-accounts-list .account-row').length;
    appendAccountRow('qobuz', { id: newAccountId(), label: `Account ${existing + 1}` }, false, true);
  });
  document.getElementById('add-beatport-account')?.addEventListener('click', () => {
    const existing = document.querySelectorAll('#beatport-accounts-list .account-row').length;
    appendAccountRow('beatport', { id: newAccountId(), label: `Account ${existing + 1}` }, false, true);
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
    syncSettingsTabs();
  });

  // Tablist keys: Up/Down move between the visible tabs and open them.
  nav.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const tabs = Array.from(nav.querySelectorAll<HTMLButtonElement>('.settings-nav-item'))
      .filter((t) => t.offsetParent !== null);
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) return;
    event.preventDefault();
    const next = tabs[(i + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length];
    next.click();
    next.focus();
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
      statusEl.textContent = total > 0 ? `Finding tracks… ${total} so far` : 'Finding tracks…';
    } else if (phase === 'scanning') {
      statusEl.textContent = `Checking ${current} of ${total}…`;
    } else if (phase === 'duplicates') {
      statusEl.textContent = 'Looking for duplicates…';
    } else if (phase === 'complete') {
      statusEl.textContent = `Done — ${total} tracks checked`;
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


  const setStatus = (text: string) => {
    if (statusEl) statusEl.textContent = text;
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
        await window.candybar.updateConfig({ rekordboxXmlPath });
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
      showToast('success', 'Check finished', `${result.missing.length} of ${result.total} files are missing.`);
    } catch (err) {
      setStatus('Scan failed.');
      showToast('error', 'Couldn\'t check for missing files', getErrorMessage(err));
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
        await window.candybar.updateConfig({ rekordboxXmlPath });
      }
      const summary = await window.candybar.rekordboxImport();
      setStatus(`Imported ${summary.imported} · ${summary.missingOnDisk} missing on disk · ${summary.totalInXml} in XML`);
      showToast('success', 'Import finished', `${summary.imported} tracks copied into Track Lab\'s library list.`);
    } catch (err) {
      setStatus('Import failed.');
      showToast('error', 'Couldn\'t import from Rekordbox', getErrorMessage(err));
    } finally {
      importBtn.disabled = false;
    }
  });

  resyncBtn?.addEventListener('click', async () => {
    const confirmed = await confirmAction({
      title: 'Rebuild this app\'s library list from Rekordbox?',
      message: 'This app\'s own track list (candybar.db) for the current library folder is cleared and rebuilt from Rekordbox\'s export.xml. Export a fresh XML from Rekordbox first.',
      details: [
        { label: 'Rebuilt', value: 'Tracks, health issues, possible duplicates and scan history' },
        { label: 'Kept', value: 'Ignored tracks, dismissed duplicates and issues, download history' },
      ],
      safetyNote: 'Rekordbox itself (master.db) and your music files are not touched.',
      confirmLabel: 'Clear and rebuild',
      tone: 'danger',
      armMs: 1500,
    });
    if (!confirmed || !resyncBtn) return;
    resyncBtn.disabled = true;
    setStatus('Resyncing… (wiping candybar.db, then re-importing from rekordbox XML)');
    if (listEl) listEl.innerHTML = '';
    try {
      const existing = await window.candybar.getConfig();
      const rekordboxXmlPath = getValue('setting-rekordbox-xml-path');
      if (rekordboxXmlPath !== existing.rekordboxXmlPath) {
        await window.candybar.updateConfig({ rekordboxXmlPath });
      }
      const summary = await window.candybar.rekordboxResync();
      setStatus(`Resynced ${summary.imported} · ${summary.missingOnDisk} missing on disk · ${summary.totalInXml} in XML`);
      showToast('success', 'Rebuild finished', `Track Lab\'s library list was rebuilt with ${summary.imported} tracks from your Rekordbox backup file.`);
      autoRefreshLibrary();
    } catch (err) {
      setStatus('Resync failed.');
      showToast('error', 'Couldn\'t rebuild from Rekordbox', getErrorMessage(err));
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
