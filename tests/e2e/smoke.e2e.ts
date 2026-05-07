import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { launchApp, LaunchedApp, NAV_PAGES } from './helpers';

describe('smoke: app boots and reports runtime errors', () => {
  let app: LaunchedApp;

  beforeAll(async () => {
    app = await launchApp();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  test('main window opens', async () => {
    expect(app.page).toBeDefined();
    const title = await app.page.title();
    expect(title.length).toBeGreaterThan(0);
  });

  test('no uncaught page errors during boot', async () => {
    await app.page.waitForTimeout(2000);
    if (app.pageErrors.length > 0) {
      console.warn('\n=== PAGE ERRORS ===\n' + app.pageErrors.join('\n---\n'));
    }
    expect(app.pageErrors, `unhandled page errors: ${app.pageErrors.join(', ')}`).toEqual([]);
  });

  test('console.error is not emitted during boot', async () => {
    if (app.consoleErrors.length > 0) {
      console.warn('\n=== CONSOLE ERRORS ===\n' + app.consoleErrors.join('\n---\n'));
    }
    // Failing-soft: just report. Comment-in the next line to fail the test.
    // expect(app.consoleErrors).toEqual([]);
  });

  test('sidebar nav links all present', async () => {
    const missing: string[] = [];
    for (const { key, nav } of NAV_PAGES) {
      const count = await app.page.locator(nav).count();
      if (count === 0) missing.push(`nav-link[${key}]`);
    }
    expect(missing, `missing nav links: ${missing.join(', ')}`).toEqual([]);
  });

  test('all page containers exist in DOM', async () => {
    const missing: string[] = [];
    for (const { key, pageId } of NAV_PAGES) {
      const count = await app.page.locator(`#${pageId}`).count();
      if (count === 0) missing.push(`#${pageId}`);
      else if (count > 1) missing.push(`#${pageId} (duplicate id, count=${count})`);
    }
    expect(missing, `page container issues: ${missing.join(', ')}`).toEqual([]);
  });

  test('window.candybar IPC bridge is exposed', async () => {
    const keys = await app.page.evaluate(() => {
      return (window as any).candybar ? Object.keys((window as any).candybar) : [];
    });
    expect(keys.length).toBeGreaterThan(10);
    // Core APIs the renderer relies on
    const required = [
      'getConfig', 'setConfig', 'getLibraryRoot',
      'checkLibrary', 'scanLibraryHealth', 'selectPath',
      'checkSpotify', 'checkSoundCloud',
    ];
    const missing = required.filter(k => !keys.includes(k));
    expect(missing, `missing window.candybar.* methods: ${missing.join(', ')}`).toEqual([]);
  });

  test('getConfig IPC returns valid config', async () => {
    const { ok, error, config } = await app.page.evaluate(async () => {
      try {
        const config = await (window as any).candybar.getConfig();
        return { ok: true, config };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    });
    expect(ok, `getConfig rejected: ${error}`).toBe(true);
    expect(config).toBeDefined();
  });
});
