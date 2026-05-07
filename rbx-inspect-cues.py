"""Inspect DjmdCue schema and rows for one cluster so we know what to merge.

Dump:
  * All column names on DjmdCue
  * All cue rows for Odd Mob 'LEFT TO RIGHT' winner (116696821) and loser (250519730)
  * Check DjmdContent for AnalysisDataPath / ANLZ location
"""
import sys
from pathlib import Path

from pyrekordbox import Rekordbox6Database
from pyrekordbox.db6 import tables

WINNER = "116696821"  # 8 cues
LOSER = "250519730"   # 5 cues


def dump(row, fields):
    return {f: getattr(row, f, "<missing>") for f in fields}


def main() -> int:
    db = Rekordbox6Database()
    DjmdCue = tables.DjmdCue

    cols = [c.name for c in DjmdCue.__table__.columns]
    print(f"DjmdCue columns ({len(cols)}):")
    for c in cols:
        print(f"  {c}")

    print("\n--- WINNER cue rows ---")
    winner_cues = db.session.query(DjmdCue).filter_by(ContentID=WINNER).all()
    for c in winner_cues:
        print(dump(c, cols))

    print("\n--- LOSER cue rows ---")
    loser_cues = db.session.query(DjmdCue).filter_by(ContentID=LOSER).all()
    for c in loser_cues:
        print(dump(c, cols))

    # ANLZ / analysis path check.
    print("\n--- DjmdContent analysis-related columns ---")
    content_cols = [c.name for c in tables.DjmdContent.__table__.columns]
    anlz_cols = [c for c in content_cols if "Analy" in c or "Path" in c or "Ext" in c or "ANLZ" in c]
    print(f"Relevant: {anlz_cols}")
    w = db.get_content(ID=WINNER)
    print("Winner values:")
    for col in anlz_cols:
        print(f"  {col:25} {getattr(w, col, None)!r}")
    l = db.get_content(ID=LOSER)
    print("Loser values:")
    for col in anlz_cols:
        print(f"  {col:25} {getattr(l, col, None)!r}")

    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
