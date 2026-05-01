# Multi-Round Analysis Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New top-level Analysis page in the CS2 Hub that lets a user pick any team and overlay all rounds from that team's uploaded demos, plus visualise every grenade landing across the filtered round set.

**Architecture:** A team-centric page (`analysis.html`) queries Supabase for matching demos by team, fetches a slim parser-side payload (~10× smaller than full `match_data`), filters rounds in the client, and renders into a canvas with two modes — Overlay (animated, round-relative time) and Grenade (static landings + side panel). The slim payload requires a one-time parser change (writes a second JSONB column at parse time) plus a backfill of already-parsed demos.

**Tech Stack:** Vanilla JS/HTML/CSS, Canvas 2D API (frontend); Python + demoparser2 + psycopg2 + Supabase (VPS parser). No new frameworks.

**Spec:** `docs/superpowers/specs/2026-05-01-cs2-hub-multiround-analysis-design.md`

---

## File Map

| File | What changes |
|---|---|
| `cs2-hub/supabase-demos.sql` | Migration: add `match_data_slim jsonb` column + 2 indexes |
| `vps/demo_parser.py` | Add `build_slim_payload(parsed)` pure function at module bottom |
| `vps/tests/test_slim_payload.py` | New — pytest unit tests for slim payload builder |
| `vps/main.py` | Wire `build_slim_payload` into `_db_write_results` (write both columns) |
| `vps/backfill_slim.py` | New — one-time backfill script for already-parsed demos |
| `cs2-hub/layout.js` | Add "Analysis" sidebar entry in TOOLS section |
| `cs2-hub/analysis.html` | New — page shell, layout, all CSS for the page |
| `cs2-hub/analysis.js` | New — main module: corpus query, filter logic, render loop, mode toggling |
| `cs2-hub/analysis-rounds.js` | New — pure `narrowRoundsForTeam` function + helpers (split for testability) |
| `cs2-hub/analysis-rounds.test.html` | New — browser-based test for `narrowRoundsForTeam` |

---

## Task 1: Database migration — slim payload column + indexes

**Files:**
- Modify: `cs2-hub/supabase-demos.sql`

- [ ] **Step 1: Append migration to the SQL file**

Add at the bottom of `cs2-hub/supabase-demos.sql`:

```sql
-- Migration 2026-05-01: slim payload column for multi-round analysis tool.
-- Populated by VPS parser at parse time alongside match_data; ~10x smaller,
-- contains only what analysis.html needs (downsampled frames, grenade landings).
alter table demos add column if not exists match_data_slim jsonb;

-- Indexes covering the common analysis lookup: "all demos where team T played map M"
create index if not exists demos_ct_team_map_idx on demos (ct_team_name, map);
create index if not exists demos_t_team_map_idx  on demos (t_team_name,  map);
```

- [ ] **Step 2: Apply the migration in Supabase SQL editor**

Run the three statements above in the Supabase SQL editor for the project's database.

- [ ] **Step 3: Verify**

In the Supabase SQL editor, run:

```sql
select column_name, data_type from information_schema.columns
  where table_name = 'demos' and column_name = 'match_data_slim';
```

Expected: one row with `data_type = 'jsonb'`.

```sql
select indexname from pg_indexes
  where tablename = 'demos'
    and indexname in ('demos_ct_team_map_idx', 'demos_t_team_map_idx');
```

Expected: two rows.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/supabase-demos.sql
git commit -m "feat(db): add match_data_slim column + team+map indexes for analysis tool"
```

---

## Task 2: VPS parser — `build_slim_payload` pure function with tests

**Files:**
- Modify: `vps/demo_parser.py` (add function at end of file)
- Create: `vps/tests/test_slim_payload.py`

- [ ] **Step 1: Write the failing test**

Create `vps/tests/test_slim_payload.py`:

```python
import pytest

from demo_parser import build_slim_payload


def _sample_parsed():
    """Minimal parsed-demo dict mirroring the shape returned by parse_demo()."""
    return {
        "meta": {
            "map": "de_mirage",
            "tick_rate": 70,
            "total_ticks": 200000,
            "ct_score": 8,
            "t_score": 5,
            "team_a_score": 8,
            "team_b_score": 5,
            "team_a_first_side": "ct",
        },
        "players_meta": {"76561": {"name": "ropz"}},
        "rounds": [
            {
                "round_num": 1,
                "start_tick": 1000,
                "freeze_end_tick": 2000,
                "end_tick": 5000,
                "winner": "CT",
                "winner_side": "ct",
                "reason": "t_eliminated",
                "team_a_side": "ct",
            },
            {
                "round_num": 2,
                "start_tick": 6000,
                "freeze_end_tick": 7000,
                "end_tick": 10000,
                "winner": "T",
                "winner_side": "t",
                "reason": "bomb_exploded",
                "team_a_side": "ct",
                "bomb_planted_site": "A",  # set in real parser; preserved if present
            },
        ],
        "frames": [
            # Round 1 frames
            {"tick": 2000, "players": [
                {"steam_id": "76561", "team": "ct", "x": 100, "y": 200, "z": 0,
                 "hp": 100, "armor": 100, "weapon": "ak47", "money": 4000,
                 "is_alive": True, "yaw": 90.0, "pitch": 0.0,
                 "has_smoke": True, "has_flash": False, "has_molotov": False, "has_he": False},
            ]},
            {"tick": 2016, "players": [  # 16 ticks later (the SAMPLE_RATE)
                {"steam_id": "76561", "team": "ct", "x": 110, "y": 210, "z": 0,
                 "hp": 100, "armor": 100, "weapon": "ak47", "money": 4000,
                 "is_alive": True, "yaw": 95.0, "pitch": 0.0,
                 "has_smoke": True, "has_flash": False, "has_molotov": False, "has_he": False},
            ]},
            # Frame outside any round (between R1 end and R2 start) — must be excluded
            {"tick": 5500, "players": []},
            # Round 2 frame
            {"tick": 7016, "players": [
                {"steam_id": "76561", "team": "t", "x": -50, "y": -100, "z": 0,
                 "hp": 100, "armor": 100, "weapon": "ak47", "money": 4000,
                 "is_alive": True, "yaw": 180.0, "pitch": 0.0,
                 "has_smoke": False, "has_flash": False, "has_molotov": True, "has_he": False},
            ]},
        ],
        "kills": [{"tick": 4000, "killer_id": "76561"}],   # excluded from slim
        "shots": [{"tick": 3000, "steam_id": "76561"}],    # excluded from slim
        "bomb":  [{"tick": 8500, "type": "planted"}],      # excluded from slim
        "grenades": [
            {
                "tick": 3500, "type": "smoke", "x": 150, "y": 250,
                "end_tick": 6316, "steam_id": "76561",
                "path": [[100, 200], [120, 220], [150, 250]],
                "origin_x": 100, "origin_y": 200, "origin_tick": 3450,
                "path_throw_tick": 3450, "path_det_tick": 3500,
            },
            # Grenade between rounds — should be excluded
            {"tick": 5500, "type": "flash", "x": 0, "y": 0,
             "end_tick": 5564, "steam_id": "76561"},
            {
                "tick": 8000, "type": "molotov", "x": -75, "y": -150,
                "end_tick": 8448, "steam_id": "76561",
                "path": [[-50, -100], [-65, -125], [-75, -150]],
                "origin_x": -50, "origin_y": -100, "origin_tick": 7950,
                "path_throw_tick": 7950, "path_det_tick": 8000,
            },
        ],
    }


def test_meta_carries_map_and_tickrate():
    slim = build_slim_payload(_sample_parsed())
    assert slim["meta"]["map"] == "de_mirage"
    assert slim["meta"]["tick_rate"] == 70


def test_meta_players_compact_to_name_only():
    slim = build_slim_payload(_sample_parsed())
    # Only steam_id → {name: ...} survives; nothing else from full players_meta
    assert slim["meta"]["players"] == {"76561": {"name": "ropz"}}


def test_rounds_keep_only_required_fields():
    slim = build_slim_payload(_sample_parsed())
    r0 = slim["rounds"][0]
    assert set(r0.keys()) == {
        "idx", "side_team_a", "freeze_end_tick", "end_tick",
        "winner", "won_by", "bomb_planted_site",
    }
    assert r0["idx"] == 0
    assert r0["side_team_a"] == "ct"
    assert r0["freeze_end_tick"] == 2000
    assert r0["end_tick"] == 5000
    assert r0["winner"] == "ct"
    assert r0["won_by"] == "t_eliminated"
    assert r0["bomb_planted_site"] is None
    # Round 2 carries the bomb plant site through
    assert slim["rounds"][1]["bomb_planted_site"] == "A"


def test_frames_assigned_to_round_and_filtered():
    slim = build_slim_payload(_sample_parsed())
    # Out-of-round frame at tick 5500 must be dropped
    assert len(slim["frames"]) == 3
    assert slim["frames"][0]["round_idx"] == 0
    assert slim["frames"][1]["round_idx"] == 0
    assert slim["frames"][2]["round_idx"] == 1


def test_frame_player_carries_only_slim_fields():
    slim = build_slim_payload(_sample_parsed())
    p = slim["frames"][0]["players"][0]
    assert set(p.keys()) == {"steam_id", "team", "x", "y", "alive", "yaw"}
    assert p["alive"] is True  # mapped from is_alive
    assert p["x"] == 100 and p["y"] == 200
    assert "hp" not in p and "weapon" not in p and "money" not in p


def test_grenades_filtered_to_in_round_and_slim_shape():
    slim = build_slim_payload(_sample_parsed())
    # The flash at tick 5500 is between rounds → excluded
    assert len(slim["grenades"]) == 2
    g = slim["grenades"][0]
    assert set(g.keys()) >= {
        "round_idx", "type", "thrower_sid", "thrower_team",
        "throw_tick", "land_x", "land_y", "trajectory",
    }
    assert g["round_idx"] == 0
    assert g["type"] == "smoke"
    assert g["thrower_sid"] == "76561"
    assert g["thrower_team"] == "ct"   # derived from frame at throw tick
    assert g["throw_tick"] == 3450
    assert g["land_x"] == 150 and g["land_y"] == 250
    assert g["trajectory"] == [[100, 200], [120, 220], [150, 250]]


