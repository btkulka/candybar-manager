#!/usr/bin/env node
// Copy refined-missing tracks from USB to /Volumes/Time Machin/tracks_to_organize/
// using flat "Artist - Title.ext" filenames.

import { promises as fs } from 'fs';
import path from 'path';

const IN_FILE = '/tmp/candybar-missing/missing_refined.json';
const DEST_DIR = '/Volumes/Time Machin/tracks_to_organize';
const LOG = '/tmp/candybar-missing/copy_log.json';

// macOS-safe: strip / and :, collapse whitespace.
function sanitize(s) {
  return s
    .replace(/[\/\\:]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function main() {
  const tracks = JSON.parse(await fs.readFile(IN_FILE, 'utf8'));
  console.error(`To copy: ${tracks.length}`);
  await fs.mkdir(DEST_DIR, { recursive: true });

  const log = { copied: [], skipped: [], failed: [] };
  let i = 0;
  for (const t of tracks) {
    i++;
    const ext = path.extname(t.path);
    const baseName = sanitize(`${t.artist} - ${t.title}`);
    let destName = `${baseName}${ext}`;
    let destPath = path.join(DEST_DIR, destName);

    // Collision handling: if exists, suffix with " (2)", " (3)", ...
    // Capped so a pathological directory can't spin forever.
    const MAX_COLLISION_SUFFIX = 1000;
    let n = 2;
    let giveUp = false;
    while (await exists(destPath)) {
      // If size matches source, skip as already-copied.
      try {
        const [srcStat, dstStat] = await Promise.all([
          fs.stat(t.path),
          fs.stat(destPath),
        ]);
        if (srcStat.size === dstStat.size) {
          log.skipped.push({ src: t.path, dst: destPath, reason: 'already exists (same size)' });
          destPath = null;
          break;
        }
      } catch { /* fall through */ }
      if (n > MAX_COLLISION_SUFFIX) {
        log.failed.push({ src: t.path, dst: destPath, error: `gave up after ${MAX_COLLISION_SUFFIX} collision suffixes` });
        console.error(`  FAIL ${baseName}${ext}: >${MAX_COLLISION_SUFFIX} collisions`);
        giveUp = true;
        break;
      }
      destName = `${baseName} (${n})${ext}`;
      destPath = path.join(DEST_DIR, destName);
      n++;
    }
    if (giveUp || !destPath) continue;

    try {
      await fs.copyFile(t.path, destPath);
      log.copied.push({ src: t.path, dst: destPath });
      if (i % 10 === 0 || i === tracks.length) {
        console.error(`  ${i}/${tracks.length}  ${destName}`);
      }
    } catch (err) {
      log.failed.push({ src: t.path, dst: destPath, error: String(err).slice(0, 300) });
      console.error(`  FAIL ${destName}: ${err.message}`);
    }
  }

  await fs.writeFile(LOG, JSON.stringify(log, null, 2));
  console.error(`\nCopied:  ${log.copied.length}`);
  console.error(`Skipped: ${log.skipped.length}`);
  console.error(`Failed:  ${log.failed.length}`);
  console.error(`Log:     ${LOG}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
