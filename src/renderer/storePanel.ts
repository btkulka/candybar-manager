// ========== Store Panel Chrome (embedded qobuz/beatport cart) ==========
//
// The embedded store cart is a native WebContentsView the main process docks on
// the right side of the window, below the app topbar (see main.ts openStorePanel
// / layoutStorePanel). The controls (back / forward / zoom / close) live in the
// app's own topbar — the `#store-panel-controls` group in index.html — so they
// sit outside the panel, within the app chrome. The only thing drawn here is a
// draggable resize handle at the app↔panel seam.
//
// Resize is driven by the MAIN process (cursor polling) — the renderer only
// signals grab/release. That keeps a shrink-drag alive when the cursor crosses
// onto the native panel view, which otherwise swallows pointer events.

const STORE_LABELS: Record<string, string> = { qobuz: 'Qobuz', beatport: 'Beatport' };

let controlsEl: HTMLElement | null = null; // the topbar control group (index.html)
let handleEl: HTMLElement | null = null;   // the resize handle (built here)
let zoomLabelEl: HTMLElement | null = null;
let labelEl: HTMLElement | null = null;
let panelOpen = false;
let dragging = false;

function buildChrome(): void {
  if (handleEl) return;

  // The resize handle is an overlay anchored to the seam, so it's built here.
  const handle = document.createElement('div');
  handle.className = 'store-panel-resize-handle';
  handle.id = 'store-panel-resize-handle';
  handle.title = 'Drag to resize the cart panel';
  handle.style.display = 'none';
  document.body.appendChild(handle);
  handleEl = handle;

  // The toolbar controls are declared in the app topbar (index.html); just wire
  // them up here so zoom/close/nav land in the app chrome, not a floating bar.
  controlsEl = document.getElementById('store-panel-controls');
  labelEl = document.getElementById('store-panel-label');
  zoomLabelEl = document.getElementById('store-panel-zoom-level');

  document.getElementById('store-panel-back')?.addEventListener('click', () => window.candybar.storePanelBack());
  document.getElementById('store-panel-forward')?.addEventListener('click', () => window.candybar.storePanelForward());
  document.getElementById('store-panel-close')?.addEventListener('click', () => window.candybar.storePanelClose());
  document.getElementById('store-panel-zoom-in')?.addEventListener('click', () => zoom('in'));
  document.getElementById('store-panel-zoom-out')?.addEventListener('click', () => zoom('out'));
  zoomLabelEl?.addEventListener('click', () => zoom('reset'));

  // Resize handle drag. The release is caught at the window level (not on the
  // handle) because a shrink-drag pulls the cursor off the handle before the
  // button comes up; if the cursor is over the native panel at release, the
  // main process ends the drag instead (see the `resizing` flag below).
  handle.addEventListener('pointerdown', onHandleDown);
  window.addEventListener('pointerup', onHandleUp);
  window.addEventListener('pointercancel', onHandleUp);
}

async function zoom(direction: 'in' | 'out' | 'reset'): Promise<void> {
  const { zoom: factor } = await window.candybar.storePanelZoom(direction);
  setZoomLabel(factor);
}

function setZoomLabel(factor: number): void {
  if (zoomLabelEl) zoomLabelEl.textContent = `${Math.round(factor * 100)}%`;
}

function onHandleDown(e: PointerEvent): void {
  e.preventDefault();
  dragging = true;
  document.body.classList.add('store-panel-resizing');
  window.candybar.storePanelResizeBegin();
}

function onHandleUp(): void {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('store-panel-resizing');
  window.candybar.storePanelResizeEnd();
}

export function initStorePanel(): void {
  buildChrome();

  window.candybar.onStorePanelState((state) => {
    panelOpen = state.open;
    const root = document.documentElement;

    if (!state.open) {
      if (controlsEl) controlsEl.style.display = 'none';
      if (handleEl) handleEl.style.display = 'none';
      // Release the reflow so the app content fills the window again.
      root.classList.remove('store-panel-open');
      root.style.removeProperty('--store-panel-width');
      // A close mid-drag ends the drag from the main side; clear local state.
      if (dragging) { dragging = false; document.body.classList.remove('store-panel-resizing'); }
      return;
    }

    // The native panel overlays the right column below the topbar and the main
    // web-contents can't be clipped from the main process, so reflow the app
    // content into the visible left column. `--store-panel-width` also anchors
    // the resize handle to the seam and reserves room in the topbar.
    root.style.setProperty('--store-panel-width', `${state.panelWidth ?? 0}px`);
    root.classList.add('store-panel-open');

    if (labelEl) labelEl.textContent = STORE_LABELS[state.store ?? ''] ?? 'Store';
    setZoomLabel(state.zoom);
    if (controlsEl) controlsEl.style.display = 'flex';
    if (handleEl) handleEl.style.display = 'block';

    // `resizing` is the authoritative drag flag from main — it ends the drag
    // even when the pointerup was swallowed by the native panel view.
    document.body.classList.toggle('store-panel-resizing', state.resizing);
    if (!state.resizing && dragging) dragging = false;
  });

  // Keyboard zoom while the cart is open (Cmd/Ctrl +/-/0), matching browser conventions.
  window.addEventListener('keydown', (e) => {
    if (!panelOpen || !(e.metaKey || e.ctrlKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoom('in'); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom('out'); }
    else if (e.key === '0') { e.preventDefault(); zoom('reset'); }
  });
}