def test_grenade_without_path_still_emitted_with_empty_trajectory():
    parsed = _sample_parsed()
    parsed["grenades"] = [{
        "tick": 3500, "type": "he", "x": 50, "y": 50,
        "end_tick": 3532, "steam_id": "76561",
        # no "path" key
    }]
    slim = build_slim_payload(parsed)
    assert len(slim["grenades"]) == 1
    assert slim["grenades"][0]["trajectory"] == []
    # Falls back to detonation tick when origin tick is unavailable
    assert slim["grenades"][0]["throw_tick"] == 3500


def test_empty_parsed_returns_empty_slim():
    slim = build_slim_payload({
        "meta": {"map": "de_mirage", "tick_rate": 70},
        "rounds": [], "frames": [], "grenades": [],
    })
    assert slim["rounds"] == [] and slim["frames"] == [] and slim["grenades"] == []
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd vps
python -m pytest tests/test_slim_payload.py -v
```

Expected: ImportError or AttributeError on `build_slim_payload` (function doesn't exist yet).

- [ ] **Step 3: Implement `build_slim_payload` at bottom of `vps/demo_parser.py`**

Add the function (place at end of file, after `parse_demo`):

```python
# ─────────────────────────────────────────────────────────────────────────────
# Slim payload for multi-round analysis tool (analysis.html).
# Pure function — no I/O. Derives a ~10x smaller representation of a parsed
# demo containing only the fields needed for round-overlay rendering and
# grenade-mode visualisation.
# ─────────────────────────────────────────────────────────────────────────────

# Maps the integer/string winner-reason from parse_demo.rounds → analysis term.
# parse_demo currently stores raw strings from _WIN_REASONS; copy through verbatim.
def _slim_won_by(reason):
    return reason if isinstance(reason, str) else None


def _round_index_for_tick(rounds, tick):
    """Return the 0-based round idx whose [start, end] contains tick, else None.
    Linear scan is fine — typical demo has ≤30 rounds."""
    for i, r in enumerate(rounds):
        if r["start_tick"] <= tick <= r["end_tick"]:
            return i
    return None


def _team_at_tick(frames, steam_id, tick):
    """Best-effort lookup of a player's team at the given tick by scanning frames.
    Used to attribute grenade throws to a side. Returns 'ct'/'t'/None."""
    # Walk frames in order; the last frame at-or-before the target tick wins.
    last = None
    for f in frames:
        if f.get("tick", 0) > tick:
            break
        for p in f.get("players", []):
            if p.get("steam_id") == steam_id:
                last = p.get("team")
    return last


def build_slim_payload(parsed: dict) -> dict:
    """Derive the slim payload from a full parse_demo() result.

    Reductions vs full match_data:
      - frames keep only steam_id/team/x/y/alive/yaw per player
      - frames carry round_idx so the client can group without scanning rounds
      - grenades keep landing coords + sparse trajectory + throw metadata
      - kills, shots, bomb timeline, players_meta omitted (live on full match_data)
    """
    meta = parsed.get("meta", {}) or {}
    rounds_in  = parsed.get("rounds", []) or []
    frames_in  = parsed.get("frames", []) or []
    grenades_in = parsed.get("grenades", []) or []

    rounds_out = []
    for i, r in enumerate(rounds_in):
        rounds_out.append({
            "idx":               i,
            "side_team_a":       r.get("team_a_side"),
            "freeze_end_tick":   int(r.get("freeze_end_tick", r.get("start_tick", 0))),
            "end_tick":          int(r.get("end_tick", 0)),
            "winner":            r.get("winner_side"),
            "won_by":            _slim_won_by(r.get("reason")),
            "bomb_planted_site": r.get("bomb_planted_site"),
        })

    frames_out = []
    for f in frames_in:
        tick = int(f.get("tick", 0))
        ridx = _round_index_for_tick(rounds_in, tick)
        if ridx is None:
            continue  # drop frames that fall outside any round (warmup, between rounds)
        slim_players = []
        for p in f.get("players", []):
            slim_players.append({
                "steam_id": p.get("steam_id", ""),
                "team":     p.get("team"),
                "x":        p.get("x", 0),
                "y":        p.get("y", 0),
                "alive":    bool(p.get("is_alive", False)),
                "yaw":      p.get("yaw", 0),
            })
        frames_out.append({
            "tick":      tick,
            "round_idx": ridx,
            "players":   slim_players,
        })

    grenades_out = []
    for g in grenades_in:
        det_tick = int(g.get("tick", 0))
        ridx = _round_index_for_tick(rounds_in, det_tick)
        if ridx is None:
            continue
        throw_tick = int(g.get("origin_tick") or g.get("path_throw_tick") or det_tick)
        thrower_sid = g.get("steam_id") or ""
        grenades_out.append({
            "round_idx":     ridx,
            "type":          g.get("type", ""),
            "thrower_sid":   thrower_sid,
            "thrower_team":  _team_at_tick(frames_in, thrower_sid, throw_tick),
            "throw_tick":    throw_tick,
            "land_x":        int(g.get("x", 0)),
            "land_y":        int(g.get("y", 0)),
            "trajectory":    list(g.get("path") or []),
        })

    # Compact players_meta into name-only lookups so the analysis side panel
    # can render thrower names (full players_meta from parse_demo carries
    # weapon counts / per-round stats we don't need for analysis).
    players_meta_in = parsed.get("players_meta", {}) or {}
    players_out = {}
    for sid, pmeta in players_meta_in.items():
        name = (pmeta or {}).get("name") if isinstance(pmeta, dict) else None
        if name:
            players_out[sid] = {"name": name}

    return {
        "meta": {
            "map":       meta.get("map", ""),
            "tick_rate": int(meta.get("tick_rate", 64)),
            "players":   players_out,
        },
        "rounds":   rounds_out,
        "frames":   frames_out,
        "grenades": grenades_out,
    }
```

- [ ] **Step 4: Run tests until all pass**

```bash
python -m pytest tests/test_slim_payload.py -v
```

Expected: 8 passed.

If a test fails, fix the implementation — do not weaken the test. The most likely failure is the `bomb_planted_site` field missing on rounds because the existing parser doesn't currently emit it; that's intentional — Task 3 will not block on it (slim payload writes `None`), and a follow-up parser change can populate it. The test asserts only that *if present in the input*, it's preserved.

- [ ] **Step 5: Commit**

```bash
git add vps/demo_parser.py vps/tests/test_slim_payload.py
git commit -m "feat(vps): add build_slim_payload() pure function for analysis tool"
```

---

## Task 3: VPS — wire slim payload into the database write path

**Files:**
- Modify: `vps/main.py` (`_db_write_results` and its caller `_process_one`)

- [ ] **Step 1: Import `build_slim_payload`**

At the top of `vps/main.py`, find the existing import:
```python
from demo_parser import parse_demo
```
Replace with:
```python
from demo_parser import parse_demo, build_slim_payload
```

- [ ] **Step 2: Update `_db_write_results` signature and body**

Find the existing function (around line 197):
```python
def _db_write_results(demo_id, meta, ct_score, t_score, match_data, player_rows):
    print(f"[db] serializing match_data (frames={len(match_data.get('frames', []))}) ...")
    match_json = json.dumps(match_data)
    print(f"[db] match_data JSON size: {len(match_json) / 1024 / 1024:.1f} MB")
```

Replace with:
```python
def _db_write_results(demo_id, meta, ct_score, t_score, match_data, slim_data, player_rows):
    print(f"[db] serializing match_data (frames={len(match_data.get('frames', []))}) ...")
    match_json = json.dumps(match_data)
    slim_json  = json.dumps(slim_data)
    print(f"[db] match_data JSON size: {len(match_json) / 1024 / 1024:.1f} MB")
    print(f"[db] match_data_slim JSON size: {len(slim_json) / 1024 / 1024:.2f} MB")
```

Then update the SQL `UPDATE` statement inside the same function. Find:
```python
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
                     match_data = %s
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
                    demo_id,
                ),
```

Replace with:
```python
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
```

- [ ] **Step 3: Update the caller in `_process_one`**

Find the call site (around line 299):
```python
                    None, _db_write_results, demo_id, meta, ct_score, t_score, match_data, player_rows
```

A few lines above this call (after `parse_demo` returns), add the slim build. Find:
```python
        match_data = await loop.run_in_executor(None, parse_demo, tmp_path)

        meta     = match_data["meta"]
```

Insert one new line after the `parse_demo` call:
```python
        match_data = await loop.run_in_executor(None, parse_demo, tmp_path)
        slim_data  = build_slim_payload(match_data)

        meta     = match_data["meta"]
```

Then update the `_db_write_results` invocation. Find:
```python
                    None, _db_write_results, demo_id, meta, ct_score, t_score, match_data, player_rows
```

Replace with:
```python
                    None, _db_write_results, demo_id, meta, ct_score, t_score, match_data, slim_data, player_rows
```

- [ ] **Step 4: Verify by uploading a test demo**

Restart the VPS service:
```bash
sudo systemctl restart midround-demo-parser
sudo journalctl -u midround-demo-parser -f
```

Upload a demo via the existing demos.html flow. In the journal output, look for:
```
[db] match_data JSON size: 4.5 MB
[db] match_data_slim JSON size: 0.45 MB
```

Then in Supabase SQL editor:
```sql
select id, length(match_data::text) as full_len, length(match_data_slim::text) as slim_len
  from demos where id = '<the demo id you just uploaded>';
```

Expected: `slim_len` is ~10% of `full_len`.

- [ ] **Step 5: Commit**

```bash
git add vps/main.py
git commit -m "feat(vps): write match_data_slim alongside full match_data on parse"
```

---

## Task 4: VPS — backfill script for already-parsed demos

**Files:**
- Create: `vps/backfill_slim.py`

- [ ] **Step 1: Create the backfill script**

Create `vps/backfill_slim.py`:

```python
"""One-time backfill: populate match_data_slim for demos that were parsed
before Task 3 shipped.

Usage:
    cd vps && python backfill_slim.py [--dry-run] [--limit N]

Reads demos with status='ready' and match_data_slim IS NULL, computes the
slim payload from match_data, and writes it back. Idempotent — safe to re-run.
"""
import argparse
import json
import os
import sys

