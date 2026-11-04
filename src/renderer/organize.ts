import type { TrackInfo, OrganizeConflictFile, OrganizeState, OrganizeProgress, ScanProgress } from './shared';
import type { OrganizeConflict } from '../types';
import {
  showToast, setStatus as setShellStatus, escapeHtml, getValue, setValue, icons, showContextMenu, openTagEditor, formatDuration,
  getErrorMessage, convertTrackWithRepair, plural, updateTrackTagsWithRepair, confirmTagWriteConversion,
} from './shared';
import { confirmAction, confirmMoveToTrash } from './confirmDialog';
import { addConversionTask, updateConversionTask } from './activity';
import { playFile } from './player';
import { pushFloatingConsole } from './settings';
import { autoRefreshLibrary } from './library';

// "Sort new music": one button checks the downloads folder (already known from
// setup), one list shows what's ready and what needs help (with the fix right
// on the row), and one button moves the ready tracks into the library, one
// folder per artist.
//
// What actually happens to files (keep the page copy in step with this):
//  - Check (scan-tracks) pulls audio files out of sub-folders of the downloads
//    folder and tidies away Finder junk and empty folders, then reads every
//    track. Autopopulate then writes any missing track info it finds online
//    into the files. Nothing goes into the library.
//  - Move (organize-tracks) moves only the tracks that are ready, after a
//    confirm. A file that already exists in the artist's folder is never
//    overwritten: it comes back as "already in your library" to decide on.

/** The shell's status line may not be on screen (it throws when it isn't);
 *  a missing status line must never stop a check or a move. */
function setStatus(text: string) {
  try { setShellStatus(text); } catch { /* no status line */ }
}

// ========== DOM Elements ==========

const pageEl = document.getElementById('page-organize') as HTMLElement | null;
const scanTracksBtn = document.getElementById('scan-tracks') as HTMLButtonElement;
const runOrganize = document.getElementById('run-organize') as HTMLButtonElement;
const runOrganizeLabel = document.getElementById('run-organize-label') as HTMLSpanElement | null;
const saveOrganize = document.getElementById('save-organize') as HTMLButtonElement;
const toggleDevToolsBtn = document.getElementById('toggle-devtools') as HTMLButtonElement | null;
const sourceInput = document.getElementById('organize-source') as HTMLInputElement;
const browseBtn = document.getElementById('organize-browse') as HTMLButtonElement | null;
const startEl = document.getElementById('organize-step-folder') as HTMLElement | null;
const folderNameEl = document.getElementById('organize-folder-name') as HTMLElement | null;
const folderPathEl = document.getElementById('organize-folder-path') as HTMLElement | null;
const folderProblemEl = document.getElementById('organize-folder-problem') as HTMLDivElement | null;
const emptyEl = document.getElementById('organize-empty') as HTMLElement | null;
const emptyTextEl = document.getElementById('organize-empty-text') as HTMLParagraphElement | null;
const emptyChooseBtn = document.getElementById('organize-empty-choose') as HTMLButtonElement | null;

const reviewEl = document.getElementById('track-list-section') as HTMLElement;
const trackListEl = document.getElementById('track-list') as HTMLDivElement;
const summaryTitleEl = document.getElementById('organize-summary-title') as HTMLElement | null;
const summaryEl = document.getElementById('organize-summary') as HTMLParagraphElement | null;
const clearTracksBtn = document.getElementById('clear-tracks') as HTMLButtonElement;

const reviewHeadEl = document.getElementById('organize-review-head') as HTMLElement | null;
const moveBarEl = document.getElementById('organize-step-move') as HTMLElement | null;
const moveResultEl = document.getElementById('organize-move-result') as HTMLDivElement | null;
const moveNoteTextEl = document.getElementById('organize-move-note-text') as HTMLElement | null;

// Check progress elements
const scanProgressEl = document.getElementById('scan-progress') as HTMLDivElement;
const scanProgressLabel = document.getElementById('scan-progress-label') as HTMLSpanElement;
const scanProgressCounts = document.getElementById('scan-progress-counts') as HTMLSpanElement;
const scanProgressBarFill = document.getElementById('scan-progress-bar-fill') as HTMLDivElement;
const scanProgressCurrent = document.getElementById('scan-progress-current') as HTMLDivElement;

// Move progress elements
const progressEl = document.getElementById('organize-progress') as HTMLDivElement;
const progressLabel = document.getElementById('organize-progress-label') as HTMLSpanElement;
const progressCounts = document.getElementById('organize-progress-counts') as HTMLSpanElement;
const progressBarFill = document.getElementById('organize-progress-bar-fill') as HTMLDivElement;
const progressCurrent = document.getElementById('organize-progress-current') as HTMLDivElement;
const progressSuccessEl = document.getElementById('organize-progress-success') as HTMLSpanElement;
const progressConflictEl = document.getElementById('organize-progress-conflict') as HTMLSpanElement;
const progressErrorEl = document.getElementById('organize-progress-error') as HTMLSpanElement;
const progressSkippedEl = document.getElementById('organize-progress-skipped') as HTMLSpanElement;

// ========== Icons (Lucide-style, stroke 2) ==========

