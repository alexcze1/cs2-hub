# vps/main.py
import asyncio
import functools
import gzip
import time
import json
import os
import shutil
import socket
import subprocess
import sys
import traceback
import uuid
import datetime
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from contextlib import asynccontextmanager
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client

from db import get_db
from demo_parser import parse_demo, build_slim_payload, compute_player_stats, compute_team_stats
from backfill_hltv_vetos import sync_team_vetos

socket.setdefaulttimeout(30)
sys.stdout.reconfigure(line_buffering=True)

# Force IPv4 — VPS has no IPv6 routing
_orig_getaddrinfo = socket.getaddrinfo
def _ipv4_getaddrinfo(host, port, family=0, *args, **kwargs):
    return _orig_getaddrinfo(host, port, socket.AF_INET, *args, **kwargs)
socket.getaddrinfo = _ipv4_getaddrinfo

load_dotenv()

SUPABASE_URL  = os.environ["SUPABASE_URL"]
SUPABASE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
DATABASE_URL  = os.environ["DATABASE_URL"]
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "10"))
STUCK_MINUTES = 2
DEMOS_DIR     = Path("/opt/midround/demos")

# Auto-retry for status='error' demos. A transient failure (pooler timeout,
# parser OOM, network blip during HLTV download) would otherwise park the
# demo as "Failed" in the UI forever. Cap attempts so a truly broken demo
# (corrupt .dem, unparseable format) eventually stops looping. Backoff
# ensures we don't hammer the same failing demo every POLL_INTERVAL.
RETRY_MAX         = int(os.getenv("RETRY_MAX", "3"))
RETRY_BACKOFF_MIN = int(os.getenv("RETRY_BACKOFF_MIN", "30"))

# Parser concurrency. parse_demo is CPU-bound (demoparser2 + Python loops) so
# multiple demos can only parse in parallel via separate processes — threads
# serialize on the GIL. Default leaves one core for FastAPI + DB + HLTV ingest.
PARSE_WORKERS = int(os.getenv("PARSE_WORKERS", str(max(1, min((os.cpu_count() or 2) - 1, 4)))))
_parse_pool: ProcessPoolExecutor | None = None


def _replace_pool_if_unchanged(broken_pool: ProcessPoolExecutor) -> None:
    # ProcessPoolExecutor goes permanently dead the moment a worker is killed
    # (OOM, segfault) — every submit() after that raises BrokenProcessPool.
    # We install a fresh pool so the next poll cycle can parse normally; the
    # demo that triggered the death still errors out and goes through the
    # auto-retry path. Identity check makes this safe when several concurrent
    # demos all observe the same broken pool: the first call replaces, the
    # rest no-op.
    global _parse_pool
    if _parse_pool is not broken_pool:
        return
    _parse_pool = ProcessPoolExecutor(max_workers=PARSE_WORKERS)
    try:
        broken_pool.shutdown(wait=False, cancel_futures=True)
    except Exception:
        pass
    print(f"[pool] recreated ProcessPoolExecutor (workers={PARSE_WORKERS}) after BrokenProcessPool")

# HLTV ingest loop: how often to scan + how far back to scan each cycle.
# 24h interval with a 2-day window gives 1-day overlap to catch matches posted
# late after the previous cycle.
HLTV_INGEST_INTERVAL = int(os.getenv("HLTV_INGEST_INTERVAL", str(24 * 3600)))
HLTV_INGEST_DAYS     = int(os.getenv("HLTV_INGEST_DAYS", "2"))

# HLTV team / player refresh: every 24 h. Cheaper than ingest (no demo
# downloads), so the loop is shorter — usually 5-10 min wall time.
HLTV_REFRESH_INTERVAL = int(os.getenv("HLTV_REFRESH_INTERVAL", str(24 * 3600)))

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _parse_pool
    DEMOS_DIR.mkdir(parents=True, exist_ok=True)
    _parse_pool = ProcessPoolExecutor(max_workers=PARSE_WORKERS)
    print(f"Parser pool started with {PARSE_WORKERS} worker(s)")
    poll_task    = asyncio.create_task(_poll_loop())
    ingest_task  = asyncio.create_task(_hltv_ingest_loop())
    refresh_task = asyncio.create_task(_hltv_refresh_loop())
    yield
    poll_task.cancel()
    ingest_task.cancel()
    refresh_task.cancel()
    _parse_pool.shutdown(wait=False, cancel_futures=True)
    # Tear down the Playwright Chromium if the ingest loop launched it.
    try:
        from hltv_scraper import shutdown_playwright
        shutdown_playwright()
    except Exception:
        pass

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


