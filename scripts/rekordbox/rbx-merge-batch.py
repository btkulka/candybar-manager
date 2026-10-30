"""Batch merge-and-delete for all duplicate clusters in the dedupe report.

For each cluster (winner + one or more losers):
  1. If winner.FolderPath is missing on disk AND some loser.FolderPath exists,
     swap winner's path to that loser's path (preserves winner's cues/data).
  2. Merge each loser's data INTO the winner:
       - Cues: migrate loser cues that don't clash (by Kind + InMsec±50ms)
               with an existing winner cue. Reparent ContentID + ContentUUID.
               Drop clashing loser cues.
       - Play count: sum into winner.
       - Rating: max.
       - Playlist memberships: union (migrate loser's into winner, drop if
         winner is already in that playlist).
       - MyTag memberships: union (same rule).
  3. Delete the loser.

Commits once per cluster so a mid-batch failure leaves a recoverable state.
Accepts --dry-run to report what would happen without writing.
Accepts --limit N to process only the first N clusters (for a smoke test).
Accepts --only-winner-id X to process only the cluster whose winner is X.
"""
import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

from pyrekordbox import Rekordbox6Database
from pyrekordbox.db6 import tables

REPORT = Path(
    "/Volumes/Time Machin/rekordbox/dedupe-report-2026-04-23T00-30-45-542Z.json"
)
CUE_POSITION_EPSILON_MS = 50


def assert_rekordbox_closed() -> None:
    out = subprocess.run(
        ["pgrep", "-if", "rekordbox"], capture_output=True, text=True
    )
    if out.stdout.strip():
        print(f"ERROR: Rekordbox is running:\n{out.stdout}")
        sys.exit(2)


def cue_key(cue) -> tuple:
    return (cue.Kind, round((cue.InMsec or 0) / CUE_POSITION_EPSILON_MS))