const svg = (body: string, cls = '') =>
  `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON_BODY = {
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  drive: '<line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/>',
  folderX: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="9.5" y1="10.5" x2="14.5" y2="15.5"/><line x1="14.5" y1="10.5" x2="9.5" y2="15.5"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  warn: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
};

const ICON = Object.fromEntries(
  Object.entries(ICON_BODY).map(([k, body]) => [k, svg(body)])
) as Record<keyof typeof ICON_BODY, string>;
const calloutIcon = (k: keyof typeof ICON_BODY) => svg(ICON_BODY[k], 'callout-icon');

// Row tooltips. Local rather than the shared actionHints: on this page the
// file is in the downloads folder, not the library.
const HINT = {
  play: 'Listen to it in the player at the top of the window.',
  edit: 'Change the artist, title, key, BPM and cover art saved inside the file.',
  skip: 'Leave this track in your downloads folder when you move the others.',
  include: 'Move this track with the others again.',
  convert: 'Make an AIFF copy, a full-quality (lossless) file type that CDJs play. It sounds the same.',
  retry: 'Put this track back with the ones that are ready, so the next move tries it again.',
  more: 'More things you can do with this track.',
  archive: 'Move it out of your downloads folder into your set-aside folder (archive). Nothing is deleted.',
  trash: 'Move it to the Trash. You\'ll be asked first, and you can put it back from Finder.',
  finder: 'Open the folder it\'s in.',
  keepIncoming: 'Put the new download in your library. The copy that was there goes to the Trash.',
  keepExisting: 'Keep the copy already in your library. The new download goes to the Trash, and Track Lab won\'t download it again.',
} as const;

// ========== State ==========

/** What a track's row says. Every state has a word, not just a colour. */
type TrackState = 'ready' | 'needs-artist' | 'wont-play' | 'skipped' | 'moved' | 'in-library' | 'failed';
type GroupKey = 'help' | 'ready' | 'moved' | 'skipped';

/** Stored in errorMessage so a saved list (organize state) keeps the outcome. */
const CONFLICT_MESSAGE = 'Conflict: file already exists at destination';
/** Rows per group before "Show all". */
const GROUP_PAGE = 100;

let tracks: TrackInfo[] = [];
let conflicts: OrganizeConflict[] = [];
let organizeRunCounters: ProgressCounters | null = null;
let libraryRoot = '';
/** organizeSourceDir as saved in config, so "Remember this folder" only shows
 *  when the folder on screen is a different one. */
let savedFolder = '';
/** The folder the list on screen came from. */
let checkedFolder = '';
// Set once a check has run (or a saved list came back), so the check button
// can say "Check again".
let hasChecked = false;
// Set once the user triggers a scan or otherwise modifies the organize state.
// Startup restoreOrganizeState races with fast user action — without this
// guard, a late cache restore can clobber freshly-scanned tracks.
let userHasModifiedState = false;
// Scan → autopopulate → rescan. Move and Clear stay locked until it ends:
// autopopulate is still writing track info into these files, and the rescan
// replaces the list.
let scanPipelineRunning = false;
// Which pass of the check the progress events belong to (the second scan only
// refreshes the list after autopopulate).
let scanPass = 1;
let moveRunning = false;
/** How many tracks the last move put in the library, for the "All done!" heading. */
let lastMoved = 0;
const openGroups = new Set<GroupKey>();
const expandedGroups = new Set<GroupKey>();

function syncOrganizeState() {
  window.candybar.updateOrganizeState({ tracks, conflicts });
}

// ========== Words ==========

const fmt = (n: number) => n.toLocaleString();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "a", "a and b", "a, b and c" */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function fileNameOf(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p;
}

function parentFolderOf(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/** The artist folder a track will land in. Mirrors normalizeArtist in
 *  lib/organizeByArtist (first credited artist, file-safe), without the case
 *  matching against existing folders the move itself does. */
function folderNameFor(artist: string): string {
  const first = artist.normalize('NFC').split(/\s*;\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0] ?? '';
  const safe = first
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '')
    .trim();
  return safe || 'Unknown Artist';
}

/** "Artist - Title" in the title or file name: a guess at the missing artist. */
function guessArtist(track: TrackInfo): { artist: string; title: string; from: string } | null {
  const base = track.fileName.replace(/\.[^.]+$/, '');
  for (const from of [track.title, base]) {
    const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(from || '');
    if (m && m[1].trim() && m[2].trim()) return { artist: m[1].trim(), title: m[2].trim(), from };
  }
  return null;
}

function fileTypeOf(track: TrackInfo): string {
  const ext = (track.fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'aif' || ext === 'aiff' || ext === 'aifc') return 'AIFF';
  if (ext === 'wav') return 'WAV';
  if (ext === 'mp3') return 'MP3';
  if (ext === 'flac') return 'FLAC';
  if (ext === 'm4a') return 'M4A';
  return ext.toUpperCase();
}

/** "AIFF, full quality (lossless). 24-bit, 44.1 kHz." for the file-type chip. */
function fileTypeTooltip(track: TrackInfo): string {
  const type = fileTypeOf(track);
  const f = track.health?.format;
  const quality = f?.lossless === true
    ? 'full quality (lossless)'
    : f?.lossless === false ? 'compressed, lower quality' : '';
  const detail: string[] = [];
  if (f?.bitDepth) detail.push(`${f.bitDepth}-bit`);
  if (f?.sampleRate) detail.push(`${(f.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`);
  if (f?.bitRate && f.lossless === false) detail.push(`${f.bitRate} kbps`);
  return `File type: ${type}${quality ? `, ${quality}` : ''}.${detail.length ? ` ${detail.join(', ')}.` : ''}`;
}

/** A health issue in plain words. The technical message stays in the tooltip. */
function issueInWords(issue: { code: string; message: string }, track: TrackInfo): string {
  const fileType = fileTypeOf(track);
  switch (issue.code) {
    case 'FILE_NOT_FOUND': return 'The file is missing';
    case 'UNKNOWN_CONTAINER': return 'Track Lab can\'t tell what kind of file this is';
    case 'UNSUPPORTED_FORMAT': return `CDJs can't play ${fileType ? `${fileType} files` : 'this file type'}`;
    case 'INVALID_SAMPLE_RATE':
    case 'LOW_SAMPLE_RATE': return 'Saved at a sample rate CDJs can\'t play';
    case 'INVALID_BIT_DEPTH': return 'Saved at a bit depth CDJs can\'t play';
    case 'BIT_DEPTH_32': return 'Saved as 32-bit, which CDJs can\'t play';
    case 'MULTICHANNEL': return 'Has more than two channels, and CDJs need stereo';
    case 'NON_PCM_CODEC': return 'Saved in an unusual way CDJs may not read';
    case 'PARSE_ERROR': return 'The file may be damaged';
    case 'BROKEN_AUDIO': return 'The audio is damaged';
    case 'LOW_BITRATE': return 'Lower-quality MP3';
    case 'HIGH_BITRATE': return 'Unusual MP3 setting some players reject';
    case 'LOSSY_FORMAT': return 'Compressed file (lower quality)';
    case 'WAV_METADATA_WARNING': return 'WAV file that can show an error on some CDJs';
    case 'LONG_DURATION': return 'Very long, maybe a whole mix';
    case 'SHORT_DURATION': return 'Very short, maybe a snippet';
    case 'MISSING_ALBUM_ART': return 'No cover art';
    case 'MISSING_TAGS': return track.hasArtist ? 'No title' : '';
    case 'SPARSE_TAGS': return 'Some track info is empty';
    case 'PATH_TOO_DEEP': return 'Buried in too many folders';
    default: return issue.message;
  }
}

// ========== Track states ==========

function trackState(track: TrackInfo): TrackState {
  if (track.status === 'success') return 'moved';
  if (track.status === 'error') {
    const msg = track.errorMessage ?? '';
    if (msg.startsWith('Conflict')) return 'in-library';
    // Lists saved by older versions marked tracks that won't play this way.
    if (msg.startsWith('Skipped')) return 'wont-play';
    return 'failed';
  }
  if (track.ignored) return 'skipped';
  if (!track.hasArtist) return 'needs-artist';
  if (track.health?.isHealthy === false) return 'wont-play';
  return 'ready';
}

const GROUP_OF: Record<TrackState, GroupKey> = {
  ready: 'ready',
  'needs-artist': 'help',
  'wont-play': 'help',
  'in-library': 'help',
  failed: 'help',
  moved: 'moved',
  skipped: 'skipped',
};

const STATE_PILL: Partial<Record<TrackState, { tone: string; label: string }>> = {
  'needs-artist': { tone: 'status-pill--warn', label: 'Needs an artist' },
  'wont-play': { tone: 'status-pill--danger', label: 'Won\'t play on CDJs' },
  'in-library': { tone: 'status-pill--warn', label: 'Already in library' },
  failed: { tone: 'status-pill--danger', label: 'Couldn\'t move' },
  moved: { tone: 'status-pill--ok', label: 'Moved' },
};

/** Exactly the tracks the Move button moves. */
function movableTracks(): TrackInfo[] {
  return tracks.filter((t) => trackState(t) === 'ready');
}

type Counts = Record<TrackState, number> & { total: number; help: number };

function countTracks(): Counts {
  const c: Counts = {
    total: tracks.length, help: 0,
    ready: 0, 'needs-artist': 0, 'wont-play': 0, skipped: 0, moved: 0, 'in-library': 0, failed: 0,
  };
  for (const t of tracks) {
    const s = trackState(t);
    c[s]++;
    if (GROUP_OF[s] === 'help') c.help++;
  }
  return c;
}

const isAre = (n: number) => (n === 1 ? 'is' : 'are');

/** Heading for the list: the one thing that matters most right now. */
function summaryTitle(c: Counts): string {
  if (c.ready > 0) return c.ready === 1 ? '1 track is ready to move' : `${fmt(c.ready)} tracks are ready to move`;
  if (c.help > 0) return c.help === 1 ? '1 track needs your help' : `${fmt(c.help)} tracks need your help`;
  if (c.moved > 0) return 'Everything is in your library';
  return c.skipped === 1 ? 'The only track is skipped' : 'Every track is skipped';
}

/** "40 tracks found in “New music”. 6 need an artist name and 2 won't play on CDJs." */
function summarySentence(c: Counts): string {
  const folder = checkedFolder || getValue('organize-source');
  const lead = `${plural(c.total, 'track')} found${folder ? ` in "${fileNameOf(folder)}"` : ''}.`;
  const parts: string[] = [];
  if (c['needs-artist']) parts.push(`${fmt(c['needs-artist'])} ${c['needs-artist'] === 1 ? 'needs' : 'need'} an artist name`);
  if (c['wont-play']) parts.push(`${fmt(c['wont-play'])} won't play on CDJs`);
  if (c['in-library']) parts.push(`${fmt(c['in-library'])} ${isAre(c['in-library'])} already in your library`);
  if (c.failed) parts.push(`${fmt(c.failed)} couldn't be moved`);
  if (c.moved) parts.push(`${fmt(c.moved)} ${c.ready || c.help ? 'already moved' : 'moved into your library'}`);
  if (c.skipped) parts.push(`${fmt(c.skipped)} skipped`);
  if (parts.length === 0) return `${lead} Nothing needs your help.`;
  return `${lead} ${cap(joinList(parts))}.`;
}

// ========== Rows ==========

