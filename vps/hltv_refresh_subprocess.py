# vps/hltv_refresh_subprocess.py
#
# One cycle of the daily HLTV team + player refresh. Runs as a separate
# Python process for the same reason ingest does — sync_playwright doesn't
# get along with the parent's asyncio loop.
#
# Pipeline:
#   1. Fetch /ranking/teams, parse top-N teams (id, name, logo, rank).
#   2. Upsert all teams into hltv_teams.
#   3. For each team, fetch /team/<id>/<slug>, parse roster (id, ign, full_name,
#      photo_url). Upsert into hltv_players. CF sometimes blocks individual
#      team pages — those teams are logged and skipped this cycle; the next
#      cycle picks them up.
#
# Run manually:
#   python -m hltv_refresh_subprocess

from __future__ import annotations

import os
import sys

import psycopg2.extras

from db import get_db


TOP_N = int(os.getenv("HLTV_REFRESH_TOP_N", "30"))


def main() -> int:
    # Lazy imports — surface ImportError inside the subprocess, not the parent.
    from hltv_rankings import (
        list_ranked_teams,
        list_team_players,
        players_from_ranking_page,
    )
    from hltv_scraper import _get, shutdown_playwright

    try:
        print(f"[refresh] scraping top {TOP_N} teams from /ranking/teams", flush=True)
        # We fetch /ranking/teams twice when we use the fallback (once via
        # list_ranked_teams, once for the IGN fallback). Cheaper to fetch once
        # and parse both views.
        rank_html = _get("/ranking/teams")
        from hltv_rankings import _parse_ranking_page
        teams = _parse_ranking_page(rank_html, top_n=TOP_N)
        print(f"[refresh] discovered {len(teams)} teams", flush=True)

        _upsert_teams(teams)
        print(f"[refresh] upserted {len(teams)} teams", flush=True)

        # Collect players. Try each team page; if CF stays sticky, fall back
        # to ranking-page IGNs for that team (no photo, no id).
        ranking_fallback_players = players_from_ranking_page(rank_html, teams)
        fallback_by_team: dict[int, list] = {}
        for p in ranking_fallback_players:
            fallback_by_team.setdefault(p.team_id, []).append(p)

        total_players = 0
        for t in teams:
            try:
                players = list_team_players(t)
            except Exception as e:
                print(
                    f"[refresh] {t.name} team-page error ({type(e).__name__}): {e}",
                    flush=True,
                )
                players = []

            # Drop entries without an HLTV id (synthetic fallback rows) since
            # hltv_players.id is the primary key.
            players_with_id = [p for p in players if p.id is not None]
            if not players_with_id:
                fb = fallback_by_team.get(t.id, [])
                print(
                    f"[refresh] {t.name}: 0 players from team page; "
                    f"{len(fb)} IGNs in ranking fallback (skipping — no HLTV ids)",
                    flush=True,
                )
                continue

            _upsert_players(players_with_id)
            total_players += len(players_with_id)
            print(
                f"[refresh] {t.name}: upserted {len(players_with_id)} players",
                flush=True,
            )

        print(f"[refresh] cycle complete — {len(teams)} teams, {total_players} players", flush=True)
    finally:
        try: shutdown_playwright()
        except Exception: pass

    return 0


def _upsert_teams(teams: list) -> None:
    if not teams:
        return
    rows = [(t.id, t.name, t.logo_url, t.rank) for t in teams]
    with get_db() as conn:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO hltv_teams (id, name, logo_url, rank, updated_at)
                VALUES %s
                ON CONFLICT (id) DO UPDATE SET
                  name       = EXCLUDED.name,
                  logo_url   = EXCLUDED.logo_url,
                  rank       = EXCLUDED.rank,
                  updated_at = now()
                """,
                rows,
                template="(%s, %s, %s, %s, now())",
            )


def _upsert_players(players: list) -> None:
    if not players:
        return
    rows = [
        (p.id, p.ign, p.full_name, p.team_name, p.team_id, p.country, p.photo_url)
        for p in players
    ]
    with get_db() as conn:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO hltv_players
                  (id, ign, full_name, team_name, team_id, country, photo_url, updated_at)
                VALUES %s
                ON CONFLICT (id) DO UPDATE SET
                  ign        = EXCLUDED.ign,
                  full_name  = COALESCE(EXCLUDED.full_name, hltv_players.full_name),
                  team_name  = EXCLUDED.team_name,
                  team_id    = EXCLUDED.team_id,
                  country    = COALESCE(EXCLUDED.country, hltv_players.country),
                  photo_url  = COALESCE(EXCLUDED.photo_url, hltv_players.photo_url),
                  updated_at = now()
                """,
                rows,
                template="(%s, %s, %s, %s, %s, %s, %s, now())",
            )


if __name__ == "__main__":
    sys.exit(main())
