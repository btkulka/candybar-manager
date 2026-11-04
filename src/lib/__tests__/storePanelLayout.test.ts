import { describe, it, expect } from 'vitest';
import { storePanelLayout, STORE_PANEL_MIN_WIDTH, APP_CONTENT_MIN_WIDTH } from '../storePanelLayout';

describe('storePanelLayout', () => {
  const sidebar = 232;

  it('keeps the chosen width when there is room beside the app', () => {
    expect(storePanelLayout(600, 1440, sidebar)).toEqual({ width: 600, overlay: false });
  });

  it('leaves the app its minimum column', () => {
    // 1100 wide: 1100 - 232 - 560 = 308 < 360, so not beside at all.
    const wide = storePanelLayout(900, 1440, sidebar);
    expect(1440 - sidebar - wide.width).toBeGreaterThanOrEqual(APP_CONTENT_MIN_WIDTH);
    expect(wide.overlay).toBe(false);
  });

  it('floats over the app when the window is too narrow for both', () => {
    const narrow = storePanelLayout(616, 1100, sidebar);
    expect(narrow.overlay).toBe(true);
    expect(narrow.width).toBe(616);
    expect(storePanelLayout(900, 860, sidebar)).toEqual({ width: 559, overlay: true });
  });

  it('never goes below the minimum width', () => {
    expect(storePanelLayout(100, 1440, sidebar).width).toBe(STORE_PANEL_MIN_WIDTH);
  });
});
