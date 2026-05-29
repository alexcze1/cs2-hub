"""One-time backfill: populate match_data_slim for demos that were parsed
before Task 3 shipped, or whose slim payload predates a new field added
to build_slim_payload (e.g. the round-level awpers list, 2026-05-29).

Usage:
    cd vps && python backfill_slim.py [--dry-run] [--limit N] [--force]

Reads each ready demo, computes the slim payload from match_data (jsonb)
when present or otherwise from the gzipped JSON in Storage at
match_data_url, and writes it back. Idempotent — safe to re-run. With
--force, re-processes rows that already have a slim payload (use this
when the slim schema changed and you want existing rows rebuilt).
"""
import argparse
import gzip
import json
import os
import sys

import psycopg2
from dotenv import load_dotenv
from supabase import create_client

from demo_parser import build_slim_payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Compute but do not write")
    parser.add_argument("--limit", type=int, default=None, help="Process at most N demos")
    parser.add_argument("--force", action="store_true",
                        help="Re-process demos that already have slim payloads. Use after "
                             "build_slim_payload gains a new field so existing rows pick it up.")
    args = parser.parse_args()

    load_dotenv()
    conn = psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=10)
    conn.autocommit = False

    supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

    where_slim = "" if args.force else " and match_data_slim is null"
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '180s'")
        cur.execute(
            f"""select id from demos
                where status = 'ready'{where_slim}
                order by created_at desc
                limit %s""",
            (args.limit,) if args.limit else (None,),
        )
        ids = [row[0] for row in cur.fetchall()]

    print(f"[backfill] {len(ids)} demos to process")

    for i, demo_id in enumerate(ids, 1):
        try:
            with conn.cursor() as cur:
                cur.execute("select match_data, match_data_url from demos where id = %s", (demo_id,))
                row = cur.fetchone()
                if not row:
                    print(f"[backfill] {i}/{len(ids)} {demo_id}: row missing, skip")
                    continue
                match_data, match_data_url = row[0], row[1]

            # Prefer jsonb (avoids a Storage round-trip); fall back to the
            # gzipped JSON at match_data_url, which is where new demos park
            # the blob since the Postgres jsonb column was retired for size.
            if match_data:
                payload = match_data  # psycopg2 returns jsonb as dict
                src = "jsonb"
            elif match_data_url:
                gz = supabase.storage.from_("match-data").download(match_data_url)
                payload = json.loads(gzip.decompress(gz).decode("utf-8"))
                src = f"storage({match_data_url})"
            else:
                print(f"[backfill] {i}/{len(ids)} {demo_id}: no match_data anywhere, skip")
                continue

            slim = build_slim_payload(payload)
            slim_json = json.dumps(slim)
            slim_mb = len(slim_json) / 1024 / 1024
            print(f"[backfill] {i}/{len(ids)} {demo_id}: src={src} slim={slim_mb:.2f} MB")

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
