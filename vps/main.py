# vps/main.py
import asyncio
import os
import shutil
import uuid
import datetime
from pathlib import Path
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import httpx
from supabase import create_client, Client
from supabase.lib.client_options import ClientOptions

from demo_parser import parse_demo

load_dotenv()

SUPABASE_URL  = os.environ["SUPABASE_URL"]
SUPABASE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "10"))
STUCK_MINUTES = 2
DEMOS_DIR     = Path("/opt/midround/demos")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY, options=ClientOptions(timeout=httpx.Timeout(60.0)))


@asynccontextmanager
async def lifespan(app: FastAPI):
    DEMOS_DIR.mkdir(parents=True, exist_ok=True)
    asyncio.create_task(_poll_loop())
    yield

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
        supabase.table("demos").insert({
            "id":           demo_id,
            "team_id":      team_id,
            "uploaded_by":  user_id,
            "status":       "pending",
            "storage_path": f"local:{demo_id}.dem",
        }).execute()
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


async def _reset_stuck():
    cutoff = (datetime.datetime.utcnow() - datetime.timedelta(minutes=STUCK_MINUTES)).isoformat()
    supabase.table("demos").update({"status": "pending"}).eq("status", "processing").lt("updated_at", cutoff).execute()


async def _process_pending():
    result = supabase.table("demos").select("id,storage_path,team_id").eq("status", "pending").limit(5).execute()
    for demo in (result.data or []):
        await _process_one(demo)


async def _process_one(demo: dict):
    demo_id      = demo["id"]
    storage_path = demo["storage_path"]
    is_local     = storage_path.startswith("local:")

    supabase.table("demos").update({"status": "processing", "updated_at": datetime.datetime.utcnow().isoformat()}).eq("id", demo_id).execute()
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

        match_data = parse_demo(tmp_path)

        meta     = match_data["meta"]
        ct_score = meta["ct_score"]
        t_score  = meta["t_score"]

        last_frame   = match_data["frames"][-1] if match_data["frames"] else {"players": []}
        kill_counts  = {}
        death_counts = {}
        for k in match_data["kills"]:
            kill_counts[k["killer_id"]]  = kill_counts.get(k["killer_id"], 0)  + 1
            death_counts[k["victim_id"]] = death_counts.get(k["victim_id"], 0) + 1

        player_rows = []
        seen = set()
        for p in last_frame["players"]:
            sid = p["steam_id"]
            if sid in seen:
                continue
            seen.add(sid)
            player_rows.append({
                "demo_id":  demo_id,
                "steam_id": sid,
                "name":     p["name"],
                "side":     p["team"],
                "kills":    kill_counts.get(sid, 0),
                "deaths":   death_counts.get(sid, 0),
                "assists":  0,
                "adr":      0.0,
                "rating":   0.0,
            })

        if player_rows:
            supabase.table("demo_players").insert(player_rows).execute()

        supabase.table("demos").update({
            "status":         "ready",
            "updated_at":     datetime.datetime.utcnow().isoformat(),
            "map":            meta["map"],
            "score_ct":       ct_score,
            "score_t":        t_score,
            "duration_ticks": meta["total_ticks"],
            "tick_rate":      meta["tick_rate"],
            "match_data":     match_data,
        }).eq("id", demo_id).execute()

        print(f"Done: {demo_id} — {meta['map']} {ct_score}-{t_score}")

    except Exception as e:
        print(f"Failed {demo_id}: {e}")
        supabase.table("demos").update({
            "status":        "error",
            "updated_at":    datetime.datetime.utcnow().isoformat(),
            "error_message": str(e)[:500],
        }).eq("id", demo_id).execute()
    finally:
        if tmp_path and not is_local:
            Path(tmp_path).unlink(missing_ok=True)