# ── On-demand HLTV veto sync ─────────────────────────────────────
#
# Frontend calls this when the user searches a team in the veto simulator.
# We list the team's matches from /results?team=<id> for the last `months`,
# diff against hltv_team_vetos, and parse the veto box on each new match
# page. Idempotent — re-syncing a fully-cached team is a single /results
# request.
#
# Throttled per-team so a user mashing the autocomplete can't burn HLTV's
# per-IP rate budget (chrome-headless behind us already gets CF-flagged
# pretty quickly under load).

_veto_sync_last:    dict[str, float] = {}  # team_name_lower -> last completion ts
_veto_sync_started: dict[str, float] = {}  # team_name_lower -> start ts (still running)
_VETO_SYNC_THROTTLE_SEC = 600              # 10 min between successful runs per team
_VETO_SYNC_RUNNING_GRACE_SEC = 1200        # 20 min — assume a still-running task is stuck if older
_veto_sync_lock = asyncio.Lock()           # serialize HLTV page fetches across all in-flight syncs


class SyncTeamVetosRequest(BaseModel):
    team_name: str
    months: int = 3


async def _run_sync_in_bg(name: str, months: int) -> None:
    """Run sync_team_vetos under the global HLTV-fetch lock and record
    timestamps so the endpoint can throttle correctly without blocking the
    caller. Each HLTV page is ~15-30s with CF, so 30 new matches takes
    several minutes — frontend doesn't wait for this."""
    key = name.lower()
    _veto_sync_started[key] = time.time()
    try:
        async with _veto_sync_lock:
            try:
                await asyncio.get_event_loop().run_in_executor(
                    None, lambda: sync_team_vetos(name, months=months, sleep=1.5),
                )
            except Exception as e:
                print(f"[veto-sync] {name}: {type(e).__name__}: {e}")
    finally:
        _veto_sync_last[key] = time.time()
        _veto_sync_started.pop(key, None)


@app.post("/sync-team-vetos")
async def sync_team_vetos_endpoint(
    req: SyncTeamVetosRequest,
    authorization: str = Header(None),
):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing auth token")
    token = authorization[7:]
    try:
        await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(None, lambda: supabase.auth.get_user(token)),
            timeout=10,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Auth service unavailable")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid auth token")

    name = (req.team_name or "").strip()
    if not name:
        return {"team_name": name, "queued": False, "reason": "empty"}

    key = name.lower()
    now = time.time()
    last_ok    = _veto_sync_last.get(key, 0)
    started_at = _veto_sync_started.get(key, 0)
    if now - last_ok < _VETO_SYNC_THROTTLE_SEC:
        return {"team_name": name, "queued": False, "reason": "throttled",
                "next_allowed_in_sec": int(_VETO_SYNC_THROTTLE_SEC - (now - last_ok))}
    if started_at and (now - started_at) < _VETO_SYNC_RUNNING_GRACE_SEC:
        return {"team_name": name, "queued": False, "reason": "in_progress"}

    months = max(1, min(12, int(req.months or 3)))
    asyncio.create_task(_run_sync_in_bg(name, months))
    return {"team_name": name, "queued": True}


