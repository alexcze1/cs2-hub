"""One-shot migration: move existing demos.match_data jsonb into the 'match-data'
Storage bucket as gzipped JSON, then NULL the column so future reads use the URL.

Usage (on VPS):
    cd /opt/midround/vps && ./.venv/bin/python3 migrate_match_data.py

Idempotent: skips demos that already have match_data_url set. Re-running after
a failure picks up where it left off.
"""
import gzip
import json
import os
import sys

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
DATABASE_URL = os.environ["DATABASE_URL"]


def fetch_targets():
    """Demos that are ready and still have inline match_data but no URL yet."""
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, team_id, is_public
                FROM demos
                WHERE status = 'ready'
                  AND match_data IS NOT NULL
                  AND match_data_url IS NULL
                ORDER BY updated_at ASC
                """
            )
            return cur.fetchall()
    finally:
        conn.close()


def migrate_one(demo_id, team_id, is_public):
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            # Pull match_data as text so we can gzip without re-serialising.
            cur.execute("SELECT match_data::text FROM demos WHERE id = %s", (demo_id,))
            row = cur.fetchone()
            if not row or not row[0]:
                print(f"  skip {demo_id} — no match_data")
                return False
            match_text = row[0]

        match_gz = gzip.compress(match_text.encode("utf-8"), compresslevel=6)
        prefix = str(team_id) if team_id else "public"
        storage_path = f"{prefix}/{demo_id}.json.gz"

        supabase.storage.from_("match-data").upload(
            storage_path,
            match_gz,
            file_options={"content-type": "application/gzip", "x-upsert": "true"},
        )

        with conn.cursor() as cur:
            cur.execute(
                "UPDATE demos SET match_data_url = %s, match_data = NULL WHERE id = %s",
                (storage_path, demo_id),
            )
        conn.commit()
        print(
            f"  ok   {demo_id}  raw={len(match_text)/1024/1024:.1f} MB  "
            f"gz={len(match_gz)/1024/1024:.2f} MB  → {storage_path}"
        )
        return True
    except Exception as e:
        conn.rollback()
        print(f"  FAIL {demo_id}: {type(e).__name__}: {e}")
        return False
    finally:
        conn.close()


def main():
    targets = fetch_targets()
    print(f"Found {len(targets)} demo(s) to migrate")
    if not targets:
        return
    ok = fail = 0
    for d in targets:
        success = migrate_one(d["id"], d["team_id"], d["is_public"])
        if success:
            ok += 1
        else:
            fail += 1
    print(f"\nDone: {ok} migrated, {fail} failed")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
