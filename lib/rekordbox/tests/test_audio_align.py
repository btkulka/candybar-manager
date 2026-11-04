"""audio_align on synthetic tracks with a known offset (no real music needed).

The "track" is kick-ish clicks at 124 BPM over noise with a slow random
envelope: periodic like dance music (the case that fools a naive
correlation), but every bar is different.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import audio_align as aa  # noqa: E402

FFMPEG = os.environ.get("FFMPEG") or str(HERE.parents[2] / "node_modules" / "ffmpeg-static" / "ffmpeg")
SR = 44100


def make(seconds: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    noise = np.convolve(rng.standard_normal(n), np.ones(8) / 8, mode="same")
    env = np.interp(t, np.linspace(0, seconds, int(seconds * 2) + 1), rng.uniform(0.05, 0.4, int(seconds * 2) + 1))
    x = noise * env * 0.5
    for bt in np.arange(0.5, seconds - 0.2, 60 / 124):
        i, length = int(bt * SR), int(0.12 * SR)
        tt = np.arange(length) / SR
        x[i:i + length] += 0.8 * np.sin(2 * np.pi * (60 + 120 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 25)
    return np.clip(x, -0.99, 0.99)


def write_wav(path: Path, mono: np.ndarray) -> None:
    st = np.stack([mono, np.roll(mono, 3) * 0.9], axis=1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((st * 32767).astype("<i2").tobytes())


def ff(*args: str) -> None:
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


@unittest.skipUnless(Path(FFMPEG).exists(), "ffmpeg-static not installed")
class AlignTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="align-test-"))
        master = make(60, seed=7)
        write_wav(cls.dir / "master.wav", master)
        pad = int(0.0375 * SR)  # a master with 37.5 ms more lead-in
        write_wav(cls.dir / "padded.wav", np.concatenate([np.zeros(pad), master]))
        write_wav(cls.dir / "edit.wav", np.concatenate([master[: 25 * SR], master[33 * SR:]]))  # 8 s cut
        write_wav(cls.dir / "other.wav", make(60, seed=99))  # same tempo and kick, other "song"
        d = cls.dir
        ff("-i", str(d / "master.wav"), "-c:a", "libmp3lame", "-b:a", "320k", str(d / "orig.mp3"))
        ff("-i", str(d / "master.wav"), "-c:a", "pcm_s16be", str(d / "master.aif"))
        ff("-i", str(d / "master.wav"), "-ar", "96000", "-c:a", "pcm_s24be", str(d / "master96.aif"))
        ff("-i", str(d / "padded.wav"), "-c:a", "flac", str(d / "padded.flac"))
        ff("-i", str(d / "edit.wav"), "-c:a", "pcm_s16be", str(d / "edit.aif"))
        ff("-i", str(d / "other.wav"), "-c:a", "pcm_s16be", str(d / "other.aif"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def align(self, orig, new, lossy=True):
        return aa.align(FFMPEG, str(self.dir / orig), str(self.dir / new), original_lossy=lossy)

    def test_mp3_against_its_master_measures_the_encoder_delay(self):
        r = self.align("orig.mp3", "master.aif")
        self.assertAlmostEqual(r["gaplessTrimMs"], 1105 / SR * 1000, delta=0.1)
        self.assertEqual(len(r["windows"]), 3)
        for w in r["windows"]:
            self.assertAlmostEqual(w["lagMs"], -1105 / SR * 1000, delta=0.1)
            self.assertGreater(w["ncc"], 0.8)
            self.assertFalse(w["atEdge"])

    def test_sample_rate_of_the_new_file_does_not_move_it(self):
        for w in self.align("orig.mp3", "master96.aif")["windows"]:
            self.assertAlmostEqual(w["lagMs"], -25.06, delta=0.1)

    def test_extra_lead_in_is_a_positive_offset(self):
        r = self.align("master.aif", "padded.flac", lossy=False)
        self.assertNotIn("gaplessTrimMs", r)
        for w in r["windows"]:
            self.assertAlmostEqual(w["lagMs"], 37.5, delta=0.1)

    def test_a_different_track_at_the_same_tempo_does_not_correlate(self):
        for w in self.align("orig.mp3", "other.aif")["windows"]:
            self.assertLess(w["ncc"], 0.3)

    def test_a_different_edit_breaks_later_windows(self):
        r = self.align("orig.mp3", "edit.aif")
        self.assertGreater(abs(r["newDurationSec"] - r["originalDurationSec"]), 7)
        self.assertGreater(r["windows"][0]["ncc"], 0.8)
        self.assertTrue(any(w["ncc"] < 0.3 or w["atEdge"] for w in r["windows"][1:]))


if __name__ == "__main__":
    unittest.main()
