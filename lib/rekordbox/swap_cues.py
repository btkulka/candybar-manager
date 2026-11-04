"""Cue-row arithmetic for swapping a track's file in place. Pure: no DB, no I/O.

How Rekordbox stores a cue (DjmdCue), as read from 3,658 cues in the live
collection on 2026-11-03 (every row fits these rules):

  InMsec / OutMsec   whole milliseconds. OutMsec is -1 (and OutFrame 0) unless
                     the cue is a loop.
  CueMicrosec        the sub-millisecond remainder(s), 0-999 each: the in
                     point's for a plain cue; for a loop, in and out packed as
                     (out << 16) | in. (Which half is which can't be told from
                     the data, so nothing here depends on it: see shift_cue.)
  InFrame / OutFrame floor(ms * 0.15) of the WHOLE-millisecond value: positions
                     in 1/150 s, the resolution of Rekordbox's detail waveform
                     and the players' cue positioning.
  InMpegFrame/Abs,   only MP3 rows fill these (players' MP3 seek hints: a
  OutMpegFrame/Abs   1/75 s index and a byte offset into the file). AIFF, WAV
                     and FLAC rows carry 0 in all four.
  In/OutPointSeekInfo  NULL on every row.

The contentCue table holds a JSON copy of each track's cues (same keys, one
array per track); a swap rewrites both so they never disagree.
"""
from __future__ import annotations

from typing import Any, Optional

# A plain cue that would land up to this far before the start of the new file
# is pinned to 0:00 (a "first beat" cue at 7 ms meeting a 25 ms shift); further
# than that, the moment it marked isn't in the new file and the swap is refused.
CLAMP_TOLERANCE_MS = 50

TIMING_FIELDS = (
    "InMsec", "InFrame", "InMpegFrame", "InMpegAbs",
    "OutMsec", "OutFrame", "OutMpegFrame", "OutMpegAbs", "CueMicrosec",
)
MPEG_FIELDS = ("InMpegFrame", "InMpegAbs", "OutMpegFrame", "OutMpegAbs")


def frame_of(ms: int) -> int:
    """InFrame/OutFrame for a whole-millisecond position (1/150 s units)."""
    return (ms * 15) // 100


def is_loop(cue: dict) -> bool:
    out = cue.get("OutMsec")
    return out is not None and out >= 0


class CueShiftRefused(Exception):
    """A cue can't follow the shift (it would land outside the new file)."""


def shift_cue(cue: dict, shift_ms: int, *, zero_mpeg: bool, new_length_ms: Optional[int] = None) -> dict:
    """The timing fields of `cue` after moving it `shift_ms` (whole ms; negative
    moves it earlier) onto a new file. Returns only TIMING_FIELDS.

    The shift is whole milliseconds on purpose: CueMicrosec then stays exactly
    as it is, however its halves are packed, and InMsec/OutMsec move by exactly
    shift_ms. Sub-millisecond precision is below anything audible or what the
    alignment measurement resolves.
    """
    if not isinstance(shift_ms, int):
        raise TypeError("shift_ms must be whole milliseconds")
    in_ms = int(cue["InMsec"])
    micro = int(cue.get("CueMicrosec") or 0)
    loop = is_loop(cue)
    new_in = in_ms + shift_ms
    if new_in < 0:
        if loop or new_in < -CLAMP_TOLERANCE_MS:
            raise CueShiftRefused(
                f"a {'loop' if loop else 'cue'} at {in_ms / 1000:.3f}s would land before the start of the new file"
            )
        # Pinned to the very start: its sub-millisecond part goes too.
        new_in, micro = 0, 0
    out: dict[str, Any] = {
        "InMsec": new_in,
        "InFrame": frame_of(new_in),
        "CueMicrosec": micro,
    }
    if loop:
        new_out = int(cue["OutMsec"]) + shift_ms
        out["OutMsec"] = new_out
        out["OutFrame"] = frame_of(new_out)
    else:
        out["OutMsec"] = cue["OutMsec"] if cue.get("OutMsec") is not None else -1
        out["OutFrame"] = cue.get("OutFrame", 0) if cue.get("OutFrame") is not None else 0
    if new_length_ms is not None:
        last = out["OutMsec"] if loop else out["InMsec"]
        if last > new_length_ms:
            raise CueShiftRefused(f"a cue at {in_ms / 1000:.3f}s would land past the end of the new file")
    for f in MPEG_FIELDS:
        out[f] = 0 if zero_mpeg else int(cue.get(f) or 0)
    if shift_ms == 0 and not zero_mpeg:
        # Nothing moves: hand back exactly what was there.
        return {f: cue.get(f) for f in TIMING_FIELDS}
    return out


def shift_json_cue(entry: dict, shift_ms: int, *, zero_mpeg: bool, new_length_ms: Optional[int] = None) -> dict:
    """A contentCue JSON entry with the same change applied. Only keys the entry
    already has are written (older entries lack CueMicrosec, BeatLoopSize...)."""
    shifted = shift_cue(entry, shift_ms, zero_mpeg=zero_mpeg, new_length_ms=new_length_ms)
    out = dict(entry)
    for k, v in shifted.items():
        if k in entry:
            out[k] = v
    return out


def cue_counts(cues: list[dict]) -> dict:
    """Hot cues, memory cues and loops, the way Rekordbox's UI groups them:
    Kind 0 is a memory cue/loop, 1-9 a hot cue slot (A-H); OutMsec >= 0 marks
    a loop either way."""
    hot = memory = loops = 0
    for c in cues:
        if is_loop(c):
            loops += 1
        elif int(c.get("Kind") or 0) == 0:
            memory += 1
        else:
            hot += 1
    return {"hotCues": hot, "memoryCues": memory, "loops": loops}