/** The plain sentence under a track: where it's going, or what's in the way. */
function trackNote(track: TrackInfo, state: TrackState): { tone: string; text: string; tooltip?: string } | null {
  const issues = track.health?.issues ?? [];
  const technical = issues.map((i) => (i.detail ? `${i.message}. ${i.detail}` : i.message)).join('\n');
  switch (state) {
    case 'moved': {
      const folder = track.resultPath ? parentFolderOf(track.resultPath) : '';
      return { tone: 'ok', text: folder ? `In the "${folder}" folder in your library.` : 'In your library.', tooltip: track.resultPath };
    }
    case 'in-library':
      return { tone: 'warn', text: 'A file with this name is already in that artist\'s folder. Which copy do you want to keep?' };
    case 'failed': {
      const msg = track.errorMessage ?? '';
      if (/^Metadata read failed/i.test(msg)) {
        return { tone: 'danger', text: 'Track Lab couldn\'t read this file\'s info. The file may be damaged.', tooltip: msg };
      }
      if (/No artist found/i.test(msg)) {
        return { tone: 'danger', text: 'This file has no artist name, so it stayed in your downloads folder.', tooltip: msg };
      }
      return { tone: 'danger', text: 'Track Lab couldn\'t move this file, so it\'s still in your downloads folder. Check the drive is plugged in, then try again.', tooltip: msg || undefined };
    }
    case 'skipped':
      return { tone: 'muted', text: 'Stays in your downloads folder.' };
    case 'needs-artist': {
      const guess = guessArtist(track);
      return {
        tone: 'warn',
        text: guess
          ? 'Track Lab guessed the artist from the file name. Check it, then save.'
          : 'Track Lab names each folder after the artist, so this one can\'t move yet.',
      };
    }
    case 'wont-play': {
      const blockers = issues.filter((i) => i.severity === 'error').map((i) => issueInWords(i, track)).filter(Boolean);
      const what = blockers.length ? `${joinList(blockers)}. ` : '';
      return { tone: 'danger', text: `${what}Convert it to AIFF to move it, or skip it.`, tooltip: technical || undefined };
    }
    case 'ready': {
      const notes = issues.filter((i) => i.severity !== 'error').map((i) => issueInWords(i, track)).filter(Boolean);
      const dest = `Goes into "${folderNameFor(track.artist)}"`;
      return { tone: 'muted', text: notes.length ? `${dest} · ${notes.join(' · ')}` : dest, tooltip: technical || undefined };
    }
  }
}

function conflictFor(track: TrackInfo): OrganizeConflict | undefined {
  return conflicts.find((c) => c.incoming.filePath === track.filePath);
}

/** The fix that sits right on a "needs your help" row (or Include on a skipped one). */
function trackFixHtml(track: TrackInfo, state: TrackState): string {
  const skip = `<button type="button" class="btn-ghost btn-sm" data-fix="skip" data-tooltip="${escapeHtml(HINT.skip)}">Skip</button>`;
  switch (state) {
    case 'needs-artist': {
      const guess = guessArtist(track);
      const inputId = `organize-artist-${track.id}`;
      return `<form class="track-fix track-fix-artist" data-fix="artist" novalidate>
        <label class="visually-hidden" for="${escapeHtml(inputId)}">Artist name for ${escapeHtml(track.title)}</label>
        <input type="text" id="${escapeHtml(inputId)}" class="track-fix-input" placeholder="Type the artist name" autocomplete="off" spellcheck="false" value="${escapeHtml(guess?.artist ?? '')}" />
        <button type="submit" class="btn-secondary btn-sm" data-tooltip="Save this artist name into the file. Then the track can move.">Save artist</button>
        ${skip}
      </form>`;
    }
    case 'wont-play':
      return `<div class="track-fix">
        <button type="button" class="btn-secondary btn-sm" data-fix="convert" data-tooltip="${escapeHtml(HINT.convert)}">Convert to AIFF</button>
        ${skip}
      </div>`;
    case 'failed':
      return `<div class="track-fix">
        <button type="button" class="btn-secondary btn-sm" data-fix="retry" data-tooltip="${escapeHtml(HINT.retry)}">Try again</button>
        ${skip}
      </div>`;
    case 'in-library': {
      const conflict = conflictFor(track);
      if (!conflict) {
        return '<div class="track-fix"><span class="track-fix-hint">Press Check again to compare the two copies.</span></div>';
      }
      const incoming = describeConflictFile(conflict.incoming);
      const existing = describeConflictFile(conflict.existing);
      // Point out the full-quality copy only when exactly one of them is.
      const incomingBetter = incoming.lossless === true && existing.lossless === false;
      const existingBetter = existing.lossless === true && incoming.lossless === false;
      return `<div class="track-fix track-fix-conflict">
        <div class="conflict-pair-files">
          ${renderConflictFileCard(conflict.incoming, 'New download', incomingBetter)}
          ${renderConflictFileCard(conflict.existing, 'In your library', existingBetter)}
        </div>
        <div class="conflict-actions">
          <button type="button" class="btn-secondary btn-sm" data-fix="keep-incoming" data-tooltip="${escapeHtml(HINT.keepIncoming)}">Keep new download</button>
          <button type="button" class="btn-secondary btn-sm" data-fix="keep-existing" data-tooltip="${escapeHtml(HINT.keepExisting)}">Keep library copy</button>
        </div>
      </div>`;
    }
    case 'skipped':
      return `<div class="track-fix"><button type="button" class="btn-ghost btn-sm" data-fix="include" data-tooltip="${escapeHtml(HINT.include)}">Include</button></div>`;
    default:
      return '';
  }
}

function createTrackElement(track: TrackInfo): HTMLElement {
  const state = trackState(track);
  const el = document.createElement('div');
  el.className = `track-item organize-track is-${state}`;
  el.dataset.trackId = track.id;
  if (track.ignored) el.classList.add('ignored');
  if (track.status === 'success') el.classList.add('success');
  if (track.status === 'error') el.classList.add('has-error');

  const pill = STATE_PILL[state];
  const note = trackNote(track, state);
  const fileType = fileTypeOf(track);
  const canEdit = state !== 'moved';
  const artHtml = track.albumArt ? `<img src="${track.albumArt}" alt="Cover art" />` : icons.albumPlaceholder;
  const titleHtml = canEdit
    ? `<button type="button" class="track-title track-title-btn" data-fix="edit" data-tooltip="Edit this track's info." title="${escapeHtml(track.fileName)}">${escapeHtml(track.title)}</button>`
    : `<div class="track-title" title="${escapeHtml(track.fileName)}">${escapeHtml(track.title)}</div>`;

  el.innerHTML = `
    <div class="track-art">${artHtml}</div>
    <div class="track-info">
      ${titleHtml}
      <div class="track-meta">
        <span class="track-artist ${track.hasArtist ? '' : 'missing'}">${track.hasArtist ? escapeHtml(track.artist) : 'No artist name'}</span>
        ${fileType ? `<span class="track-format" tabindex="0" data-tooltip="${escapeHtml(fileTypeTooltip(track))}">${escapeHtml(fileType)}</span>` : ''}
      </div>
      ${note ? `<div class="track-note track-note--${note.tone}"${note.tooltip ? ` title="${escapeHtml(note.tooltip)}"` : ''}>${escapeHtml(note.text)}</div>` : ''}
    </div>
    ${pill ? `<span class="status-pill ${pill.tone} track-state">${pill.label}</span>` : ''}
    <div class="track-actions">
      <button type="button" class="btn-icon preview-btn" aria-label="Play ${escapeHtml(track.title)}" data-tooltip="${escapeHtml(HINT.play)}">
        <svg class="icon-play" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <svg class="icon-stop" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
      </button>
      <button type="button" class="btn-icon more-btn" aria-label="More actions for ${escapeHtml(track.title)}" aria-haspopup="menu" data-tooltip="${escapeHtml(HINT.more)}">${ICON.more}</button>
    </div>
    ${trackFixHtml(track, state)}
  `;

  el.querySelector<HTMLButtonElement>('.preview-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    playFile(state === 'moved' && track.resultPath ? track.resultPath : track.filePath, track.title);
  });

  const openMenu = (x: number, y: number) => showContextMenu(x, y, trackMenuItems(track, state));
  el.querySelector<HTMLButtonElement>('.more-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom + 4);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY);
  });

  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-fix]');
    if (!btn) return;
    switch (btn.dataset.fix) {
      case 'edit': openTagEditor(track, (u) => updateTrackInList(u, track.filePath)); break;
      case 'skip':
      case 'include': toggleIgnore(track.id); break;
      case 'convert': void handleConvertTrack(track); break;
      case 'retry': retryTrack(track); break;
      case 'keep-incoming':
      case 'keep-existing': {
        const conflict = conflictFor(track);
        if (conflict) void resolveConflict(conflict, btn.dataset.fix === 'keep-incoming' ? 'incoming' : 'existing', el);
        break;
      }
    }
  });

  const artistForm = el.querySelector<HTMLFormElement>('form[data-fix="artist"]');
  artistForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    void saveInlineArtist(track, artistForm);
  });

  return el;
}