import psycopg2
from dotenv import load_dotenv

from demo_parser import build_slim_payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Compute but do not write")
    parser.add_argument("--limit", type=int, default=None, help="Process at most N demos")
    args = parser.parse_args()

    load_dotenv()
    conn = psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=10)
    conn.autocommit = False

    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '180s'")
        cur.execute(
            """select id from demos
                where status = 'ready'
                  and match_data_slim is null
                order by created_at desc
                limit %s""",
            (args.limit,) if args.limit else (None,),
        )
        ids = [row[0] for row in cur.fetchall()]

    print(f"[backfill] {len(ids)} demos to process")

    for i, demo_id in enumerate(ids, 1):
        try:
            with conn.cursor() as cur:
                cur.execute("select match_data from demos where id = %s", (demo_id,))
                row = cur.fetchone()
                if not row or not row[0]:
                    print(f"[backfill] {i}/{len(ids)} {demo_id}: no match_data, skip")
                    continue
                match_data = row[0]  # psycopg2 returns jsonb as dict

            slim = build_slim_payload(match_data)
            slim_json = json.dumps(slim)
            slim_mb = len(slim_json) / 1024 / 1024
            print(f"[backfill] {i}/{len(ids)} {demo_id}: slim={slim_mb:.2f} MB")

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
```

- [ ] **Step 2: Dry-run on the VPS**

```bash
cd /opt/midround/vps  # or wherever the deploy lives
python backfill_slim.py --dry-run --limit 3
```

Expected: prints "N demos to process" and 3 lines like `[backfill] 1/3 <uuid>: slim=0.45 MB`. No DB writes.

- [ ] **Step 3: Real backfill (no limit)**

```bash
python backfill_slim.py
```

Watch output. Each line should show ~0.3–0.8 MB slim sizes. On completion:

```sql
select count(*) from demos where status = 'ready' and match_data_slim is null;
```
Expected: 0 (or only failed ones, which the script logged).

- [ ] **Step 4: Commit**

```bash
git add vps/backfill_slim.py
git commit -m "feat(vps): one-time backfill script for match_data_slim"
```

---

## Task 5: Frontend — sidebar entry + analysis.html shell

**Files:**
- Modify: `cs2-hub/layout.js`
- Create: `cs2-hub/analysis.html`

- [ ] **Step 1: Add the Analysis sidebar entry**

In `cs2-hub/layout.js`, find the `ICONS` object (lines 4–18). Add a new icon entry after `demos`:

```js
  analysis:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/><circle cx="7" cy="14" r="1.4"/><circle cx="11" cy="10" r="1.4"/><circle cx="15" cy="14" r="1.4"/><circle cx="20" cy="9" r="1.4"/></svg>`,
```

Then in the `links` array (around line 35), insert a new entry after the `demos` entry:

```js
    { id: 'demos', label: 'Demos', href: 'demos.html', icon: ICONS.demos },
    { id: 'analysis', label: 'Analysis', href: 'analysis.html', icon: ICONS.analysis },
    { id: 'opponents',  label: 'Anti-Strat',        href: 'opponents.html',  icon: ICONS.opponents },
```

- [ ] **Step 2: Create `cs2-hub/analysis.html`**

