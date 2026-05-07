import { _electron as electron, ElectronApplication, Page } from 'playwright';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  consoleErrors: string[];
  pageErrors: string[];
  close: () => Promise<void>;
}

export async function launchApp(): Promise<LaunchedApp> {
  // Strip ELECTRON_RUN_AS_NODE from the environment — if set (even to '1'),
  // it forces Electron into node-only mode and prevents main-process init.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'ELECTRON_RUN_AS_NODE') continue;
    if (typeof v === 'string') env[k] = v;
  }
  env.NODE_ENV = 'test';
  env.ELECTRON_DISABLE_SANDBOX = '1';

  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env,
    timeout: 30000,
  });

  const page = await app.firstWindow({ timeout: 15000 });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);

  return {
    app,
    page,
    consoleErrors,
    pageErrors,
    close: async () => {
      try { await app.close(); } catch { /* ignore */ }
    },
  };
}

export const NAV_PAGES = [
  { key: 'library',    pageId: 'page-library',    nav: '[data-page="library"]' },
  { key: 'organize',   pageId: 'page-organize',   nav: '[data-page="organize"]' },
  { key: 'check',      pageId: 'page-check',      nav: '[data-page="check"]' },
  { key: 'source',     pageId: 'page-source',     nav: '[data-page="source"]' },
  { key: 'usb-health', pageId: 'page-usb-health', nav: '[data-page="usb-health"]' },
] as const;
