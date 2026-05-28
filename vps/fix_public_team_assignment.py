# vps/fix_public_team_assignment.py
#
# Reconcile demos.team_a_name / team_b_name with the parser's actual team_a
# (= the team that started CT at round 1) for HLTV-ingested public demos.
#
# Why this exists: the parser labels "team A" by initial CT side, which swaps
# per map within a series. HLTV's team_a_name is constant across the series.
# When a map has the HLTV team_b starting CT, the parser's team_a is HLTV's
# team_b — and the frontend, which trusts (team_a_name, team_a_score) as a
# pair, ends up showing the wrong score next to each team name.
#
# Fix strategy:
#   1. For each public demo, get the parser's team='a' player ign list from
#      demo_players.
#   2. Look those ign's up in hltv_players (case-insensitive). The team_id
#      that wins the popular vote is the HLTV team for parser's team_a.
#   3. Get that team's name from hltv_teams; compare to demos.team_a_name and
#      team_b_name. If it matches team_b_name (case-insensitive), swap the
#      two name columns on the demo row.
#   4. Skip demos where hltv_players doesn't cover enough of the lineup — we
#      keep whatever HLTV ordering was there. (Bumping HLTV_REFRESH_TOP_N
#      improves coverage over time.)
#
# Run as a one-shot:
#   python3 fix_public_team_assignment.py
# It's idempotent: a second run is a no-op once names are aligned.

from __future__ import annotations

import os
import sys

import psycopg2.extras

from db import get_db


def main() -> int:
    fixed = 0
    skipped_no_lookup = 0
    already_correct = 0
    unmatched_team = 0

    with get_db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT id, team_a_name, team_b_name
                FROM demos
                WHERE source = 'hltv'
                  AND status = 'ready'
                  AND team_a_name IS NOT NULL
                  AND team_b_name IS NOT NULL
            """)
            demos = cur.fetchall()

        for d in demos:
            demo_id = d["id"]
            team_a_name = d["team_a_name"]
            team_b_name = d["team_b_name"]

            with conn.cursor() as cur:
                cur.execute("""
                    SELECT lower(name) AS ign
                    FROM demo_players
                    WHERE demo_id = %s AND team = 'a' AND side = 'all'
                """, (demo_id,))
                a_igns = [r[0] for r in cur.fetchall() if r[0]]

            if not a_igns:
                skipped_no_lookup += 1
                continue

            # Look up players in hltv_players (case-insensitive). Tally team_ids.
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT lower(ign) AS ign, team_id, team_name
                    FROM hltv_players
                    WHERE lower(ign) = ANY (%s) AND team_id IS NOT NULL
                """, (a_igns,))
                rows = cur.fetchall()

            if len(rows) < 2:
                # < 2 of the 5 players matched — not enough confidence to assert
                # which HLTV team parser_a belongs to. Leave as-is.
                skipped_no_lookup += 1
                continue

            team_votes: dict[int, int] = {}
            team_id_to_name: dict[int, str] = {}
            for _ign, tid, tname in rows:
                team_votes[tid] = team_votes.get(tid, 0) + 1
                team_id_to_name[tid] = tname or ""

            winner_tid = max(team_votes.items(), key=lambda kv: kv[1])[0]
            parser_a_team_name = (team_id_to_name.get(winner_tid) or "").strip().lower()

            if not parser_a_team_name:
                unmatched_team += 1
                continue

            ta_lower = team_a_name.strip().lower()
            tb_lower = team_b_name.strip().lower()

            if parser_a_team_name == ta_lower:
                already_correct += 1
                continue

            if parser_a_team_name == tb_lower:
                # Swap so HLTV's team_a_name corresponds to parser's team_a.
                with conn.cursor() as cur:
                    cur.execute("""
                        UPDATE demos
                        SET team_a_name = %s,
                            team_b_name = %s
                        WHERE id = %s
                    """, (team_b_name, team_a_name, demo_id))
                fixed += 1
                continue

            # Parser_a's HLTV team is NEITHER team_a_name NOR team_b_name. Probably
            # an obscure roster move or a name spelling difference. Leave alone.
            unmatched_team += 1

    print(f"[fix-teams] examined {len(demos)} public demos:")
    print(f"  fixed (swapped):           {fixed}")
    print(f"  already correct:           {already_correct}")
    print(f"  no hltv_players coverage:  {skipped_no_lookup}")
    print(f"  unmatched team after vote: {unmatched_team}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
