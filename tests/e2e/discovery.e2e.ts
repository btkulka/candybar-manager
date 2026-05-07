import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { launchApp, LaunchedApp, NAV_PAGES } from './helpers';

/**
 * Discovery suite: probes the running app for the presence and wiring of
 * every feature entry point. Each test reports a clean list of what's
 * missing or broken — so a single run produces a punch list of regressions.
 */

interface FeatureProbe {
  page: typeof NAV_PAGES[number]['key'];
  name: string;
  selector: string;
  expect: 'exists' | 'visible' | 'enabled';
}

const FEATURE_PROBES: FeatureProbe[] = [
  // Library page
  { page: 'library', name: 'library-kpi-dashboard',  selector: '#library-dashboard', expect: 'exists' },
  { page: 'library', name: 'browse-compact-list',    selector: '#browse-compact-list', expect: 'exists' },
  { page: 'library', name: 'browse-search-input',    selector: '#browse-search', expect: 'exists' },
  { page: 'library', name: 'browse-health-summary',  selector: '#browse-health-summary', expect: 'exists' },
  { page: 'library', name: 'duplicates-section',     selector: '#duplicates-section', expect: 'exists' },
  { page: 'library', name: 'toggle-split-panel',     selector: '#toggle-split-panel', expect: 'exists' },
  { page: 'library', name: 'toggle-columns-panel',   selector: '#toggle-columns-panel', expect: 'exists' },
  { page: 'library', name: 'connected-devices-section', selector: '#connected-devices-section', expect: 'exists' },

  // Organize page
  { page: 'organize', name: 'source-dir-input',      selector: '#organize-source', expect: 'exists' },
  { page: 'organize', name: 'scan-tracks-button',    selector: '#scan-tracks', expect: 'visible' },
  { page: 'organize', name: 'run-organize-button',   selector: '#run-organize', expect: 'exists' },
  { page: 'organize', name: 'track-list-container',  selector: '#track-list', expect: 'exists' },

  // Check page
  { page: 'check',    name: 'check-wizard',          selector: '#check-wizard', expect: 'exists' },
  { page: 'check',    name: 'check-source-lane',     selector: '#check-wizard [data-lane="source"]', expect: 'exists' },
  { page: 'check',    name: 'check-source-toggle',   selector: '#check-source-toggle', expect: 'exists' },
  { page: 'check',    name: 'csv-source-field',      selector: '#csv-source-field', expect: 'exists' },
  { page: 'check',    name: 'csv-drop-zone',         selector: '#csv-drop-zone', expect: 'exists' },
  { page: 'check',    name: 'spotify-source-field',  selector: '#spotify-source-field', expect: 'exists' },
  { page: 'check',    name: 'run-check-button',      selector: '#run-check', expect: 'exists' },
  { page: 'check',    name: 'check-tabs',            selector: '.check-tab[data-tab="missing"]', expect: 'exists' },
  { page: 'check',    name: 'check-search-input',    selector: '#check-search', expect: 'exists' },
  { page: 'check',    name: 'export-current-list',   selector: '#export-current-list', expect: 'exists' },
  { page: 'check',    name: 'missing-track-list',    selector: '#missing-track-list', expect: 'exists' },
  { page: 'check',    name: 'matched-track-list',    selector: '#matched-track-list', expect: 'exists' },
  { page: 'check',    name: 'uncertain-track-list',  selector: '#uncertain-track-list', expect: 'exists' },
  { page: 'check',    name: 'csv-track-list',        selector: '#csv-track-list', expect: 'exists' },

  // Source page
  { page: 'source',   name: 'source-wizard',         selector: '#source-wizard', expect: 'exists' },
  { page: 'source',   name: 'source-csv-drop-zone',  selector: '#source-csv-drop-zone', expect: 'exists' },
  { page: 'source',   name: 'run-source-search',     selector: '#run-source-search', expect: 'exists' },
  { page: 'source',   name: 'source-results-list',   selector: '#source-results-list', expect: 'exists' },
  { page: 'source',   name: 'source-tab-all',        selector: '.source-tab[data-source-tab="all"]', expect: 'exists' },

  // USB health page
  { page: 'usb-health', name: 'usb-data-table',      selector: '#usb-data-table', expect: 'exists' },
  { page: 'usb-health', name: 'usb-kpi-grid',        selector: '#usb-kpi-grid', expect: 'exists' },
  { page: 'usb-health', name: 'usb-drive-overview',  selector: '#usb-drive-overview', expect: 'exists' },
  { page: 'usb-health', name: 'usb-checklist',       selector: '#usb-checklist', expect: 'exists' },
  { page: 'usb-health', name: 'usb-format-breakdown',selector: '#usb-format-breakdown', expect: 'exists' },

  // Global modals / panels
  { page: 'library', name: 'settings-modal',         selector: '#settings-modal', expect: 'exists' },
  { page: 'library', name: 'store-purchase-modal',   selector: '#store-purchase-modal', expect: 'exists' },
  { page: 'library', name: 'tag-editor-modal',       selector: '#tag-editor-modal', expect: 'exists' },
  { page: 'library', name: 'right-drawer',           selector: '#right-drawer', expect: 'exists' },

  // Top bar / global
  { page: 'library', name: 'settings-button',        selector: '#open-settings', expect: 'visible' },
  { page: 'library', name: 'activity-tray',          selector: '#activity-tray', expect: 'exists' },
  { page: 'library', name: 'spotify-status-badge',   selector: '#spotify-status', expect: 'visible' },
  { page: 'library', name: 'soundcloud-status-badge',selector: '#soundcloud-status', expect: 'visible' },
  { page: 'library', name: 'sidebar-player',         selector: '#sidebar-player', expect: 'exists' },
  { page: 'library', name: 'toast-container',        selector: '#toast-container', expect: 'exists' },
];

