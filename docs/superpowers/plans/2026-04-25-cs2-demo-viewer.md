# CS2 2D Demo Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CS2 2D demo viewer to MIDROUND — teams upload `.dem` files, a VPS FastAPI service parses them with demoparser2, and a Canvas-based viewer renders player positions, kills, grenades, and economy in a broadcast-style (stats-first) layout.

**Architecture:** Upload → Supabase Storage (raw .dem) + DB record (`pending`) → VPS polls every 10s, parses with demoparser2, writes `match_data` JSONB, marks `ready` → Supabase Realtime notifies frontend → viewer fetches JSON and renders on HTML Canvas. VPS uses service role key (bypasses RLS); frontend uses anon key + team_id query filter (same pattern as rest of MIDROUND).

**Tech Stack:** Python 3.11 + FastAPI + demoparser2 + supabase-py (VPS); Supabase Storage + Realtime + JSONB; HTML Canvas 2D + vanilla JS (viewer); existing MIDROUND stack.

---

## File Map

**New files:**
- `cs2-hub/supabase-demos.sql` — DB migration: `demos` + `demo_players` tables, RLS, storage bucket
- `cs2-hub/demos.html` — demo library page
- `cs2-hub/demos.js` — upload flow, demo list, Realtime subscription
- `cs2-hub/demo-viewer.html` — 2D viewer page (layout C)
- `cs2-hub/demo-viewer.js` — Canvas renderer, playback engine, UI updates
- `cs2-hub/demo-map-data.js` — map coordinate constants (MAP_DATA)
- `cs2-hub/images/maps/de_*.png` — 8 radar PNGs (sourced from CS2 installation)
- `vps/requirements.txt`
- `vps/.env.example`
- `vps/main.py` — FastAPI app + polling loop
- `vps/parser.py` — demoparser2 extraction → match_data dict
- `vps/tests/test_parser.py` — unit tests for parser output shape
- `vps/midround-demo-parser.service` — systemd service file

**Modified files:**
- `cs2-hub/layout.js` — add Demos nav item

---

## Task 1: Database Migration

**Files:**
- Create: `cs2-hub/supabase-demos.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- cs2-hub/supabase-demos.sql
-- Run in Supabase SQL Editor after supabase-setup.sql

create table demos (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null,
  uploaded_by   uuid references auth.users(id),
  created_at    timestamptz default now(),

  -- set at upload time
  status        text not null default 'pending'
                  check (status in ('pending','processing','ready','error')),
  error_message text,
  storage_path  text not null,

  -- populated by VPS after parsing
  map           text,
  played_at     timestamptz,
  score_ct      int,
  score_t       int,
  opponent_name text,
  duration_ticks int,
  tick_rate     int,
  match_data    jsonb
);

create table demo_players (
  id         uuid primary key default gen_random_uuid(),
  demo_id    uuid references demos(id) on delete cascade,
  steam_id   text,
  name       text,
  side       text check (side in ('ct','t')),
  kills      int,
  deaths     int,
  assists    int,
  adr        float,
  rating     float
);

alter table demos        enable row level security;
alter table demo_players enable row level security;

create policy "auth_all" on demos        for all to authenticated using (true) with check (true);
create policy "auth_all" on demo_players for all to authenticated using (true) with check (true);

-- Storage bucket (run separately if SQL editor doesn't support storage API)
insert into storage.buckets (id, name, public)
values ('demos', 'demos', false)
on conflict do nothing;

create policy "auth_all" on storage.objects
  for all to authenticated
  using (bucket_id = 'demos')
  with check (bucket_id = 'demos');
```

- [ ] **Step 2: Run migration in Supabase SQL Editor**

Go to your Supabase project → SQL Editor → paste and run the file above. Verify in Table Editor that `demos` and `demo_players` tables appear.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/supabase-demos.sql
git commit -m "feat: add demos and demo_players DB migration"
```

---

## Task 2: VPS Project Scaffold

**Files:**
- Create: `vps/requirements.txt`
- Create: `vps/.env.example`
- Create: `vps/main.py` (stub)
- Create: `vps/parser.py` (stub)

- [ ] **Step 1: Create requirements.txt**

```
# vps/requirements.txt
fastapi==0.115.0
uvicorn==0.30.0
demoparser2==4.5.0
supabase==2.9.0
python-dotenv==1.0.1
polars==0.20.31
```

> Note: Pin exact versions. Run `pip install -r requirements.txt` to verify all install cleanly. demoparser2 requires a Rust toolchain to compile on install — on the VPS run `curl https://sh.rustup.rs -sSf | sh` first if missing.

- [ ] **Step 2: Create .env.example**

```
# vps/.env.example
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
POLL_INTERVAL=10
```

Copy to `vps/.env` and fill in real values. The service role key is in Supabase → Project Settings → API → `service_role` (secret).

- [ ] **Step 3: Create parser.py stub**

```python
# vps/parser.py

def parse_demo(dem_path: str) -> dict:
    raise NotImplementedError
```

- [ ] **Step 4: Create main.py stub**

```python
# vps/main.py
from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}
```

- [ ] **Step 5: Verify FastAPI starts**

```bash
cd vps
pip install -r requirements.txt
uvicorn main:app --reload
```

Expected: `Uvicorn running on http://127.0.0.1:8000`. Hit `http://127.0.0.1:8000/health` → `{"status":"ok"}`.

- [ ] **Step 6: Commit**

```bash
git add vps/
git commit -m "feat: add VPS project scaffold"
```

---

## Task 3: VPS Parser Module

**Files:**
- Modify: `vps/parser.py`
- Create: `vps/tests/__init__.py`
- Create: `vps/tests/test_parser.py`

- [ ] **Step 1: Write the failing shape test**

