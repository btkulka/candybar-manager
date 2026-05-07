#!/usr/bin/env node
// Copy the 202 files we DIDN'T include in the 127 copied set
// (144 untagged + 32 duplicates + 26 filename-matches)
// into /Volumes/Time Machin/on_hold/

import { promises as fs } from 'fs';
import path from 'path';

const NO_TAG = '/tmp/candybar-missing/usb_no_tag.json';
const DUPES  = '/tmp/candybar-missing/duplicates_removed.json';
const FN_MATCH = '/tmp/candybar-missing/dropped_by_filename_match.json';
const DEST_DIR = '/Volumes/Time Machin/on_hold';
const LOG = '/tmp/candybar-missing/onhold_copy_log.json';

function sanitize(s) {
  return s.replace(/[\/\\:]+/g, '-').replace(/\s+/g, ' ').trim();
}

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

function destNameFor(t) {
  const ext = path.extname(t.path);
  // Tagged: Artist - Title.ext. Untagged: original filename.
  if (t.artist && t.title) {
    return `${sanitize(`${t.artist} - ${t.title}`)}${ext}`;
  }
  return path.basename(t.path);
}

async function main() {
  const noTag   = JSON.parse(await fs.readFile(NO_TAG,   'utf8'));
  const dupes   = JSON.parse(await fs.readFile(DUPES,    'utf8'));
  const fnMatch = JSON.parse(await fs.readFile(FN_MATCH, 'utf8'));

  const all = [
    ...noTag.map(t => ({ ...t, bucket: 'no_tag' })),
    ...dupes.map(t => ({ ...t, bucket: 'duplicate' })),
    ...fnMatch.map(t => ({ ...t, bucket: 'filename_match' })),
  ];
  console.error(`Total to copy: ${all.length} (no_tag=${noTag.length}, duplicate=${dupes.length}, filename_match=${fnMatch.length})`);

  await fs.mkdir(DEST_DIR, { recursive: true });

  const log = { copied: [], skipped: [], failed: [] };
  let i = 0;
  for (const t of all) {
    i++;
    const ext = path.extname(t.path);
    const baseName = destNameFor(t).slice(0, destNameFor(t).length - ext.length);
    let destName = `${baseName}${ext}`;
    let destPath = path.join(DEST_DIR, destName);

    let n = 2;
    let skipReason = null;
    while (await exists(destPath)) {
      try {
        const [s, d] = await Promise.all([fs.stat(t.path), fs.stat(destPath)]);
        if (s.size === d.size) { skipReason = 'already exists (same size)'; break; }
      } catch {}
      destName = `${baseName} (${n})${ext}`;
      destPath = path.join(DEST_DIR, destName);
      n++;
    }
    if (skipReason) {
      log.skipped.push({ src: t.path, dst: destPath, bucket: t.bucket, reason: skipReason });
      continue;
    }

    try {
      await fs.copyFile(t.path, destPath);
      log.copied.push({ src: t.path, dst: destPath, bucket: t.bucket });
      if (i % 20 === 0 || i === all.length) {
        console.error(`  ${i}/${all.length}  ${destName}`);
      }
    } catch (err) {
      log.failed.push({ src: t.path, dst: destPath, bucket: t.bucket, error: String(err).slice(0, 300) });
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
