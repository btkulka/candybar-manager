// Profiles in the window: the chip under the logo (whose Track Lab this is,
// with a menu to switch or add one) and Settings → Profiles (add, rename,
// make default, remove). Each profile is a data folder of its own
// (src/lib/profiles.ts); switching swaps it in place and opens a new window.

import type { ProfilesState, TrackLabProfile } from '../types';
import { escapeHtml, getErrorMessage, showToast } from './shared';
import { confirmAction } from './confirmDialog';
import { openSettingsTo } from './settings';

let state: ProfilesState | null = null;
let renaming: string | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function running(): TrackLabProfile | undefined {
  return state?.profiles.find(p => p.isRunning);
}

function initial(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

function badges(p: TrackLabProfile): string {
  const out: string[] = [];
  if (p.isRunning) out.push('<span class="profile-badge profile-badge--running">Open now</span>');
  if (p.isDefault) out.push('<span class="profile-badge">Default</span>');
  return out.join('');
}

function renderChip(): void {
  const current = running();
  const name = current?.name ?? '…';
  const nameEl = $('profile-chip-name');
  const avatar = $('profile-chip-avatar');
  if (nameEl) nameEl.textContent = name;
  if (avatar) avatar.textContent = current ? initial(current.name) : '';
  // With more than one profile, the title bar says whose Track Lab this is.
  document.title = state && state.profiles.length > 1 && current ? `Track Lab — ${current.name}` : 'Track Lab';
}

function renderMenu(): void {
  const menu = $('profile-menu');
  if (!menu || !state) return;
  const rows = state.profiles.map(p => `
    <button type="button" class="profile-menu-item${p.isRunning ? ' is-current' : ''}" role="menuitemradio" aria-checked="${p.isRunning}" data-profile-switch="${escapeHtml(p.id)}">
      <span class="profile-chip-avatar" aria-hidden="true">${escapeHtml(initial(p.name))}</span>
      <span class="profile-menu-name">${escapeHtml(p.name)}</span>
      ${p.isDefault ? '<span class="profile-badge">Default</span>' : ''}
      ${p.isRunning ? '<svg class="profile-menu-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
    </button>`).join('');
  menu.innerHTML = `
    <p class="profile-menu-title">Profiles</p>
    ${rows}
    <div class="profile-menu-sep" role="separator"></div>
    <button type="button" class="profile-menu-item profile-menu-action" role="menuitem" data-profile-action="add">Add a profile…</button>
    <button type="button" class="profile-menu-item profile-menu-action" role="menuitem" data-profile-action="manage">Manage profiles…</button>`;
}

function renderList(): void {
  const list = $('profile-list');
  if (!list || !state) return;
  list.innerHTML = state.profiles.map(p => {
    const nameCell = renaming === p.id
      ? `<span class="profile-rename">
           <input type="text" class="profile-rename-input" data-instant maxlength="40" value="${escapeHtml(p.name)}" aria-label="New name for ${escapeHtml(p.name)}" />
           <button type="button" class="btn-primary btn-sm" data-profile-rename-save="${escapeHtml(p.id)}">Save</button>
           <button type="button" class="btn-secondary btn-sm" data-profile-rename-cancel>Cancel</button>
         </span>`
      : `<span class="profile-row-name">${escapeHtml(p.name)}</span>${badges(p)}`;
    const actions = renaming === p.id ? '' : [
      p.isRunning ? '' : `<button type="button" class="btn-secondary btn-sm" data-profile-switch="${escapeHtml(p.id)}" data-tooltip="Switch Track Lab to ${escapeHtml(p.name)}">Switch</button>`,
      p.isDefault ? '' : `<button type="button" class="btn-secondary btn-sm" data-profile-default="${escapeHtml(p.id)}" data-tooltip="Open Track Lab as ${escapeHtml(p.name)} from now on">Make default</button>`,
      `<button type="button" class="btn-secondary btn-sm" data-profile-rename="${escapeHtml(p.id)}">Rename</button>`,
      p.isMain || p.isRunning ? '' : `<button type="button" class="btn-secondary btn-sm btn-danger-text" data-profile-remove="${escapeHtml(p.id)}">Remove</button>`,
    ].join('');
    return `
      <li class="profile-row${p.isRunning ? ' is-current' : ''}">
        <span class="profile-chip-avatar" aria-hidden="true">${escapeHtml(initial(p.name))}</span>
        <span class="profile-row-main">
          <span class="profile-row-title">${nameCell}</span>
          <span class="profile-row-dir" title="${escapeHtml(p.dir)}">${escapeHtml(p.dir)}</span>
        </span>
        <span class="profile-row-actions">${actions}</span>
      </li>`;
  }).join('');
  if (renaming) list.querySelector<HTMLInputElement>('.profile-rename-input')?.select();
}

function render(): void {
  renderChip();
  renderMenu();
  renderList();
}

function showError(message: string | null): void {
  const el = $('profile-error');
  if (!el) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

export async function refreshProfiles(): Promise<void> {
  try {
    state = await window.candybar.profilesList();
    render();
  } catch (err) {
    console.warn('[Profiles] could not read profiles:', err);
  }
}

function setMenuOpen(open: boolean): void {
  const menu = $('profile-menu');
  const chip = $('profile-chip');
  if (!menu || !chip) return;
  menu.hidden = !open;
  chip.setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector<HTMLButtonElement>('.profile-menu-item:not(.is-current)')?.focus();
}

async function switchTo(id: string): Promise<void> {
  const target = state?.profiles.find(p => p.id === id);
  if (!target || target.isRunning) return;
  const ok = await confirmAction({
    title: `Switch to ${target.name}?`,
    message: `Track Lab switches to ${target.name}'s folders, sign-ins and downloads.`,
    safetyNote: 'Nothing is lost: switch back any time from the profile menu.',
    confirmLabel: 'Switch',
    tone: 'info',
  });
  if (!ok) return;
  try {
    const result = await window.candybar.profilesSwitch(id);
    if (!result.switched && result.reason) showToast('info', 'Still here', result.reason);
  } catch (err) {
    showToast('error', 'Could not switch profiles', getErrorMessage(err));
  }
}

async function addProfile(): Promise<void> {
  const input = $<HTMLInputElement>('profile-new-name');
  const name = input?.value.trim() ?? '';
  showError(null);
  if (!name) {
    showError('Type a name for the new profile.');
    input?.focus();
    return;
  }
  try {
    const result = await window.candybar.profilesCreate(name, false);
    state = result;
    if (input) input.value = '';
    render();
    const go = await confirmAction({
      title: `Switch to ${result.created.name} now?`,
      message: `Track Lab switches to ${result.created.name} and the setup guide asks for their folders, details and accounts.`,
      confirmLabel: 'Switch and set up',
      cancelLabel: 'Later',
      tone: 'info',
    });
    if (go) {
      const switched = await window.candybar.profilesSwitch(result.created.id);
      if (!switched.switched && switched.reason) showToast('info', 'Still here', switched.reason);
    } else {
      showToast('success', `Added ${result.created.name}`, 'Switch to it from the profile menu under the logo.');
    }
  } catch (err) {
    showError(getErrorMessage(err));
  }
}

async function saveRename(id: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('.profile-rename-input');
  showError(null);
  try {
    state = await window.candybar.profilesRename(id, input?.value ?? '');
    renaming = null;
    render();
  } catch (err) {
    showError(getErrorMessage(err));
  }
}

async function makeDefault(id: string): Promise<void> {
  showError(null);
  try {
    state = await window.candybar.profilesSetDefault(id);
    render();
    const p = state.profiles.find(x => x.id === id);
    if (p) showToast('success', `${p.name} is the default`, 'Track Lab opens as them from now on.');
  } catch (err) {
    showError(getErrorMessage(err));
  }
}

async function removeProfile(id: string): Promise<void> {
  const target = state?.profiles.find(p => p.id === id);
  if (!target) return;
  const ok = await confirmAction({
    title: `Remove ${target.name}?`,
    message: `Their settings, sign-ins, download history and Track Lab library list go to the Trash. Their music files aren't touched.`,
    details: [{ label: 'Folder', value: target.dir }],
    safetyNote: 'The folder can be put back from the Trash, though it won\'t show up as a profile again by itself.',
    confirmLabel: 'Move to Trash',
    tone: 'danger',
  });
  if (!ok) return;
  showError(null);
  try {
    const result = await window.candybar.profilesDelete(id);
    state = result;
    render();
    showToast(result.trashed ? 'success' : 'warning', `Removed ${target.name}`, result.trashed ? 'Its folder is in the Trash.' : `Its folder couldn't go to the Trash: ${result.folder}`);
  } catch (err) {
    showError(getErrorMessage(err));
  }
}

export function initProfiles(): void {
  const chip = $('profile-chip');
  const menu = $('profile-menu');
  const switcher = $('profile-switcher');

  chip?.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu?.hidden ?? true;
    // Re-read first: a profile can be added or renamed from Claude (MCP) too.
    if (opening) void refreshProfiles().then(() => setMenuOpen(true));
    else setMenuOpen(false);
  });
  document.querySelector('.settings-nav-item[data-target="profiles"]')?.addEventListener('click', () => void refreshProfiles());
  document.addEventListener('click', (e) => {
    if (menu && !menu.hidden && !switcher?.contains(e.target as Node)) setMenuOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu && !menu.hidden) {
      setMenuOpen(false);
      chip?.focus();
    }
  });
  menu?.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-profile-switch], [data-profile-action]');
    if (!el) return;
    setMenuOpen(false);
    if (el.dataset.profileSwitch) {
      void switchTo(el.dataset.profileSwitch);
    } else {
      openSettingsTo('profiles');
      void refreshProfiles();
      if (el.dataset.profileAction === 'add') setTimeout(() => $('profile-new-name')?.focus(), 50);
    }
  });

  $('profile-add')?.addEventListener('click', () => void addProfile());
  $('profile-new-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void addProfile();
    }
  });

  $('profile-list')?.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!el) return;
    const d = el.dataset;
    if (d.profileSwitch) void switchTo(d.profileSwitch);
    else if (d.profileDefault) void makeDefault(d.profileDefault);
    else if (d.profileRename) { renaming = d.profileRename; showError(null); renderList(); }
    else if (d.profileRenameSave) void saveRename(d.profileRenameSave);
    else if ('profileRenameCancel' in d) { renaming = null; renderList(); }
    else if (d.profileRemove) void removeProfile(d.profileRemove);
  });
  $('profile-list')?.addEventListener('keydown', (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>('.profile-rename-input');
    if (!input || !renaming) return;
    if (e.key === 'Enter') { e.preventDefault(); void saveRename(renaming); }
    if (e.key === 'Escape') { e.stopPropagation(); renaming = null; renderList(); }
  });

  void refreshProfiles();
}
