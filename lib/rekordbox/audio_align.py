"""Measure where the same music sits in two files: the track Rekordbox holds now
and the lossless copy replacing it. Cue points are positions in time, so they
only stay on the same musical moment if the two line up (or the measured
offset is applied to them).

Method:
  1. Decode both to mono at 22,050 Hz with ffmpeg and pre-emphasise them
     (first difference). Raw dance music is dominated by the kick, so two
     different tracks at the same tempo correlate at ~0.9 on any whole beat;
     after pre-emphasis the hats, vocals and synths that tell recordings apart
     carry the correlation instead, and the peaks get sharper.
  2. Coarse lag over the WHOLE track, on a 4x-decimated copy, within +/-8 s.
     A window alone can lock onto a repeat of a loop a few bars away; the whole
     track only lines up at the true offset.
  3. Three 12 s windows of the original (near the start, the middle, near the
     end) refined at full rate within a few ms of the coarse lag, with a
     parabolic fit for sub-sample precision. Each reports its lag and its
     normalised cross-correlation (NCC). Agreeing windows mean one offset holds
     for the whole track; disagreeing ones mean a different edit.
The caller classifies the result (aligned / shifted / mismatch).

Which timeline the ORIGINAL is decoded on matters. Rekordbox's cue times for
MP3 (and AAC) files include the encoder's start-up delay: it skips the
Xing/LAME info frame but does not apply the gapless trim the LAME tag asks for.
ffmpeg applies that trim by default (1,105 samples, 25.06 ms at 44.1 kHz for
LAME), so the original is decoded with `-flags2 +skip_manual`, which leaves it
in. The evidence (2026-11-03), none of it a test inside Rekordbox itself:
  - Mixxx's Rekordbox importer (src/library/rekordbox/rekordboxfeature.cpp,
    PR 2119) subtracts 26 ms from Rekordbox MP3 positions when decoding with
    FFmpeg exactly when the file has a valid LAME tag (the case where ffmpeg
    trims), and 48 ms (2,112 AAC priming samples) for M4A under CoreAudio.
  - dj-kb's converter notes: Rekordbox skips the info frame; Traktor, which
    doesn't trim, agrees with Rekordbox on valid-LAME files.
  - The one same-version MP3/AIFF pair in the collection (Dom Dolla, "Miracle
    Maker (Extended Mix)", IDs 249054562 / 237574227) has Rekordbox's own MP3
    beatgrid 29-30 ms later than its AIFF grid, beat for beat.
"""
from __future__ import annotations

import subprocess
from typing import Optional

import numpy as np

RATE = 22050
DECIMATE = 4
WINDOW_S = 12.0
SEARCH_S = 8.0
# Full-rate refinement radius around the coarse lag, in ms (the coarse step is
# DECIMATE samples, 0.18 ms; this leaves room for the parabolic fit).
REFINE_MS = 3.0
# Below this RMS (full scale = 1.0, before pre-emphasis) a window is
# near-silence and its correlation means nothing; it slides forward instead.
MIN_WINDOW_RMS = 0.003


class DecodeError(Exception):
    pass


def decode(ffmpeg: str, path: str, *, untrimmed: bool, rate: int = RATE, seconds: Optional[float] = None) -> np.ndarray:
    """Mono PCM as float64. `untrimmed` keeps the encoder delay ffmpeg would
    otherwise strip from an MP3/AAC start (Rekordbox's timeline)."""
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
    if untrimmed:
        cmd += ["-flags2", "+skip_manual"]
    cmd += ["-i", path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(rate)]
    if seconds is not None:
        cmd += ["-t", str(seconds)]
    cmd += ["-f", "f32le", "-"]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        msg = proc.stderr.decode(errors="replace").strip().splitlines()
        raise DecodeError(msg[-1] if msg else f"ffmpeg exited {proc.returncode}")
    pcm = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float64)
    if pcm.size == 0:
        raise DecodeError("no audio decoded")
    return pcm


def pre_emphasis(x: np.ndarray) -> np.ndarray:
    """First difference, same length (y[0] = 0): a gentle high-pass."""
    y = np.empty_like(x)
    y[0] = 0.0
    y[1:] = x[1:] - x[:-1]
    return y