Create the page shell. It must include the same boilerplate as other hub pages (sidebar mount, auth, base styles).

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Analysis — MIDROUND</title>
  <link rel="stylesheet" href="style.css">
  <style>
    /* ── Page shell ──────────────────────────────────────────── */
    .analysis-shell {
      display: flex; flex-direction: column;
      height: 100vh; box-sizing: border-box;
    }
    .analysis-header {
      flex-shrink: 0;
      display: flex; align-items: center; gap: 16px;
      padding: 12px 18px;
      background: rgba(3,7,18,0.92);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .analysis-title {
      font-size: 13px; color: var(--muted);
      text-transform: uppercase; letter-spacing: 0.12em;
    }
    .team-pick-wrap { flex: 0 0 280px; }
    .team-pick-input {
      width: 100%; box-sizing: border-box;
      padding: 7px 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 6px;
      color: #fff; font-size: 13px;
    }
    .mode-pills {
      display: flex; gap: 4px; margin-left: auto;
      background: rgba(255,255,255,0.04);
      padding: 3px; border-radius: 7px;
    }
    .mode-pill {
      padding: 5px 14px; font-size: 11px;
      color: var(--muted); cursor: pointer; border: none;
      background: transparent; border-radius: 5px;
      transition: background 0.12s, color 0.12s;
    }
    .mode-pill.active { background: rgba(102,102,183,0.18); color: #cfcff0; }

    /* ── Body: filters | canvas (| grenade panel) ────────────── */
    .analysis-body {
      flex: 1; min-height: 0;
      display: flex;
    }
    .filter-rail {
      flex: 0 0 200px;
      padding: 14px 12px; box-sizing: border-box;
      overflow-y: auto;
      background: rgba(3,7,18,0.78);
      border-right: 1px solid rgba(255,255,255,0.05);
    }
    .filter-rail .label {
      font-size: 9px; color: #555;
      text-transform: uppercase; letter-spacing: 0.1em;
      margin: 14px 0 5px;
    }
    .filter-rail .label:first-child { margin-top: 0; }
    .filter-rail select,
    .filter-rail input[type="date"] {
      width: 100%; box-sizing: border-box;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 5px;
      padding: 5px 7px; font-size: 12px;
      color: #ddd;
    }
    .seg-row { display: flex; gap: 3px; }
    .seg-btn {
      flex: 1; padding: 5px 0;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 4px;
      font-size: 10px; color: #888;
      cursor: pointer;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }
    .seg-btn.active {
      background: rgba(102,102,183,0.18);
      border-color: rgba(102,102,183,0.45);
      color: #cfcff0;
    }
    .filter-readout {
      margin-top: 18px; padding-top: 12px;
      border-top: 1px solid rgba(255,255,255,0.06);
      font-size: 11px; color: #888;
    }
    .filter-readout .num { color: #cfcff0; font-weight: 700; }
    .reset-filters-btn {
      margin-top: 10px;
      width: 100%; padding: 6px 0;
      background: transparent;
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 5px;
      color: #888; font-size: 10px;
      cursor: pointer;
    }
    .reset-filters-btn:hover { color: #cfcff0; border-color: rgba(102,102,183,0.45); }

    /* ── Canvas area ──────────────────────────────────────────── */
    .canvas-wrap {
      flex: 1; min-width: 0;
      position: relative; overflow: hidden;
      background: #030712;
    }
    #map-canvas {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      display: block;
    }
    .canvas-empty {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: #444; font-size: 14px;
      pointer-events: none;
    }
    .canvas-chips {
      position: absolute; top: 10px; left: 10px;
      display: flex; flex-direction: column; gap: 6px;
      z-index: 10; pointer-events: none;
    }
    .chip {
      padding: 4px 9px;
      background: rgba(0,0,0,0.55);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 4px;
      font-size: 10px; color: #cfcff0;
    }
    .chip.warn { color: #ffc56b; border-color: rgba(255,180,80,0.30); }
    .chip.error { color: #ff7676; border-color: rgba(255,100,100,0.30); }

    /* ── Bottom timeline (overlay only) ──────────────────────── */
    .analysis-bottom {
      flex-shrink: 0;
      display: flex; align-items: center; gap: 10px;
      padding: 8px 14px;
      background: rgba(3,7,18,0.95);
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .analysis-bottom.hidden { display: none; }
    .play-btn {
      width: 30px; height: 30px;
      background: rgba(102,102,183,0.20);
      border: 1px solid rgba(102,102,183,0.50);
      border-radius: 50%;
      color: #9999dd; font-size: 12px;
      cursor: pointer; padding: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .play-btn:hover { background: rgba(102,102,183,0.36); }
    .tl-track {
      flex: 1; position: relative; height: 26px; cursor: pointer;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 5px;
    }
    .tl-fill {
      position: absolute; left: 0; top: 0; bottom: 0;
      background: rgba(102,102,183,0.16);
      border-radius: 5px 0 0 5px;
      pointer-events: none;
    }
    .tl-thumb {
      position: absolute; top: 50%;
      transform: translate(-50%, -50%);
      width: 12px; height: 12px;
      background: #fff;
      border-radius: 50%;
      box-shadow: 0 0 0 3px rgba(102,102,183,0.4);
      pointer-events: none;
    }
    .tl-time {
      font-family: "SF Mono", "Consolas", monospace;
      font-size: 10px; color: #555;
      flex-shrink: 0;
    }
    .speed-buttons { display: flex; gap: 3px; flex-shrink: 0; }
    .speed-btn {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 4px;
      padding: 3px 8px; font-size: 10px;
      color: #666; cursor: pointer;
    }
    .speed-btn.active {
      background: rgba(102,102,183,0.16);
      border-color: rgba(102,102,183,0.50);
      color: #cfcff0;
    }
    .trail-toggle {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 4px;
      padding: 4px 10px; font-size: 10px;
      color: #666; cursor: pointer;
      flex-shrink: 0;
    }
    .trail-toggle.active { color: #cfcff0; border-color: rgba(102,102,183,0.50); }

    /* ── Grenade side panel ──────────────────────────────────── */
    .grenade-panel {
      flex: 0 0 280px;
      display: none; flex-direction: column;
      background: rgba(3,7,18,0.85);
      border-left: 1px solid rgba(255,255,255,0.06);
    }
    .grenade-panel.show { display: flex; }
    .gp-header {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .gp-count { font-size: 12px; font-weight: 700; color: #cfcff0; }
    .gp-controls {
      display: flex; gap: 6px; margin-top: 8px; align-items: center;
    }
    .gp-controls select {
      flex: 1;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 11px; color: #ddd;
    }
    .gp-list { flex: 1; overflow-y: auto; padding: 6px; }
    .gp-item {
      padding: 6px 8px; cursor: pointer;
      border-radius: 4px;
      font-size: 11px; color: #aaa;
      display: flex; align-items: center; gap: 8px;
    }
    .gp-item:hover { background: rgba(255,255,255,0.04); }
    .gp-item.active { background: rgba(102,102,183,0.16); color: #cfcff0; }
    .gp-item-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .gp-item-dot.smoke   { background: #b3b3b3; }
    .gp-item-dot.molotov { background: #ff7a30; }
    .gp-item-dot.flash   { background: #ffeb55; }
    .gp-item-dot.he      { background: #6cd070; }
  </style>
</head>
<body>
  <div id="sidebar" class="sidebar"></div>

  <main class="main-content">
    <div class="analysis-shell" id="analysis-shell">
      <header class="analysis-header">
        <span class="analysis-title">Analysis</span>
        <div class="team-pick-wrap">
          <input id="team-pick" class="team-pick-input" type="text" placeholder="Pick a team…" autocomplete="off">
        </div>
        <div class="mode-pills">
          <button class="mode-pill active" data-mode="overlay">Overlay</button>
          <button class="mode-pill"        data-mode="grenade">Grenade</button>
        </div>
      </header>

      <div class="analysis-body">
        <aside class="filter-rail" id="filter-rail">
          <!-- Filter UI populated by analysis.js once a team is picked -->
        </aside>

        <div class="canvas-wrap" id="canvas-wrap">
          <canvas id="map-canvas"></canvas>
          <div class="canvas-empty" id="canvas-empty">Pick a team to begin.</div>
          <div class="canvas-chips" id="canvas-chips"></div>
        </div>

        <aside class="grenade-panel" id="grenade-panel">
          <div class="gp-header">
            <div class="gp-count" id="gp-count">0 grenades</div>
            <div class="gp-controls">
              <select id="gp-type-filter">
                <option value="all">All types</option>
                <option value="smoke">Smoke</option>
                <option value="molotov">Molotov</option>
                <option value="flash">Flash</option>
                <option value="he">HE</option>
              </select>
              <select id="gp-sort">
                <option value="round">Sort: Round</option>
                <option value="type">Sort: Type</option>
                <option value="thrower">Sort: Thrower</option>
              </select>
            </div>
          </div>
          <div class="gp-list" id="gp-list"></div>
        </aside>
      </div>

      <div class="analysis-bottom hidden" id="analysis-bottom">
        <button class="play-btn" id="play-btn">▶</button>
        <span class="tl-time" id="tl-current">0:00</span>
        <div class="tl-track" id="tl-track">
          <div class="tl-fill" id="tl-fill"></div>
          <div class="tl-thumb" id="tl-thumb"></div>
        </div>
        <span class="tl-time" id="tl-end">0:00</span>
        <button class="trail-toggle" id="trail-toggle">Trails</button>
        <div class="speed-buttons">
          <button class="speed-btn" data-speed="0.5">½×</button>
          <button class="speed-btn active" data-speed="1">1×</button>
          <button class="speed-btn" data-speed="2">2×</button>
          <button class="speed-btn" data-speed="4">4×</button>
        </div>
      </div>
    </div>
  </main>

  <script type="module" src="analysis.js"></script>
</body>
</html>
```

- [ ] **Step 3: Verify the page loads (skeleton, no JS yet)**

Open `cs2-hub/analysis.html` in a browser. Expect: 404 on `analysis.js` in console (we haven't created it yet) and a blank dark layout with sidebar and the empty canvas message "Pick a team to begin."

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/layout.js cs2-hub/analysis.html
git commit -m "feat(hub): add Analysis sidebar entry and analysis.html shell"
```

---

## Task 6: Frontend — `analysis.js` skeleton with auth, sidebar, team picker

**Files:**
- Create: `cs2-hub/analysis.js`

- [ ] **Step 1: Create `analysis.js` with the auth/sidebar boilerplate and team-picker autocomplete**

Create `cs2-hub/analysis.js`:

```js
import { requireAuth }           from './auth.js'
import { renderSidebar }         from './layout.js'
import { supabase }              from './supabase.js'
import { attachTeamAutocomplete } from './team-autocomplete.js'

await requireAuth()
renderSidebar('analysis')

// ── State ────────────────────────────────────────────────────
const state = {
  team:        null,         // selected team name (string)
  mode:        'overlay',    // 'overlay' | 'grenade'
  filters: {
    map:        null,        // string
    side:       'ct',        // 'ct' | 't' | 'both'
    opponent:   'any',       // 'any' | string
    dateRange:  '30d',       // 'all' | '30d' | 'last10' | 'custom'
    outcome:    'all',       // 'all' | 'won' | 'lost'
    bombSite:   'all',       // 'all' | 'a' | 'b' | 'none'
  },
  corpus:      [],           // [{id, map, played_at, ct_team_name, t_team_name, ...}]
  slimCache:   new Map(),    // demoId → slim payload
  rounds:      [],           // computed RenderRound[] (built in Task 9)
}

// ── URL helpers ──────────────────────────────────────────────
function readUrl() {
  const p = new URLSearchParams(location.search)
  state.team        = p.get('team')                 || null
  state.mode        = p.get('mode')                 || 'overlay'
  state.filters.map      = p.get('map')             || null
  state.filters.side     = p.get('side')            || 'ct'
  state.filters.opponent = p.get('opponent')        || 'any'
  state.filters.dateRange = p.get('date')           || '30d'
  state.filters.outcome  = p.get('outcome')         || 'all'
  state.filters.bombSite = p.get('bomb')            || 'all'
}

function writeUrl() {
  const p = new URLSearchParams()
  if (state.team)              p.set('team',     state.team)
  if (state.mode !== 'overlay') p.set('mode',    state.mode)
  if (state.filters.map)        p.set('map',     state.filters.map)
  if (state.filters.side !== 'ct') p.set('side', state.filters.side)
  if (state.filters.opponent !== 'any') p.set('opponent', state.filters.opponent)
  if (state.filters.dateRange !== '30d') p.set('date',     state.filters.dateRange)
  if (state.filters.outcome !== 'all') p.set('outcome',   state.filters.outcome)
  if (state.filters.bombSite !== 'all') p.set('bomb',     state.filters.bombSite)
  const qs = p.toString()
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname)
}

// ── Team picker ──────────────────────────────────────────────
const teamInput = document.getElementById('team-pick')
attachTeamAutocomplete(teamInput, async team => {
  state.team = team.name
  teamInput.value = team.name
  // Reset map filter on team change — Task 11 will handle stale-filter cleanup
  state.filters.map = null
  writeUrl()
  await onTeamChanged()
})

// ── Boot ─────────────────────────────────────────────────────
readUrl()
if (state.team) {
  teamInput.value = state.team
  await onTeamChanged()
}

async function onTeamChanged() {
  // Stub — Task 7 fills this in.
  console.log('[analysis] team selected:', state.team)
}

// Export for tests (no-op in browser)
export { state, readUrl, writeUrl }
```

- [ ] **Step 2: Verify**

Open `analysis.html` in the browser. The team picker dropdown should now work (typing "Fa" should suggest FaZe etc., based on the existing `hltv-teams.json`). Selecting a team should log `[analysis] team selected: <name>` to console and set `?team=<name>` in the URL.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/analysis.js
git commit -m "feat(hub): analysis.js skeleton with team picker and URL state"
```

---

## Task 7: Frontend — corpus query + filter rail render

**Files:**
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Implement `loadCorpus()` and replace the `onTeamChanged` stub**

In `analysis.js`, replace the `onTeamChanged` stub with:

```js
async function loadCorpus(teamName) {
  const { data, error } = await supabase
    .from('demos')
    .select('id, map, played_at, ct_team_name, t_team_name, score_ct, score_t, team_a_first_side, team_a_score, team_b_score')
    .eq('status', 'ready')
    .or(`ct_team_name.eq.${teamName},t_team_name.eq.${teamName}`)
    .order('played_at', { ascending: false })

  if (error) {
    console.error('[analysis] corpus query failed:', error)
    return []
  }
  return data ?? []
}

async function onTeamChanged() {
  if (!state.team) return
  showChip('Loading corpus…', 'info')
  state.corpus = await loadCorpus(state.team)
  hideChip('Loading corpus…')
  renderFilterRail()
  // Round set built once filters apply — Task 9
  await reloadRoundSet()
}
```

- [ ] **Step 2: Add `showChip` / `hideChip` helpers**

Add near the top of `analysis.js`:

```js
const _chips = new Map()  // key → element

function showChip(text, kind = 'info') {
  const container = document.getElementById('canvas-chips')
  if (_chips.has(text)) return
  const el = document.createElement('div')
  el.className = `chip ${kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : ''}`
  el.textContent = text
  container.appendChild(el)
  _chips.set(text, el)
}

function hideChip(text) {
  const el = _chips.get(text)
  if (el) { el.remove(); _chips.delete(text) }
}

function setEmptyMessage(text) {
  const el = document.getElementById('canvas-empty')
  el.textContent = text
  el.style.display = text ? 'flex' : 'none'
}
```

- [ ] **Step 3: Add `renderFilterRail()`**

Add to `analysis.js`:

```js
function renderFilterRail() {
  const rail = document.getElementById('filter-rail')
  if (!state.team || !state.corpus.length) {
    rail.innerHTML = `<div class="label">Filters</div><div style="font-size:11px;color:#555">No demos for this team yet.</div>`
    setEmptyMessage(state.team ? 'No demos found for this team.' : 'Pick a team to begin.')
    return
  }
  setEmptyMessage('')

  // Derive filter options from the corpus
  const maps = [...new Set(state.corpus.map(d => d.map).filter(Boolean))].sort()
  const opps = [...new Set(state.corpus.flatMap(d => [d.ct_team_name, d.t_team_name])
                                       .filter(n => n && n !== state.team))].sort()

  // Default the map filter if nothing chosen yet
  if (!state.filters.map || !maps.includes(state.filters.map)) {
    state.filters.map = maps[0] ?? null
    writeUrl()
  }
  // Defensive: opponent fallback
  if (state.filters.opponent !== 'any' && !opps.includes(state.filters.opponent)) {
    state.filters.opponent = 'any'
    writeUrl()
  }

  rail.innerHTML = `
    <div class="label">Map</div>
    <select id="f-map">
      ${maps.map(m => `<option value="${m}" ${m === state.filters.map ? 'selected' : ''}>${mapShort(m)}</option>`).join('')}
    </select>

    <div class="label">Side</div>
    <div class="seg-row" id="f-side">
      <button class="seg-btn ${state.filters.side === 'ct' ? 'active' : ''}"   data-v="ct">CT</button>
      <button class="seg-btn ${state.filters.side === 't'  ? 'active' : ''}"   data-v="t">T</button>
      <button class="seg-btn ${state.filters.side === 'both' ? 'active' : ''}" data-v="both">Both</button>
    </div>

    <div class="label">Opponent</div>
    <select id="f-opp">
      <option value="any" ${state.filters.opponent === 'any' ? 'selected' : ''}>Any opponent</option>
      ${opps.map(o => `<option value="${o}" ${o === state.filters.opponent ? 'selected' : ''}>${o}</option>`).join('')}
    </select>

    <div class="label">Date</div>
    <select id="f-date">
      <option value="all"    ${state.filters.dateRange === 'all'    ? 'selected' : ''}>All time</option>
      <option value="30d"    ${state.filters.dateRange === '30d'    ? 'selected' : ''}>Last 30 days</option>
      <option value="last10" ${state.filters.dateRange === 'last10' ? 'selected' : ''}>Last 10 matches</option>
    </select>

    <div class="label">Outcome</div>
    <div class="seg-row" id="f-outcome">
      <button class="seg-btn ${state.filters.outcome === 'won'  ? 'active' : ''}" data-v="won">Won</button>
      <button class="seg-btn ${state.filters.outcome === 'lost' ? 'active' : ''}" data-v="lost">Lost</button>
      <button class="seg-btn ${state.filters.outcome === 'all'  ? 'active' : ''}" data-v="all">All</button>
    </div>

    <div class="label">Bomb plant</div>
    <div class="seg-row" id="f-bomb">
      <button class="seg-btn ${state.filters.bombSite === 'a'    ? 'active' : ''}" data-v="a">A</button>
      <button class="seg-btn ${state.filters.bombSite === 'b'    ? 'active' : ''}" data-v="b">B</button>
      <button class="seg-btn ${state.filters.bombSite === 'none' ? 'active' : ''}" data-v="none">None</button>
      <button class="seg-btn ${state.filters.bombSite === 'all'  ? 'active' : ''}" data-v="all">All</button>
    </div>

    <div class="filter-readout">
      <span class="num" id="f-rounds">0</span> rounds<br>
      from <span class="num" id="f-demos">0</span> demos
    </div>
    <button class="reset-filters-btn" id="f-reset">Reset filters</button>
  `

  // Wire change handlers
  rail.querySelector('#f-map').addEventListener('change', e => onFilter('map', e.target.value))
  rail.querySelector('#f-opp').addEventListener('change', e => onFilter('opponent', e.target.value))
  rail.querySelector('#f-date').addEventListener('change', e => onFilter('dateRange', e.target.value))
  for (const [groupId, key] of [['f-side','side'], ['f-outcome','outcome'], ['f-bomb','bombSite']]) {
    rail.querySelector('#' + groupId).addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn'); if (!btn) return
      onFilter(key, btn.dataset.v)
    })
  }
  rail.querySelector('#f-reset').addEventListener('click', () => {
    state.filters.side = 'ct'
    state.filters.opponent = 'any'
    state.filters.dateRange = '30d'
    state.filters.outcome = 'all'
    state.filters.bombSite = 'all'
    writeUrl()
    renderFilterRail()
    reloadRoundSet()
  })
}

function mapShort(m) {
  return (m || '').replace('de_', '').replace(/^./, c => c.toUpperCase())
}

function onFilter(key, value) {
  state.filters[key] = value
  writeUrl()
  renderFilterRail()  // re-render so segmented active state updates
  reloadRoundSet()
}

async function reloadRoundSet() {
  // Stub — Task 9 fills this in. For now just update the readout to a placeholder.
  const rEl = document.getElementById('f-rounds')
  const dEl = document.getElementById('f-demos')
  if (rEl) rEl.textContent = '…'
  if (dEl) dEl.textContent = String(state.corpus.length)
}
```

- [ ] **Step 4: Verify**

Open `analysis.html?team=<a real team in your DB>`. Expected:
- Filter rail populates with Map dropdown showing only maps that team has demos on.
- Opponent dropdown lists only teams that have actually played against the selected team.
- Clicking Side/Outcome/Bomb pills toggles their active state.
- The URL updates on each filter change.
- Readout shows `… rounds from N demos`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/analysis.js
git commit -m "feat(hub): analysis corpus query + filter rail UI"
```

---

## Task 8: Frontend — slim payload fetcher with LRU cache

**Files:**
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Add the fetcher and the LRU eviction**

Add to `analysis.js` (above `reloadRoundSet`):

```js
const SLIM_CACHE_MAX = 50

async function fetchSlimPayloads(demoIds) {
  // Split into already-cached vs needs-fetch
  const need = demoIds.filter(id => !state.slimCache.has(id))
  if (need.length) {
    showChip(`Loading ${need.length} demo${need.length === 1 ? '' : 's'}…`, 'info')
    const { data, error } = await supabase
      .from('demos')
      .select('id, match_data_slim, team_a_first_side')
      .in('id', need)
    hideChip(`Loading ${need.length} demo${need.length === 1 ? '' : 's'}…`)

    if (error) {
      showChip('Some demos failed to load', 'error')
      console.error('[analysis] slim fetch error:', error)
    } else {
      let skipped = 0
      for (const row of data ?? []) {
        if (!row.match_data_slim) { skipped++; continue }
        // Inject team_a_first_side into the slim payload so downstream code
        // doesn't need to keep a parallel lookup
        row.match_data_slim._team_a_first_side = row.team_a_first_side
        state.slimCache.set(row.id, row.match_data_slim)
      }
      if (skipped > 0) showChip(`${skipped} demo(s) skipped — pending re-parse`, 'warn')
    }
    // LRU eviction
    while (state.slimCache.size > SLIM_CACHE_MAX) {
      const oldestKey = state.slimCache.keys().next().value
      state.slimCache.delete(oldestKey)
    }
  }
  return demoIds.map(id => state.slimCache.get(id)).filter(Boolean)
}
```

- [ ] **Step 2: Verify with a console probe**

In the browser DevTools console on the analysis page (with a team selected), run:

```js
const { state } = await import('./analysis.js')
// Pick a real demo id from state.corpus
console.log(await window._fetchProbe?.(state.corpus.slice(0,2).map(d => d.id)))
```

Add at the bottom of `analysis.js` (temporarily for verification):

```js
window._fetchProbe = fetchSlimPayloads
```

Expected: returns an array of 1–2 slim payloads with `meta`, `rounds`, `frames`, `grenades`. After verification, **remove** the `window._fetchProbe` line.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/analysis.js
git commit -m "feat(hub): slim payload fetcher with LRU cache"
```

---

## Task 9: Frontend — `narrowRoundsForTeam` pure function with browser test

**Files:**
- Create: `cs2-hub/analysis-rounds.js`
- Create: `cs2-hub/analysis-rounds.test.html`
- Modify: `cs2-hub/analysis.js` (use the helper in `reloadRoundSet`)

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/analysis-rounds.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<h1>analysis-rounds tests</h1>
<pre id="out"></pre>
<script type="module">
import { narrowRoundsForTeam } from './analysis-rounds.js'

const out = document.getElementById('out')
let pass = 0, fail = 0
function assert(cond, msg) {
  const line = (cond ? '✓ ' : '✗ ') + msg
  out.textContent += line + '\n'
  if (cond) pass++; else fail++
}

// Two slim payloads representing two demos.
//
// Demo A: team "Alpha" was roster A, started CT. Two rounds.
//   - R0: team_a_side='ct'  (Alpha on CT)  winner='ct' (Alpha won, ct side)  bomb_planted_site=null
//   - R1: team_a_side='t'   (Alpha on T after halftime) winner='ct' (Alpha lost) bomb_planted_site='A'
// Demo B: team "Alpha" was roster B (i.e. team_a_first_side='t' meant the OTHER team started T,
//   so Alpha started CT — that's the same as demo A. Use a contrasting case:
//   _team_a_first_side='t' means roster A is the OTHER team and started T → Alpha = roster B started CT.
//   - R0: team_a_side='t' so roster B (Alpha) is CT; winner='t' (Alpha lost) bomb_planted_site='B'
const demoA = {
  meta: { map: 'de_mirage', tick_rate: 70 },
  _team_a_first_side: 'ct',
  rounds: [
    { idx: 0, side_team_a: 'ct', freeze_end_tick: 1000, end_tick: 5000, winner: 'ct', won_by: 't_eliminated', bomb_planted_site: null },
    { idx: 1, side_team_a: 't',  freeze_end_tick: 6000, end_tick: 10000, winner: 'ct', won_by: 'bomb_defused', bomb_planted_site: 'A' },
  ],
  frames: [], grenades: [],
}
// In Demo A, Alpha is roster A. Alpha-on-CT rounds = those where side_team_a='ct' → only R0.
// Alpha-on-T rounds = those where side_team_a='t' → only R1.

const demoB = {
  meta: { map: 'de_mirage', tick_rate: 70 },
  _team_a_first_side: 't',     // roster A started T → Alpha (roster B) started CT
  rounds: [
    { idx: 0, side_team_a: 't', freeze_end_tick: 1000, end_tick: 5000, winner: 't', won_by: 'bomb_exploded', bomb_planted_site: 'B' },
  ],
  frames: [], grenades: [],
}
// In Demo B, Alpha is roster B. Alpha-on-CT rounds = those where side_team_a='t' (B is opposite of A) → R0.
// In R0, winner='t' so Alpha (CT) lost.

// helper to bind team identity to a slim payload — analysis.js does this from
// the corpus row, and narrowRoundsForTeam expects payloads with these fields:
function bind(slim, isRosterA) {
  return Object.assign({ _is_roster_a: isRosterA, _demo_id: 'd' + Math.random() }, slim)
}

const pA = bind(demoA, true)   // Alpha = roster A in demo A
const pB = bind(demoB, false)  // Alpha = roster B in demo B
const payloads = [pA, pB]

// Test: side='ct' should return both demos' CT-side rounds (1 each)
let got = narrowRoundsForTeam(payloads, { side: 'ct', outcome: 'all', bombSite: 'all' })
assert(got.length === 2, `side=ct returns 2 rounds (got ${got.length})`)
assert(got.every(r => r.demoId), 'each result carries demoId')

// Test: side='t' returns only Demo A R1
got = narrowRoundsForTeam(payloads, { side: 't', outcome: 'all', bombSite: 'all' })
assert(got.length === 1 && got[0].roundIdx === 1, `side=t returns demoA R1 (got len=${got.length} idx=${got[0]?.roundIdx})`)

// Test: outcome='won' from CT side — Alpha won R0 in demoA (ct=Alpha won) but lost demoB R0 (t won)
got = narrowRoundsForTeam(payloads, { side: 'ct', outcome: 'won', bombSite: 'all' })
assert(got.length === 1, `side=ct + won returns 1 round (got ${got.length})`)

// Test: bombSite='B' from CT returns only demoB R0
got = narrowRoundsForTeam(payloads, { side: 'ct', outcome: 'all', bombSite: 'b' })
assert(got.length === 1, `side=ct + bombSite=b returns 1 round (got ${got.length})`)

// Test: bombSite='none' from CT returns only demoA R0 (no plant)
got = narrowRoundsForTeam(payloads, { side: 'ct', outcome: 'all', bombSite: 'none' })
assert(got.length === 1 && got[0].roundIdx === 0, `bombSite=none returns demoA R0 (len=${got.length})`)

// Test: side='both' returns all 3 rounds
got = narrowRoundsForTeam(payloads, { side: 'both', outcome: 'all', bombSite: 'all' })
assert(got.length === 3, `side=both returns 3 rounds (got ${got.length})`)

out.textContent += `\n${pass} passed, ${fail} failed`
</script>
</body>
</html>
```

- [ ] **Step 2: Open the test in a browser to verify it fails**

Open `cs2-hub/analysis-rounds.test.html`. Expected: console error "Failed to load module ./analysis-rounds.js" and `0 passed, 0 failed` (script never reached the assertions).

- [ ] **Step 3: Implement `narrowRoundsForTeam`**

Create `cs2-hub/analysis-rounds.js`:

```js
// Pure helpers for the analysis page. No DOM, no fetch — testable in isolation.
//
// A "slim payload" looks like:
//   { meta, rounds, frames, grenades, _team_a_first_side, _is_roster_a, _demo_id }
//
// `_is_roster_a` is set by analysis.js from the corpus row, comparing the
// selected team's name against ct_team_name + the team_a_first_side rule.
// Knowing whether the selected team is roster A or B lets us, for each round,
// derive which side (CT/T) the selected team played that round.

/** Returns 'ct' or 't': which side the selected team was on for the given round. */
export function teamSideForRound(payload, round) {
  const aSide = round.side_team_a       // side that roster A played this round
  if (!aSide) return null
  if (payload._is_roster_a) return aSide
  return aSide === 'ct' ? 't' : 'ct'
}

/** Filter a corpus of slim payloads down to a list of RenderRound objects. */
export function narrowRoundsForTeam(payloads, filters) {
  const out = []
  let hueIdx = 0
  for (const payload of payloads) {
    for (const round of payload.rounds) {
      const teamSide = teamSideForRound(payload, round)
      if (teamSide === null) continue

      // Side filter
      if (filters.side !== 'both' && teamSide !== filters.side) continue

      // Outcome filter — round.winner is the winning side ('ct'/'t')
      if (filters.outcome === 'won'  && round.winner !== teamSide) continue
      if (filters.outcome === 'lost' && round.winner === teamSide) continue

      // Bomb site filter
      if (filters.bombSite === 'a' && round.bomb_planted_site !== 'A') continue
      if (filters.bombSite === 'b' && round.bomb_planted_site !== 'B') continue
      if (filters.bombSite === 'none' && round.bomb_planted_site != null) continue

      out.push({
        demoId:         payload._demo_id,
        roundIdx:       round.idx,
        freezeEndTick:  round.freeze_end_tick,
        endTick:        round.end_tick,
        teamSide,
        hue:            (hueIdx++ * 137) % 360,   // golden-angle distribution
        // Frames + grenades referenced lazily — caller indexes into payload by roundIdx
        _payload:       payload,
      })
    }
  }
  return out
}

/** Return the subset of `frames` from the payload that belong to a round. */
export function framesForRound(payload, roundIdx) {
  return payload.frames.filter(f => f.round_idx === roundIdx)
}

/** Return the subset of `grenades` from the payload that belong to a round. */
export function grenadesForRound(payload, roundIdx) {
  return payload.grenades.filter(g => g.round_idx === roundIdx)
}
```

- [ ] **Step 4: Re-open the test page**

Refresh `cs2-hub/analysis-rounds.test.html`. Expected: `7 passed, 0 failed`. If a test fails, fix the implementation — do not weaken the test.

- [ ] **Step 5: Wire `reloadRoundSet` in `analysis.js` to use the helper**

In `cs2-hub/analysis.js`, add the import at the top:
```js
import { narrowRoundsForTeam, framesForRound, grenadesForRound } from './analysis-rounds.js'
```

Replace the stub `reloadRoundSet`:

```js
async function reloadRoundSet() {
  // 1. Apply demo-level filters in client (cheap, no fetch).
  let demos = state.corpus
  if (state.filters.map)  demos = demos.filter(d => d.map === state.filters.map)
  if (state.filters.opponent !== 'any') {
    demos = demos.filter(d =>
      (d.ct_team_name === state.filters.opponent && d.t_team_name === state.team) ||
      (d.t_team_name === state.filters.opponent && d.ct_team_name === state.team)
    )
  }
  if (state.filters.dateRange === '30d') {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000
    demos = demos.filter(d => d.played_at && new Date(d.played_at).getTime() >= cutoff)
  } else if (state.filters.dateRange === 'last10') {
    demos = demos.slice(0, 10)
  }

  if (!demos.length) {
    state.rounds = []
    updateReadout(0, 0)
    setEmptyMessage('0 rounds match — try widening filters.')
    requestRender()
    return
  }

  // 2. Fetch slim payloads — populates state.slimCache. Awaiting only ensures
  //    the cache is filled; we look up by demo.id below to keep id↔payload
  //    pairing unambiguous (avoids index-drift if any payload was skipped).
  await fetchSlimPayloads(demos.map(d => d.id))

  // 3. Bind team identity to each payload (roster A vs B for the selected team).
  const teamName = state.team
  const enriched = []
  for (const demo of demos) {
    const slim = state.slimCache.get(demo.id)
    if (!slim) continue   // skipped (null match_data_slim) — already chip-warned
    // Roster A = team that started on the side recorded in team_a_first_side.
    // Match the selected team's name to either ct_team_name or t_team_name to
    // determine whether it was roster A in this demo.
    const aFirstSide = slim._team_a_first_side
    let isRosterA = false
    if (aFirstSide === 'ct')      isRosterA = (demo.ct_team_name === teamName)
    else if (aFirstSide === 't')  isRosterA = (demo.t_team_name === teamName)
    else                          isRosterA = (demo.ct_team_name === teamName)  // legacy fallback

    enriched.push(Object.assign({ _is_roster_a: isRosterA, _demo_id: demo.id }, slim))
  }

  // 4. Narrow rounds.
  state.rounds = narrowRoundsForTeam(enriched, state.filters)

  updateReadout(state.rounds.length, demos.length)
  setEmptyMessage(state.rounds.length === 0 ? '0 rounds match — try widening filters.' : '')
  requestRender()
}

function updateReadout(rounds, demos) {
  const r = document.getElementById('f-rounds')
  const d = document.getElementById('f-demos')
  if (r) r.textContent = String(rounds)
  if (d) d.textContent = String(demos)
}

function requestRender() {
  // Stub — Task 10 fills in actual canvas rendering.
}
```

- [ ] **Step 6: Verify**

Open `analysis.html?team=<team>`. Pick a map. The readout should show a real "N rounds from M demos" count. Toggle Side / Outcome and watch the round count change. The browser test page (`analysis-rounds.test.html`) should still pass.

- [ ] **Step 7: Commit**

```bash
git add cs2-hub/analysis-rounds.js cs2-hub/analysis-rounds.test.html cs2-hub/analysis.js
git commit -m "feat(hub): narrowRoundsForTeam pure helper with browser test"
```

---

## Task 10: Frontend — canvas base + map render

**Files:**
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Add canvas setup, map loader, and the letterboxed render base**

Add to `analysis.js` (after the existing helpers, before `requestRender`):

```js
import { worldToCanvas } from './demo-map-data.js'

const canvas = document.getElementById('map-canvas')
const ctx    = canvas.getContext('2d')
const wrap   = document.getElementById('canvas-wrap')

let mapImg     = null
let mapLoaded  = false
let _renderQueued = false

function loadMapImage(mapName) {
  mapImg = new Image()
  mapLoaded = false
  mapImg.src = `images/maps/${mapName}_viewer.png`
  mapImg.onload  = () => { mapLoaded = true; requestRender() }
  mapImg.onerror = () => {
    mapImg.src = `images/maps/${mapName}_radar.png`
    mapImg.onload  = () => { mapLoaded = true; requestRender() }
    mapImg.onerror = () => { mapLoaded = true; requestRender() }
  }
}

function resizeCanvas() {
  const { width, height } = wrap.getBoundingClientRect()
  if (width < 10 || height < 10) return
  canvas.width  = Math.round(width)
  canvas.height = Math.round(height)
}
new ResizeObserver(() => { resizeCanvas(); requestRender() }).observe(wrap)
resizeCanvas()
```

- [ ] **Step 2: Replace the `requestRender` stub with an rAF-coalesced render**

Replace the existing stub with:

```js
function requestRender() {
  if (_renderQueued) return
  _renderQueued = true
  requestAnimationFrame(() => {
    _renderQueued = false
    render()
  })
}

function render() {
  const cw = canvas.width
  const ch = canvas.height
  ctx.clearRect(0, 0, cw, ch)
  ctx.fillStyle = '#030712'
  ctx.fillRect(0, 0, cw, ch)

  // Letterbox: square map region, centered
  const mapSize = Math.min(cw, ch)
  const mapX    = Math.round((cw - mapSize) / 2)
  const mapY    = Math.round((ch - mapSize) / 2)

  if (mapLoaded && mapImg.complete && mapImg.naturalWidth) {
    ctx.drawImage(mapImg, mapX, mapY, mapSize, mapSize)
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.fillRect(mapX, mapY, mapSize, mapSize)
  } else {
    ctx.fillStyle = '#0d1117'
    ctx.fillRect(mapX, mapY, mapSize, mapSize)
  }

  const tc = (wx, wy) => {
    const { x, y } = worldToCanvas(wx, wy, state.filters.map, mapSize, mapSize)
    return { x: x + mapX, y: y + mapY }
  }

  // Mode dispatch (Task 11/13 fill these in)
  if (state.mode === 'overlay') renderOverlay(tc, mapSize)
  else if (state.mode === 'grenade') renderGrenadeMode(tc, mapSize)
}

// Stubs — Tasks 11 (overlay) and 13 (grenade) fill them in
function renderOverlay(tc, mapSize) {}
function renderGrenadeMode(tc, mapSize) {}
```

- [ ] **Step 3: Trigger a map load whenever the Map filter changes**

In the existing `onFilter` function in `analysis.js`, after the existing body, add a map-load trigger. Find:

```js
function onFilter(key, value) {
  state.filters[key] = value
  writeUrl()
  renderFilterRail()  // re-render so segmented active state updates
  reloadRoundSet()
}
```

Replace with:

```js
function onFilter(key, value) {
  const prevMap = state.filters.map
  state.filters[key] = value
  writeUrl()
  renderFilterRail()
  if (key === 'map' && value !== prevMap) loadMapImage(value)
  reloadRoundSet()
}
```

Also call `loadMapImage` once on team change (after the corpus loads). In `onTeamChanged`, after `renderFilterRail()`:

```js
  if (state.filters.map) loadMapImage(state.filters.map)
```

- [ ] **Step 4: Verify**

Reload the page with a team + map selected. The map image should load and fill the canvas, letterboxed (dark bands left/right on a wide window). Resize the window — the canvas should re-render at the new size.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/analysis.js
git commit -m "feat(hub): canvas + letterboxed map render base"
```

---

## Task 11: Frontend — overlay mode rendering + animation loop

**Files:**
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Add playback state + animation loop**

Add to `analysis.js` (above `render` — `framesForRound` was already imported in Task 9 step 5, so no new import is needed):

```js
const playback = {
  playing:  false,
  speed:    1,
  relTick:  0,        // round-relative tick (0 = freeze end)
  maxTick:  0,        // longest matched round duration
  lastTs:   0,
  showTrails: false,
}

function recomputePlaybackBounds() {
  let max = 0
  for (const r of state.rounds) {
    const span = r.endTick - r.freezeEndTick
    if (span > max) max = span
  }
  playback.maxTick = max
  if (playback.relTick > max) playback.relTick = 0
}

function loop(ts) {
  if (playback.playing) {
    if (!playback.lastTs) playback.lastTs = ts
    const dt = (ts - playback.lastTs) / 1000
    playback.lastTs = ts
    const tickRate = state.rounds[0]?._payload?.meta?.tick_rate ?? 64
    playback.relTick += dt * tickRate * playback.speed
    if (playback.relTick > playback.maxTick) {
      playback.relTick = 0  // loop
    }
    updateTimelineUi()
    render()
  } else {
    playback.lastTs = 0
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
```

- [ ] **Step 2: Wire play/pause, scrub, and speed buttons**

Add at the bottom of `analysis.js`:

```js
function updateTimelineUi() {
  const fillEl  = document.getElementById('tl-fill')
  const thumbEl = document.getElementById('tl-thumb')
  const curEl   = document.getElementById('tl-current')
  const endEl   = document.getElementById('tl-end')
  const tr      = state.rounds[0]?._payload?.meta?.tick_rate ?? 64

  const pct = playback.maxTick > 0 ? (playback.relTick / playback.maxTick) * 100 : 0
  fillEl.style.width  = pct + '%'
  thumbEl.style.left  = pct + '%'

  const fmt = secs => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`
  curEl.textContent = fmt(playback.relTick / tr)
  endEl.textContent = fmt(playback.maxTick / tr)
}

document.getElementById('play-btn').addEventListener('click', () => {
  playback.playing = !playback.playing
  document.getElementById('play-btn').textContent = playback.playing ? '❚❚' : '▶'
})

document.getElementById('tl-track').addEventListener('click', e => {
  const rect = e.currentTarget.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  playback.relTick = pct * playback.maxTick
  updateTimelineUi()
  render()
})

for (const btn of document.querySelectorAll('.speed-btn')) {
  btn.addEventListener('click', () => {
    playback.speed = parseFloat(btn.dataset.speed)
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', b === btn))
  })
}

document.getElementById('trail-toggle').addEventListener('click', e => {
  playback.showTrails = !playback.showTrails
  e.currentTarget.classList.toggle('active', playback.showTrails)
  render()
})
```

- [ ] **Step 3: Implement `renderOverlay`**

Replace the empty `renderOverlay` stub in `analysis.js`:

```js
function renderOverlay(tc, mapSize) {
  if (!state.rounds.length) return

  const dotR = Math.max(2, Math.round(mapSize * 0.0035))

  for (const r of state.rounds) {
    const targetTick = r.freezeEndTick + Math.floor(playback.relTick)
    if (targetTick > r.endTick) continue   // round ended already
    const frames = framesForRound(r._payload, r.roundIdx)
    if (!frames.length) continue

    // Find the nearest frame at-or-before targetTick (binary search)
    let lo = 0, hi = frames.length - 1, idx = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (frames[mid].tick <= targetTick) { idx = mid; lo = mid + 1 } else hi = mid - 1
    }
    const frame = frames[idx]

    const color = `hsl(${r.hue}, 75%, 60%)`

    // Trails (off by default)
    if (playback.showTrails) {
      const trailFrames = 30
      const trailStart  = Math.max(0, idx - trailFrames)
      ctx.lineWidth = 1.2
      for (const player of frame.players) {
        if (!player.alive) continue
        ctx.beginPath()
        let started = false
        for (let i = trailStart; i <= idx; i++) {
          const pf = frames[i]
          const pp = pf.players.find(p => p.steam_id === player.steam_id)
          if (!pp || !pp.alive) { started = false; continue }
          const { x, y } = tc(pp.x, pp.y)
          if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
        }
        const fade = Math.max(0.05, 0.25)
        ctx.strokeStyle = `hsla(${r.hue}, 75%, 60%, ${fade})`
        ctx.stroke()
      }
    }

    // Player dots
    ctx.fillStyle = color
    ctx.globalAlpha = 0.35
    for (const player of frame.players) {
      if (!player.alive) continue
      const { x, y } = tc(player.x, player.y)
      ctx.beginPath()
      ctx.arc(x, y, dotR, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1.0
  }
}
```

- [ ] **Step 4: Recompute bounds + show timeline whenever the round set changes**

In `reloadRoundSet`, after `state.rounds = narrowRoundsForTeam(...)`, add:

```js
  recomputePlaybackBounds()
  updateTimelineUi()
```

- [ ] **Step 5: Verify**

Open `analysis.html?team=<team>` with a map selected. Filter to side=CT. Press the play button. Expected: hued dots animate across the map at the correct positions. Scrubbing the timeline jumps all rounds. Speed buttons change playback speed. Toggle Trails — fading lines should appear behind players.

If positions look wildly off, check that `state.filters.map` is being passed to `worldToCanvas` (it should be set before `loadMapImage` is called).

- [ ] **Step 6: Commit**

```bash
git add cs2-hub/analysis.js
git commit -m "feat(hub): overlay mode — animation, hued rounds, scrub, speeds, trails"
```

---

## Task 12: Frontend — mode toggle pills + show/hide bottom bar

**Files:**
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Wire the mode pills and the bottom-bar visibility**

Add to `analysis.js`:

```js
function applyMode() {
  for (const pill of document.querySelectorAll('.mode-pill')) {
    pill.classList.toggle('active', pill.dataset.mode === state.mode)
  }
  document.getElementById('analysis-bottom').classList.toggle('hidden', state.mode !== 'overlay')
  document.getElementById('grenade-panel').classList.toggle('show',     state.mode === 'grenade')
  if (state.mode !== 'overlay') {
    playback.playing = false
    document.getElementById('play-btn').textContent = '▶'
  }
  if (state.mode === 'grenade') refreshGrenadePanel()  // Task 14
  render()
}

for (const pill of document.querySelectorAll('.mode-pill')) {
  pill.addEventListener('click', () => {
    state.mode = pill.dataset.mode
    writeUrl()
    applyMode()
  })
}
applyMode()  // initial sync from URL
```

- [ ] **Step 2: Add a stub for `refreshGrenadePanel`** (Task 14 fills it in)

```js
function refreshGrenadePanel() {}
```

- [ ] **Step 3: Verify**

Click the Grenade pill. The bottom timeline should hide and the right-side grenade panel should appear (empty for now). Click Overlay. Bottom bar reappears, right panel hides. The URL toggles `?mode=grenade`.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/analysis.js
git commit -m "feat(hub): mode toggle pills (overlay/grenade) with bottom-bar + side-panel sync"
```

---

## Task 13: Frontend — grenade mode map render

**Files:**
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Implement `renderGrenadeMode`**

Add to `analysis.js`:

```js
const GREN_COLORS = {
  smoke:   { fill: 'rgba(180,180,180,0.55)', stroke: 'rgba(220,220,220,0.85)' },
  molotov: { fill: 'rgba(255,122,48,0.65)',  stroke: 'rgba(255,170,90,0.95)'  },
  flash:   { fill: 'rgba(255,235,85,0.65)',  stroke: 'rgba(255,245,140,0.95)' },
  he:      { fill: 'rgba(108,208,112,0.55)', stroke: 'rgba(150,230,150,0.95)' },
}
const GREN_RADII = { smoke: 0.024, molotov: 0.014, flash: 0.012, he: 0.012 }

let _highlightedGrenadeKey = null  // demoId|roundIdx|throw_tick — used for click highlight
```

Then replace the `renderGrenadeMode` stub:

```js
function renderGrenadeMode(tc, mapSize) {
  if (!state.rounds.length) return

  const typeFilter = document.getElementById('gp-type-filter')?.value ?? 'all'

  for (const r of state.rounds) {
    const grenades = grenadesForRound(r._payload, r.roundIdx)
    for (const g of grenades) {
      if (typeFilter !== 'all' && g.type !== typeFilter) continue

      const colors = GREN_COLORS[g.type] || GREN_COLORS.smoke
      const radius = (GREN_RADII[g.type] || 0.012) * mapSize
      const { x, y } = tc(g.land_x, g.land_y)
      const key = `${r.demoId}|${r.roundIdx}|${g.throw_tick}`
      const dimmed = _highlightedGrenadeKey && _highlightedGrenadeKey !== key

      ctx.globalAlpha = dimmed ? 0.20 : 1.0

      ctx.fillStyle   = colors.fill
      ctx.strokeStyle = colors.stroke
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()

      if (_highlightedGrenadeKey === key) {
        ctx.beginPath()
        ctx.arc(x, y, radius + 4, 0, Math.PI * 2)
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
  }
  ctx.globalAlpha = 1.0
}
```

- [ ] **Step 2: Verify**

Switch to Grenade mode on a team/map with grenade data. Map should show colored landing dots — grey for smokes, orange for molotovs, yellow for flashes, green for HE. The right-side panel is still empty (Task 14 fills it in).

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/analysis.js
git commit -m "feat(hub): grenade mode map render — colored landings by type"
```

---

## Task 14: Frontend — grenade side panel (list, sort, click highlight)

**Files:**
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Implement `refreshGrenadePanel`**

Replace the stub `refreshGrenadePanel`:

```js
function refreshGrenadePanel() {
  const listEl  = document.getElementById('gp-list')
  const countEl = document.getElementById('gp-count')
  const typeFilter = document.getElementById('gp-type-filter').value
  const sortBy     = document.getElementById('gp-sort').value

  const items = []
  for (const r of state.rounds) {
    const grenades = grenadesForRound(r._payload, r.roundIdx)
    // slim payload carries meta.players = { sid: { name } } (Task 2 / build_slim_payload)
    const playersMeta = r._payload.meta?.players || {}
    for (const g of grenades) {
      if (typeFilter !== 'all' && g.type !== typeFilter) continue
      items.push({
        key:         `${r.demoId}|${r.roundIdx}|${g.throw_tick}`,
        type:        g.type,
        round:       r.roundIdx + 1,
        thrower:     playersMeta[g.thrower_sid]?.name || g.thrower_sid?.slice(-5) || '?',
        thrower_team: g.thrower_team,
        throw_tick:  g.throw_tick,
        round_ref:   r,
      })
    }
  }

  items.sort((a, b) => {
    if (sortBy === 'type')    return a.type.localeCompare(b.type) || a.round - b.round
    if (sortBy === 'thrower') return a.thrower.localeCompare(b.thrower)
    return a.round - b.round || a.throw_tick - b.throw_tick
  })

  countEl.textContent = `${items.length} grenade${items.length === 1 ? '' : 's'}`

  listEl.innerHTML = items.map(it => `
    <div class="gp-item ${_highlightedGrenadeKey === it.key ? 'active' : ''}" data-key="${it.key}">
      <div class="gp-item-dot ${it.type}"></div>
      <div>
        <div>${it.type.toUpperCase()} · R${it.round} · ${escapeHtml(it.thrower)}</div>
      </div>
    </div>
  `).join('')

  for (const el of listEl.querySelectorAll('.gp-item')) {
    el.addEventListener('click', () => {
      _highlightedGrenadeKey = (_highlightedGrenadeKey === el.dataset.key) ? null : el.dataset.key
      refreshGrenadePanel()
      render()
    })
  }
}

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML
}

document.getElementById('gp-type-filter').addEventListener('change', () => { refreshGrenadePanel(); render() })
document.getElementById('gp-sort').addEventListener('change', refreshGrenadePanel)
```

- [ ] **Step 2: Refresh the panel after the round set changes**

In `reloadRoundSet`, at the end (after `requestRender()`), add:

```js
  if (state.mode === 'grenade') refreshGrenadePanel()
```

- [ ] **Step 3: Verify**

In Grenade mode, the right panel should list every grenade. Click a row — the corresponding landing on the map should be highlighted (white outline + others dimmed). Clicking the row again removes the highlight. Switching the type filter (All / Smoke / Moly / Flash / HE) restricts both the map and the list. Sort dropdown reorders the list.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/analysis.js
git commit -m "feat(hub): grenade side panel — list, sort, type filter, click highlight"
```

---

## Task 15: Frontend — final polish, error handling, manual verification

**Files:**
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Robustness — guard `loadCorpus` against network failures**

Replace the existing `loadCorpus` body:

```js
async function loadCorpus(teamName) {
  try {
    const { data, error } = await supabase
      .from('demos')
      .select('id, map, played_at, ct_team_name, t_team_name, score_ct, score_t, team_a_first_side, team_a_score, team_b_score')
      .eq('status', 'ready')
      .or(`ct_team_name.eq.${teamName},t_team_name.eq.${teamName}`)
      .order('played_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } catch (e) {
    console.error('[analysis] corpus load failed:', e)
    showChip('Failed to load corpus — check network', 'error')
    return []
  }
}
```

- [ ] **Step 2: Defensive — skip rounds with bad coords**

In `renderOverlay`, wrap the `tc()` call to drop NaN/out-of-bounds. Find:
```js
      const { x, y } = tc(player.x, player.y)
      ctx.beginPath()
      ctx.arc(x, y, dotR, 0, Math.PI * 2)
      ctx.fill()
```
Replace with:
```js
      const { x, y } = tc(player.x, player.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      ctx.beginPath()
      ctx.arc(x, y, dotR, 0, Math.PI * 2)
      ctx.fill()
```

In `renderGrenadeMode`, apply the same guard. Find:
```js
      const { x, y } = tc(g.land_x, g.land_y)
      const key = `${r.demoId}|${r.roundIdx}|${g.throw_tick}`
      const dimmed = _highlightedGrenadeKey && _highlightedGrenadeKey !== key

      ctx.globalAlpha = dimmed ? 0.20 : 1.0
```
Replace with:
```js
      const { x, y } = tc(g.land_x, g.land_y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const key = `${r.demoId}|${r.roundIdx}|${g.throw_tick}`
      const dimmed = _highlightedGrenadeKey && _highlightedGrenadeKey !== key

      ctx.globalAlpha = dimmed ? 0.20 : 1.0
```

- [ ] **Step 3: Soft warning when corpus is large**

In `reloadRoundSet`, after the demo-level filter narrows to a list `demos`, add:

```js
  if (demos.length > 15) showChip(`Loading ${demos.length} demos — this may take a moment…`, 'warn')
  else                    hideChip(`Loading ${demos.length} demos — this may take a moment…`)
```

- [ ] **Step 4: Manual verification checklist**

Walk through each of the following on the running app. Tick each off only after observing the expected behavior.

- [ ] **A. Team selection persistence:** Pick FaZe → URL gains `?team=FaZe`. Refresh page. Team is still FaZe; corpus reloads.
- [ ] **B. Filter persistence:** Set Map=Mirage, Side=T, Outcome=Won. Refresh. All three filters are restored.
- [ ] **C. Corpus narrows on filters:** Pick a team where you know the demo counts. Filter to a specific opponent. Confirm the readout's demo count matches what you expect.
- [ ] **D. Side mapping correctness:** Pick a team that played both sides in a single demo (any normal MR12 match). Toggle Side=CT vs Side=T. The round count should change and roughly halve, not show identical numbers.
- [ ] **E. Overlay animation:** Press play. Dots animate. Each round has a distinct color. Scrub timeline — all rounds jump together.
- [ ] **F. Trails:** Toggle on. Faint lines trace recent player movement. Toggle off. Lines disappear.
- [ ] **G. Speed:** ½× / 1× / 2× / 4× — each visibly changes animation speed.
- [ ] **H. Mode switch:** Click Grenade. Bottom bar disappears. Right panel appears. Map shows grenade landings. Switch back. Animation resumes from where it was paused.
- [ ] **I. Grenade highlight:** Click a grenade in the right panel. Map highlights that landing; others dim. Click again to clear.
- [ ] **J. Type filter:** In Grenade mode, set type filter to Smoke. Both the map and list show only smokes.
- [ ] **K. Empty state:** Set filters such that 0 rounds match (e.g., side=CT + outcome=lost + a single-demo corpus where you won every CT round). Canvas shows "0 rounds match — try widening filters."
- [ ] **L. Skipped chip:** If the team has any demo whose `match_data_slim` is null (i.e. backfill did not run), the warning chip "N demo(s) skipped — pending re-parse" should appear.
- [ ] **M. Resize:** Resize the browser window. Map stays centered, players stay aligned with map features.

- [ ] **Step 5: Final commit**

```bash
git add cs2-hub/analysis.js
git commit -m "feat(hub): analysis page polish — error handling, soft warning, defensive guards"
```

---

## Done

After Task 15 passes verification, the multi-round analysis tool is shippable. Follow-up specs (deferred from the original brainstorm) cover heatmap mode, grenade pattern search, public HLTV pipeline, and the richer filter set (economy, situations, etc.).
