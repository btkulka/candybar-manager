// ========== Store Panel (embedded <webview> cart) ==========
//
// The store cart is a real in-DOM <webview> living inside the #store-panel
// container (see index.html). Because it's a DOM element — not a native overlay
// composited on top of the window — it's clipped, rounded, and bordered by its
// container and z-orders with the rest of the app: a genuine UX panel.
//
// This module owns everything about the panel view: mounting/unmounting the
// <webview> (recreated per store so each binds its own session partition, which
// is immutable once attached), navigation, reload, loading and error states,
// zoom, horizontal-scroll injection, and a native CSS splitter for resize. The
// main process only polls auth and drives the scripted checkout (it needs the
// guest's webContents id, which we register on attach via storePanelAttach).

import { storePanelLayout } from '../lib/storePanelLayout';
import { isStoreSignInUrl } from '../lib/mainGuards';

const STORE_LABELS: Record<string, string> = { qobuz: 'Qobuz', beatport: 'Beatport' };

const DEFAULT_RATIO = 0.45;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;
const LS_WIDTH = 'candybar:store-panel-width';
// Zoom is remembered per store (Beatport and Qobuz suit different sizes); the
// old shared value is each store's starting point.
const LS_ZOOM_SHARED = 'candybar:store-panel-zoom';
const zoomKey = (store: string) => `${LS_ZOOM_SHARED}:${store}`;

/** Qobuz's desktop pages are a fixed 1080px wide, but it serves a real phone
 *  layout (menu button, full-width pages) to a phone browser, and the panel is
 *  phone-width. Only this <webview> asks as one: the hidden pages cart adds run
 *  in keep the desktop agent, whose pages they parse. */
function phoneUserAgent(): string {
  const major = navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '142';
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
}
const PANEL_USER_AGENT: Record<string, (() => string) | undefined> = { qobuz: phoneUserAgent };

/** Minimal shape of Electron's <webview> tag — declared locally so the renderer
 *  doesn't need to depend on electron's types. */
