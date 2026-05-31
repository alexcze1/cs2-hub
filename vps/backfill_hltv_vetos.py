# vps/backfill_hltv_vetos.py
#
# One-shot backfill of HLTV veto data into hltv_team_vetos.
#
# Strategy: iterate every public demo we've ingested (status='ready', source='hltv',
# source_url set), group by source_match_id so each match page is fetched only
# once, parse the veto box, upsert into hltv_team_vetos.
#
# Run as a one-shot:
#   python3 backfill_hltv_vetos.py            # all public demos
#   python3 backfill_hltv_vetos.py --limit 50 # cap for incremental runs
#
# Idempotent — re-runs replace the existing row for the same match_id.

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import defaultdict

import psycopg2.extras
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()

from db import get_db
from hltv_scraper import HLTVBlockedError, _get, list_team_matches


_MAP_NAME_NORM = {
    "dust2": "dust2", "dust": "dust2",
    "mirage": "mirage", "inferno": "inferno", "nuke": "nuke",
    "anubis": "anubis", "overpass": "overpass", "ancient": "ancient",
    "train": "train", "vertigo": "vertigo",
}
# "1. TYLOO removed Dust2" / "3. TYLOO picked Inferno" / "7. Anubis was left over"
_RX_REMOVED  = re.compile(r"^\s*(\d+)\.\s+(.+?)\s+removed\s+(\w+)\s*$", re.IGNORECASE)
_RX_PICKED   = re.compile(r"^\s*(\d+)\.\s+(.+?)\s+picked\s+(\w+)\s*$",  re.IGNORECASE)
_RX_LEFTOVER = re.compile(r"^\s*(\d+)\.\s+(\w+)\s+was\s+left\s+over\s*$", re.IGNORECASE)


def _norm_map(name: str) -> str | None:
    if not name:
        return None
    return _MAP_NAME_NORM.get(name.strip().lower())


def parse_veto_box(html: str) -> list[dict]:
    """Parse the per-step veto sequence from an HLTV match page.

    Returns a list of {order, team, action, map} dicts, or [] when no veto
    box is present (rare — some old / forfeited matches don't have one).
    """
    soup = BeautifulSoup(html, "html.parser")
    out: list[dict] = []
    # Page has multiple .standard-box elements; the veto-box is the one that
    # contains lines matching our regexes.
    for box in soup.select(".veto-box"):
        for div in box.find_all("div"):
            text = div.get_text(strip=True)
            if not text or text == "—":
                continue
            m = _RX_REMOVED.match(text)
            if m:
                mp = _norm_map(m.group(3))
                if mp:
                    out.append({"order": int(m.group(1)), "team": m.group(2).strip(), "action": "ban",  "map": mp})
                continue
            m = _RX_PICKED.match(text)
            if m:
                mp = _norm_map(m.group(3))
                if mp:
                    out.append({"order": int(m.group(1)), "team": m.group(2).strip(), "action": "pick", "map": mp})
                continue
            m = _RX_LEFTOVER.match(text)
            if m:
                mp = _norm_map(m.group(2))
                if mp:
                    out.append({"order": int(m.group(1)), "team": None, "action": "decider", "map": mp})
                continue
    # De-dup by order — the page sometimes contains the veto box twice
    # (per-map and overall). Keep the first occurrence per order.
    seen, dedup = set(), []
    for s in out:
        if s["order"] in seen:
            continue
        seen.add(s["order"])
        dedup.append(s)
    return sorted(dedup, key=lambda s: s["order"])


def _infer_format(seq: list[dict]) -> str | None:
    """Best-effort BO1 / BO3 / BO5 detection from the sequence shape."""
    picks = sum(1 for s in seq if s["action"] == "pick")
    if picks == 0:                            # all bans + a decider
        return "bo1"
    if picks == 2:
        return "bo3"
    if picks >= 4:
        return "bo5"
    return None


def _fetch_match_ids(limit: int | None) -> list[dict]:
    sql = """
        SELECT DISTINCT ON (source_match_id)
               source_match_id, source_url, team_a_name, team_b_name, played_at
          FROM demos
         WHERE source = 'hltv'
           AND source_match_id IS NOT NULL
           AND source_url      IS NOT NULL
           AND team_a_name     IS NOT NULL
           AND team_b_name     IS NOT NULL
         ORDER BY source_match_id, played_at DESC NULLS LAST
    """
    if limit:
        sql += f" LIMIT {int(limit)}"
    with get_db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql)
            return list(cur.fetchall())


