// Draw Track Lab's icons from the record graphic (styles/art/record.svg): a
// dark disc with an aquamarine rim and fine grooves, a soft sheen, an
// aquamarine label and a dark spindle hole.
//
//   node scripts/make-icons.mjs        (macOS)
//
// Writes, under assets/:
//   icon/app-icon.svg, icon/app-icon-small.svg, icon/mark.svg   the sources
//   app-icon.png        1024px, the window and Dock icon (main.ts resolveIconPath)
//   AppIcon.icns        the Applications launcher's icon (scripts/_common.sh)
// macOS draws them: sips rasterizes the SVGs (with transparency) and iconutil
// packs the .icns, so nothing needs installing. sips ignores SVG filters and
// a stroke inherited from a <g>, so the shadow is stacked shapes and every
// shape carries its own stroke.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const ACCENT = '#7fffd4';
const INK = '#05090c';

// ---------- artwork ----------

/** The record: rim, grooves, sheen, label, spindle. `detail` thins it out for tiny sizes. */
function record({ cx, cy, r, detail = true }) {
  const s = r / 318; // proportions taken at r = 318
  const grooves = [];
  if (detail) {
    for (let gr = 128; gr <= 304; gr += 9.5) {
      grooves.push(`<circle cx="${cx}" cy="${cy}" r="${(gr * s).toFixed(1)}" fill="none" stroke="${ACCENT}" stroke-opacity="0.13" stroke-width="${(2 * s).toFixed(2)}"/>`);
    }
  } else {
    grooves.push(`<circle cx="${cx}" cy="${cy}" r="${(232 * s).toFixed(1)}" fill="none" stroke="${ACCENT}" stroke-opacity="0.3" stroke-width="${(16 * s).toFixed(1)}"/>`);
  }
  return `
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="#070b0e" stroke="${ACCENT}" stroke-opacity="${detail ? 0.5 : 0.75}" stroke-width="${((detail ? 5 : 30) * s).toFixed(1)}"/>
  ${grooves.join('\n  ')}
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#sheen)"/>
  <circle cx="${cx}" cy="${cy}" r="${((detail ? 108 : 150) * s).toFixed(1)}" fill="${ACCENT}"/>
  ${detail ? `<circle cx="${cx}" cy="${cy}" r="${(70 * s).toFixed(1)}" fill="none" stroke="${INK}" stroke-opacity="0.22" stroke-width="${(4 * s).toFixed(1)}"/>` : ''}
  <circle cx="${cx}" cy="${cy}" r="${((detail ? 14 : 34) * s).toFixed(1)}" fill="${INK}"/>`;
}

// Light catching the grooves: brightest top right, a little bottom left, as on record.svg.
const SHEEN = `<linearGradient id="sheen" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/><stop offset="0.42" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.58" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.07"/></linearGradient>`;

/** The macOS app icon on Apple's 1024 grid: an 824px rounded square with a
 *  soft shadow, the grooves sweeping in from the top right (the motif behind
 *  every page header), and the record in the middle. */
function appIconSvg({ detail = true } = {}) {
  const corner = [];
  if (detail) {
    for (let i = 0; i < 14; i++) {
      corner.push(`<circle cx="924" cy="100" r="${150 + i * 26}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-opacity="${(0.11 - i * 0.006).toFixed(3)}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#162027"/><stop offset="1" stop-color="#0a0f13"/></linearGradient>
    ${SHEEN}
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5"><stop offset="0.62" stop-color="${ACCENT}" stop-opacity="0.16"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/></radialGradient>
    <clipPath id="body-clip"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
  </defs>
  <rect x="96" y="110" width="832" height="832" rx="189" fill="#000" fill-opacity="0.08"/>
  <rect x="98" y="106" width="828" height="828" rx="187" fill="#000" fill-opacity="0.10"/>
  <rect x="100" y="103" width="824" height="824" rx="185" fill="#000" fill-opacity="0.14"/>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#body)"/>
  <g clip-path="url(#body-clip)">${corner.join('')}</g>
  <rect x="101" y="101" width="822" height="822" rx="184" fill="none" stroke="${ACCENT}" stroke-opacity="0.14" stroke-width="2"/>
  ${detail ? '<circle cx="512" cy="512" r="370" fill="url(#halo)"/>' : ''}
  ${record({ cx: 512, cy: 512, r: detail ? 318 : 350, detail })}
</svg>
`;
}

/** The mark on its own (no rounded square): what the sidebar shows. */
function markSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>${SHEEN}</defs>
  <circle cx="32" cy="32" r="30" fill="#070b0e" stroke="${ACCENT}" stroke-opacity="0.6" stroke-width="2"/>
  <circle cx="32" cy="32" r="24.5" fill="none" stroke="${ACCENT}" stroke-opacity="0.22" stroke-width="1.4"/>
  <circle cx="32" cy="32" r="19.5" fill="none" stroke="${ACCENT}" stroke-opacity="0.22" stroke-width="1.4"/>
  <circle cx="32" cy="32" r="30" fill="url(#sheen)"/>
  <circle cx="32" cy="32" r="12" fill="${ACCENT}"/>
  <circle cx="32" cy="32" r="2.6" fill="${INK}"/>
</svg>
`;
}

// ---------- rendering ----------

const sips = (...args) => execFileSync('sips', args, { stdio: 'ignore' });

try {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tracklab-icons-'));
  fs.mkdirSync(path.join(ASSETS, 'icon'), { recursive: true });
  const sources = { 'app-icon.svg': appIconSvg(), 'app-icon-small.svg': appIconSvg({ detail: false }), 'mark.svg': markSvg() };
  for (const [name, svg] of Object.entries(sources)) fs.writeFileSync(path.join(ASSETS, 'icon', name), svg);

  // Each 1024 SVG rasterizes at its own size; smaller ones are scaled down from there.
  const big = path.join(work, 'big.png');
  const small = path.join(work, 'small.png');
  sips('-s', 'format', 'png', path.join(ASSETS, 'icon', 'app-icon.svg'), '--out', big);
  sips('-s', 'format', 'png', path.join(ASSETS, 'icon', 'app-icon-small.svg'), '--out', small);
  fs.copyFileSync(big, path.join(ASSETS, 'app-icon.png'));

  // The detailed art from 64px up; the plain one below, where grooves blur to mud.
  const set = path.join(work, 'AppIcon.iconset');
  fs.mkdirSync(set);
  const entries = [
    ['icon_16x16.png', 16, small], ['icon_16x16@2x.png', 32, small],
    ['icon_32x32.png', 32, small], ['icon_32x32@2x.png', 64, big],
    ['icon_128x128.png', 128, big], ['icon_128x128@2x.png', 256, big],
    ['icon_256x256.png', 256, big], ['icon_256x256@2x.png', 512, big],
    ['icon_512x512.png', 512, big], ['icon_512x512@2x.png', 1024, big],
  ];
  for (const [name, size, src] of entries) sips('-z', String(size), String(size), src, '--out', path.join(set, name));
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(ASSETS, 'AppIcon.icns')]);
  fs.rmSync(work, { recursive: true, force: true });
  console.log('Wrote assets/app-icon.png, assets/AppIcon.icns and assets/icon/*.svg');
} catch (err) {
  console.error('make-icons failed:', err.message);
  process.exitCode = 1;
}
