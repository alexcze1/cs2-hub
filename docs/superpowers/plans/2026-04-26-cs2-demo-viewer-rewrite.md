# CS2 Demo Viewer Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Python demo parser to fix structural bugs (round pairing, winner detection) and strip the viewer down to players-on-map essentials that actually work.

**Architecture:** Server-side parser (`demoparser2` + polars) writes JSON to Supabase `demos.match_data`; frontend fetches and renders on a canvas. Output shape is preserved — `meta`, `rounds`, `frames`, `kills`. Grenades and economy dropped for now.

**Tech Stack:** Python 3.11+, demoparser2 (polars-backed), pytest — frontend: vanilla JS ES modules on Vercel.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `vps/demo_parser.py` | Rewrite | Clean parser with tested helper functions |
| `vps/tests/test_parser.py` | Modify | Add unit tests for helpers, update shape test |
| `vps/test_parse.py` | Create | Standalone CLI script to validate a .dem file |
| `cs2-hub/demo-viewer.html` | Rewrite | Strip to canvas + round tracker + timeline |
| `cs2-hub/demo-viewer.js` | Rewrite | Strip to render + controls, no debug/cards/feed |

`cs2-hub/demo-map-data.js` — **unchanged**, coordinate formula and MAP_DATA values are correct.

---

## Task 1: Parser helper unit tests

**Files:**
- Modify: `vps/tests/test_parser.py`

- [ ] **Step 1: Replace the contents of `vps/tests/test_parser.py` with this:**

```python
import pytest
from pathlib import Path
from demo_parser import parse_demo, _pair_rounds, _winner_side, _is_warmup, SAMPLE_RATE

FIXTURE = Path(__file__).parent / "fixture.dem"


# ── helper unit tests (no file I/O) ──────────────────────────

def test_pair_rounds_basic():
    starts = [100, 300, 500]
    ends = [
        {"tick": 200, "winner": 3, "reason": 7},
        {"tick": 400, "winner": 2, "reason": 8},
        {"tick": 600, "winner": 3, "reason": 9},
    ]
    pairs = _pair_rounds(starts, ends)
    assert len(pairs) == 3
    assert pairs[0]["start_tick"] == 100
    assert pairs[0]["end_tick"] == 200
    assert pairs[1]["start_tick"] == 300
    assert pairs[1]["end_tick"] == 400


def test_pair_rounds_mismatched_trims_to_shorter():
    starts = [100, 300]
    ends = [
        {"tick": 200, "winner": 3, "reason": 7},
        {"tick": 400, "winner": 2, "reason": 8},
        {"tick": 600, "winner": 3, "reason": 9},
    ]
    pairs = _pair_rounds(starts, ends)
    assert len(pairs) == 2


def test_pair_rounds_out_of_order_input_sorted():
    starts = [300, 100, 500]
    ends = [
        {"tick": 600, "winner": 3, "reason": 9},
        {"tick": 200, "winner": 3, "reason": 7},
        {"tick": 400, "winner": 2, "reason": 8},
    ]
    pairs = _pair_rounds(starts, ends)
    assert pairs[0]["start_tick"] == 100
    assert pairs[0]["end_tick"] == 200


def test_pair_rounds_winner_and_reason_preserved():
    starts = [100]
    ends = [{"tick": 200, "winner": 2, "reason": 9}]
    pairs = _pair_rounds(starts, ends)
    assert pairs[0]["winner"] == 2
    assert pairs[0]["reason"] == 9


def test_winner_side_ct():
    assert _winner_side(3) == "ct"


def test_winner_side_t():
    assert _winner_side(2) == "t"


def test_winner_side_unknown_returns_none():
    assert _winner_side(0) is None
    assert _winner_side(None) is None
    assert _winner_side(1) is None
    assert _winner_side("CT") is None


def test_is_warmup_short_round():
    assert _is_warmup(100, 400) is True   # 300 ticks < 500


def test_is_warmup_real_round():
    assert _is_warmup(100, 700) is False  # 600 ticks >= 500


def test_is_warmup_exact_boundary():
    assert _is_warmup(100, 600) is False  # 500 ticks == 500, not warmup


# ── integration tests (require fixture.dem) ──────────────────

@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_output_shape():
    result = parse_demo(str(FIXTURE))
    assert "meta" in result
    assert "rounds" in result
    assert "frames" in result
    assert "kills" in result


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


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_player_fields():
    result = parse_demo(str(FIXTURE))
    frame = result["frames"][0]
    assert "tick" in frame
    assert "players" in frame
    if frame["players"]:
        p = frame["players"][0]
        for key in ("steam_id", "name", "team", "x", "y", "hp", "is_alive"):
            assert key in p, f"missing key: {key}"
        assert p["team"] in ("ct", "t")


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_no_rounds_share_start_tick():
    result = parse_demo(str(FIXTURE))
    start_ticks = [r["start_tick"] for r in result["rounds"]]
    assert len(start_ticks) == len(set(start_ticks)), "duplicate start ticks"


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_all_rounds_have_valid_winner():
    result = parse_demo(str(FIXTURE))
    for r in result["rounds"]:
        assert r["winner_side"] in ("ct", "t"), f"bad winner: {r}"
```

