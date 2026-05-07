// ========== Right Drawer ==========
// Generic right-side drawer with three states: hidden, collapsed, expanded.
// Content is set programmatically via setContent().

export type DrawerState = 'hidden' | 'collapsed' | 'expanded';

let currentState: DrawerState = 'hidden';
const stateChangeListeners = new Set<(state: DrawerState) => void>();

// DOM refs
const drawer = document.getElementById('right-drawer') as HTMLElement;
const expandBtn = document.getElementById('right-drawer-expand') as HTMLButtonElement;
const collapseBtn = document.getElementById('right-drawer-collapse') as HTMLButtonElement;
const hideBtn = document.getElementById('right-drawer-hide') as HTMLButtonElement;
const titleEl = document.getElementById('right-drawer-title') as HTMLHeadingElement;
const bodyEl = document.getElementById('right-drawer-body') as HTMLDivElement;

function applyState(state: DrawerState) {
  currentState = state;
  drawer.classList.remove('right-drawer--hidden', 'right-drawer--collapsed', 'right-drawer--expanded');
  drawer.classList.add(`right-drawer--${state}`);
  for (const cb of stateChangeListeners) cb(state);
}

// ========== Public API ==========

/** Get the current drawer state. */
export function getDrawerState(): DrawerState { return currentState; }

/** Show the drawer in expanded state. */
export function expandDrawer() { applyState('expanded'); }

/** Collapse the drawer to a narrow strip. */
export function collapseDrawer() { applyState('collapsed'); }

/** Hide the drawer completely (off-screen). */
export function hideDrawer() { applyState('hidden'); }

/** Toggle between expanded and collapsed. If hidden, expands. */
export function toggleDrawer() {
  if (currentState === 'expanded') applyState('collapsed');
  else applyState('expanded');
}

/** Set the drawer title. */
export function setDrawerTitle(title: string) {
  titleEl.textContent = title;
}

/** Set the drawer body content. Pass an element or HTML string. */
export function setDrawerContent(content: HTMLElement | string) {
  bodyEl.innerHTML = '';
  if (typeof content === 'string') {
    bodyEl.innerHTML = content;
  } else {
    bodyEl.appendChild(content);
  }
}

/** Get the drawer body element for direct DOM manipulation. */
export function getDrawerBody(): HTMLDivElement { return bodyEl; }

/** Register a callback for state changes. Returns unsubscribe function. */
export function onDrawerStateChange(cb: (state: DrawerState) => void): () => void {
  stateChangeListeners.add(cb);
  return () => { stateChangeListeners.delete(cb); };
}

// ========== Init ==========

export function initRightDrawer() {
  if (!drawer) return;

  expandBtn.addEventListener('click', expandDrawer);
  collapseBtn.addEventListener('click', collapseDrawer);
  hideBtn.addEventListener('click', hideDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentState !== 'hidden') hideDrawer();
  });
}