@app.post("/upload")
async def upload_demo(
    file: UploadFile = File(...),
    team_id: str = Form(...),
    authorization: str = Header(None),
):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing auth token")
    token = authorization[7:]
    try:
        user_resp = await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(None, lambda: supabase.auth.get_user(token)),
            timeout=10,
        )
        user_id = user_resp.user.id
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Auth service unavailable, try again")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid auth token")

    if not file.filename or not file.filename.endswith(".dem"):
        raise HTTPException(status_code=400, detail="Only .dem files allowed")

    demo_id    = str(uuid.uuid4())
    local_path = DEMOS_DIR / f"{demo_id}.dem"

    try:
        with local_path.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {e}")

    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO demos (id, team_id, uploaded_by, status, storage_path)
                       VALUES (%s, %s, %s, 'pending', %s)""",
                    (demo_id, team_id, user_id, f"local:{demo_id}.dem"),
                )
    except Exception as e:
        local_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Failed to create record: {e}")

    return {"demo_id": demo_id}


async def _poll_loop():
    print("Polling loop started")
    while True:
        try:
            await _reset_stuck()
            await _retry_errors()
            await _process_pending()
        except asyncio.CancelledError:
            print("Poll loop cancelled — shutting down")
            raise
        except BaseException as e:
            print(f"Poll error ({type(e).__name__}): {e}")
        await asyncio.sleep(POLL_INTERVAL)


async def _hltv_ingest_loop():
    if not int(os.getenv("HLTV_INGEST_ENABLED", "1")):
        print("HLTV ingest loop disabled (HLTV_INGEST_ENABLED=0) — skipping")
        return
    print(f"HLTV ingest loop started (interval={HLTV_INGEST_INTERVAL}s, days={HLTV_INGEST_DAYS})")
    # Track whether the previous cycle exited cleanly so a transient Playwright
    # crash (Chromium OOM, CF rate-limit, network blip) only costs ~15 min,
    # not a full 24 h. _hltv_ingest_once sets _last_ingest_ok on the module.
    while True:
        global _last_ingest_ok
        _last_ingest_ok = True
        try:
            await asyncio.get_event_loop().run_in_executor(None, _hltv_ingest_once)
        except asyncio.CancelledError:
            print("HLTV ingest loop cancelled — shutting down")
            raise
        except BaseException as e:
            print(f"HLTV ingest error ({type(e).__name__}): {e}")
            _last_ingest_ok = False
        delay = HLTV_INGEST_INTERVAL if _last_ingest_ok else 900   # 15 min on failure
        await asyncio.sleep(delay)


_last_ingest_ok = True


async def _hltv_refresh_loop():
    """Daily HLTV team + player refresh — keeps autocomplete logos/photos fresh.

    Starts 45 min after the service boots so its Chromium doesn't compete with
    the ingest subprocess at startup. A 512 MB VPS can't comfortably run two
    headless Chromium instances simultaneously; observed symptom is both
    Playwrights hitting `Page.goto: Timeout 30000ms exceeded` and crashing.
    """
    if not int(os.getenv("HLTV_REFRESH_ENABLED", "1")):
        print("HLTV refresh loop disabled (HLTV_REFRESH_ENABLED=0) — skipping")
        return
    initial_delay = int(os.getenv("HLTV_REFRESH_STARTUP_DELAY", "2700"))  # 45 min
    print(f"HLTV refresh loop started (interval={HLTV_REFRESH_INTERVAL}s, "
          f"first run in {initial_delay}s)")
    await asyncio.sleep(initial_delay)
    while True:
        try:
            await asyncio.get_event_loop().run_in_executor(None, _hltv_refresh_once)
        except asyncio.CancelledError:
            print("HLTV refresh loop cancelled — shutting down")
            raise
        except BaseException as e:
            print(f"HLTV refresh error ({type(e).__name__}): {e}")
        await asyncio.sleep(HLTV_REFRESH_INTERVAL)


def _hltv_refresh_once():
    """Spawn a subprocess to run one HLTV team + player refresh cycle.

    Same subprocess-isolation rationale as _hltv_ingest_once: sync Playwright
    needs a fresh interpreter to avoid the parent's asyncio loop.
    """
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "hltv_refresh_subprocess"],
        cwd=str(Path(__file__).resolve().parent),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
        text=True,
    )
    # 30-min cap — a healthy refresh runs in 5-10 min (30 teams × 2 page fetches
    # × ~5 s incl. networkidle waits). 30 min absorbs CF retries comfortably.
    deadline = datetime.datetime.utcnow() + datetime.timedelta(seconds=1800)
    try:
        for line in proc.stdout:
            sys.stdout.write(line)
            if datetime.datetime.utcnow() > deadline:
                print("[refresh] subprocess deadline exceeded — killing")
                proc.kill()
                break
        proc.wait(timeout=60)
    except Exception as e:
        print(f"[refresh] subprocess stream error: {type(e).__name__}: {e}")
        try: proc.kill()
        except Exception: pass
        proc.wait(timeout=60)

    if proc.returncode != 0:
        print(f"[refresh] subprocess exited with {proc.returncode}")


def _hltv_ingest_once():
    """Spawn a subprocess to run one HLTV ingest cycle.

    The subprocess isolates sync_playwright from this process's asyncio loop —
    Playwright's sync API guard would otherwise trip "Sync API inside the
    asyncio loop" on subsequent cycles when partial state from a failed cycle
    leaked across the worker thread. A fresh interpreter avoids that entirely.

    Env propagated via os.environ inheritance (DATABASE_URL, SUPABASE_*,
    HLTV_INGEST_DAYS, HLTV_FORCE_PLAYWRIGHT, HLTV_DEMOS_DIR_SOFT_CAP_BYTES).
    DEMOS_DIR is passed explicitly so the subprocess writes .dem files where
    _process_pending() will find them.
    """
    env = os.environ.copy()
    env["DEMOS_DIR"] = str(DEMOS_DIR)
    env["HLTV_INGEST_DAYS"] = str(HLTV_INGEST_DAYS)
    env["PYTHONUNBUFFERED"] = "1"

    # Stream stdout line-by-line so each "discovered N matches" / "ingested N
    # demos" line appears in the journal immediately — `subprocess.run` with
    # capture_output buffers everything until the process exits, which makes
    # a multi-hour ingest cycle look indistinguishable from a hang. `-u` flag
    # plus PYTHONUNBUFFERED defeats Python's own block buffering on stdout.
    # stderr is merged into stdout so errors interleave with progress.
    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "hltv_ingest_subprocess"],
        cwd=str(Path(__file__).resolve().parent),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
        text=True,
    )

    # 2-hour cap: a full cycle of ~100 matches × ~60 s download averages ~100 min.
    # If the subprocess exceeds that, something is stuck.
    deadline = datetime.datetime.utcnow() + datetime.timedelta(seconds=7200)
    try:
        for line in proc.stdout:                 # blocks until the child writes a line
            sys.stdout.write(line)
            if datetime.datetime.utcnow() > deadline:
                print("[hltv] subprocess deadline exceeded — killing")
                proc.kill()
                break
        proc.wait(timeout=60)
    except Exception as e:
        print(f"[hltv] subprocess stream error: {type(e).__name__}: {e}")
        try: proc.kill()
        except Exception: pass
        proc.wait(timeout=60)

    if proc.returncode != 0:
        print(f"[hltv] subprocess exited with {proc.returncode}")
        # Flag failure so _hltv_ingest_loop retries in 15 min instead of 24 h.
        global _last_ingest_ok
        _last_ingest_ok = False


def _reset_stuck_sync(cutoff):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE demos SET status = 'pending' WHERE status = 'processing' AND updated_at < %s",
                (cutoff,),
            )


async def _reset_stuck():
    cutoff = (datetime.datetime.utcnow() - datetime.timedelta(minutes=STUCK_MINUTES)).isoformat()
    await asyncio.get_event_loop().run_in_executor(None, _reset_stuck_sync, cutoff)


def _retry_errors_sync(cutoff, max_retries):
    """Requeue error rows whose retry budget isn't exhausted and whose last
    attempt was long enough ago. Returns the number of rows requeued so the
    caller can log it (helps confirm the loop is alive in journalctl).
    """
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE demos
                      SET status     = 'pending',
                          updated_at = %s
                    WHERE status      = 'error'
                      AND retry_count < %s
                      AND updated_at  < %s""",
                (datetime.datetime.utcnow().isoformat(), max_retries, cutoff),
            )
            return cur.rowcount


