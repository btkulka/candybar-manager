#!/usr/bin/env node
// For every XML track whose expected file exists on disk, verify that the
// file's byte size matches the XML Size attribute. Size mismatch = either the
// file was re-encoded/re-tagged after import, or it's a different file at the
// same path.

import { promises as fs } from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { parseFile } from 'music-metadata';
import { locToPath } from './lib/xmlUtils.mjs';

const XML = '/Volumes/Time Machin/rekordbox/export.xml';
const OUT = '/tmp/candybar-missing/present_audit.json';

async function main() {
  const xml = await fs.readFile(XML, 'utf8');
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const tracks = Array.from(
    dom.window.document.querySelector('COLLECTION').querySelectorAll('TRACK'),
  );

  const buckets = {
    sizeExact: [], sizeDiffDurOk: [], sizeDiffDurBad: [],
    noXmlSize: [], durationUnreadable: [], missing: [],
  };

  for (const t of tracks) {
    const loc = t.getAttribute('Location');
    const expected = locToPath(loc || '');
    const xmlSize = parseInt(t.getAttribute('Size') || '0', 10);
    const xmlDur = parseInt(t.getAttribute('TotalTime') || '0', 10);
    const rec = {
      trackId: t.getAttribute('TrackID'),
      artist: t.getAttribute('Artist'),
      name: t.getAttribute('Name'),
      expected, xmlSize, xmlDur,
    };
    let st;
    try { st = await fs.stat(expected); } catch { buckets.missing.push(rec); continue; }
    if (!st.isFile()) { buckets.missing.push(rec); continue; }
    rec.diskSize = st.size;
    if (!xmlSize) { buckets.noXmlSize.push(rec); continue; }
    if (st.size === xmlSize) { buckets.sizeExact.push(rec); continue; }
    // Size differs — check duration to see if it's a tag-rewrite (duration stays)
    // vs a content swap (duration drifts).
    try {
      const m = await parseFile(expected, { duration: true, skipCovers: true });
      const dur = Math.round(m.format.duration || 0);
      rec.diskDur = dur;
      if (xmlDur > 0 && Math.abs(dur - xmlDur) <= 1) buckets.sizeDiffDurOk.push(rec);
      else buckets.sizeDiffDurBad.push(rec);
    } catch (e) {
      rec.error = String(e.message || e);
      buckets.durationUnreadable.push(rec);
    }
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(buckets, null, 2));

  console.error(`Total tracks: ${tracks.length}`);
  console.error(`  size exact match:     ${buckets.sizeExact.length}`);
  console.error(`  size diff, dur OK:    ${buckets.sizeDiffDurOk.length}  (likely tag-rewrite)`);
  console.error(`  size diff, dur BAD:   ${buckets.sizeDiffDurBad.length}  <-- likely wrong file`);
  console.error(`  XML Size=0 (no check): ${buckets.noXmlSize.length}`);
  console.error(`  duration unreadable:  ${buckets.durationUnreadable.length}`);
  console.error(`  missing:              ${buckets.missing.length}`);
  console.error(`Report: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
