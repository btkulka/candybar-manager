#!/usr/bin/env python
"""Read playlists out of the live Rekordbox collection (master.db via pyrekordbox).

  read_rekordbox_playlists.py list
      {"playlists": [{"id", "name", "path", "kind", "count"}, ...]}
      Regular (Attribute 0) and smart (Attribute 4) playlists in tree order.
      Folders only contribute to `path`; the cloud-sync trial row is skipped.
      A smart playlist not counted within the time budget has "countUnknown".

  read_rekordbox_playlists.py tracks <playlist id>
      {"playlist": {...}, "tracks": [entry, ...], "collection": [entry, ...]}
      `tracks` is the playlist in its own order. `collection` is every live
      entry in the collection, so the caller can spot a lossless copy of a
      lossy playlist entry that is already owned.

Read-only: no write session is opened, so this is safe while Rekordbox runs.
Failures are reported as {"error": "..."} on stdout with exit status 1, so the
caller can show the message instead of a stack trace.
"""

import json
import sys
import time

PLAYLIST, FOLDER, SMART = 0, 1, 4

# The app gives the whole read 120 s. Counting a smart playlist runs its rules,
# which can be slow on a big collection, so `list` stops counting them once
# this much time has gone and marks the rest "countUnknown".
SMART_COUNT_BUDGET_S = 60


def safe(fn, default=""):
    """Relationship properties (ArtistName, AlbumName) raise when the linked
    row is missing; treat that as blank."""
    try:
        v = fn()
    except Exception:
        return default
    return default if v is None else v


def entry(c):
    return {
        "rbId": str(c.ID),
        "artist": safe(lambda: c.ArtistName),
        "title": c.Title or "",
        "album": safe(lambda: c.AlbumName),
        "filePath": c.FolderPath or "",
        "fileType": c.FileType,
        "bitRate": c.BitRate or 0,
        "sampleRate": c.SampleRate or 0,
        "bitDepth": c.BitDepth or 0,
        "length": c.Length or 0,
    }


def live(row):
    return not getattr(row, "rb_local_deleted", 0)


def playlists_in_tree_order(db):
    """(playlist, folder path) for every pickable playlist, depth-first by Seq."""
    rows = [p for p in db.get_playlist() if live(p)]
    children = {}
    for p in rows:
        children.setdefault(str(p.ParentID), []).append(p)
    for kids in children.values():
        kids.sort(key=lambda p: (p.Seq or 0, p.Name or ""))

    out = []

    def walk(parent_id, trail):
        for p in children.get(parent_id, []):
            if p.Attribute == FOLDER:
                walk(str(p.ID), trail + [p.Name or ""])
            elif p.Attribute in (PLAYLIST, SMART):
                out.append((p, " / ".join(trail)))

    walk("root", [])
    return out


def smart_contents(db, p):
    """A smart playlist's live entries. pyrekordbox translates the smart rules
    to SQL itself and can't do all of them (0.4.4 fails on date rules such as
    "added in the last N months"), so that failure gets a readable reason."""
    try:
        return [c for c in db.get_playlist_contents(p) if live(c)]
    except Exception as e:
        raise RuntimeError("pyrekordbox can't evaluate this smart playlist's rules (%s)" % e)


def summary(db, p, path, song_counts, deadline):
    out = {
        "id": str(p.ID),
        "name": p.Name or "",
        "path": path,
        "kind": "smart" if p.Attribute == SMART else "playlist",
        "count": song_counts.get(str(p.ID), 0),
    }
    if p.Attribute == SMART:
        if time.monotonic() > deadline:
            out["count"] = 0
            out["countUnknown"] = True
            return out
        try:
            out["count"] = len(smart_contents(db, p))
        except RuntimeError as e:
            out["count"] = 0
            out["unreadable"] = str(e)
    return out


def regular_song_counts(db):
    """Entries per regular playlist, counting only rows that still point at a
    live track — the same rows `tracks` will return — so an emptied playlist
    reads as empty rather than pickable."""
    live_ids = {str(c.ID) for c in db.get_content() if live(c)}
    counts = {}
    for s in db.get_playlist_songs():
        if live(s) and str(s.ContentID) in live_ids:
            counts[str(s.PlaylistID)] = counts.get(str(s.PlaylistID), 0) + 1
    return counts


def cmd_list(db):
    counts = regular_song_counts(db)
    deadline = time.monotonic() + SMART_COUNT_BUDGET_S
    return {"playlists": [summary(db, p, path, counts, deadline) for p, path in playlists_in_tree_order(db)]}


def cmd_tracks(db, playlist_id):
    found = [(p, path) for p, path in playlists_in_tree_order(db) if str(p.ID) == playlist_id]
    if not found:
        raise LookupError("No playlist with id %s in the Rekordbox collection" % playlist_id)
    p, path = found[0]

    if p.Attribute == SMART:
        contents = smart_contents(db, p)
    else:
        songs = [s for s in db.get_playlist_songs(PlaylistID=p.ID) if live(s)]
        songs.sort(key=lambda s: s.TrackNo or 0)
        contents = [s.Content for s in songs if s.Content is not None and live(s.Content)]

    tracks = [entry(c) for c in contents]
    collection = [entry(c) for c in db.get_content() if live(c)]
    return {
        "playlist": {
            "id": str(p.ID),
            "name": p.Name or "",
            "path": path,
            "kind": "smart" if p.Attribute == SMART else "playlist",
            "count": len(tracks),
        },
        "tracks": tracks,
        "collection": collection,
    }


def main(argv):
    if len(argv) < 2 or argv[1] not in ("list", "tracks") or (argv[1] == "tracks" and len(argv) < 3):
        raise ValueError("usage: read_rekordbox_playlists.py list | tracks <playlist id>")
    try:
        from pyrekordbox import Rekordbox6Database
    except ImportError:
        raise RuntimeError(
            "pyrekordbox isn't installed for %s. Run scripts/install.sh again "
            "to set it up in the repo's .venv-rbx." % sys.executable
        )
    db = Rekordbox6Database()
    try:
        return cmd_list(db) if argv[1] == "list" else cmd_tracks(db, argv[2])
    finally:
        db.close()


if __name__ == "__main__":
    # Serialize first, write once: a failure part-way through never leaves half
    # a document on stdout for the caller to choke on.
    try:
        out = json.dumps(main(sys.argv))
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e) or type(e).__name__}))
        sys.exit(1)
    sys.stdout.write(out)
