// ========== Store Panel (embedded <webview> cart) ==========
//
// The store cart is a real in-DOM <webview> living inside the #store-panel
// container (see index.html). Because it's a DOM element — not a native overlay
// composited on top of the window — it's clipped, rounded, and bordered by its
// container and z-orders with the rest of the app: a genuine UX panel.
//
// This module owns everything about the panel view: mounting/unmounting the
// <webview> (recreated per store so each binds its own session partition, which
// is immutable once attached), navigation, zoom, horizontal-scroll injection,
// and a native CSS splitter for resize. The main process only pre-warms the
// session, polls auth, and drives the scripted checkout (it needs the guest's
// webContents id, which we register on attach via storePanelAttach).

const STORE_LABELS: Record<string, string> = { qobuz: 'Qobuz', beatport: 'Beatport' };

const MIN_WIDTH = 360;
const MAX_RATIO = 0.65;      // panel may take at most this fraction of the window
const DEFAULT_RATIO = 0.45;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;
const LS_WIDTH = 'candybar:store-panel-width';
const LS_ZOOM = 'candybar:store-panel-zoom';

/** Minimal shape of Electron's <webview> tag — declared locally so the renderer
 *  doesn't need to depend on electron's types. */
interface StoreWebview extends HTMLElement {
  src: string;
  getWebContentsId(): number;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  setZoomFactor(factor: number): void;
  executeJavaScript(code: string): Promise<unknown>;
  getURL(): string;
  loadURL(url: string): Promise<void>;
}

// Re-assert horizontal scrolling: store pages (Qobuz) pin `overflow-x: hidden`
// on <body>, often inline-!important, which clips content wider than the panel
// (and everything once zoomed in). Force it back inline via JS after each load
// and a couple of times more to win against the page's own post-load scripts.
const HSCROLL_SCRIPT = `(() => { const f = () => { for (const el of [document.documentElement, document.body]) {
    if (el) el.style.setProperty('overflow-x', 'auto', 'important');
  } }; f(); setTimeout(f, 400); setTimeout(f, 1200); })();`;

let panelEl: HTMLElement | null = null;
let wrapEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let zoomLabelEl: HTMLElement | null = null;
let backBtn: HTMLButtonElement | null = null;
let fwdBtn: HTMLButtonElement | null = null;
let resizeEl: HTMLElement | null = null;

let webview: StoreWebview | null = null;
let currentPartition: string | null = null;
let panelOpen = false;
let dragging = false;

let panelWidth = readNumber(LS_WIDTH, Math.round(window.innerWidth * DEFAULT_RATIO));
let zoomFactor = readNumber(LS_ZOOM, 1);

