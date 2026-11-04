/**
 * Sound wave behind the app while a track plays.
 *
 * A spectrum of bars across the full width of the main view, rising up to half
 * its height, drawn on one canvas that never takes clicks. Each bar keeps a
 * "ghost" of its recent peak: a cap that holds for a moment, then sinks and
 * fades. Frames aren't cleared outright, only faded, so falling bars leave a
 * short trail. It idles (no animation frames at all) when nothing plays, when
 * the window is hidden, when it's switched off in Settings, or when the
 * system asks for reduced motion.
 *
 * The audio element is routed through Web Audio (element → analyser →
 * speakers). The media:// protocol serves CORS headers for this; without
 * them the analyser would only ever read silence.
 */

const STORAGE_KEY = 'candybar.player.visualizer';
const BAR_W = 3;
const BAR_GAP = 3;
const MIN_HZ = 45;
const MAX_HZ = 16000;
const PEAK_HOLD_S = 0.35;  // a peak stays put this long before sinking
const PEAK_FALL = 0.42;    // then sinks at this fraction of the height per second
const PEAK_FADE_S = 1.8;   // and fades out over this long since it was last hit
const TRAIL_FADE = 0.2;    // share of the previous frame erased each frame

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let freq: Uint8Array<ArrayBuffer> | null = null;
const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

let playing = false;
let frameId: number | null = null;
let lastT = 0;
let width = 0;
let height = 0;
let dpr = 1;

// Per bar: the frequency-bin range it covers, its current level and its ghost.
let bins: Array<[number, number]> = [];
let levels = new Float32Array(0);
let peaks = new Float32Array(0);
let peakAge = new Float32Array(0);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export function isVisualizerEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setVisualizerEnabled(on: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* per-viewer nicety only */ }
  if (!on) stopLoop(true);
  else if (playing) startLoop();
}

export function initVisualizer(): void {
  canvas = document.getElementById('player-visualizer') as HTMLCanvasElement | null;
  ctx = canvas?.getContext('2d') ?? null;
  if (!canvas || !ctx) return;
  new ResizeObserver(resize).observe(canvas);
  resize();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLoop(false);
    else if (playing) startLoop();
  });
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) stopLoop(true); else if (playing) startLoop(); });
}

/** Route a newly created audio element through the analyser. Call before play(). */
export function connectAudio(audio: HTMLAudioElement): void {
  try {
    audio.crossOrigin = 'anonymous';
    if (!audioCtx) {
      audioCtx = new AudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 8192; // fine enough that the bass bars don't share bins
      analyser.smoothingTimeConstant = 0.72;
      analyser.minDecibels = -88;
      analyser.maxDecibels = -18;
      analyser.connect(audioCtx.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
      layoutBars();
    }
    if (!sources.has(audio)) {
      const src = audioCtx.createMediaElementSource(audio);
      src.connect(analyser!);
      sources.set(audio, src);
    }
  } catch (err) {
    // No sound wave is fine; silence is not. Leave the element unrouted.
    console.warn('[Visualizer] Web Audio unavailable:', err);
  }
}

/** The player tells us when sound starts and stops. */
export function setVisualizerPlaying(on: boolean): void {
  playing = on;
  if (on) {
    void audioCtx?.resume();
    startLoop();
  }
  // When it stops, the loop keeps drawing until the bars and ghosts have
  // settled, then stops itself.
}

// ========== Drawing ==========

function resize(): void {
  if (!canvas || !ctx) return;
  dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  width = Math.max(1, Math.round(rect.width));
  height = Math.max(1, Math.round(rect.height));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layoutBars();
}

/** Log-spaced bars from MIN_HZ to MAX_HZ, as many as fit the width. */
function layoutBars(): void {
  if (!analyser || !audioCtx || width <= 1) return;
  const count = Math.max(24, Math.floor((width + BAR_GAP) / (BAR_W + BAR_GAP)));
  const nyquist = audioCtx.sampleRate / 2;
  const binHz = nyquist / analyser.frequencyBinCount;
  bins = [];
  for (let i = 0; i < count; i++) {
    const lo = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / count);
    const hi = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, (i + 1) / count);
    const a = Math.max(1, Math.floor(lo / binHz));
    const b = Math.max(a + 1, Math.ceil(hi / binHz));
    bins.push([a, Math.min(b, analyser.frequencyBinCount)]);
  }
  levels = new Float32Array(count);
  peaks = new Float32Array(count);
  peakAge = new Float32Array(count).fill(PEAK_FADE_S);
}

function startLoop(): void {
  if (frameId !== null || !ctx || !analyser) return;
  if (!isVisualizerEnabled() || reducedMotion.matches || document.hidden) return;
  canvas?.classList.add('is-live');
  lastT = performance.now();
  frameId = requestAnimationFrame(frame);
}

function stopLoop(clear: boolean): void {
  if (frameId !== null) cancelAnimationFrame(frameId);
  frameId = null;
  if (clear) {
    ctx?.clearRect(0, 0, width, height);
    levels.fill(0);
    peaks.fill(0);
    peakAge.fill(PEAK_FADE_S);
    canvas?.classList.remove('is-live');
  }
}

function frame(t: number): void {
  frameId = null;
  if (!ctx || !analyser || !freq) return;
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;

  if (playing) analyser.getByteFrequencyData(freq);
  else freq.fill(0);

  // Fade what's there instead of clearing it: that's the trail.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE})`;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';

  const n = bins.length;
  const slot = width / n;
  const barW = Math.max(1, Math.min(BAR_W, slot - 1));
  const grad = ctx.createLinearGradient(0, height, 0, 0);
  grad.addColorStop(0, 'rgba(127, 255, 212, 0.42)');
  grad.addColorStop(0.55, 'rgba(127, 255, 212, 0.15)');
  grad.addColorStop(1, 'rgba(127, 255, 212, 0.03)');

  let active = false;
  for (let i = 0; i < n; i++) {
    const [a, b] = bins[i];
    let sum = 0;
    for (let k = a; k < b; k++) sum += freq[k];
    // Highs carry less energy; a gentle tilt keeps the right side alive.
    const raw = (sum / (b - a)) / 255;
    const v = Math.min(1, Math.pow(raw, 1.5) * (0.9 + 0.5 * (i / n)));
    // Rise instantly, fall smoothly.
    levels[i] = v > levels[i] ? v : Math.max(v, levels[i] - dt * 1.6);
    if (levels[i] >= peaks[i]) {
      peaks[i] = levels[i];
      peakAge[i] = 0;
    } else {
      peakAge[i] += dt;
      if (peakAge[i] > PEAK_HOLD_S) peaks[i] = Math.max(levels[i], peaks[i] - PEAK_FALL * dt);
    }

    const x = i * slot + (slot - barW) / 2;
    const h = levels[i] * height;
    if (h > 0.5) {
      ctx.fillStyle = grad;
      ctx.fillRect(x, height - h, barW, h);
      active = true;
    }
    const ghost = 1 - peakAge[i] / PEAK_FADE_S;
    if (ghost > 0 && peaks[i] > 0.01) {
      ctx.fillStyle = `rgba(127, 255, 212, ${(0.7 * ghost).toFixed(3)})`;
      ctx.fillRect(x - 0.5, height - peaks[i] * height - 2, barW + 1, 2);
      active = true;
    }
  }

  if (playing || active) {
    frameId = requestAnimationFrame(frame);
  } else {
    stopLoop(true);
  }
}
