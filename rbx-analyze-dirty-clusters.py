"""For each 'dirty' loser cluster, compare loser refs vs winner refs.

If winner has MORE (or equal) data -> current choice is right, nothing to do.
If loser has MORE data -> our 'oldest DateAdded' heuristic picked the wrong
one; we should swap (winner becomes loser, loser becomes winner) OR flag
for manual review if both have real data.
"""
import json
from pathlib import Path

from pyrekordbox import Rekordbox6Database
from pyrekordbox.db6 import tables

REPORT = Path(
    "/Volumes/Time Machin/rekordbox/dedupe-report-2026-04-23T00-30-45-542Z.json"
)


def score(cues, pls, mts, plays, rating):
    return cues * 10 + pls * 5 + mts * 3 + plays + (rating // 10)


def refs(session, tables_mod, tid):
    DjmdCue = tables_mod.DjmdCue
    DjmdSongPlaylist = tables_mod.DjmdSongPlaylist
    DjmdSongMyTag = tables_mod.DjmdSongMyTag
    return {
        "cues": session.query(DjmdCue).filter_by(ContentID=tid).count(),
        "playlists": session.query(DjmdSongPlaylist).filter_by(ContentID=tid).count(),
        "mytags": session.query(DjmdSongMyTag).filter_by(ContentID=tid).count(),
    }


def main() -> int:
    report = json.loads(REPORT.read_text())
    losers = report.get("losers", [])
    # Group losers by clusterKey so we can batch per-cluster.
    clusters = {}
    for l in losers:
        clusters.setdefault(l["clusterKey"], []).append(l)

    db = Rekordbox6Database()
    s = db.session

    # Precompute all cluster winners' refs.
    swap = []      # loser has strictly more -> swap sides
    ambiguous = [] # both have meaningful refs
    keep = []      # current winner choice stands

    for ckey, loser_group in clusters.items():
        winner_tid = loser_group[0]["winnerTrackId"]
        wc = db.get_content(ID=winner_tid)
        if wc is None:
            continue
        w_refs = refs(s, tables, winner_tid)
        w_plays = int(getattr(wc, "DJPlayCount", 0) or 0)
        w_rating = int(getattr(wc, "Rating", 0) or 0)
        w_score = score(w_refs["cues"], w_refs["playlists"], w_refs["mytags"], w_plays, w_rating)

        # Find the "heaviest" loser in this cluster (most data).
        best_loser = None
        best_loser_score = -1
        best_loser_refs = None
        best_loser_plays = 0
        best_loser_rating = 0
        for l in loser_group:
            lc = db.get_content(ID=l["trackId"])
            if lc is None:
                continue
            l_refs = refs(s, tables, l["trackId"])
            l_plays = int(getattr(lc, "DJPlayCount", 0) or 0)
            l_rating = int(getattr(lc, "Rating", 0) or 0)
            l_score = score(l_refs["cues"], l_refs["playlists"], l_refs["mytags"], l_plays, l_rating)
            if l_score > best_loser_score:
                best_loser_score = l_score
                best_loser = l
                best_loser_refs = l_refs
                best_loser_plays = l_plays
                best_loser_rating = l_rating

        if best_loser is None or best_loser_score <= 0:
            # No loser has real data -- nothing to reconsider.
            if w_score > 0:
                keep.append({
                    "clusterKey": ckey,
                    "winner": winner_tid,
                    "winner_score": w_score,
                    "winner_refs": w_refs,
                })
            continue

        if best_loser_score > w_score:
            swap.append({
                "clusterKey": ckey,
                "artist": best_loser["artist"],
                "title": best_loser["title"],
                "current_winner": winner_tid,
                "current_winner_score": w_score,
                "current_winner_refs": w_refs,
                "current_winner_plays": w_plays,
                "current_winner_rating": w_rating,
                "proposed_winner": best_loser["trackId"],
                "proposed_winner_score": best_loser_score,
                "proposed_winner_refs": best_loser_refs,
                "proposed_winner_plays": best_loser_plays,
                "proposed_winner_rating": best_loser_rating,
            })
        elif w_score > 0 and best_loser_score > 0:
            ambiguous.append({
                "clusterKey": ckey,
                "artist": best_loser["artist"],
                "title": best_loser["title"],
                "winner": winner_tid,
                "winner_score": w_score,
                "winner_refs": w_refs,
                "heaviest_loser": best_loser["trackId"],
                "heaviest_loser_score": best_loser_score,
                "heaviest_loser_refs": best_loser_refs,
            })
        else:
            keep.append({
                "clusterKey": ckey,
                "winner": winner_tid,
                "winner_score": w_score,
                "winner_refs": w_refs,
            })

    print(f"Cluster reclassification:")
    print(f"  keep as-is:          {len(keep)} (winner has more/all the data)")
    print(f"  SWAP (winner wrong): {len(swap)}")
    print(f"  ambiguous (review):  {len(ambiguous)}")

    if swap:
        print("\nSWAP list (top 10):")
        swap.sort(key=lambda x: x["proposed_winner_score"], reverse=True)
        for s_ in swap[:10]:
            print(
                f"  {s_['artist'][:35]} - {s_['title'][:35]}: "
                f"current winner {s_['current_winner']} (score {s_['current_winner_score']}, {s_['current_winner_refs']}) "
                f"→ proposed {s_['proposed_winner']} (score {s_['proposed_winner_score']}, {s_['proposed_winner_refs']})"
            )

    if ambiguous:
        print("\nAMBIGUOUS list (both have data) -- top 10:")
        ambiguous.sort(key=lambda x: x["winner_score"] + x["heaviest_loser_score"], reverse=True)
        for a in ambiguous[:10]:
            print(
                f"  {a['artist'][:35]} - {a['title'][:35]}: "
                f"winner {a['winner']} (score {a['winner_score']}, {a['winner_refs']}); "
                f"loser {a['heaviest_loser']} (score {a['heaviest_loser_score']}, {a['heaviest_loser_refs']})"
            )

    # Persist full analysis.
    out = Path(__file__).resolve().parent / "rbx-cluster-analysis.json"
    out.write_text(json.dumps({"swap": swap, "ambiguous": ambiguous, "keep_count": len(keep)}, indent=2))
    print(f"\nFull analysis -> {out}")

    db.close()
    return 0


if __name__ == "__main__":
    main()