You need a real `.dem` file to test with. Copy any CS2 `.dem` from your replays folder (`C:\Users\<you>\Documents\My Games\Counter-Strike Global Offensive\730\`) to `vps/tests/fixture.dem`. Then:

```python
# vps/tests/test_parser.py
import pytest
from pathlib import Path
from parser import parse_demo

FIXTURE = Path(__file__).parent / "fixture.dem"

@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_output_shape():
    result = parse_demo(str(FIXTURE))
    assert "meta" in result
    assert "rounds" in result
    assert "frames" in result
    assert "kills" in result
    assert "grenades" in result
    assert "economy" in result

@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_meta_fields():
    result = parse_demo(str(FIXTURE))
    m = result["meta"]
    assert m["map"].startswith("de_")
    assert m["tick_rate"] in (64, 128)
    assert m["total_ticks"] > 0

@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_frames_sampled():
    result = parse_demo(str(FIXTURE))
    frames = result["frames"]
    assert len(frames) > 100
    # Frames should be sampled (not every tick)
    if len(frames) > 1:
        tick_gap = frames[1]["tick"] - frames[0]["tick"]
        assert 4 <= tick_gap <= 16

@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_player_fields():
    result = parse_demo(str(FIXTURE))
    frame = result["frames"][0]
    assert "tick" in frame
    assert "players" in frame
    if frame["players"]:
        p = frame["players"][0]
        for key in ("steam_id", "name", "team", "x", "y", "hp", "armor", "weapon", "money", "is_alive"):
            assert key in p, f"missing key: {key}"
        assert p["team"] in ("ct", "t")
```

- [ ] **Step 2: Run tests — verify they fail or skip**

```bash
cd vps
pytest tests/test_parser.py -v
```

Expected: tests skip (no fixture) or fail with `NotImplementedError`.

- [ ] **Step 3: Implement parser.py**

```python
# vps/parser.py
from demoparser2 import DemoParser

SAMPLE_RATE = 8  # store every 8th tick (~8-16 fps depending on tick rate)

WIN_REASONS = {
    1: "t_eliminated",
    7: "bomb_defused",
    8: "ct_eliminated",
    9: "bomb_exploded",
    12: "time_ran_out",
}

def _safe(val, default=0):
    return val if val is not None else default

def parse_demo(dem_path: str) -> dict:
    p = DemoParser(dem_path)
    header = p.parse_header()

    # --- tick data ---
    tick_df = p.parse_ticks([
        "X", "Y", "health", "armor_value",
        "active_weapon_name", "is_alive", "cash",
        "team_num",
    ])
    # Verify columns: if KeyError below, run print(tick_df.columns) and adjust names
    all_ticks = tick_df["tick"].unique().sort().to_list()

    # --- events ---
    kills_df  = p.parse_event("player_death",         player_props=["X", "Y"])
    round_end = p.parse_event("round_end")
    round_start = p.parse_event("round_start")
    smoke_df  = p.parse_event("smokegrenade_detonate")
    flash_df  = p.parse_event("flashbang_detonate")
    he_df     = p.parse_event("hegrenade_detonate")
    molotov_df = p.parse_event("inferno_startburn")

    # --- rounds ---
    starts = sorted(round_start["tick"].to_list()) if len(round_start) else []
    rounds = []
    for i, row in enumerate(round_end.iter_rows(named=True)):
        winner_val = row.get("winner", 2)
        rounds.append({
            "round_num":   i + 1,
            "start_tick":  int(starts[i]) if i < len(starts) else 0,
            "end_tick":    int(row["tick"]),
            "winner_side": "ct" if winner_val == 3 else "t",
            "win_reason":  WIN_REASONS.get(row.get("reason"), "unknown"),
        })

    # --- sampled frames ---
    sampled = all_ticks[::SAMPLE_RATE]
    frames = []
    for tick in sampled:
        rows = tick_df.filter(tick_df["tick"] == tick)
        players = []
        for r in rows.iter_rows(named=True):
            team_num = _safe(r.get("team_num"), 2)
            players.append({
                "steam_id":  str(_safe(r.get("steamid"), "")),
                "name":      str(_safe(r.get("name"), "")),
                "team":      "ct" if team_num == 3 else "t",
                "x":         float(_safe(r.get("X"), 0)),
                "y":         float(_safe(r.get("Y"), 0)),
                "hp":        int(_safe(r.get("health"), 0)),
                "armor":     int(_safe(r.get("armor_value"), 0)),
                "weapon":    str(_safe(r.get("active_weapon_name"), "")),
                "money":     int(_safe(r.get("cash"), 0)),
                "is_alive":  bool(_safe(r.get("is_alive"), False)),
            })
        frames.append({"tick": int(tick), "players": players})

    # --- kills ---
    kills = []
    for r in kills_df.iter_rows(named=True):
        kills.append({
            "tick":        int(r["tick"]),
            "killer_id":   str(_safe(r.get("attacker_steamid"), "")),
            "killer_name": str(_safe(r.get("attacker_name"), "")),
            "victim_id":   str(_safe(r.get("user_steamid"), "")),
            "victim_name": str(_safe(r.get("user_name"), "")),
            "weapon":      str(_safe(r.get("weapon"), "")),
            "headshot":    bool(_safe(r.get("headshot"), False)),
            "killer_x":    float(_safe(r.get("attacker_X"), 0)),
            "killer_y":    float(_safe(r.get("attacker_Y"), 0)),
            "victim_x":    float(_safe(r.get("user_X"), 0)),
            "victim_y":    float(_safe(r.get("user_Y"), 0)),
        })

    # --- grenades ---
    def _nades(df, nade_type):
        out = []
        for r in df.iter_rows(named=True):
            thrower = r.get("userid_steamid") or r.get("attacker_steamid") or ""
            out.append({
                "tick":       int(r["tick"]),
                "type":       nade_type,
                "thrower_id": str(_safe(thrower, "")),
                "x":          float(_safe(r.get("x"), 0)),
                "y":          float(_safe(r.get("y"), 0)),
            })
        return out

    grenades = (
        _nades(smoke_df,   "smoke") +
        _nades(flash_df,   "flash") +
        _nades(he_df,      "he") +
        _nades(molotov_df, "molotov")
    )

    # --- economy (snapshot at each round start) ---
    economy = []
    for i, start_tick in enumerate(starts):
        rows = tick_df.filter(tick_df["tick"] == start_tick)
        players_eco = []
        for r in rows.iter_rows(named=True):
            players_eco.append({
                "steam_id":        str(_safe(r.get("steamid"), "")),
                "money":           int(_safe(r.get("cash"), 0)),
                "equipment_value": int(_safe(r.get("current_equip_value"), 0)),
            })
        economy.append({"round_num": i + 1, "players": players_eco})

    # --- meta ---
    raw_rate = header.get("playback_ticks", 128) / max(header.get("playback_time", 1), 0.001)
    tick_rate = 64 if raw_rate < 100 else 128
    ct_score = sum(1 for r in rounds if r["winner_side"] == "ct")
    t_score  = sum(1 for r in rounds if r["winner_side"] == "t")

    return {
        "meta": {
            "map":           header.get("map_name", ""),
            "tick_rate":     tick_rate,
            "total_ticks":   int(_safe(header.get("playback_ticks"), 0)),
            "ct_score":      ct_score,
            "t_score":       t_score,
        },
        "rounds":   rounds,
        "frames":   frames,
        "kills":    kills,
        "grenades": grenades,
        "economy":  economy,
    }
```

- [ ] **Step 4: Run tests — verify they pass (if fixture.dem present)**

```bash
cd vps
pytest tests/test_parser.py -v
```

Expected: all 4 tests PASS (or skip if no fixture). If you get a `KeyError` on a column name, run `python -c "from demoparser2 import DemoParser; p=DemoParser('tests/fixture.dem'); print(p.parse_ticks(['X','Y','health']).columns)"` to see real column names, then adjust `parser.py`.

- [ ] **Step 5: Commit**

```bash
git add vps/parser.py vps/tests/
git commit -m "feat: add VPS demoparser2 extraction module"
```

---

## Task 4: VPS Polling Service

**Files:**
- Modify: `vps/main.py`

- [ ] **Step 1: Replace main.py with full polling service**

```python
# vps/main.py
import asyncio
import os
import tempfile
import datetime
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from supabase import create_client, Client

from parser import parse_demo

load_dotenv()

SUPABASE_URL  = os.environ["SUPABASE_URL"]
SUPABASE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "10"))
STUCK_MINUTES = 10  # jobs stuck in 'processing' for this long get reset

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.on_event("startup")
async def start_poll():
    asyncio.create_task(_poll_loop())


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
    supabase.table("demos").update({"status": "pending"}).eq("status", "processing").lt("created_at", cutoff).execute()


