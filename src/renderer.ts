// Global error handlers for renderer process
window.addEventListener('error', (event) => {
  console.error('[Renderer] Uncaught error:', event.error?.message || event.message, event.error?.stack);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Renderer] Unhandled rejection:', event.reason);
});

import { setActiveTab, setValue, initNavigation, initTagEditor, initArtViewer, checkSpotifyConnection, checkSoundCloudConnection, checkStoreConnections, applyHowSteps, initConnections } from './renderer/shared';
import { initOrganize, restoreOrganizeState } from './renderer/organize';
import { initSource, setSourceCsvFile, restoreSourceSpotifyUrl, hasRestoredSourcesSession } from './renderer/source';
import { initLibrary, restoreLibraryResults, autoRefreshLibrary, showHealthSkeleton, hideHealthSkeleton } from './renderer/library';
import { initSettings, setCurrentArchivePath, setFloatingConsoleEnabled, setLibraryRootDisplay, setStoreCredentials, setRekordboxEnabled, setShowAdvancedTools, setRekordboxBackupDir } from './renderer/settings';
import { initTooltips } from './renderer/tooltips';
import { initActivity } from './renderer/activity';
import { initPlayer } from './renderer/player';
import { initVisualizer, isVisualizerEnabled, setVisualizerEnabled } from './renderer/visualizer';
import { initUsbHealth } from './renderer/usbHealth';
import { initRestore } from './renderer/restore';
import { initSpliceRecovery } from './renderer/spliceRecovery';
import { initRightDrawer } from './renderer/rightDrawer';
import { initStorePanel } from './renderer/storePanel';
import { initTour, offerTour } from './renderer/tour';
import { initSetupWizard, startFirstRunSetup, refreshSetupBadge } from './renderer/setupWizard';
import { initUpgrade } from './renderer/upgrade';
import { initClaude } from './renderer/claude';
import { initUpdates } from './renderer/updates';

// Re-export types that were previously exported from this file
export type { SuggestedAction, HealthIssue } from './renderer/shared';

// ========== Browse Buttons ==========

function initBrowseButtons() {
  const browseButtons = document.querySelectorAll('[data-browse]');
  browseButtons.forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const targetId = (button as HTMLButtonElement).dataset.browse;
      const type = (button as HTMLButtonElement).dataset.type === 'file' ? 'file' : 'dir';
      const selection = await window.candybar.selectPath(type);

      if (selection && targetId) {
        // `check-csv` was the legacy Check-tab CSV picker; Check was merged
        // into Source, so both browse targets now route to the Source tab.
        if (targetId === 'source-csv' || targetId === 'check-csv') {
          setSourceCsvFile(selection);
        } else {
          setValue(targetId, selection);
        }
      }
    });
  });
}

// ========== Config Loading ==========

async function loadConfig() {
  const [config, libraryRoot] = await Promise.all([
    window.candybar.getConfig(),
    window.candybar.getLibraryRoot()
  ]);

  setValue('organize-source', config.organizeSourceDir);

  // Settings module state
  setCurrentArchivePath(config.archivePath);
  setValue('setting-archive-path', config.archivePath);
  setValue('setting-rekordbox-xml-path', config.rekordboxXmlPath ?? '');
  setRekordboxBackupDir((config as typeof config & { rekordboxBackupDir?: string }).rekordboxBackupDir);
  setLibraryRootDisplay(libraryRoot);
  setFloatingConsoleEnabled(config.floatingConsoleEnabled ?? true);
  const rekordboxEnabled = config.rekordboxEnabled ?? true;
  setRekordboxEnabled(rekordboxEnabled);
  setShowAdvancedTools(config.showAdvancedTools ?? false);
  await setStoreCredentials(config);

  // Restore active tab. `check` was merged into `source` — redirect silently
  // so users whose last session ended on Check land on the merged tab instead
  // of a 404. If Restore or Upgrades was last active but rekordbox is disabled
  // on this machine, fall back to organize.
  if (config.activeTab) {
    let resolvedTab = config.activeTab === 'check' ? 'source' : config.activeTab;
    if ((resolvedTab === 'restore' || resolvedTab === 'upgrade') && !rekordboxEnabled) resolvedTab = 'organize';
    setActiveTab(resolvedTab);
  }

  // First launch on this machine: the setup guide, which hands over to the
  // tour. Started after the tab restore above so it can't yank the page out
  // from under either of them.
  if (!config.tutorialCompleted && !config.setupCompleted) startFirstRunSetup();
  else if (!config.tourOffered) offerTour();
  void refreshSetupBadge(config);

  // Restore persisted input (CSV path or Spotify playlist URL) into the
  // Source tab. The config keys are still `checkCsvPath` / `checkSpotifyPlaylistUrl`
  // for back-compat — they're just internal and don't warrant a migration.
  // Nothing writes them any more, so a saved Sources session (which also holds
  // SoundCloud links) is newer and wins; these only seed a first launch.
  if (!hasRestoredSourcesSession()) {
    if (config.checkSpotifyPlaylistUrl) {
      restoreSourceSpotifyUrl(config.checkSpotifyPlaylistUrl);
    } else if (config.checkCsvPath) {
      await setSourceCsvFile(config.checkCsvPath);
    }
  }

  // Restore cached scan results
  await restoreCachedResults(config);
}

