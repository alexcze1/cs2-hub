"""One-time backfill: populate match_data_slim for demos that were parsed
before Task 3 shipped.

Usage:
    cd vps && python backfill_slim.py [--dry-run] [--limit N]

Reads demos with status='ready' and match_data_slim IS NULL, computes the
slim payload from match_data, and writes it back. Idempotent — safe to re-run.
"""
import argparse
import json
import os
import sys

import psycopg2
from dotenv import load_dotenv

from demo_parser import build_slim_payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Compute but do not write")
    parser.add_argument("--limit", type=int, default=None, help="Process at most N demos")
    args = parser.parse_args()

    load_dotenv()
    conn = psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=10)
    conn.autocommit = False

    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '180s'")
        cur.execute(
            """select id from demos
                where status = 'ready'
                  and match_data_slim is null
                order by created_at desc
                limit %s""",
            (args.limit,) if args.limit else (None,),
        )
        ids = [row[0] for row in cur.fetchall()]

    print(f"[backfill] {len(ids)} demos to process")

    for i, demo_id in enumerate(ids, 1):
        try:
            with conn.cursor() as cur:
                cur.execute("select match_data from demos where id = %s", (demo_id,))
                row = cur.fetchone()
                if not row or not row[0]:
                    print(f"[backfill] {i}/{len(ids)} {demo_id}: no match_data, skip")
                    continue
                match_data = row[0]  # psycopg2 returns jsonb as dict

            slim = build_slim_payload(match_data)
            slim_json = json.dumps(slim)
            slim_mb = len(slim_json) / 1024 / 1024
            print(f"[backfill] {i}/{len(ids)} {demo_id}: slim={slim_mb:.2f} MB")

            if args.dry_run:
                continue

            with conn.cursor() as cur:
                cur.execute(
                    "update demos set match_data_slim = %s where id = %s",
                    (slim_json, demo_id),
                )
            conn.commit()
        except Exception as e:
            conn.rollback()
            print(f"[backfill] {i}/{len(ids)} {demo_id}: ERROR {e}", file=sys.stderr)

    conn.close()
    print("[backfill] done")


if __name__ == "__main__":
    main()
