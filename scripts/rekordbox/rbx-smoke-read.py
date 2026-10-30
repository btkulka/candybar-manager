"""Read-only smoke test for pyrekordbox against the user's Rekordbox 6.8.5 master.db.

Verifies:
  1. SQLCipher key works on this Rekordbox version (6.8.5, past the 6.7.7 tested baseline).
  2. We can iterate DjmdContent and read track rows.
  3. TrackIDs from our dedupe XML report correspond to rows we can locate in master.db.
  4. What field(s) hold the file path so we know what to write later.

Does not modify anything. Prints a structured report.
"""
import json
import sys
from pathlib import Path

from pyrekordbox import Rekordbox6Database

REPO = Path(__file__).resolve().parent
# Latest JSON report from the dedupe dry-run:
REPORT = Path(
    "/Volumes/Time Machin/rekordbox/dedupe-report-2026-04-23T00-30-45-542Z.json"
)


def main() -> int:
    print(f"Opening Rekordbox master.db...")
    db = Rekordbox6Database()

    # Basic sanity: count tracks.
    contents = list(db.get_content())
    print(f"  Total DjmdContent rows: {len(contents)}")
    if not contents:
        print("  ERROR: no rows read. Key or schema mismatch.")
        return 1

    # Show the first row's available attributes so we know the field names.
    sample = contents[0]
    print(f"\nFirst row attributes (subset):")
    interesting = [
        "ID", "Title", "FolderPath", "FileNameL", "FileNameS",
        "FileSize", "DateCreated", "ArtistID",
    ]
    for attr in interesting:
        val = getattr(sample, attr, "<missing>")
        print(f"  {attr:15} {val!r}")

    # Cross-reference with our dedupe report.
    if not REPORT.exists():
        print(f"\nReport not found: {REPORT}. Skipping cross-ref.")
        return 0

    report = json.loads(REPORT.read_text())
    relocations = report.get("relocations", [])
    losers = report.get("losers", [])
    print(
        f"\nReport has {len(relocations)} relocations, {len(losers)} losers."
    )

    # Build an ID->content map once for speed.
    by_id = {str(c.ID): c for c in contents}

    # Check 5 relocation TrackIDs resolve in master.db.
    hits = 0
    misses = []
    for r in relocations[:5]:
        tid = str(r["trackId"])
        c = by_id.get(tid)
        if c is None:
            misses.append(tid)
            continue
        hits += 1
        print(
            f"\nRELOCATION #{r['trackId']}: {r['artist']} - {r['title']}"
        )
        print(f"  DB Title:      {c.Title!r}")
        print(f"  DB FolderPath: {c.FolderPath!r}")
        print(f"  XML oldPath:   {r['oldPath']!r}")
        print(f"  Target newPath:{r['newPath']!r}")

    # Check 3 loser TrackIDs.
    for l in losers[:3]:
        tid = str(l["trackId"])
        c = by_id.get(tid)
        if c is None:
            misses.append(tid)
            continue
        hits += 1
        print(f"\nLOSER #{l['trackId']}: {l['artist']} - {l['title']}")
        print(f"  DB Title:      {c.Title!r}")
        print(f"  DB FolderPath: {c.FolderPath!r}")

    print(f"\nTrackID lookups: {hits} hit, {len(misses)} missed")
    if misses:
        print(f"  missed IDs: {misses}")

    # Not strictly required, but be clean.
    db.close()
    print("\nOK: read-only smoke test completed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
