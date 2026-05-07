# Splice sample recovery

Recover missing Splice samples from an old Ableton project by re-downloading them from your Splice library.

## What it does

1. Reads a `.als` (Ableton Live Set), finds every `<SampleRef>` whose path lives under `/Splice/`, and filters to the ones missing on disk.
2. For each missing sample, searches Splice's GraphQL API by filename — first against your owned/licensed library (free re-download), then against the full catalog (costs credits).
3. Writes a manifest sorting hits into three buckets:
   - **owned** — already in your subscription, free to re-download
   - **credits** — available in the catalog but you don't own it yet
   - **notFound** — no match (renamed, removed from Splice, or wasn't from Splice in the first place)
4. With `--download-owned`, automatically pulls the owned bucket into the original paths the project referenced — so when you reopen in Ableton, samples resolve.

The credits bucket is intentionally not auto-downloaded; the eventual UI will make spending credits an explicit per-sample opt-in.

## One-time setup on a fresh machine

### Prerequisites

- **Node 22** — pinned in `.nvmrc`. If you use nvm: `nvm install 22 && nvm use`.
- **Google Chrome** — the recovery tool launches your real installed Chrome (not Playwright's bundled Chrome-for-Testing) to avoid Cloudflare blocks. Install from google.com/chrome if you don't have it.
- **A Splice account** with an active subscription.

### Install

```bash
npm install
npx playwright install chromium   # one-time browser download
```

### Log into Splice (one-time)

The recovery tool reuses a saved Chrome profile so it doesn't have to log in every run. Set up the profile:

```bash
node splice-api-recon.mjs
```

A Chrome window opens at splice.com. Log in with your Splice account. Once you're in, you can close the window — the script writes the profile to `~/.cache/candybar-manager/playwright-profiles/splice/`.

(This script was originally for reverse-engineering the API and also dumps every request to `/tmp/splice-recon-*` — that's harmless, just leftover from recon.)

## Running a recovery

### Dry run — see what would happen

```bash
node splice-recover.mjs /path/to/your-project.als
```

Output looks like:

```
scanning /path/to/your-project.als
  total sample refs: 142
  splice-flavored:   58
  missing on disk:   23

[1/23] Drums_OneShots_kick_16.wav … OWNED (uuid=...)
[2/23] T_TSCR2_clap_oneshot_aguila.wav … OWNED (uuid=...)
[3/23] some-rare-sample.wav … CREDITS (uuid=...)
...

owned (free):     19
credits (paid):   3
not found:        1

manifest: /tmp/splice-recover-your-project.json
```

The manifest has all three buckets with sample names, asset UUIDs, and the original Ableton paths.

### Actually download the free bucket

```bash
node splice-recover.mjs /path/to/your-project.als --download-owned
```

This re-runs the scan and downloads every sample in the owned bucket into the original path the `.als` referenced. Reopen the project in Ableton and missing-sample warnings should resolve.

The credits bucket is not touched — read the manifest at `/tmp/splice-recover-<project>.json` to see what would cost credits.

## Troubleshooting

### "Could not capture Splice bearer token"

The saved profile got logged out. Re-run `node splice-api-recon.mjs` and log in again.

### Chrome opens to a Cloudflare challenge or "access denied" page

Solve the challenge once in the visible browser — the persistent profile keeps Cloudflare's "you're a real human" cookie, so subsequent runs should pass without challenge.

### Browser fails to launch with "channel: chrome" error

You don't have Google Chrome installed (Playwright was looking for the system Chrome binary). Install Chrome from google.com/chrome.

### Matches look wrong

Splice's `filepath` filter matches against their own filenames. If your project renamed samples after download (some users do this), the basename won't match — those will land in `notFound`. Open the manifest and search the basenames manually on splice.com to confirm.

## How it works (brief)

| File | Role |
|---|---|
| [`lib/launchBrowser.mjs`](../lib/launchBrowser.mjs) | Launches real Chrome with a per-site persistent profile. Avoids Chrome-for-Testing fingerprint. |
| [`lib/spliceClient.mjs`](../lib/spliceClient.mjs) | Snags the Auth0 JWT from the persistent profile, caches it with expiry, talks to `surfaces-graphql.splice.com`. Rate-limited, retries on 401/429. |
| [`lib/alsParser.mjs`](../lib/alsParser.mjs) | Decompresses `.als` (gzipped XML), regex-extracts `<Path Value="..."/>`, filters to `/Splice/` paths. |
| [`splice-recover.mjs`](../splice-recover.mjs) | CLI that wires the above together. |
| [`splice-api-recon.mjs`](../splice-api-recon.mjs) | One-time API recon / login helper. |

The two GraphQL operations used: `SamplesSearch` (for matching by filename + library scoping via `licensed: true`) and `SampleAssetFiles` (returns a 119-second-signed S3 URL for the source WAV).

## Known limitations

- **No pagination on search results.** We take the top hit per missing sample. If multiple Splice samples share a basename (rare but possible), we may pick the wrong one.
- **Token refresh requires Playwright.** When the cached JWT expires (~1 hour), we spin up a brief headless Chrome to mint a new one. We could replicate Auth0's silent refresh flow with `fetch` directly, but it's not worth the brittleness for the once-an-hour cost.
- **No UI yet.** Eventual Electron page lets you check/uncheck items in the credits bucket and bulk-spend. For now: read the manifest, decide manually.