async function restoreCachedResults(config: Awaited<ReturnType<typeof window.candybar.getConfig>>) {
  async function restoreOrganizeCache() {
    try {
      const organizeState = await window.candybar.getOrganizeState();
      if (organizeState && organizeState.tracks.length > 0) {
        restoreOrganizeState(organizeState);
      }
    } catch { /* cache miss, ignore */ }
  }

  async function restoreHealthCache() {
    showHealthSkeleton();
    try {
      const healthResponse = await window.candybar.scanLibraryHealth(true, true);
      if (healthResponse.result && healthResponse.fromCache) {
        await restoreLibraryResults(healthResponse.result, config.healthTabFilter);
      } else {
        hideHealthSkeleton();
      }
    } catch { hideHealthSkeleton(); /* cache miss, ignore */ }
  }

  // Restore caches in parallel. Sourcing has no cache of its own — the merged
  // flow re-runs its pipeline each time the user hits Run, relying on the
  // library-check on-disk cache under the hood for fast phase-1 repeats.
  await Promise.all([restoreOrganizeCache(), restoreHealthCache()]);

  // Always run a write-through background scan to keep health data fresh.
  // It loads its own result into the Library view, and a missing library
  // drive shows the Library page's banner rather than an error toast.
  void autoRefreshLibrary({ silent: true });
}

// ========== Initialize ==========

function safeInit(name: string, fn: () => void) {
  try { fn(); } catch (err) {
    console.error(`[Renderer] ${name} failed:`, err);
  }
}

function initApp() {
  safeInit('initTooltips', initTooltips);
  safeInit('initNavigation', initNavigation);
  safeInit('initTagEditor', initTagEditor);
  safeInit('initArtViewer', initArtViewer);
  safeInit('initOrganize', initOrganize);
  safeInit('initSource', initSource);
  safeInit('initUpgrade', initUpgrade);
  safeInit('initLibrary', initLibrary);
  safeInit('initSettings', initSettings);
  safeInit('initBrowseButtons', initBrowseButtons);
  safeInit('initActivity', initActivity);
  safeInit('initPlayer', initPlayer);
  safeInit('initVisualizer', () => {
    initVisualizer();
    const toggle = document.getElementById('setting-visualizer') as HTMLInputElement | null;
    if (toggle) {
      toggle.checked = isVisualizerEnabled();
      toggle.addEventListener('change', () => setVisualizerEnabled(toggle.checked));
    }
  });
  safeInit('initUsbHealth', initUsbHealth);
  safeInit('initRestore', initRestore);
  safeInit('initSpliceRecovery', initSpliceRecovery);
  safeInit('initRightDrawer', initRightDrawer);
  safeInit('initStorePanel', initStorePanel);
  safeInit('initTour', initTour);
  safeInit('initSetupWizard', initSetupWizard);
  safeInit('initClaude', initClaude);
  safeInit('applyHowSteps', () => applyHowSteps());
  safeInit('initConnections', initConnections);
  safeInit('initUpdates', initUpdates);

  loadConfig().catch((err) => console.error('[Renderer] loadConfig failed:', err));
  checkSpotifyConnection(false).catch((err) => console.error('[Renderer] checkSpotifyConnection failed:', err));
  checkSoundCloudConnection(false).catch((err) => console.error('[Renderer] checkSoundCloudConnection failed:', err));
  checkStoreConnections(false).catch((err) => console.error('[Renderer] checkStoreConnections failed:', err));

  window.candybar.onStorePanelAuth((auth) => {
    if (auth.loggedIn) {
      checkStoreConnections(false).catch((err) => console.error('[Renderer] checkStoreConnections (panel auth) failed:', err));
    }
  });

  window.addEventListener('store-account-changed', () => {
    checkStoreConnections(false).catch((err) => console.error('[Renderer] checkStoreConnections (account changed) failed:', err));
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