def process_cluster(db, winner_id: str, loser_ids: list[str], dry_run: bool) -> dict:
    stats = {
        "winner_id": winner_id,
        "loser_ids": loser_ids,
        "losers_deleted": 0,
        "losers_missing_from_db": 0,
        "cues_migrated": 0,
        "cues_discarded_clash": 0,
        "plays_added": 0,
        "rating_raised": False,
        "playlists_migrated": 0,
        "playlists_discarded_dup": 0,
        "mytags_migrated": 0,
        "mytags_discarded_dup": 0,
        "path_relocated": False,
        "relocated_from": None,
    }

    winner = db.get_content(ID=winner_id)
    if winner is None:
        stats["error"] = f"winner {winner_id} not in DB"
        return stats

    winner_uuid = getattr(winner, "UUID", None) or getattr(winner, "ContentUUID", None)

    # Index winner's existing cues so we can detect clashes.
    winner_cues = db.session.query(tables.DjmdCue).filter_by(ContentID=winner_id).all()
    occupied_keys = {cue_key(c) for c in winner_cues}

    # Index winner's existing playlist + mytag memberships.
    winner_playlist_ids = {
        p.PlaylistID for p in db.session.query(tables.DjmdSongPlaylist).filter_by(ContentID=winner_id).all()
    }
    winner_mytag_ids = {
        m.MyTagID for m in db.session.query(tables.DjmdSongMyTag).filter_by(ContentID=winner_id).all()
    }

    for lid in loser_ids:
        loser = db.get_content(ID=lid)
        if loser is None:
            stats["losers_missing_from_db"] += 1
            continue

        # Path swap: only if winner's path is missing and this loser's path exists.
        if (
            not stats["path_relocated"]
            and winner.FolderPath
            and not os.path.exists(winner.FolderPath)
            and loser.FolderPath
            and os.path.exists(loser.FolderPath)
        ):
            if not dry_run:
                winner.FolderPath = loser.FolderPath
                winner.FileNameL = os.path.basename(loser.FolderPath)
            stats["path_relocated"] = True
            stats["relocated_from"] = loser.FolderPath

        # Cues
        loser_cues = db.session.query(tables.DjmdCue).filter_by(ContentID=lid).all()
        for cue in loser_cues:
            key = cue_key(cue)
            if key in occupied_keys:
                stats["cues_discarded_clash"] += 1
                if not dry_run:
                    db.session.delete(cue)
            else:
                stats["cues_migrated"] += 1
                if not dry_run:
                    cue.ContentID = winner_id
                    if winner_uuid is not None:
                        cue.ContentUUID = winner_uuid
                occupied_keys.add(key)

        # Play count
        l_plays = int(getattr(loser, "DJPlayCount", 0) or 0)
        if l_plays > 0:
            stats["plays_added"] += l_plays
            if not dry_run:
                w_plays = int(getattr(winner, "DJPlayCount", 0) or 0)
                winner.DJPlayCount = w_plays + l_plays

        # Rating
        l_rating = int(getattr(loser, "Rating", 0) or 0)
        if l_rating > 0:
            w_rating = int(getattr(winner, "Rating", 0) or 0)
            if l_rating > w_rating:
                stats["rating_raised"] = True
                if not dry_run:
                    winner.Rating = l_rating

        # Playlists
        loser_pl_refs = db.session.query(tables.DjmdSongPlaylist).filter_by(ContentID=lid).all()
        for ref in loser_pl_refs:
            pid = ref.PlaylistID
            if pid in winner_playlist_ids:
                stats["playlists_discarded_dup"] += 1
                if not dry_run:
                    db.session.delete(ref)
            else:
                stats["playlists_migrated"] += 1
                if not dry_run:
                    ref.ContentID = winner_id
                winner_playlist_ids.add(pid)

        # MyTags
        loser_mt_refs = db.session.query(tables.DjmdSongMyTag).filter_by(ContentID=lid).all()
        for ref in loser_mt_refs:
            mid = ref.MyTagID
            if mid in winner_mytag_ids:
                stats["mytags_discarded_dup"] += 1
                if not dry_run:
                    db.session.delete(ref)
            else:
                stats["mytags_migrated"] += 1
                if not dry_run:
                    ref.ContentID = winner_id
                winner_mytag_ids.add(mid)

        # Delete the loser DjmdContent row.
        if not dry_run:
            db.session.delete(loser)
        stats["losers_deleted"] += 1

    if not dry_run:
        db.commit()
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None, help="Process only N clusters")
    ap.add_argument("--only-winner-id", default=None, help="Process only cluster with this winner TrackID")
    args = ap.parse_args()

    if not args.dry_run:
        assert_rekordbox_closed()

    report = json.loads(REPORT.read_text())
    losers = report["losers"]

    # Group losers by winner TrackID.
    clusters = defaultdict(list)
    for l in losers:
        clusters[str(l["winnerTrackId"])].append(str(l["trackId"]))

    winner_ids = list(clusters.keys())
    if args.only_winner_id:
        winner_ids = [w for w in winner_ids if w == args.only_winner_id]
    if args.limit:
        winner_ids = winner_ids[: args.limit]

    print(f"Clusters to process: {len(winner_ids)} (dry_run={args.dry_run})")

    db = Rekordbox6Database()
    total = {
        "clusters_processed": 0,
        "losers_deleted": 0,
        "losers_missing_from_db": 0,
        "cues_migrated": 0,
        "cues_discarded_clash": 0,
        "plays_added": 0,
        "ratings_raised": 0,
        "playlists_migrated": 0,
        "playlists_discarded_dup": 0,
        "mytags_migrated": 0,
        "mytags_discarded_dup": 0,
        "paths_relocated": 0,
        "errors": 0,
    }
    per_cluster = []
    for i, wid in enumerate(winner_ids, start=1):
        loser_ids = clusters[wid]
        stats = process_cluster(db, wid, loser_ids, dry_run=args.dry_run)
        per_cluster.append(stats)
        total["clusters_processed"] += 1
        total["losers_deleted"] += stats["losers_deleted"]
        total["losers_missing_from_db"] += stats["losers_missing_from_db"]
        total["cues_migrated"] += stats["cues_migrated"]
        total["cues_discarded_clash"] += stats["cues_discarded_clash"]
        total["plays_added"] += stats["plays_added"]
        total["ratings_raised"] += 1 if stats.get("rating_raised") else 0
        total["playlists_migrated"] += stats["playlists_migrated"]
        total["playlists_discarded_dup"] += stats["playlists_discarded_dup"]
        total["mytags_migrated"] += stats["mytags_migrated"]
        total["mytags_discarded_dup"] += stats["mytags_discarded_dup"]
        total["paths_relocated"] += 1 if stats["path_relocated"] else 0
        if "error" in stats:
            total["errors"] += 1
        if i <= 3 or i % 50 == 0 or i == len(winner_ids):
            print(f"  [{i}/{len(winner_ids)}] winner={wid} losers={len(loser_ids)} | "
                  f"cues: migrated={stats['cues_migrated']} clash={stats['cues_discarded_clash']} | "
                  f"plays+={stats['plays_added']} | pls m/d={stats['playlists_migrated']}/{stats['playlists_discarded_dup']} | "
                  f"mts m/d={stats['mytags_migrated']}/{stats['mytags_discarded_dup']} | "
                  f"reloc={stats['path_relocated']} | del={stats['losers_deleted']}")

    print("\nTOTALS:")
    for k, v in total.items():
        print(f"  {k:28} {v}")

    # Write per-cluster log.
    log_path = Path(__file__).resolve().parent / (
        "rbx-merge-log-dryrun.json" if args.dry_run else "rbx-merge-log.json"
    )
    log_path.write_text(json.dumps({"totals": total, "per_cluster": per_cluster}, indent=2))
    print(f"\nPer-cluster log -> {log_path}")
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