async def _process_pending():
    result = supabase.table("demos").select("id,storage_path,team_id").eq("status", "pending").limit(5).execute()
    for demo in (result.data or []):
        await _process_one(demo)


async def _process_one(demo: dict):
    demo_id      = demo["id"]
    storage_path = demo["storage_path"]

    # Claim the job
    supabase.table("demos").update({"status": "processing"}).eq("id", demo_id).execute()
    print(f"Processing demo {demo_id}")

    try:
        # Download .dem from Supabase Storage
        file_bytes = supabase.storage.from_("demos").download(storage_path)

        with tempfile.NamedTemporaryFile(suffix=".dem", delete=False) as tmp:
            tmp.write(file_bytes)
            tmp_path = tmp.name

        # Parse
        match_data = parse_demo(tmp_path)
        Path(tmp_path).unlink(missing_ok=True)

        meta = match_data["meta"]
        rounds = match_data["rounds"]
        ct_score = meta["ct_score"]
        t_score  = meta["t_score"]

        # Build demo_players rows from the last frame
        last_frame = match_data["frames"][-1] if match_data["frames"] else {"players": []}
        kill_counts = {}
        death_counts = {}
        for k in match_data["kills"]:
            kill_counts[k["killer_id"]]  = kill_counts.get(k["killer_id"], 0)  + 1
            death_counts[k["victim_id"]] = death_counts.get(k["victim_id"], 0) + 1

        player_rows = []
        seen = set()
        for p in last_frame["players"]:
            sid = p["steam_id"]
            if sid in seen: continue
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
            "status": "error",
            "error_message": str(e)[:500],
        }).eq("id", demo_id).execute()
```

- [ ] **Step 2: Verify startup**

```bash
cd vps
uvicorn main:app --reload
```

Expected: `Polling loop started` in logs, no crashes. Hit `http://127.0.0.1:8000/health` → `{"status":"ok"}`.

- [ ] **Step 3: Commit**

```bash
git add vps/main.py
git commit -m "feat: add VPS FastAPI polling service"
```

---

## Task 5: Add Demos to MIDROUND Sidebar

**Files:**
- Modify: `cs2-hub/layout.js`

- [ ] **Step 1: Add demos icon and nav entry**

In `layout.js`, add to the `ICONS` object (after the `vods` entry):

```javascript
demos: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
```

Then in the `links` array, add after the `vods` entry:

```javascript
{ id: 'demos', label: 'Demos', href: 'demos.html', icon: ICONS.demos },
```

- [ ] **Step 2: Verify in browser**

Open any MIDROUND page (e.g. `dashboard.html`). The sidebar should now show a "Demos" link between "Results & Review" and "Anti-Strat". Clicking it will 404 for now (page not built yet).

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/layout.js
git commit -m "feat: add Demos nav item to sidebar"
```

---

## Task 6: Map Radar Assets + Coordinate Constants

**Files:**
- Create: `cs2-hub/images/maps/de_mirage_radar.png` (and 7 others)
- Create: `cs2-hub/demo-map-data.js`

- [ ] **Step 1: Copy radar PNGs from CS2 installation**

Locate your CS2 install (typically `C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\resource\overviews\`). Copy these 8 files to `cs2-hub/images/maps/`:

```
de_mirage_radar.png
de_inferno_radar.png
de_nuke_radar.png
de_ancient_radar.png
de_anubis_radar.png
de_dust2_radar.png
de_vertigo_radar.png
de_train_radar.png
```

- [ ] **Step 2: Write the failing coordinate test**

```html
<!-- cs2-hub/demo-map-data.test.html — open in browser, check console -->
<script type="module">
import { worldToCanvas, MAP_DATA } from './demo-map-data.js'