describe('discovery: feature probe report', () => {
  let app: LaunchedApp;

  beforeAll(async () => {
    app = await launchApp();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  test('HTML structural integrity: no duplicate element IDs', async () => {
    const duplicates = await app.page.evaluate(() => {
      const ids: Record<string, number> = {};
      document.querySelectorAll('[id]').forEach(el => {
        const id = el.id;
        ids[id] = (ids[id] || 0) + 1;
      });
      return Object.entries(ids).filter(([, n]) => n > 1).map(([id, n]) => `${id} × ${n}`);
    });

    if (duplicates.length > 0) {
      console.warn('\n=== DUPLICATE IDs ===\n  ' + duplicates.join('\n  '));
    }
    expect(duplicates, `duplicate IDs detected:\n  ${duplicates.join('\n  ')}`).toEqual([]);
  });

  test('orphan nav links: every nav[data-page] has a matching #page-*', async () => {
    const orphans = await app.page.evaluate(() => {
      const navs = Array.from(document.querySelectorAll('[data-page]')) as HTMLElement[];
      return navs
        .map(n => n.dataset.page!)
        .filter(key => !document.getElementById(`page-${key}`));
    });
    expect(orphans, `nav links without page container: ${orphans.join(', ')}`).toEqual([]);
  });

  test('orphan pages: every #page-* has a matching nav link', async () => {
    const orphans = await app.page.evaluate(() => {
      const pages = Array.from(document.querySelectorAll('[id^="page-"]')) as HTMLElement[];
      return pages
        .map(p => p.id.replace(/^page-/, ''))
        .filter(key => !document.querySelector(`[data-page="${key}"]`));
    });
    if (orphans.length > 0) {
      console.warn(`\n=== ORPHAN PAGES (no nav) ===\n  ${orphans.join('\n  ')}`);
    }
    expect(orphans, `pages unreachable via nav: ${orphans.join(', ')}`).toEqual([]);
  });

  test('feature probe: report which features are missing per page', async () => {
    const report: Record<string, string[]> = {};

    for (const probe of FEATURE_PROBES) {
      const nav = NAV_PAGES.find(p => p.key === probe.page);
      if (nav) {
        await app.page.locator(nav.nav).first().click().catch(() => {});
        await app.page.waitForTimeout(150);
      }

      const result = await app.page.evaluate((p) => {
        const el = document.querySelector(p.selector) as HTMLElement | null;
        if (!el) return { ok: false, reason: 'not-found' };
        if (p.expect === 'exists') return { ok: true, reason: '' };
        if (p.expect === 'visible') {
          const visible = el.offsetParent !== null && getComputedStyle(el).display !== 'none';
          return { ok: visible, reason: visible ? '' : 'not-visible' };
        }
        if (p.expect === 'enabled') {
          const disabled = (el as HTMLButtonElement).disabled;
          return { ok: !disabled, reason: disabled ? 'disabled' : '' };
        }
        return { ok: false, reason: 'unknown-check' };
      }, probe);

      if (!result.ok) {
        (report[probe.page] ||= []).push(`${probe.name} (${probe.selector}) — ${result.reason}`);
      }
    }

    if (Object.keys(report).length > 0) {
      const lines = ['\n=== MISSING / BROKEN FEATURES ==='];
      for (const [page, items] of Object.entries(report)) {
        lines.push(`\n[${page}]`);
        items.forEach(i => lines.push(`  • ${i}`));
      }
      console.warn(lines.join('\n'));
    }

    const totalMissing = Object.values(report).reduce((n, arr) => n + arr.length, 0);
    expect(totalMissing, `${totalMissing} feature(s) missing or broken`).toBe(0);
  });

  test('IPC surface parity: every window.candybar method is callable', async () => {
    const calls: Array<{ fn: string; args: unknown[] }> = [
      { fn: 'getConfig', args: [] },
      { fn: 'getLibraryRoot', args: [] },
      { fn: 'checkSpotify', args: [] },
      { fn: 'checkSoundCloud', args: [] },
    ];

    const results = await app.page.evaluate(async (calls) => {
      const out: Record<string, { ok: boolean; error?: string }> = {};
      for (const { fn, args } of calls) {
        try {
          await (window as any).candybar[fn](...args);
          out[fn] = { ok: true };
        } catch (e: any) {
          out[fn] = { ok: false, error: e?.message || String(e) };
        }
      }
      return out;
    }, calls);

    const failed = Object.entries(results).filter(([, r]) => !r.ok);
    if (failed.length > 0) {
      console.warn('\n=== IPC FAILURES ===\n  ' + failed.map(([fn, r]) => `${fn}: ${r.error}`).join('\n  '));
    }
    expect(failed.map(([fn]) => fn), 'IPC calls rejected').toEqual([]);
  });

  test('CSS sanity: no classes referenced by renderer but absent from stylesheet', async () => {
    // Pull out class names actually used in live DOM, compare against style rules
    const unstyled = await app.page.evaluate(() => {
      const usedClasses = new Set<string>();
      document.querySelectorAll('*').forEach(el => {
        el.classList.forEach(c => usedClasses.add(c));
      });

      const styledClasses = new Set<string>();
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList | null = null;
        try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule) {
            const matches = rule.selectorText.match(/\.[a-zA-Z_][\w-]*/g);
            matches?.forEach(m => styledClasses.add(m.slice(1)));
          }
        }
      }

      const SKIP = /^(active|selected|open|hidden|disabled|loading|visible|dragging|checked|focused|error|warning|success|info|hover|collapsed|expanded|dark|light)$/;
      return Array.from(usedClasses)
        .filter(c => !styledClasses.has(c) && !SKIP.test(c))
        .sort();
    });

    if (unstyled.length > 0) {
      console.warn(`\n=== CLASSES USED BUT UNSTYLED (${unstyled.length}) ===\n  ` + unstyled.join('\n  '));
    }
    // Soft-fail: many will be legit Tailwind-style utility classes or state mods.
    // Flip to expect().toEqual([]) once the known-legitimate set is filtered above.
  });
});
