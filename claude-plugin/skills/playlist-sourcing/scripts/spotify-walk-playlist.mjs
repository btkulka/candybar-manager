#!/usr/bin/env node
// Read one of your OWN Spotify playlists — the private ones the API 404s on — by
// walking it in the signed-in Spotify desktop app, and write a CSV that
// bin/source-playlist.mjs --csv accepts.
//
//   node spotify-walk-playlist.mjs <playlist url or id> [--out file.csv] [--max N]
//
// Why this exists: for a private playlist the client-credentials API, the public
// embed page and the claude.ai Spotify connector all 404 or omit the items
// (verified 2026-10-19). The desktop app is signed in, so it can play the list,
// and AppleScript can read what it plays. The app is muted and put back
// afterwards; budget about 0.7 s per track, during which Spotify is busy.
//
// Trust only a WRAP. The walk ends when the app comes back round to track 1;
// that is the only proof the whole playlist was seen. If it stopped at --max
// instead, the tail may be Autoplay recommendations rather than the playlist,
// and the file is named *-unverified.csv so nobody sources it by accident.
//
// `artist` is the primary artist only — that is all AppleScript exposes — so
// a collab reads as one name where the API path would list both. The library
// and store matchers tolerate that (token-set scoring), but a probable-bucket
// score can land a little lower than it would from the API.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'spotify-walk-playlist.applescript');
const US = '\u001f';
const SESSION_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'candybar-manager', 'sourcing-sessions');

function parseArgs(argv) {
  const args = { max: 1000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--max') args.max = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!args.input) args.input = a;
  }
  return args;
}

function playlistId(input) {
  const m = (input || '').match(/playlist[/:]([A-Za-z0-9]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9]{22}$/.test(input || '') ? input : null;
}

const csvField = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    console.error('usage: node spotify-walk-playlist.mjs <playlist url or id> [--out file.csv] [--max N]');
    process.exit(args.help ? 0 : 1);
  }
  const id = playlistId(args.input);
  if (!id) throw new Error(`not a Spotify playlist URL or id: ${args.input}`);
  if (!Number.isFinite(args.max) || args.max < 1) throw new Error('--max must be a positive number');

  console.error(`[1/2] Walking spotify:playlist:${id} in the Spotify desktop app (muted; up to ${args.max} tracks)…`);
  let stdout;
  try {
    ({ stdout } = await execFileAsync('osascript', [SCRIPT, id, String(args.max)], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60 * 60 * 1000,
    }));
  } catch (err) {
    const msg = (err.stderr || err.message || '').trim();
    if (/not allowed|not authorized|-1743/i.test(msg)) {
      throw new Error(`macOS refused to automate Spotify — allow it under System Settings → Privacy & Security → Automation (Terminal / the app running this) → Spotify. (${msg})`);
    }
    if (/Can’t get|Can't get|-1728/i.test(msg)) {
      throw new Error(`Spotify would not play that playlist — is the desktop app signed in to the account that owns it? (${msg})`);
    }
    throw new Error(`osascript failed: ${msg}`);
  }

  const lines = stdout.split(/\r?\n/).map(l => l.replace(/\r$/, '')).filter(l => l.length);
  const marker = lines.findIndex(l => l.startsWith('#wrapped='));
  const wrapped = marker >= 0 && lines[marker] === '#wrapped=true';
  const rows = (marker >= 0 ? lines.slice(0, marker) : lines)
    .map(l => l.split(US))
    .filter(f => f.length >= 5 && f[0])
    .map(([url, artist, title, album, durationMs, art]) => ({
      artist, title, album,
      artworkUrl: art || '',
      spotifyUrl: url.replace(/^spotify:track:([A-Za-z0-9]+)$/, 'https://open.spotify.com/track/$1'),
      durationS: Number(durationMs) > 0 ? Math.round(Number(durationMs) / 1000) : '',
    }));
  if (!rows.length) throw new Error('the walk produced no tracks — is the playlist empty, or did Spotify fail to start it?');

  const seen = new Set();
  const duplicates = rows.filter(r => (seen.has(r.spotifyUrl) ? true : (seen.add(r.spotifyUrl), false))).length;

  const stamp = new Date().toISOString().slice(0, 10);
  let outPath = args.out
    ? path.resolve(args.out)
    : path.join(SESSION_DIR, `spotify-${id}-${stamp}${wrapped ? '' : '-unverified'}.csv`);
  if (!wrapped && args.out && !/unverified/i.test(outPath)) outPath = outPath.replace(/(\.csv)?$/i, '-unverified.csv');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const header = ['artist', 'title', 'album', 'artwork_url', 'spotify_url', 'duration_s'];
  const csv = [header.join(',')]
    .concat(rows.map(r => [r.artist, r.title, r.album, r.artworkUrl, r.spotifyUrl, r.durationS].map(csvField).join(',')))
    .join('\n') + '\n';
  fs.writeFileSync(outPath, csv);

  console.error(`[2/2] ${rows.length} track(s)${duplicates ? ` (${duplicates} duplicate${duplicates > 1 ? 's' : ''} kept; the sourcing run drops them)` : ''} → ${outPath}`);
  if (wrapped) {
    console.error('      WRAP confirmed — the walk came back round to track 1, so this is the whole playlist.');
  } else {
    console.error(`      WARNING: no WRAP. The walk stopped at --max ${args.max} without returning to track 1.`);
    console.error('      Either the playlist is longer than that (raise --max) or Spotify drifted into Autoplay —');
    console.error('      the tail of this file may not be the playlist. Fix and re-run before sourcing from it.');
  }
  console.log(outPath);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