async def _retry_errors():
    cutoff = (datetime.datetime.utcnow() - datetime.timedelta(minutes=RETRY_BACKOFF_MIN)).isoformat()
    n = await asyncio.get_event_loop().run_in_executor(
        None, _retry_errors_sync, cutoff, RETRY_MAX,
    )
    if n:
        print(f"[retry] requeued {n} error row(s) (retry_count < {RETRY_MAX}, backoff {RETRY_BACKOFF_MIN}m)")


def _fetch_pending():
    with get_db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT id, storage_path, team_id, is_public FROM demos "
                "WHERE status = 'pending' LIMIT 5"
            )
            return cur.fetchall()


async def _process_pending():
    loop = asyncio.get_event_loop()
    demos = await loop.run_in_executor(None, _fetch_pending)
    if not demos:
        return
    # Run the batch concurrently — parse_demo is offloaded to the process pool
    # (PARSE_WORKERS workers), DB/storage steps share the default thread pool.
    # asyncio.gather lets multiple demos overlap their I/O + CPU phases.
    await asyncio.gather(*(_process_one(d) for d in demos), return_exceptions=True)


def _db_set_processing(demo_id):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE demos SET status = 'processing', updated_at = %s WHERE id = %s",
                (datetime.datetime.utcnow().isoformat(), demo_id),
            )