function readNumber(key: string, fallback: number): number {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function clampWidth(w: number): number {
  const max = Math.floor(window.innerWidth * MAX_RATIO);
  return Math.max(MIN_WIDTH, Math.min(w, Math.max(MIN_WIDTH, max)));
}

function setWidth(w: number, persist = true): void {
  panelWidth = clampWidth(w);
  document.documentElement.style.setProperty('--store-panel-width', `${panelWidth}px`);
  if (persist) localStorage.setItem(LS_WIDTH, String(panelWidth));
}

function setZoomLabel(): void {
  if (zoomLabelEl) zoomLabelEl.textContent = `${Math.round(zoomFactor * 100)}%`;
}

function applyZoom(): void {
  try { webview?.setZoomFactor(zoomFactor); } catch { /* guest not ready */ }
  setZoomLabel();
}

function zoom(direction: 'in' | 'out' | 'reset'): void {
  if (direction === 'in') zoomFactor = Math.min(ZOOM_MAX, +(zoomFactor + ZOOM_STEP).toFixed(2));
  else if (direction === 'out') zoomFactor = Math.max(ZOOM_MIN, +(zoomFactor - ZOOM_STEP).toFixed(2));
  else zoomFactor = 1;
  localStorage.setItem(LS_ZOOM, String(zoomFactor));
  applyZoom();
}

function updateNavState(): void {
  if (backBtn) backBtn.disabled = !webview?.canGoBack();
  if (fwdBtn) fwdBtn.disabled = !webview?.canGoForward();
}

function injectHScroll(): void {
  webview?.executeJavaScript(HSCROLL_SCRIPT).catch(() => { /* page may navigate mid-eval */ });
}

/** Mount (or navigate) the <webview>. The partition is fixed at attach time, so
 *  a store switch tears the element down and builds a fresh one. */
function mountWebview(url: string, partition: string): void {
  if (webview && currentPartition === partition) {
    if (webview.getURL() !== url) void webview.loadURL(url).catch(() => { /* transient */ });
    return;
  }
  destroyWebview();
  if (!wrapEl) return;

  const wv = document.createElement('webview') as unknown as StoreWebview;
  wv.id = 'store-panel-webview';
  wv.className = 'store-panel-webview';
  wv.setAttribute('partition', partition);
  wv.setAttribute('allowpopups', ''); // let 3DS/SCA + login popups open (hardened in main)
  wv.setAttribute('src', url);
  currentPartition = partition;

  wv.addEventListener('dom-ready', () => {
    // Register the guest's webContents id so main can drive scripted checkout.
    try { void window.candybar.storePanelAttach(wv.getWebContentsId()); } catch { /* not attached */ }
    applyZoom();
    injectHScroll();
    updateNavState();
  });

  const onNavigate = (e: Event): void => {
    const url = (e as unknown as { url?: string }).url ?? wv.getURL();
    void window.candybar.storePanelNav(url);
    injectHScroll();
    updateNavState();
  };
  wv.addEventListener('did-navigate', onNavigate);
  wv.addEventListener('did-navigate-in-page', onNavigate);
  wv.addEventListener('did-stop-loading', updateNavState);

  wrapEl.appendChild(wv);
  webview = wv;
}

function destroyWebview(): void {
  if (webview) { webview.remove(); webview = null; }
  currentPartition = null;
  void window.candybar.storePanelAttach(null);
}

function openPanel(state: { store?: string | null; url?: string; partition?: string }): void {
  panelOpen = true;
  const root = document.documentElement;
  setWidth(panelWidth, false); // publish the current width to CSS without re-persisting
  root.classList.add('store-panel-open');
  if (panelEl) panelEl.hidden = false;
  if (titleEl) titleEl.textContent = STORE_LABELS[state.store ?? ''] ?? 'Store';
  setZoomLabel();
  if (state.url && state.partition) mountWebview(state.url, state.partition);
}

function closePanel(): void {
  panelOpen = false;
  destroyWebview();
  if (panelEl) panelEl.hidden = true;
  const root = document.documentElement;
  root.classList.remove('store-panel-open');
  root.style.removeProperty('--store-panel-width');
  if (dragging) endResize();
}

// ----- Resize splitter -----
// The <webview> guest swallows pointer events, so during a drag we set
// `pointer-events: none` on it (via body.store-panel-resizing in styles.css) and
// capture the pointer on the handle — both keep pointermove/up flowing to us.

function beginResize(e: PointerEvent): void {
  e.preventDefault();
  dragging = true;
  document.body.classList.add('store-panel-resizing');
  try { resizeEl?.setPointerCapture(e.pointerId); } catch { /* older webview */ }
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', endResize);
  window.addEventListener('pointercancel', endResize);
}

function onResizeMove(e: PointerEvent): void {
  if (!dragging) return;
  setWidth(window.innerWidth - e.clientX);
}

function endResize(): void {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('store-panel-resizing');
  window.removeEventListener('pointermove', onResizeMove);
  window.removeEventListener('pointerup', endResize);
  window.removeEventListener('pointercancel', endResize);
}

export function initStorePanel(): void {
  panelEl = document.getElementById('store-panel');
  wrapEl = document.getElementById('store-panel-webview-wrap');
  titleEl = document.getElementById('store-panel-title');
  zoomLabelEl = document.getElementById('store-panel-zoom-level');
  backBtn = document.getElementById('store-panel-back') as HTMLButtonElement | null;
  fwdBtn = document.getElementById('store-panel-forward') as HTMLButtonElement | null;
  resizeEl = document.getElementById('store-panel-resize');

  backBtn?.addEventListener('click', () => webview?.goBack());
  fwdBtn?.addEventListener('click', () => webview?.goForward());
  document.getElementById('store-panel-close')?.addEventListener('click', () => window.candybar.storePanelClose());
  document.getElementById('store-panel-zoom-in')?.addEventListener('click', () => zoom('in'));
  document.getElementById('store-panel-zoom-out')?.addEventListener('click', () => zoom('out'));
  zoomLabelEl?.addEventListener('click', () => zoom('reset'));
  resizeEl?.addEventListener('pointerdown', beginResize);

  // Keep the panel width valid if the window shrinks below the current width.
  // persist=false: this only re-clamps the live CSS width to the new window; it
  // must NOT overwrite the user's saved width preference (clampWidth only ever
  // narrows, so persisting here would permanently shrink the stored value).
  window.addEventListener('resize', () => { if (panelOpen) setWidth(panelWidth, false); });

  window.candybar.onStorePanelState((state) => {
    if (!state.open) { closePanel(); return; }
    openPanel(state);
  });

  // Keyboard zoom while the cart is open (Cmd/Ctrl +/-/0), matching browser conventions.
  window.addEventListener('keydown', (e) => {
    if (!panelOpen || !(e.metaKey || e.ctrlKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoom('in'); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom('out'); }
    else if (e.key === '0') { e.preventDefault(); zoom('reset'); }
  });
}
