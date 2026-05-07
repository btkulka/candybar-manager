import type { AlbumArtMissingTrack, UpdateTagsParams, MusicSearchResult, AlbumArtSuggestion } from './shared';
import { showToast, setStatus, escapeHtml, icons, updateTrackTagsWithRepair } from './shared';

// ========== DOM Elements ==========

const scanAlbumArtBtn = document.getElementById('scan-album-art') as HTMLButtonElement;
const polishReviewCard = document.getElementById('polish-review-card') as HTMLDivElement;
const polishQueueCount = document.getElementById('polish-queue-count') as HTMLSpanElement;
const polishTrackRow = document.getElementById('polish-track-row') as HTMLDivElement;
const polishSuggestionsStatus = document.getElementById('polish-suggestions-status') as HTMLSpanElement;
const polishSuggestionPreview = document.getElementById('polish-suggestion-preview') as HTMLDivElement;
const polishSuggestionTitle = document.getElementById('polish-suggestion-title') as HTMLSpanElement;
const polishSuggestionArtist = document.getElementById('polish-suggestion-artist') as HTMLSpanElement;
const polishSuggestionSource = document.getElementById('polish-suggestion-source') as HTMLSpanElement;
const polishSuggestionConfidence = document.getElementById('polish-suggestion-confidence') as HTMLSpanElement;
const polishMetadataBadges = document.getElementById('polish-metadata-badges') as HTMLDivElement;
const polishSuggestionMeta = document.getElementById('polish-suggestion-meta') as HTMLDivElement;
const polishSuggestionGrid = document.getElementById('polish-suggestion-grid') as HTMLDivElement;
const polishPrevSuggestion = document.getElementById('polish-prev-suggestion') as HTMLButtonElement;
const polishNextSuggestion = document.getElementById('polish-next-suggestion') as HTMLButtonElement;
const polishApplyBtn = document.getElementById('polish-apply') as HTMLButtonElement;
const polishSkipBtn = document.getElementById('polish-skip') as HTMLButtonElement;
const polishResultsSection = document.getElementById('polish-results-section') as HTMLDivElement;
const polishUpdatedList = document.getElementById('polish-updated-list') as HTMLDivElement;
const polishSkippedList = document.getElementById('polish-skipped-list') as HTMLDivElement;
const polishProgressSection = document.getElementById('polish-progress-section') as HTMLDivElement;
const polishProgressMessage = document.getElementById('polish-progress-message') as HTMLSpanElement;
const polishProgressCount = document.getElementById('polish-progress-count') as HTMLSpanElement;
const polishProgressBar = document.getElementById('polish-progress-bar') as HTMLDivElement;

// Service status elements
const spotifyStatus = document.getElementById('spotify-status') as HTMLDivElement;
const spotifyStatusText = spotifyStatus.querySelector('.spotify-status-text') as HTMLSpanElement;
const soundcloudStatus = document.getElementById('soundcloud-status') as HTMLDivElement;
const soundcloudStatusText = soundcloudStatus.querySelector('.soundcloud-status-text') as HTMLSpanElement;

// ========== State ==========

let polishQueue: AlbumArtMissingTrack[] = [];
let polishIndex = 0;
let polishSuggestions: AlbumArtSuggestion[] = [];
let polishSuggestionIndex = 0;
let polishApplied: AlbumArtMissingTrack[] = [];
let polishSkipped: AlbumArtMissingTrack[] = [];
let polishSearchToken = 0;
let activePolishScanId: string | null = null;

// Service status state
let spotifyCollapseTimer: ReturnType<typeof setTimeout> | null = null;
let soundcloudCollapseTimer: ReturnType<typeof setTimeout> | null = null;
let isCheckingSpotify = false;
let isCheckingSoundCloud = false;

