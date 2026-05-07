# Demo Stats — Ship 1 Implementation Plan (per-demo scoreboard)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Scoreboard" tab to the demo viewer showing HLTV-style per-player and per-team stats (split All/CT/T) for every uploaded demo.

**Architecture:** Stats computed at parse-time on the VPS worker, written to two tables (`demo_players`, `demo_team_stats`), read by a new browser module. No client-side recomputation. Backfill via full reparse.

**Tech Stack:** Python 3 (demoparser2 + pytest) for the VPS parser; Supabase Postgres (DDL + RLS) for storage; vanilla ES modules + supabase-js for the browser.

**Spec:** `docs/superpowers/specs/2026-05-07-demo-stats-design.md`

---

## File Structure

**New files:**
- `cs2-hub/supabase-stats-migration.sql` — DDL applied once on Supabase.
- `cs2-hub/scoreboard.js` — browser module that loads + renders scoreboard.
- `vps/tests/test_stats.py` — pytest unit tests for stat helpers and compute functions.

**Modified files:**
- `vps/demo_parser.py` — extend `kills` event capture (assister + damage), add `damage_events` capture, add stat helpers, add `compute_player_stats` and `compute_team_stats`.
- `vps/main.py` — call new compute functions, write rows to `demo_players` + `demo_team_stats` after `parse_demo` succeeds.
- `cs2-hub/analysis.html` — add Playback/Scoreboard tab strip.
- `cs2-hub/analysis.js` — wire tab switching, mount scoreboard module.
- `cs2-hub/style.css` — scoreboard tab + table + tile grid styles.

---

## Task 1: Write schema migration

**Files:**
- Create: `cs2-hub/supabase-stats-migration.sql`

- [ ] **Step 1: Write the migration SQL**

Create `cs2-hub/supabase-stats-migration.sql` with:

```sql
-- Ship 1: per-demo scoreboard schema
-- Idempotent: safe to re-run.

-- 1. Relax demo_players.side check to allow 'all'
alter table demo_players drop constraint if exists demo_players_side_check;
alter table demo_players add constraint demo_players_side_check
  check (side in ('all','ct','t'));

-- 2. Add new stat columns to demo_players (if not present)
alter table demo_players add column if not exists team            text;
alter table demo_players add constraint demo_players_team_check
  check (team is null or team in ('a','b'));
alter table demo_players add column if not exists hs_pct          float;
alter table demo_players add column if not exists kast_pct        float;
alter table demo_players add column if not exists multi_2k        int;
alter table demo_players add column if not exists multi_3k        int;
alter table demo_players add column if not exists multi_4k        int;
alter table demo_players add column if not exists multi_5k        int;
alter table demo_players add column if not exists opening_kills   int;
alter table demo_players add column if not exists opening_deaths  int;
alter table demo_players add column if not exists clutches_won    int;
alter table demo_players add column if not exists clutches_lost   int;
alter table demo_players add column if not exists utility_dmg     int;
alter table demo_players add column if not exists flash_assists   int;
alter table demo_players add column if not exists traded_deaths   int;
alter table demo_players add column if not exists impact_rating   float;
alter table demo_players add column if not exists rounds_played   int;

-- 3. Truncate any pre-existing demo_players rows (Ship 1 fully replaces stats)
truncate table demo_players;

-- 4. Unique row per (demo, player, side)
create unique index if not exists demo_players_unique_side
  on demo_players (demo_id, steam_id, side);

-- 5. Create demo_team_stats
create table if not exists demo_team_stats (
  id uuid primary key default gen_random_uuid(),
  demo_id uuid not null references demos(id) on delete cascade,
  team text not null check (team in ('a','b')),

  pistol_wins         int, pistol_played       int,
  five_v_four_wins    int, five_v_four_played  int,
  five_v_four_t_wins  int, five_v_four_t_played  int,
  five_v_four_ct_wins int, five_v_four_ct_played int,

  first_kills         int, first_deaths        int,
  first_kills_t       int, first_kills_ct      int,
  first_deaths_t      int, first_deaths_ct     int,

  eco_wins       int, eco_played       int,
  force_wins     int, force_played     int,
  full_buy_wins  int, full_buy_played  int,

  bomb_plants    int, bomb_defuses     int,

  ct_round_wins  int, ct_rounds_played int,
  t_round_wins   int, t_rounds_played  int,

  unique (demo_id, team)
);

alter table demo_team_stats enable row level security;

drop policy if exists "team stats follow demo" on demo_team_stats;
create policy "team stats follow demo"
  on demo_team_stats for select
  using (exists (
    select 1 from demos d
    where d.id = demo_id and d.uploaded_by = auth.uid()
  ));
```

- [ ] **Step 2: Apply the migration on Supabase**

Open Supabase SQL editor → paste the file contents → Run.
Expected: no errors, all `alter` and `create` statements succeed.

- [ ] **Step 3: Verify schema**

In Supabase SQL editor, run:

```sql
select column_name from information_schema.columns
where table_name = 'demo_players' order by ordinal_position;
```

Expected: includes `team`, `hs_pct`, `kast_pct`, `multi_2k`, `multi_3k`, `multi_4k`, `multi_5k`, `opening_kills`, `opening_deaths`, `clutches_won`, `clutches_lost`, `utility_dmg`, `flash_assists`, `traded_deaths`, `impact_rating`, `rounds_played`.

```sql
select count(*) from demo_team_stats;
```

Expected: `0` (table exists, empty).

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/supabase-stats-migration.sql
git commit -m "feat(stats): add schema migration for per-demo scoreboard"
```

---

## Task 2: Extend parser to capture assister + damage on kills, plus damage events

**Why:** Current `kills` records lack `assister_id`, `dmg_health`, `dmg_armor`. Stats need assists, ADR, and trade detection. Also need `player_hurt` events for non-fatal damage (full ADR) and utility damage attribution.

**Files:**
- Modify: `vps/demo_parser.py:619-845` (kills capture) and `vps/demo_parser.py:904-`(return dict)
- Test: `vps/tests/test_parser.py` (add new test)

- [ ] **Step 1: Write failing test for assister + damage fields on kill records**

Append to `vps/tests/test_parser.py`:

```python
def test_kill_records_have_assister_and_damage_fields():
    """Every kill record exposes assister_id, dmg_health, dmg_armor (may be empty/0)."""
    parsed = parse_demo(str(FIXTURE))
    assert parsed["kills"], "fixture should have kills"
    for k in parsed["kills"]:
        assert "assister_id" in k
        assert "dmg_health" in k
        assert "dmg_armor" in k
        assert isinstance(k["dmg_health"], int)
        assert isinstance(k["dmg_armor"], int)


def test_parser_returns_damage_events():
    """parsed['damage_events'] is a list of player_hurt records with attacker, victim, dmg, tick."""
    parsed = parse_demo(str(FIXTURE))
    assert "damage_events" in parsed
    assert isinstance(parsed["damage_events"], list)
    if parsed["damage_events"]:
        ev = parsed["damage_events"][0]
        for k in ("tick", "attacker_id", "victim_id", "dmg_health", "weapon"):
            assert k in ev
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd vps && pytest tests/test_parser.py::test_kill_records_have_assister_and_damage_fields tests/test_parser.py::test_parser_returns_damage_events -v
```

Expected: FAIL — keys missing.

- [ ] **Step 3: Extend kill record + capture player_hurt**

In `vps/demo_parser.py`, find the `kills.append({...})` block around line 833 and replace with:

```python
        kills.append({
            "tick":        int(r["tick"]),
            "killer_id":   str(r.get("attacker_steamid") or ""),
            "killer_name": str(r.get("attacker_name") or ""),
            "killer_team": _team_at(str(r.get("attacker_steamid") or ""), int(r["tick"])),
            "victim_id":   str(r.get("user_steamid") or ""),
            "victim_name": str(r.get("user_name") or ""),
            "victim_team": _team_at(str(r.get("user_steamid") or ""), int(r["tick"])),
            "assister_id": str(r.get("assister_steamid") or ""),
            "weapon":      str(r.get("weapon") or ""),
            "headshot":    bool(r.get("headshot") or False),
            "dmg_health":  _safe_int(r.get("dmg_health")),
            "dmg_armor":   _safe_int(r.get("dmg_armor")),
            "victim_x":    vx,
            "victim_y":    vy,
        })
```

Then add a `player_hurt` parse near where other events are parsed (after line 622 `round_start_df = p.parse_event("round_start")`):

```python
    try:
        hurt_df = p.parse_event("player_hurt")
    except Exception as e:
        print(f"[parser] player_hurt parse failed: {e}")
        hurt_df = None
