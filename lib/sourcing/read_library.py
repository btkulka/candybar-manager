#!/usr/bin/env python
"""Dump the library index that playlist-sourcing matches against.

Source of truth order (see the project memory note):
  1. Rekordbox master.db  — the DJ collection. Owning it HERE is what decides
     whether a track needs buying. Read via pyrekordbox (master.db is
     SQLCipher-encrypted; plain sqlite3 cannot open it).
  2. candybar.db library_tracks — the app's scan reflection. Adds files that
     exist on disk but were never imported into Rekordbox, plus the format /
     lossless data Rekordbox doesn't expose conveniently.

A file present on disk but absent from Rekordbox is reported with
in_rekordbox=false so the caller can say "you have the file but it isn't in
your collection" rather than "buy it again".

Emits one JSON object on stdout: {"tracks": [...], "ignored": [...], "stats": {...}}
Never raises for a missing source — a degraded index is reported in `stats`
so the caller can warn instead of silently under-reporting ownership.
"""

import json
import os
import sqlite3
import sys

# The app passes its own candybar.db when its user-data folder isn't the default.
CANDYBAR_DB = os.environ.get("CANDYBAR_DB") or os.path.expanduser(
    "~/Library/Application Support/candybar-manager/candybar.db"
)


def norm_path(p):
    return os.path.normpath(p).lower() if p else ""


def read_rekordbox():
    """Every non-deleted track in the Rekordbox collection."""
    from pyrekordbox import Rekordbox6Database

    db = Rekordbox6Database()
    try:
        return rekordbox_rows(db)
    finally:
        db.close()


def rekordbox_rows(db):
    out = []
    for c in db.get_content():
        # rb_local_deleted rows are tombstones; skip them.
        if getattr(c, "rb_local_deleted", 0):
            continue
        folder = c.FolderPath or ""
        try:
            artist = c.ArtistName or ""
        except Exception:
            artist = ""
        try:
            album = c.AlbumName or ""
        except Exception:
            album = ""
        out.append({
            "artist": artist,
            "title": c.Title or "",
            "album": album,
            "file_path": folder,
            "in_rekordbox": True,
            "rb_id": str(c.ID),
            "bit_depth": getattr(c, "BitDepth", None),
            "sample_rate": getattr(c, "SampleRate", None),
            "bit_rate": getattr(c, "BitRate", None),
            "date_added": str(getattr(c, "StockDate", "") or ""),
        })
    return out


def read_candybar():
    """The app's library scan + the ignore list."""
    if not os.path.exists(CANDYBAR_DB):
        return [], []
    con = sqlite3.connect("file:%s?mode=ro" % CANDYBAR_DB, uri=True)
    con.row_factory = sqlite3.Row
    tracks, ignored = [], []
    try:
        for r in con.execute(
            "SELECT artist, title, album, file_path, container, codec, "
            "bit_depth, sample_rate, bit_rate, lossless, date_added "
            "FROM library_tracks"
        ):
            tracks.append({
                "artist": r["artist"] or "",
                "title": r["title"] or "",
                "album": r["album"] or "",
                "file_path": r["file_path"] or "",
                "in_rekordbox": False,
                "container": r["container"],
                "codec": r["codec"],
                "bit_depth": r["bit_depth"],
                "sample_rate": r["sample_rate"],
                "bit_rate": r["bit_rate"],
                "lossless": bool(r["lossless"]) if r["lossless"] is not None else None,
                "date_added": r["date_added"],
            })
    except sqlite3.Error as e:
        print("candybar library_tracks read failed: %s" % e, file=sys.stderr)
    try:
        ignored = [r[0] for r in con.execute("SELECT key FROM ignored_tracks")]
    except sqlite3.Error:
        pass
    con.close()
    return tracks, ignored


def main():
    stats = {"rekordbox": 0, "candybar": 0, "disk_only": 0, "errors": []}

    try:
        rb = read_rekordbox()
        stats["rekordbox"] = len(rb)
    except Exception as e:
        rb = []
        stats["errors"].append("rekordbox: %s" % e)

    try:
        cb, ignored = read_candybar()
        stats["candybar"] = len(cb)
    except Exception as e:
        cb, ignored = [], []
        stats["errors"].append("candybar: %s" % e)

    # Rekordbox rows win on path collision; candybar rows then contribute both
    # the disk-only tracks and the format data Rekordbox lacks.
    by_path = {}
    for t in rb:
        by_path[norm_path(t["file_path"])] = t
    for t in cb:
        k = norm_path(t["file_path"])
        if k and k in by_path:
            for field in ("container", "codec", "lossless"):
                if t.get(field) is not None:
                    by_path[k][field] = t[field]
        else:
            by_path[k or ("cb:%d" % len(by_path))] = t
            stats["disk_only"] += 1

    tracks = [t for t in by_path.values() if t["artist"] or t["title"]]
    # One write of a finished document: never half a JSON object on stdout.
    sys.stdout.write(json.dumps({"tracks": tracks, "ignored": ignored, "stats": stats}))


if __name__ == "__main__":
    main()
