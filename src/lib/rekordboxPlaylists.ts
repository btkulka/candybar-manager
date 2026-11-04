/**
 * Read playlists from the live Rekordbox collection.
 *
 * master.db is SQLCipher-encrypted, so the read goes through pyrekordbox
 * (lib/sourcing/read_rekordbox_playlists.py), using the repo's .venv-rbx — the
 * same interpreter the rekordbox-* skills and the playlist-sourcing CLI use.
 * The reader never opens a write session.
 */

import { app } from 'electron';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import type { RekordboxPlaylistSummary } from '../types';
import type { RekordboxEntry } from './losslessUpgrade';
import { rbxPython, RBX_PYTHON_MISSING } from './rbxPython';

const execFileAsync = promisify(execFile);

async function runReader<T>(args: string[]): Promise<T> {
  const script = path.join(app.getAppPath(), 'lib', 'sourcing', 'read_rekordbox_playlists.py');
  const python = rbxPython(app.getAppPath());
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(python, [script, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    }));
  } catch (err) {
    // A failed read still prints {"error": …} before exiting non-zero.
    const out = (err as { stdout?: string }).stdout;
    if (!out && python === 'python3') throw new Error(RBX_PYTHON_MISSING);
    if (!out) throw new Error(`Couldn't run the Rekordbox reader: ${err instanceof Error ? err.message : String(err)}`);
    stdout = out;
  }
  let data: T & { error?: string };
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`The Rekordbox reader returned something unreadable: ${stdout.slice(0, 200)}`);
  }
  if (data.error) throw new Error(data.error);
  return data;
}

export async function listRekordboxPlaylists(): Promise<RekordboxPlaylistSummary[]> {
  const { playlists } = await runReader<{ playlists: RekordboxPlaylistSummary[] }>(['list']);
  return playlists;
}

/** A playlist's entries in order, plus the whole collection (to find lossless copies). */
export async function readRekordboxPlaylist(playlistId: string): Promise<{
  playlist: RekordboxPlaylistSummary;
  tracks: RekordboxEntry[];
  collection: RekordboxEntry[];
}> {
  return runReader(['tracks', playlistId]);
}