def _upsert_veto(match_id: str, *, played_at, team_a: str, team_b: str,
                 fmt: str | None, seq: list[dict]) -> None:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO hltv_team_vetos
                       (match_id, played_at, team_a_name, team_b_name, format, sequence)
                VALUES (%s, %s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (match_id) DO UPDATE SET
                       played_at   = EXCLUDED.played_at,
                       team_a_name = EXCLUDED.team_a_name,
                       team_b_name = EXCLUDED.team_b_name,
                       format      = EXCLUDED.format,
                       sequence    = EXCLUDED.sequence,
                       scraped_at  = now()
                """,
                (match_id, played_at, team_a, team_b, fmt, json.dumps(seq)),
            )


# --------------------------------------------------------------------------- #
# Per-team on-demand sync
# --------------------------------------------------------------------------- #
#
# Called from the FastAPI endpoint when the frontend's veto-simulator searches
# a team. Picks up only the matches we don't already have for that team in
# the last `months` window, so a sync for a fully-cached team is a single
# /results page load + the team-id lookup.

def _team_id_for_name(team_name: str) -> int | None:
    """Look up the HLTV team_id from our hltv_teams table by name (CI)."""
    if not team_name:
        return None
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM hltv_teams WHERE lower(name) = lower(%s) LIMIT 1",
                (team_name.strip(),),
            )
            row = cur.fetchone()
    return int(row[0]) if row and row[0] is not None else None


def _existing_match_ids() -> set[str]:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT match_id FROM hltv_team_vetos")
            return {r[0] for r in cur.fetchall()}


def sync_team_vetos(team_name: str, *, months: int = 3, sleep: float = 2.0) -> dict:
    """Sync the last `months` of vetos for ONE team from HLTV.

    Steps:
      1. Look up team_id (if not in hltv_teams, we can't drive a filtered
         results query — return early with a flag the caller can show).
      2. List the team's matches in the window.
      3. Filter out matches already in hltv_team_vetos.
      4. Fetch + parse each new match page, upsert the veto.

    Returns a small dict the API endpoint can surface to the frontend:
      { team_name, team_id, listed, already_had, parsed, no_veto, failed,
        blocked, in_window }
    """
    days = max(1, int(months) * 31)
    result = {
        "team_name":   team_name,
        "team_id":     None,
        "listed":      0,
        "already_had": 0,
        "parsed":      0,
        "no_veto":     0,
        "failed":      0,
        "blocked":     False,
        "in_window":   0,
    }
    team_id = _team_id_for_name(team_name)
    if team_id is None:
        # Team not in hltv_teams — backfill script's broad walk is the only
        # path to coverage. Frontend falls back to whatever's in the DB.
        return result
    result["team_id"] = team_id

    try:
        matches = list_team_matches(team_id, days=days)
    except HLTVBlockedError:
        result["blocked"] = True
        return result
    result["listed"]    = len(matches)
    result["in_window"] = len(matches)

    already = _existing_match_ids()
    todo = [m for m in matches if m.hltv_id not in already]
    result["already_had"] = len(matches) - len(todo)
    if not todo:
        return result

    for m in todo:
        try:
            html = _get(m.url)
        except HLTVBlockedError:
            result["blocked"] = True
            break
        except Exception:
            result["failed"] += 1
            time.sleep(sleep)
            continue
        seq = parse_veto_box(html)
        if not seq:
            result["no_veto"] += 1
            time.sleep(sleep)
            continue
        try:
            _upsert_veto(
                m.hltv_id,
                played_at=m.date,
                team_a=m.team_a,
                team_b=m.team_b,
                fmt=_infer_format(seq),
                seq=seq,
            )
            result["parsed"] += 1
        except Exception:
            result["failed"] += 1
        time.sleep(sleep)
    return result


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None, help="cap rows scanned (debug)")
    p.add_argument("--sleep", type=float, default=2.0, help="seconds between match-page fetches")
    args = p.parse_args(argv)

    rows = _fetch_match_ids(args.limit)
    if not rows:
        print("[veto-backfill] no demos to scan")
        return 0
    print(f"[veto-backfill] {len(rows)} matches to scan")

    # Skip rows already in hltv_team_vetos so reruns are cheap.
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT match_id FROM hltv_team_vetos")
            already = {r[0] for r in cur.fetchall()}
    print(f"[veto-backfill] {len(already)} already scraped, processing the rest")

    parsed = 0
    skipped = 0
    failed = 0
    for r in rows:
        mid = r["source_match_id"]
        if mid in already:
            skipped += 1
            continue
        try:
            html = _get(r["source_url"])
        except HLTVBlockedError:
            print(f"[veto-backfill] HLTV blocked us, stopping at match {mid}")
            break
        except Exception as e:
            print(f"[veto-backfill] fetch failed for {mid}: {e}")
            failed += 1
            time.sleep(args.sleep)
            continue
        seq = parse_veto_box(html)
        if not seq:
            print(f"[veto-backfill] no veto box on match {mid}")
            skipped += 1
            time.sleep(args.sleep)
            continue
        try:
            _upsert_veto(
                mid,
                played_at=r["played_at"],
                team_a=r["team_a_name"],
                team_b=r["team_b_name"],
                fmt=_infer_format(seq),
                seq=seq,
            )
            parsed += 1
            print(f"[veto-backfill] ok {mid}  {r['team_a_name']} vs {r['team_b_name']}  {len(seq)} steps")
        except Exception as e:
            print(f"[veto-backfill] upsert failed for {mid}: {e}")
            failed += 1
        time.sleep(args.sleep)

    print(f"[veto-backfill] done — parsed={parsed} skipped={skipped} failed={failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
