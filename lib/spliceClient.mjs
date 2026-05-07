// Splice GraphQL client.
//
// Uses the saved Playwright profile (set up by `splice-api-recon.mjs`) to
// snag a fresh Auth0 bearer token, caches it on disk, and then talks to
// `surfaces-graphql.splice.com` and S3 directly via plain `fetch`. No
// browser stays alive between calls — Playwright is only spun up to mint
// or refresh the JWT.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { launchSiteBrowser } from './launchBrowser.mjs';

const TOKEN_CACHE = path.join(os.homedir(), '.cache', 'candybar-manager', 'splice-token.json');
const GRAPHQL_URL = 'https://surfaces-graphql.splice.com/graphql';

// Politeness: keep ~700ms between API calls. Splice has no published rate
// limit; this is just "noticeably slower than a human power-user" so we
// don't trip whatever heuristics they have.
const MIN_REQUEST_GAP_MS = 700;

// --- GraphQL operations (verbatim from network capture) -------------------

const SAMPLES_SEARCH_QUERY = `query SamplesSearch($attributes: [AssetAttributeSlug!], $parent_asset_uuid: GUID, $query: String, $order: SortOrder = DESC, $sort: AssetSortType = popularity, $random_seed: String, $tags: [ID], $key: String, $chord_type: String, $bpm: String, $min_bpm: Int, $max_bpm: Int, $limit: Int = 50, $asset_category_slug: AssetCategorySlug, $page: Int = 1, $ac_uuid: String, $parent_asset_type: AssetTypeSlug, $licensed: Boolean, $liked: Boolean, $filepath: String) {
  assetsSearch(
    filter: {attributes: $attributes, legacy: true, published: true, asset_type_slug: sample, query: $query, filepath: $filepath, tag_ids: $tags, key: $key, chord_type: $chord_type, bpm: $bpm, min_bpm: $min_bpm, max_bpm: $max_bpm, asset_category_slug: $asset_category_slug, ac_uuid: $ac_uuid, licensed: $licensed, liked: $liked}
    children: {parent_asset_uuid: $parent_asset_uuid}
    pagination: {page: $page, limit: $limit}
    sort: {order: $order, sort_type: $sort, random_seed: $random_seed}
  ) {
    assets {
      ... on SampleAsset {
        uuid
        name
        filename
        bpm
        key
        duration
        attributes
        asset_category_slug
        parents {
          items {
            ... on PackAsset {
              uuid
              name
              permalink_slug
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    pagination {
      total_entries
      total_pages
      current_page
      __typename
    }
    __typename
  }
}`;

const SAMPLE_ASSET_FILES_QUERY = `query SampleAssetFiles($assetUuid: GUID!, $legacy: AssetLegacyInput) {
  asset: asset(uuid: $assetUuid, legacy: $legacy) {
    __typename
    ... on SampleAsset {
      files(includeSource: true) {
        uuid
        name
        url
        asset_file_type_slug
        path
        __typename
      }
      __typename
    }
  }
}`;

// --- Token management -----------------------------------------------------

function readCachedToken() {
  try {
    const raw = fs.readFileSync(TOKEN_CACHE, 'utf8');
    const cached = JSON.parse(raw);
    // Treat anything within 60s of expiry as expired — gives in-flight
    // requests a buffer.
    if (cached.expiresAt > Date.now() + 60_000) return cached.token;
  } catch {}
  return null;
}

function writeCachedToken(token) {
  // JWT payload is base64url; second segment carries `exp` (unix seconds).
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  fs.mkdirSync(path.dirname(TOKEN_CACHE), { recursive: true });
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ token, expiresAt: payload.exp * 1000 }, null, 2));
  return payload.exp * 1000;
}

