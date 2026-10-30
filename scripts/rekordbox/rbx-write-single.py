"""Single-track write test: relocate one DjmdContent row in master.db.

Target: TrackID 205914339 (J. Cole - "a m a r i").
  Before: FolderPath on Candy Bar (missing drive), FileNameL matches.
  After:  FolderPath on Time Machin/Library, FileNameL updated to basename.

Safety:
  * Refuses to run if a rekordbox process is detected.
  * Writes rollback.json with the before-values so we can undo just this row
    without a full master.db restore.
  * Re-queries after commit to verify the write persisted.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from pyrekordbox import Rekordbox6Database

TARGET_ID = "249054562"
NEW_FOLDER_PATH = "/Volumes/Time Machin/Library/Dom Dolla/Miracle_Maker.aiff"
ROLLBACK_PATH = Path(__file__).resolve().parent / f"rbx-rollback-{TARGET_ID}.json"


def assert_rekordbox_closed() -> None:
    out = subprocess.run(
        ["pgrep", "-if", "rekordbox"], capture_output=True, text=True
    )
    if out.stdout.strip():
        print(f"ERROR: Rekordbox is running:\n{out.stdout}")
        print("Quit Rekordbox before writing to master.db.")
        sys.exit(2)


def main() -> int:
    assert_rekordbox_closed()

    new_basename = os.path.basename(NEW_FOLDER_PATH)
    if not os.path.exists(NEW_FOLDER_PATH):
        print(f"ERROR: new path does not exist on disk: {NEW_FOLDER_PATH}")
        return 3

    print("Opening master.db...")
    db = Rekordbox6Database()

    c = db.get_content(ID=TARGET_ID)
    if c is None:
        print(f"ERROR: TrackID {TARGET_ID} not found.")
        return 4

    before = {
        "ID": c.ID,
        "Title": c.Title,
        "FolderPath": c.FolderPath,
        "FileNameL": c.FileNameL,
        "FileNameS": c.FileNameS,
    }
    print("BEFORE:")
    for k, v in before.items():
        print(f"  {k:12} {v!r}")

    # Save rollback info first (before touching anything).
    ROLLBACK_PATH.write_text(json.dumps({"before": before}, indent=2))
    print(f"\nWrote rollback snapshot -> {ROLLBACK_PATH}")

    # Update fields.
    c.FolderPath = NEW_FOLDER_PATH
    c.FileNameL = new_basename
    db.commit()
    print("Committed.")

    # Re-query to confirm persisted.
    db.close()
    db = Rekordbox6Database()
    c2 = db.get_content(ID=TARGET_ID)
    after = {
        "ID": c2.ID,
        "Title": c2.Title,
        "FolderPath": c2.FolderPath,
        "FileNameL": c2.FileNameL,
        "FileNameS": c2.FileNameS,
    }
    print("\nAFTER (re-read from DB):")
    for k, v in after.items():
        changed = " <-- changed" if before[k] != v else ""
        print(f"  {k:12} {v!r}{changed}")

    db.close()
    if after["FolderPath"] == NEW_FOLDER_PATH and after["FileNameL"] == new_basename:
        print("\nOK: write persisted.")
        return 0
    print("\nFAIL: write did not persist as expected.")
    return 5


if __name__ == "__main__":
    sys.exit(main())
