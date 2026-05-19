# vps/db.py
#
# Shared Postgres connection helper. Imported by main.py and hltv_ingest.py so
# the connection settings (timeouts, keepalives, statement_timeout) live in
# exactly one place.

import os
from contextlib import contextmanager

import psycopg2


@contextmanager
def get_db():
    # keepalives: detect dead pooler connections in ~25s instead of hanging indefinitely.
    # statement_timeout: server kills any single statement > 180s (large match_data writes
    # have measured at ~45s, so 180s is generous headroom while still bounding hangs).
    conn = psycopg2.connect(
        os.environ["DATABASE_URL"],
        connect_timeout=10,
        keepalives=1,
        keepalives_idle=10,
        keepalives_interval=5,
        keepalives_count=3,
    )
    try:
        with conn.cursor() as cur:
            cur.execute("SET statement_timeout = '180s'")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
