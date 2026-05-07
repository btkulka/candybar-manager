#!/usr/bin/env node
// Dry-run: scan USB + HDD Library, match by metadata artist+title,
// report tracks present on USB but missing from HDD.
//
// Reads music-metadata from /Users/benkulka/source/candybar-manager/node_modules.

import { parseFile } from 'music-metadata';
import { promises as fs } from 'fs';
import path from 'path';
import { walkAudioFiles } from './lib/walkAudioFiles.mjs';
import { makeAggressiveKey } from './lib/stringUtils.mjs';

const USB_ROOT = '/Volumes/NHI 2-0 BAK/Contents';
const HDD_ROOT = '/Volumes/Time Machin/Library';
const OUT_DIR = '/tmp/candybar-missing';

const CONCURRENCY = 12;

async function readMeta(p) {
  try {
    const m = await parseFile(p, { duration: false, skipCovers: true });
    return {
      path: p,
      artist: m.common.artist || m.common.artists?.[0] || '',
      title: m.common.title || '',
    };
  } catch (err) {
    process.stderr.write(`[readMeta] parse failed: ${p} (${String(err.message || err).slice(0, 120)})\n`);
    return { path: p, artist: '', title: '', readError: String(err.message || err).slice(0, 200) };
  }
}

async function scanAll(label, paths) {
  const total = paths.length;
  const results = new Array(total);
  let done = 0;
  let idx = 0;
  async function worker() {
    while (idx < total) {
      const i = idx++;
      results[i] = await readMeta(paths[i]);
      done++;
      if (done % 200 === 0 || done === total) {
        process.stderr.write(`  [${label}] ${done}/${total}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  process.stderr.write('Walking USB...\n');
  const usbFiles = await walkAudioFiles(USB_ROOT);
  process.stderr.write(`USB: ${usbFiles.length} audio files\n`);

  process.stderr.write('Walking HDD Library...\n');
  const hddFiles = await walkAudioFiles(HDD_ROOT);
  process.stderr.write(`HDD: ${hddFiles.length} audio files\n`);

  process.stderr.write('Reading HDD metadata...\n');
  const hddMeta = await scanAll('HDD', hddFiles);
  process.stderr.write('Reading USB metadata...\n');
  const usbMeta = await scanAll('USB', usbFiles);

  const hddKeys = new Set();
  const hddNoTag = [];
  for (const m of hddMeta) {
    if (m.artist && m.title) hddKeys.add(makeAggressiveKey(m.artist, m.title));
    else hddNoTag.push(m);
  }

  const missing = [];
  const usbNoTag = [];
  const present = [];
  for (const m of usbMeta) {
    if (!m.artist || !m.title) {
      usbNoTag.push(m);
      continue;
    }
    const k = makeAggressiveKey(m.artist, m.title);
    if (hddKeys.has(k)) present.push(m);
    else missing.push(m);
  }

  await fs.writeFile(
    path.join(OUT_DIR, 'missing.json'),
    JSON.stringify(missing, null, 2)
  );
  await fs.writeFile(
    path.join(OUT_DIR, 'present.json'),
    JSON.stringify(present, null, 2)
  );
  await fs.writeFile(
    path.join(OUT_DIR, 'usb_no_tag.json'),
    JSON.stringify(usbNoTag, null, 2)
  );
  await fs.writeFile(
    path.join(OUT_DIR, 'hdd_no_tag.json'),
    JSON.stringify(hddNoTag, null, 2)
  );

  const report = [
    `USB audio files:           ${usbFiles.length}`,
    `HDD audio files:           ${hddFiles.length}`,
    ``,
    `USB with tags:             ${usbMeta.length - usbNoTag.length}`,
    `USB missing tags:          ${usbNoTag.length}`,
    `HDD with tags:             ${hddMeta.length - hddNoTag.length}`,
    `HDD missing tags:          ${hddNoTag.length}`,
    ``,
    `HDD unique (artist|title): ${hddKeys.size}`,
    ``,
    `USB tracks PRESENT on HDD: ${present.length}`,
    `USB tracks MISSING on HDD: ${missing.length}`,
    ``,
    `First 20 missing:`,
    ...missing.slice(0, 20).map((m) => `  ${m.artist} - ${m.title}`),
  ].join('\n');

  await fs.writeFile(path.join(OUT_DIR, 'summary.txt'), report + '\n');
  process.stderr.write('\n' + report + '\n');
  process.stderr.write(`\nOutputs in ${OUT_DIR}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