function trackMenuItems(track: TrackInfo, state: TrackState) {
  if (state === 'moved') {
    return [{
      label: 'Show in Finder',
      icon: ICON.folder,
      hint: HINT.finder,
      action: () => void window.candybar.showInFinder(track.resultPath || track.filePath),
    }];
  }
  const canSkip = state === 'ready' || state === 'needs-artist' || state === 'wont-play' || state === 'skipped';
  return [
    { label: 'Edit info', icon: icons.edit, hint: HINT.edit, action: () => openTagEditor(track, (u) => updateTrackInList(u, track.filePath)) },
    ...(canSkip ? [{
      label: track.ignored ? 'Include this track' : 'Skip this track',
      icon: track.ignored ? icons.include : icons.ignore,
      hint: track.ignored ? HINT.include : HINT.skip,
      action: () => toggleIgnore(track.id),
    }] : []),
    { label: 'Convert to AIFF', icon: icons.convert, hint: HINT.convert, action: () => void handleConvertTrack(track) },
    { label: 'Show in Finder', icon: ICON.folder, hint: HINT.finder, action: () => void window.candybar.showInFinder(track.filePath) },
    { separator: true },
    { label: 'Set aside', icon: icons.archive, hint: HINT.archive, action: () => void handleArchiveTrack(track) },
    { label: 'Move to Trash…', icon: icons.trash, danger: true, hint: HINT.trash, action: () => void trashTrack(track) },
  ];
}

// ========== Groups ==========

const GROUP_COPY: Record<GroupKey, { title: string; desc: string }> = {
  help: { title: 'Needs your help', desc: 'These stay in your downloads folder until you fix or skip them.' },
  ready: { title: 'Ready to move', desc: 'Each one goes into a folder named after its artist, inside your library folder.' },
  moved: { title: 'Moved into your library', desc: 'Each one is in its artist\'s folder.' },
  skipped: { title: 'Skipped', desc: 'These stay in your downloads folder.' },
};

function buildGroup(key: GroupKey, rows: TrackInfo[], skippable: number): HTMLElement {
  const copy = GROUP_COPY[key];
  const collapsible = key === 'moved' || key === 'skipped';
  const limit = expandedGroups.has(key) ? rows.length : GROUP_PAGE;

  const body = document.createElement('div');
  body.className = 'organize-group-rows';
  rows.slice(0, limit).forEach((t) => body.appendChild(createTrackElement(t)));
  if (rows.length > limit) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn-ghost btn-sm organize-group-more';
    more.textContent = `Show all ${fmt(rows.length)}`;
    more.addEventListener('click', () => { expandedGroups.add(key); renderTrackList(); });
    body.appendChild(more);
  }

  const count = `<span class="organize-group-count">${fmt(rows.length)}</span>`;
  const descHtml = key === 'ready' && libraryRoot
    ? copy.desc.replace('your library folder', `<span class="term" tabindex="0" data-tooltip="${escapeHtml(libraryRoot)}">your library folder</span>`)
    : escapeHtml(copy.desc);

  if (collapsible) {
    const details = document.createElement('details');
    details.className = `organize-group organize-group--${key}`;
    details.open = openGroups.has(key);
    details.innerHTML = `<summary class="organize-group-head"><span class="organize-group-title">${copy.title}</span>${count}<span class="organize-group-desc">${descHtml}</span></summary>`;
    details.appendChild(body);
    details.addEventListener('toggle', () => {
      if (details.open) openGroups.add(key); else openGroups.delete(key);
    });
    return details;
  }

  const section = document.createElement('section');
  section.className = `organize-group organize-group--${key}`;
  const headId = `organize-group-${key}`;
  section.setAttribute('aria-labelledby', headId);
  section.innerHTML = `
    <header class="organize-group-head">
      <div>
        <h4 id="${headId}"><span class="organize-group-title">${copy.title}</span>${count}</h4>
        <p class="organize-group-desc">${descHtml}</p>
      </div>
      ${key === 'help' && skippable > 1
        ? `<button type="button" class="btn-ghost btn-sm" id="ignore-all-missing" data-tooltip="Leave these in your downloads folder for now. You can include them again from Skipped.">Skip all ${fmt(skippable)}</button>`
        : ''}
    </header>`;
  section.appendChild(body);
  section.querySelector('#ignore-all-missing')?.addEventListener('click', skipAllThatNeedHelp);
  return section;
}

function renderTrackList() {
  // Typing into an inline artist box survives a re-render.
  const typing = document.activeElement instanceof HTMLInputElement && trackListEl.contains(document.activeElement)
    ? { id: document.activeElement.id, value: document.activeElement.value }
    : null;

  trackListEl.innerHTML = '';
  const byGroup: Record<GroupKey, TrackInfo[]> = { help: [], ready: [], moved: [], skipped: [] };
  for (const t of tracks) byGroup[GROUP_OF[trackState(t)]].push(t);
  const skippable = byGroup.help.filter((t) => {
    const s = trackState(t);
    return s === 'needs-artist' || s === 'wont-play';
  }).length;

  // Nothing else to show? Open the folded group so the page isn't empty.
  const onlyFolded = byGroup.help.length === 0 && byGroup.ready.length === 0;
  if (onlyFolded && byGroup.moved.length) openGroups.add('moved');
  else if (onlyFolded && byGroup.skipped.length) openGroups.add('skipped');

  (['help', 'ready', 'moved', 'skipped'] as GroupKey[]).forEach((key) => {
    if (byGroup[key].length) trackListEl.appendChild(buildGroup(key, byGroup[key], skippable));
  });

  if (typing) {
    const input = document.getElementById(typing.id) as HTMLInputElement | null;
    if (input) { input.value = typing.value; input.focus(); }
  }
  updateSummary();
  updateRunButton();
}

function replaceTrackElement(track: TrackInfo) {
  const existing = trackListEl.querySelector(`[data-track-id="${CSS.escape(track.id)}"]`) as HTMLElement | null;
  if (!existing) return;
  existing.replaceWith(createTrackElement(track));
}