function assert(condition, msg) {
  if (!condition) { console.error('FAIL:', msg); return; }
  console.log('PASS:', msg);
}

// Mirage: mid-map position should land near center of a 512x512 canvas
const mid = worldToCanvas(-50, 100, 'de_mirage', 512, 512)
assert(mid.x > 150 && mid.x < 350, `mirage center x in range (got ${mid.x})`)
assert(mid.y > 150 && mid.y < 350, `mirage center y in range (got ${mid.y})`)

// Extreme coord should clamp to edge area
const corner = worldToCanvas(-3200, 1700, 'de_mirage', 512, 512)
assert(corner.x < 20, `mirage top-left x near 0 (got ${corner.x})`)
assert(corner.y < 20, `mirage top-left y near 0 (got ${corner.y})`)

console.log('All coordinate tests done')
</script>
```

Open in browser → check console for FAIL lines before implementation.

- [ ] **Step 3: Create demo-map-data.js**

```javascript
// cs2-hub/demo-map-data.js
// pos_x, pos_y: world coords of the top-left corner of the radar image
// scale: game units per pixel of the 1024x1024 radar image
export const MAP_DATA = {
  de_mirage:  { pos_x: -3230, pos_y:  1713, scale: 5.00 },
  de_inferno: { pos_x: -2087, pos_y:  3870, scale: 4.90 },
  de_nuke:    { pos_x: -3453, pos_y:  2887, scale: 7.00 },
  de_ancient: { pos_x: -2953, pos_y:  2164, scale: 5.00 },
  de_anubis:  { pos_x: -2796, pos_y:  3328, scale: 5.22 },
  de_dust2:   { pos_x: -2476, pos_y:  3239, scale: 4.40 },
  de_vertigo: { pos_x: -3168, pos_y:  1762, scale: 4.00 },
  de_train:   { pos_x: -2477, pos_y:  2392, scale: 4.70 },
}

/**
 * Convert CS2 world coordinates to canvas pixel coordinates.
 * The radar image is always assumed to be 1024×1024 in world-space.
 * @param {number} wx - world X
 * @param {number} wy - world Y
 * @param {string} map - e.g. 'de_mirage'
 * @param {number} cw - canvas width in pixels
 * @param {number} ch - canvas height in pixels
 * @returns {{ x: number, y: number }}
 */
export function worldToCanvas(wx, wy, map, cw, ch) {
  const m = MAP_DATA[map]
  if (!m) return { x: 0, y: 0 }
  const x = ((wx - m.pos_x) / m.scale / 1024) * cw
  const y = ((m.pos_y - wy) / m.scale / 1024) * ch
  return { x, y }
}
```

- [ ] **Step 4: Re-run test — verify PASS**

Reload `demo-map-data.test.html` in browser. All lines should show `PASS`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/demo-map-data.js cs2-hub/images/maps/
git commit -m "feat: add map radar assets and coordinate transform"
```

---

## Task 7: Demo Library Page

**Files:**
- Create: `cs2-hub/demos.html`
- Create: `cs2-hub/demos.js`

- [ ] **Step 1: Create demos.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <link rel="icon" type="image/png" href="images/favicon.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Demos — MIDROUND</title>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>
<div class="app-shell">
  <nav class="sidebar" id="sidebar"></nav>
  <main class="main-content">

    <div class="page-header">
      <div>
        <div class="page-title">Demos</div>
        <div class="page-sub" id="demo-count-sub">Loading…</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <input type="file" id="demo-file-input" accept=".dem" style="display:none"/>
        <button class="btn btn-primary" id="upload-btn">+ Upload Demo</button>
      </div>
    </div>

    <div id="upload-progress" style="display:none" class="card" style="margin-bottom:16px">
      <div id="upload-progress-text" style="margin-bottom:8px;font-size:14px;color:var(--text-secondary)">Uploading…</div>
      <div style="height:4px;background:var(--border);border-radius:2px">
        <div id="upload-progress-bar" style="height:100%;background:var(--accent);border-radius:2px;width:0%;transition:width 0.2s"></div>
      </div>
    </div>

    <div id="demos-list"></div>

  </main>
</div>
<script type="module" src="demos.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create demos.js**

