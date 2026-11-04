"""swap_cues: the DjmdCue arithmetic for moving a track's cues onto a new file.

    .venv-rbx/bin/python -m unittest discover -s lib/rekordbox/tests
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import swap_cues as sc  # noqa: E402


def cue(in_ms, micro=0, out_ms=-1, kind=1, **kw):
    """A cue shaped like an MP3 row's (MPEG fields filled)."""
    c = {
        "ID": "1", "Kind": kind, "InMsec": in_ms, "InFrame": sc.frame_of(in_ms),
        "InMpegFrame": 1053, "InMpegAbs": 421058, "OutMsec": out_ms,
        "OutFrame": sc.frame_of(out_ms) if out_ms >= 0 else 0,
        "OutMpegFrame": 0, "OutMpegAbs": 0, "CueMicrosec": micro,
    }
    c.update(kw)
    return c


class FrameTests(unittest.TestCase):
    def test_frame_is_floor_of_whole_ms_times_0_15(self):
        # Values read off live rows: 14039 ms -> 2105, 42068 -> 6310, 70097 -> 10514.
        self.assertEqual(sc.frame_of(14039), 2105)
        self.assertEqual(sc.frame_of(42068), 6310)
        self.assertEqual(sc.frame_of(70097), 10514)
        self.assertEqual(sc.frame_of(0), 0)
        self.assertEqual(sc.frame_of(6), 0)
        self.assertEqual(sc.frame_of(7), 1)


class ShiftTests(unittest.TestCase):
    def test_plain_cue_moves_whole_ms_and_keeps_micro(self):
        out = sc.shift_cue(cue(14039, micro=455), -25, zero_mpeg=True)
        self.assertEqual(out["InMsec"], 14014)
        self.assertEqual(out["CueMicrosec"], 455)
        self.assertEqual(out["InFrame"], sc.frame_of(14014))
        self.assertEqual(out["OutMsec"], -1)
        self.assertEqual(out["OutFrame"], 0)
        for f in sc.MPEG_FIELDS:
            self.assertEqual(out[f], 0)

    def test_loop_moves_both_ends_and_packed_micro_is_untouched(self):
        packed = (700 << 16) | 133  # 45875333, as on a live loop row
        out = sc.shift_cue(cue(253561, micro=packed, out_ms=257401), 37, zero_mpeg=False)
        self.assertEqual((out["InMsec"], out["OutMsec"]), (253598, 257438))
        self.assertEqual((out["InFrame"], out["OutFrame"]), (sc.frame_of(253598), sc.frame_of(257438)))
        self.assertEqual(out["CueMicrosec"], packed)
        self.assertEqual(out["InMpegFrame"], 1053)  # zero_mpeg off: kept

    def test_zero_shift_onto_aiff_only_clears_mpeg_fields(self):
        before = cue(14039, micro=455)
        out = sc.shift_cue(before, 0, zero_mpeg=True)
        self.assertEqual(out["InMsec"], 14039)
        self.assertEqual(out["InFrame"], before["InFrame"])
        self.assertEqual(out["CueMicrosec"], 455)
        self.assertEqual((out["InMpegFrame"], out["InMpegAbs"]), (0, 0))

    def test_zero_shift_without_mpeg_change_returns_the_row_as_is(self):
        before = cue(500, micro=12)
        out = sc.shift_cue(before, 0, zero_mpeg=False)
        self.assertEqual(out, {f: before[f] for f in sc.TIMING_FIELDS})

    def test_first_beat_cue_is_pinned_to_zero(self):
        out = sc.shift_cue(cue(7, micro=300), -25, zero_mpeg=True)
        self.assertEqual((out["InMsec"], out["CueMicrosec"], out["InFrame"]), (0, 0, 0))

    def test_cue_far_before_start_is_refused(self):
        with self.assertRaises(sc.CueShiftRefused):
            sc.shift_cue(cue(1000), -1100, zero_mpeg=True)

    def test_loop_crossing_zero_is_refused(self):
        with self.assertRaises(sc.CueShiftRefused):
            sc.shift_cue(cue(10, out_ms=1885), -25, zero_mpeg=True)

    def test_cue_past_the_end_is_refused(self):
        with self.assertRaises(sc.CueShiftRefused):
            sc.shift_cue(cue(299990), 25, zero_mpeg=True, new_length_ms=300000)

    def test_shift_must_be_whole_ms(self):
        with self.assertRaises(TypeError):
            sc.shift_cue(cue(1000), -25.06, zero_mpeg=True)


class JsonTests(unittest.TestCase):
    def test_json_entry_only_writes_keys_it_had(self):
        # Older contentCue entries lack CueMicrosec / BeatLoopSize / ColorTableIndex.
        entry = {"ID": "9", "InMsec": 2000, "InFrame": 300, "InMpegFrame": 150, "InMpegAbs": 9000,
                 "OutMsec": -1, "OutFrame": 0, "OutMpegFrame": 0, "OutMpegAbs": 0, "Kind": 2,
                 "created_at": "x", "updated_at": "y"}
        out = sc.shift_json_cue(entry, -25, zero_mpeg=True)
        self.assertNotIn("CueMicrosec", out)
        self.assertEqual(out["InMsec"], 1975)
        self.assertEqual(out["InFrame"], sc.frame_of(1975))
        self.assertEqual(out["InMpegFrame"], 0)
        self.assertEqual((out["created_at"], out["updated_at"], out["Kind"]), ("x", "y", 2))
        self.assertEqual(list(out), list(entry))  # key order kept


class CountTests(unittest.TestCase):
    def test_counts_split_hot_memory_and_loops(self):
        cues = [cue(1, kind=1), cue(2, kind=9), cue(3, kind=0), cue(4, kind=0, out_ms=900), cue(5, kind=3, out_ms=990)]
        self.assertEqual(sc.cue_counts(cues), {"hotCues": 2, "memoryCues": 1, "loops": 2})


if __name__ == "__main__":
    unittest.main()
