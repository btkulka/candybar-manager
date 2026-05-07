"""Single-track delete test.

Deletes one loser DjmdContent row and shows before/after state for
associated tables (cues, playlists). We want to know whether pyrekordbox
cascades the delete or leaves orphan rows.

Target: TrackID 255808629 (loser for Dom Dolla - Miracle Maker winner 249054562).
"""
import json
import subprocess
import sys
from pathlib import Path

from pyrekordbox import Rekordbox6Database
from pyrekordbox.db6 import tables

TARGET_ID = "255808629"
WINNER_ID = "249054562"  # untouched sanity reference
ROLLBACK_PATH = Path(__file__).resolve().parent / f"rbx-rollback-delete-{TARGET_ID}.json"


def assert_rekordbox_closed() -> None:
    out = subprocess.run(
        ["pgrep", "-if", "rekordbox"], capture_output=True, text=True
    )
    if out.stdout.strip():
        print(f"ERROR: Rekordbox is running:\n{out.stdout}")
        print("Quit Rekordbox before writing to master.db.")
        sys.exit(2)


def count_refs(db, tid: str) -> dict:
    DjmdCue = tables.DjmdCue
    DjmdSongPlaylist = tables.DjmdSongPlaylist
    DjmdSongMyTag = tables.DjmdSongMyTag
    return {
        "cues": db.session.query(DjmdCue).filter_by(ContentID=tid).count(),
        "playlist_memberships": db.session.query(DjmdSongPlaylist)
            .filter_by(ContentID=tid).count(),
        "mytag_memberships": db.session.query(DjmdSongMyTag)
            .filter_by(ContentID=tid).count(),
    }


def main() -> int:
    assert_rekordbox_closed()

    print("Opening master.db...")
    db = Rekordbox6Database()

    c = db.get_content(ID=TARGET_ID)
    if c is None:
        print(f"ERROR: TrackID {TARGET_ID} not found.")
        return 4

    w = db.get_content(ID=WINNER_ID)
    before_loser = {
        "ID": c.ID,
        "Title": c.Title,
        "FolderPath": c.FolderPath,
    }
    before_loser_refs = count_refs(db, TARGET_ID)
    before_winner = {
        "ID": w.ID if w else None,
        "Title": w.Title if w else None,
        "FolderPath": w.FolderPath if w else None,
    }
    before_winner_refs = count_refs(db, WINNER_ID) if w else None

    print("BEFORE -- loser:")
    for k, v in before_loser.items():
        print(f"  {k:12} {v!r}")
    print(f"  refs: {before_loser_refs}")
    print("BEFORE -- winner (sanity):")
    for k, v in before_winner.items():
        print(f"  {k:12} {v!r}")
    print(f"  refs: {before_winner_refs}")

    ROLLBACK_PATH.write_text(json.dumps({
        "loser_before": before_loser,
        "loser_refs_before": before_loser_refs,
        "winner_before": before_winner,
        "winner_refs_before": before_winner_refs,
    }, indent=2))
    print(f"\nWrote rollback snapshot -> {ROLLBACK_PATH}")

    # Find the delete API. pyrekordbox should expose delete_content(); fall back
    # to raw session.delete if not.
    if hasattr(db, "delete_content"):
        print("Using db.delete_content(content)")
        db.delete_content(c)
    else:
        print("db.delete_content missing; using session.delete")
        db.session.delete(c)
    db.commit()
    print("Committed.")

    # Re-open and re-check.
    db.close()
    db = Rekordbox6Database()

    c_after = db.get_content(ID=TARGET_ID)
    w_after = db.get_content(ID=WINNER_ID)
    after_loser_refs = count_refs(db, TARGET_ID)
    after_winner_refs = count_refs(db, WINNER_ID)

    print("\nAFTER:")
    print(f"  loser row present?  {c_after is not None}")
    print(f"  loser orphan refs:  {after_loser_refs}")
    print(f"  winner row present? {w_after is not None}")
    if w_after:
        print(f"  winner FolderPath:  {w_after.FolderPath!r}")
    print(f"  winner refs:        {after_winner_refs}")

    if (
        c_after is None
        and w_after is not None
        and after_winner_refs == before_winner_refs
        and all(v == 0 for v in after_loser_refs.values())
    ):
        print("\nOK: loser removed, winner intact, no orphan refs.")
        db.close()
        return 0

    print("\nWARNING: unexpected post-delete state.")
    if any(v > 0 for v in after_loser_refs.values()):
        print("  Orphan references to deleted ContentID still exist:")
        print(f"    {after_loser_refs}")
    db.close()
    return 6


if __name__ == "__main__":
    sys.exit(main())