```

Build the damage_events list right before the `return {` at line 904:

```python
    damage_events = []
    if hurt_df is not None:
        for r in _to_records(hurt_df):
            damage_events.append({
                "tick":        int(r.get("tick") or 0),
                "attacker_id": str(r.get("attacker_steamid") or ""),
                "victim_id":   str(r.get("user_steamid") or ""),
                "dmg_health":  _safe_int(r.get("dmg_health")),
                "dmg_armor":   _safe_int(r.get("dmg_armor")),
                "weapon":      str(r.get("weapon") or ""),
                "hitgroup":    str(r.get("hitgroup") or ""),
            })
    print(f"[parser] damage events: {len(damage_events)}")
```

Add `"damage_events": damage_events,` to the returned dict (alongside `"kills": kills,`).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd vps && pytest tests/test_parser.py -v
```

Expected: all parser tests PASS, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add vps/demo_parser.py vps/tests/test_parser.py
git commit -m "feat(parser): capture assister + damage on kills, expose damage_events"
```

---

## Task 3: Helper — `_first_event_per_round`

**Files:**
- Modify: `vps/demo_parser.py` (add helper at end, before `build_slim_payload`)
- Test: `vps/tests/test_stats.py` (new file)

- [ ] **Step 1: Create test file with failing test**

Create `vps/tests/test_stats.py`:

```python
import pytest
from demo_parser import _first_event_per_round


def test_first_event_per_round_picks_earliest_per_round():
    rounds = [
        {"start_tick": 100, "end_tick": 200},
        {"start_tick": 300, "end_tick": 400},
    ]
    events = [
        {"tick": 150, "id": "a"},
        {"tick": 130, "id": "b"},  # earlier in round 0
        {"tick": 350, "id": "c"},
        {"tick": 320, "id": "d"},  # earlier in round 1
        {"tick": 999, "id": "z"},  # outside any round
    ]
    result = _first_event_per_round(events, rounds)
    assert result == [{"tick": 130, "id": "b"}, {"tick": 320, "id": "d"}]


def test_first_event_per_round_empty_round_yields_none():
    rounds = [{"start_tick": 100, "end_tick": 200}, {"start_tick": 300, "end_tick": 400}]
    events = [{"tick": 150, "id": "a"}]  # nothing in round 1
    result = _first_event_per_round(events, rounds)
    assert result == [{"tick": 150, "id": "a"}, None]
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: FAIL — `ImportError: cannot import name '_first_event_per_round'`.

- [ ] **Step 3: Implement helper**

Append to `vps/demo_parser.py` (after `_classify_buy`, before `build_slim_payload`):

```python
def _first_event_per_round(events: list, rounds: list) -> list:
    """For each round, return the event with the smallest tick that falls
    within (start_tick, end_tick]. Returns None for rounds with no events.
    Events outside all rounds are ignored."""
    result = [None] * len(rounds)
    for ev in events:
        t = int(ev.get("tick", 0))
        for i, r in enumerate(rounds):
            if r["start_tick"] < t <= r["end_tick"]:
                if result[i] is None or t < int(result[i].get("tick", 0)):
                    result[i] = ev
                break
    return result
```

- [ ] **Step 4: Run test to verify pass**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vps/demo_parser.py vps/tests/test_stats.py
git commit -m "feat(stats): add _first_event_per_round helper"
```

---

## Task 4: Helper — `_was_traded`

**Why:** Used by KAST and `traded_deaths`. A death is "traded" if the killer is killed by a teammate within `window_ticks`.

**Files:**
- Modify: `vps/demo_parser.py`
- Test: `vps/tests/test_stats.py`

- [ ] **Step 1: Add failing test**

Append to `vps/tests/test_stats.py`:

```python
from demo_parser import _was_traded


def test_was_traded_true_when_killer_dies_to_teammate_in_window():
    kills = [
        {"tick": 1000, "killer_id": "ATTACKER", "killer_team": "ct", "victim_id": "VICTIM", "victim_team": "t"},
        {"tick": 1200, "killer_id": "TEAMMATE", "killer_team": "t",  "victim_id": "ATTACKER", "victim_team": "ct"},
    ]
    assert _was_traded(kills, 0, window_ticks=320) is True  # 200-tick gap, within 320


def test_was_traded_false_when_outside_window():
    kills = [
        {"tick": 1000, "killer_id": "A", "killer_team": "ct", "victim_id": "V", "victim_team": "t"},
        {"tick": 5000, "killer_id": "T", "killer_team": "t",  "victim_id": "A", "victim_team": "ct"},
    ]
    assert _was_traded(kills, 0, window_ticks=320) is False


def test_was_traded_false_when_killer_dies_to_own_teammate():
    kills = [
        {"tick": 1000, "killer_id": "A", "killer_team": "ct", "victim_id": "V", "victim_team": "t"},
        {"tick": 1100, "killer_id": "OTHER_CT", "killer_team": "ct", "victim_id": "A", "victim_team": "ct"},
    ]
    assert _was_traded(kills, 0, window_ticks=320) is False
```

- [ ] **Step 2: Run to verify fail**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: FAIL — `_was_traded` not defined.

- [ ] **Step 3: Implement**

Append to `vps/demo_parser.py`:

```python
def _was_traded(kills: list, victim_idx: int, window_ticks: int = 320) -> bool:
    """A death is 'traded' if the attacker is killed by a teammate of the victim
    within window_ticks. Default window: 320 ticks ≈ 5 seconds @ 64 tick.

    Args:
        kills: list of kill events sorted by tick.
        victim_idx: index into kills of the death we're checking.
        window_ticks: max tick gap.
    """
    death = kills[victim_idx]
    attacker_id = death.get("killer_id")
    victim_team = death.get("victim_team")
    death_tick  = int(death.get("tick", 0))
    if not attacker_id:
        return False
    for k in kills[victim_idx + 1:]:
        gap = int(k.get("tick", 0)) - death_tick
        if gap > window_ticks:
            break
        if k.get("victim_id") == attacker_id and k.get("killer_team") == victim_team:
            return True
    return False
```

- [ ] **Step 4: Run to verify pass**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vps/demo_parser.py vps/tests/test_stats.py
git commit -m "feat(stats): add _was_traded helper"
```

---

## Task 5: Helper — `_alive_count_at_round_min`

**Why:** Used to detect 5v4 (any frame in a round where one team had +1 alive). We just need the per-round minimum-alive-count per side.

**Files:**
- Modify: `vps/demo_parser.py`
- Test: `vps/tests/test_stats.py`

- [ ] **Step 1: Add failing test**

Append to `vps/tests/test_stats.py`:

```python
from demo_parser import _alive_counts_per_round


def test_alive_counts_per_round_tracks_min_per_side():
    rounds = [{"start_tick": 100, "end_tick": 300}]
    frames = [
        # tick, list of {steam_id, team, hp}
        {"tick": 110, "players": [
            {"steam_id": "1", "team": "ct", "hp": 100},
            {"steam_id": "2", "team": "ct", "hp": 100},
            {"steam_id": "3", "team": "t",  "hp": 100},
            {"steam_id": "4", "team": "t",  "hp": 100},
            {"steam_id": "5", "team": "t",  "hp": 100},
        ]},
        {"tick": 200, "players": [
            {"steam_id": "1", "team": "ct", "hp": 100},
            {"steam_id": "2", "team": "ct", "hp": 100},
            {"steam_id": "3", "team": "t",  "hp": 0},   # dead
            {"steam_id": "4", "team": "t",  "hp": 100},
            {"steam_id": "5", "team": "t",  "hp": 100},
        ]},
    ]
    result = _alive_counts_per_round(rounds, frames)
    # round 0: CT min alive 2, T min alive 2 (after death). Max for either side = 2/2 → no 5v4 here
    # but the helper returns the minimum alive per side per round:
    assert result == [{"ct_min_alive": 2, "t_min_alive": 2}]


def test_alive_counts_detects_5v4():
    rounds = [{"start_tick": 100, "end_tick": 300}]
    frames = [
        {"tick": 110, "players": [
            {"steam_id": "1", "team": "ct", "hp": 100},
            {"steam_id": "2", "team": "ct", "hp": 100},
            {"steam_id": "3", "team": "t",  "hp": 100},
            {"steam_id": "4", "team": "t",  "hp": 100},
        ]},
        {"tick": 200, "players": [
            {"steam_id": "1", "team": "ct", "hp": 100},
            {"steam_id": "2", "team": "ct", "hp": 0},
            {"steam_id": "3", "team": "t",  "hp": 100},
            {"steam_id": "4", "team": "t",  "hp": 100},
        ]},
    ]
    result = _alive_counts_per_round(rounds, frames)
    assert result == [{"ct_min_alive": 1, "t_min_alive": 2}]
```

- [ ] **Step 2: Run to verify fail**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: FAIL — `_alive_counts_per_round` not defined.

- [ ] **Step 3: Implement**

Append to `vps/demo_parser.py`:

```python
def _alive_counts_per_round(rounds: list, frames: list) -> list:
    """For each round, return the minimum alive count per side observed
    across all frames in (start_tick, end_tick].

    Returns: [{ct_min_alive: int, t_min_alive: int}, ...]
    """
    result = []
    for r in rounds:
        ct_min, t_min = 5, 5
        for f in frames:
            t = int(f.get("tick", 0))
            if not (r["start_tick"] < t <= r["end_tick"]):
                continue
            ct_alive = sum(1 for p in f.get("players", []) if p.get("team") == "ct" and int(p.get("hp", 0)) > 0)
            t_alive  = sum(1 for p in f.get("players", []) if p.get("team") == "t"  and int(p.get("hp", 0)) > 0)
            if ct_alive < ct_min: ct_min = ct_alive
            if t_alive  < t_min:  t_min  = t_alive
        result.append({"ct_min_alive": ct_min, "t_min_alive": t_min})
    return result
```

- [ ] **Step 4: Run to verify pass**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vps/demo_parser.py vps/tests/test_stats.py
git commit -m "feat(stats): add _alive_counts_per_round helper"
```

---

## Task 6: Helper — `_clutch_outcome`

**Why:** Detect 1vN at any point in a round and whether the clutcher won.

**Files:**
- Modify: `vps/demo_parser.py`
- Test: `vps/tests/test_stats.py`

- [ ] **Step 1: Add failing test**

Append to `vps/tests/test_stats.py`:

```python
from demo_parser import _clutch_outcome


def test_clutch_outcome_winner_when_last_alive_wins_round():
    rnd = {"start_tick": 100, "end_tick": 500, "winner_side": "ct"}
    # frame at tick 400: only one CT alive, two T alive → clutch scenario for CT player
    frames = [{"tick": 400, "players": [
        {"steam_id": "CT_LAST", "team": "ct", "hp": 100},
        {"steam_id": "T_A",     "team": "t",  "hp": 100},
        {"steam_id": "T_B",     "team": "t",  "hp": 100},
    ]}]
    out = _clutch_outcome(rnd, frames)
    # round winner is ct → clutcher won
    assert out == {"clutcher_id": "CT_LAST", "won": True}


def test_clutch_outcome_loser_when_last_alive_loses_round():
    rnd = {"start_tick": 100, "end_tick": 500, "winner_side": "t"}
    frames = [{"tick": 400, "players": [
        {"steam_id": "CT_LAST", "team": "ct", "hp": 100},
        {"steam_id": "T_A",     "team": "t",  "hp": 100},
    ]}]
    out = _clutch_outcome(rnd, frames)
    assert out == {"clutcher_id": "CT_LAST", "won": False}


def test_clutch_outcome_none_when_no_1vN_situation():
    rnd = {"start_tick": 100, "end_tick": 500, "winner_side": "ct"}
    frames = [{"tick": 400, "players": [
        {"steam_id": "CT_A", "team": "ct", "hp": 100},
        {"steam_id": "CT_B", "team": "ct", "hp": 100},
        {"steam_id": "T_A",  "team": "t",  "hp": 100},
    ]}]
    assert _clutch_outcome(rnd, frames) is None
```

- [ ] **Step 2: Run to verify fail**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: FAIL — `_clutch_outcome` not defined.

- [ ] **Step 3: Implement**

Append to `vps/demo_parser.py`:

```python
def _clutch_outcome(rnd: dict, frames: list) -> dict | None:
    """Detect 1vN scenario in this round and report outcome.

    Returns {clutcher_id, won} if at any frame in the round one team had
    exactly 1 alive while the opponent had >=2. The clutcher is the
    last-alive player on that team at the *earliest* such frame. 'won'
    reflects whether that team's side matched rnd['winner_side'].
    Returns None if no 1vN scenario occurred.
    """
    for f in frames:
        t = int(f.get("tick", 0))
        if not (rnd["start_tick"] < t <= rnd["end_tick"]):
            continue
        ct_alive = [p for p in f.get("players", []) if p.get("team") == "ct" and int(p.get("hp", 0)) > 0]
        t_alive  = [p for p in f.get("players", []) if p.get("team") == "t"  and int(p.get("hp", 0)) > 0]
        if len(ct_alive) == 1 and len(t_alive) >= 2:
            return {"clutcher_id": ct_alive[0]["steam_id"], "won": rnd.get("winner_side") == "ct"}
        if len(t_alive) == 1 and len(ct_alive) >= 2:
            return {"clutcher_id": t_alive[0]["steam_id"], "won": rnd.get("winner_side") == "t"}
    return None
```

- [ ] **Step 4: Run to verify pass**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vps/demo_parser.py vps/tests/test_stats.py
git commit -m "feat(stats): add _clutch_outcome helper"
```

---

## Task 7: Helper — `_grenade_damage_attribution`

**Why:** Sum damage from `damage_events` where the weapon is a grenade and credit it to the thrower.

**Files:**
- Modify: `vps/demo_parser.py`
- Test: `vps/tests/test_stats.py`

- [ ] **Step 1: Add failing test**

Append to `vps/tests/test_stats.py`:

```python
from demo_parser import _grenade_damage_attribution


def test_grenade_damage_attribution_sums_per_thrower():
    damage_events = [
        {"attacker_id": "A", "victim_id": "V1", "dmg_health": 30, "weapon": "hegrenade"},
        {"attacker_id": "A", "victim_id": "V2", "dmg_health": 20, "weapon": "inferno"},
        {"attacker_id": "B", "victim_id": "V1", "dmg_health": 50, "weapon": "molotov"},
        {"attacker_id": "A", "victim_id": "V1", "dmg_health": 30, "weapon": "ak47"},  # not grenade
    ]
    result = _grenade_damage_attribution(damage_events)
    assert result == {"A": 50, "B": 50}
```

- [ ] **Step 2: Run to verify fail**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: FAIL — `_grenade_damage_attribution` not defined.

- [ ] **Step 3: Implement**

Append to `vps/demo_parser.py`:

```python
_GRENADE_WEAPONS = {"hegrenade", "inferno", "molotov", "incendiary", "incgrenade"}


def _grenade_damage_attribution(damage_events: list) -> dict:
    """Sum grenade damage per thrower steam_id."""
    out: dict = {}
    for ev in damage_events:
        if (ev.get("weapon") or "").lower() not in _GRENADE_WEAPONS:
            continue
        sid = ev.get("attacker_id")
        if not sid:
            continue
        out[sid] = out.get(sid, 0) + int(ev.get("dmg_health", 0))
    return out
```

- [ ] **Step 4: Run to verify pass**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vps/demo_parser.py vps/tests/test_stats.py
git commit -m "feat(stats): add _grenade_damage_attribution helper"
```

---

## Task 8: Helper — `_flash_assist_for_kill`

**Why:** Credit a player with a flash assist if they flashed the victim within ~140 ticks (~2s @ 70 tick rate) before the kill.

**Files:**
- Modify: `vps/demo_parser.py`
- Test: `vps/tests/test_stats.py`

- [ ] **Step 1: Add failing test**

Append to `vps/tests/test_stats.py`:

```python
from demo_parser import _flash_assist_for_kill


def test_flash_assist_credits_recent_flasher():
    kill = {"tick": 1000, "victim_id": "V", "killer_id": "K"}
    flashes = [
        {"thrower_id": "FLASHER", "victim_id": "V", "tick": 950},  # 50 ticks before kill
    ]
    assert _flash_assist_for_kill(kill, flashes, window_ticks=140) == "FLASHER"


def test_flash_assist_none_when_outside_window():
    kill = {"tick": 1000, "victim_id": "V"}
    flashes = [{"thrower_id": "F", "victim_id": "V", "tick": 700}]
    assert _flash_assist_for_kill(kill, flashes, window_ticks=140) is None


def test_flash_assist_none_when_killer_flashed_self_assist_target():
    kill = {"tick": 1000, "victim_id": "V", "killer_id": "K"}
    flashes = [{"thrower_id": "K", "victim_id": "V", "tick": 950}]  # killer's own flash
    # killer flashing victim doesn't count as a flash *assist* (no separate assister)
    assert _flash_assist_for_kill(kill, flashes, window_ticks=140) is None
```

- [ ] **Step 2: Run to verify fail**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `vps/demo_parser.py`:

```python
def _flash_assist_for_kill(kill: dict, flashes: list, window_ticks: int = 140) -> str | None:
    """Find a flasher who blinded the victim within window_ticks before the kill.
    Returns the flasher's steam_id, or None. Killer is not a valid flash-assister.
    """
    kill_tick = int(kill.get("tick", 0))
    victim    = kill.get("victim_id")
    killer    = kill.get("killer_id")
    best = None
    best_tick = -1
    for fl in flashes:
        if fl.get("victim_id") != victim:
            continue
        thrower = fl.get("thrower_id")
        if not thrower or thrower == killer:
            continue
        ft = int(fl.get("tick", 0))
        if ft <= kill_tick and (kill_tick - ft) <= window_ticks and ft > best_tick:
            best, best_tick = thrower, ft
    return best
```

- [ ] **Step 4: Run to verify pass**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vps/demo_parser.py vps/tests/test_stats.py
git commit -m "feat(stats): add _flash_assist_for_kill helper"
```

---

## Task 9: `compute_player_stats`

**Why:** The main per-player aggregation. Returns 3 rows per player (all/ct/t).

**Files:**
- Modify: `vps/demo_parser.py`
- Test: `vps/tests/test_stats.py`

- [ ] **Step 1: Add failing test (uses fixture demo)**

Append to `vps/tests/test_stats.py`:

```python
from pathlib import Path
from demo_parser import parse_demo, compute_player_stats

FIXTURE = Path(__file__).parent / "fixture.dem"


def test_compute_player_stats_returns_three_rows_per_player():
    parsed = parse_demo(str(FIXTURE))
    rows = compute_player_stats(parsed)
    assert rows, "fixture should produce stat rows"
    # Every (steam_id, side) is unique
    seen = set()
    for r in rows:
        key = (r["steam_id"], r["side"])
        assert key not in seen, f"duplicate row {key}"
        seen.add(key)
        assert r["side"] in ("all", "ct", "t")
    # Per-player: all, ct, t exist (or only 'all' + the side they played)
    sids = {r["steam_id"] for r in rows}
    for sid in sids:
        sides = {r["side"] for r in rows if r["steam_id"] == sid}
        assert "all" in sides


def test_compute_player_stats_kill_count_consistency():
    """all-side kills should equal ct kills + t kills for each player."""
    parsed = parse_demo(str(FIXTURE))
    rows = compute_player_stats(parsed)
    by_sid: dict = {}
    for r in rows:
        by_sid.setdefault(r["steam_id"], {})[r["side"]] = r
    for sid, sides in by_sid.items():
        if "ct" in sides and "t" in sides and "all" in sides:
            assert sides["all"]["kills"] == sides["ct"]["kills"] + sides["t"]["kills"]
            assert sides["all"]["deaths"] == sides["ct"]["deaths"] + sides["t"]["deaths"]


def test_compute_player_stats_rating_in_reasonable_range():
    parsed = parse_demo(str(FIXTURE))
    rows = compute_player_stats(parsed)
    for r in rows:
        if r["side"] == "all" and r["rounds_played"] and r["rounds_played"] > 5:
            assert 0.0 <= r["rating"] <= 2.5, f"unrealistic rating: {r}"
```

- [ ] **Step 2: Run to verify fail**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: FAIL — `compute_player_stats` not defined.

- [ ] **Step 3: Implement**

Append to `vps/demo_parser.py`:

```python
def _hltv_rating(kills: int, deaths: int, rounds: int,
                 multi_1k: int, multi_2k: int, multi_3k: int,
                 multi_4k: int, multi_5k: int) -> float:
    """HLTV 1.0 rating formula."""
    if rounds <= 0:
        return 0.0
    kill_rating     = kills / rounds / 0.679
    survival_rating = max(rounds - deaths, 0) / rounds / 0.317
    rwm             = (1*multi_1k + 4*multi_2k + 9*multi_3k + 16*multi_4k + 25*multi_5k) / rounds / 1.277
    return round((kill_rating + 0.7 * survival_rating + rwm) / 2.7, 3)


def compute_player_stats(parsed: dict) -> list[dict]:
    """Returns 3 rows per player ({side: 'all'|'ct'|'t'}).

    Wraps an inner loop in try/except — if anything goes wrong we return [].
    """
    try:
        rounds        = parsed.get("rounds") or []
        kills         = parsed.get("kills") or []
        damage_events = parsed.get("damage_events") or []
        frames        = parsed.get("frames") or []
        grenades      = parsed.get("grenades") or []
        players_meta  = parsed.get("players_meta") or {}
        team_a_first  = (parsed.get("meta") or {}).get("team_a_first_side")

        # Pre-compute things shared across players
        first_kill_per_round  = _first_event_per_round(kills, rounds)
        first_death_per_round = first_kill_per_round  # same event yields the first death
        alive_counts          = _alive_counts_per_round(rounds, frames)
        clutch_per_round      = [_clutch_outcome(r, frames) for r in rounds]
        utility_dmg_by_sid    = _grenade_damage_attribution(damage_events)

        # Build a flash list from grenades (parser stores hits)
        flash_events = []
        for g in grenades:
            if (g.get("type") or "").lower() != "flashbang":
                continue
            for h in (g.get("hits") or []):
                flash_events.append({
                    "thrower_id": str(g.get("steam_id") or ""),
                    "victim_id":  str(h.get("victim_id") or ""),
                    "tick":       int(h.get("tick") or g.get("tick") or 0),
                })

        # Identify which roster (a or b) a player belongs to. team_a_first_side
        # tells us which side team_a started on. We look at the player's side
        # at round 1's freeze_end_tick.
        def player_team_letter(sid: str) -> str | None:
            if not rounds: return None
            r1 = rounds[0]
            target_tick = r1.get("freeze_end_tick") or r1["start_tick"]
            for f in frames:
                if int(f.get("tick", 0)) >= target_tick:
                    for p in f.get("players", []):
                        if p.get("steam_id") == sid:
                            side = p.get("team")
                            if side == team_a_first: return "a"
                            if side and side != team_a_first: return "b"
                    return None
            return None

        # Identify rounds each player was alive at start (rounds_played)
        def alive_at_round_start(sid: str, rnd: dict) -> bool:
            target_tick = rnd.get("freeze_end_tick") or rnd["start_tick"]
            for f in frames:
                if int(f.get("tick", 0)) >= target_tick:
                    for p in f.get("players", []):
                        if p.get("steam_id") == sid:
                            return int(p.get("hp", 0)) > 0
                    return False
            return False

        def round_side_for(sid: str, rnd: dict) -> str | None:
            """Look up the player's side at round freeze-end. Falls back to None."""
            target_tick = rnd.get("freeze_end_tick") or rnd["start_tick"]
            for f in frames:
                if int(f.get("tick", 0)) >= target_tick:
                    for p in f.get("players", []):
                        if p.get("steam_id") == sid:
                            return p.get("team")
                    return None
            return None

        # Collect all sids
        sids = set(players_meta.keys())
        for k in kills:
            if k.get("killer_id"): sids.add(k["killer_id"])
            if k.get("victim_id"): sids.add(k["victim_id"])

        out: list[dict] = []
        for sid in sids:
            if not sid:
                continue
            # Aggregator per side bucket
            buckets = {
                "all": _empty_player_bucket(),
                "ct":  _empty_player_bucket(),
                "t":   _empty_player_bucket(),
            }

            # Rounds-played + per-round multi-kill counters per side
            for ri, rnd in enumerate(rounds):
                if not alive_at_round_start(sid, rnd):
                    continue
                side = round_side_for(sid, rnd) or "ct"
                if side not in ("ct", "t"):
                    continue
                for b in (buckets["all"], buckets[side]):
                    b["rounds_played"] += 1

                # Round-level kills/deaths/assists
                rkills = [k for k in kills if rnd["start_tick"] < int(k["tick"]) <= rnd["end_tick"]]
                killed   = sum(1 for k in rkills if k.get("killer_id") == sid)
                died     = any(k.get("victim_id") == sid for k in rkills)
                assisted = any(k.get("assister_id") == sid for k in rkills)
                survived = not died

                # Multi-kill bucket
                multi_idx = min(killed, 5)
                if multi_idx > 0:
                    for b in (buckets["all"], buckets[side]):
                        b[f"multi_{multi_idx}k"] += 1

                # KAST: did player K, A, S, or get traded death?
                trade_traded_death = False
                for ki, k in enumerate(kills):
                    if k.get("victim_id") == sid and rnd["start_tick"] < int(k["tick"]) <= rnd["end_tick"]:
                        if _was_traded(kills, ki):
                            trade_traded_death = True
                            for b in (buckets["all"], buckets[side]):
                                b["traded_deaths"] += 1
                            break
                if killed > 0 or assisted or survived or trade_traded_death:
                    for b in (buckets["all"], buckets[side]):
                        b["kast_rounds"] += 1

                # Opening kill / death
                fk = first_kill_per_round[ri]
                if fk:
                    if fk.get("killer_id") == sid:
                        for b in (buckets["all"], buckets[side]):
                            b["opening_kills"] += 1
                    if fk.get("victim_id") == sid:
                        for b in (buckets["all"], buckets[side]):
                            b["opening_deaths"] += 1

                # Clutches
                clutch = clutch_per_round[ri]
                if clutch and clutch.get("clutcher_id") == sid:
                    key = "clutches_won" if clutch["won"] else "clutches_lost"
                    for b in (buckets["all"], buckets[side]):
                        b[key] += 1

            # Cross-round totals: kills, deaths, assists, hs, damage
            for k in kills:
                if k.get("killer_id") == sid:
                    side = (k.get("killer_team") or "ct")
                    for b in (buckets["all"], buckets[side]):
                        b["kills"] += 1
                        if k.get("headshot"):
                            b["hs_kills"] += 1
                        b["damage_dealt"] += int(k.get("dmg_health", 0))
                if k.get("victim_id") == sid:
                    side = (k.get("victim_team") or "ct")
                    for b in (buckets["all"], buckets[side]):
                        b["deaths"] += 1
                if k.get("assister_id") == sid:
                    # Assister side at kill tick — best effort: same as killer team
                    side = (k.get("killer_team") or "ct")
                    for b in (buckets["all"], buckets[side]):
                        b["assists"] += 1

            # Non-fatal damage
            for ev in damage_events:
                if ev.get("attacker_id") == sid:
                    # Attribute by attacker's side at hit tick — best effort: use kill_team lookup
                    side = _team_at_tick(frames, sid, int(ev.get("tick", 0))) or "ct"
                    for b in (buckets["all"], buckets[side]):
                        b["damage_dealt"] += int(ev.get("dmg_health", 0))

            # Utility damage + flash assists
            ud = utility_dmg_by_sid.get(sid, 0)
            for k in kills:
                if k.get("killer_id") == sid:
                    continue
                fa = _flash_assist_for_kill(k, flash_events)
                if fa == sid:
                    side = (k.get("killer_team") or "ct")
                    for b in (buckets["all"], buckets[side]):
                        b["flash_assists"] += 1

            # Emit rows
            name = players_meta.get(sid) or ""
            team_letter = player_team_letter(sid)
            for side_label, b in buckets.items():
                if b["rounds_played"] == 0 and side_label != "all":
                    continue  # skip empty side rows
                rounds_played = b["rounds_played"] or 1
                row = {
                    "steam_id":       sid,
                    "name":           name,
                    "team":           team_letter,
                    "side":           side_label,
                    "kills":          b["kills"],
                    "deaths":         b["deaths"],
                    "assists":        b["assists"],
                    "hs_pct":         round(b["hs_kills"] / b["kills"], 3) if b["kills"] else 0.0,
                    "adr":            round(b["damage_dealt"] / rounds_played, 1),
                    "kast_pct":       round(b["kast_rounds"] / rounds_played, 3),
                    "multi_2k":       b["multi_2k"],
                    "multi_3k":       b["multi_3k"],
                    "multi_4k":       b["multi_4k"],
                    "multi_5k":       b["multi_5k"],
                    "opening_kills":  b["opening_kills"],
                    "opening_deaths": b["opening_deaths"],
                    "clutches_won":   b["clutches_won"],
                    "clutches_lost":  b["clutches_lost"],
                    "utility_dmg":    ud if side_label == "all" else 0,
                    "flash_assists":  b["flash_assists"],
                    "traded_deaths":  b["traded_deaths"],
                    "rounds_played":  b["rounds_played"],
                    "impact_rating":  round(
                        (b["opening_kills"] + b["clutches_won"] +
                         b["multi_3k"] + b["multi_4k"] + b["multi_5k"]) / rounds_played, 3),
                    "rating":         _hltv_rating(
                        b["kills"], b["deaths"], rounds_played,
                        b["multi_1k"], b["multi_2k"], b["multi_3k"], b["multi_4k"], b["multi_5k"],
                    ),
                }
                out.append(row)
        return out
    except Exception as e:
        print(f"[stats] compute_player_stats failed: {e}")
        return []


def _empty_player_bucket() -> dict:
    return {
        "kills": 0, "deaths": 0, "assists": 0, "hs_kills": 0,
        "damage_dealt": 0, "rounds_played": 0, "kast_rounds": 0,
        "multi_1k": 0, "multi_2k": 0, "multi_3k": 0, "multi_4k": 0, "multi_5k": 0,
        "opening_kills": 0, "opening_deaths": 0,
        "clutches_won": 0, "clutches_lost": 0,
        "flash_assists": 0, "traded_deaths": 0,
    }
```

- [ ] **Step 4: Run to verify pass**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: all stats tests PASS.

- [ ] **Step 5: Commit**

```bash
git add vps/demo_parser.py vps/tests/test_stats.py
git commit -m "feat(stats): add compute_player_stats with HLTV 1.0 rating"
```

---

## Task 10: `compute_team_stats`

**Why:** Two rows per demo (team_a, team_b) with pistol/5v4/FK-FD/eco/force/full-buy/bomb stats.

**Files:**
- Modify: `vps/demo_parser.py`
- Test: `vps/tests/test_stats.py`

- [ ] **Step 1: Add failing test**

Append to `vps/tests/test_stats.py`:

```python
from demo_parser import compute_team_stats


def test_compute_team_stats_returns_two_rows():
    parsed = parse_demo(str(FIXTURE))
    rows = compute_team_stats(parsed)
    assert len(rows) == 2
    teams = {r["team"] for r in rows}
    assert teams == {"a", "b"}


def test_compute_team_stats_round_count_consistency():
    parsed = parse_demo(str(FIXTURE))
    rows = compute_team_stats(parsed)
    n_rounds = len(parsed["rounds"])
    for r in rows:
        # CT rounds + T rounds = total rounds (every round has the team on one side)
        assert r["ct_rounds_played"] + r["t_rounds_played"] == n_rounds


def test_compute_team_stats_pistol_max_two():
    parsed = parse_demo(str(FIXTURE))
    rows = compute_team_stats(parsed)
    for r in rows:
        assert 0 <= r["pistol_played"] <= 2
        assert 0 <= r["pistol_wins"] <= r["pistol_played"]
```

- [ ] **Step 2: Run to verify fail**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: FAIL — `compute_team_stats` not defined.

- [ ] **Step 3: Implement**

Append to `vps/demo_parser.py`:

```python
def compute_team_stats(parsed: dict) -> list[dict]:
    """Returns 2 rows: team='a' and team='b'."""
    try:
        rounds        = parsed.get("rounds") or []
        kills         = parsed.get("kills") or []
        frames        = parsed.get("frames") or []
        bomb          = parsed.get("bomb") or []
        meta          = parsed.get("meta") or {}
        team_a_first  = meta.get("team_a_first_side")  # 'ct' | 't' | None

        first_kill_per_round = _first_event_per_round(kills, rounds)
        alive_counts         = _alive_counts_per_round(rounds, frames)

        # Initialize stats for both teams
        def empty():
            return {
                "pistol_wins": 0, "pistol_played": 0,
                "five_v_four_wins": 0, "five_v_four_played": 0,
                "five_v_four_t_wins": 0, "five_v_four_t_played": 0,
                "five_v_four_ct_wins": 0, "five_v_four_ct_played": 0,
                "first_kills": 0, "first_deaths": 0,
                "first_kills_t": 0, "first_kills_ct": 0,
                "first_deaths_t": 0, "first_deaths_ct": 0,
                "eco_wins": 0, "eco_played": 0,
                "force_wins": 0, "force_played": 0,
                "full_buy_wins": 0, "full_buy_played": 0,
                "bomb_plants": 0, "bomb_defuses": 0,
                "ct_round_wins": 0, "ct_rounds_played": 0,
                "t_round_wins": 0, "t_rounds_played": 0,
            }

        a, b = empty(), empty()

        for ri, rnd in enumerate(rounds):
            a_side = rnd.get("team_a_side")  # 'ct' or 't'
            b_side = "t" if a_side == "ct" else "ct"
            winner = rnd.get("winner_side")

            # Side win/loss
            if a_side == "ct":
                a["ct_rounds_played"] += 1
                a["ct_round_wins"]    += 1 if winner == "ct" else 0
                b["t_rounds_played"]  += 1
                b["t_round_wins"]     += 1 if winner == "t" else 0
            else:
                a["t_rounds_played"]  += 1
                a["t_round_wins"]     += 1 if winner == "t" else 0
                b["ct_rounds_played"] += 1
                b["ct_round_wins"]    += 1 if winner == "ct" else 0

            # Pistol
            if _is_pistol_round(rounds, ri):
                a["pistol_played"] += 1
                b["pistol_played"] += 1
                if winner == a_side: a["pistol_wins"] += 1
                if winner == b_side: b["pistol_wins"] += 1

            # First kill / death
            fk = first_kill_per_round[ri]
            if fk:
                killer_team = fk.get("killer_team")
                victim_team = fk.get("victim_team")
                if killer_team == a_side:
                    a["first_kills"] += 1
                    a[f"first_kills_{a_side}"] += 1
                    b["first_deaths"] += 1
                    b[f"first_deaths_{b_side}"] += 1
                if killer_team == b_side:
                    b["first_kills"] += 1
                    b[f"first_kills_{b_side}"] += 1
                    a["first_deaths"] += 1
                    a[f"first_deaths_{a_side}"] += 1

            # 5v4 — at any frame, did either side have +1 alive
            ac = alive_counts[ri] if ri < len(alive_counts) else None
            if ac:
                if ac["ct_min_alive"] >= 4 and ac["t_min_alive"] >= 4:
                    pass
                # If at any point one side dropped below 5 while the other had >=5,
                # the team WITH the advantage played a 5v4. Approximation: if a_side
                # min alive is 5 and b_side min alive < 5, team A had a man advantage.
                a_min = ac["ct_min_alive"] if a_side == "ct" else ac["t_min_alive"]
                b_min = ac["ct_min_alive"] if b_side == "ct" else ac["t_min_alive"]
                if a_min >= 5 and b_min < 5:
                    a["five_v_four_played"] += 1
                    a[f"five_v_four_{a_side}_played"] += 1
                    if winner == a_side:
                        a["five_v_four_wins"] += 1
                        a[f"five_v_four_{a_side}_wins"] += 1
                if b_min >= 5 and a_min < 5:
                    b["five_v_four_played"] += 1
                    b[f"five_v_four_{b_side}_played"] += 1
                    if winner == b_side:
                        b["five_v_four_wins"] += 1
                        b[f"five_v_four_{b_side}_wins"] += 1

            # Buy classification — needs equip values per team
            a_equip = _team_equip_value_at_tick(frames, rnd.get("freeze_end_tick", rnd["start_tick"]), a_side)
            b_equip = _team_equip_value_at_tick(frames, rnd.get("freeze_end_tick", rnd["start_tick"]), b_side)
            is_pistol = _is_pistol_round(rounds, ri)
            a_buy = _classify_buy(a_equip, b_equip, is_pistol)
            b_buy = _classify_buy(b_equip, a_equip, is_pistol)
            for team, buy, side in ((a, a_buy, a_side), (b, b_buy, b_side)):
                if buy == "eco":
                    team["eco_played"] += 1
                    if winner == side: team["eco_wins"] += 1
                elif buy == "force":
                    team["force_played"] += 1
                    if winner == side: team["force_wins"] += 1
                elif buy == "full":
                    team["full_buy_played"] += 1
                    if winner == side: team["full_buy_wins"] += 1

        # Bomb plants/defuses
        for ev in bomb:
            etype = (ev.get("type") or "").lower()
            # Plant attributed to whoever's on T side at the tick;
            # defuse to whoever's on CT.
            if etype == "plant":
                planter_team = ev.get("team") or "t"  # planter is always T
                # Find the planter's *roster* (a or b) by the round side
                ri = _round_index_for_tick(rounds, int(ev.get("tick", 0)))
                if ri is not None and 0 <= ri < len(rounds):
                    a_side_here = rounds[ri].get("team_a_side")
                    if a_side_here == "t":
                        a["bomb_plants"] += 1
                    else:
                        b["bomb_plants"] += 1
            elif etype == "defuse":
                ri = _round_index_for_tick(rounds, int(ev.get("tick", 0)))
                if ri is not None and 0 <= ri < len(rounds):
                    a_side_here = rounds[ri].get("team_a_side")
                    if a_side_here == "ct":
                        a["bomb_defuses"] += 1
                    else:
                        b["bomb_defuses"] += 1

        return [{"team": "a", **a}, {"team": "b", **b}]
    except Exception as e:
        print(f"[stats] compute_team_stats failed: {e}")
        return []
```

- [ ] **Step 4: Run to verify pass**

```bash
cd vps && pytest tests/test_stats.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vps/demo_parser.py vps/tests/test_stats.py
git commit -m "feat(stats): add compute_team_stats"
```

---

## Task 11: Wire compute into worker, write rows to DB

**Files:**
- Modify: `vps/main.py`

- [ ] **Step 1: Read existing pipeline location**

Open `vps/main.py` and find where `parse_demo` is called and where `match_data` / `match_data_slim` are written to the DB. Locate the section just after `slim = build_slim_payload(parsed)`.

- [ ] **Step 2: Add stats writer function**

Near the top of `vps/main.py` (after imports, before the polling loop), add:

```python
from demo_parser import compute_player_stats, compute_team_stats


def write_stats_for_demo(supabase_client, demo_id: str, parsed: dict) -> None:
    """Compute and upsert per-demo stat rows. Soft-failures: log and continue."""
    # Players
    try:
        player_rows = compute_player_stats(parsed)
        if player_rows:
            supabase_client.table("demo_players").delete().eq("demo_id", demo_id).execute()
            for row in player_rows:
                row["demo_id"] = demo_id
            # Chunk inserts to avoid payload limits
            for i in range(0, len(player_rows), 100):
                supabase_client.table("demo_players").insert(player_rows[i:i+100]).execute()
            print(f"[stats] wrote {len(player_rows)} player rows for demo {demo_id}")
    except Exception as e:
        print(f"[stats] player stats write failed for {demo_id}: {e}")

    # Team stats
    try:
        team_rows = compute_team_stats(parsed)
        if team_rows:
            supabase_client.table("demo_team_stats").delete().eq("demo_id", demo_id).execute()
            for row in team_rows:
                row["demo_id"] = demo_id
            supabase_client.table("demo_team_stats").insert(team_rows).execute()
            print(f"[stats] wrote {len(team_rows)} team rows for demo {demo_id}")
    except Exception as e:
        print(f"[stats] team stats write failed for {demo_id}: {e}")
```

- [ ] **Step 3: Call writer after successful parse**

In `vps/main.py`, locate the block where `match_data` / `match_data_slim` are written to the `demos` table after a successful parse. Immediately after that update, add:

```python
        write_stats_for_demo(supabase, demo["id"], parsed)
```

(Use whatever variable names already exist for the supabase client and the demo dict — reuse them, don't introduce new ones.)

- [ ] **Step 4: Manually smoke-test on one demo**

On the VPS:

```bash
cd vps && python -c "
from demo_parser import parse_demo, compute_player_stats, compute_team_stats
import json
parsed = parse_demo('tests/fixture.dem')
ps = compute_player_stats(parsed)
ts = compute_team_stats(parsed)
print('players:', len(ps), 'first row keys:', list(ps[0].keys()) if ps else [])
print('teams:', len(ts))
print('team a:', json.dumps(ts[0], indent=2) if ts else 'none')
"
```

Expected: prints player count > 0, exactly 2 team rows, no exceptions.

- [ ] **Step 5: Commit**

```bash
git add vps/main.py
git commit -m "feat(stats): wire compute_player_stats and compute_team_stats into worker"
```

---

## Task 12: Backfill existing demos

**Files:** none — this is a runtime SQL step.

- [ ] **Step 1: Verify worker is running with new code**

Confirm the VPS process is restarted with the changes from Task 11.

- [ ] **Step 2: Flip existing demos to pending**

In Supabase SQL editor:

```sql
update demos
set processing_status = 'pending', processed_at = null
where processing_status = 'completed';
```

- [ ] **Step 3: Watch worker logs**

Tail the VPS worker logs and verify each demo prints `[stats] wrote N player rows` and `[stats] wrote 2 team rows`.

- [ ] **Step 4: Verify data**

In Supabase SQL editor:

```sql
select demo_id, count(*) as player_rows
from demo_players
group by demo_id
order by player_rows desc;

select demo_id, count(*) as team_rows
from demo_team_stats
group by demo_id;
```

Expected: each demo has ~30 player rows (10 players × 3 sides, fewer if subs) and exactly 2 team rows.

- [ ] **Step 5: No commit (runtime step)**

---

## Task 13: Add Scoreboard tab strip + tab switching to demo viewer

**Files:**
- Modify: `cs2-hub/analysis.html`
- Modify: `cs2-hub/analysis.js`
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Read current header layout**

Open `cs2-hub/analysis.html` and find the demo viewer header (the bar above the playback area with the map name, score, etc.). We'll add a tab strip there.

- [ ] **Step 2: Add tab strip markup**

In `cs2-hub/analysis.html`, locate the demo viewer header element. Add a tab strip immediately to its right:

```html
<div class="dv-tabs" id="dv-tabs">
  <button class="dv-tab is-active" data-tab="playback">Playback</button>
  <button class="dv-tab" data-tab="scoreboard">Scoreboard</button>
</div>
```

Wrap the existing playback content in `<div id="dv-tab-playback" class="dv-tab-panel is-active">…existing content…</div>` and add a sibling:

```html
<div id="dv-tab-scoreboard" class="dv-tab-panel" hidden>
  <div id="scoreboard-root"></div>
</div>
```

- [ ] **Step 3: Add tab styles**

Append to `cs2-hub/style.css`:

```css
.dv-tabs { display:flex; gap:4px; }
.dv-tab {
  background: transparent; color: var(--muted);
  border: none; padding: 6px 12px; font-size: 13px;
  border-radius: 4px; cursor: pointer;
}
.dv-tab.is-active { background: #2a3038; color: #fff; }
.dv-tab-panel[hidden] { display: none; }
```

- [ ] **Step 4: Wire tab switch in analysis.js**

In `cs2-hub/analysis.js`, near the bottom (after other event wiring), add:

```javascript
import { mountScoreboard } from './scoreboard.js'

let _scoreboardMounted = false
document.querySelectorAll('.dv-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab
    document.querySelectorAll('.dv-tab').forEach(b =>
      b.classList.toggle('is-active', b === btn))
    document.querySelectorAll('.dv-tab-panel').forEach(p => {
      const match = p.id === `dv-tab-${target}`
      p.hidden = !match
      p.classList.toggle('is-active', match)
    })
    if (target === 'scoreboard' && !_scoreboardMounted) {
      mountScoreboard(document.getElementById('scoreboard-root'),
        new URLSearchParams(location.search).get('id'))
      _scoreboardMounted = true
    }
  })
})
```

- [ ] **Step 5: Smoke test in browser**

Start the local dev server, open a demo's analysis page. Click "Scoreboard" — it should switch panels (the playback panel hides). The scoreboard area is empty for now (Task 14 fills it).

- [ ] **Step 6: Commit**

```bash
git add cs2-hub/analysis.html cs2-hub/analysis.js cs2-hub/style.css
git commit -m "feat(scoreboard): add Playback/Scoreboard tabs to demo viewer"
```

---

## Task 14: Create scoreboard.js module — fetch + skeleton render

**Files:**
- Create: `cs2-hub/scoreboard.js`

- [ ] **Step 1: Create module skeleton**

Create `cs2-hub/scoreboard.js`:

```javascript
// cs2-hub/scoreboard.js
//
// Loads per-demo player + team stats from Supabase and renders the
// Scoreboard tab inside the demo viewer.

import { supabase } from './supabase.js'

const SIDE_KEY = 'scoreboard:side'

export async function mountScoreboard(root, demoId) {
  if (!root || !demoId) return
  const side = localStorage.getItem(SIDE_KEY) || 'all'

  root.innerHTML = `<div class="sb-loading">Loading stats…</div>`

  try {
    const [{ data: players, error: pe }, { data: teams, error: te }] = await Promise.all([
      supabase.from('demo_players')
        .select('*').eq('demo_id', demoId),
      supabase.from('demo_team_stats')
        .select('*').eq('demo_id', demoId),
    ])
    if (pe) throw pe
    if (te) throw te

    if (!players?.length) {
      root.innerHTML = `<div class="sb-empty">No stats parsed for this demo yet.</div>`
      return
    }

    render(root, { players, teams: teams || [], side, demoId })
  } catch (e) {
    console.error('[scoreboard]', e)
    root.innerHTML = `<div class="sb-empty">Failed to load stats: ${esc(e.message || String(e))}</div>`
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function render(root, state) {
  const { players, teams, side } = state
  root.innerHTML = `
    <div class="sb-toolbar">
      <span class="sb-label">View</span>
      <button class="sb-side-btn ${side==='all'?'is-active':''}" data-side="all">All</button>
      <button class="sb-side-btn ${side==='ct'?'is-active':''}"  data-side="ct">CT</button>
      <button class="sb-side-btn ${side==='t'?'is-active':''}"   data-side="t">T</button>
    </div>
    <div id="sb-tables"></div>
    <div id="sb-team-stats"></div>
  `
  for (const btn of root.querySelectorAll('.sb-side-btn')) {
    btn.addEventListener('click', () => {
      const newSide = btn.dataset.side
      localStorage.setItem(SIDE_KEY, newSide)
      render(root, { ...state, side: newSide })
    })
  }
  renderPlayerTables(root.querySelector('#sb-tables'), players, side)
  renderTeamStats(root.querySelector('#sb-team-stats'), teams)
}

function renderPlayerTables(container, players, side) {
  container.innerHTML = `<div class="sb-empty">Player tables — Task 15</div>`
}

function renderTeamStats(container, teams) {
  container.innerHTML = `<div class="sb-empty">Team stats — Task 16</div>`
}
```

- [ ] **Step 2: Smoke test**

Reload the demo viewer, click Scoreboard tab. Should see toolbar with All/CT/T buttons (clickable, persist to localStorage), and two placeholder messages.

Open browser devtools → Application → Local Storage → confirm `scoreboard:side` updates as you click.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/scoreboard.js
git commit -m "feat(scoreboard): fetch demo stats + render side toggle skeleton"
```

---

## Task 15: Render player tables (both teams)

**Files:**
- Modify: `cs2-hub/scoreboard.js`

- [ ] **Step 1: Replace `renderPlayerTables` placeholder**

In `cs2-hub/scoreboard.js`, replace the placeholder `renderPlayerTables` with:

```javascript
function renderPlayerTables(container, players, side) {
  const filtered = players.filter(p => p.side === side)
  const teamA = filtered.filter(p => p.team === 'a').sort((a, b) => (b.rating || 0) - (a.rating || 0))
  const teamB = filtered.filter(p => p.team === 'b').sort((a, b) => (b.rating || 0) - (a.rating || 0))
  const orphans = filtered.filter(p => p.team !== 'a' && p.team !== 'b')
  const tail = orphans.length ? orphans.sort((a, b) => (b.rating || 0) - (a.rating || 0)) : []

  container.innerHTML = `
    ${teamTable('Your team', 'sb-team-a', teamA)}
    ${teamTable('Opponent',  'sb-team-b', teamB)}
    ${tail.length ? teamTable('Other', 'sb-team-other', tail) : ''}
  `
}

function teamTable(label, cls, rows) {
  if (!rows.length) return ''
  return `
    <div class="sb-team-block ${cls}">
      <div class="sb-team-header">${esc(label)}</div>
      <table class="sb-table">
        <thead>
          <tr>
            <th class="sb-col-name">Player</th>
            <th>K</th><th>D</th><th>A</th><th>+/–</th>
            <th>ADR</th><th>HS%</th><th>KAST</th>
            <th>Multi</th><th>Open</th><th>Clutch</th>
            <th class="sb-col-rating">Rating</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(p => row(p)).join('')}
        </tbody>
      </table>
    </div>
  `
}

function row(p) {
  const plusMinus = (p.kills || 0) - (p.deaths || 0)
  const pmClass = plusMinus > 0 ? 'sb-pos' : plusMinus < 0 ? 'sb-neg' : ''
  return `
    <tr>
      <td class="sb-col-name">${esc(p.name || p.steam_id)}</td>
      <td>${p.kills ?? 0}</td>
      <td>${p.deaths ?? 0}</td>
      <td>${p.assists ?? 0}</td>
      <td class="${pmClass}">${plusMinus > 0 ? '+' : ''}${plusMinus}</td>
      <td>${(p.adr ?? 0).toFixed(1)}</td>
      <td>${pct(p.hs_pct)}</td>
      <td>${pct(p.kast_pct)}</td>
      <td>${p.multi_2k ?? 0}/${p.multi_3k ?? 0}/${p.multi_4k ?? 0}/${p.multi_5k ?? 0}</td>
      <td>${p.opening_kills ?? 0}–${p.opening_deaths ?? 0}</td>
      <td>${p.clutches_won ?? 0}–${p.clutches_lost ?? 0}</td>
      <td class="sb-col-rating">${(p.rating ?? 0).toFixed(2)}</td>
    </tr>
  `
}

function pct(v) {
  if (v == null) return '—'
  return `${Math.round(v * 100)}%`
}
```

- [ ] **Step 2: Smoke test**

Reload, click Scoreboard. Player table renders with rows sorted by rating. Click All/CT/T — table re-renders with side-filtered numbers (CT row shows only CT-half stats, T row shows only T-half).

Spot-check: top player's rating + numbers look plausible (compare to HLTV if you have a public match parsed).

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/scoreboard.js
git commit -m "feat(scoreboard): render player table with rating-sorted rows"
```

---

## Task 16: Render team stats tile grid

**Files:**
- Modify: `cs2-hub/scoreboard.js`

- [ ] **Step 1: Replace `renderTeamStats` placeholder**

In `cs2-hub/scoreboard.js`, replace `renderTeamStats` with:

```javascript
function renderTeamStats(container, teams) {
  if (!teams.length) {
    container.innerHTML = `<div class="sb-empty">No team stats.</div>`
    return
  }
  // Find team A (your team) and B
  const a = teams.find(t => t.team === 'a') || {}
  const b = teams.find(t => t.team === 'b') || {}

  container.innerHTML = `
    <div class="sb-team-stats">
      <div class="sb-team-stats-label">Team stats — Your team</div>
      <div class="sb-tiles">
        ${tile('Pistol rounds', `${a.pistol_wins ?? 0} / ${a.pistol_played ?? 0}`,
          (a.pistol_wins === a.pistol_played && a.pistol_played > 0) ? 'won both'
            : (a.pistol_wins === 0) ? 'lost both' : 'split')}
        ${tile('5v4 conversion',
          `${a.five_v_four_wins ?? 0} / ${a.five_v_four_played ?? 0} ${pctText(a.five_v_four_wins, a.five_v_four_played)}`,
          `CT ${a.five_v_four_ct_wins ?? 0}/${a.five_v_four_ct_played ?? 0} · T ${a.five_v_four_t_wins ?? 0}/${a.five_v_four_t_played ?? 0}`)}
        ${tile('First kills', a.first_kills ?? 0,
          `CT ${a.first_kills_ct ?? 0} · T ${a.first_kills_t ?? 0}`)}
        ${tile('First deaths', a.first_deaths ?? 0,
          `CT ${a.first_deaths_ct ?? 0} · T ${a.first_deaths_t ?? 0}`)}
        ${tile('Eco wins', `${a.eco_wins ?? 0} / ${a.eco_played ?? 0}`, pctText(a.eco_wins, a.eco_played))}
        ${tile('Force wins', `${a.force_wins ?? 0} / ${a.force_played ?? 0}`, pctText(a.force_wins, a.force_played))}
        ${tile('Full-buy wins', `${a.full_buy_wins ?? 0} / ${a.full_buy_played ?? 0}`, pctText(a.full_buy_wins, a.full_buy_played))}
        ${tile('Side splits',
          `CT ${a.ct_round_wins ?? 0}–${(a.ct_rounds_played ?? 0)-(a.ct_round_wins ?? 0)} · T ${a.t_round_wins ?? 0}–${(a.t_rounds_played ?? 0)-(a.t_round_wins ?? 0)}`,
          'side win rates')}
      </div>
    </div>
  `
}

function tile(label, big, sub) {
  return `
    <div class="sb-tile">
      <div class="sb-tile-label">${esc(label)}</div>
      <div class="sb-tile-big">${big}</div>
      <div class="sb-tile-sub">${esc(sub)}</div>
    </div>
  `
}

function pctText(num, den) {
  if (!den) return ''
  return `${Math.round((num / den) * 100)}%`
}
```

- [ ] **Step 2: Smoke test**

Reload, click Scoreboard. 8 tiles render below the player table with sensible numbers. Hover/inspect each — values match the underlying `demo_team_stats` row for `team='a'`.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/scoreboard.js
git commit -m "feat(scoreboard): render team stats tile grid"
```

---

## Task 17: Style the scoreboard

**Files:**
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Append scoreboard styles**

Append to `cs2-hub/style.css`:

```css
/* === Scoreboard tab === */
#scoreboard-root { padding: 14px 16px; }

.sb-loading, .sb-empty {
  padding: 20px; text-align: center; color: var(--muted);
}

.sb-toolbar {
  display: flex; gap: 6px; align-items: center;
  margin-bottom: 14px;
}
.sb-label {
  font-size: 11px; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.5px;
  margin-right: 6px;
}
.sb-side-btn {
  background: transparent; color: var(--muted);
  border: 1px solid #2a3038;
  padding: 5px 12px; border-radius: 3px;
  font-size: 12px; cursor: pointer;
}
.sb-side-btn.is-active {
  background: #2a3038; color: #fff; border-color: #2a3038;
}

.sb-table {
  width: 100%; border-collapse: collapse;
  font-size: 12px; margin-bottom: 18px;
}
.sb-table thead th {
  text-align: center;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.5px;
  color: #666;
  padding: 6px 4px;
  border-bottom: 1px solid #2a3038;
}
.sb-table thead th.sb-col-name { text-align: left; }
.sb-table thead th.sb-col-rating { color: #fff; }
.sb-table tbody td {
  text-align: center;
  padding: 7px 4px;
  border-bottom: 1px solid #1a1d22;
}
.sb-table tbody td.sb-col-name {
  text-align: left; font-weight: 500;
}
.sb-table tbody td.sb-col-rating {
  font-weight: 600; color: #fff;
}
.sb-pos { color: #7ed957; }
.sb-neg { color: #e6534b; }

.sb-team-block { margin-bottom: 18px; }
.sb-team-header {
  display: flex; justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid #2a3038;
  font-weight: 600;
  margin-bottom: 4px;
}
.sb-team-a .sb-team-header { color: #5fa8ff; }
.sb-team-b .sb-team-header { color: #e6534b; }
.sb-team-other .sb-team-header { color: var(--muted); }

.sb-team-stats {
  margin-top: 14px;
  padding: 14px 16px;
  background: #0a0c0f;
  border-top: 1px solid #222;
  border-radius: 6px;
}
.sb-team-stats-label {
  font-size: 11px; color: #666;
  text-transform: uppercase; letter-spacing: 0.5px;
  margin-bottom: 10px;
}
.sb-tiles {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px 24px;
}
.sb-tile-label {
  font-size: 10px; color: #888;
  text-transform: uppercase;
}
.sb-tile-big {
  font-size: 18px; font-weight: 600; margin-top: 2px;
}
.sb-tile-sub {
  font-size: 11px; color: #666;
}

@media (max-width: 900px) {
  .sb-tiles { grid-template-columns: repeat(2, 1fr); }
}
```

- [ ] **Step 2: Smoke test**

Reload demo viewer → Scoreboard. Visual check:
- All/CT/T toggle styled with active state
- Player table has uppercase tiny header, denser rows, +/– colored green/red, rating bold-white
- Team stats tile grid renders 4 columns at desktop width, 2 at narrow width
- Layout matches the brainstorm mockup (allowing for minor differences)

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/style.css
git commit -m "feat(scoreboard): style player table + team stats tiles"
```

---

## Task 18: Acceptance smoke test

**Files:** none (manual verification)

- [ ] **Step 1: End-to-end happy path**

1. Pick an existing demo. Open it in the demo viewer.
2. Confirm `Playback` tab loads as before, no regression.
3. Click `Scoreboard`. Player table + team tiles render within ~1s.
4. Click `CT`. Numbers change (kills/deaths shrink). Click `T` — same. Click `All` — totals match `CT + T` for each player (manually spot-check 1 player).
5. Reload the page. The scoreboard re-renders with the last-selected side (localStorage persistence).
6. Open the same demo in a different team's account → confirm RLS blocks (player rows do not load).

- [ ] **Step 2: Empty-state path**

In Supabase, set one demo's `processing_status` to `pending` (won't trigger reparse, just demonstrates state). Open it → click Scoreboard. Should show empty state ("No stats parsed for this demo yet.").

- [ ] **Step 3: Failure-isolation check**

Confirm that a stat compute failure (simulate by raising in `compute_player_stats`) does NOT:
- prevent `match_data` from being written
- block the demo from being marked `completed`
- crash the worker

- [ ] **Step 4: Verify all spec acceptance criteria**

Walk through `docs/superpowers/specs/2026-05-07-demo-stats-design.md` § Acceptance criteria:
- [ ] Schema migrations applied
- [ ] Parser writes 3 rows/player + 2 rows/demo
- [ ] Existing demos backfilled
- [ ] Scoreboard tab next to Playback
- [ ] Side toggle re-queries + persists
- [ ] Player table shows 12 columns with correct formulas (HLTV spot-check)
- [ ] Team stats panel shows 8 tiles
- [ ] Compute failures don't block playback
- [ ] RLS verified — different team can't read data

- [ ] **Step 5: No commit (verification only)**

---

## Self-review notes

- **Spec coverage:** every section of the spec maps to a task. Schema → Task 1; Stat formulas → Tasks 3–10; Parser additions → Tasks 2, 9, 10, 11; UI → Tasks 13–17; Edge cases → covered by `try/except` wrappers in Tasks 9–11 and verified in Task 18; Backfill → Task 12.
- **Scope:** stays within Ship 1. Aggregate page, roster UI, filters, drill-downs are excluded as specified.
- **Open risks acknowledged:**
  - ADR includes both kill damage (from Task 2) and non-fatal damage (from `damage_events`), so should be accurate. If `player_hurt` parsing fails on the VPS demoparser2 version, ADR degrades to kill-damage only — not a blocker.
  - 5v4 detection is approximate (uses min-alive-per-side per round). Permissive by design (per spec).
  - Per-player team grouping (team A vs team B player tables) is simplified to a single rating-sorted table in Ship 1 — splitting into two tables is a polish item that can land later without a schema change.