```javascript
// cs2-hub/demos.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function formatDate(d) { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }

await requireAuth()
renderSidebar('demos')

const teamId = getTeamId()
const listEl = document.getElementById('demos-list')
const countEl = document.getElementById('demo-count-sub')
const uploadBtn = document.getElementById('upload-btn')
const fileInput = document.getElementById('demo-file-input')
const progressWrap = document.getElementById('upload-progress')
const progressText = document.getElementById('upload-progress-text')
const progressBar = document.getElementById('upload-progress-bar')

// ── Load demos ────────────────────────────────────────────
async function loadDemos() {
  const { data, error } = await supabase
    .from('demos')
    .select('id,status,error_message,map,played_at,score_ct,score_t,opponent_name,created_at')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false })

  if (error) {
    listEl.innerHTML = `<div class="empty-state"><h3>Failed to load demos</h3><p>${esc(error.message)}</p></div>`
    return
  }

  countEl.textContent = `${data.length} match${data.length === 1 ? '' : 'es'} uploaded`

  if (!data.length) {
    listEl.innerHTML = `<div class="empty-state"><h3>No demos yet</h3><p>Upload your first .dem file to get started.</p></div>`
    return
  }

  listEl.innerHTML = data.map(d => {
    const mapName = d.map ? d.map.replace('de_', '') : '?'
    const score = d.score_ct != null ? `${d.score_ct}–${d.score_t}` : ''
    const badge = {
      pending:    `<span class="badge badge-warning">Processing</span>`,
      processing: `<span class="badge badge-warning">Processing</span>`,
      ready:      `<span class="badge badge-success">Ready</span>`,
      error:      `<span class="badge badge-error" title="${esc(d.error_message ?? '')}">Error</span>`,
    }[d.status] ?? ''
    const watchBtn = d.status === 'ready'
      ? `<a class="btn btn-primary btn-sm" href="demo-viewer.html?id=${d.id}">▶ Watch</a>`
      : d.status === 'error'
        ? `<button class="btn btn-ghost btn-sm" onclick="retryDemo('${d.id}')">Retry</button>`
        : `<button class="btn btn-ghost btn-sm" disabled>▶ Watch</button>`

    return `
      <div class="list-row" id="demo-row-${d.id}">
        <div class="list-row-icon" style="background:var(--surface-2);font-size:11px;font-weight:600;color:var(--text-secondary)">${esc(mapName.slice(0,3).toUpperCase())}</div>
        <div class="list-row-body">
          <div class="list-row-title">${d.opponent_name ? `vs ${esc(d.opponent_name)}` : 'Demo'} — ${esc(d.map ?? '?')}</div>
          <div class="list-row-sub">${d.played_at ? formatDate(d.played_at) : formatDate(d.created_at)}${score ? ` · ${score}` : ''}</div>
        </div>
        ${badge}
        ${watchBtn}
      </div>`
  }).join('')
}

// ── Realtime: update status badges live ──────────────────
supabase.channel('demos-status')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'demos', filter: `team_id=eq.${teamId}` }, payload => {
    const d = payload.new
    const row = document.getElementById(`demo-row-${d.id}`)
    if (!row) return
    // Re-render just this row by reloading all
    loadDemos()
  })
  .subscribe()

// ── Upload ────────────────────────────────────────────────
uploadBtn.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0]
  if (!file) return
  fileInput.value = ''

  if (!file.name.endsWith('.dem')) {
    alert('Please select a .dem file.')
    return
  }

  progressWrap.style.display = 'block'
  progressText.textContent = `Uploading ${file.name}…`
  progressBar.style.width = '0%'

  const { data: { user } } = await supabase.auth.getUser()
  const demoId = crypto.randomUUID()
  const storagePath = `${teamId}/${demoId}.dem`

  // Upload to Storage
  const { error: uploadErr } = await supabase.storage
    .from('demos')
    .upload(storagePath, file, { upsert: false })

  if (uploadErr) {
    progressText.textContent = `Upload failed: ${uploadErr.message}`
    return
  }

  progressBar.style.width = '60%'
  progressText.textContent = 'Registering demo…'

  // Create DB record
  const { error: insertErr } = await supabase.from('demos').insert({
    id:           demoId,
    team_id:      teamId,
    uploaded_by:  user.id,
    status:       'pending',
    storage_path: storagePath,
  })

  if (insertErr) {
    progressText.textContent = `Failed to register: ${insertErr.message}`
    return
  }

  progressBar.style.width = '100%'
  progressText.textContent = 'Uploaded — processing in background…'
  setTimeout(() => { progressWrap.style.display = 'none' }, 3000)
  loadDemos()
})

// ── Retry ─────────────────────────────────────────────────
window.retryDemo = async (id) => {
  await supabase.from('demos').update({ status: 'pending', error_message: null }).eq('id', id)
  loadDemos()
}

loadDemos()
```

- [ ] **Step 3: Add missing CSS classes** (badge + list-row) to `cs2-hub/style.css` if not already present

Check if `.badge`, `.badge-success`, `.badge-warning`, `.badge-error`, `.list-row`, `.list-row-icon`, `.list-row-body`, `.list-row-title`, `.list-row-sub`, `.btn-sm` exist in style.css. If any are missing, add:

```css
/* demos — add to style.css only if these classes don't already exist */
.badge { display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500 }
.badge-success { background:rgba(76,175,80,.15);color:#4CAF50 }
.badge-warning { background:rgba(255,193,7,.15);color:#FFC107 }
.badge-error   { background:rgba(239,83,80,.15);color:#EF5350 }
.list-row { display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:8px }
.list-row-icon { width:44px;height:44px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0 }
.list-row-body { flex:1;min-width:0 }
.list-row-title { font-weight:500;font-size:14px;color:var(--text) }
.list-row-sub   { font-size:12px;color:var(--text-secondary);margin-top:2px }
.btn-sm { padding:4px 10px;font-size:12px }
```

- [ ] **Step 4: Test in browser**