// ========== String Similarity (Jaccard token-based) ==========

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stringSimilarity(a: string, b: string): number {
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  const tokensA = new Set(normA.split(' ').filter(Boolean));
  const tokensB = new Set(normB.split(' ').filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  tokensA.forEach((token) => {
    if (tokensB.has(token)) intersection += 1;
  });
  const union = tokensA.size + tokensB.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;
  const containsBoost = normA.includes(normB) || normB.includes(normA) ? 0.15 : 0;

  return Math.min(1, jaccard + containsBoost);
}

// ========== Suggestion Scoring ==========

function scoreSuggestion(track: AlbumArtMissingTrack, title: string, artist: string): number {
  const titleScore = stringSimilarity(track.title, title);
  const artistScore = stringSimilarity(track.artist, artist);
  const blended = titleScore * 0.7 + artistScore * 0.3;
  return Math.round(blended * 100);
}

function getSoundCloudArtwork(url: string | null): string | null {
  if (!url) return null;
  return url.replace('-large', '-t500x500');
}

type MetadataToPopulate = {
  album: boolean;
  year: boolean;
  genre: boolean;
};

function getMetadataToPopulate(
  track: AlbumArtMissingTrack,
  suggestion: AlbumArtSuggestion
): MetadataToPopulate {
  return {
    album: !track.album && !!suggestion.album,
    year: !track.year && !!suggestion.year,
    genre: !track.genre && !!suggestion.genre
  };
}

// ========== Rendering ==========

function updatePolishQueueCount() {
  if (polishQueue.length === 0) {
    polishQueueCount.textContent = '0 tracks';
    return;
  }
  const displayIndex = Math.min(polishIndex + 1, polishQueue.length);
  polishQueueCount.textContent = `${displayIndex} of ${polishQueue.length} tracks`;
}

function renderPolishSuggestionGrid() {
  polishSuggestionGrid.innerHTML = '';

  polishSuggestions.forEach((suggestion, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'polish-suggestion-thumb';
    if (index === polishSuggestionIndex) {
      button.classList.add('selected');
    }

    const img = document.createElement('img');
    img.src = suggestion.imageUrl;
    img.alt = `${suggestion.title} album art`;
    button.appendChild(img);

    button.setAttribute('data-tooltip', `${suggestion.source.toUpperCase()} • ${suggestion.confidence}%`);
    button.addEventListener('click', () => {
      polishSuggestionIndex = index;
      updatePolishSuggestionDisplay();
    });

    polishSuggestionGrid.appendChild(button);
  });
}

function setPolishSuggestionLoading(isLoading: boolean) {
  polishSuggestionPreview.classList.toggle('loading', isLoading);
  polishSuggestionGrid.classList.toggle('loading', isLoading);
  polishSuggestionMeta.classList.toggle('loading', isLoading);
  polishPrevSuggestion.disabled = isLoading || polishSuggestions.length <= 1;
  polishNextSuggestion.disabled = isLoading || polishSuggestions.length <= 1;
  polishApplyBtn.disabled = isLoading || polishSuggestions.length === 0;
}

function renderPolishTrackRow(track: AlbumArtMissingTrack) {
  const albumText = track.album ? track.album : 'Album unknown';
  polishTrackRow.innerHTML = `
    <div class="track-item">
      <div class="track-status">${icons.pending}</div>
      <div class="track-art">${icons.albumPlaceholder}</div>
      <div class="track-info">
        <div class="track-title">${escapeHtml(track.title)}</div>
        <div class="track-artist">${escapeHtml(track.artist)}</div>
        <div class="track-result">${escapeHtml(albumText)} • ${escapeHtml(track.fileName)}</div>
      </div>
    </div>
  `;
}

function updatePolishSuggestionDisplay() {
  if (polishSuggestions.length === 0) {
    polishSuggestionPreview.innerHTML = icons.albumPlaceholder;
    polishSuggestionTitle.textContent = 'No suggestions found';
    polishSuggestionArtist.textContent = '';
    polishSuggestionSource.textContent = '';
    polishSuggestionConfidence.textContent = '0%';
    polishMetadataBadges.innerHTML = '';
    polishApplyBtn.disabled = true;
    polishPrevSuggestion.disabled = true;
    polishNextSuggestion.disabled = true;
    polishSuggestionGrid.innerHTML = '';
    return;
  }

  const suggestion = polishSuggestions[polishSuggestionIndex];
  const track = polishQueue[polishIndex];
  polishSuggestionPreview.innerHTML = '';
  const img = document.createElement('img');
  img.src = suggestion.imageUrl;
  img.alt = `${suggestion.title} album art`;
  polishSuggestionPreview.appendChild(img);

  polishSuggestionTitle.textContent = suggestion.title;
  polishSuggestionArtist.textContent = suggestion.artist;
  polishSuggestionSource.textContent = suggestion.source === 'spotify' ? 'Spotify' : 'SoundCloud';
  polishSuggestionConfidence.textContent = `${suggestion.confidence}% match`;

  if (track) {
    const toPopulate = getMetadataToPopulate(track, suggestion);
    const badges: string[] = [];
    if (toPopulate.album) badges.push('<span class="meta-badge">+Album</span>');
    if (toPopulate.year) badges.push('<span class="meta-badge">+Year</span>');
    if (toPopulate.genre) badges.push('<span class="meta-badge">+Genre</span>');
    polishMetadataBadges.innerHTML = badges.join('');
  } else {
    polishMetadataBadges.innerHTML = '';
  }

  polishApplyBtn.disabled = false;
  polishPrevSuggestion.disabled = polishSuggestions.length <= 1;
  polishNextSuggestion.disabled = polishSuggestions.length <= 1;
  renderPolishSuggestionGrid();
}

function formatSearchStatus(count: number, errors: MusicSearchResult['errors']) {
  const errorSources = errors.map((e) => e.source).join(', ');
  if (count === 0 && errorSources) {
    return `No results (${errorSources} unavailable)`;
  }
  if (count === 0) return 'No results found';
  if (errorSources) return `${count} results (${errorSources} unavailable)`;
  return `${count} results`;
}

// ========== Search & Suggestions ==========

async function fetchPolishSuggestions(track: AlbumArtMissingTrack): Promise<AlbumArtSuggestion[]> {
  const query = `${track.artist} ${track.title}`.trim();
  const result = await window.candybar.searchMusic(query, ['spotify', 'soundcloud']);

  const spotifySuggestions: AlbumArtSuggestion[] = (result.spotify?.tracks ?? [])
    .slice(0, 10)
    .map((t) => ({
      source: 'spotify' as const,
      title: t.name,
      artist: t.artists.join(', '),
      imageUrl: t.album_image_url || '',
      externalUrl: t.external_url,
      confidence: scoreSuggestion(track, t.name, t.artists.join(' ')),
      album: t.album || undefined,
      year: t.release_year || undefined
    }))
    .filter((s) => s.imageUrl);

  const soundCloudSuggestions: AlbumArtSuggestion[] = (result.soundcloud?.tracks ?? [])
    .slice(0, 10)
    .map((t) => ({
      source: 'soundcloud' as const,
      title: t.title,
      artist: t.user,
      imageUrl: getSoundCloudArtwork(t.artwork_url) || '',
      externalUrl: t.permalink_url,
      confidence: scoreSuggestion(track, t.title, t.user),
      genre: t.genre || undefined
    }))
    .filter((s) => s.imageUrl);

  const combined = [...spotifySuggestions, ...soundCloudSuggestions].sort(
    (a, b) => b.confidence - a.confidence
  );

  polishSuggestionsStatus.textContent = formatSearchStatus(combined.length, result.errors);
  return combined;
}

async function renderPolishTrack() {
  const track = polishQueue[polishIndex];
  if (!track) {
    polishReviewCard.style.display = 'none';
    renderPolishResults();
    polishResultsSection.style.display = 'block';
    showToast(
      'success',
      'Polish Complete',
      `Updated ${polishApplied.length} track${polishApplied.length === 1 ? '' : 's'}, skipped ${polishSkipped.length}.`
    );
    return;
  }

  updatePolishQueueCount();
  renderPolishTrackRow(track);

  polishSuggestionsStatus.textContent = 'Searching...';
  polishSuggestions = [];
  polishSuggestionIndex = 0;
  setPolishSuggestionLoading(true);
  updatePolishSuggestionDisplay();

  const token = ++polishSearchToken;
  try {
    const suggestions = await fetchPolishSuggestions(track);
    if (token !== polishSearchToken) return;
    polishSuggestions = suggestions;
    polishSuggestionIndex = 0;
    setPolishSuggestionLoading(false);
    updatePolishSuggestionDisplay();
  } catch (err) {
    if (token !== polishSearchToken) return;
    const message = err instanceof Error ? err.message : 'Unknown error';
    polishSuggestionsStatus.textContent = 'Search failed';
    showToast('error', 'Search Failed', message);
    polishSuggestions = [];
    setPolishSuggestionLoading(false);
    updatePolishSuggestionDisplay();
  }
}

function renderPolishResults() {
  polishUpdatedList.innerHTML = '';
  polishSkippedList.innerHTML = '';

  if (polishApplied.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'polish-empty';
    empty.textContent = 'No tracks updated.';
    polishUpdatedList.appendChild(empty);
  } else {
    polishApplied.forEach((track) => {
      const item = document.createElement('div');
      item.className = 'polish-result-item';
      item.textContent = `${track.artist} — ${track.title}`;
      polishUpdatedList.appendChild(item);
    });
  }

  if (polishSkipped.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'polish-empty';
    empty.textContent = 'No tracks skipped.';
    polishSkippedList.appendChild(empty);
  } else {
    polishSkipped.forEach((track) => {
      const item = document.createElement('div');
      item.className = 'polish-result-item';
      item.textContent = `${track.artist} — ${track.title}`;
      polishSkippedList.appendChild(item);
    });
  }
}

function showPolishEmptyState(message: string) {
  polishUpdatedList.innerHTML = '';
  polishSkippedList.innerHTML = '';

  const empty = document.createElement('div');
  empty.className = 'polish-empty';
  empty.textContent = message;
  polishUpdatedList.appendChild(empty);

  const skippedEmpty = document.createElement('div');
  skippedEmpty.className = 'polish-empty';
  skippedEmpty.textContent = 'No tracks skipped.';
  polishSkippedList.appendChild(skippedEmpty);
}

async function fetchImageAsDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch album art: ${response.statusText}`);
  }
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read album art data'));
    reader.readAsDataURL(blob);
  });
}

// ========== Service Status Checks ==========

function scheduleCollapse(element: HTMLElement, timer: ReturnType<typeof setTimeout> | null): ReturnType<typeof setTimeout> {
  if (timer) clearTimeout(timer);
  return setTimeout(() => {
    element.classList.add('collapsed');
  }, 2000);
}

export async function checkSpotifyConnection(showToasts = false) {
  if (isCheckingSpotify) return;
  isCheckingSpotify = true;

  spotifyStatus.classList.remove('collapsed');
  if (spotifyCollapseTimer) clearTimeout(spotifyCollapseTimer);

  spotifyStatusText.textContent = 'Connecting';
  spotifyStatus.classList.remove('connected', 'disconnected');
  spotifyStatus.classList.add('checking');

  try {
    const connected = await window.candybar.checkSpotify();
    spotifyStatus.classList.remove('checking');

    if (connected) {
      spotifyStatus.classList.add('connected');
      spotifyStatusText.textContent = 'Connected';
      if (showToasts) {
        showToast('success', 'Spotify Connected', 'Successfully authenticated with Spotify API');
      }
    } else {
      spotifyStatus.classList.add('disconnected');
      spotifyStatusText.textContent = 'Not configured';
      if (showToasts) {
        showToast(
          'warning',
          'Spotify Not Configured',
          'Add your Client ID and Secret to the config file at ~/Library/Application Support/candybar-manager/config.json'
        );
      }
    }
    spotifyCollapseTimer = scheduleCollapse(spotifyStatus, spotifyCollapseTimer);
  } catch (err) {
    spotifyStatus.classList.remove('checking');
    spotifyStatus.classList.add('disconnected');
    spotifyStatusText.textContent = 'Error';
    if (showToasts) {
      const message = err instanceof Error ? err.message : 'Unknown error occurred';
      showToast('error', 'Spotify Connection Failed', message);
    }
    spotifyCollapseTimer = scheduleCollapse(spotifyStatus, spotifyCollapseTimer);
  } finally {
    isCheckingSpotify = false;
  }
}

export async function checkSoundCloudConnection(showToasts = false) {
  if (isCheckingSoundCloud) return;
  isCheckingSoundCloud = true;

  soundcloudStatus.classList.remove('collapsed');
  if (soundcloudCollapseTimer) clearTimeout(soundcloudCollapseTimer);

  soundcloudStatusText.textContent = 'Connecting';
  soundcloudStatus.classList.remove('connected', 'disconnected');
  soundcloudStatus.classList.add('checking');

  try {
    const connected = await window.candybar.checkSoundCloud();
    soundcloudStatus.classList.remove('checking');

    if (connected) {
      soundcloudStatus.classList.add('connected');
      soundcloudStatusText.textContent = 'Connected';
      if (showToasts) {
        showToast('success', 'SoundCloud Connected', 'Successfully connected to SoundCloud');
      }
    } else {
      soundcloudStatus.classList.add('disconnected');
      soundcloudStatusText.textContent = 'Unavailable';
      if (showToasts) {
        showToast('warning', 'SoundCloud Unavailable', 'Could not connect to SoundCloud');
      }
    }
    soundcloudCollapseTimer = scheduleCollapse(soundcloudStatus, soundcloudCollapseTimer);
  } catch (err) {
    soundcloudStatus.classList.remove('checking');
    soundcloudStatus.classList.add('disconnected');
    soundcloudStatusText.textContent = 'Error';
    if (showToasts) {
      const message = err instanceof Error ? err.message : 'Unknown error occurred';
      showToast('error', 'SoundCloud Connection Failed', message);
    }
    soundcloudCollapseTimer = scheduleCollapse(soundcloudStatus, soundcloudCollapseTimer);
  } finally {
    isCheckingSoundCloud = false;
  }
}

// ========== Init ==========

export function initPolish() {
  // Scan button
  scanAlbumArtBtn.addEventListener('click', async () => {
    if (typeof window.candybar.scanMissingAlbumArt !== 'function') {
      showToast('error', 'Scan Unavailable', 'Album art scanning is not available in this build.');
      return;
    }

    scanAlbumArtBtn.disabled = true;
    polishReviewCard.style.display = 'none';
    polishResultsSection.style.display = 'none';
    polishProgressSection.style.display = 'block';
    polishProgressMessage.textContent = 'Starting scan...';
    polishProgressCount.textContent = '0 / 0';
    polishProgressBar.style.width = '0%';
    polishApplied = [];
    polishSkipped = [];
    polishQueue = [];
    polishIndex = 0;
    activePolishScanId = null;
    updatePolishQueueCount();

    setStatus('Scanning...');
    try {
      const result = await window.candybar.scanMissingAlbumArt();
      activePolishScanId = result.id;
      polishQueue = result.tracks;
      polishProgressMessage.textContent = 'Scan complete';
      polishProgressBar.style.width = '100%';
      polishProgressCount.textContent = `${polishQueue.length} missing`;
      if (polishQueue.length === 0) {
        showToast('success', 'No Missing Art', 'All scanned tracks already have album art.');
        polishReviewCard.style.display = 'none';
        polishResultsSection.style.display = 'block';
        showPolishEmptyState('No missing album art found.');
        setStatus('Idle');
        return;
      }

      polishReviewCard.style.display = 'block';
      await renderPolishTrack();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      showToast('error', 'Scan Failed', message);
      polishProgressMessage.textContent = `Scan failed: ${message}`;
      polishProgressCount.textContent = '0 / 0';
      polishProgressBar.style.width = '0%';
      polishProgressSection.style.display = 'none';
    } finally {
      scanAlbumArtBtn.disabled = false;
      setStatus('Idle');
    }
  });

  // Carousel navigation
  polishPrevSuggestion.addEventListener('click', () => {
    if (polishSuggestions.length === 0) return;
    polishSuggestionIndex =
      (polishSuggestionIndex - 1 + polishSuggestions.length) % polishSuggestions.length;
    updatePolishSuggestionDisplay();
  });

  polishNextSuggestion.addEventListener('click', () => {
    if (polishSuggestions.length === 0) return;
    polishSuggestionIndex = (polishSuggestionIndex + 1) % polishSuggestions.length;
    updatePolishSuggestionDisplay();
  });

  // Apply album art
  polishApplyBtn.addEventListener('click', async () => {
    const track = polishQueue[polishIndex];
    const suggestion = polishSuggestions[polishSuggestionIndex];
    if (!track || !suggestion) return;

    polishApplyBtn.disabled = true;
    polishSkipBtn.disabled = true;
    const previousLabel = polishApplyBtn.textContent;
    polishApplyBtn.textContent = 'Applying...';

    try {
      const dataUrl = await fetchImageAsDataUrl(suggestion.imageUrl);

      const params: UpdateTagsParams = {
        filePath: track.filePath,
        albumArt: dataUrl
      };

      if (!track.album && suggestion.album) params.album = suggestion.album;
      if (!track.year && suggestion.year) params.year = suggestion.year;
      if (!track.genre && suggestion.genre) params.genre = suggestion.genre;

      await updateTrackTagsWithRepair(params, track.title || track.fileName);
      polishApplied.push(track);

      const updated: string[] = ['Art'];
      if (params.album) updated.push('Album');
      if (params.year) updated.push('Year');
      if (params.genre) updated.push('Genre');
      showToast('success', 'Track Updated', `${track.artist} — ${track.title} (+${updated.join(', ')})`);

      polishIndex += 1;
      await renderPolishTrack();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      showToast('error', 'Apply Failed', message);
    } finally {
      polishApplyBtn.disabled = false;
      polishSkipBtn.disabled = false;
      polishApplyBtn.textContent = previousLabel || 'Apply Album Art';
    }
  });

  // Skip track
  polishSkipBtn.addEventListener('click', async () => {
    const track = polishQueue[polishIndex];
    if (!track) return;
    polishSkipped.push(track);
    polishIndex += 1;
    await renderPolishTrack();
  });

  // Keyboard shortcuts for polish page
  document.addEventListener('keydown', (event) => {
    const polishPage = document.getElementById('page-polish');
    if (!polishPage?.classList.contains('active')) return;
    if (polishReviewCard.style.display === 'none') return;

    const target = event.target as HTMLElement | null;
    const tagName = target?.tagName?.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea' || target?.isContentEditable) return;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      polishPrevSuggestion.click();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      polishNextSuggestion.click();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!polishApplyBtn.disabled) {
        polishApplyBtn.click();
      }
    }
  });

  // Polish scan progress listener
  if (typeof window.candybar.onPolishScanProgress === 'function') {
    window.candybar.onPolishScanProgress((progress) => {
      if (activePolishScanId && progress.id !== activePolishScanId) return;
      activePolishScanId = progress.id ?? null;

      polishProgressSection.style.display = 'block';

      if (progress.phase === 'discovering') {
        polishProgressMessage.textContent = 'Discovering files...';
        polishProgressCount.textContent = '0 / 0';
        polishProgressBar.style.width = '0%';
        return;
      }

      if (progress.phase === 'scanning') {
        const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
        polishProgressMessage.textContent = 'Scanning tracks for missing art...';
        polishProgressCount.textContent = `${progress.current} / ${progress.total}`;
        polishProgressBar.style.width = `${percent}%`;
        return;
      }

      if (progress.phase === 'complete') {
        polishProgressMessage.textContent = 'Scan complete';
        polishProgressCount.textContent = `${progress.total} / ${progress.total}`;
        polishProgressBar.style.width = '100%';
      }
    });
  }

  // Service status click handlers
  spotifyStatus.addEventListener('click', () => {
    void checkSpotifyConnection(true);
  });

  soundcloudStatus.addEventListener('click', () => {
    void checkSoundCloudConnection(true);
  });
}
