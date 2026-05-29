# vps/backfill_public_scores.py
#
# One-shot reconciliation for HLTV-ingested public demos already in the DB.
#
# Why this exists: until 2026-05-28 the public-demos pipeline relied on the
# parser's per-CT-roster team_a_score / team_b_score and a player-vote name
# swap to align them with HLTV's team_a_name / team_b_name. Coverage gaps in
# hltv_players left many low-tier rows with names and scores mis-paired,
# producing wrong winners in the UI. The pipeline now sources both names
# and per-map scores from the HLTV match page at ingest. This script applies
# the same correction to rows ingested before the switch.
#
# Strategy:
#   1. Group rows by source_match_id so we fetch each HLTV match page once.
#   2. For each match, re-parse the per-map (team1, score1, team2, score2)
#      tuples from the match page.
#   3. For each demo, resolve (team_a_score, team_b_score) using
#      match_scores_for(). When the lookup fails because the row's stored
#      team_a_name / team_b_name were swapped by the old player-vote fixer,
#      retry with names swapped and write back BOTH the score pair and the
#      corrected name order.
#   4. Skip rows where neither orientation matches (genuine name drift); we
#      leave the row alone rather than guess.
#
# Run as a one-shot:
#   python3 backfill_public_scores.py            # all public demos
#   python3 backfill_public_scores.py --limit 50 # cap for incremental runs
#
# Idempotent: a second run on a corrected row is a no-op (already-correct).

from __future__ import annotations

import argparse
import sys
import time
from collections import defaultdict
from typing import Iterable

import psycopg2.extras

from db import get_db
from hltv_scraper import (
    HLTVBlockedError,
    MapResult,
    fetch_match_page_map_results,
    match_scores_for,
)


def _fetch_public_demos(limit: int | None) -> list[dict]:
    sql = """
        SELECT id, source_match_id, source_map_index, source_url, map,
               team_a_name, team_b_name, team_a_score, team_b_score
        FROM demos
        WHERE source = 'hltv'
          AND team_a_name IS NOT NULL
          AND team_b_name IS NOT NULL
          AND source_url IS NOT NULL
        ORDER BY played_at DESC NULLS LAST, created_at DESC
    """
    if limit:
        sql += f" LIMIT {int(limit)}"
    with get_db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql)
            return list(cur.fetchall())


def _resolve_one(
    demo: dict,
    map_results: list[MapResult],
    canonical_team_a: str,
    canonical_team_b: str,
) -> tuple[int, int, str, str] | None:
    """Return the corrected (team_a_score, team_b_score, team_a_name, team_b_name) or None.

    Always writes names in the canonical (series-wide) order so the front-end
    can rely on team_a_name being consistent across every map of a series.
    The canonical pair is taken from the first played map on the HLTV match
    page; map_results was parsed once per match by the caller.
    """
    map_name = (demo.get("map") or "").lower().replace("de_", "")
    map_index = demo.get("source_map_index") or 0

    scores = match_scores_for(
        team_a_name=canonical_team_a,
        team_b_name=canonical_team_b,
        map_name=map_name,
        map_index=map_index,
        map_results=map_results,
    )
    if scores is None:
        return None
    return (scores[0], scores[1], canonical_team_a, canonical_team_b)


def _apply_update(demo_id: str, ta_score: int, tb_score: int,
                  ta_name: str, tb_name: str) -> bool:
    """Write the corrected (names, scores). Returns True iff any column changed."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE demos
                SET team_a_score = %s,
                    team_b_score = %s,
                    team_a_name  = %s,
                    team_b_name  = %s
                WHERE id = %s
                  AND (team_a_score IS DISTINCT FROM %s
                    OR team_b_score IS DISTINCT FROM %s
                    OR team_a_name  IS DISTINCT FROM %s
                    OR team_b_name  IS DISTINCT FROM %s)
                """,
                (ta_score, tb_score, ta_name, tb_name, demo_id,
                 ta_score, tb_score, ta_name, tb_name),
            )
            return cur.rowcount > 0


