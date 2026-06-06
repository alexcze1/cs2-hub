# vps/db.py
#
# Shared Postgres connection helper. Imported by main.py and hltv_ingest.py so
# the connection settings (timeouts, keepalives, statement_timeout) live in
# exactly one place.

import os
import sys
from contextlib import contextmanager
from urllib.parse import urlparse

import psycopg2


def _check_database_url_port(url: str) -> None:
    # The Supabase *transaction* pooler runs on 6543 and silently breaks our
    # long-lived transactions ⇒ demos hang in "Processing". We MUST use the
    # session pooler on 5432. Warn loudly at import time so a future env
    # regression is obvious in logs instead of materialising as stuck demos.
    try:
        port = urlparse(url).port
    except Exception:
        return
    if port == 6543:
        print(
            "[db] WARNING: DATABASE_URL points at the Supabase transaction pooler "
            "(port 6543). Demos will stall in 'Processing'. Use the session "
            "pooler on port 5432.",
            file=sys.stderr,
            flush=True,
        )


_DB_URL = os.environ.get("DATABASE_URL", "")
if _DB_URL:
    _check_database_url_port(_DB_URL)


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