Open `cs2-hub/demos.html`. Should show "No demos yet" empty state. Click "+ Upload Demo", pick a `.dem` file. Should upload, show "processing in background", and the row should appear in the list with a "Processing" badge.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/demos.html cs2-hub/demos.js cs2-hub/style.css
git commit -m "feat: add demo library page with upload and realtime status"
```

---

## Task 8: Demo Viewer HTML Shell

**Files:**
- Create: `cs2-hub/demo-viewer.html`

- [ ] **Step 1: Create demo-viewer.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <link rel="icon" type="image/png" href="images/favicon.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Demo Viewer — MIDROUND</title>
  <link rel="stylesheet" href="style.css"/>
  <style>
    .viewer-shell { display:flex;flex-direction:column;height:calc(100vh - 40px);gap:8px;padding:8px 16px }
    .player-cards { display:grid;grid-template-columns:1fr 1fr 80px 1fr 1fr;gap:6px }
    .player-card { background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 10px }
    .player-card.ct { border-top:2px solid #4FC3F7 }
    .player-card.t  { border-top:2px solid #EF5350 }
    .player-card.dead { opacity:0.4 }
    .player-card-name { font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis }
    .player-card-kd   { font-size:11px;color:var(--text-secondary) }
    .player-card-weapon { font-size:10px;color:var(--text-secondary);margin-top:2px }
    .player-card-money  { font-size:10px;color:#4CAF50 }
    .player-card-hp { height:3px;border-radius:1px;margin-top:5px;transition:width 0.2s }
    .score-card { background:var(--surface);border:1px solid var(--border);border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:6px }
    .score-ct { font-size:18px;font-weight:700;color:#4FC3F7 }
    .score-t  { font-size:18px;font-weight:700;color:#EF5350 }
    .score-vs { font-size:10px;color:var(--text-secondary) }
    .viewer-mid { display:grid;grid-template-columns:1fr 180px;gap:8px;flex:1;min-height:0 }
    .map-canvas-wrap { background:var(--surface);border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden }
    #map-canvas { display:block;max-width:100%;max-height:100% }
    .viewer-side { display:flex;flex-direction:column;gap:8px }
    .round-tracker { background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px }
    .round-tracker-label { font-size:10px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px }
    .round-squares { display:flex;flex-wrap:wrap;gap:3px }
    .round-sq { width:16px;height:16px;border-radius:2px;cursor:pointer;opacity:0.85 }
    .round-sq.current { outline:2px solid var(--text);outline-offset:1px }
    .round-sq.ct { background:#4FC3F7 }
    .round-sq.t  { background:#EF5350 }
    .round-sq.unplayed { background:var(--border) }
    .kill-feed { background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px;flex:1;overflow:hidden }
    .kill-feed-label { font-size:10px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px }
    .kill-row { font-size:11px;color:var(--text);display:flex;gap:4px;align-items:center;margin-bottom:3px }
    .kill-row .kname { color:#4FC3F7 }
    .kill-row .vname { color:#EF5350 }
    .kill-row .kweapon { color:var(--text-secondary);font-size:10px }
    .viewer-timeline { background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;display:flex;align-items:center;gap:10px;flex-shrink:0 }
    .timeline-track { flex:1;position:relative;height:4px;background:var(--border);border-radius:2px;cursor:pointer }
    .timeline-fill  { height:100%;background:var(--accent);border-radius:2px;pointer-events:none }
    .timeline-thumb { position:absolute;top:50%;transform:translate(-50%,-50%);width:12px;height:12px;background:#fff;border-radius:50%;pointer-events:none;box-shadow:0 0 4px rgba(0,0,0,.4) }
    .timeline-time { font-size:11px;color:var(--text-secondary);min-width:36px }
    .speed-btn { background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:11px;color:var(--text-secondary);cursor:pointer }
    .speed-btn.active { border-color:var(--accent);color:var(--accent) }
    .play-btn { background:none;border:none;color:var(--text);font-size:18px;cursor:pointer;padding:0 4px }
    #viewer-loading { position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--bg);z-index:10;font-size:14px;color:var(--text-secondary) }
  </style>
</head>
<body>
<div class="app-shell">
  <nav class="sidebar" id="sidebar"></nav>
  <main class="main-content" style="padding:0;overflow:hidden;position:relative">
    <div id="viewer-loading">Loading demo…</div>

    <div class="viewer-shell" id="viewer-shell" style="display:none">

      <!-- top: player cards -->
      <div class="player-cards" id="player-cards">
        <!-- populated by JS -->
      </div>

      <!-- middle: map + side panel -->
      <div class="viewer-mid">
        <div class="map-canvas-wrap" id="map-canvas-wrap">
          <canvas id="map-canvas"></canvas>
        </div>
        <div class="viewer-side">
          <div class="round-tracker">
            <div class="round-tracker-label">Round <span id="round-num">—</span> / <span id="round-total">—</span></div>
            <div class="round-squares" id="round-squares"></div>
          </div>
          <div class="kill-feed">
            <div class="kill-feed-label">Kill Feed</div>
            <div id="kill-feed-rows"></div>
          </div>
        </div>
      </div>

      <!-- bottom: timeline -->
      <div class="viewer-timeline">
        <button class="play-btn" id="play-btn">▶</button>
        <span class="timeline-time" id="timeline-current">0:00</span>
        <div class="timeline-track" id="timeline-track">
          <div class="timeline-fill" id="timeline-fill" style="width:0%"></div>
          <div class="timeline-thumb" id="timeline-thumb" style="left:0%"></div>
        </div>
        <span class="timeline-time" id="timeline-end">0:00</span>
        <button class="speed-btn active" data-speed="1">1×</button>
        <button class="speed-btn" data-speed="2">2×</button>
        <button class="speed-btn" data-speed="4">4×</button>
      </div>

    </div>
  </main>
</div>
<script type="module" src="demo-viewer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add cs2-hub/demo-viewer.html
git commit -m "feat: add demo viewer HTML shell"
```

---

## Task 9: Demo Viewer JavaScript

**Files:**
- Create: `cs2-hub/demo-viewer.js`

- [ ] **Step 1: Create demo-viewer.js**

