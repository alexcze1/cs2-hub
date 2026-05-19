# vps/main.py
import asyncio
import json
import os
import shutil
import socket
import sys
import traceback
import uuid
import datetime
from contextlib import asynccontextmanager
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client, Client

from db import get_db
from demo_parser import parse_demo, build_slim_payload, compute_player_stats, compute_team_stats

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

# HLTV ingest loop: how often to scan + how far back to scan each cycle.
# 24h interval with a 2-day window gives 1-day overlap to catch matches posted
# late after the previous cycle.
HLTV_INGEST_INTERVAL = int(os.getenv("HLTV_INGEST_INTERVAL", str(24 * 3600)))
HLTV_INGEST_DAYS     = int(os.getenv("HLTV_INGEST_DAYS", "2"))

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


@asynccontextmanager
async def lifespan(app: FastAPI):
    DEMOS_DIR.mkdir(parents=True, exist_ok=True)
    poll_task   = asyncio.create_task(_poll_loop())
    ingest_task = asyncio.create_task(_hltv_ingest_loop())
    yield
    poll_task.cancel()
    ingest_task.cancel()

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
            await _process_pending()
        except asyncio.CancelledError:
            print("Poll loop cancelled — shutting down")
            raise
        except BaseException as e:
            print(f"Poll error ({type(e).__name__}): {e}")
        await asyncio.sleep(POLL_INTERVAL)


async def _hltv_ingest_loop():
    print(f"HLTV ingest loop started (interval={HLTV_INGEST_INTERVAL}s, days={HLTV_INGEST_DAYS})")
    while True:
        try:
            await asyncio.get_event_loop().run_in_executor(None, _hltv_ingest_once)
        except asyncio.CancelledError:
            print("HLTV ingest loop cancelled — shutting down")
            raise
        except BaseException as e:
            print(f"HLTV ingest error ({type(e).__name__}): {e}")
        await asyncio.sleep(HLTV_INGEST_INTERVAL)


def _hltv_ingest_once():
    # Imported lazily so a missing cloudscraper dep (e.g. dev box) doesn't break
    # the rest of main.py at import time.
    from hltv_scraper import list_recent_matches, HLTVBlockedError, DiskCapExceeded
    from hltv_ingest import ingest_match

    matches = list_recent_matches(days=HLTV_INGEST_DAYS)
    print(f"[hltv] discovered {len(matches)} matches in last {HLTV_INGEST_DAYS}d")
    for m in matches:
        try:
            n = ingest_match(m, DEMOS_DIR)
            if n:
                print(f"[hltv] ingested {n} demos for {m.team_a} vs {m.team_b} ({m.hltv_id})")
        except DiskCapExceeded as e:
            # Hit the soft cap mid-cycle — stop fetching; the parser will drain
            # pending rows and next cycle will resume from where we stopped.
            print(f"[hltv] disk cap reached, stopping cycle: {e}")
            return
        except HLTVBlockedError as e:
            # Cloudflare is angry; bail out of this cycle and try again next interval.
            print(f"[hltv] Cloudflare block, stopping cycle: {e}")
            return
        except Exception as e:
            print(f"[hltv] skip {m.hltv_id} ({type(e).__name__}): {e}")


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
    for demo in demos:
        await _process_one(demo)


def _db_set_processing(demo_id):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE demos SET status = 'processing', updated_at = %s WHERE id = %s",
                (datetime.datetime.utcnow().isoformat(), demo_id),
            )


def _db_set_error(demo_id, msg):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE demos SET status = 'error', updated_at = %s, error_message = %s WHERE id = %s",
                (datetime.datetime.utcnow().isoformat(), msg[:500], demo_id),
            )


def _db_write_results(demo_id, meta, ct_score, t_score, match_data, slim_data):
    print(f"[db] serializing match_data (frames={len(match_data.get('frames', []))}) ...")
    match_json = json.dumps(match_data)
    slim_json  = json.dumps(slim_data)
    print(f"[db] match_data JSON size: {len(match_json) / 1024 / 1024:.1f} MB")
    print(f"[db] match_data_slim JSON size: {len(slim_json) / 1024 / 1024:.2f} MB")
    with get_db() as conn:
        with conn.cursor() as cur:
            print(f"[db] writing to postgres ...")
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
                     match_data = %s,
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
                    match_json,
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
    "eco_wins", "eco_played",
    "force_wins", "force_played",
    "anti_eco_wins", "anti_eco_played",
    "full_buy_wins", "full_buy_played",
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
                    r.get("eco_wins", 0), r.get("eco_played", 0),
                    r.get("force_wins", 0), r.get("force_played", 0),
                    r.get("anti_eco_wins", 0), r.get("anti_eco_played", 0),
                    r.get("full_buy_wins", 0), r.get("full_buy_played", 0),
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
    storage_path = demo["storage_path"]
    is_local     = storage_path.startswith("local:")
    is_public    = bool(demo.get("is_public"))
    loop         = asyncio.get_event_loop()

    await loop.run_in_executor(None, _db_set_processing, demo_id)
    print(f"Processing demo {demo_id}")

    tmp_path = None
    try:
        if is_local:
            tmp_path = str(DEMOS_DIR / storage_path[6:])
        else:
            file_bytes = supabase.storage.from_("demos").download(storage_path)
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".dem", delete=False) as tmp:
                tmp.write(file_bytes)
                tmp_path = tmp.name

        match_data = await loop.run_in_executor(None, parse_demo, tmp_path)
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
                    None, _db_write_results, demo_id, meta, ct_score, t_score, match_data, slim_data
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

        print(f"Done: {demo_id} — {meta['map']} {ct_score}-{t_score}")

        # Public demos (HLTV-ingested) discard the local .dem after a successful
        # parse — match_data + slim + stat rows are the only artefacts we keep.
        # Errors skip this branch on purpose so a stuck demo can be re-parsed
        # without re-downloading from HLTV.
        if is_local and is_public:
            Path(tmp_path).unlink(missing_ok=True)
            print(f"[cleanup] deleted local .dem for public demo {demo_id}")

    except Exception as e:
        print(f"Failed {demo_id} ({type(e).__name__}): {e}")
        await loop.run_in_executor(None, _db_set_error, demo_id, str(e))
    finally:
        if tmp_path and not is_local:
            Path(tmp_path).unlink(missing_ok=True)
