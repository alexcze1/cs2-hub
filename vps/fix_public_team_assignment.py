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

import json
import os
import sys
from pathlib import Path

import psycopg2.extras

from db import get_db


# Static fallback — same file the frontend's player-autocomplete used to load.
# hltv_players is refreshed daily but only covers the top ~30 teams; this JSON
# was captured once and covers ~1300 players from many lower-tier teams, which
# is exactly where the new public demos come from. We use the JSON only when
# the DB has no entry for an ign (DB wins on collision so a renamed/transferred
# player is right).
_PLAYERS_JSON_PATH = Path(__file__).resolve().parent.parent / "cs2-hub" / "hltv-players.json"


def _load_json_player_map() -> dict[str, str]:
    """ign_lower → team_name (string), loaded once from the static JSON."""
    try:
        data = json.loads(_PLAYERS_JSON_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"[fix-teams] WARN: {_PLAYERS_JSON_PATH} not found — fallback disabled")
        return {}
    out: dict[str, str] = {}
    for p in data:
        ign = (p.get("ign") or "").strip().lower()
        team = (p.get("team") or "").strip()
        if ign and team:
            out[ign] = team
    return out


def _team_for_ign_db(conn, igns: list[str]) -> dict[str, str]:
    """Look ups (lower(ign)) → team_name from hltv_players. Only ign-with-team rows."""
    if not igns:
        return {}
    with conn.cursor() as cur:
        cur.execute("""
            SELECT lower(ign) AS ign, team_name
            FROM hltv_players
            WHERE lower(ign) = ANY (%s) AND team_name IS NOT NULL
        """, (igns,))
        return {r[0]: r[1] for r in cur.fetchall()}


def main() -> int:
    fixed = 0
    skipped_no_lookup = 0
    already_correct = 0
    unmatched_team = 0

    json_map = _load_json_player_map()
    print(f"[fix-teams] loaded {len(json_map)} ign→team entries from hltv-players.json")

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

            # DB first, JSON fills gaps. DB wins on collision because it's the
            # current daily-refreshed roster, whereas JSON is a point-in-time
            # snapshot.
            db_map = _team_for_ign_db(conn, a_igns)
            ign_to_team: dict[str, str] = {}
            for ign in a_igns:
                t = db_map.get(ign) or json_map.get(ign)
                if t:
                    ign_to_team[ign] = t

            if len(ign_to_team) < 2:
                skipped_no_lookup += 1
                continue

            # Vote by team name (string), case-insensitive.
            votes: dict[str, int] = {}
            for tname in ign_to_team.values():
                k = tname.strip().lower()
                votes[k] = votes.get(k, 0) + 1
            parser_a_team_lower = max(votes.items(), key=lambda kv: kv[1])[0]

            ta_lower = team_a_name.strip().lower()
            tb_lower = team_b_name.strip().lower()

            if parser_a_team_lower == ta_lower:
                already_correct += 1
                continue

            if parser_a_team_lower == tb_lower:
                with conn.cursor() as cur:
                    cur.execute("""
                        UPDATE demos
                        SET team_a_name = %s,
                            team_b_name = %s
                        WHERE id = %s
                    """, (team_b_name, team_a_name, demo_id))
                fixed += 1
                continue

            # Parser_a's vote team is NEITHER team_a_name NOR team_b_name —
            # likely a name spelling drift (e.g. "Lilmix" vs "lilmix esport")
            # or recent roster move. Leave the row alone.
            unmatched_team += 1

    print(f"[fix-teams] examined {len(demos)} public demos:")
    print(f"  fixed (swapped):           {fixed}")
    print(f"  already correct:           {already_correct}")
    print(f"  no hltv_players coverage:  {skipped_no_lookup}")
    print(f"  unmatched team after vote: {unmatched_team}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