function markTrackProcessing(filePath: string) {
  clearTrackProcessing();
  const track = tracks.find((t) => t.filePath === filePath);
  if (!track) return;
  const el = trackListEl.querySelector(`[data-track-id="${CSS.escape(track.id)}"]`) as HTMLElement | null;
  if (!el) return;
  el.classList.add('organize-processing');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearTrackProcessing() {
  trackListEl.querySelectorAll('.track-item.organize-processing').forEach((el) => {
    el.classList.remove('organize-processing');
  });
}

/** Everything on the list is in the library: nothing to move, nothing to fix. */
function isAllDone(c: Counts = countTracks()): boolean {
  return c.total > 0 && c.moved > 0 && c.ready === 0 && c.help === 0 && !moveRunning;
}

function updateSummary() {
  const c = countTracks();
  const done = isAllDone(c);
  let title = c.total ? summaryTitle(c) : 'Your new tracks';
  if (done && lastMoved > 0) {
    title = lastMoved === 1 ? 'All done! The track is in your library.' : `All done! ${fmt(lastMoved)} tracks are in your library.`;
  }
  if (summaryTitleEl) summaryTitleEl.textContent = title;
  if (summaryEl) summaryEl.textContent = c.total ? summarySentence(c) : '';
  // The finished job gets the record artwork; the Move bar has nothing left to do.
  reviewHeadEl?.classList.toggle('art-hero', done);
  reviewHeadEl?.classList.toggle('organize-done', done);
  reviewHeadEl?.querySelector('.organize-review-head-text')?.classList.toggle('art-hero-content', done);
  if (moveBarEl) moveBarEl.hidden = done;
}

// ========== The folder, and the page's overall state ==========

function refreshFolderDisplay() {
  const folder = getValue('organize-source');
  if (folderNameEl) folderNameEl.textContent = folder ? fileNameOf(folder) : 'No folder chosen yet';
  if (folderPathEl) {
    folderPathEl.textContent = folder || 'Choose the folder your new downloads land in.';
    folderPathEl.title = folder;
  }
  // With no folder yet, the big button is the one that picks it.
  if (browseBtn) { browseBtn.textContent = 'Change…'; browseBtn.hidden = !folder; }
  saveOrganize.hidden = !folder || folder === savedFolder;
  updateCheckButton();
}

async function pickFolder() {
  const selection = await window.candybar.selectPath('dir');
  if (!selection) return;
  setValue('organize-source', selection);
  clearFolderProblem();
  if (emptyEl) emptyEl.hidden = true;
  refreshFolderDisplay();
}

function setResultsVisible(visible: boolean) {
  reviewEl.style.display = visible ? 'block' : 'none';
  if (visible && emptyEl) emptyEl.hidden = true;
}

/** One primary button per state. No list yet: the big "Check my new
 *  downloads" (or "Choose your downloads folder" if there isn't one). Once
 *  there's a list, Move takes over and the check becomes a small "Check again". */
function updateCheckButton() {
  const hasList = tracks.length > 0;
  const folder = getValue('organize-source');
  // When the list is all done, checking for more is the next step again.
  const primary = !hasList || isAllDone();
  startEl?.classList.toggle('is-compact', hasList);
  // The record artwork only while the card is just a welcome: not while
  // checking, and not under a problem or the "no music" card.
  const idle = !hasList && !scanPipelineRunning && (folderProblemEl?.hidden ?? true) && (emptyEl?.hidden ?? true);
  startEl?.classList.toggle('art-hero', idle);
  scanTracksBtn.classList.toggle('btn-primary', primary);
  scanTracksBtn.classList.toggle('btn-lg', !hasList);
  scanTracksBtn.classList.toggle('btn-secondary', !primary);
  scanTracksBtn.classList.toggle('btn-sm', hasList);
  if (scanPipelineRunning) scanTracksBtn.textContent = 'Checking…';
  else if (!folder) scanTracksBtn.textContent = 'Choose your downloads folder';
  else scanTracksBtn.textContent = hasChecked || hasList ? 'Check again' : 'Check my new downloads';
  scanTracksBtn.dataset.tooltip = folder
    ? 'Look through the folder for new tracks and anything missing. Nothing goes into your library yet.'
    : 'Pick the folder your new downloads land in.';
  scanTracksBtn.dataset.tooltipDisabled = moveRunning
    ? 'Wait for the move to finish, then check again.'
    : 'Track Lab is checking this folder now.';
}

// ========== Check progress ==========

function showScanProgress() {
  scanProgressEl.style.display = 'flex';
  scanProgressLabel.textContent = 'Getting the folder ready…';
  scanProgressCounts.textContent = '';
  scanProgressBarFill.style.width = '0%';
  scanProgressCurrent.textContent = '';
}

function updateScanProgress(payload: ScanProgress) {
  if (payload.phase === 'flattening') {
    scanProgressLabel.textContent = scanPass === 1 ? 'Pulling tracks out of any sub-folders…' : 'Updating the list…';
    scanProgressCounts.textContent = '';
    scanProgressBarFill.style.width = '0%';
    scanProgressCurrent.textContent = '';
    return;
  }

  if (payload.phase === 'scanning') {
    const pct = payload.total === 0 ? 0 : Math.round((payload.current / payload.total) * 100);
    scanProgressLabel.textContent = scanPass === 1 ? 'Checking tracks…' : 'Updating the list…';
    scanProgressCounts.textContent = payload.total ? `${fmt(payload.current)} of ${fmt(payload.total)}` : '';
    scanProgressBarFill.style.width = `${pct}%`;
    if (payload.filePath) scanProgressCurrent.textContent = fileNameOf(payload.filePath);
    return;
  }

  if (payload.phase === 'done') {
    scanProgressBarFill.style.width = '100%';
    scanProgressCounts.textContent = payload.total ? `${fmt(payload.total)} of ${fmt(payload.total)}` : '';
    scanProgressLabel.textContent = payload.total ? `Checked ${plural(payload.total, 'track')}` : 'Checked the folder';
    scanProgressCurrent.textContent = '';
  }
}

function hideScanProgress() {
  scanProgressEl.style.display = 'none';
}

// ========== Move progress ==========

type ProgressCounters = { success: number; conflict: number; error: number; skipped: number };

function resetProgressUi(total: number, skipped: number) {
  progressEl.style.display = 'flex';
  progressEl.classList.remove('done');
  progressLabel.textContent = `Moving 0 of ${plural(total, 'track')}…`;
  progressCounts.textContent = '';
  progressBarFill.style.width = '0%';
  progressCurrent.textContent = '';
  progressSuccessEl.textContent = '0';
  progressConflictEl.textContent = '0';
  progressErrorEl.textContent = '0';
  progressSkippedEl.textContent = fmt(skipped);
  if (moveResultEl) moveResultEl.hidden = true;
}

function updateProgressUi(payload: OrganizeProgress, counters: ProgressCounters) {
  const pct = payload.total === 0 ? 0 : Math.round((payload.current / payload.total) * 100);
  progressLabel.textContent = `Moving ${fmt(payload.current)} of ${plural(payload.total, 'track')}…`;
  progressCounts.textContent = `${pct}%`;
  progressBarFill.style.width = `${pct}%`;
  if (payload.phase === 'processing') progressCurrent.textContent = fileNameOf(payload.filePath);
  progressSuccessEl.textContent = fmt(counters.success);
  progressConflictEl.textContent = fmt(counters.conflict);
  progressErrorEl.textContent = fmt(counters.error);
}

/** The sentence that says how the move went, with the four counts under it. */
function showMoveResult(counters: ProgressCounters) {
  progressEl.style.display = 'none';
  clearTrackProcessing();
  if (!moveResultEl) return;

  let tone = 'success';
  let icon: keyof typeof ICON_BODY = 'check';
  let title: string;
  let body: string;
  const moved = counters.success === 1 ? '1 track moved' : `${fmt(counters.success)} tracks moved`;
  if (counters.error > 0) {
    tone = 'danger';
    icon = 'alert';
    title = `${moved}. ${fmt(counters.error)} couldn't be moved.`;
    body = 'Those are still in your downloads folder, under Needs your help. Check the drive is plugged in, then press Try again on them.';
  } else if (counters.conflict > 0) {
    tone = 'warn';
    icon = 'warn';
    title = `${moved}. ${counters.conflict === 1 ? '1 is' : `${fmt(counters.conflict)} are`} already in your library.`;
    body = 'Choose which copy to keep under Needs your help.';
  } else {
    title = counters.success === 1 ? 'All done! The track is in your library.' : `All done! ${fmt(counters.success)} tracks are in your library.`;
    body = 'Each one is in a folder named after its artist, inside your library folder.';
  }
  const stat = (n: number, label: string, cls: string) => `<span class="status-pill ${cls}">${fmt(n)} ${label}</span>`;
  moveResultEl.className = `callout callout--${tone} organize-move-result`;
  moveResultEl.innerHTML = `
    ${calloutIcon(icon)}
    <div class="callout-body">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(body)}</p>
      <div class="organize-move-stats">
        ${stat(counters.success, 'moved', 'status-pill--ok')}
        ${stat(counters.conflict, 'already in your library', 'status-pill--warn')}
        ${stat(counters.error, 'couldn\'t move', 'status-pill--danger')}
        ${stat(counters.skipped, 'skipped', '')}
      </div>
    </div>`;
  moveResultEl.hidden = false;
}

// ========== The Move button ==========

function updateRunButton() {
  const c = countTracks();
  clearTracksBtn.disabled = scanPipelineRunning || moveRunning;

  const n = c.ready;
  if (runOrganizeLabel) {
    runOrganizeLabel.textContent = n > 0 ? `Move ${plural(n, 'track')} to your library` : 'Move tracks to your library';
  }
  runOrganize.disabled = scanPipelineRunning || moveRunning || n === 0;
  if (scanPipelineRunning) {
    runOrganize.dataset.tooltipDisabled = 'Track Lab is still checking and filling in track info. This unlocks when it\'s done.';
  } else if (moveRunning) {
    runOrganize.dataset.tooltipDisabled = 'Moving tracks now.';
  } else if (c.total > 0 && c.moved === c.total) {
    runOrganize.dataset.tooltipDisabled = 'Everything here is in your library already.';
  } else if (c.help > 0) {
    runOrganize.dataset.tooltipDisabled = 'Nothing is ready yet. Fix or skip the tracks under Needs your help first.';
  } else {
    runOrganize.dataset.tooltipDisabled = 'No tracks are ready to move yet.';
  }

  if (moveNoteTextEl) {
    const left = c['needs-artist'] + c['wont-play'] + c.skipped + c.failed + c['in-library'];
    moveNoteTextEl.textContent = n > 0 && left > 0
      ? `You'll see a summary first. The other ${plural(left, 'track')} stay in your downloads folder.`
      : 'You\'ll see a summary before anything moves. Nothing gets overwritten.';
  }
  updateCheckButton();
}

function toggleIgnore(trackId: string) {
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return;
  userHasModifiedState = true;
  track.ignored = !track.ignored;
  renderTrackList();
  syncOrganizeState();
}

function skipAllThatNeedHelp() {
  let count = 0;
  for (const track of tracks) {
    const s = trackState(track);
    if (s === 'needs-artist' || s === 'wont-play') {
      track.ignored = true;
      count++;
    }
  }
  if (count === 0) return;
  userHasModifiedState = true;
  renderTrackList();
  syncOrganizeState();
  showToast('success', `Skipped ${plural(count, 'track')}`, `${count === 1 ? 'It stays' : 'They stay'} in your downloads folder. Open Skipped at the bottom of the list to include any of them again.`);
}

/** A track that couldn't move goes back with the ready ones. */
function retryTrack(track: TrackInfo) {
  userHasModifiedState = true;
  track.status = 'pending';
  track.errorMessage = undefined;
  renderTrackList();
  syncOrganizeState();
}

// ========== Inline fix: add the artist ==========

async function saveInlineArtist(track: TrackInfo, form: HTMLFormElement) {
  const input = form.querySelector<HTMLInputElement>('input')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const artist = input.value.trim();
  if (!artist) {
    input.setAttribute('aria-invalid', 'true');
    input.placeholder = 'Type the artist name first';
    input.focus();
    return;
  }
  input.removeAttribute('aria-invalid');
  // WAV and FLAC become an AIFF copy when track info is saved: same question
  // the editor asks.
  if (!(await confirmTagWriteConversion(track.filePath))) return;

  // Accepting the "Artist - Title" guess also tidies the title.
  const guess = guessArtist(track);
  const title = guess && guess.artist === artist && guess.from === track.title ? guess.title : track.title;

  form.querySelectorAll('button, input').forEach((b) => { (b as HTMLButtonElement).disabled = true; });
  submit.textContent = 'Saving…';
  try {
    const updated = await updateTrackTagsWithRepair({
      filePath: track.filePath,
      title,
      artist,
      album: track.album,
      year: track.year != null ? String(track.year) : '',
      genre: track.genre,
      label: track.label || '',
      key: track.key || '',
      bpm: track.bpm || '',
      remixer: track.remixer || '',
      comment: track.comment || '',
    }, track.title);
    updateTrackInList(updated, track.filePath);
    showToast('success', 'Artist saved', `"${updated.title || title}" can move into the "${folderNameFor(artist)}" folder now.`);
  } catch (err) {
    showToast('error', 'Couldn\'t save the artist', getErrorMessage(err));
    form.querySelectorAll('button, input').forEach((b) => { (b as HTMLButtonElement).disabled = false; });
    submit.textContent = 'Save artist';
  }
}

// ========== Trash / set aside ==========

async function trashTrack(track: TrackInfo) {
  if (!(await confirmMoveToTrash([track]))) return;
  userHasModifiedState = true;
  try {
    const result = await window.candybar.deleteTrackFile(track.filePath);
    if (result.success) {
      showToast('success', 'Moved to Trash', `${track.fileName} is in the Trash if you need it back.`);
      tracks = tracks.filter((t) => t.id !== track.id);
      renderTrackList();
      syncOrganizeState();
    } else {
      // Trash-only: when the Trash refuses (e.g. some USB formats) the file stays put.
      showToast('error', 'Not moved to Trash', result.error || 'The file is still where it was.');
    }
  } catch (err) {
    showToast('error', 'Not moved to Trash', getErrorMessage(err));
  }
}

async function handleArchiveTrack(track: TrackInfo) {
  userHasModifiedState = true;
  try {
    const result = await window.candybar.archiveTrackFile(track.filePath);
    if (result.success) {
      showToast('success', 'Set aside', `${track.fileName} is in your set-aside folder. Nothing was deleted.`);
      tracks = tracks.filter((t) => t.id !== track.id);
      renderTrackList();
      syncOrganizeState();
    } else {
      showToast('error', 'Couldn\'t set it aside', result.errorMessage || 'The file is still in your downloads folder.');
    }
  } catch (err) {
    showToast('error', 'Couldn\'t set it aside', getErrorMessage(err));
  }
}

/** After the editor (or the inline artist box) saves. `previousPath` matters
 *  for WAV and FLAC, which come back as a new .aiff file. */
function updateTrackInList(updatedTrack: TrackInfo, previousPath = updatedTrack.filePath) {
  const index = tracks.findIndex((t) => t.filePath === previousPath || t.filePath === updatedTrack.filePath);
  if (index !== -1) {
    userHasModifiedState = true;
    const old = tracks[index];
    updatedTrack.ignored = old.ignored;
    updatedTrack.status = old.status;
    updatedTrack.resultPath = old.resultPath;
    updatedTrack.errorMessage = old.errorMessage;
    // A tag write doesn't re-check the file. Keep what the check found, so
    // a track that won't play on CDJs doesn't suddenly count as ready.
    updatedTrack.health = updatedTrack.health ?? old.health;
    tracks[index] = updatedTrack;
    renderTrackList();
    syncOrganizeState();
  }
}

// ========== Convert ==========

async function handleConvertTrack(track: TrackInfo) {
  setStatus('Converting…');
  const taskId = addConversionTask(track.fileName, 'aiff');

  try {
    const result = await convertTrackWithRepair(track.filePath, track.fileName);

    if (result.success && result.outputPath) {
      updateConversionTask(taskId, 'completed', result.outputPath);

      const source = checkedFolder || getValue('organize-source');
      if (source) {
        tracks = mergeRescan(await window.candybar.scanTracks(source));
        renderTrackList();
        syncOrganizeState();
      }
    } else {
      updateConversionTask(taskId, 'failed');
      showToast('error', 'Couldn\'t convert', result.errorMessage || 'The original file is unchanged.');
    }
  } catch (err) {
    updateConversionTask(taskId, 'failed');
    showToast('error', 'Couldn\'t convert', getErrorMessage(err));
  } finally {
    setStatus('Idle');
  }
}

// ========== Check ==========

/** Rescanned list, keeping the user's Skip choices and finished outcomes. A
 *  track that couldn't be moved goes back to its normal state, so checking
 *  again lets it be tried again; so does an "already in your library" whose
 *  details were lost. */
function mergeRescan(fresh: TrackInfo[]): TrackInfo[] {
  const previous = new Map(tracks.map((t) => [t.filePath, t]));
  return fresh.map((t) => {
    const old = previous.get(t.filePath);
    if (!old) return t;
    const keepOutcome = old.status === 'success'
      || ((old.errorMessage ?? '').startsWith('Conflict') && !!conflictFor(old));
    return keepOutcome
      ? { ...t, ignored: old.ignored, status: old.status, resultPath: old.resultPath, errorMessage: old.errorMessage }
      : { ...t, ignored: old.ignored };
  });
}

async function autopopulateTracks(tracksToPopulate: TrackInfo[]) {
  if (tracksToPopulate.length === 0) return;

  setStatus(`Filling in track info (0 of ${fmt(tracksToPopulate.length)})…`);
  scanProgressEl.style.display = 'flex';
  scanProgressLabel.textContent = 'Filling in missing track info from the internet…';
  scanProgressCounts.textContent = '';
  scanProgressBarFill.style.width = '0%';
  scanProgressCurrent.textContent = '';

  const progressHandler = (payload: { current: number; total: number; filePath: string }) => {
    setStatus(`Filling in track info (${fmt(payload.current)} of ${fmt(payload.total)})…`);
    const pct = payload.total === 0 ? 0 : Math.round((payload.current / payload.total) * 100);
    scanProgressCounts.textContent = `${fmt(payload.current)} of ${fmt(payload.total)}`;
    scanProgressBarFill.style.width = `${pct}%`;
    scanProgressCurrent.textContent = fileNameOf(payload.filePath);
  };
  const offAutopopulate = window.candybar.onAutopopulateProgress(progressHandler);

  try {
    const input = tracksToPopulate.map((t) => ({
      filePath: t.filePath,
      title: t.title,
      artist: t.artist,
      album: t.album,
      year: t.year,
      genre: t.genre,
      label: t.label,
      key: t.key,
      bpm: t.bpm,
      remixer: t.remixer,
      hasAlbumArt: !!t.albumArt
    }));

    // Organize tracks can be re-scanned repeatedly — don't skip previously
    // autopopulated files.
    const results = await window.candybar.autopopulateTracks(input, true);
    const updatedCount = results.filter((r) => r.updated).length;

    if (updatedCount > 0) {
      showToast('success', 'Filled in track info', `Track Lab found missing info for ${plural(updatedCount, 'track')} online and saved it into the files.`);
    }
  } catch (err) {
    showToast('error', 'Couldn\'t look up track info', `${getErrorMessage(err)} Your tracks are still listed, and you can fill in details with Edit info.`);
  } finally {
    offAutopopulate();
  }
}

/** Why a check couldn't run, in words, with the one thing to do about it. */
function showFolderProblem(folder: string, message: string) {
  if (!folderProblemEl) {
    showToast('error', 'Couldn\'t check this folder', message);
    return;
  }
  const drive = /^\/Volumes\/([^/]+)/.exec(folder)?.[1];
  let tone: 'warn' | 'danger' = 'danger';
  let icon: keyof typeof ICON_BODY = 'folderX';
  let title: string;
  let body: string;
  let actions = '<button type="button" class="btn-secondary btn-sm" data-organize-problem="choose">Choose the folder</button>';
  let details = '';

  if (/ENOENT|no such file/i.test(message)) {
    if (drive) {
      tone = 'warn';
      icon = 'drive';
      title = `Can't reach the "${drive}" drive`;
      body = 'Your downloads folder is on a drive Track Lab can\'t find right now. If it\'s unplugged, plug it in and check again. If the folder was moved or renamed, choose it again.';
      actions = '<button type="button" class="btn-secondary btn-sm" data-organize-problem="retry">Check again</button>'
        + '<button type="button" class="btn-ghost btn-sm" data-organize-problem="choose">Choose another folder</button>';
    } else {
      title = 'Track Lab can\'t find your downloads folder';
      body = 'It may have been moved, renamed or deleted. Choose the folder your new downloads land in.';
    }
  } else if (/not a directory|must be a directory|ENOTDIR/i.test(message)) {
    title = 'That\'s a file, not a folder';
    body = 'Choose the folder that holds your new downloads.';
  } else if (/EACCES|EPERM|permission|not permitted/i.test(message)) {
    icon = 'lock';
    title = 'Your Mac didn\'t let Track Lab open this folder';
    body = 'Choose it again to give Track Lab access. If that doesn\'t help, allow Track Lab under System Settings, Privacy & Security, Files and Folders.';
  } else {
    title = 'Track Lab couldn\'t check this folder';
    body = 'Something went wrong while reading it. Try again, or choose a different folder.';
    actions = '<button type="button" class="btn-secondary btn-sm" data-organize-problem="retry">Try again</button>'
      + '<button type="button" class="btn-ghost btn-sm" data-organize-problem="choose">Choose another folder</button>';
    details = `<details class="disclosure organize-problem-details"><summary>Show details</summary><div class="disclosure-body"><code>${escapeHtml(message)}</code></div></details>`;
  }

  folderProblemEl.className = `callout callout--${tone} organize-folder-problem`;
  folderProblemEl.innerHTML = `
    ${calloutIcon(icon)}
    <div class="callout-body">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(body)}</p>
      ${details}
    </div>
    <div class="callout-actions">${actions}</div>`;
  folderProblemEl.hidden = false;
  sourceInput.setAttribute('aria-invalid', 'true');
  updateCheckButton();
}

function clearFolderProblem() {
  if (folderProblemEl) folderProblemEl.hidden = true;
  sourceInput.removeAttribute('aria-invalid');
  updateCheckButton();
}

function showNoMusic(folder: string) {
  setResultsVisible(false);
  if (!emptyEl) {
    showToast('warning', 'No music in this folder', 'Track Lab didn\'t find any MP3, WAV, AIFF, FLAC or M4A files.');
    return;
  }
  if (emptyTextEl) {
    emptyTextEl.textContent = `Track Lab didn't find any music files in "${fileNameOf(folder)}". It looks for MP3, WAV, AIFF, FLAC and M4A files. Download some tracks into this folder, or choose a different one.`;
  }
  emptyEl.hidden = false;
  updateCheckButton();
}

async function handleScanTracks() {
  const source = getValue('organize-source');
  clearFolderProblem();
  if (!source) {
    // No folder yet: the button's job is to pick one.
    await pickFolder();
    return;
  }

  userHasModifiedState = true;
  setStatus('Checking tracks…');
  scanTracksBtn.disabled = true;
  scanPipelineRunning = true;
  scanPass = 1;
  lastMoved = 0;
  if (emptyEl) emptyEl.hidden = true;
  if (moveResultEl) moveResultEl.hidden = true;
  updateRunButton();
  showScanProgress();
  const offScanProgress = window.candybar.onScanProgress(updateScanProgress);

  try {
    const fresh = await window.candybar.scanTracks(source);
    // A different folder from the list on screen starts a fresh list.
    if (checkedFolder && checkedFolder !== source) { tracks = []; conflicts = []; }
    checkedFolder = source;
    tracks = mergeRescan(fresh);
    hasChecked = true;

    if (tracks.length === 0) {
      showNoMusic(source);
    } else {
      setResultsVisible(true);
      renderTrackList();
      pushFloatingConsole(`Check finished: found ${plural(tracks.length, 'track')}`);
      syncOrganizeState();
      await autopopulateTracks(tracks);
      // Re-scan so the list shows any track info autopopulate wrote.
      scanPass = 2;
      tracks = mergeRescan(await window.candybar.scanTracks(source));
      renderTrackList();
      // All tracks have been through the analysis queue — refresh library tags
      // so the Library tab picks up any writes autopopulate made.
      void autoRefreshLibrary({ silent: true });
    }

    syncOrganizeState();
    setStatus('Idle');
  } catch (err) {
    showFolderProblem(source, getErrorMessage(err));
    setStatus('Idle');
  } finally {
    offScanProgress();
    hideScanProgress();
    scanTracksBtn.disabled = false;
    scanPipelineRunning = false;
    if (tracks.length) renderTrackList(); else updateRunButton();
  }
}

// ========== Remember this folder ==========

async function saveOrganizeConfig() {
  const folder = getValue('organize-source');
  try {
    await window.candybar.updateConfig({ organizeSourceDir: folder });
    savedFolder = folder;
    refreshFolderDisplay();
    showToast('success', 'Folder remembered', 'Track Lab checks this folder every time you open Sort new music.');
  } catch (err) {
    showToast('error', 'Couldn\'t remember this folder', getErrorMessage(err));
  }
}

// ========== Already in your library ==========

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "AIFF" / "MP3, 320 kbps", and whether it's full quality. */
function describeConflictFile(file: OrganizeConflictFile): { type: string; lossless: boolean | null } {
  const ext = (file.fileName.split('.').pop() || '').toLowerCase();
  const container = (file.format || '').toUpperCase();
  // The container decides: both copies share a file name, so the extension
  // can't tell them apart (an MP3 can sit in the library as "Track.wav").
  const kind = container || ext.toUpperCase();
  let type = kind;
  let lossless: boolean | null = null;
  if (/AIF/.test(kind)) { type = 'AIFF'; lossless = true; }
  else if (/WAV/.test(kind)) { type = 'WAV'; lossless = true; }
  else if (/FLAC/.test(kind)) { type = 'FLAC'; lossless = true; }
  else if (/MPEG|MP3/.test(kind)) { type = 'MP3'; lossless = false; }
  else if (/M4A|MP4|AAC/.test(kind)) { type = 'M4A'; lossless = file.bitRate != null ? file.bitRate > 700 : null; }
  if (lossless === false && file.bitRate) type = `${type}, ${file.bitRate} kbps`;
  return { type, lossless };
}

function renderConflictFileCard(file: OrganizeConflictFile, label: string, better: boolean): string {
  const { type } = describeConflictFile(file);
  const parts = [type, formatDuration(file.duration), formatFileSize(file.sizeBytes)].filter(Boolean);
  return `
    <div class="conflict-file-card">
      <div class="conflict-file-label">${escapeHtml(label)}${better ? ' <span class="status-pill status-pill--ok">Full quality</span>' : ''}</div>
      <div class="conflict-file-details" title="${escapeHtml(file.filePath)}">${escapeHtml(parts.join(' · '))}</div>
    </div>
  `;
}

async function resolveConflict(conflict: OrganizeConflict, keep: 'incoming' | 'existing', el: HTMLElement) {
  // Both buttons lock while the files move, so a double-click can't run it twice.
  const buttons = el.querySelectorAll<HTMLButtonElement>('.conflict-actions button');
  buttons.forEach((b) => { b.disabled = true; });

  try {
    const result = await window.candybar.organizeResolveConflict(
      conflict.incoming.filePath,
      conflict.existing.filePath,
      conflict.targetPath,
      keep
    );
    if (result.success) {
      userHasModifiedState = true;
      if (keep === 'incoming') {
        showToast('success', 'Kept the new download', 'It\'s in your library now. The old copy is in the Trash.');
      } else {
        showToast('success', 'Kept your library copy', 'The new download is in the Trash, and Track Lab won\'t download it again.');
      }
      // The row follows the decision: moved in, or gone to the Trash.
      const track = tracks.find((t) => t.filePath === conflict.incoming.filePath);
      if (track && keep === 'incoming') {
        track.status = 'success';
        track.resultPath = conflict.targetPath;
        track.errorMessage = undefined;
      } else if (track) {
        tracks = tracks.filter((t) => t !== track);
      }
      conflicts = conflicts.filter((c) => c !== conflict);
      renderTrackList();
      syncOrganizeState();
      return;
    }
    showToast('error', 'Couldn\'t swap the files', result.error || 'Both copies are where they were.');
  } catch (err) {
    showToast('error', 'Couldn\'t swap the files', getErrorMessage(err));
  }
  buttons.forEach((b) => { b.disabled = false; });
}

// ========== Move ==========

function handleOrganizeProgress(payload: OrganizeProgress) {
  if (!organizeRunCounters) return;

  if (payload.phase === 'processing') {
    markTrackProcessing(payload.filePath);
    updateProgressUi(payload, organizeRunCounters);
    return;
  }

  if (payload.phase === 'done') {
    const track = tracks.find((t) => t.filePath === payload.filePath);
    if (track) {
      if (payload.status === 'success') {
        track.status = 'success';
        track.resultPath = payload.resultPath;
        track.errorMessage = undefined;
        organizeRunCounters.success++;
      } else if (payload.status === 'conflict') {
        track.status = 'error';
        track.errorMessage = CONFLICT_MESSAGE;
        organizeRunCounters.conflict++;
      } else if (payload.status === 'error') {
        track.status = 'error';
        track.errorMessage = payload.errorMessage;
        organizeRunCounters.error++;
      } else if (payload.status === 'skipped') {
        track.status = 'error';
        track.errorMessage = payload.errorMessage;
        organizeRunCounters.skipped++;
      }
      // 'ignored' — leave status as-is
      replaceTrackElement(track);
    }
    updateProgressUi(payload, organizeRunCounters);
  }
}

async function runOrganizeHandler() {
  const toMove = movableTracks();
  if (toMove.length === 0) {
    showToast('warning', 'Nothing to move', 'No tracks are ready to move yet. Needs your help shows what\'s in the way.');
    return;
  }

  const c = countTracks();
  const staying: string[] = [];
  if (c['needs-artist']) staying.push(`${fmt(c['needs-artist'])} without an artist name`);
  if (c['wont-play']) staying.push(`${fmt(c['wont-play'])} that won't play on CDJs`);
  if (c.failed) staying.push(`${fmt(c.failed)} that couldn't move before`);
  if (c['in-library']) staying.push(`${fmt(c['in-library'])} already in your library`);
  if (c.skipped) staying.push(`${fmt(c.skipped)} you skipped`);
  const leftBehind = c.total - c.moved - toMove.length;

  // Locked from the first click so a double-click can't open two confirms.
  runOrganize.disabled = true;
  libraryRoot = (await window.candybar.getLibraryRoot().catch(() => '')) || libraryRoot;
  const confirmed = await confirmAction({
    title: `Move ${plural(toMove.length, 'track')} into your library?`,
    message: 'Each track goes into a folder named after its artist, inside your library folder.',
    details: [
      { label: 'From', value: checkedFolder || getValue('organize-source') || 'Your downloads folder' },
      { label: 'Into', value: libraryRoot || 'Your library folder' },
      ...(staying.length ? [{ label: 'Staying in your downloads folder', value: joinList(staying) }] : []),
    ],
    safetyNote: 'Nothing gets overwritten. If a track is already in your library, you choose which copy to keep.',
    confirmLabel: `Move ${plural(toMove.length, 'track')}`,
    tone: 'info',
  });
  if (!confirmed) { updateRunButton(); return; }

  // A rescan mid-run would swap the list out from under the progress events.
  userHasModifiedState = true;
  scanTracksBtn.disabled = true;
  moveRunning = true;
  setStatus('Moving tracks…');
  organizeRunCounters = { success: 0, conflict: 0, error: 0, skipped: leftBehind };
  resetProgressUi(toMove.length, leftBehind);
  updateRunButton();

  try {
    // Only the ready tracks go: the rest stay in the downloads folder.
    const trackData = toMove.map((t) => ({
      filePath: t.filePath,
      ignored: false,
      isHealthy: t.health?.isHealthy ?? true
    }));
    const movedPaths = new Set(trackData.map((t) => t.filePath));

    const results = await window.candybar.organizeTracks(trackData);

    // Progress events don't carry conflict details; the results do. Earlier
    // undecided conflicts stay on the list.
    conflicts = [
      ...conflicts.filter((cf) => !movedPaths.has(cf.incoming.filePath)),
      ...results.flatMap((r) => (r.conflict ? [r.conflict] : [])),
    ];
    syncOrganizeState();

    const counters = organizeRunCounters;
    lastMoved = counters.success;
    showMoveResult(counters);

    if (counters.error > 0) {
      showToast('warning', 'Some tracks didn\'t move', `Moved ${plural(counters.success, 'track')}. ${fmt(counters.error)} couldn't be moved and ${counters.error === 1 ? 'is' : 'are'} still in your downloads folder.`);
    } else if (counters.conflict > 0) {
      showToast('warning', 'Almost done', `Moved ${plural(counters.success, 'track')}. ${fmt(counters.conflict)} ${isAre(counters.conflict)} already in your library: choose which copy to keep.`);
    } else {
      showToast('success', 'All done!', `Moved ${plural(counters.success, 'track')} into your library.`);
    }

    setStatus('Done');
  } catch (err) {
    showToast('error', 'Couldn\'t move the tracks', getErrorMessage(err));
    setStatus('Idle');
    clearTrackProcessing();
    progressEl.style.display = 'none';
  } finally {
    organizeRunCounters = null;
    moveRunning = false;
    scanTracksBtn.disabled = false;
    renderTrackList();
  }
}

// ========== Restore ==========

export function restoreOrganizeState(state: OrganizeState) {
  // If the user already kicked off a scan (or other mutation), skip — we'd
  // be overwriting fresh data with the stale DB snapshot that this restore
  // was built from.
  if (userHasModifiedState) return;

  tracks = state.tracks;
  conflicts = state.conflicts;

  if (tracks.length > 0) {
    hasChecked = true;
    setResultsVisible(true);
    renderTrackList();
  }
}

// ========== Init ==========

/** Folder and library paths can change elsewhere (setup guide, Settings):
 *  pick them up whenever the page is shown. */
async function refreshFromConfig() {
  try {
    const [config, root] = await Promise.all([window.candybar.getConfig(), window.candybar.getLibraryRoot()]);
    savedFolder = config.organizeSourceDir || '';
    libraryRoot = root || '';
    if (!getValue('organize-source') && savedFolder) setValue('organize-source', savedFolder);
  } catch {
    /* keep what's on screen */
  }
  refreshFolderDisplay();
}

export function initOrganize() {
  scanTracksBtn.addEventListener('click', handleScanTracks);
  browseBtn?.addEventListener('click', () => void pickFolder());
  emptyChooseBtn?.addEventListener('click', () => void pickFolder());

  clearTracksBtn.addEventListener('click', () => {
    userHasModifiedState = true;
    tracks = [];
    conflicts = [];
    checkedFolder = '';
    trackListEl.innerHTML = '';
    setResultsVisible(false);
    progressEl.style.display = 'none';
    if (moveResultEl) moveResultEl.hidden = true;
    syncOrganizeState();
    updateRunButton();
  });

  // Typing a path (advanced) updates the folder line and clears the last complaint.
  sourceInput.addEventListener('input', () => {
    clearFolderProblem();
    refreshFolderDisplay();
  });

  // The problem callout carries its own buttons.
  folderProblemEl?.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-organize-problem]')?.dataset.organizeProblem;
    if (action === 'retry') void handleScanTracks();
    else if (action === 'choose') void pickFolder();
  });

  // Wire progress listener once; `handleOrganizeProgress` consults module state
  // to only act during an active run.
  window.candybar.onOrganizeProgress?.(handleOrganizeProgress);

  runOrganize.addEventListener('click', runOrganizeHandler);

  saveOrganize.addEventListener('click', saveOrganizeConfig);

  if (pageEl) {
    new MutationObserver(() => {
      if (pageEl.classList.contains('active')) void refreshFromConfig();
    }).observe(pageEl, { attributes: true, attributeFilter: ['class'] });
  }

  toggleDevToolsBtn?.addEventListener('click', async () => {
    toggleDevToolsBtn.classList.add('loading');
    toggleDevToolsBtn.disabled = true;
    try {
      await window.candybar.toggleDevTools();
    } finally {
      setTimeout(() => {
        toggleDevToolsBtn.classList.remove('loading');
        toggleDevToolsBtn.disabled = false;
      }, 300);
    }
  });

  void refreshFromConfig();
  updateRunButton();
}
