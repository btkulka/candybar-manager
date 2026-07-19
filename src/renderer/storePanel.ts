// ========== Store Panel Chrome (embedded qobuz/beatport cart) ==========
//
// The embedded store cart is a native WebContentsView the main process stacks
// over the right side of the window (see main.ts openStorePanel). The app's own
// content view is sized to the visible left column, so its right edge lands
// exactly on the app↔panel seam — which lets this module draw the chrome the
// renderer owns simply by anchoring to `right: 0`: a floating toolbar (back /
// forward / zoom / close) and a draggable resize handle at the seam.
//
// Resize is driven by the MAIN process (cursor polling) — the renderer only
// signals grab/release. That keeps a shrink-drag alive when the cursor crosses
// onto the native panel view, which otherwise swallows pointer events.

const STORE_LABELS: Record<string, string> = { qobuz: 'Qobuz', beatport: 'Beatport' };

let toolbarEl: HTMLElement | null = null;
let handleEl: HTMLElement | null = null;
let zoomLabelEl: HTMLButtonElement | null = null;
let labelEl: HTMLElement | null = null;
let panelOpen = false;
let dragging = false;

function icon(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function buildChrome(): void {
  if (toolbarEl) return;

  const toolbar = document.createElement('div');
  toolbar.className = 'store-panel-toolbar';
  toolbar.id = 'store-panel-toolbar';
  toolbar.style.display = 'none';
  toolbar.innerHTML = `
    <div class="store-panel-toolbar-left">
      <button class="btn-icon" id="store-panel-back" title="Back">${icon('<polyline points="15 18 9 12 15 6"/>')}</button>
      <button class="btn-icon" id="store-panel-forward" title="Forward">${icon('<polyline points="9 18 15 12 9 6"/>')}</button>
      <span class="store-panel-label" id="store-panel-label">Store</span>
    </div>
    <div class="store-panel-toolbar-right">
      <button class="btn-icon" id="store-panel-zoom-out" title="Zoom out">${icon('<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/><line x1="8" y1="11" x2="14" y2="11"/>')}</button>
      <button class="store-panel-zoom-level" id="store-panel-zoom-level" title="Reset zoom">100%</button>
      <button class="btn-icon" id="store-panel-zoom-in" title="Zoom in">${icon('<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/>')}</button>
      <button class="btn-icon" id="store-panel-close" title="Close cart">${icon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}</button>
    </div>`;
  document.body.appendChild(toolbar);

  const handle = document.createElement('div');
  handle.className = 'store-panel-resize-handle';
  handle.id = 'store-panel-resize-handle';
  handle.title = 'Drag to resize the cart panel';
  handle.style.display = 'none';
  document.body.appendChild(handle);

  toolbarEl = toolbar;
  handleEl = handle;
  labelEl = toolbar.querySelector('#store-panel-label');
  zoomLabelEl = toolbar.querySelector('#store-panel-zoom-level');

  // Navigation / close
  toolbar.querySelector('#store-panel-back')?.addEventListener('click', () => window.candybar.storePanelBack());
  toolbar.querySelector('#store-panel-forward')?.addEventListener('click', () => window.candybar.storePanelForward());
  toolbar.querySelector('#store-panel-close')?.addEventListener('click', () => window.candybar.storePanelClose());

  // Zoom
  toolbar.querySelector('#store-panel-zoom-in')?.addEventListener('click', () => zoom('in'));
  toolbar.querySelector('#store-panel-zoom-out')?.addEventListener('click', () => zoom('out'));
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
      if (toolbarEl) toolbarEl.style.display = 'none';
      if (handleEl) handleEl.style.display = 'none';
      // Release the left-column reflow so the app fills the window again.
      root.classList.remove('store-panel-open');
      root.style.removeProperty('--store-panel-width');
      // A close mid-drag ends the drag from the main side; clear local state.
      if (dragging) { dragging = false; document.body.classList.remove('store-panel-resizing'); }
      return;
    }

    // The native panel overlays the right edge and the main web-contents can't
    // be clipped from the main process, so reflow the whole app into the visible
    // left column: `--store-panel-width` shifts app content + the chrome (which
    // is position:fixed) off the panel so both stay reachable.
    root.style.setProperty('--store-panel-width', `${state.panelWidth ?? 0}px`);
    root.classList.add('store-panel-open');

    if (labelEl) labelEl.textContent = STORE_LABELS[state.store ?? ''] ?? 'Store';
    setZoomLabel(state.zoom);
    if (toolbarEl) toolbarEl.style.display = 'flex';
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
