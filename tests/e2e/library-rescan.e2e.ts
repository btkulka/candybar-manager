import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { launchApp, LaunchedApp } from './helpers';

const TARGET_ROOT = '/Volumes/Time Machin/Library';

// Regression: after a fresh library-health scan, the Library compact list
// must actually render the tracks. A legacy 'all' value in healthTabFilter
// used to get applied as an issue-code filter and hide every row.
describe('library rescan: tracks display after scan', () => {
  let app: LaunchedApp;

  beforeAll(async () => {
    app = await launchApp();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  test('scan library root and render tracks in the Library page', async () => {
    const { page } = app;

    const scanInfo = await page.evaluate(async (root) => {
      const w = window as any;
      const existing = await w.candybar.getConfig();
      await w.candybar.setConfig({ ...existing, libraryRoot: root });
      const res = await w.candybar.scanLibraryHealth(false, false);
      return {
        libraryRoot: res.result?.libraryRoot,
        total: res.result?.summary?.total ?? 0
      };
    }, TARGET_ROOT);

    expect(scanInfo.libraryRoot).toBe(TARGET_ROOT);
    expect(scanInfo.total).toBeGreaterThan(0);

    // Reload so the real renderer boot path (restoreHealthCache →
    // restoreLibraryResults) runs against the fresh SQLite snapshot.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const state = await page.evaluate(() => {
      const listEl = document.getElementById('browse-compact-list');
      return {
        rowCount: listEl ? listEl.querySelectorAll('.bv4-row').length : -1,
        firstSnippet: listEl ? listEl.innerHTML.slice(0, 120) : null
      };
    });

    expect(state.rowCount, `tracks should be rendered, got: ${state.firstSnippet}`).toBeGreaterThan(0);
  }, 180000);
});
