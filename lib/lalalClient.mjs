// LALAL.AI stem-splitter client.
//
// Thin wrapper over the LALAL.AI REST API (https://www.lalal.ai/api/help/).
// The flow is: upload the audio file → request a split for a given stem →
// poll until the task finishes → download the resulting stem + backing
// tracks. All auth is a single license key sent as `Authorization: license
// <key>`.
//
// Splitting the *full* track consumes minutes from your LALAL.AI plan; without
// an active plan the API returns preview-length results. This client just
// downloads whatever URLs come back.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const API = 'https://www.lalal.ai/api';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- auth -----------------------------------------------------------------

/**
 * Resolve the LALAL.AI license key from, in order: env vars, then a
 * gitignored `secrets.json` in the project root. Returns null if none found.
 */
export function resolveApiKey() {
  const fromEnv = process.env.LALAL_API_KEY || process.env.LALALAI_API_KEY || process.env.LALALAI_LICENSE;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  for (const dir of [process.cwd(), PROJECT_ROOT]) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
      const k = s.lalalApiKey || s.lalal_api_key || s.lalalaiApiKey || s.LALAL_API_KEY;
      if (k) return String(k).trim();
    } catch {}
  }
  return null;
}

// One JSON POST with a 60s timeout so a stuck socket can't hang the pipeline.
async function apiFetch(url, { apiKey, headers = {}, body, timeoutMs = 60_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { Authorization: `license ${apiKey}`, ...headers },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// --- API steps ------------------------------------------------------------

/**
 * Upload an audio file. Returns `{ id, size, duration, expires }`; `id` is the
 * handle every later call uses. Uploaded files expire after ~1 day.
 */
export async function uploadFile(filePath, { apiKey } = {}) {
  const data = await fs.promises.readFile(filePath);
  const filename = path.basename(filePath);
  // LALAL.AI expects the filename URL-encoded in Content-Disposition (their
  // own Python sample uses urllib.parse.quote). --restrict-filenames upstream
  // already keeps this ASCII, but encode defensively regardless.
  const res = await apiFetch(`${API}/upload/`, {
    apiKey,
    headers: { 'Content-Disposition': `attachment; filename=${encodeURIComponent(filename)}` },
    body: data,
    timeoutMs: 300_000, // uploads can be large
  });
  const json = await res.json().catch(() => ({}));
  if (json.status !== 'success' || !json.id) {
    throw new Error(`LALAL.AI upload failed: ${json.error || `HTTP ${res.status}`}`);
  }
  return json;
}

/**
 * Request a split for an uploaded file id.
 *
 * @param {string} fileId
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.stem='vocals']  vocals|voice|drum|bass|piano|electric_guitar|acoustic_guitar|synthesizer|strings|wind
 * @param {string} [opts.splitter='phoenix'] phoenix|orion|perseus|andromeda
 * @param {boolean} [opts.enhanced=false] enhanced processing (not available for the "voice" stem)
 * @param {boolean} [opts.dereverb=false]
 * @param {number}  [opts.noise=1]        noise-cancelling level 0|1|2 (voice stem)
 */
export async function requestSplit(fileId, { apiKey, stem = 'vocals', splitter = 'phoenix', enhanced = false, dereverb = false, noise = 1 } = {}) {
  const entry = {
    id: fileId,
    stem,
    splitter,
    dereverb_enabled: !!dereverb,
    noise_cancelling_level: noise,
  };
  // Enhanced processing is rejected for the "voice" stem — only send it
  // otherwise.
  if (stem !== 'voice') entry.enhanced_processing_enabled = !!enhanced;

  const body = new URLSearchParams({ params: JSON.stringify([entry]) });
  const res = await apiFetch(`${API}/split/`, {
    apiKey,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (json.status !== 'success') {
    throw new Error(`LALAL.AI split request failed: ${json.error || `HTTP ${res.status}`}`);
  }
  return json;
}

/** Raw status poll for one or more file ids. Returns the `result` map. */
export async function checkStatus(fileIds, { apiKey } = {}) {
  const body = new URLSearchParams({ id: fileIds.join(',') });
  const res = await apiFetch(`${API}/check/`, {
    apiKey,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (json.status !== 'success') {
    throw new Error(`LALAL.AI check failed: ${json.error || `HTTP ${res.status}`}`);
  }
  return json.result || {};
}

/**
 * Poll `check` until the split for `fileId` finishes.
 *
 * @returns {Promise<{stem_track:string, back_track:string, duration:number}>}
 *   the `split` object (download URLs) on success.
 */
export async function waitForSplit(fileId, { apiKey, intervalMs = 2500, timeoutMs = 900_000, onProgress } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await checkStatus([fileId], { apiKey });
    const entry = result[fileId];
    if (entry) {
      if (entry.status === 'error') throw new Error(`LALAL.AI error: ${entry.error || 'unknown'}`);
      const task = entry.task || {};
      if (onProgress) onProgress({ state: task.state || 'progress', progress: task.progress ?? 0 });
      if (task.state === 'success') {
        if (!entry.split || !entry.split.stem_track) throw new Error('LALAL.AI reported success but returned no split URLs');
        return entry.split;
      }
      if (task.state === 'error') throw new Error(`LALAL.AI split failed: ${task.error || 'unknown error'}`);
      if (task.state === 'cancelled') throw new Error('LALAL.AI split was cancelled');
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for LALAL.AI split to finish');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Stream a result URL to disk. Returns the destination path. */
export async function downloadResult(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`);
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  return destPath;
}