- [ ] **Step 2: Run the tests — helper tests should fail (functions don't exist yet)**

```bash
cd vps && pytest tests/test_parser.py -v -k "not fixture"
```

Expected output: 9 failures like `ImportError: cannot import name '_pair_rounds' from 'demo_parser'`

- [ ] **Step 3: Commit the test file**

```bash
cd vps && git add tests/test_parser.py
git commit -m "test: add helper unit tests for demo parser rewrite"
```

---

## Task 2: Rewrite `vps/demo_parser.py`

**Files:**
- Rewrite: `vps/demo_parser.py`

- [ ] **Step 1: Replace the entire contents of `vps/demo_parser.py` with:**

```python
import math
from collections import defaultdict
from demoparser2 import DemoParser

SAMPLE_RATE = 8

_WIN_REASONS = {
    1: "t_eliminated",
    7: "bomb_defused",
    8: "ct_eliminated",
    9: "bomb_exploded",
    12: "time_ran_out",
}


def _pair_rounds(start_ticks: list, end_rows: list) -> list:
    """Pair round_start ticks with round_end rows by sorted position."""
    start_ticks = sorted(int(t) for t in start_ticks)
    end_rows = sorted(end_rows, key=lambda r: int(r["tick"]))
    n = min(len(start_ticks), len(end_rows))
    return [
        {
            "start_tick": start_ticks[i],
            "end_tick":   int(end_rows[i]["tick"]),
            "winner":     end_rows[i].get("winner"),
            "reason":     end_rows[i].get("reason"),
        }
        for i in range(n)
    ]


def _winner_side(winner_val) -> str | None:
    """Return 'ct', 't', or None. CS2: winner==3 → CT, winner==2 → T."""
    if winner_val == 3:
        return "ct"
    if winner_val == 2:
        return "t"
    return None


def _is_warmup(start_tick: int, end_tick: int, min_ticks: int = 500) -> bool:
    return (end_tick - start_tick) < min_ticks


def _safe_float(val) -> float:
    if val is None:
        return 0.0
    try:
        f = float(val)
        return 0.0 if math.isnan(f) else f
    except (TypeError, ValueError):
        return 0.0


def _safe_int(val) -> int:
    if val is None:
        return 0
    try:
        f = float(val)
        return 0 if math.isnan(f) else int(f)
    except (TypeError, ValueError):
        return 0


def parse_demo(dem_path: str) -> dict:
    p = DemoParser(dem_path)
    header = p.parse_header()

    tick_df = p.parse_ticks([
        "X", "Y", "health", "is_alive", "team_num",
        "active_weapon_name", "cash", "armor_value",
    ])

    kills_df      = p.parse_event("player_death")
    round_end_df  = p.parse_event("round_end")
    round_start_df = p.parse_event("round_start")

    start_ticks = round_start_df["tick"].to_list()
    end_rows    = round_end_df.to_dicts()

    pairs = _pair_rounds(start_ticks, end_rows)
    print(f"[parser] pairs: {len(pairs)}  starts: {len(start_ticks)}  ends: {len(end_rows)}")

    rounds = []
    for pair in pairs:
        if _is_warmup(pair["start_tick"], pair["end_tick"]):
            print(f"[parser] skip warmup: {pair['start_tick']}→{pair['end_tick']}")
            continue
        winner = _winner_side(pair["winner"])
        if winner is None:
            print(f"[parser] skip unknown winner={pair['winner']} at tick {pair['end_tick']}")
            continue
        rounds.append({
            "round_num":   len(rounds) + 1,
            "start_tick":  pair["start_tick"],
            "end_tick":    pair["end_tick"],
            "winner_side": winner,
            "win_reason":  _WIN_REASONS.get(pair["reason"], "unknown"),
        })

    print(f"[parser] rounds built: {len(rounds)}")

    all_ticks = sorted(tick_df["tick"].unique().to_list())
    sampled   = all_ticks[::SAMPLE_RATE]
    print(f"[parser] tick range: {all_ticks[0] if all_ticks else 'none'}–{all_ticks[-1] if all_ticks else 'none'}  sampled: {len(sampled)}")

    tick_records = tick_df.to_dicts()
    by_tick: dict = defaultdict(list)
    for r in tick_records:
        by_tick[int(r["tick"])].append(r)

    frames = []
    for tick in sampled:
        players = []
        for r in by_tick.get(tick, []):
            team_num = _safe_int(r.get("team_num")) or 2
            players.append({
                "steam_id": str(r.get("steamid") or ""),
                "name":     str(r.get("name") or ""),
                "team":     "ct" if team_num == 3 else "t",
                "x":        _safe_float(r.get("X")),
                "y":        _safe_float(r.get("Y")),
                "hp":       _safe_int(r.get("health")),
                "armor":    _safe_int(r.get("armor_value")),
                "weapon":   str(r.get("active_weapon_name") or ""),
                "money":    _safe_int(r.get("cash")),
                "is_alive": bool(r.get("is_alive") or False),
            })
        frames.append({"tick": int(tick), "players": players})

    print(f"[parser] frames: {len(frames)}  frame[0] players: {len(frames[0]['players']) if frames else 0}")

    kills = []
    for r in kills_df.to_dicts():
        kills.append({
            "tick":        int(r["tick"]),
            "killer_id":   str(r.get("attacker_steamid") or ""),
            "killer_name": str(r.get("attacker_name") or ""),
            "victim_id":   str(r.get("user_steamid") or ""),
            "victim_name": str(r.get("user_name") or ""),
            "weapon":      str(r.get("weapon") or ""),
            "headshot":    bool(r.get("headshot") or False),
            "victim_x":    _safe_float(r.get("user_X")),
            "victim_y":    _safe_float(r.get("user_Y")),
        })

    raw_rate = header.get("playback_ticks", 128) / max(header.get("playback_time", 1), 0.001)
    tick_rate = 64 if raw_rate < 100 else 128
    ct_score  = sum(1 for r in rounds if r["winner_side"] == "ct")
    t_score   = sum(1 for r in rounds if r["winner_side"] == "t")

    return {
        "meta": {
            "map":         header.get("map_name", ""),
            "tick_rate":   tick_rate,
            "total_ticks": _safe_int(header.get("playback_ticks")),
            "ct_score":    ct_score,
            "t_score":     t_score,
        },
        "rounds": rounds,
        "frames": frames,
        "kills":  kills,
    }
```

- [ ] **Step 2: Run the helper unit tests — all 9 should pass**

```bash
cd vps && pytest tests/test_parser.py -v -k "not fixture"
```

Expected output:
```
test_pair_rounds_basic PASSED
test_pair_rounds_mismatched_trims_to_shorter PASSED
test_pair_rounds_out_of_order_input_sorted PASSED
test_pair_rounds_winner_and_reason_preserved PASSED
test_winner_side_ct PASSED
test_winner_side_t PASSED
test_winner_side_unknown_returns_none PASSED
test_is_warmup_short_round PASSED
test_is_warmup_real_round PASSED
test_is_warmup_exact_boundary PASSED
```

- [ ] **Step 3: Commit**

```bash
git add vps/demo_parser.py
git commit -m "feat: rewrite demo parser — correct round pairing, polars-native, strict winner detection"
```

---

## Task 3: Validation script

**Files:**
- Create: `vps/test_parse.py`

- [ ] **Step 1: Create `vps/test_parse.py` with this content:**

```python
#!/usr/bin/env python3
"""Standalone demo parse validator.
Usage: cd vps && python test_parse.py path/to/demo.dem
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from demo_parser import parse_demo

_MAP_BOUNDS = {
    "de_mirage":  {"x": (-3230, 1890),  "y": (-3407, 1713)},
    "de_inferno": {"x": (-2087, 2930),  "y": (-1147, 3870)},
    "de_nuke":    {"x": (-3453, 3715),  "y": (-4281, 2887)},
    "de_ancient": {"x": (-2953, 2167),  "y": (-2956, 2164)},
    "de_anubis":  {"x": (-2796, 2549),  "y": (-2017, 3328)},
    "de_dust2":   {"x": (-2476, 2030),  "y": (-1267, 3239)},
    "de_vertigo": {"x": (-3168,  928),  "y": (-2334, 1762)},
    "de_train":   {"x": (-2477, 2336),  "y": (-2421, 2392)},
}


def _in_bounds(x, y, map_name):
    b = _MAP_BOUNDS.get(map_name)
    if not b:
        return True
    return b["x"][0] <= x <= b["x"][1] and b["y"][0] <= y <= b["y"][1]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_parse.py <demo.dem>")
        sys.exit(1)

    path = sys.argv[1]
    print(f"Parsing {path} …\n")
    data = parse_demo(path)

    map_name  = data["meta"]["map"]
    tick_rate = data["meta"]["tick_rate"]

    print("── META ──────────────────────────────────────────────────")
    print(f"  Map: {map_name}   Tick rate: {tick_rate}")
    print(f"  CT {data['meta']['ct_score']} – {data['meta']['t_score']} T")

    print(f"\n── ROUNDS ({len(data['rounds'])}) ────────────────────────────────────")
    for r in data["rounds"][:5]:
        dur = r["end_tick"] - r["start_tick"]
        print(f"  R{r['round_num']:02d}  {r['start_tick']:6d} → {r['end_tick']:6d}  ({dur:4d} ticks)  {r['winner_side'].upper()}  {r['win_reason']}")
    if len(data["rounds"]) > 5:
        print(f"  … {len(data['rounds']) - 5} more rounds")

    print(f"\n── FRAMES ({len(data['frames'])}) ───────────────────────────────────")
    if data["frames"]:
        f0 = data["frames"][0]
        print(f"  Frame 0  tick={f0['tick']}  players={len(f0['players'])}")
        for p in f0["players"][:10]:
            flag = "✓" if _in_bounds(p["x"], p["y"], map_name) else "⚠ OUT OF BOUNDS"
            print(f"    {p['name'][:15]:15}  {p['team'].upper()}  x={p['x']:8.0f}  y={p['y']:8.0f}  alive={p['is_alive']}  {flag}")

    print(f"\n── KILLS ({len(data['kills'])}) ─────────────────────────────────────")
    for k in data["kills"][:5]:
        hs = "  HS" if k["headshot"] else ""
        print(f"  tick={k['tick']:6d}  {k['killer_name'][:12]:12} → {k['victim_name'][:12]:12}  {k['weapon']}{hs}")

    # Sanity checks
    print("\n── CHECKS ────────────────────────────────────────────────")

    oob = [(f["tick"], p["name"], p["x"], p["y"])
           for f in data["frames"]
           for p in f["players"]
           if p["is_alive"] and not _in_bounds(p["x"], p["y"], map_name)]
    if oob:
        print(f"  ⚠ {len(oob)} out-of-bounds alive-player positions")
        for tick, name, x, y in oob[:3]:
            print(f"    tick={tick}  {name}  ({x:.0f}, {y:.0f})")
    else:
        print("  ✓ All alive-player positions within map bounds")

    zero = sum(1 for f in data["frames"]
               for p in f["players"]
               if p["is_alive"] and p["x"] == 0 and p["y"] == 0)
    if zero:
        print(f"  ⚠ {zero} alive players stuck at (0, 0) — likely parse failure")
    else:
        print("  ✓ No alive players at origin")

    start_ticks = [r["start_tick"] for r in data["rounds"]]
    if len(start_ticks) != len(set(start_ticks)):
        print("  ⚠ Duplicate round start_ticks detected")
    else:
        print("  ✓ All round start_ticks are unique")

    print("\n✓ Done")
```

- [ ] **Step 2: Verify the script is importable (no syntax errors)**

```bash
cd vps && python -c "import test_parse; print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add vps/test_parse.py
git commit -m "feat: add standalone demo parse validation script"
```

---

## Task 4: Rewrite `demo-viewer.html`

**Files:**
- Rewrite: `cs2-hub/demo-viewer.html`

- [ ] **Step 1: Replace the full contents of `cs2-hub/demo-viewer.html` with:**

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
    .viewer-shell {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 40px);
      gap: 8px;
      padding: 8px 16px;
    }
    .viewer-mid {
      flex: 1;
      min-height: 0;
    }
    .map-canvas-wrap {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    #map-canvas { display: block; max-width: 100%; max-height: 100%; }
    .viewer-bottom {
      display: grid;
      grid-template-columns: 200px 1fr;
      gap: 8px;
      flex-shrink: 0;
    }
    .round-tracker {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
    }
    .round-tracker-label {
      font-size: 10px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: .06em;
      margin-bottom: 6px;
    }
    .round-squares { display: flex; flex-wrap: wrap; gap: 3px; }
    .round-sq {
      width: 16px;
      height: 16px;
      border-radius: 2px;
      cursor: pointer;
      opacity: 0.85;
    }
    .round-sq.current  { outline: 2px solid var(--text); outline-offset: 1px; }
    .round-sq.ct       { background: #4FC3F7; }
    .round-sq.t        { background: #EF5350; }
    .round-sq.unplayed { background: rgba(255,255,255,0.18); }
    .viewer-timeline {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .timeline-track {
      flex: 1;
      position: relative;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      cursor: pointer;
    }
    .timeline-fill  { height: 100%; background: var(--accent); border-radius: 2px; pointer-events: none; }
    .timeline-thumb {
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 12px;
      height: 12px;
      background: #fff;
      border-radius: 50%;
      pointer-events: none;
      box-shadow: 0 0 4px rgba(0,0,0,.4);
    }
    .timeline-time  { font-size: 11px; color: var(--text-secondary); min-width: 36px; }
    .speed-btn {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 11px;
      color: var(--text-secondary);
      cursor: pointer;
    }
    .speed-btn.active { border-color: var(--accent); color: var(--accent); }
    .play-btn { background: none; border: none; color: var(--text); font-size: 18px; cursor: pointer; padding: 0 4px; }
    #viewer-loading {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg);
      z-index: 10;
      font-size: 14px;
      color: var(--text-secondary);
    }
  </style>
</head>
<body>
<div class="app-shell">
  <nav class="sidebar" id="sidebar"></nav>
  <main class="main-content" style="padding:0;overflow:hidden;position:relative">

    <div id="viewer-loading">Loading demo…</div>

    <div class="viewer-shell" id="viewer-shell" style="display:none">

      <div class="viewer-mid">
        <div class="map-canvas-wrap" id="map-canvas-wrap">
          <canvas id="map-canvas"></canvas>
        </div>
      </div>

      <div class="viewer-bottom">
        <div class="round-tracker">
          <div class="round-tracker-label">
            Round <span id="round-num">—</span> / <span id="round-total">—</span>
          </div>
          <div class="round-squares" id="round-squares"></div>
        </div>
        <div class="viewer-timeline">
          <button class="play-btn" id="play-btn">▶</button>
          <span class="timeline-time" id="timeline-current">0:00</span>
          <div class="timeline-track" id="timeline-track">
            <div class="timeline-fill"  id="timeline-fill"  style="width:0%"></div>
            <div class="timeline-thumb" id="timeline-thumb" style="left:0%"></div>
          </div>
          <span class="timeline-time" id="timeline-end">0:00</span>
          <button class="speed-btn active" data-speed="1">1×</button>
          <button class="speed-btn" data-speed="2">2×</button>
          <button class="speed-btn" data-speed="4">4×</button>
        </div>
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
git commit -m "feat: strip demo viewer html to essentials — map, rounds, timeline only"
```

---

## Task 5: Rewrite `demo-viewer.js`

**Files:**
- Rewrite: `cs2-hub/demo-viewer.js`

- [ ] **Step 1: Replace the full contents of `cs2-hub/demo-viewer.js` with:**

```javascript
import { requireAuth }   from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase }      from './supabase.js'
import { worldToCanvas } from './demo-map-data.js'

await requireAuth()
renderSidebar('demos')

const params = new URLSearchParams(location.search)
const demoId = params.get('id')
if (!demoId) { location.href = 'demos.html'; throw new Error('no id') }

// ── State ─────────────────────────────────────────────────────
const state = { match: null, playing: false, tick: 0, speed: 1, lastTs: 0, roundIdx: 0 }
let mapImg    = null
let mapLoaded = false

// ── Load ──────────────────────────────────────────────────────
const loadingEl = document.getElementById('viewer-loading')

const { data: demo, error } = await supabase
  .from('demos')
  .select('match_data,map,status')
  .eq('id', demoId)
  .single()

if (error || !demo || demo.status !== 'ready') {
  loadingEl.textContent =
    demo?.status === 'processing' ? 'Demo is still processing…' :
    demo?.status === 'error'      ? 'Demo processing failed.'   :
    'Demo not found.'
  throw new Error('not ready')
}

state.match         = demo.match_data
state.match.rounds  = state.match.rounds ?? []
state.match.frames  = state.match.frames ?? []
state.match.kills   = state.match.kills  ?? []

if (!state.match.frames.length) {
  loadingEl.textContent = 'No frame data — try re-uploading.'
  throw new Error('no frames')
}
if (!state.match.frames[0]?.players?.length) {
  loadingEl.textContent = 'Parser returned no players — check server logs.'
  throw new Error('no players in frame 0')
}
if (!state.match.rounds.length) {
  loadingEl.textContent = 'No round data — try re-uploading.'
  throw new Error('no rounds')
}

document.title = `${demo.map ?? ''} — MIDROUND`

mapImg     = new Image()
mapImg.src = `images/maps/${demo.map}_radar.png`
mapImg.onload  = () => { mapLoaded = true }
mapImg.onerror = () => { mapLoaded = true }

loadingEl.style.display = 'none'
document.getElementById('viewer-shell').style.display = 'flex'

// ── Canvas ────────────────────────────────────────────────────
const canvas = document.getElementById('map-canvas')
const ctx    = canvas.getContext('2d')
const wrap   = document.getElementById('map-canvas-wrap')

function resizeCanvas() {
  const { width, height } = wrap.getBoundingClientRect()
  const size = Math.min(width, height) - 16
  if (size < 10) return
  canvas.width  = size
  canvas.height = size
}
requestAnimationFrame(resizeCanvas)
new ResizeObserver(resizeCanvas).observe(wrap)

// ── Round helpers ─────────────────────────────────────────────
function currentRound() { return state.match.rounds[state.roundIdx] }

function jumpToRound(idx) {
  state.roundIdx = Math.max(0, Math.min(idx, state.match.rounds.length - 1))
  state.tick     = currentRound().start_tick
  state.playing  = false
  updatePlayBtn()
  updateRoundTracker()
}

// ── Frame lookup (binary search) ──────────────────────────────
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

// ── Render ────────────────────────────────────────────────────
function render() {
  const { width: cw, height: ch } = canvas
  const map = state.match.meta.map
  ctx.clearRect(0, 0, cw, ch)

  if (mapLoaded && mapImg.complete && mapImg.naturalWidth) {
    ctx.drawImage(mapImg, 0, 0, cw, ch)
  } else {
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, cw, ch)
  }

  const frame = getFrame(state.tick)
  if (!frame) return

  const dotR     = Math.round(cw * 0.012)
  const fontSize = Math.round(cw * 0.018)

  for (const p of frame.players) {
    const { x, y } = worldToCanvas(p.x, p.y, map, cw, ch)

    ctx.beginPath()
    ctx.arc(x, y, dotR, 0, Math.PI * 2)
    if (!p.is_alive) {
      ctx.globalAlpha = 0.3
      ctx.fillStyle   = '#888'
    } else {
      ctx.fillStyle = p.team === 'ct' ? '#4FC3F7' : '#EF5350'
    }
    ctx.strokeStyle = '#fff'
    ctx.lineWidth   = 1.5
    ctx.fill()
    ctx.stroke()
    ctx.globalAlpha = 1

    if (p.is_alive) {
      ctx.fillStyle    = '#fff'
      ctx.font         = `${fontSize}px sans-serif`
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(p.name.slice(0, 10), x, y + dotR + 2)
    }
  }
}

// ── UI updates ────────────────────────────────────────────────
function updateRoundTracker() {
  const rounds = state.match.rounds
  document.getElementById('round-num').textContent   = state.roundIdx + 1
  document.getElementById('round-total').textContent = rounds.length
  document.getElementById('round-squares').innerHTML = rounds.map((r, i) => {
    const cls = i < state.roundIdx
      ? r.winner_side
      : i === state.roundIdx
        ? `${r.winner_side} current`
        : 'unplayed'
    return `<div class="round-sq ${cls}" title="Round ${i + 1}" onclick="jumpToRound(${i})"></div>`
  }).join('')
}

function updateTimeline() {
  const round    = currentRound()
  const span     = round.end_tick - round.start_tick
  const pct      = span > 0 ? ((state.tick - round.start_tick) / span) * 100 : 0
  const clamped  = Math.max(0, Math.min(100, pct))
  document.getElementById('timeline-fill').style.width = clamped + '%'
  document.getElementById('timeline-thumb').style.left = clamped + '%'

  const tickRate = state.match.meta.tick_rate
  const elapsed  = Math.floor(Math.max(0, state.tick - round.start_tick) / tickRate)
  const total    = Math.floor(span / tickRate)
  const fmt = s  => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  document.getElementById('timeline-current').textContent = fmt(elapsed)
  document.getElementById('timeline-end').textContent     = fmt(total)
}

function updatePlayBtn() {
  document.getElementById('play-btn').textContent = state.playing ? '⏸' : '▶'
}

// ── Loop ──────────────────────────────────────────────────────
function loop(ts) {
  try {
    if (state.playing) {
      const dt        = ts - state.lastTs
      const ticksPerMs = (state.match.meta.tick_rate * state.speed) / 1000
      state.tick      += dt * ticksPerMs

      const round = currentRound()
      if (state.tick >= round.end_tick) {
        state.tick    = round.end_tick
        state.playing = false
        updatePlayBtn()
      }
    }
    state.lastTs = ts
    render()
    updateRoundTracker()
    updateTimeline()
  } catch (e) {
    console.error('Viewer loop error:', e)
  }
  requestAnimationFrame(loop)
}

// ── Controls ──────────────────────────────────────────────────
document.getElementById('play-btn').addEventListener('click', () => {
  const round = currentRound()
  if (state.tick >= round.end_tick) state.tick = round.start_tick
  state.playing = !state.playing
  updatePlayBtn()
})

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.speed = Number(btn.dataset.speed)
    document.querySelectorAll('.speed-btn').forEach(b =>
      b.classList.toggle('active', b === btn)
    )
  })
})