```javascript
// cs2-hub/demo-viewer.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'
import { worldToCanvas } from './demo-map-data.js'

await requireAuth()
renderSidebar('demos')

const params  = new URLSearchParams(location.search)
const demoId  = params.get('id')
if (!demoId) { location.href = 'demos.html'; throw new Error('no id') }

// ── State ────────────────────────────────────────────────
const state = {
  match:    null,
  playing:  false,
  tick:     0,
  speed:    1,
  lastTs:   0,
  roundIdx: 0,
}
let mapImg    = null
let mapLoaded = false

// ── Load data ────────────────────────────────────────────
const { data: demo, error } = await supabase
  .from('demos')
  .select('match_data,map,opponent_name,played_at,score_ct,score_t,status')
  .eq('id', demoId)
  .single()

if (error || !demo || demo.status !== 'ready') {
  document.getElementById('viewer-loading').textContent =
    demo?.status === 'processing' ? 'Demo is still processing…' :
    demo?.status === 'error'      ? 'Demo processing failed.' :
    'Demo not found.'
  throw new Error('not ready')
}

state.match = demo.match_data
document.title = `${demo.opponent_name ?? 'Demo'} — ${demo.map ?? ''} — MIDROUND`

// Load map image
mapImg = new Image()
mapImg.src = `images/maps/${demo.map}_radar.png`
mapImg.onload  = () => { mapLoaded = true }
mapImg.onerror = () => { mapLoaded = true }  // render without bg if missing

// Show UI
document.getElementById('viewer-loading').style.display = 'none'
document.getElementById('viewer-shell').style.display = 'flex'

// ── Canvas setup ──────────────────────────────────────────
const canvas = document.getElementById('map-canvas')
const ctx     = canvas.getContext('2d')
const wrap    = document.getElementById('map-canvas-wrap')

function resizeCanvas() {
  const { width, height } = wrap.getBoundingClientRect()
  const size = Math.min(width, height) - 16
  canvas.width  = size
  canvas.height = size
}
resizeCanvas()
new ResizeObserver(resizeCanvas).observe(wrap)

// ── Round helpers ─────────────────────────────────────────
function currentRound() { return state.match.rounds[state.roundIdx] }

function jumpToRound(idx) {
  state.roundIdx = Math.max(0, Math.min(idx, state.match.rounds.length - 1))
  state.tick     = currentRound().start_tick
  state.playing  = false
  updatePlayBtn()
  updateRoundTracker()
}

// ── Frame lookup (binary search) ─────────────────────────
function getFrame(tick) {
  const frames = state.match.frames
  if (!frames.length) return null
  let lo = 0, hi = frames.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (frames[mid].tick <= tick) lo = mid
    else hi = mid - 1
  }
  return frames[lo]
}

// ── Canvas render ─────────────────────────────────────────
function render() {
  const { width: cw, height: ch } = canvas
  const map = state.match.meta.map
  ctx.clearRect(0, 0, cw, ch)

  // Map background
  if (mapLoaded && mapImg.complete && mapImg.naturalWidth) {
    ctx.drawImage(mapImg, 0, 0, cw, ch)
  } else {
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, cw, ch)
  }

  const tick = state.tick

  // Grenade blasts (show for 2 seconds around detonation tick)
  const tickRate = state.match.meta.tick_rate
  const NADE_DURATION = tickRate * 2
  for (const g of state.match.grenades) {
    if (tick < g.tick || tick > g.tick + NADE_DURATION) continue
    const { x, y } = worldToCanvas(g.x, g.y, map, cw, ch)
    const alpha = 1 - (tick - g.tick) / NADE_DURATION
    ctx.globalAlpha = alpha * 0.7
    ctx.beginPath()
    ctx.arc(x, y, 14, 0, Math.PI * 2)
    ctx.fillStyle = { smoke: '#aaa', flash: '#ffe', molotov: '#f60', he: '#fc0' }[g.type] ?? '#fff'
    ctx.fill()
    ctx.globalAlpha = 1
  }

  // Kill markers (show for 3 seconds, fade out)
  const KILL_DURATION = tickRate * 3
  for (const k of state.match.kills) {
    if (tick < k.tick || tick > k.tick + KILL_DURATION) continue
    const { x, y } = worldToCanvas(k.victim_x, k.victim_y, map, cw, ch)
    const age = (tick - k.tick) / KILL_DURATION
    ctx.globalAlpha = 1 - age
    ctx.fillStyle = '#ff4444'
    ctx.font = `bold ${Math.round(cw * 0.025)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('✕', x, y)
    ctx.globalAlpha = 1
  }

  // Players
  const frame = getFrame(tick)
  if (!frame) return
  const dotR = Math.round(cw * 0.012)
  for (const p of frame.players) {
    const { x, y } = worldToCanvas(p.x, p.y, map, cw, ch)
    ctx.beginPath()
    ctx.arc(x, y, dotR, 0, Math.PI * 2)
    if (!p.is_alive) {
      ctx.globalAlpha = 0.3
      ctx.fillStyle = '#888'
    } else {
      ctx.fillStyle = p.team === 'ct' ? '#4FC3F7' : '#EF5350'
    }
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.fill()
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

// ── UI updates ────────────────────────────────────────────
function buildPlayerCards() {
  const round = currentRound()
  const frame = getFrame(state.tick)
  if (!frame) return

  const ct = frame.players.filter(p => p.team === 'ct')
  const t  = frame.players.filter(p => p.team === 't')

  // Count kills per player up to current tick
  const killMap = {}
  const deathMap = {}
  for (const k of state.match.kills) {
    if (k.tick > state.tick) continue
    killMap[k.killer_id]  = (killMap[k.killer_id]  ?? 0) + 1
    deathMap[k.victim_id] = (deathMap[k.victim_id] ?? 0) + 1
  }

  function cardHtml(p) {
    const k = killMap[p.steam_id]  ?? 0
    const d = deathMap[p.steam_id] ?? 0
    const hpPct = Math.max(0, Math.min(100, p.hp))
    const hpColor = hpPct > 50 ? '#4CAF50' : hpPct > 25 ? '#FFC107' : '#EF5350'
    return `
      <div class="player-card ${p.team}${p.is_alive ? '' : ' dead'}">
        <div class="player-card-name">${esc(p.name)}</div>
        <div class="player-card-kd">${k}/${d}</div>
        <div class="player-card-weapon">${esc(p.weapon.replace('weapon_', ''))}</div>
        <div class="player-card-money">$${p.money.toLocaleString()}</div>
        <div class="player-card-hp" style="width:${hpPct}%;background:${hpColor}"></div>
      </div>`
  }

  const meta = state.match.meta
  document.getElementById('player-cards').innerHTML =
    ct.map(cardHtml).join('') +
    `<div class="score-card">
       <div class="score-ct">${meta.ct_score}</div>
       <div class="score-vs">vs</div>
       <div class="score-t">${meta.t_score}</div>
     </div>` +
    t.map(cardHtml).join('')
}

function updateRoundTracker() {
  const rounds = state.match.rounds
  document.getElementById('round-num').textContent   = state.roundIdx + 1
  document.getElementById('round-total').textContent = rounds.length

  document.getElementById('round-squares').innerHTML = rounds.map((r, i) => {
    const cls = i < state.roundIdx ? r.winner_side : i === state.roundIdx ? `${r.winner_side} current` : 'unplayed'
    return `<div class="round-sq ${cls}" title="Round ${i+1}" onclick="jumpToRound(${i})"></div>`
  }).join('')
}

function updateKillFeed() {
  const tick = state.tick
  const tickRate = state.match.meta.tick_rate
  const recent = state.match.kills
    .filter(k => tick - k.tick >= 0 && tick - k.tick < tickRate * 8)
    .slice(-5)
    .reverse()

  document.getElementById('kill-feed-rows').innerHTML = recent.map(k =>
    `<div class="kill-row">
       <span class="kname">${esc(k.killer_name)}</span>
       <span>→</span>
       <span class="vname">${esc(k.victim_name)}</span>
       <span class="kweapon">${esc(k.weapon.replace('weapon_',''))}${k.headshot ? ' hs' : ''}</span>
     </div>`
  ).join('')
}

function updateTimeline() {
  const round = currentRound()
  const span  = round.end_tick - round.start_tick
  const pct   = span > 0 ? ((state.tick - round.start_tick) / span) * 100 : 0
  const clamped = Math.max(0, Math.min(100, pct))
  document.getElementById('timeline-fill').style.width = clamped + '%'
  document.getElementById('timeline-thumb').style.left = clamped + '%'

  const tickRate = state.match.meta.tick_rate
  const elapsed  = Math.floor((state.tick - round.start_tick) / tickRate)
  const total    = Math.floor(span / tickRate)
  const fmt = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`
  document.getElementById('timeline-current').textContent = fmt(elapsed)
  document.getElementById('timeline-end').textContent     = fmt(total)
}

function updatePlayBtn() {
  document.getElementById('play-btn').textContent = state.playing ? '⏸' : '▶'
}

// ── Animation loop ────────────────────────────────────────
function loop(ts) {
  if (state.playing) {
    const dt         = ts - state.lastTs
    const ticksPerMs = (state.match.meta.tick_rate * state.speed) / 1000
    state.tick       = state.tick + dt * ticksPerMs

    const round = currentRound()
    if (state.tick >= round.end_tick) {
      state.tick    = round.end_tick
      state.playing = false
      updatePlayBtn()
    }
  }
  state.lastTs = ts

  render()
  buildPlayerCards()
  updateRoundTracker()
  updateKillFeed()
  updateTimeline()

  requestAnimationFrame(loop)
}

// ── Controls ──────────────────────────────────────────────
document.getElementById('play-btn').addEventListener('click', () => {
  const round = currentRound()
  if (state.tick >= round.end_tick) state.tick = round.start_tick
  state.playing = !state.playing
  updatePlayBtn()
})

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.speed = Number(btn.dataset.speed)
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', b === btn))
  })
})

// Timeline seek
const track = document.getElementById('timeline-track')
function seekFromEvent(e) {
  const { left, width } = track.getBoundingClientRect()
  const pct   = Math.max(0, Math.min(1, (e.clientX - left) / width))
  const round = currentRound()
  state.tick  = round.start_tick + pct * (round.end_tick - round.start_tick)
}
let dragging = false
track.addEventListener('mousedown', e => { dragging = true; seekFromEvent(e) })
window.addEventListener('mousemove', e => { if (dragging) seekFromEvent(e) })
window.addEventListener('mouseup',   () => { dragging = false })

// Round squares clicks (wired via onclick attr in HTML)
window.jumpToRound = jumpToRound

// ── Escape hatch helper ───────────────────────────────────
function esc(s) {
  const d = document.createElement('div')
  d.textContent = s ?? ''
  return d.innerHTML
}

// ── Kick off ──────────────────────────────────────────────
jumpToRound(0)
requestAnimationFrame(ts => { state.lastTs = ts; loop(ts) })
```

- [ ] **Step 2: Test in browser with a processed demo**

After the VPS has processed at least one demo:
1. Go to `demos.html`, click "▶ Watch" on a ready demo
2. The viewer should load, showing the map with player dots
3. Hit play — dots should move
4. Click a round square — should jump to that round
5. Drag the timeline — should scrub through the round
6. Click 2× speed — playback should be faster
7. Kill markers should appear as `✕` at victim positions
8. Smoke clouds should appear as grey circles

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: add CS2 2D demo viewer with Canvas renderer and playback"
```

---

## Task 10: VPS Deployment

**Files:**
- Create: `vps/midround-demo-parser.service`

- [ ] **Step 1: Provision VPS**

Spin up a Ubuntu 22.04 VPS (DigitalOcean $6/mo Droplet or equivalent). SSH in as root.

```bash
apt update && apt install -y python3.11 python3.11-venv python3-pip curl build-essential
# Install Rust (required by demoparser2)
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"
```

- [ ] **Step 2: Deploy code**

```bash
cd /opt
git clone <your-repo-url> midround
cd midround/vps
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
nano .env   # fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
```

- [ ] **Step 3: Create systemd service**

```ini
# vps/midround-demo-parser.service
[Unit]
Description=MIDROUND Demo Parser
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/midround/vps
EnvironmentFile=/opt/midround/vps/.env
ExecStart=/opt/midround/vps/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8100
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
cp vps/midround-demo-parser.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable midround-demo-parser
systemctl start midround-demo-parser
systemctl status midround-demo-parser
```

Expected: `Active: active (running)` and `Polling loop started` in logs (`journalctl -u midround-demo-parser -f`).

- [ ] **Step 4: Test end-to-end**

1. Upload a `.dem` via the MIDROUND demo library page
2. Watch the VPS logs: `journalctl -u midround-demo-parser -f`
3. Should see `Processing demo <id>` then `Done: <id> — de_mirage 16-13`
4. Back in the browser, the demo row should flip from "Processing" to "Ready" (Realtime)
5. Click "▶ Watch" — viewer loads and plays back correctly

- [ ] **Step 5: Commit**

```bash
git add vps/midround-demo-parser.service
git commit -m "feat: add systemd service file for VPS demo parser"
```

---

## Self-Review Notes

- `worldToCanvas` is tested via `demo-map-data.test.html`
- `parse_demo` output shape tested via pytest
- VPS stuck-job cleanup resets jobs stuck in `processing` for >10 min
- Storage path uses `{team_id}/{demo_id}.dem` — consistent between upload and VPS download
- `match_data` JSONB populated by VPS — demo rows before processing have null map/score fields (handled in demos.js with `??` fallbacks)
- `opponent_name` left null for now (not in CS2 demo headers) — teams can see it as `Demo` until a future edit UI is added
- RLS follows existing MIDROUND pattern: authenticated users see all rows, team scoping done at query level with `getTeamId()`
