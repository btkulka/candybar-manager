"""The write-safety ceremony for Rekordbox's master.db, for the app.

Ported from the rekordbox-write skill's _rbx_safety.py (the app must not
depend on ~/.claude at runtime). Every write the app makes to master.db goes
through run_write_session(), which keeps the skill's guarantees:

    refuse if Rekordbox is running -> byte-exact snapshot of master.db,
    SHA-256 verified, before the DB is opened -> ONE session for every edit ->
    rollback/audit JSON written BEFORE commit -> one commit -> close ->
    reopen fresh and verify every edit -> if verification fails, refuse again
    if Rekordbox is now running, else restore the snapshot over master.db.

Differences from the skill, all deliberate:
  - Failures raise SafetyError(code, message) instead of sys.exit(), so the
    caller can report them as JSON for the app to show.
  - The DB path can be given explicitly (tests run against a copy); without it
    the active Rekordbox folder is detected the way the skill does.
  - The audit JSON goes beside the snapshot in the backup folder.
  - pyrekordbox's commit() also rewrites masterPlaylists6.xml whenever a
    playlist's timestamp drifted. The swap edits no playlists, so that sync is
    switched off for the write session: nothing outside master.db is touched.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

RB6_DIR = Path.home() / "Library" / "Pioneer" / "rekordbox"
RB7_DIR = Path.home() / "Library" / "Pioneer" / "rekordbox7"

VerifyCheck = Callable[[Any], "tuple[bool, str]"]


class SafetyError(Exception):
    """A refusal or failure the caller reports as-is. `code` is machine-readable:
    rekordbox-running, no-db, backup-dir, backup-mismatch, commit-failed,
    verify-failed, restore-failed."""

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.extra = extra


class SessionAborted(Exception):
    """The work function produced no edits; nothing was committed."""


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")


def rekordbox_processes() -> list[str]:
    """Running processes whose BINARY is Rekordbox's: the app, rekordboxAgent and
    any helper inside a rekordbox*.app bundle, matched on the executable's real
    path (or, when that can't be read, the name it was started as).

    The skill matched whole command lines (pgrep -if), which also refuses
    whenever a shell or script merely mentions "rekordbox" in its arguments,
    and `ps comm` shows process titles a program can set itself. Both misfired
    while testing this: another tool's shell command naming a rekordbox XML
    file, and a test runner titled after rekordboxUpgradeSwap.e2e.test.ts."""
    import psutil  # a pyrekordbox dependency

    procs = []
    for p in psutil.process_iter():
        try:
            try:
                exe = p.exe()
            except (psutil.AccessDenied, psutil.ZombieProcess, OSError):
                exe = ""
            label = exe or p.name()
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            # Not even its name is readable: another user's process, which a
            # Rekordbox run by this user never is.
            continue
        if "rekordbox" in label.lower():
            procs.append(f"{p.pid} {label}")
    return procs


def assert_rekordbox_closed() -> None:
    """Refuse while Rekordbox runs: a write could be corrupted, or overwritten by
    Rekordbox's own autosave on its next tick. Non-negotiable."""
    procs = rekordbox_processes()
    if procs:
        raise SafetyError(
            "rekordbox-running",
            "Rekordbox is running. Quit Rekordbox (and rekordboxAgent) first, then try again.",
            processes=procs,
        )


def detect_db_path() -> Optional[Path]:
    """master.db in whichever of rekordbox/ and rekordbox7/ was written last."""
    candidates = [p / "master.db" for p in (RB6_DIR, RB7_DIR) if (p / "master.db").exists()]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def resolve_db_path(db_path: Optional[str]) -> Path:
    path = Path(db_path) if db_path else detect_db_path()
    if path is None or not path.exists():
        raise SafetyError("no-db", "Couldn't find Rekordbox's collection (master.db).")
    return path


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def take_session_backup(db_path: Path, backup_dir: Path, label: str) -> Path:
    """Byte-exact copy of master.db, SHA-256 and size verified, before the DB is
    opened. Any mismatch deletes the copy and aborts."""
    try:
        backup_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise SafetyError("backup-dir", f"Couldn't create the backup folder {backup_dir}: {exc}")
    if not os.access(backup_dir, os.W_OK):
        raise SafetyError("backup-dir", f"The backup folder isn't writable: {backup_dir}")
    backup_path = backup_dir / f"master-session-{label}-{utc_stamp()}.db"
    shutil.copy2(db_path, backup_path)
    src_sha, dst_sha = sha256_file(db_path), sha256_file(backup_path)
    if src_sha != dst_sha or db_path.stat().st_size != backup_path.stat().st_size:
        backup_path.unlink(missing_ok=True)
        raise SafetyError("backup-mismatch", "The backup copy of master.db didn't match the original, so nothing was changed.")
    return backup_path


def restore_backup_file(backup_path: Path, db_path: Path) -> None:
    """Put the snapshot back over master.db. Refuses (again) if Rekordbox is now
    running. Copies to a temp name, verifies, then renames, so a kill mid-copy
    never leaves a truncated master.db."""
    assert_rekordbox_closed()
    if not backup_path.exists():
        raise SafetyError("restore-failed", f"The session backup vanished ({backup_path}); master.db could not be restored.")
    tmp = db_path.with_suffix(db_path.suffix + ".restore-tmp")
    shutil.copy2(backup_path, tmp)
    if sha256_file(tmp) != sha256_file(backup_path):
        tmp.unlink(missing_ok=True)
        raise SafetyError("restore-failed", "The restore copy didn't verify; master.db was left as it is.")
    os.replace(tmp, db_path)


def open_db(db_path: Path, *, sync_playlist_xml: bool = True):
    from pyrekordbox import Rekordbox6Database

    db = Rekordbox6Database(path=str(db_path))
    if not sync_playlist_xml:
        db.playlist_xml = None
    return db


def run_write_session(
    *,
    db_path: Path,
    backup_dir: Path,
    label: str,
    work_fn: Callable[[Any], dict],
    verify_checks_for: Callable[[dict], Iterable[VerifyCheck]],
    on_phase: Callable[[str], None] = lambda phase: None,
) -> dict:
    """Atomic write session: snapshot, one session, audit JSON, one commit,
    reopen and verify, restore on failure.

    work_fn(db) does every write in the session it is given (no commit, no
    close) and returns a dict with at least {"edits": [...]}. An exception in
    it rolls the session back; the file on disk was never touched.

    verify_checks_for(result) yields checks (db) -> (ok, message) that run on a
    freshly opened DB after the commit. Any failure restores the snapshot and
    raises SafetyError("verify-failed").

    on_phase(name) is told "snapshot", "writing", "verifying" and, only on a
    failed verification, "restoring", for progress reporting.

    Returns work_fn's dict plus backupPath and rollbackPath.
    """
    assert_rekordbox_closed()
    on_phase("snapshot")
    backup_path = take_session_backup(db_path, backup_dir, label)

    on_phase("writing")
    db = open_db(db_path, sync_playlist_xml=False)
    try:
        result = work_fn(db)
    except Exception:
        try:
            db.session.rollback()
        finally:
            db.close()
        raise

    edits = result.get("edits") if isinstance(result, dict) else None
    if not edits:
        db.session.rollback()
        db.close()
        raise SessionAborted("no edits to commit")

    # The audit trail goes down before the commit, so even a commit that dies
    # half-way leaves a record of what was attempted.
    stamp = utc_stamp()
    rollback_path = backup_dir / f"rbx-rollback-{label}-{stamp}.json"
    payload = {"stamp": stamp, "label": label, "backup": str(backup_path), "dbPath": str(db_path), **result}
    rollback_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str))

    try:
        # The guard the skill relies on runs again inside pyrekordbox's commit.
        db.commit()
    except Exception as exc:
        try:
            db.session.rollback()
        finally:
            db.close()
        failed_path = rollback_path.with_suffix(".commit-failed.json")
        rollback_path.rename(failed_path)
        raise SafetyError("commit-failed", f"Rekordbox's collection couldn't be saved ({exc}); nothing was changed.",
                          rollbackPath=str(failed_path), backupPath=str(backup_path))
    db.close()

    on_phase("verifying")
    failed: list[str] = []
    db2 = open_db(db_path)
    try:
        for check in verify_checks_for(result):
            ok, msg = check(db2)
            if not ok:
                failed.append(msg)
    finally:
        db2.close()

    if failed:
        on_phase("restoring")
        try:
            restore_backup_file(backup_path, db_path)
        except SafetyError as exc:
            raise SafetyError(
                "restore-failed",
                f"The changes didn't read back correctly and the backup couldn't be put back ({exc}). "
                f"Keep Rekordbox closed and copy {backup_path} over {db_path}.",
                failures=failed[:20], rollbackPath=str(rollback_path), backupPath=str(backup_path),
            )
        reverted_path = rollback_path.with_suffix(".reverted.json")
        rollback_path.rename(reverted_path)
        raise SafetyError(
            "verify-failed",
            "The changes didn't read back correctly, so Rekordbox's collection was restored from the backup taken just before.",
            failures=failed[:20], rollbackPath=str(reverted_path), backupPath=str(backup_path),
        )

    return {**result, "backupPath": str(backup_path), "rollbackPath": str(rollback_path)}