// Spin up a headless Chrome with the saved Splice profile, navigate to a
// page that fires GraphQL, and intercept the Authorization header. This
// is the simplest way to get a JWT without re-implementing Auth0's
// silent-refresh flow ourselves.
async function mintFreshToken({ verbose }) {
  if (verbose) console.error('[splice] minting fresh JWT via Playwright…');
  const ctx = await launchSiteBrowser({ profile: 'splice', headless: true });
  let token = null;
  ctx.on('request', (req) => {
    if (token) return;
    if (!req.url().startsWith(GRAPHQL_URL)) return;
    const auth = req.headers()['authorization'];
    if (auth?.startsWith('Bearer ')) token = auth.slice('Bearer '.length);
  });
  try {
    const page = await ctx.newPage();
    // Loading the "your sounds" page reliably triggers a SamplesSearch
    // call, which carries the bearer token in its headers.
    await page.goto('https://splice.com/sounds/your-sounds/samples', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    const deadline = Date.now() + 30_000;
    while (!token && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  if (!token) {
    throw new Error(
      'Could not capture Splice bearer token. The profile may have been logged out — re-run `node splice-api-recon.mjs` and log in again.',
    );
  }
  writeCachedToken(token);
  if (verbose) console.error('[splice] token cached');
  return token;
}

export async function getAuthToken({ forceRefresh = false, verbose = false } = {}) {
  if (!forceRefresh) {
    const cached = readCachedToken();
    if (cached) return cached;
  }
  return await mintFreshToken({ verbose });
}

// --- Rate-limited GraphQL POST -------------------------------------------

let lastRequestAt = 0;
async function spaceRequests() {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

// One GraphQL POST. Handles 401 (token went stale mid-session) by
// refreshing once and retrying. Handles 429 with exponential backoff.
async function graphql(operationName, query, variables, { verbose = false } = {}) {
  let token = await getAuthToken({ verbose });
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await spaceRequests();
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      body: JSON.stringify({ operationName, query, variables }),
    });

    if (res.status === 401 && attempt === 0) {
      attempt++;
      token = await getAuthToken({ forceRefresh: true, verbose });
      continue;
    }
    if (res.status === 429 && attempt < 3) {
      const backoffMs = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
      if (verbose) console.error(`[splice] 429 — backing off ${backoffMs}ms`);
      await new Promise((r) => setTimeout(r, backoffMs));
      attempt++;
      continue;
    }
    if (!res.ok) {
      throw new Error(`Splice GraphQL ${operationName} failed: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    if (json.errors) {
      throw new Error(`Splice GraphQL ${operationName} returned errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  }
}

// --- Public API -----------------------------------------------------------

/**
 * Search Splice's sample catalog.
 *
 * @param {object} opts
 * @param {string} [opts.filepath] Filename fragment to match. Splice's
 *                                 own search also uses this; basename of
 *                                 the missing file works well.
 * @param {string} [opts.query]    Free-text query. Usually we use filepath.
 * @param {boolean} [opts.licensed] true → only samples already in the
 *                                 user's library (free re-download). null
 *                                 (default) → full catalog (costs credits).
 * @param {number} [opts.page]
 * @param {number} [opts.limit]
 * @returns {Promise<{assets: Array, pagination: object}>}
 */
export async function searchSamples({ filepath = null, query = null, licensed = null, page = 1, limit = 50, verbose = false } = {}) {
  const data = await graphql(
    'SamplesSearch',
    SAMPLES_SEARCH_QUERY,
    {
      order: 'DESC',
      sort: licensed ? 'recency' : 'popularity',
      limit,
      page,
      tags: [],
      key: null,
      chord_type: null,
      bpm: null,
      min_bpm: null,
      max_bpm: null,
      asset_category_slug: null,
      random_seed: null,
      attributes: [],
      filepath,
      query,
      licensed,
      liked: null,
      ac_uuid: null,
    },
    { verbose },
  );
  return data.assetsSearch;
}

/**
 * Look up the asset files for a given sample UUID. The interesting one
 * is the file whose `asset_file_type_slug === 'source'` — its `url` is
 * a signed S3 URL valid for ~120 seconds.
 */
export async function getSampleAssetFiles(assetUuid, { verbose = false } = {}) {
  const data = await graphql(
    'SampleAssetFiles',
    SAMPLE_ASSET_FILES_QUERY,
    { assetUuid },
    { verbose },
  );
  return data.asset?.files || [];
}

/**
 * Download a sample by UUID to `destPath`. Resolves to the absolute path
 * written. Creates parent directories as needed.
 */
export async function downloadSample(assetUuid, destPath, { verbose = false } = {}) {
  const files = await getSampleAssetFiles(assetUuid, { verbose });
  const source = files.find((f) => f.asset_file_type_slug === 'source');
  if (!source?.url) {
    throw new Error(`No source file in SampleAssetFiles response for ${assetUuid}`);
  }
  const res = await fetch(source.url);
  if (!res.ok) {
    throw new Error(`S3 download failed for ${assetUuid}: ${res.status} ${res.statusText}`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  if (verbose) console.error(`[splice] wrote ${destPath}`);
  return destPath;
}
