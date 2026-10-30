#!/usr/bin/env node
// yt-vocal-split — search YouTube, pick a track, and pull an isolated vocal
// (or other) stem out of it via LALAL.AI.
//
// Pipeline:
//   (a) take a search query        → argv or a prompt
//   (b) paginated result list      → interactive picker (10/page)
//   (c) snag the chosen URL
//   (d) YouTube → mp3              → yt-dlp + ffmpeg (lib/youtubeDl.mjs)
//   (e) mp3 → LALAL.AI split       → lib/lalalClient.mjs
//   (f) download the split stem(s) → ./vocal-splits (or --out)
//
//   node yt-vocal-split.mjs "artist - track"
//   node yt-vocal-split.mjs --search-only "artist - track"   # just a/b
//   node yt-vocal-split.mjs --help
//
// Needs a LALAL.AI license key (env LALAL_API_KEY, or secrets.json →
// { "lalalApiKey": "..." }). yt-dlp is auto-fetched on first run if absent.

import path from 'path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { searchYouTube, downloadAudioMp3 } from './lib/youtubeDl.mjs';
import { resolveApiKey, uploadFile, requestSplit, waitForSplit, downloadResult } from './lib/lalalClient.mjs';
import { detectUserLibrary, revealInFileManager } from './lib/abletonLibrary.mjs';

const STEMS = ['vocals', 'voice', 'drum', 'bass', 'piano', 'electric_guitar', 'acoustic_guitar', 'synthesizer', 'strings', 'wind'];

// --- args -----------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    query: [], url: null, out: null,
    limit: 40, pageSize: 10,
    stem: 'vocals', splitter: 'phoenix', enhanced: false, dereverb: false, noise: 1,
    backing: true, yes: false, searchOnly: false, help: false, reveal: true,
  };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '--search-only': o.searchOnly = true; break;
      case '-y': case '--yes': o.yes = true; break;
      case '--no-backing': o.backing = false; break;
      case '--no-reveal': o.reveal = false; break;
      case '--enhanced': o.enhanced = true; break;
      case '--dereverb': o.dereverb = true; break;
      case '--url': o.url = need(i++, a); break;
      case '-o': case '--out': o.out = need(i++, a); break;
      case '--stem': o.stem = need(i++, a); break;
      case '--splitter': o.splitter = need(i++, a); break;
      case '--limit': o.limit = parseInt(need(i++, a), 10); break;
      case '--page-size': o.pageSize = parseInt(need(i++, a), 10); break;
      case '--noise': o.noise = parseInt(need(i++, a), 10); break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
        o.query.push(a);
    }
  }
  o.query = o.query.join(' ').trim();
  if (!STEMS.includes(o.stem)) throw new Error(`--stem must be one of: ${STEMS.join(', ')}`);
  return o;
}

function printHelp() {
  stdout.write(`yt-vocal-split — YouTube → mp3 → LALAL.AI stem split

Usage:
  node yt-vocal-split.mjs [options] <search query...>

By default the split stem is saved into your Ableton User Library
(under vocal-splits/) so it shows up in Live's browser — Places → User
Library → vocal-splits — ready to drag onto a track, and Explorer opens
with the file selected for an immediate drag.

Options:
  --url <url>        Skip search; use a direct YouTube URL
  --search-only      Print search results and exit (steps a/b only)
  -y, --yes          Non-interactive: auto-pick the first result
  -o, --out <dir>    Output directory (default: <Ableton User Library>/vocal-splits)
  --no-reveal        Don't open the file manager with the stem selected
  --stem <name>      Stem to isolate (default: vocals)
                     ${STEMS.join(', ')}
  --splitter <name>  phoenix | orion | perseus | andromeda  (default: phoenix)
  --enhanced         Enhanced processing (not for the "voice" stem)
  --dereverb         Remove reverb from the stem
  --noise <0|1|2>    Noise-cancelling level for the "voice" stem (default: 1)
  --no-backing       Don't also download the backing (instrumental) track
  --limit <n>        Search results to fetch (default: 40)
  --page-size <n>    Results per page in the picker (default: 10)
  -h, --help         This help

Auth:
  Set LALAL_API_KEY, or add { "lalalApiKey": "..." } to secrets.json.
`);
}

// --- presentation helpers -------------------------------------------------

function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtViews(n) {
  if (n == null) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K views`;
  return `${n} views`;
}

function describe(r) {
  const bits = [fmtDuration(r.duration), r.channel, fmtViews(r.views)].filter(Boolean);
  return `${r.title}${bits.length ? `\n       ${bits.join(' · ')}` : ''}`;
}

// --- interactive paginated picker ----------------------------------------

async function pickInteractively(results, { pageSize, query }) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const pages = Math.max(1, Math.ceil(results.length / pageSize));
    let page = 0;
    for (;;) {
      const start = page * pageSize;
      const slice = results.slice(start, start + pageSize);
      stdout.write(`\nResults for "${query}" — page ${page + 1}/${pages} (${results.length} total)\n\n`);
      slice.forEach((r, i) => {
        stdout.write(`  ${String(start + i + 1).padStart(3)}. ${describe(r)}\n`);
      });
      stdout.write(`\n  [#] select · [n]ext · [p]rev · [q]uit\n`);
      const ans = (await rl.question('  > ')).trim().toLowerCase();
      if (ans === 'q') return null;
      if (ans === 'n' || ans === '') {
        if (page < pages - 1) page++; else stdout.write('  (already at last page)\n');
        continue;
      }
      if (ans === 'p') {
        if (page > 0) page--; else stdout.write('  (already at first page)\n');
        continue;
      }
      const num = Number.parseInt(ans, 10);
      if (Number.isInteger(num) && num >= 1 && num <= results.length) return results[num - 1];
      stdout.write('  Enter a result number, or n / p / q.\n');
    }
  } finally {
    rl.close();
  }
}