def _group_by_match(demos: Iterable[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for d in demos:
        out[d["source_match_id"]].append(d)
    return out


def _inconsistent_match_ids() -> list[str]:
    """Return source_match_ids whose demos have inconsistent team_a_name."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT source_match_id
                FROM demos
                WHERE source = 'hltv' AND status = 'ready' AND team_a_name IS NOT NULL
                GROUP BY source_match_id
                HAVING count(DISTINCT team_a_name) > 1
            """)
            return [r[0] for r in cur.fetchall()]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--limit", type=int, default=None,
                   help="Process at most N demos (still grouped by match).")
    p.add_argument("--per-match-sleep", type=float, default=10.0,
                   help="Seconds to sleep between match-page fetches "
                        "(default 10; CF rate-limits aggressive scrapes).")
    p.add_argument("--only-inconsistent", action="store_true",
                   help="Restrict to matches whose demos currently have "
                        "inconsistent team_a_name across maps. Useful for "
                        "re-runs that finish what an earlier rate-limited "
                        "run missed.")
    args = p.parse_args(argv)

    demos = _fetch_public_demos(args.limit)
    if args.only_inconsistent:
        keep = set(_inconsistent_match_ids())
        before = len(demos)
        demos = [d for d in demos if d["source_match_id"] in keep]
        print(f"[backfill] --only-inconsistent: {len(demos)}/{before} demos "
              f"({len(keep)} matches)")

    if not demos:
        print("[backfill] no public demos to inspect")
        return 0

    by_match = _group_by_match(demos)
    print(f"[backfill] {len(demos)} demos across {len(by_match)} matches "
          f"(per-match sleep: {args.per_match_sleep}s)")

    updated = 0
    already_correct = 0
    unmatched = 0
    fetch_failed = 0

    first = True
    for hltv_id, rows in by_match.items():
        # All rows in a group share source_url, but fall back gracefully if not.
        url = rows[0].get("source_url")
        if not url:
            unmatched += len(rows)
            continue

        # Pace per-match-page fetches so we stay under CF's per-IP threshold.
        # The trickle wrapper uses 180s; backfill is more aggressive (10s
        # default) since it runs ad-hoc, but still leaves CF time to forget us.
        if not first and args.per_match_sleep > 0:
            time.sleep(args.per_match_sleep)
        first = False

        try:
            map_results = fetch_match_page_map_results(url)
        except HLTVBlockedError as e:
            print(f"[backfill] {hltv_id} blocked by CF: {e}")
            fetch_failed += len(rows)
            continue
        except Exception as e:
            print(f"[backfill] {hltv_id} fetch error: {type(e).__name__}: {e}")
            fetch_failed += len(rows)
            continue

        if not map_results:
            print(f"[backfill] {hltv_id} match page had no played maps")
            unmatched += len(rows)
            continue

        # HLTV is consistent across maps within a match — the first played
        # map's team1/team2 names are the canonical series-wide order.
        canonical_a = map_results[0].team1_name
        canonical_b = map_results[0].team2_name

        for d in rows:
            resolved = _resolve_one(d, map_results, canonical_a, canonical_b)
            if resolved is None:
                unmatched += 1
                continue
            ta_score, tb_score, ta_name, tb_name = resolved
            already = (
                d["team_a_score"] == ta_score
                and d["team_b_score"] == tb_score
                and d["team_a_name"] == ta_name
                and d["team_b_name"] == tb_name
            )
            if already:
                already_correct += 1
                continue
            if _apply_update(d["id"], ta_score, tb_score, ta_name, tb_name):
                updated += 1

    print(f"[backfill] updated:         {updated}")
    print(f"[backfill] already correct: {already_correct}")
    print(f"[backfill] unmatched:       {unmatched}")
    print(f"[backfill] fetch failed:    {fetch_failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
