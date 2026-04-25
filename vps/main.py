# vps/main.py
import asyncio
import json
import os
import shutil
import socket
import sys
import uuid
import datetime
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client, Client

from demo_parser import parse_demo

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

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


@contextmanager
def get_db():
    conn = psycopg2.connect(DATABASE_URL)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    DEMOS_DIR.mkdir(parents=True, exist_ok=True)
    task = asyncio.create_task(_poll_loop())
    yield
    task.cancel()

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
        except Exception as e:
            print(f"Poll error: {e}")
        await asyncio.sleep(POLL_INTERVAL)


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
            cur.execute("SELECT id, storage_path, team_id FROM demos WHERE status = 'pending' LIMIT 5")
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


def _db_write_results(demo_id, meta, ct_score, t_score, match_data, player_rows):
    with get_db() as conn:
        with conn.cursor() as cur:
            if player_rows:
                psycopg2.extras.execute_values(
                    cur,
                    """INSERT INTO demo_players
                         (id, demo_id, steam_id, name, side, kills, deaths, assists, adr, rating)
                       VALUES %s""",
                    player_rows,
                )
            cur.execute(
                """UPDATE demos SET
                     status = 'ready',
                     updated_at = %s,
                     map = %s,
                     score_ct = %s,
                     score_t = %s,
                     duration_ticks = %s,
                     tick_rate = %s,
                     match_data = %s
                   WHERE id = %s""",
                (
                    datetime.datetime.utcnow().isoformat(),
                    meta["map"],
                    ct_score,
                    t_score,
                    meta["total_ticks"],
                    meta["tick_rate"],
                    json.dumps(match_data),
                    demo_id,
                ),
            )


async def _process_one(demo: dict):
    demo_id      = demo["id"]
    storage_path = demo["storage_path"]
    is_local     = storage_path.startswith("local:")
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

        meta     = match_data["meta"]
        ct_score = meta["ct_score"]
        t_score  = meta["t_score"]

        last_frame   = match_data["frames"][-1] if match_data["frames"] else {"players": []}
        kill_counts  = {}
        death_counts = {}
        for k in match_data["kills"]:
            kill_counts[k["killer_id"]]  = kill_counts.get(k["killer_id"], 0) + 1
            death_counts[k["victim_id"]] = death_counts.get(k["victim_id"], 0) + 1

        player_rows = []
        seen = set()
        for p in last_frame["players"]:
            sid = p["steam_id"]
            if sid in seen:
                continue
            seen.add(sid)
            player_rows.append((
                str(uuid.uuid4()), demo_id, sid, p["name"], p["team"],
                kill_counts.get(sid, 0), death_counts.get(sid, 0), 0, 0.0, 0.0,
            ))

        await loop.run_in_executor(
            None, _db_write_results, demo_id, meta, ct_score, t_score, match_data, player_rows
        )
        print(f"Done: {demo_id} — {meta['map']} {ct_score}-{t_score}")

    except Exception as e:
        print(f"Failed {demo_id} ({type(e).__name__}): {e}")
        await loop.run_in_executor(None, _db_set_error, demo_id, str(e))
    finally:
        if tmp_path and not is_local:
            Path(tmp_path).unlink(missing_ok=True)
