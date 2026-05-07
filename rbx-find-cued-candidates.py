"""Find relocation TrackIDs with actual cue/beatgrid/play-count data.

We need a track that had data BEFORE we relocate it, so we can verify the
data survived the write. J. Cole had none -> bad test. This script looks at
all 107 relocations and ranks them by how much "stuff" they carry.

For each relocation TrackID, reports:
  - HotCueBankList / MemoryCue counts
  - DJPlayCount
  - Rating
  - ColorID
  - MyTag links (tags)
Sorts by a composite "has interesting data" score.
"""
import json
import sys
from pathlib import Path

from pyrekordbox import Rekordbox6Database
from pyrekordbox.db6 import tables

REPORT = Path(
    "/Volumes/Time Machin/rekordbox/dedupe-report-2026-04-23T00-30-45-542Z.json"
)


def main() -> int:
    report = json.loads(REPORT.read_text())
    relocations = report.get("relocations", [])
    print(f"Scoring {len(relocations)} relocation tracks...")

    db = Rekordbox6Database()

    # Table hints: DjmdCue holds hot + memory cues (Kind differentiates).
    # DjmdContent has DJPlayCount, Rating, ColorID, etc.
    DjmdCue = tables.DjmdCue

    # Count cues per ContentID in one pass.
    cue_counts = {}
    for cue in db.session.query(DjmdCue).all():
        cid = str(cue.ContentID)
        cue_counts[cid] = cue_counts.get(cid, 0) + 1

    rows = []
    for r in relocations:
        tid = str(r["trackId"])
        c = db.get_content(ID=tid)
        if c is None:
            continue
        n_cues = cue_counts.get(tid, 0)
        play_count = getattr(c, "DJPlayCount", 0) or 0
        rating = getattr(c, "Rating", 0) or 0
        color = getattr(c, "ColorID", None)
        # Composite score: cues matter most, then plays, then rating/color.
        score = n_cues * 10 + int(play_count) + (int(rating) // 10) + (1 if color else 0)
        rows.append({
            "trackId": tid,
            "artist": r["artist"],
            "title": r["title"],
            "cues": n_cues,
            "plays": int(play_count),
            "rating": int(rating),
            "color": color,
            "oldPath": r["oldPath"],
            "newPath": r["newPath"],
            "score": score,
        })

    rows.sort(key=lambda x: x["score"], reverse=True)
    print("\nTop 10 relocation candidates with actual data:\n")
    print(f"{'TrackID':<12} {'cues':>4} {'plays':>5} {'rat':>4} {'color':>5} {'artist - title'}")
    print("-" * 110)
    for r in rows[:10]:
        print(
            f"{r['trackId']:<12} {r['cues']:>4} {r['plays']:>5} "
            f"{r['rating']:>4} {str(r['color'] or ''):>5} "
            f"{(r['artist'][:40] + ' - ' + r['title'][:40])}"
        )

    # Save the full ranked list for reference.
    out = Path(__file__).resolve().parent / "rbx-reloc-candidates.json"
    out.write_text(json.dumps(rows, indent=2))
    print(f"\nFull ranked list -> {out}")

    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
