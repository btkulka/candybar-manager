#!/usr/bin/env python
"""Swap a lossless file in for a Rekordbox entry IN PLACE: same DjmdContent row
(same ID), so cues, loops, Date Added (StockDate), play count, rating, colour,
comments, playlist memberships and MyTags all stay attached.

  upgrade_swap.py preflight [--db PATH]
      {"rekordboxRunning", "processes", "dbFound", "dbPath"}

  upgrade_swap.py read [--db PATH]          stdin: {"ids": [...], "paths": [...]}
      {"rows": {id: row}, "pathOwners": {path: [id, ...]}}
      Read-only (safe while Rekordbox runs). `pathOwners` names the entries
      whose file is each given path, so the caller never points two entries
      at one file.

  upgrade_swap.py align --ffmpeg PATH --original PATH --new PATH [--original-lossy]
      Per-window offsets between the two files (see audio_align.py).

  upgrade_swap.py comment --file AIFF --text TEXT
      Rewrite a new AIFF's comment as a real ID3 COMM frame (needs mutagen).

  upgrade_swap.py apply [--db PATH] --backup-dir DIR [--label L]   stdin: {"items": [...]}
      ONE guarded write session through rbx_safety.run_write_session. Each
      item: {"rbId", "expectBefore": {field: value}, "set": {field: value},
             "cueShiftMs": int, "zeroMpeg": bool, "newLengthMs": int,
             "cuesBefore": [cue snapshot], "contentCueBefore": str | null}
      An item applies all-or-nothing: if any guard disagrees with the live row
      (Rekordbox changed it since the plan), that item is skipped untouched.
      {"items": [{"rbId", "status": written|guard_failed|row_missing|refused, "detail"}],
       "backupPath", "rollbackPath"}

Failures print {"error", "code"} on stdout and exit 1, like the playlist reader.
The DB is only ever written by `apply`, and only through the safety session.
"""
from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from rbx_safety import (  # noqa: E402
    SafetyError,
    SessionAborted,
    open_db,
    rekordbox_processes,
    resolve_db_path,
    run_write_session,
)
import swap_cues  # noqa: E402

# DjmdContent fields a swap may change: the ones that describe the file.
FILE_FIELDS = ("FolderPath", "FileNameL", "FileSize", "FileType", "BitRate", "SampleRate", "BitDepth", "Length", "OrgFolderPath")
# Fields that carry the entry's history and identity. A swap never writes
# them; verification proves they read back unchanged.
KEPT_FIELDS = (
    "ID", "UUID", "StockDate", "DJPlayCount", "Rating", "ColorID", "Commnt", "Title", "ArtistID",
    "AlbumID", "GenreID", "KeyID", "BPM", "AnalysisDataPath", "ImagePath", "DateCreated", "MasterSongID",
)
CUE_KEPT_FIELDS = ("Kind", "Color", "ColorTableIndex", "ActiveLoop", "Comment", "BeatLoopSize", "ContentID", "ContentUUID", "UUID")


def live(row: Any) -> bool:
    return row is not None and not getattr(row, "rb_local_deleted", 0)


def safe(fn, default=""):
    try:
        v = fn()
    except Exception:
        return default
    return default if v is None else v


def path_key(p: str) -> str:
    """macOS volumes (APFS, exFAT) are case-insensitive and paths may arrive in
    either Unicode form: compare them folded."""
    return unicodedata.normalize("NFC", p or "").casefold()


def cue_dict(q: Any) -> dict:
    return {f: getattr(q, f) for f in ("ID", *swap_cues.TIMING_FIELDS, *CUE_KEPT_FIELDS)}


def _tables():
    from pyrekordbox.db6 import tables
    return tables


def cues_of(db, rb_id: str) -> list:
    t = _tables()
    return db.session.query(t.DjmdCue).filter(t.DjmdCue.ContentID == rb_id).all()


def content_cues_of(db, rb_id: str) -> list:
    t = _tables()
    return [r for r in db.session.query(t.ContentCue).filter(t.ContentCue.ContentID == rb_id).all() if live(r)]


def link_counts(db, rb_id: str) -> dict:
    """Playlist and MyTag memberships: a swap must leave both untouched."""
    t = _tables()
    playlists = db.session.query(t.DjmdSongPlaylist).filter(t.DjmdSongPlaylist.ContentID == rb_id).all()
    my_tags = db.session.query(t.DjmdSongMyTag).filter(t.DjmdSongMyTag.ContentID == rb_id).all()
    return {"playlists": sum(1 for s in playlists if live(s)), "myTags": sum(1 for s in my_tags if live(s))}


