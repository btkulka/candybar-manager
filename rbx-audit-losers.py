"""Audit all 294 losers for references (cues, playlists, MyTags).

A loser with zero refs is safe to delete directly. A loser with refs needs
manual review -- we'd likely want to migrate those refs to the winner
before deleting. Reports counts and writes a CSV of losers with refs.
"""
import csv
import json
import sys
from pathlib import Path

from pyrekordbox import Rekordbox6Database
from pyrekordbox.db6 import tables

REPORT = Path(
    "/Volumes/Time Machin/rekordbox/dedupe-report-2026-04-23T00-30-45-542Z.json"
)
OUT_DIR = Path("/Volumes/Time Machin/rekordbox")


def main() -> int:
    report = json.loads(REPORT.read_text())
    losers = report.get("losers", [])
    print(f"Auditing {len(losers)} losers for refs...")

    db = Rekordbox6Database()
    DjmdCue = tables.DjmdCue
    DjmdSongPlaylist = tables.DjmdSongPlaylist
    DjmdSongMyTag = tables.DjmdSongMyTag

    # Precompute counts per ContentID in three passes (fast for all rows).
    cue_map = {}
    for c in db.session.query(DjmdCue).all():
        k = str(c.ContentID)
        cue_map[k] = cue_map.get(k, 0) + 1
    pl_map = {}
    for p in db.session.query(DjmdSongPlaylist).all():
        k = str(p.ContentID)
        pl_map[k] = pl_map.get(k, 0) + 1
    mt_map = {}
    for m in db.session.query(DjmdSongMyTag).all():
        k = str(m.ContentID)
        mt_map[k] = mt_map.get(k, 0) + 1

    clean = 0
    dirty = []
    missing = 0
    for l in losers:
        tid = str(l["trackId"])
        c = db.get_content(ID=tid)
        if c is None:
            missing += 1
            continue
        cues = cue_map.get(tid, 0)
        pls = pl_map.get(tid, 0)
        mts = mt_map.get(tid, 0)
        if cues == 0 and pls == 0 and mts == 0:
            clean += 1
        else:
            rating = int(getattr(c, "Rating", 0) or 0)
            plays = int(getattr(c, "DJPlayCount", 0) or 0)
            dirty.append({
                "trackId": tid,
                "artist": l["artist"],
                "title": l["title"],
                "winnerTrackId": l["winnerTrackId"],
                "linkage": l.get("linkage", ""),
                "cues": cues,
                "playlists": pls,
                "mytags": mts,
                "rating": rating,
                "plays": plays,
                "loserPath": l["filePath"],
            })

    print(f"\nSummary:")
    print(f"  clean (no refs):   {clean}")
    print(f"  dirty (has refs):  {len(dirty)}")
    print(f"  missing (already gone from DB): {missing}")

    if dirty:
        out = OUT_DIR / "dedupe-losers-with-refs.csv"
        with out.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(dirty[0].keys()))
            w.writeheader()
            w.writerows(dirty)
        print(f"\nDirty losers -> {out}")
        print("\nTop 10 dirty losers (most refs first):")
        dirty.sort(key=lambda x: x["cues"] * 10 + x["playlists"] * 5 + x["mytags"], reverse=True)
        print(f"{'trackId':<12} {'cues':>4} {'pls':>4} {'tag':>3} {'rat':>3} {'plays':>5} artist - title")
        print("-" * 100)
        for d in dirty[:10]:
            print(
                f"{d['trackId']:<12} {d['cues']:>4} {d['playlists']:>4} "
                f"{d['mytags']:>3} {d['rating']:>3} {d['plays']:>5} "
                f"{d['artist'][:40]} - {d['title'][:40]}"
            )

    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
