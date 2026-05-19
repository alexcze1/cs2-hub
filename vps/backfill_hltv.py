#!/usr/bin/env python3
"""One-shot backfill: scrape HLTV /results for the past N days and ingest every
match the existing pipeline doesn't already know about.

Run on the VPS, watched live. The recommended first invocation caps ingest at
50 demos so we can measure Postgres growth before committing to the full
backfill:

    python3 backfill_hltv.py --days 90 --max-demos 50

After confirming jsonb size projections are tolerable, re-run without the cap.
Idempotent: matches already ingested by a previous run (or by the daily loop)
are skipped via the unique index in supabase-public-demos-migration.sql.

Spec: docs/superpowers/specs/2026-05-18-public-pro-demos-design.md
Plan: docs/superpowers/plans/2026-05-18-public-pro-demos.md
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# Force IPv4 for the same reason main.py does (VPS has no IPv6 routing).
# Doing it here mirrors main.py without importing it (we don't want FastAPI's
# lifespan to fire when running this as a CLI).
import socket
_orig_getaddrinfo = socket.getaddrinfo
def _ipv4_getaddrinfo(host, port, family=0, *args, **kwargs):
    return _orig_getaddrinfo(host, port, socket.AF_INET, *args, **kwargs)
socket.getaddrinfo = _ipv4_getaddrinfo

from hltv_ingest import ingest_match
from hltv_scraper import DiskCapExceeded, HLTVBlockedError, list_recent_matches


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--days", type=int, default=90,
                   help="how many days of HLTV results to walk (default: 90)")
    p.add_argument("--max-demos", type=int, default=None,
                   help="stop after this many demos inserted; useful for a "
                        "measurement run before full backfill")
    p.add_argument("--per-match-sleep", type=float, default=30.0,
                   help="seconds to sleep between matches; HLTV gets angry "
                        "if we go too fast (default: 30)")
    p.add_argument("--demos-dir", default="/opt/midround/demos",
                   help="where to stage .dem files (default: /opt/midround/demos)")
    args = p.parse_args(argv)

    demos_dir = Path(args.demos_dir)
    demos_dir.mkdir(parents=True, exist_ok=True)

    print(f"[backfill] scanning HLTV results for the last {args.days} days...")
    try:
        matches = list_recent_matches(days=args.days)
    except HLTVBlockedError as e:
        print(f"[backfill] HLTV blocked the listing: {e}", file=sys.stderr)
        return 2
    print(f"[backfill] discovered {len(matches)} matches")

    total_inserted = 0
    matches_seen = 0
    for m in matches:
        matches_seen += 1
        try:
            n = ingest_match(m, demos_dir)
        except DiskCapExceeded as e:
            print(f"[backfill] disk cap reached, stopping: {e}")
            break
        except HLTVBlockedError as e:
            print(f"[backfill] Cloudflare block mid-backfill, stopping: {e}")
            break
        except Exception as e:
            print(f"[backfill] skip {m.hltv_id} ({type(e).__name__}): {e}")
            time.sleep(args.per_match_sleep)
            continue

        if n:
            total_inserted += n
            print(f"[backfill] {matches_seen}/{len(matches)} "
                  f"ingested {n} demos: {m.team_a} vs {m.team_b} ({m.hltv_id}) "
                  f"— running total {total_inserted}")
        if args.max_demos is not None and total_inserted >= args.max_demos:
            print(f"[backfill] reached --max-demos={args.max_demos}, stopping")
            break
        time.sleep(args.per_match_sleep)

    print(f"[backfill] done — {total_inserted} demos inserted across "
          f"{matches_seen} matches walked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