# ---------- preflight / read ----------

def cmd_preflight(args) -> dict:
    procs = rekordbox_processes()
    try:
        db_path = resolve_db_path(args.db)
        return {"rekordboxRunning": bool(procs), "processes": procs, "dbFound": True, "dbPath": str(db_path)}
    except SafetyError:
        return {"rekordboxRunning": bool(procs), "processes": procs, "dbFound": False, "dbPath": None}


def read_row(db, c) -> dict:
    cues = [cue_dict(q) for q in cues_of(db, c.ID)]
    content_cue = content_cues_of(db, c.ID)
    row = {f: getattr(c, f) for f in (*FILE_FIELDS, *KEPT_FIELDS)}
    row.update({
        "rbId": str(c.ID),
        "artist": safe(lambda: c.ArtistName),
        "album": safe(lambda: c.AlbumName),
        "cues": cues,
        "counts": {**swap_cues.cue_counts(cues), **link_counts(db, c.ID)},
        # More than one contentCue row for a track has never been seen; a swap
        # refuses rather than guess which one Rekordbox reads.
        "contentCueCount": len(content_cue),
        "contentCue": content_cue[0].Cues if len(content_cue) == 1 else None,
    })
    return row


def cmd_read(args, payload: dict) -> dict:
    db = open_db(resolve_db_path(args.db))
    try:
        rows = {}
        for rb_id in payload.get("ids", []):
            c = db.get_content(ID=str(rb_id))
            if live(c):
                rows[str(rb_id)] = read_row(db, c)
        wanted = {path_key(p): p for p in payload.get("paths", []) if p}
        owners: dict[str, list[str]] = {p: [] for p in wanted.values()}
        if wanted:
            for c in db.session.query(_tables().DjmdContent).all():
                if live(c) and c.FolderPath and path_key(c.FolderPath) in wanted:
                    owners[wanted[path_key(c.FolderPath)]].append(str(c.ID))
        return {"rows": rows, "pathOwners": owners}
    finally:
        db.close()


def cmd_comment(args) -> dict:
    """Give a freshly written AIFF a real ID3 COMM frame. ffmpeg can only write
    a comment as TXXX:comment (and an AIFF ANNO chunk), which DJ software
    doesn't read as the comment. Best effort: mutagen isn't one of
    pyrekordbox's dependencies, so without it the file keeps ffmpeg's frame."""
    try:
        from mutagen.aiff import AIFF
        from mutagen.id3 import COMM
    except ImportError:
        return {"ok": False, "reason": "mutagen is not installed in .venv-rbx"}
    f = AIFF(args.file)
    if f.tags is None:
        f.add_tags()
    f.tags.delall("TXXX:comment")
    f.tags.delall("COMM")
    f.tags.add(COMM(encoding=3, lang="eng", desc="", text=[args.text]))
    f.save(v2_version=3)
    return {"ok": True}


def cmd_align(args) -> dict:
    import audio_align
    try:
        return audio_align.align(args.ffmpeg, args.original, args.new, original_lossy=args.original_lossy)
    except audio_align.DecodeError as exc:
        return {"error": f"Couldn't decode the audio ({exc})", "code": "decode"}


# ---------- apply ----------

def cue_guard(current: list[dict], expected: list[dict]) -> str | None:
    cur = {c["ID"]: c for c in current}
    exp = {c["ID"]: c for c in expected}
    if set(cur) != set(exp):
        return "its cue points changed since the plan"
    for cid, e in exp.items():
        for f in ("ID", *swap_cues.TIMING_FIELDS):
            if cur[cid].get(f) != e.get(f):
                return "its cue points changed since the plan"
    return None