interface StoreWebview extends HTMLElement {
  src: string;
  getWebContentsId(): number;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  reload(): void;
  setZoomFactor(factor: number): void;
  executeJavaScript(code: string): Promise<unknown>;
  getURL(): string;
  clearHistory(): void;
  loadURL(url: string, options?: { userAgent?: string }): Promise<void>;
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
let progressEl: HTMLElement | null = null;
let noticeEl: HTMLElement | null = null;
let errorEl: HTMLElement | null = null;
let errorTextEl: HTMLElement | null = null;

let webview: StoreWebview | null = null;
let currentPartition: string | null = null;
let currentStore = '';
let panelOpen = false;
let dragging = false;
/** The URL last reported to main: a load fires both did-navigate and
 *  did-navigate-in-page for the same address. */
let lastReportedUrl = '';
/** The page that failed, so Try again loads it rather than the last good one. */
let failedUrl = '';

/** The width the user chose by dragging, or null before they ever have. */
let savedWidth = readNumber(LS_WIDTH);
let zoomFactor = 1;

function readNumber(key: string): number | null {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** Until the user drags, a share of the window as it is now — not as it was
 *  when this module loaded, before the window maximized. */
function desiredWidth(): number {
  return savedWidth ?? Math.round(window.innerWidth * DEFAULT_RATIO);
}

/** Lay the panel out at `desired` (clamped), beside the app or over it, and
 *  publish the width to CSS. Returns the width used. */
function applyWidth(desired: number): number {
  const appLeft = document.querySelector('.app-main')?.getBoundingClientRect().left ?? 0;
  const { width, overlay } = storePanelLayout(desired, window.innerWidth, appLeft);
  const root = document.documentElement;
  root.style.setProperty('--store-panel-width', `${width}px`);
  root.classList.toggle('store-panel-overlay', overlay);
  return width;
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
  if (currentStore) localStorage.setItem(zoomKey(currentStore), String(zoomFactor));
  applyZoom();
}

function updateNavState(): void {
  if (backBtn) backBtn.disabled = !webview?.canGoBack();
  if (fwdBtn) fwdBtn.disabled = !webview?.canGoForward();
}

function injectHScroll(): void {
  webview?.executeJavaScript(HSCROLL_SCRIPT).catch(() => { /* page may navigate mid-eval */ });
}

function setLoading(loading: boolean): void {
  if (progressEl) progressEl.hidden = !loading;
}

/** A signed-out cart lands on the store's sign-in page, inside the panel. */
function updateSignInNotice(url: string): void {
  if (!noticeEl) return;
  const show = isStoreSignInUrl(url);
  noticeEl.hidden = !show;
  if (show) noticeEl.textContent = `Sign in to ${STORE_LABELS[currentStore] ?? 'the store'} below. Track Lab picks it up as soon as you're in.`;
}

function showError(description: string, url: string): void {
  failedUrl = url;
  if (errorTextEl) {
    errorTextEl.textContent = `${STORE_LABELS[currentStore] ?? 'The store'} didn't answer (${description || 'no response'}). Check your connection, then try again.`;
  }
  if (errorEl) errorEl.hidden = false;
}

function hideError(): void {
  failedUrl = '';
  if (errorEl) errorEl.hidden = true;
}

function retry(): void {
  const url = failedUrl;
  hideError();
  if (!webview) return;
  if (url) void webview.loadURL(url).catch(() => { /* reported by did-fail-load */ });
  else webview.reload();
}

/** Mount (or navigate) the <webview>. The partition is fixed at attach time, so
 *  a store switch tears the element down and builds a fresh one. */
function mountWebview(url: string, partition: string, store: string): void {
  const userAgent = PANEL_USER_AGENT[store]?.();
  if (webview && currentPartition === partition) {
    if (webview.getURL() !== url) void webview.loadURL(url, userAgent ? { userAgent } : undefined).catch(() => { /* transient */ });
    return;
  }
  destroyWebview();
  if (!wrapEl) return;

  const wv = document.createElement('webview') as unknown as StoreWebview;
  wv.id = 'store-panel-webview';
  wv.className = 'store-panel-webview';
  wv.setAttribute('partition', partition);
  wv.setAttribute('allowpopups', ''); // let 3DS/SCA + login popups open (hardened in main)
  if (userAgent) wv.setAttribute('useragent', userAgent);
  // The first load goes out before the useragent attribute takes hold (Qobuz
  // then serves its desktop page), so a store with its own agent starts blank
  // and loads the real page with that agent once the guest is up.
  let pendingUrl = userAgent ? url : '';
  let startedBlank = !!userAgent;
  wv.setAttribute('src', userAgent ? 'about:blank' : url);
  currentPartition = partition;

  wv.addEventListener('dom-ready', () => {
    if (pendingUrl) {
      const first = pendingUrl;
      pendingUrl = '';
      void wv.loadURL(first, { userAgent }).catch(() => { /* reported by did-fail-load */ });
    }
    // Register the guest's webContents id so main can drive scripted checkout.
    try { void window.candybar.storePanelAttach(wv.getWebContentsId()); } catch { /* not attached */ }
    applyZoom();
    injectHScroll();
    updateNavState();
  });

  const onNavigate = (e: Event): void => {
    const navUrl = (e as unknown as { url?: string }).url ?? wv.getURL();
    if (navUrl === 'about:blank') return;
    // The blank start page isn't somewhere Back should go.
    if (startedBlank) {
      startedBlank = false;
      try { wv.clearHistory(); } catch { /* not attached */ }
    }
    if (navUrl !== lastReportedUrl) {
      lastReportedUrl = navUrl;
      void window.candybar.storePanelNav(navUrl);
    }
    updateSignInNotice(navUrl);
    injectHScroll();
    updateNavState();
  };
  wv.addEventListener('did-navigate', onNavigate);
  wv.addEventListener('did-navigate-in-page', onNavigate);
  wv.addEventListener('did-start-loading', () => {
    setLoading(true);
    hideError();
  });
  wv.addEventListener('did-stop-loading', () => {
    setLoading(false);
    updateNavState();
  });
  wv.addEventListener('did-fail-load', (e: Event) => {
    const ev = e as unknown as { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
    // -3 is an aborted load: a redirect or a newer navigation took its place.
    if (!ev.isMainFrame || ev.errorCode === -3) return;
    showError(ev.errorDescription, ev.validatedURL);
  });

  wrapEl.appendChild(wv);
  webview = wv;
}

function destroyWebview(): void {
  if (webview) { webview.remove(); webview = null; }
  currentPartition = null;
  lastReportedUrl = '';
  setLoading(false);
  hideError();
  if (noticeEl) noticeEl.hidden = true;
  void window.candybar.storePanelAttach(null);
}

function openPanel(state: { store?: string | null; url?: string; partition?: string }): void {
  panelOpen = true;
  const store = state.store ?? '';
  if (store !== currentStore) {
    currentStore = store;
    zoomFactor = readNumber(zoomKey(store)) ?? readNumber(LS_ZOOM_SHARED) ?? 1;
  }
  applyWidth(desiredWidth());
  document.documentElement.classList.add('store-panel-open');
  if (panelEl) panelEl.hidden = false;
  if (titleEl) titleEl.textContent = STORE_LABELS[store] ?? 'Store';
  setZoomLabel();
  if (state.url && state.partition) mountWebview(state.url, state.partition, store);
}

function closePanel(): void {
  panelOpen = false;
  destroyWebview();
  if (panelEl) panelEl.hidden = true;
  const root = document.documentElement;
  root.classList.remove('store-panel-open', 'store-panel-overlay');
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
  savedWidth = applyWidth(window.innerWidth - e.clientX);
  localStorage.setItem(LS_WIDTH, String(savedWidth));
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
  progressEl = document.getElementById('store-panel-progress');
  noticeEl = document.getElementById('store-panel-notice');
  errorEl = document.getElementById('store-panel-error');
  errorTextEl = document.getElementById('store-panel-error-text');

  backBtn?.addEventListener('click', () => webview?.goBack());
  fwdBtn?.addEventListener('click', () => webview?.goForward());
  document.getElementById('store-panel-reload')?.addEventListener('click', retry);
  document.getElementById('store-panel-retry')?.addEventListener('click', retry);
  document.getElementById('store-panel-close')?.addEventListener('click', () => window.candybar.storePanelClose());
  document.getElementById('store-panel-zoom-in')?.addEventListener('click', () => zoom('in'));
  document.getElementById('store-panel-zoom-out')?.addEventListener('click', () => zoom('out'));
  zoomLabelEl?.addEventListener('click', () => zoom('reset'));
  resizeEl?.addEventListener('pointerdown', beginResize);

  // Re-lay the panel out for the new window size from the user's chosen width,
  // which this never overwrites: a narrower window only narrows the live width
  // (or floats the panel), and it grows back when the window does.
  window.addEventListener('resize', () => { if (panelOpen) applyWidth(desiredWidth()); });

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