def _db_set_error(demo_id, msg):
    # Increment retry_count alongside the status change. _retry_errors() uses
    # this to decide whether to requeue (caps at RETRY_MAX attempts).
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE demos
                      SET status        = 'error',
                          updated_at    = %s,
                          error_message = %s,
                          retry_count   = COALESCE(retry_count, 0) + 1
                    WHERE id = %s""",
                (datetime.datetime.utcnow().isoformat(), msg[:500], demo_id),
            )


def _db_write_results(demo_id, team_id, meta, ct_score, t_score, match_data, slim_data, *, is_public=False):
    print(f"[db] serializing match_data (frames={len(match_data.get('frames', []))}) ...")
    match_json = json.dumps(match_data)
    slim_json  = json.dumps(slim_data)
    print(f"[db] match_data JSON size: {len(match_json) / 1024 / 1024:.1f} MB")
    print(f"[db] match_data_slim JSON size: {len(slim_json) / 1024 / 1024:.2f} MB")

    # match_data goes to Storage (gzipped) — the 40+ MB jsonb UPDATE was hitting
    # the 240 s asyncio cap before the statement could even finish uploading
    # through the cross-region pooler. Storage handles the blob; Postgres only
    # gets the path + the small slim payload that analysis.html joins on.
    match_gz = gzip.compress(match_json.encode("utf-8"), compresslevel=6)
    print(f"[storage] match_data gzipped: {len(match_gz) / 1024 / 1024:.2f} MB")
    # HLTV-ingested demos have team_id=NULL; bucket them under 'public/' so the
    # storage RLS policy can grant anon read access to those (matches the public
    # RLS on the demos table itself).
    storage_path = f"{team_id or 'public'}/{demo_id}.json.gz"
    # x-upsert lets a re-parse overwrite a previous upload for the same demo.
    supabase.storage.from_("match-data").upload(
        storage_path,
        match_gz,
        file_options={"content-type": "application/gzip", "x-upsert": "true"},
    )
    print(f"[storage] uploaded to match-data/{storage_path}")

    # For public (HLTV-ingested) demos the team_a_score / team_b_score columns
    # are set at INGEST from the HLTV match page, which is authoritative and
    # correctly paired with team_a_name. The parser's per-CT-roster scores
    # swap per map within a series and would mis-pair with our constant
    # team_a_name. So we don't touch them here.
    with get_db() as conn:
        with conn.cursor() as cur:
            print(f"[db] writing to postgres ...")
            if is_public:
                cur.execute(
                    """UPDATE demos SET
                         status = 'ready',
                         updated_at = %s,
                         map = %s,
                         score_ct = %s,
                         score_t = %s,
                         team_a_first_side = %s,
                         duration_ticks = %s,
                         tick_rate = %s,
                         match_data = NULL,
                         match_data_url = %s,
                         match_data_slim = %s
                       WHERE id = %s""",
                    (
                        datetime.datetime.utcnow().isoformat(),
                        meta["map"],
                        ct_score,
                        t_score,
                        meta.get("team_a_first_side"),
                        meta["total_ticks"],
                        meta["tick_rate"],
                        storage_path,
                        slim_json,
                        demo_id,
                    ),
                )
            else:
                cur.execute(
                    """UPDATE demos SET
                         status = 'ready',
                         updated_at = %s,
                         map = %s,
                         score_ct = %s,
                         score_t = %s,
                         team_a_score = %s,
                         team_b_score = %s,
                         team_a_first_side = %s,
                         duration_ticks = %s,
                         tick_rate = %s,
                         match_data = NULL,
                         match_data_url = %s,
                         match_data_slim = %s
                       WHERE id = %s""",
                    (
                        datetime.datetime.utcnow().isoformat(),
                        meta["map"],
                        ct_score,
                        t_score,
                        meta.get("team_a_score"),
                        meta.get("team_b_score"),
                        meta.get("team_a_first_side"),
                        meta["total_ticks"],
                        meta["tick_rate"],
                        storage_path,
                        slim_json,
                        demo_id,
                    ),
                )
            print(f"[db] postgres write done")


# Columns for demo_players inserts. Order MUST match the VALUES tuple below.
_PLAYER_STAT_COLS = (
    "id", "demo_id", "steam_id", "name", "team", "side",
    "kills", "deaths", "assists",
    "adr", "rating", "hs_pct", "kast_pct",
    "multi_2k", "multi_3k", "multi_4k", "multi_5k",
    "opening_kills", "opening_deaths",
    "clutches_won", "clutches_lost",
    "utility_dmg", "flash_assists", "traded_deaths",
    "impact_rating", "rounds_played",
)

# Columns for demo_team_stats. Same ordering rule.
_TEAM_STAT_COLS = (
    "id", "demo_id", "team",
    "pistol_wins", "pistol_played",
    "five_v_four_wins", "five_v_four_played",
    "five_v_four_t_wins", "five_v_four_t_played",
    "five_v_four_ct_wins", "five_v_four_ct_played",
    "first_kills", "first_deaths",
    "first_kills_t", "first_kills_ct",
    "first_deaths_t", "first_deaths_ct",
    "hard_eco_wins", "hard_eco_played",
    "eco_wins", "eco_played",
    "force_wins", "force_played",
    "half_buy_wins", "half_buy_played",
    "full_buy_wins", "full_buy_played",
    "anti_eco_wins", "anti_eco_played",
    "anti_force_wins", "anti_force_played",
    "bomb_plants", "bomb_defuses",
    "ct_round_wins", "ct_rounds_played",
    "t_round_wins", "t_rounds_played",
)


def write_stats_for_demo(demo_id: str, parsed: dict) -> None:
    """Compute and replace per-demo stat rows. Soft-failures: log and continue."""
    # Players
    try:
        player_rows = compute_player_stats(parsed)
        if player_rows:
            tuples = []
            for r in player_rows:
                tuples.append((
                    str(uuid.uuid4()), demo_id,
                    r.get("steam_id") or "", r.get("name") or "",
                    r.get("team"), r.get("side"),
                    r.get("kills", 0), r.get("deaths", 0), r.get("assists", 0),
                    r.get("adr", 0.0), r.get("rating", 0.0),
                    r.get("hs_pct", 0.0), r.get("kast_pct", 0.0),
                    r.get("multi_2k", 0), r.get("multi_3k", 0),
                    r.get("multi_4k", 0), r.get("multi_5k", 0),
                    r.get("opening_kills", 0), r.get("opening_deaths", 0),
                    r.get("clutches_won", 0), r.get("clutches_lost", 0),
                    r.get("utility_dmg", 0), r.get("flash_assists", 0),
                    r.get("traded_deaths", 0),
                    r.get("impact_rating", 0.0), r.get("rounds_played", 0),
                ))
            with get_db() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM demo_players WHERE demo_id = %s", (demo_id,)
                    )
                    psycopg2.extras.execute_values(
                        cur,
                        f"INSERT INTO demo_players ({', '.join(_PLAYER_STAT_COLS)}) VALUES %s",
                        tuples,
                    )
            print(f"[stats] wrote {len(tuples)} player rows for demo {demo_id}")
    except Exception as e:
        print(f"[stats] player stats write failed for {demo_id}: {e}")
        print(traceback.format_exc())

    # Team stats
    try:
        team_rows = compute_team_stats(parsed)
        if team_rows:
            tuples = []
            for r in team_rows:
                tuples.append((
                    str(uuid.uuid4()), demo_id, r.get("team"),
                    r.get("pistol_wins", 0), r.get("pistol_played", 0),
                    r.get("five_v_four_wins", 0), r.get("five_v_four_played", 0),
                    r.get("five_v_four_t_wins", 0), r.get("five_v_four_t_played", 0),
                    r.get("five_v_four_ct_wins", 0), r.get("five_v_four_ct_played", 0),
                    r.get("first_kills", 0), r.get("first_deaths", 0),
                    r.get("first_kills_t", 0), r.get("first_kills_ct", 0),
                    r.get("first_deaths_t", 0), r.get("first_deaths_ct", 0),
                    r.get("hard_eco_wins", 0), r.get("hard_eco_played", 0),
                    r.get("eco_wins", 0), r.get("eco_played", 0),
                    r.get("force_wins", 0), r.get("force_played", 0),
                    r.get("half_buy_wins", 0), r.get("half_buy_played", 0),
                    r.get("full_buy_wins", 0), r.get("full_buy_played", 0),
                    r.get("anti_eco_wins", 0), r.get("anti_eco_played", 0),
                    r.get("anti_force_wins", 0), r.get("anti_force_played", 0),
                    r.get("bomb_plants", 0), r.get("bomb_defuses", 0),
                    r.get("ct_round_wins", 0), r.get("ct_rounds_played", 0),
                    r.get("t_round_wins", 0), r.get("t_rounds_played", 0),
                ))
            with get_db() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM demo_team_stats WHERE demo_id = %s", (demo_id,)
                    )
                    psycopg2.extras.execute_values(
                        cur,
                        f"INSERT INTO demo_team_stats ({', '.join(_TEAM_STAT_COLS)}) VALUES %s",
                        tuples,
                    )
            print(f"[stats] wrote {len(tuples)} team rows for demo {demo_id}")
    except Exception as e:
        print(f"[stats] team stats write failed for {demo_id}: {e}")
        print(traceback.format_exc())


async def _process_one(demo: dict):
    demo_id      = demo["id"]
    team_id      = demo["team_id"]
    storage_path = demo["storage_path"]
    is_local     = storage_path.startswith("local:")
    is_public    = bool(demo.get("is_public"))
    loop         = asyncio.get_event_loop()

    await loop.run_in_executor(None, _db_set_processing, demo_id)
    print(f"Processing demo {demo_id}")

    tmp_path = None
    pool_used: ProcessPoolExecutor | None = None
    try:
        if is_local:
            tmp_path = str(DEMOS_DIR / storage_path[6:])
        else:
            file_bytes = supabase.storage.from_("demos").download(storage_path)
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".dem", delete=False) as tmp:
                tmp.write(file_bytes)
                tmp_path = tmp.name

        # CPU-bound parse runs in a worker process to bypass the GIL.
        pool_used = _parse_pool
        match_data = await loop.run_in_executor(pool_used, parse_demo, tmp_path)
        slim_data  = build_slim_payload(match_data)

        meta     = match_data["meta"]
        ct_score = meta["ct_score"]
        t_score  = meta["t_score"]

        # Bound the write at 240s so a stuck pooler connection can't lock the
        # poll loop forever — server statement_timeout (180s) should fire first;
        # this is a belt-and-suspenders cap. On timeout the demo is marked error
        # and the loop continues; the leaked connection eventually gets reaped
        # by keepalives.
        try:
            await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    functools.partial(
                        _db_write_results,
                        demo_id, team_id, meta, ct_score, t_score, match_data, slim_data,
                        is_public=is_public,
                    ),
                ),
                timeout=240,
            )
        except asyncio.TimeoutError:
            raise RuntimeError("postgres write exceeded 240s — connection likely stuck")

        # Stats are computed & written in a separate transaction so a stats
        # failure can't poison the demo's primary write. Bounded at 240s
        # for the same reason as the primary write — keep the poll loop
        # responsive if a stats connection hangs.
        try:
            await asyncio.wait_for(
                loop.run_in_executor(None, write_stats_for_demo, demo_id, match_data),
                timeout=240,
            )
        except asyncio.TimeoutError:
            print(f"[stats] write exceeded 240s for {demo_id} — skipping (demo write already committed)")

        # No post-parse team reconciliation needed: for public demos, both
        # (team_a_name, team_b_name) and (team_a_score, team_b_score) are
        # set at ingest from the HLTV match page and are guaranteed paired.

        print(f"Done: {demo_id} — {meta['map']} {ct_score}-{t_score}")

        # Public demos (HLTV-ingested) discard the local .dem after a successful
        # parse — match_data + slim + stat rows are the only artefacts we keep.
        # Errors skip this branch on purpose so a stuck demo can be re-parsed
        # without re-downloading from HLTV.
        if is_local and is_public:
            Path(tmp_path).unlink(missing_ok=True)
            print(f"[cleanup] deleted local .dem for public demo {demo_id}")

    except BrokenProcessPool as e:
        print(f"Failed {demo_id} (BrokenProcessPool): {e}")
        if pool_used is not None:
            _replace_pool_if_unchanged(pool_used)
        await loop.run_in_executor(None, _db_set_error, demo_id, f"BrokenProcessPool: {e}")
    except Exception as e:
        print(f"Failed {demo_id} ({type(e).__name__}): {e}")
        await loop.run_in_executor(None, _db_set_error, demo_id, str(e))
    finally:
        if tmp_path and not is_local:
            Path(tmp_path).unlink(missing_ok=True)