class ItemRefused(Exception):
    """One item can't be applied as planned; it is skipped, untouched."""

    def __init__(self, status: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def check_item(db, item: dict):
    """Every guard for one item, before anything is written. Returns the row,
    its cue rows, its contentCue row (or None) and the new cue values; raises
    ItemRefused when the live DB disagrees with the plan."""
    rb_id = str(item["rbId"])
    c = db.get_content(ID=rb_id)
    if not live(c):
        raise ItemRefused("row_missing", "The track is no longer in the collection.")

    expect, to_set = item["expectBefore"], item["set"]
    if not set(to_set) <= set(expect):
        raise ValueError(f"{rb_id}: every field set must have an expectBefore guard")
    if not set(to_set) <= set(FILE_FIELDS):
        raise ValueError(f"{rb_id}: a swap only changes file fields, not {sorted(set(to_set) - set(FILE_FIELDS))}")
    drift = [k for k, v in expect.items() if getattr(c, k) != v]
    if drift:
        raise ItemRefused("guard_failed", f"Rekordbox changed {', '.join(drift)} since the plan.")

    cues = cues_of(db, rb_id)
    msg = cue_guard([cue_dict(q) for q in cues], item.get("cuesBefore", []))
    if msg:
        raise ItemRefused("guard_failed", f"Rekordbox changed {msg}.")
    content_cue = content_cues_of(db, rb_id)
    if len(content_cue) > 1:
        raise ItemRefused("refused", "The track has more than one cue record, so it was left alone.")
    cc_row = content_cue[0] if content_cue else None
    if (cc_row.Cues if cc_row else None) != item.get("contentCueBefore"):
        raise ItemRefused("guard_failed", "Rekordbox changed its cue points since the plan.")

    shift, zero_mpeg = int(item.get("cueShiftMs", 0)), bool(item.get("zeroMpeg"))
    length_ms = item.get("newLengthMs")
    try:
        new_cues = {q.ID: swap_cues.shift_cue(cue_dict(q), shift, zero_mpeg=zero_mpeg, new_length_ms=length_ms) for q in cues}
        cc_after = None
        if cc_row is not None and cc_row.Cues is not None:
            cc_after = json.dumps(
                [swap_cues.shift_json_cue(e, shift, zero_mpeg=zero_mpeg, new_length_ms=length_ms) for e in json.loads(cc_row.Cues)],
                separators=(",", ":"), ensure_ascii=False,
            )
    except swap_cues.CueShiftRefused as exc:
        raise ItemRefused("refused", f"Not swapped: {exc}.")
    return c, cues, cc_row, new_cues, cc_after


def apply_item(db, item: dict) -> tuple[dict, dict | None]:
    """Stage one item's writes in the session. Returns (status, edit-or-None).
    Every guard runs before the first write, so a refused item leaves nothing
    behind in the session."""
    rb_id = str(item["rbId"])
    try:
        c, cues, cc_row, new_cues, cc_after = check_item(db, item)
    except ItemRefused as exc:
        return {"rbId": rb_id, "status": exc.status, "detail": exc.detail}, None

    to_set = item["set"]
    edit = {
        "rbId": rb_id,
        "title": c.Title,
        "content": {"before": {k: getattr(c, k) for k in to_set}, "after": dict(to_set)},
        "kept": {k: getattr(c, k) for k in KEPT_FIELDS},
        "counts": link_counts(db, rb_id),
        "cues": [],
        "contentCue": None,
        "cueShiftMs": int(item.get("cueShiftMs", 0)),
    }

    # Writes. Only fields that change are touched (each set bumps a USN).
    for k, v in to_set.items():
        if getattr(c, k) != v:
            setattr(c, k, v)
    for q in cues:
        before, after = cue_dict(q), new_cues[q.ID]
        for f, v in after.items():
            if before.get(f) != v:
                setattr(q, f, v)
        edit["cues"].append({
            "id": q.ID,
            "before": {f: before.get(f) for f in swap_cues.TIMING_FIELDS},
            "after": {f: after.get(f) for f in swap_cues.TIMING_FIELDS},
            "kept": {f: before.get(f) for f in CUE_KEPT_FIELDS},
        })
    if cc_row is not None and cc_after is not None and cc_after != cc_row.Cues:
        edit["contentCue"] = {"id": cc_row.ID, "before": cc_row.Cues, "after": cc_after}
        cc_row.Cues = cc_after
    return {"rbId": rb_id, "status": "written", "detail": ""}, edit


def _check_cues(db, edit: dict) -> tuple[bool, str]:
    rb_id = edit["rbId"]
    cur = {q.ID: cue_dict(q) for q in cues_of(db, rb_id)}
    want = {e["id"]: e for e in edit["cues"]}
    if set(cur) != set(want):
        return False, f"{rb_id}: cue set changed ({len(cur)} vs {len(want)})"
    for cid, e in want.items():
        for f, v in {**e["after"], **e["kept"]}.items():
            if cur[cid].get(f) != v:
                return False, f"{rb_id}: cue {cid} {f} = {cur[cid].get(f)!r}, expected {v!r}"
    return True, f"{rb_id}: {len(want)} cue(s) as planned"


def verify_checks(result: dict):
    for edit in result["edits"]:
        rb_id = edit["rbId"]

        def check_content(db, edit=edit, rb_id=rb_id):
            c = db.get_content(ID=rb_id)
            if not live(c):
                return False, f"{rb_id}: row missing after commit"
            bad = [k for k, v in edit["content"]["after"].items() if getattr(c, k) != v]
            bad += [k for k, v in edit["kept"].items() if getattr(c, k) != v]
            return not bad, f"{rb_id}: file fields set, history kept" + (f" (drift: {bad})" if bad else "")

        def check_content_cue(db, edit=edit, rb_id=rb_id):
            if edit["contentCue"] is None:
                return True, f"{rb_id}: contentCue untouched"
            rows = [r for r in content_cues_of(db, rb_id) if r.ID == edit["contentCue"]["id"]]
            ok = len(rows) == 1 and rows[0].Cues == edit["contentCue"]["after"]
            return ok, f"{rb_id}: contentCue JSON matches the cue rows"

        def check_links(db, edit=edit, rb_id=rb_id):
            now = link_counts(db, rb_id)
            return now == edit["counts"], f"{rb_id}: {now['playlists']} playlist(s), {now['myTags']} MyTag(s) still attached"

        yield check_content
        yield lambda db, edit=edit: _check_cues(db, edit)
        yield check_content_cue
        yield check_links


def cmd_apply(args, payload: dict) -> dict:
    db_path = resolve_db_path(args.db)
    statuses: list[dict] = []

    def work(db):
        edits = []
        for item in payload.get("items", []):
            status, edit = apply_item(db, item)
            statuses.append(status)
            if edit:
                edits.append(edit)
        return {"operation": "lossless_swap", "edits": edits}

    def on_phase(phase: str) -> None:
        # Progress goes to stderr as JSON lines; stdout carries only the result.
        sys.stderr.write(json.dumps({"progress": phase}) + "\n")
        sys.stderr.flush()

    try:
        result = run_write_session(
            db_path=db_path, backup_dir=Path(args.backup_dir), label=args.label,
            work_fn=work, verify_checks_for=verify_checks, on_phase=on_phase,
        )
    except SessionAborted:
        return {"items": statuses, "backupPath": None, "rollbackPath": None}
    return {"items": statuses, "backupPath": result["backupPath"], "rollbackPath": result["rollbackPath"]}


def main(argv: list[str]) -> dict:
    p = argparse.ArgumentParser(prog="upgrade_swap.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("preflight", "read", "apply"):
        sp = sub.add_parser(name)
        sp.add_argument("--db", default=None, help="master.db to use (default: the active Rekordbox one)")
        if name == "apply":
            sp.add_argument("--backup-dir", required=True)
            sp.add_argument("--label", default="lossless-swap")
    sa = sub.add_parser("align")
    sa.add_argument("--ffmpeg", required=True)
    sa.add_argument("--original", required=True)
    sa.add_argument("--new", required=True)
    sa.add_argument("--original-lossy", action="store_true")
    sc = sub.add_parser("comment")
    sc.add_argument("--file", required=True)
    sc.add_argument("--text", required=True)
    args = p.parse_args(argv[1:])

    if args.cmd == "preflight":
        return cmd_preflight(args)
    if args.cmd == "align":
        return cmd_align(args)
    if args.cmd == "comment":
        return cmd_comment(args)
    payload = json.loads(sys.stdin.read() or "{}")
    if args.cmd == "read":
        return cmd_read(args, payload)
    return cmd_apply(args, payload)


if __name__ == "__main__":
    # Serialize first, write once, so a failure never leaves half a document.
    try:
        out = main(sys.argv)
        text = json.dumps(out, default=str)
    except SafetyError as e:
        sys.stdout.write(json.dumps({"error": str(e), "code": e.code, **e.extra}, default=str))
        sys.exit(1)
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e) or type(e).__name__, "code": "internal"}))
        sys.exit(1)
    sys.stdout.write(text)
    if isinstance(out, dict) and out.get("error"):
        sys.exit(1)
