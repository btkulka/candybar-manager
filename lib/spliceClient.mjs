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

// Splice's GraphQL schema shifted in late 2025. The query below was captured
// from a live web-app session via scripts/capture-splice-query.mjs. Notable
// changes vs. the original:
//   - sort field renamed: `{ sort_type: $sort }` → `{ sort: $sort }`
//   - legacy arg moved out of `filter` and into a top-level `legacy: {...}`
//   - response shape: `assets` → `items`, `pagination` → `pagination_metadata`
//   - `SampleAsset.filename` removed; filename lives under `files[].name` now
//   - `parents` requires a filter argument
//
// We trim the captured query to just the fields we care about (uuid/name +
// files[] for filename); the full web-app query also pulls fragments for
// PresetAsset/PackAsset/MidiAsset/etc that don't apply to sample search.
const SAMPLES_SEARCH_QUERY = `query SamplesSearch($attributes: [AssetAttributeSlug!], $parent_asset_uuid: GUID, $query: String, $order: SortOrder = DESC, $sort: AssetSortType = popularity, $random_seed: String, $tags: [ID], $key: String, $chord_type: String, $bpm: String, $min_bpm: Int, $max_bpm: Int, $limit: Int = 50, $asset_category_slug: AssetCategorySlug, $page: Int = 1, $ac_uuid: String, $parent_asset_type: AssetTypeSlug, $licensed: Boolean, $liked: Boolean, $filepath: String) {
  assetsSearch(
    filter: {attributes: $attributes, legacy: true, published: true, asset_type_slug: sample, query: $query, filepath: $filepath, tag_ids: $tags, key: $key, chord_type: $chord_type, bpm: $bpm, min_bpm: $min_bpm, max_bpm: $max_bpm, asset_category_slug: $asset_category_slug, ac_uuid: $ac_uuid, licensed: $licensed, liked: $liked}
    children: {parent_asset_uuid: $parent_asset_uuid}
    pagination: {page: $page, limit: $limit}
    sort: {sort: $sort, order: $order, random_seed: $random_seed}
    legacy: {parent_asset_type: $parent_asset_type}
  ) {
    items {
      ... on IAsset {
        uuid
        __typename
      }
      ... on SampleAsset {
        catalog_uuid
        name
        bpm
        key
        duration
        attributes
        asset_category_slug
        files {
          uuid
          name
          path
          asset_file_type_slug
          __typename
        }
        parents(filter: {asset_type_slug: pack}) {
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
    pagination_metadata {
      currentPage
      totalPages
      __typename
    }
    response_metadata {
      records
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

const SOUNDS_LAYOUT_QUERY = `query SoundsLayout {
  subscription {
    credits
    state
    plan {
      tier
      name
      group {
        name
        __typename
      }
      __typename
    }
    __typename
  }
}`;

const PURCHASE_ASSET_MUTATION = `mutation PurchaseAsset($uuid: GUID!) {
  purchaseAsset(uuid: $uuid) {
    ... on IAsset {
      uuid
      licensed
      __typename
    }
    __typename
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

// Spin up a Chrome with the saved Splice profile, navigate to a page that
// fires GraphQL, and intercept the Authorization header. Note: NOT
// headless — Splice's anti-bot stack fingerprints headless Chrome and
// the page either doesn't fire SamplesSearch or shows the auth wall.
// The window appears briefly (~5s) and closes itself; rare enough during
// a session that it's a tolerable UX cost vs. silent failure.
async function mintFreshToken({ verbose }) {
  if (verbose) console.error('[splice] minting fresh JWT via Playwright…');
  const ctx = await launchSiteBrowser({ profile: 'splice', headless: false });
  let token = null;
  ctx.on('request', (req) => {
    if (token) return;
    if (!req.url().startsWith(GRAPHQL_URL)) return;
    const auth = req.headers()['authorization'];
    if (auth?.startsWith('Bearer ')) token = auth.slice('Bearer '.length);
  });
  try {
    const page = await ctx.newPage();
    // Loading any sounds-search page reliably triggers a SamplesSearch
    // call. The general /sounds page works whether the user has owned
    // samples or not.
    await page.goto('https://splice.com/sounds', {
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
      'Could not capture Splice bearer token. The profile may have been logged out — sign in again from Splice Recovery.',
    );
  }
  writeCachedToken(token);
  if (verbose) console.error('[splice] token cached');
  return token;
}

// Promise-coalesce in-flight mints. Without this, every parallel/sequential
// 401-retry in the classify loop would spawn its own browser window. With
// it, the first call mints; everyone else waits for that promise. Once it
// resolves the cache is fresh and subsequent callers hit readCachedToken.
let mintInFlight = null;

export async function getAuthToken({ forceRefresh = false, verbose = false } = {}) {
  if (!forceRefresh) {
    const cached = readCachedToken();
    if (cached) return cached;
  }
  if (mintInFlight) return mintInFlight;
  mintInFlight = (async () => {
    try {
      return await mintFreshToken({ verbose });
    } finally {
      mintInFlight = null;
    }
  })();
  return mintInFlight;
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
// 30s timeout per request so a stuck TCP socket can't freeze the whole
// classify loop indefinitely.
async function graphql(operationName, query, variables, { verbose = false } = {}) {
  let token = await getAuthToken({ verbose });
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await spaceRequests();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    let res;
    try {
      res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        body: JSON.stringify({ operationName, query, variables }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

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
 * @returns {Promise<{assets: Array<{uuid: string, contentHash: string, name: string, filename: string}>, pagination: {currentPage: number, totalPages: number, totalRecords: number}}>}
 *   `uuid` is the canonical 36-char GUID (what asset() lookup wants);
 *   `contentHash` is the 64-char content hash Splice surfaces as `uuid`
 *   in their schema but we don't need for downloads.
 */
export async function searchSamples({ filepath = null, query = null, licensed = null, page = 1, limit = 50, verbose = false } = {}) {
  // Splice's web app sets BOTH `filepath` and `query` to the same string
  // when the user types in the search box. Sending only one returns
  // popularity-sorted noise rather than name matches. Mirror their UI:
  // if the caller only passed `filepath`, copy it to `query` too.
  const queryTerm = query ?? filepath ?? null;

  const data = await graphql(
    'SamplesSearch',
    SAMPLES_SEARCH_QUERY,
    {
      order: 'DESC',
      // Always sort by popularity. Splice's UI uses popularity even on
      // owned-library searches; using `recency` here was a leftover that
      // returned samples ordered by when you licensed them rather than by
      // search relevance, which buried exact filename matches.
      sort: 'popularity',
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
      query: queryTerm,
      licensed,
      liked: null,
      ac_uuid: null,
    },
    { verbose },
  );

  const raw = data.assetsSearch;
  const items = raw?.items ?? [];
  const assets = items.map((it) => {
    const files = it.files ?? [];
    // Prefer the actual sample file (source) for the filename. Fall back to
    // any file with a name, then synthesize from the asset's display name.
    // The asset's `name` may already include an extension — only append
    // `.wav` if one isn't already present.
    const source = files.find((f) => f.asset_file_type_slug === 'source');
    const fallbackName = (it.name && /\.[a-z0-9]{2,4}$/i.test(it.name))
      ? it.name
      : `${it.name ?? 'unknown'}.wav`;
    const filename =
      source?.name ||
      files.find((f) => f.name)?.name ||
      fallbackName;
    // Pack metadata + cover art live under parents (filtered to packs).
    // Pull the first pack's name, slug (for the public Splice URL), and
    // its `cover_image` file URL — that's the small thumbnail Splice
    // uses on listings.
    const pack = it.parents?.items?.[0];
    const coverUrl = pack?.files?.find?.((f) => f.asset_file_type_slug === 'cover_image')?.url ?? null;
    const packName = pack?.name ?? null;
    const packSlug = pack?.permalink_slug ?? null;

    // The naming is confusing: the field Splice now exposes as `uuid` is
    // a 64-char content hash (the audio sample's blob ID), and the field
    // they call `catalog_uuid` is actually the canonical 36-char GUID
    // that `asset(uuid: GUID!)` lookup expects. We expose the GUID as
    // `uuid` for downstream callers since that's what they pass to
    // downloadSample/asset() — the 64-char hash isn't useful to us.
    return {
      uuid: it.catalog_uuid,
      contentHash: it.uuid,
      name: it.name,
      filename,
      coverUrl,
      packName,
      packSlug,
    };
  });

  const pm = raw?.pagination_metadata ?? {};
  const rm = raw?.response_metadata ?? {};
  const pagination = {
    currentPage: pm.currentPage ?? page,
    totalPages: pm.totalPages ?? 0,
    totalRecords: rm.records ?? assets.length,
  };

  return { assets, pagination };
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

/**
 * Read the user's credits balance + plan. Mirrors what splice.com fires
 * on every Sounds page load.
 *
 * @returns {Promise<{ credits: number, state: string, planName: string | null, planTier: string | null }>}
 */
export async function getCreditsBalance({ verbose = false } = {}) {
  const data = await graphql('SoundsLayout', SOUNDS_LAYOUT_QUERY, {}, { verbose });
  const sub = data.subscription ?? {};
  return {
    credits: typeof sub.credits === 'number' ? sub.credits : 0,
    state: sub.state ?? 'unknown',
    planName: sub.plan?.name ?? null,
    planTier: sub.plan?.tier ?? null,
  };
}

/**
 * Spend a credit to license a sample asset. After this resolves, the
 * sample is in the user's library and `downloadSample(uuid, …)` will
 * succeed against it.
 *
 * @param {string} assetUuid Canonical 36-char GUID (catalog_uuid).
 */
export async function purchaseAsset(assetUuid, { verbose = false } = {}) {
  const data = await graphql(
    'PurchaseAsset',
    PURCHASE_ASSET_MUTATION,
    { uuid: assetUuid },
    { verbose },
  );
  if (!data.purchaseAsset) {
    throw new Error(`PurchaseAsset returned no asset for ${assetUuid}`);
  }
  return data.purchaseAsset;
}