def _decimate(x: np.ndarray, k: int) -> np.ndarray:
    n = (len(x) // k) * k
    return x[:n].reshape(-1, k).mean(axis=1)


def _xcorr(a: np.ndarray, b: np.ndarray, size: int) -> np.ndarray:
    """Circular cross-correlation c[k] = sum_i a[i] * b[i + k] over an FFT of
    `size` (>= len(a) + len(b) so nothing wraps)."""
    return np.fft.irfft(np.fft.rfft(b, size) * np.conj(np.fft.rfft(a, size)), size)


def _ncc_search(win: np.ndarray, seg: np.ndarray) -> np.ndarray:
    """NCC of `win` against every placement inside `seg` (len(seg) >= len(win)):
    out[k] = <win, seg[k:k+m]> / (|win| |seg[k:k+m]|)."""
    m = len(win)
    n = len(seg) - m + 1
    size = 1 << int(np.ceil(np.log2(len(seg) + m)))
    corr = _xcorr(win, seg, size)[:n]
    csum = np.concatenate([[0.0], np.cumsum(seg * seg)])
    seg_norm = np.sqrt(np.maximum(csum[m:m + n] - csum[:n], 0.0))
    denom = seg_norm * np.sqrt(np.dot(win, win))
    with np.errstate(divide="ignore", invalid="ignore"):
        ncc = np.where(denom > 1e-12, corr / denom, 0.0)
    return ncc


def _parabolic(y: np.ndarray, i: int) -> float:
    if 0 < i < len(y) - 1:
        a, b, c = y[i - 1], y[i], y[i + 1]
        d = a - 2 * b + c
        if d != 0:
            return i + 0.5 * (a - c) / d
    return float(i)


def _segment(x: np.ndarray, start: int, length: int) -> np.ndarray:
    """x[start:start+length], zero-padded where it runs off either end."""
    out = np.zeros(length)
    lo, hi = max(start, 0), min(start + length, len(x))
    if hi > lo:
        out[lo - start:hi - start] = x[lo:hi]
    return out


def global_lag(orig: np.ndarray, new: np.ndarray, rate: int = RATE) -> tuple[int, float]:
    """(lag in full-rate samples, normalised peak) over the whole track, on the
    decimated signals. Lag is new minus original: new[t + lag] ~ orig[t]."""
    a = _decimate(orig, DECIMATE)
    b = _decimate(new, DECIMATE)
    size = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    c = _xcorr(a, b, size)
    search = int(SEARCH_S * rate / DECIMATE)
    lags = np.concatenate([np.arange(0, search + 1), np.arange(-search, 0)])
    vals = np.concatenate([c[: search + 1], c[size - search:]])
    i = int(np.argmax(np.abs(vals)))
    norm = np.sqrt(np.dot(a, a) * np.dot(b, b))
    return int(lags[i]) * DECIMATE, float(abs(vals[i]) / norm) if norm > 0 else 0.0


def window_lag(orig: np.ndarray, new: np.ndarray, start: int, around: int, rate: int = RATE) -> dict:
    """Refined lag (ms, new minus original) and NCC for the original window at
    `start`, searched within REFINE_MS of `around` (full-rate samples)."""
    m = int(WINDOW_S * rate)
    win = orig[start:start + m]
    r = int(REFINE_MS / 1000 * rate) + DECIMATE
    seg = _segment(new, start + around - r, m + 2 * r)
    ncc = _ncc_search(win, seg)
    # Polarity-flipped masters exist, so the strongest peak either way counts.
    j = int(np.argmax(np.abs(ncc)))
    sign = 1.0 if ncc[j] >= 0 else -1.0
    frac = _parabolic(sign * ncc, j)
    lag_samples = around - r + frac
    edge = j in (0, len(ncc) - 1)
    return {
        "atSec": round(start / rate, 3),
        "lagMs": round(float(lag_samples) / rate * 1000, 3),
        "ncc": round(float(abs(ncc[j])), 4),
        "inverted": bool(ncc[j] < 0),
        # The best match sat on the edge of the refinement range: this window
        # doesn't agree with the whole-track lag.
        "atEdge": bool(edge),
    }


def window_starts(orig_raw: np.ndarray, rate: int = RATE) -> list[int]:
    """Up to three window starts (~start, middle, ~end), each slid forward off
    near-silence."""
    m = int(WINDOW_S * rate)
    n = len(orig_raw)
    if n < m + rate:
        return []
    if n >= 3 * m:
        anchors = [0.08, 0.5, 0.82]
    elif n >= 2 * m:
        anchors = [0.1, 0.6]
    else:
        anchors = [0.0]
    starts: list[int] = []
    for a in anchors:
        s = min(int(a * n), n - m)
        for _ in range(4):
            if np.sqrt(np.mean(orig_raw[s:s + m] ** 2)) >= MIN_WINDOW_RMS:
                starts.append(s)
                break
            s = min(s + 5 * rate, n - m)
    return sorted(set(starts))


def gapless_trim_ms(ffmpeg: str, path: str) -> float:
    """How much ffmpeg's default (gapless) decode trims from the file's start
    compared with the untrimmed decode: 25.06 ms for a LAME MP3 at 44.1 kHz,
    0 for a file with nothing to trim."""
    a = decode(ffmpeg, path, untrimmed=True, seconds=12)
    b = decode(ffmpeg, path, untrimmed=False, seconds=12)
    m = min(len(a), len(b)) - int(0.3 * RATE)
    if m <= RATE:
        return 0.0
    # The trimmed decode starts `trim` samples into the untrimmed one:
    # b[t] == a[t + trim]. Find where b's opening lands inside a.
    win = b[:m - int(0.2 * RATE)]
    ncc = _ncc_search(win, a[:m])
    i = int(np.argmax(ncc[: int(0.2 * RATE)]))
    return round(_parabolic(ncc, i) / RATE * 1000, 3)


def align(ffmpeg: str, original: str, new: str, *, original_lossy: bool) -> dict:
    orig_raw = decode(ffmpeg, original, untrimmed=original_lossy)
    new_raw = decode(ffmpeg, new, untrimmed=False)
    orig, newp = pre_emphasis(orig_raw), pre_emphasis(new_raw)
    lag, peak = global_lag(orig, newp)
    windows = [window_lag(orig, newp, s, lag) for s in window_starts(orig_raw)]
    out = {
        "originalDurationSec": round(len(orig_raw) / RATE, 3),
        "newDurationSec": round(len(new_raw) / RATE, 3),
        "globalLagMs": round(lag / RATE * 1000, 3),
        "globalPeak": round(peak, 4),
        "windows": windows,
        "originalTimeline": "untrimmed" if original_lossy else "as-decoded",
    }
    if original_lossy:
        out["gaplessTrimMs"] = gapless_trim_ms(ffmpeg, original)
    return out
