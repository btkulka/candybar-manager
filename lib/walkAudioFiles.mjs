import { promises as fs } from 'fs';
import path from 'path';
import { AUDIO_EXTS } from './audioExts.mjs';

// Recursively walk `root`, returning absolute paths of audio files.
// Unlike the inline `walk()` copies this replaced, a readdir failure is
// logged to stderr (not swallowed) so a flaky USB volume doesn't make
// missing files look present.
export async function walkAudioFiles(root, { extensions = AUDIO_EXTS, onError } = {}) {
  const out = [];
  async function rec(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (onError) onError(dir, err);
      else process.stderr.write(`[walkAudioFiles] readdir failed: ${dir} (${err.code || err.message})\n`);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile() && extensions.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  }
  await rec(root);
  return out;
}
