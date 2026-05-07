import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { launchApp, LaunchedApp, NAV_PAGES } from './helpers';

describe('navigation: each nav link activates its page', () => {
  let app: LaunchedApp;

  beforeAll(async () => {
    app = await launchApp();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  for (const { key, pageId, nav } of NAV_PAGES) {
    test(`clicking nav[${key}] activates #${pageId}`, async () => {
      const errorsBefore = app.pageErrors.length;

      await app.page.locator(nav).first().click({ timeout: 5000 });
      await app.page.waitForTimeout(400);

      const activeOnPage = await app.page.evaluate((id) => {
        const nodes = Array.from(document.querySelectorAll(`#${id}`)) as HTMLElement[];
        const active = nodes.find(n => n.classList.contains('active'));
        return {
          count: nodes.length,
          anyActive: Boolean(active),
          activeVisible: active ? active.offsetParent !== null : false,
        };
      }, pageId);

      expect(activeOnPage.count, `#${pageId} not found in DOM`).toBeGreaterThan(0);
      expect(activeOnPage.anyActive, `#${pageId} did not receive .active class after nav click`).toBe(true);

      const errorsAfter = app.pageErrors.length;
      const newErrors = app.pageErrors.slice(errorsBefore, errorsAfter);
      expect(newErrors, `errors thrown on nav[${key}]: ${newErrors.join(', ')}`).toEqual([]);
    });
  }
});