async function promptQuery() {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question('YouTube search query: ')).trim();
  } finally {
    rl.close();
  }
}

function renderProgress({ state, progress }) {
  const label = state === 'progress' ? 'splitting' : state;
  stdout.write(`\r  ${label}… ${progress}%   `);
  if (state !== 'progress') stdout.write('\n');
}

// --- main -----------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  // (a) resolve the target: a direct URL, or a search + pick.
  let target; // { url, title }
  if (opts.url) {
    target = { url: opts.url, title: opts.url };
  } else {
    const query = opts.query || (await promptQuery());
    if (!query) throw new Error('No search query given.');

    stdout.write(`Searching YouTube for "${query}"…\n`);
    const results = await searchYouTube(query, { limit: opts.limit });
    if (!results.length) throw new Error('No YouTube results found.');

    if (opts.searchOnly) {
      results.forEach((r, i) => stdout.write(`  ${String(i + 1).padStart(3)}. ${describe(r)}\n       ${r.url}\n`));
      return;
    }

    const chosen = opts.yes ? results[0] : await pickInteractively(results, { pageSize: opts.pageSize, query });
    if (!chosen) { stdout.write('Cancelled.\n'); return; }
    target = chosen;
    stdout.write(`\nSelected: ${target.title}\n  ${target.url}\n`);
  }

  // The LALAL.AI key is required for everything past the download — check it
  // up front so we don't fetch an mp3 only to fail at the upload.
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      'LALAL.AI API key not found. Set one of:\n' +
      '  • env  LALAL_API_KEY=<your key>\n' +
      '  • secrets.json in the project root:  { "lalalApiKey": "<your key>" }\n' +
      'Find your key in your LALAL.AI account under the API section.',
    );
  }

  // Default the stem destination to Ableton's User Library so it lands in
  // Live's browser with zero setup. --out overrides; fall back to ./vocal-splits
  // if Live isn't found.
  const userLib = opts.out ? null : detectUserLibrary();
  const outDir = path.resolve(opts.out || (userLib ? path.join(userLib, 'vocal-splits') : path.join(process.cwd(), 'vocal-splits')));

  // (c/d) YouTube → mp3
  stdout.write(`\n▶ Downloading audio → mp3  (into ${outDir})\n`);
  const mp3Path = await downloadAudioMp3(target.url, outDir);
  stdout.write(`  ✔ ${mp3Path}\n`);

  // (e) upload + split
  stdout.write(`\n▶ Uploading to LALAL.AI…\n`);
  const up = await uploadFile(mp3Path, { apiKey });
  stdout.write(`  ✔ uploaded (${fmtDuration(up.duration)} · id ${up.id})\n`);

  stdout.write(`▶ Splitting "${opts.stem}" with ${opts.splitter}…\n`);
  await requestSplit(up.id, {
    apiKey, stem: opts.stem, splitter: opts.splitter,
    enhanced: opts.enhanced, dereverb: opts.dereverb, noise: opts.noise,
  });
  const split = await waitForSplit(up.id, { apiKey, onProgress: renderProgress });

  // (f) download the stem(s)
  const base = path.join(outDir, path.basename(mp3Path, path.extname(mp3Path)));
  const stemPath = `${base}.${opts.stem}.mp3`;
  await downloadResult(split.stem_track, stemPath);
  stdout.write(`\n✔ ${opts.stem}:  ${stemPath}\n`);

  if (opts.backing && split.back_track) {
    const backPath = `${base}.backing.mp3`;
    await downloadResult(split.back_track, backPath);
    stdout.write(`✔ backing: ${backPath}\n`);
  }

  // Make it one drag into Live: reveal the stem in the file manager and,
  // when it's inside the User Library, point at where it appears in Live's
  // browser (which auto-watches the User Library).
  if (opts.reveal) revealInFileManager(stemPath);

  stdout.write('\nDone.\n');
  if (userLib) {
    const rel = path.relative(userLib, stemPath).split(path.sep).join(' → ');
    stdout.write(`In Live: Browser → Places → User Library → ${rel}\n`);
    stdout.write('(drag it onto a track; if it doesn\'t appear yet, click User Library in the browser to refresh)\n');
  } else {
    stdout.write(`Drag the stem into Live from:\n  ${stemPath}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`\nError: ${err.message || err}\n`);
  process.exit(1);
});