const track = document.getElementById('timeline-track')
let dragging = false
function seekFromEvent(e) {
  const { left, width } = track.getBoundingClientRect()
  const pct   = Math.max(0, Math.min(1, (e.clientX - left) / width))
  const round = currentRound()
  state.tick  = round.start_tick + pct * (round.end_tick - round.start_tick)
}
track.addEventListener('mousedown', e => { dragging = true; seekFromEvent(e) })
window.addEventListener('mousemove', e => { if (dragging) seekFromEvent(e) })
window.addEventListener('mouseup',   ()  => { dragging = false })

window.jumpToRound = jumpToRound

// ── Kick off ──────────────────────────────────────────────────
jumpToRound(0)
requestAnimationFrame(ts => { state.lastTs = ts; loop(ts) })
```

- [ ] **Step 2: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: rewrite demo viewer js — essentials only, players on map, round nav, timeline"
```

---

## Task 6: Deploy and validate end-to-end

- [ ] **Step 1: Run parser unit tests one final time**

```bash
cd vps && pytest tests/test_parser.py -v -k "not fixture"
```

All 10 helper tests should pass.

- [ ] **Step 2: (If you have a .dem file) Run the validation script**

```bash
cd vps && python test_parse.py /path/to/your/demo.dem
```

Check that:
- Rounds count looks right (typically 20–35 for a full match)
- Player positions show ✓ (not out-of-bounds)
- No alive players at (0, 0)
- All round start_ticks are unique

- [ ] **Step 3: Deploy the VPS parser**

```bash
# On your VPS, pull latest and restart the service
git pull && sudo systemctl restart midround-vps   # adjust service name as needed
```

- [ ] **Step 4: Re-parse a demo through the normal upload flow**

Upload a demo via the app UI. Wait for it to reach `status = 'ready'` in Supabase. Open it in the viewer and confirm players appear as dots on the map.

- [ ] **Step 5: Final commit if any tweaks were needed**

```bash
git add -p && git commit -m "fix: <describe any tweaks found during validation>"
```
