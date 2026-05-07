#!/usr/bin/env node
// Fetch Qobuz purchase pages using the Electron session partition that already
// has `userCookie` from prior login attempts in the main app. Dumps the raw
// HTML to /tmp/qobuz-recon/electron-<slug>.html so we can inspect structure.

import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const OUT_DIR = '/tmp/qobuz-recon';
fs.mkdirSync(OUT_DIR, { recursive: true });

const ACCOUNT_IDS = [
  'cfc03926-c402-413b-a975-8f6eb1d31729', // Primary (ben@forcemajeure.vip)
  'a9644e8a-af83-4c45-b906-847efb68e57c', // Legacy (management@godspeedtalent.com)
];

const URLS = [
  'https://www.qobuz.com/us-en/account/purchases/tracks',
  'https://www.qobuz.com/us-en/account/purchases',
  'https://www.qobuz.com/us-en/account/downloads',
  'https://www.qobuz.com/us-en/library/purchases',
  'https://www.qobuz.com/api.json/0.2/user/me',
];

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k === 'ELECTRON_RUN_AS_NODE') continue;
  if (typeof v === 'string') env[k] = v;
}
env.ELECTRON_DISABLE_SANDBOX = '1';

console.log(`launching Electron`);
const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 30000 });

// Don't need a visible window — we just need the session partitions live.
// Wait briefly so main process finishes startup.
await new Promise(r => setTimeout(r, 3000));

for (const accountId of ACCOUNT_IDS) {
  console.log(`\n=== account ${accountId} ===`);
  const partition = `persist:qobuz-${accountId}`;

  for (const url of URLS) {
    const result = await app.evaluate(async ({ session }, { partition, url }) => {
      const ses = session.fromPartition(partition);
      const cookies = await ses.cookies.get({ url });
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      try {
        const res = await fetch(url, {
          redirect: 'manual',
          headers: {
            'Cookie': cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
        });
        const body = await res.text();
        return {
          status: res.status,
          location: res.headers.get('location'),
          bodyLen: body.length,
          cookieNames: cookies.map(c => c.name).sort(),
          body: body.length > 500_000 ? body.slice(0, 500_000) : body,
        };
      } catch (err) {
        return { error: err && err.message ? err.message : String(err), cookieNames: cookies.map(c => c.name).sort() };
      }
    }, { partition, url });

    const slug = url.replace(/[^a-zA-Z0-9]/g, '_').slice(-80);
    const outPath = `${OUT_DIR}/electron-${accountId.slice(0, 8)}-${slug}.html`;
    if (result.body) fs.writeFileSync(outPath, result.body);
    console.log(`  ${url}`);
    console.log(`    status=${result.status} location=${result.location ?? '(none)'} bodyLen=${result.bodyLen} wrote=${result.body ? outPath : '(no body)'}`);
    console.log(`    cookies=${(result.cookieNames || []).length} names=[${(result.cookieNames || []).join(',')}]`);
    if (result.error) console.log(`    ERROR: ${result.error}`);
  }
}

await app.close();
console.log(`\nDone. Files in ${OUT_DIR}`);
