"""End to end on a COPY of master.db: swap an existing MP3 entry (with cues)
onto a synthetic AIFF through `upgrade_swap.py apply`, then prove the entry is
the same row with the same history and its cues moved by exactly the shift.

The live DB is only read (copied); every write goes to the copy in a temp
folder, which is deleted afterwards. Skipped when there is no Rekordbox
collection on this machine or Rekordbox is running.

    .venv-rbx/bin/python -m unittest lib/rekordbox/tests/test_upgrade_swap_e2e.py
    RBX_SOURCE_DB=/path/to/some/master.db ...   # copy this one instead
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIB = HERE.parent
sys.path.insert(0, str(LIB))

import rbx_safety  # noqa: E402
import swap_cues  # noqa: E402

SCRIPT = LIB / "upgrade_swap.py"
FFMPEG = os.environ.get("FFMPEG") or str(LIB.parents[1] / "node_modules" / "ffmpeg-static" / "ffmpeg")
SHIFT_MS = -25
LIVE_DIRS = (rbx_safety.RB6_DIR, rbx_safety.RB7_DIR)


def source_db():
    p = os.environ.get("RBX_SOURCE_DB")
    return Path(p) if p else rbx_safety.detect_db_path()


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(cmd, db, payload=None, *extra):
    out = subprocess.run(
        [sys.executable, str(SCRIPT), cmd, "--db", str(db), *extra],
        input=json.dumps(payload) if payload is not None else None, capture_output=True, text=True,
    )
    return json.loads(out.stdout), out.returncode


SRC = source_db()


@unittest.skipUnless(SRC and SRC.exists(), "no Rekordbox collection to copy")
@unittest.skipIf(rbx_safety.rekordbox_processes(), "Rekordbox is running")
@unittest.skipUnless(Path(FFMPEG).exists(), "ffmpeg-static not installed")
class SwapOnCopy(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swap-e2e-"))
        self.db = self.tmp / "master.db"
        shutil.copy2(SRC, self.db)
        # Belt and braces: everything below writes only inside self.tmp.
        for live in LIVE_DIRS:
            self.assertFalse(str(self.db.resolve()).startswith(str(live.resolve())))
        self.backups = self.tmp / "backups"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def pick_mp3_with_cues(self):
        db = rbx_safety.open_db(self.db)
        try:
            from pyrekordbox.db6 import tables as t
            best = None
            for c in db.session.query(t.DjmdContent).filter(t.DjmdContent.FileType == 1).all():
                if getattr(c, "rb_local_deleted", 0):
                    continue
                cues = db.session.query(t.DjmdCue).filter(t.DjmdCue.ContentID == c.ID).all()
                cc = db.session.query(t.ContentCue).filter(t.ContentCue.ContentID == c.ID).all()
                if len(cues) < 3 or len(cc) != 1 or not any(q.InMpegFrame for q in cues):
                    continue
                score = (any(q.OutMsec >= 0 for q in cues), any(0 < q.InMsec < 25 for q in cues), len(cues))
                if best is None or score > best[0]:
                    best = (score, str(c.ID))
            return best[1] if best else None
        finally:
            db.close()

    def make_aiff(self, seconds: int) -> Path:
        out = self.tmp / "Library" / "Some Artist" / "Some Track.aif"
        out.parent.mkdir(parents=True)
        subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                        f"anoisesrc=d={seconds}:c=pink:a=0.1:r=44100", "-ac", "2",
                        "-c:a", "pcm_s16be", str(out)], check=True)
        return out

    def apply_item(self, row: dict, new_file: Path, seconds: int) -> dict:
        """What rekordboxUpgradeSwap.buildApplyItem sends for this row."""
        set_ = {
            "FolderPath": str(new_file), "FileNameL": new_file.name, "FileSize": new_file.stat().st_size,
            "FileType": 12, "BitRate": 1411, "SampleRate": 44100, "BitDepth": 16,
        }
        expect = {k: row[k] for k in ("StockDate", "DJPlayCount", "Rating", "ColorID", "UUID")}
        expect.update({k: row[k] for k in set_})
        return {
            "rbId": row["rbId"], "expectBefore": expect, "set": set_, "cueShiftMs": SHIFT_MS,
            "zeroMpeg": True, "newLengthMs": seconds * 1000,
            "cuesBefore": row["cues"], "contentCueBefore": row["contentCue"],
        }

    def test_swap_keeps_the_row_and_moves_every_cue(self):
        rb_id = self.pick_mp3_with_cues()
        if not rb_id:
            self.skipTest("no MP3 entry with cues in this collection")
        before, code = run("read", self.db, {"ids": [rb_id], "paths": []})
        self.assertEqual(code, 0, before)
        row = before["rows"][rb_id]
        seconds = int(row["Length"]) + 2
        new_file = self.make_aiff(seconds)
        pre_sha = sha(self.db)

        result, code = run("apply", self.db, {"items": [self.apply_item(row, new_file, seconds)]},
                           "--backup-dir", str(self.backups), "--label", "e2e")
        self.assertEqual(code, 0, result)
        self.assertEqual(result["items"], [{"rbId": rb_id, "status": "written", "detail": ""}])
        # The snapshot is the pre-session DB, byte for byte; the audit log is beside it.
        self.assertEqual(sha(Path(result["backupPath"])), pre_sha)
        audit = json.loads(Path(result["rollbackPath"]).read_text())
        self.assertEqual(audit["edits"][0]["rbId"], rb_id)

        after, _ = run("read", self.db, {"ids": [rb_id], "paths": [str(new_file)]})
        new = after["rows"][rb_id]
        self.assertEqual(after["pathOwners"][str(new_file)], [rb_id])
        # Same row, same identity and history.
        for k in ("ID", "UUID", "StockDate", "DJPlayCount", "Rating", "ColorID", "Commnt", "Title",
                  "ArtistID", "AlbumID", "AnalysisDataPath", "ImagePath", "DateCreated"):
            self.assertEqual(new[k], row[k], k)
        self.assertEqual(new["counts"], row["counts"])
        # The file fields describe the AIFF now.
        self.assertEqual((new["FolderPath"], new["FileNameL"], new["FileType"], new["BitRate"], new["BitDepth"]),
                         (str(new_file), new_file.name, 12, 1411, 16))
        self.assertEqual(new["FileSize"], new_file.stat().st_size)
        # Every cue: same ID and kind, moved by exactly SHIFT_MS (pinned at 0 if
        # it would cross it), frames recomputed, MPEG fields cleared.
        old_cues = {c["ID"]: c for c in row["cues"]}
        new_cues = {c["ID"]: c for c in new["cues"]}
        self.assertEqual(set(old_cues), set(new_cues))
        for cid, o in old_cues.items():
            n = new_cues[cid]
            want_in = o["InMsec"] + SHIFT_MS
            pinned = want_in < 0
            self.assertEqual(n["InMsec"], 0 if pinned else want_in, cid)
            self.assertEqual(n["InFrame"], swap_cues.frame_of(n["InMsec"]))
            self.assertEqual(n["CueMicrosec"], 0 if pinned else o["CueMicrosec"])
            if o["OutMsec"] >= 0:
                self.assertEqual(n["OutMsec"], o["OutMsec"] + SHIFT_MS)
                self.assertEqual(n["OutFrame"], swap_cues.frame_of(n["OutMsec"]))
            else:
                self.assertEqual((n["OutMsec"], n["OutFrame"]), (-1, 0))
            for f in swap_cues.MPEG_FIELDS:
                self.assertEqual(n[f], 0)
            for f in ("Kind", "Color", "ColorTableIndex", "ActiveLoop", "BeatLoopSize", "ContentUUID", "UUID"):
                self.assertEqual(n[f], o[f], f)
        # contentCue's JSON copy says the same as the cue rows.
        for e in json.loads(new["contentCue"]):
            n = new_cues.get(e["ID"])
            if n:
                self.assertEqual((e["InMsec"], e["InFrame"], e["InMpegFrame"]), (n["InMsec"], n["InFrame"], 0))

        # Re-running the same plan: every guard now disagrees, so nothing is written.
        again, code = run("apply", self.db, {"items": [self.apply_item(row, new_file, seconds)]},
                          "--backup-dir", str(self.backups), "--label", "e2e")
        self.assertEqual(code, 0, again)
        self.assertEqual(again["items"][0]["status"], "guard_failed")
        self.assertIsNone(again["rollbackPath"])

    def test_failed_verification_puts_the_snapshot_back(self):
        pre_sha = sha(self.db)

        def work(db):
            from pyrekordbox.db6 import tables as t
            c = db.session.query(t.DjmdContent).first()
            c.DJPlayCount = (c.DJPlayCount or 0) + 1
            return {"edits": [{"rbId": c.ID}]}

        with self.assertRaises(rbx_safety.SafetyError) as ctx:
            rbx_safety.run_write_session(
                db_path=self.db, backup_dir=self.backups, label="e2e-verify",
                work_fn=work, verify_checks_for=lambda r: [lambda db: (False, "forced failure")],
            )
        self.assertEqual(ctx.exception.code, "verify-failed")
        self.assertEqual(sha(self.db), pre_sha)
        self.assertTrue(Path(ctx.exception.extra["rollbackPath"]).name.endswith(".reverted.json"))

    def test_refuses_while_rekordbox_runs_and_touches_nothing(self):
        pre_sha = sha(self.db)
        real = rbx_safety.rekordbox_processes
        rbx_safety.rekordbox_processes = lambda: ["123 rekordbox"]
        try:
            with self.assertRaises(rbx_safety.SafetyError) as ctx:
                rbx_safety.run_write_session(
                    db_path=self.db, backup_dir=self.backups, label="e2e-running",
                    work_fn=lambda db: {"edits": [1]}, verify_checks_for=lambda r: [],
                )
        finally:
            rbx_safety.rekordbox_processes = real
        self.assertEqual(ctx.exception.code, "rekordbox-running")
        self.assertEqual(sha(self.db), pre_sha)
        self.assertFalse(self.backups.exists())


if __name__ == "__main__":
    unittest.main()
