// How wide the store panel is, and whether it sits beside the app or over it.
//
// Beside the app (the default), the app's content column reflows into what's
// left, so the panel may only take what keeps that column usable. In a window
// too narrow for both, squeezing the app to a sliver broke its layout (the buy
// bar ran off the edge), so the panel floats over the content instead.

export const STORE_PANEL_MIN_WIDTH = 360;
/** The panel never takes more than this share of the window. */
export const STORE_PANEL_MAX_RATIO = 0.65;
/** What the app's content column keeps when the panel sits beside it. */
export const APP_CONTENT_MIN_WIDTH = 560;

export function storePanelLayout(
  desired: number,
  windowWidth: number,
  appLeft: number
): { width: number; overlay: boolean } {
  const clamp = (w: number, max: number) => Math.round(Math.max(STORE_PANEL_MIN_WIDTH, Math.min(w, max)));
  const ratioMax = Math.floor(windowWidth * STORE_PANEL_MAX_RATIO);
  const beside = windowWidth - appLeft - APP_CONTENT_MIN_WIDTH;
  if (beside >= STORE_PANEL_MIN_WIDTH) {
    return { width: clamp(desired, Math.min(ratioMax, beside)), overlay: false };
  }
  return { width: clamp(desired, Math.min(ratioMax, windowWidth - appLeft)), overlay: true };
}
