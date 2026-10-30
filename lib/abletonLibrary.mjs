// Locate Ableton Live's User Library and reveal files for drag-into-Live.
//
// The point: anything written under the User Library shows up in Live's
// browser sidebar (Places → User Library) with no setup, so a freshly-split
// stem is one drag onto a track. We find the *authoritative* User Library
// path — even if the user relocated it — by reading Live's own `Library.cfg`
// preferences file, which is plain XML:
//
//   <UserLibrary><LibraryProject>
//     <ProjectName Value="User Library" />
//     <ProjectPath Value="C:/Users/you/Documents/Ableton" />
//   </LibraryProject></UserLibrary>
//
// User Library = <ProjectPath>/<ProjectName>. We parse the most recently
// *run* version's config (newest mtime) so multi-version / beta installs
// resolve to whatever Live the user actually opens.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

// Every `.../Ableton/Live <ver>/Preferences/Library.cfg` (win/linux) or
// `.../Ableton/Live <ver>/Library.cfg` (mac), newest-run first.
function libraryCfgFiles() {
  const home = os.homedir();
  const roots = [];
  if (process.platform === 'win32') {
    roots.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Ableton'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Preferences', 'Ableton'));
  } else {
    roots.push(path.join(home, '.config', 'Ableton'));
  }
  const files = [];
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !/^Live /i.test(e.name)) continue;
      // Preferences sit under a Preferences/ subfolder on Windows, directly
      // in the version folder on macOS — probe both.
      for (const sub of ['Preferences', '.']) {
        const cfg = path.join(root, e.name, sub, 'Library.cfg');
        if (fs.existsSync(cfg)) files.push(cfg);
      }
    }
  }
  return files
    .map((f) => { let m = 0; try { m = fs.statSync(f).mtimeMs; } catch {} return { f, m }; })
    .sort((a, b) => b.m - a.m)
    .map((x) => x.f);
}

function userLibraryFromCfg(cfgPath) {
  let xml;
  try { xml = fs.readFileSync(cfgPath, 'utf8'); } catch { return null; }
  const block = xml.match(/<UserLibrary>[\s\S]*?<\/UserLibrary>/i);
  const scope = block ? block[0] : xml;
  const pathM = scope.match(/<ProjectPath\s+Value\s*=\s*"([^"]*)"/i);
  if (!pathM) return null;
  const nameM = scope.match(/<ProjectName\s+Value\s*=\s*"([^"]*)"/i);
  // Live writes paths with forward slashes; normalise to the host separator.
  const parent = pathM[1].replace(/[\\/]+/g, path.sep);
  const name = (nameM && nameM[1]) || 'User Library';
  return path.join(parent, name);
}

/**
 * Absolute path to Ableton's User Library, or null if Live isn't installed /
 * can't be located. `ABLETON_USER_LIBRARY` env var overrides everything.
 */
export function detectUserLibrary() {
  const override = process.env.ABLETON_USER_LIBRARY;
  if (override && fs.existsSync(override)) return override;

  for (const cfg of libraryCfgFiles()) {
    const lib = userLibraryFromCfg(cfg);
    if (lib && fs.existsSync(lib)) return lib;
  }

  // Fallback to the default location if Live's config didn't resolve.
  const home = os.homedir();
  const cands = [];
  if (process.platform === 'darwin') cands.push(path.join(home, 'Music', 'Ableton', 'User Library'));
  cands.push(path.join(home, 'Documents', 'Ableton', 'User Library'));
  try {
    // OneDrive-redirected Documents (common on Windows).
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (e.isDirectory() && /^OneDrive/i.test(e.name)) {
        cands.push(path.join(home, e.name, 'Documents', 'Ableton', 'User Library'));
      }
    }
  } catch {}
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

/**
 * Open the OS file manager with `target` selected, so it can be dragged
 * straight into Live. Fire-and-forget; returns false only if spawn threw.
 * (explorer.exe exits 1 even on success, so we never inspect the exit code.)
 */
export function revealInFileManager(target) {
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [path.dirname(target)], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}
