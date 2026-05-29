# vps/backfill_public_played_at.py
#
# One-shot backfill of `played_at` for HLTV-ingested public demos.
#
# Why this exists: until 2026-05-28 the HLTV ingest never persisted the
# match's scheduled datetime, so every public demo row landed with
# played_at = NULL. The Pro tab on demos.html sorts and labels rows by
# played_at, falling back to the upload timestamp when missing — which
# meant the displayed date and ordering reflected ingest time, not the
# real HLTV match date. New rows are correct (hltv_ingest now writes
# match.date), but the historical backlog needs filling in.
#
# Strategy:
#   1. Pick up every HLTV demo where played_at IS NULL and source_url is set.
#   2. Group by source_match_id so we fetch each HLTV match page once.
#   3. Parse the page's <div class="timeAndEvent"> date and UPDATE all
#      rows in the match with that single value.
#
# Run as a one-shot:
#   python3 backfill_public_played_at.py            # all eligible
#   python3 backfill_public_played_at.py --limit 200
#
# Idempotent: rows with played_at already set are excluded by the SELECT.

from __future__ import annotations

import argparse
import sys
import time
from collections import defaultdict
from datetime import datetime
from typing import Iterable

import psycopg2.extras

from db import get_db
from hltv_scraper import HLTVBlockedError, fetch_match_page_played_at


def _fetch_rows(limit: int | None, *, include_midnight: bool) -> list[dict]:
    # Default: only rows where played_at IS NULL.
    # --refresh-midnight: also include rows whose played_at is exactly
    # midnight UTC — those landed during the 2026-05-28..29 window when
    # ingest used match.date (headline date only) instead of the precise
    # data-unix timestamp from the match page. Re-fetching gives them an
    # accurate time.
    where = "played_at IS NULL"
    if include_midnight:
        where += (" OR (played_at IS NOT NULL "
                  "AND date_trunc('day', played_at AT TIME ZONE 'UTC') = "
                  "played_at AT TIME ZONE 'UTC')")
    sql = f"""
        SELECT id, source_match_id, source_url, played_at
        FROM demos
        WHERE source = 'hltv'
          AND ({where})
          AND source_url IS NOT NULL
        ORDER BY created_at DESC
    """
    if limit:
        sql += f" LIMIT {int(limit)}"
    with get_db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql)
            return list(cur.fetchall())


def _group_by_match(rows: Iterable[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        out[r["source_match_id"]].append(r)
    return out


def _apply_update(demo_ids: list[str], ts: datetime) -> int:
    """Overwrite played_at unconditionally for the targeted ids — the SELECT
    has already filtered down to rows that need updating. Previously had an
    AND played_at IS NULL guard that silently skipped the midnight-only
    rows the --refresh-midnight pass is meant to fix."""
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE demos SET played_at = %s WHERE id = ANY(%s::uuid[])",
                (ts, demo_ids),
            )
            return cur.rowcount


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--limit", type=int, default=None,
                   help="Process at most N rows (still grouped by match).")
    p.add_argument("--refresh-midnight", action="store_true",
                   help="Also re-fetch rows whose played_at is exactly "
                        "midnight UTC — likely came from the headline-date "
                        "fallback before precise timestamps were wired in.")
    p.add_argument("--per-match-sleep", type=float, default=10.0,
                   help="Seconds to sleep between match-page fetches "
                        "(default 10; HLTV CF rate-limits aggressive scrapes).")
    args = p.parse_args(argv)

    rows = _fetch_rows(args.limit, include_midnight=args.refresh_midnight)
    if not rows:
        print("[backfill] no rows need played_at")
        return 0

    by_match = _group_by_match(rows)
    print(f"[backfill] {len(rows)} rows across {len(by_match)} matches")

    updated = 0
    fetch_failed = 0
    no_date = 0

    first = True
    for hltv_id, group in by_match.items():
        url = group[0].get("source_url")
        if not first and args.per_match_sleep > 0:
            time.sleep(args.per_match_sleep)
        first = False
        try:
            ts = fetch_match_page_played_at(url)
        except HLTVBlockedError as e:
            print(f"[backfill] {hltv_id} blocked by CF: {e}")
            fetch_failed += len(group)
            continue
        except Exception as e:
            print(f"[backfill] {hltv_id} fetch error: {type(e).__name__}: {e}")
            fetch_failed += len(group)
            continue

        if ts is None:
            print(f"[backfill] {hltv_id} match page had no date element")
            no_date += len(group)
            continue

        n = _apply_update([r["id"] for r in group], ts)
        updated += n

    print(f"[backfill] updated:      {updated}")
    print(f"[backfill] fetch failed: {fetch_failed}")
    print(f"[backfill] no date:      {no_date}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
