#!/usr/bin/env node
// Parse export.xml, find tracks whose Location file doesn't exist on disk.

import { promises as fs } from 'fs';
import { JSDOM } from 'jsdom';

const XML = '/Volumes/Time Machin/rekordbox/export.xml';
const OUT = '/tmp/candybar-missing/xml_missing.json';

function locToPath(loc) {
  if (!loc) return null;
  const prefix = 'file://localhost';
  let p = loc.startsWith(prefix) ? loc.slice(prefix.length) : loc;
  return decodeURIComponent(p);
}

async function fileExists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function main() {
  const xml = await fs.readFile(XML, 'utf8');
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const doc = dom.window.document;

  // Only COLLECTION tracks (skip PLAYLIST references)
  const collection = doc.querySelector('COLLECTION');
  const tracks = Array.from(collection.querySelectorAll('TRACK'));
  console.error(`XML tracks: ${tracks.length}`);

  const missing = [];
  const present = [];
  for (const t of tracks) {
    const loc = t.getAttribute('Location');
    const p = locToPath(loc);
    if (!p) { continue; }
    const ok = await fileExists(p);
    const rec = {
      trackId: t.getAttribute('TrackID'),
      name:    t.getAttribute('Name'),
      artist:  t.getAttribute('Artist'),
      album:   t.getAttribute('Album'),
      location: loc,
      path: p,
    };
    if (ok) present.push(rec); else missing.push(rec);
  }

  await fs.writeFile(OUT, JSON.stringify(missing, null, 2));
  console.error(`Present: ${present.length}`);
  console.error(`Missing: ${missing.length}`);
  console.error(`Output:  ${OUT}`);
  console.error('\nFirst 10 missing:');
  for (const m of missing.slice(0, 10)) {
    console.error(`  ${m.artist} - ${m.name}`);
    console.error(`    ${m.path}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
