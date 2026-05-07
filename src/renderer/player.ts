// Global music player (topbar)

let audio: HTMLAudioElement | null = null;
let animFrameId: number | null = null;

// DOM elements
const playerEl = document.getElementById('sidebar-player') as HTMLDivElement;
const artEl = document.getElementById('sidebar-player-art') as HTMLDivElement;
const titleEl = document.getElementById('sidebar-player-title') as HTMLSpanElement;
const playBtn = document.getElementById('sidebar-player-play') as HTMLButtonElement;
const progressWrap = document.getElementById('sidebar-player-progress-wrap') as HTMLDivElement;
const progressBar = document.getElementById('sidebar-player-progress') as HTMLDivElement;
const timeEl = document.getElementById('sidebar-player-time') as HTMLSpanElement;
const durationEl = document.getElementById('sidebar-player-duration') as HTMLSpanElement;
const volumeSlider = document.getElementById('sidebar-player-volume') as HTMLInputElement;
const muteBtn = document.getElementById('sidebar-player-mute') as HTMLButtonElement;

let currentFilePath: string | null = null;

// Persisted volume across audio instances + sessions.
const VOLUME_STORAGE_KEY = 'candybar.player.volume';
const MUTED_STORAGE_KEY = 'candybar.player.muted';
let currentVolume = loadStoredVolume();
let isMuted = loadStoredMuted();

function loadStoredVolume(): number {
  const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
  if (raw === null) return 1;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
}

function loadStoredMuted(): boolean {
  return localStorage.getItem(MUTED_STORAGE_KEY) === '1';
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateProgress() {
  if (!audio) return;
  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  progressBar.style.width = `${pct}%`;
  timeEl.textContent = formatTime(audio.currentTime);
  if (!audio.paused) {
    animFrameId = requestAnimationFrame(updateProgress);
  }
}

function setPlaying(playing: boolean) {
  playerEl.classList.toggle('playing', playing);
}

function applyVolumeToAudio() {
  if (!audio) return;
  audio.volume = currentVolume;
  audio.muted = isMuted;
}

function reflectMutedUI() {
  playerEl.classList.toggle('muted', isMuted);
  muteBtn.setAttribute('data-tooltip', isMuted ? 'Unmute' : 'Mute');
}

function buildMediaUrl(filePath: string): string {
  return 'media://localhost' + filePath.split('/').map(encodeURIComponent).join('/');
}

async function loadAlbumArt(filePath: string) {
  artEl.innerHTML = '';
  try {
    const dataUrl = await window.candybar.getTrackAlbumArt(filePath);
    if (dataUrl && currentFilePath === filePath) {
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = 'Album art';
      artEl.appendChild(img);
      playerEl.classList.add('has-art');
      return;
    }
  } catch { /* ignore */ }
  playerEl.classList.remove('has-art');
}

export function stopPlayer() {
  if (audio) {
    audio.pause();
    audio.src = '';
    audio = null;
  }
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  setPlaying(false);
  progressBar.style.width = '0%';
  timeEl.textContent = '0:00';
  durationEl.textContent = '0:00';
  currentFilePath = null;
  document.querySelectorAll('.preview-btn.playing').forEach(btn => btn.classList.remove('playing'));
}

export function playFile(filePath: string, displayName?: string) {
  if (currentFilePath === filePath && audio) {
    if (audio.paused) {
      audio.play();
      setPlaying(true);
      animFrameId = requestAnimationFrame(updateProgress);
    } else {
      audio.pause();
      setPlaying(false);
    }
    return;
  }

  stopPlayer();
  currentFilePath = filePath;

  const name = displayName || filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Unknown';
  titleEl.textContent = name;
  titleEl.title = name;
  playBtn.disabled = false;

  loadAlbumArt(filePath);

  audio = new Audio(buildMediaUrl(filePath));
  applyVolumeToAudio();

  audio.addEventListener('loadedmetadata', () => {
    if (!audio) return;
    durationEl.textContent = formatTime(audio.duration);
    audio.play();
    setPlaying(true);
    animFrameId = requestAnimationFrame(updateProgress);
  });

  audio.addEventListener('ended', () => {
    setPlaying(false);
    progressBar.style.width = '100%';
    if (animFrameId !== null) cancelAnimationFrame(animFrameId);
  });

  audio.addEventListener('error', () => {
    const err = audio?.error;
    console.error(`Audio playback error: code=${err?.code}, message=${err?.message}, src=${audio?.src}`);
    stopPlayer();
    titleEl.textContent = 'Playback error';
  });
}

export function isPlaying(filePath: string): boolean {
  return currentFilePath === filePath && audio !== null && !audio.paused;
}

export function getCurrentFilePath(): string | null {
  return currentFilePath;
}

export function initPlayer() {
  volumeSlider.value = String(currentVolume);
  reflectMutedUI();

  playBtn.addEventListener('click', () => {
    if (!audio) return;
    if (audio.paused) {
      audio.play();
      setPlaying(true);
      animFrameId = requestAnimationFrame(updateProgress);
    } else {
      audio.pause();
      setPlaying(false);
    }
  });

  progressWrap.addEventListener('click', (e) => {
    if (!audio || !audio.duration) return;
    const rect = progressWrap.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
    updateProgress();
  });

  volumeSlider.addEventListener('input', () => {
    currentVolume = parseFloat(volumeSlider.value);
    // Adjusting the slider implicitly unmutes — matches how most players behave.
    if (isMuted && currentVolume > 0) {
      isMuted = false;
      localStorage.setItem(MUTED_STORAGE_KEY, '0');
      reflectMutedUI();
    }
    localStorage.setItem(VOLUME_STORAGE_KEY, String(currentVolume));
    applyVolumeToAudio();
  });

  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    localStorage.setItem(MUTED_STORAGE_KEY, isMuted ? '1' : '0');
    reflectMutedUI();
    applyVolumeToAudio();
  });
}
