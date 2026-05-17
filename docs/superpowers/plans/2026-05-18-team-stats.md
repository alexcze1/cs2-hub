# Team Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Team Stats panel on the demo viewer's Scoreboard tab (both teams side-by-side, single match) and an aggregated Team Stats section on the Results & Review page (our team only, filter-aware, deltas on percentage tiles). Add one new parser metric pair: anti-eco wins/played.

**Architecture:** Parser writes `demo_team_stats` rows at parse-time (already shipped in Ship 1). Add two anti-eco columns. Browser reads via Supabase. Two pure render modules + one pure aggregation module + small wiring changes in `scoreboard.js` and `vods.js`. RLS is already scoped from Ship 1.

**Tech Stack:** Python (`vps/demo_parser.py`, `vps/main.py`, `pytest`), PostgreSQL (Supabase, `psycopg2`), vanilla ES modules (browser, no framework), HTML test files (`*.test.html` loaded directly in browser).

---

## File Structure

**New files (8):**

| Path | Responsibility |
|---|---|
| `cs2-hub/team-stats-aggregate.js` | Pure helpers: sum/aggregate `demo_team_stats` rows, compute deltas. No DOM, no Supabase. |
| `cs2-hub/team-stats-aggregate.test.html` | Tests for above. |
| `cs2-hub/scoreboard-team-stats.js` | Pure render: takes `{ teamA, teamB, teamAName, teamBName }`, emits HTML for the side-by-side panel. |
| `cs2-hub/scoreboard-team-stats.test.html` | Tests for above (DOM-rendered tile verification). |
| `cs2-hub/vods-team-stats.js` | Pure render: takes `{ rowsCurrent, rowsPrior, ourTeamByDemoId }`, emits 11-tile grid with deltas. |
| `cs2-hub/vods-team-stats.test.html` | Tests for above. |

**Modified files (6):**

| Path | Change |
|---|---|
| `cs2-hub/supabase-stats-migration.sql` | Add `anti_eco_wins int, anti_eco_played int` to `demo_team_stats` (idempotent). |
| `vps/demo_parser.py` | Add anti-eco counters inside `compute_team_stats`. |
| `vps/main.py` | Add `anti_eco_wins`/`anti_eco_played` to `_TEAM_STAT_COLS` and the tuple. |
| `vps/tests/test_stats.py` | Add anti-eco unit tests. |
| `cs2-hub/scoreboard.js` | Fetch `demo_team_stats` in parallel; mount panel below player tables. |
| `cs2-hub/vods.html` | Add `<section id="rr-team-stats">` between hero and player-impact. |
| `cs2-hub/vods.js` | Fetch `demo_team_stats`; build `ourTeamByDemoId`; partition rows; render new section. |
| `cs2-hub/style.css` | Styles for `.sb-team-stats-panel`, `.rr-team-stats`, tile grid, delta chip. |

---

## Phase 1 — Parser: add anti-eco columns

### Task 1: Schema migration

**Files:**
- Modify: `cs2-hub/supabase-stats-migration.sql`

- [ ] **Step 1: Add migration lines at end of file**

Open `cs2-hub/supabase-stats-migration.sql` and append:

```sql

-- 6. Ship 3: anti-eco counters (rounds where opponent was on eco)
alter table demo_team_stats add column if not exists anti_eco_wins   int;
alter table demo_team_stats add column if not exists anti_eco_played int;
```

- [ ] **Step 2: Apply migration via Supabase SQL editor**

Copy the two `alter table` lines from above. Run them in the Supabase project's SQL Editor. The `if not exists` makes this idempotent — re-running is safe.

Expected: "Success. No rows returned." for each statement.

- [ ] **Step 3: Verify columns exist**

Run in Supabase SQL Editor:

```sql
select column_name from information_schema.columns
where table_name = 'demo_team_stats' and column_name like 'anti_eco%';
```

Expected output: two rows — `anti_eco_wins`, `anti_eco_played`.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/supabase-stats-migration.sql
git commit -m "feat(stats): add anti_eco_wins/played columns to demo_team_stats"
```

---

### Task 2: Parser — anti-eco counters in `compute_team_stats`

**Files:**
- Modify: `vps/demo_parser.py:1584-1724`
- Test: `vps/tests/test_stats.py`

**Definition recap:** From team A's perspective, `anti_eco_played` = count of rounds where team B's buy was classified as `eco` (NOT `antieco`, NOT `fullbuy`). `anti_eco_wins` = subset of those that team A won. Symmetric for team B.

- [ ] **Step 1: Write failing tests**

Append to `vps/tests/test_stats.py`:

```python
def test_compute_team_stats_counts_anti_eco_when_opponent_ecos():
    """If team B is on eco and team A is on full-buy, team A's anti_eco_played +=1,
    and if A wins, anti_eco_wins +=1. Symmetric for team B."""
    # Round 0: pistol-shaped filler so _is_pistol_round() treats round 1 as non-pistol.
    # Round 1: team A on CT with AK-47s + armor (full-buy), team B on T with pistols
    # only (eco). A wins → a.anti_eco_played=1, a.anti_eco_wins=1.
    parsed = {
        "rounds": [
            {"start_tick": 0, "end_tick": 90, "freeze_end_tick": 10,
             "team_a_side": "ct", "winner_side": "ct"},
            {"start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150,
             "team_a_side": "ct", "winner_side": "ct"},
        ],
        "kills": [],
        "damage_events": [],
        "frames": [
            {"tick": 150, "players": [
                {"steam_id": "A1", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A2", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A3", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A4", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A5", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B1", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B2", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B3", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B4", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B5", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
            ]},
        ],
        "grenades": [],
        "bomb": [],
        "players_meta": {},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_team_stats(parsed)
    a = next(r for r in rows if r["team"] == "a")
    b = next(r for r in rows if r["team"] == "b")
    # A is on full-buy, B is on eco. A wins.
    assert a["anti_eco_played"] == 1, f"expected a.anti_eco_played=1, got {a['anti_eco_played']}"
    assert a["anti_eco_wins"]   == 1, f"expected a.anti_eco_wins=1, got {a['anti_eco_wins']}"
    # B was the eco-er, not the anti-eco-er → its anti_eco_* stay 0.
    assert b["anti_eco_played"] == 0
    assert b["anti_eco_wins"]   == 0


def test_compute_team_stats_anti_eco_not_counted_when_opponent_full_buys():
    """Symmetric full-buys: neither side anti-ecos (regression vs. mis-counting)."""
    parsed = {
        "rounds": [
            {"start_tick": 0, "end_tick": 90, "freeze_end_tick": 10,
             "team_a_side": "ct", "winner_side": "ct"},
            {"start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150,
             "team_a_side": "ct", "winner_side": "ct"},
        ],
        "kills": [], "damage_events": [],
        "frames": [
            {"tick": 150, "players": [
                {"steam_id": "A1", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A2", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A3", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A4", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A5", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B1", "team": "t",  "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B2", "team": "t",  "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B3", "team": "t",  "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B4", "team": "t",  "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B5", "team": "t",  "hp": 100, "weapon": "AK-47", "armor": 100},
            ]},
        ],
        "grenades": [], "bomb": [], "players_meta": {},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_team_stats(parsed)
    a = next(r for r in rows if r["team"] == "a")
    b = next(r for r in rows if r["team"] == "b")
    assert a["anti_eco_played"] == 0
    assert b["anti_eco_played"] == 0


def test_compute_team_stats_anti_eco_loss_counts_played_not_wins():
    """If opponent ecos but we still lose the round, anti_eco_played +=1 but anti_eco_wins stays 0."""
    parsed = {
        "rounds": [
            {"start_tick": 0, "end_tick": 90, "freeze_end_tick": 10,
             "team_a_side": "ct", "winner_side": "ct"},
            {"start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150,
             "team_a_side": "ct", "winner_side": "t"},  # T (=B) wins despite eco
        ],
        "kills": [], "damage_events": [],
        "frames": [
            {"tick": 150, "players": [
                {"steam_id": "A1", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A2", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A3", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A4", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A5", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B1", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B2", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B3", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B4", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B5", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
            ]},
        ],
        "grenades": [], "bomb": [], "players_meta": {},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_team_stats(parsed)
    a = next(r for r in rows if r["team"] == "a")
    assert a["anti_eco_played"] == 1
    assert a["anti_eco_wins"]   == 0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd vps && python -m pytest tests/test_stats.py -k "anti_eco" -v
```

Expected: 3 tests, all FAILING with `KeyError: 'anti_eco_played'` (the dict has no such key yet).

- [ ] **Step 3: Add anti-eco keys to `empty()` initialiser**

In `vps/demo_parser.py` around line 1608 (inside `compute_team_stats`), add two keys to the `empty()` dict (place them right after the `force_wins` / `force_played` line so the team-stat keys stay grouped):

Change from:
```python
                "eco_wins": 0, "eco_played": 0,
                "force_wins": 0, "force_played": 0,
                "full_buy_wins": 0, "full_buy_played": 0,
```

to:
```python
                "eco_wins": 0, "eco_played": 0,
                "force_wins": 0, "force_played": 0,
                "anti_eco_wins": 0, "anti_eco_played": 0,
                "full_buy_wins": 0, "full_buy_played": 0,
```

- [ ] **Step 4: Add counter logic in the round loop**

In the same function, locate the buy-classification block (around line 1680-1694):

```python
            for team, buy, side in ((a, a_buy, a_side), (b, b_buy, b_side)):
                if buy == "eco":
                    team["eco_played"] += 1
                    if winner == side: team["eco_wins"] += 1
                # Ship 1 maps anti-eco buys to the force_* bucket: a true
                # force-buy classifier isn't available yet, and an anti-eco is
                # the closest available proxy. The DB columns stay force_*.
                elif buy == "antieco":
                    team["force_played"] += 1
                    if winner == side: team["force_wins"] += 1
                elif buy == "fullbuy":
                    team["full_buy_played"] += 1
                    if winner == side: team["full_buy_wins"] += 1
```

Immediately after this `for` loop and before the `# Bomb plants/defuses` comment, add:

```python
            # Anti-eco counters: rounds where the OPPONENT was on eco.
            # Independent of what we bought — measures whether we punished an eco.
            if b_buy == "eco":
                a["anti_eco_played"] += 1
                if winner == a_side: a["anti_eco_wins"] += 1
            if a_buy == "eco":
                b["anti_eco_played"] += 1
                if winner == b_side: b["anti_eco_wins"] += 1
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd vps && python -m pytest tests/test_stats.py -k "anti_eco" -v
```

Expected: 3 tests PASS.

- [ ] **Step 6: Run full test suite to confirm no regression**

```bash
cd vps && python -m pytest tests/ -v
```

Expected: all tests pass (existing tests should be unaffected since we only added new keys).

- [ ] **Step 7: Commit**

```bash
git add vps/demo_parser.py vps/tests/test_stats.py
git commit -m "feat(stats): count anti-eco rounds in compute_team_stats"
```

---

### Task 3: Wire anti-eco into the insert tuple

**Files:**
- Modify: `vps/main.py:252-268` and `vps/main.py:315-330`

- [ ] **Step 1: Add columns to `_TEAM_STAT_COLS`**

In `vps/main.py`, locate `_TEAM_STAT_COLS` (around line 253). Change from:

```python
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
    "full_buy_wins", "full_buy_played",
    "bomb_plants", "bomb_defuses",
    "ct_round_wins", "ct_rounds_played",
    "t_round_wins", "t_rounds_played",
)
```

to (insert `anti_eco_*` immediately after `force_*` to keep the buy-classification stats grouped):

```python
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
```

- [ ] **Step 2: Add corresponding tuple values**

Around line 315-330, the `tuples.append((...))` block must match the column order. Change from:

```python
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
                    r.get("full_buy_wins", 0), r.get("full_buy_played", 0),
                    r.get("bomb_plants", 0), r.get("bomb_defuses", 0),
                    r.get("ct_round_wins", 0), r.get("ct_rounds_played", 0),
                    r.get("t_round_wins", 0), r.get("t_rounds_played", 0),
                ))
```

to:

```python
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
```

- [ ] **Step 3: Spot-check column/tuple count match**

Count items in `_TEAM_STAT_COLS` (Python helps):

```bash
cd vps && python -c "from main import _TEAM_STAT_COLS; print(len(_TEAM_STAT_COLS))"
```

Expected output: `31` (29 from Ship 1 + 2 anti-eco).

- [ ] **Step 4: Run the full test suite**

```bash
cd vps && python -m pytest tests/ -v
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add vps/main.py
git commit -m "feat(stats): insert anti_eco_wins/played in demo_team_stats writes"
```

---

### Task 4: Backfill — reparse all existing demos

**Files:** none modified. Operational task.

- [ ] **Step 1: Deploy parser changes to VPS**

Deploy mechanism is project-specific (likely `git pull` on the VPS + restart of the worker service `midround-demo-parser.service`). Confirm with the team how the VPS is updated. If unsure, ask the user before proceeding.

- [ ] **Step 2: Flip every demo back to `pending`**

In the Supabase SQL editor:

```sql
update demos set processing_status = 'pending';
```

This causes the worker to re-pick every demo. Worker is rate-limited and idempotent; existing slim payloads are overwritten and `demo_players` / `demo_team_stats` rows are deleted-then-reinserted (see `write_stats_for_demo` in `main.py`).

- [ ] **Step 3: Verify reparse populated anti-eco columns**

After enough time for the worker to finish (depends on demo count and VPS throughput), run in Supabase:

```sql
select count(*) filter (where anti_eco_played is not null) as populated,
       count(*) as total
from demo_team_stats;
```

Expected: `populated` should equal `total` (or be very close — any zero means the worker hasn't finished or a specific demo failed parse).

- [ ] **Step 4: No commit needed (operational task).**

---

## Phase 2 — Aggregation module

### Task 5: `team-stats-aggregate.js` — pure helpers

**Files:**
- Create: `cs2-hub/team-stats-aggregate.js`
- Test:   `cs2-hub/team-stats-aggregate.test.html`

- [ ] **Step 1: Write the failing test file**

Create `cs2-hub/team-stats-aggregate.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<script type="module">
import { aggregateTeamStats, computeDeltas } from './team-stats-aggregate.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}
function approx(a, b, eps = 0.0005) { return Math.abs(a - b) < eps }

// ---- aggregateTeamStats ----
{
  const out = aggregateTeamStats([])
  assert(out.pistols.played === 0,    'empty rows → pistols.played=0')
  assert(out.pistols.pct === null,    'empty rows → pistols.pct=null')
  assert(out.first_kills === 0,       'empty rows → first_kills=0')
  assert(out.opening_duel.pct === null, 'empty rows → opening_duel.pct=null')
}
{
  // Single demo, our team's row only
  const rows = [{
    pistol_wins: 2, pistol_played: 2,
    five_v_four_wins: 4, five_v_four_played: 5,
    first_kills: 24, first_deaths: 18,
    eco_wins: 1, eco_played: 5,
    force_wins: 2, force_played: 3,
    anti_eco_wins: 4, anti_eco_played: 5,
    full_buy_wins: 12, full_buy_played: 18,
    ct_round_wins: 8, ct_rounds_played: 12,
    t_round_wins:  6, t_rounds_played: 12,
  }]
  const out = aggregateTeamStats(rows)
  assert(out.pistols.wins === 2 && out.pistols.played === 2, 'pistols sum')
  assert(approx(out.pistols.pct, 1.0),                       'pistols.pct=1.0')
  assert(out.five_v_four.wins === 4 && out.five_v_four.played === 5, '5v4 sum')
  assert(approx(out.five_v_four.pct, 0.8),                   '5v4 pct=0.8')
  assert(out.first_kills === 24 && out.first_deaths === 18,  'fk/fd raw counts')
  assert(approx(out.opening_duel.pct, 24/(24+18)),           'opening duel pct')
  assert(out.eco.wins === 1 && out.eco.played === 5,         'eco sum')
  assert(out.force.wins === 2 && out.force.played === 3,     'force sum')
  assert(out.anti_ecos.wins === 4 && out.anti_ecos.played === 5, 'anti-eco sum')
  assert(approx(out.anti_ecos.pct, 0.8),                     'anti-eco pct=0.8')
  assert(out.full_buy.wins === 12 && out.full_buy.played === 18, 'full-buy sum')
  assert(approx(out.ct.pct, 8/12),                           'CT pct')
  assert(approx(out.t.pct, 6/12),                            'T pct')
}
{
  // Two demos sum across rows
  const rows = [
    { pistol_wins: 1, pistol_played: 2, first_kills: 10, first_deaths: 8,
      anti_eco_wins: 2, anti_eco_played: 3, eco_wins: 0, eco_played: 2,
      force_wins: 0, force_played: 0, full_buy_wins: 8, full_buy_played: 14,
      five_v_four_wins: 2, five_v_four_played: 3,
      ct_round_wins: 6, ct_rounds_played: 12, t_round_wins: 5, t_rounds_played: 12 },
    { pistol_wins: 2, pistol_played: 2, first_kills: 12, first_deaths: 6,
      anti_eco_wins: 1, anti_eco_played: 1, eco_wins: 1, eco_played: 4,
      force_wins: 1, force_played: 2, full_buy_wins: 7, full_buy_played: 12,
      five_v_four_wins: 1, five_v_four_played: 2,
      ct_round_wins: 7, ct_rounds_played: 12, t_round_wins: 4, t_rounds_played: 12 },
  ]
  const out = aggregateTeamStats(rows)
  assert(out.pistols.wins === 3 && out.pistols.played === 4, 'pistols sum across demos')
  assert(approx(out.pistols.pct, 0.75),                      'pistols 3/4=0.75')
  assert(out.first_kills === 22 && out.first_deaths === 14,  'fk/fd sum across demos')
  assert(approx(out.opening_duel.pct, 22/(22+14)),           'opening duel pct combined')
  assert(out.anti_ecos.wins === 3 && out.anti_ecos.played === 4, 'anti-eco sum across demos')
}
{
  // Divide-by-zero guards
  const rows = [{
    pistol_wins: 0, pistol_played: 0,
    five_v_four_wins: 0, five_v_four_played: 0,
    first_kills: 0, first_deaths: 0,
    eco_wins: 0, eco_played: 0, force_wins: 0, force_played: 0,
    anti_eco_wins: 0, anti_eco_played: 0,
    full_buy_wins: 0, full_buy_played: 0,
    ct_round_wins: 0, ct_rounds_played: 0,
    t_round_wins: 0, t_rounds_played: 0,
  }]
  const out = aggregateTeamStats(rows)
  assert(out.pistols.pct === null,       'pistols.pct=null when played=0')
  assert(out.five_v_four.pct === null,   '5v4.pct=null when played=0')
  assert(out.opening_duel.pct === null,  'opening duel.pct=null when fk+fd=0')
  assert(out.anti_ecos.pct === null,     'anti-eco.pct=null when played=0')
  assert(out.ct.pct === null,            'CT.pct=null when ct_rounds_played=0')
}
{
  // Null-valued columns (e.g. pre-anti-eco-backfill rows) treated as 0
  const rows = [{
    pistol_wins: 2, pistol_played: 2,
    five_v_four_wins: 1, five_v_four_played: 2,
    first_kills: 10, first_deaths: 8,
    eco_wins: 0, eco_played: 2, force_wins: 0, force_played: 0,
    anti_eco_wins: null, anti_eco_played: null,   // pre-backfill
    full_buy_wins: 5, full_buy_played: 10,
    ct_round_wins: 6, ct_rounds_played: 12, t_round_wins: 5, t_rounds_played: 12,
  }]
  const out = aggregateTeamStats(rows)
  assert(out.anti_ecos.wins === 0 && out.anti_ecos.played === 0, 'null treated as 0')
  assert(out.anti_ecos.pct === null,                              'anti-eco.pct=null when null cols')
  assert(out.pistols.wins === 2,                                  'unaffected by null in other cols')
}

// ---- computeDeltas ----
{
  const current = aggregateTeamStats([{
    pistol_wins: 6, pistol_played: 10, first_kills: 50, first_deaths: 40,
    five_v_four_wins: 8, five_v_four_played: 10, eco_wins: 2, eco_played: 8,
    force_wins: 1, force_played: 3, anti_eco_wins: 6, anti_eco_played: 8,
    full_buy_wins: 30, full_buy_played: 50,
    ct_round_wins: 40, ct_rounds_played: 80, t_round_wins: 35, t_rounds_played: 70,
  }])
  const prior = aggregateTeamStats([{
    pistol_wins: 5, pistol_played: 10, first_kills: 45, first_deaths: 45,
    five_v_four_wins: 7, five_v_four_played: 10, eco_wins: 2, eco_played: 8,
    force_wins: 1, force_played: 3, anti_eco_wins: 5, anti_eco_played: 8,
    full_buy_wins: 25, full_buy_played: 50,
    ct_round_wins: 36, ct_rounds_played: 80, t_round_wins: 30, t_rounds_played: 70,
  }])
  const view = computeDeltas(current, prior)
  // pistols: 0.6 - 0.5 = 0.1
  assert(approx(view.pistols.delta, 0.1),  'pistols delta=+0.1')
  assert(view.pistols.value === current.pistols, 'pistols.value passes through')
  // opening_duel: 50/(50+40) - 45/(45+45) = 0.5555 - 0.5 = 0.0555
  assert(approx(view.opening_duel.delta, 50/90 - 0.5), 'opening duel delta computed')
  // count tiles: no delta
  assert(!('delta' in view.first_kills),  'first_kills has no delta')
  assert(!('delta' in view.first_deaths), 'first_deaths has no delta')
  // force tile: no delta (we deliberately skip it — small sample, no pct)
  assert(!('delta' in view.force),        'force has no delta')
}
{
  // Prior window with < minPlayed rounds → delta=null
  const current = aggregateTeamStats([{
    pistol_wins: 6, pistol_played: 10, first_kills: 50, first_deaths: 40,
    five_v_four_wins: 8, five_v_four_played: 10, eco_wins: 2, eco_played: 8,
    force_wins: 1, force_played: 3, anti_eco_wins: 6, anti_eco_played: 8,
    full_buy_wins: 30, full_buy_played: 50,
    ct_round_wins: 40, ct_rounds_played: 80, t_round_wins: 35, t_rounds_played: 70,
  }])
  const prior = aggregateTeamStats([{
    pistol_wins: 1, pistol_played: 2, first_kills: 5, first_deaths: 4,
    five_v_four_wins: 1, five_v_four_played: 2, eco_wins: 0, eco_played: 1,
    force_wins: 0, force_played: 0, anti_eco_wins: 1, anti_eco_played: 1,
    full_buy_wins: 3, full_buy_played: 5,
    ct_round_wins: 4, ct_rounds_played: 8, t_round_wins: 3, t_rounds_played: 8,
  }])
  const view = computeDeltas(current, prior, { minPlayed: 10 })
  assert(view.pistols.delta === null,    'pistols.delta=null when prior.played<minPlayed')
  assert(view.five_v_four.delta === null,'5v4.delta=null when prior.played<minPlayed')
}
{
  // Empty prior → all deltas null
  const current = aggregateTeamStats([{
    pistol_wins: 2, pistol_played: 2, first_kills: 10, first_deaths: 8,
    five_v_four_wins: 1, five_v_four_played: 2, eco_wins: 0, eco_played: 2,
    force_wins: 0, force_played: 0, anti_eco_wins: 1, anti_eco_played: 1,
    full_buy_wins: 5, full_buy_played: 10,
    ct_round_wins: 6, ct_rounds_played: 12, t_round_wins: 5, t_rounds_played: 12,
  }])
  const prior = aggregateTeamStats([])
  const view = computeDeltas(current, prior)
  assert(view.pistols.delta === null, 'pistols.delta=null when prior is empty')
  assert(view.anti_ecos.delta === null, 'anti-eco.delta=null when prior is empty')
}
</script>
</body>
</html>
```

- [ ] **Step 2: Open the test in a browser to verify FAIL**

```bash
# From repo root, start a static server (only needed once for the session):
cd cs2-hub && python -m http.server 8080
```

Then open: `http://localhost:8080/team-stats-aggregate.test.html`

Expected: all assertions FAIL with `404` (the module file does not exist yet) — open dev console, expect `Failed to load module script` errors.

- [ ] **Step 3: Implement `team-stats-aggregate.js`**

Create `cs2-hub/team-stats-aggregate.js`:

```js
// cs2-hub/team-stats-aggregate.js
//
// Pure helpers to aggregate `demo_team_stats` rows into a team-level summary
// and compute current-vs-prior deltas for the percentage tiles.
// All inputs are arrays of demo_team_stats rows (already filtered to "our team"
// by the caller). No Supabase, no DOM.

// Sum field pairs (wins, played) for a list of rows.
function sumWinsPlayed(rows, winsKey, playedKey) {
  let wins = 0, played = 0
  for (const r of rows || []) {
    wins   += r[winsKey]   || 0
    played += r[playedKey] || 0
  }
  return { wins, played }
}

function pct(wins, played) {
  return played > 0 ? wins / played : null
}

// Sum a single counter across rows.
function sumOne(rows, key) {
  let n = 0
  for (const r of rows || []) n += r[key] || 0
  return n
}

// Aggregate a list of demo_team_stats rows (one per demo, our team's row only).
// Returns a shape with one entry per tile:
//   percentage tiles → { wins, played, pct }
//   force tile       → { wins, played }   (no pct — sample size too small)
//   count tiles      → number
//   opening_duel     → { pct } derived from first_kills + first_deaths
export function aggregateTeamStats(rows) {
  const pistols      = sumWinsPlayed(rows, 'pistol_wins',       'pistol_played')
  const five_v_four  = sumWinsPlayed(rows, 'five_v_four_wins',  'five_v_four_played')
  const eco          = sumWinsPlayed(rows, 'eco_wins',          'eco_played')
  const force        = sumWinsPlayed(rows, 'force_wins',        'force_played')
  const anti_ecos    = sumWinsPlayed(rows, 'anti_eco_wins',     'anti_eco_played')
  const full_buy     = sumWinsPlayed(rows, 'full_buy_wins',     'full_buy_played')
  const ct           = sumWinsPlayed(rows, 'ct_round_wins',     'ct_rounds_played')
  const t            = sumWinsPlayed(rows, 't_round_wins',      't_rounds_played')

  const first_kills  = sumOne(rows, 'first_kills')
  const first_deaths = sumOne(rows, 'first_deaths')
  const openTotal    = first_kills + first_deaths
  const opening_duel = { pct: openTotal > 0 ? first_kills / openTotal : null }

  return {
    pistols:      { ...pistols,     pct: pct(pistols.wins,     pistols.played) },
    anti_ecos:    { ...anti_ecos,   pct: pct(anti_ecos.wins,   anti_ecos.played) },
    eco:          { ...eco,         pct: pct(eco.wins,         eco.played) },
    force:        { ...force },  // no pct
    full_buy:     { ...full_buy,    pct: pct(full_buy.wins,    full_buy.played) },
    first_kills,
    first_deaths,
    opening_duel,
    five_v_four:  { ...five_v_four, pct: pct(five_v_four.wins, five_v_four.played) },
    ct:           { ...ct,          pct: pct(ct.wins,          ct.played) },
    t:            { ...t,           pct: pct(t.wins,           t.played) },
  }
}

// Build a view object that pairs each tile's current value with a delta vs prior.
// Deltas are computed only for percentage tiles.
// `minPlayed` suppresses deltas when the prior sample is too small.
export function computeDeltas(current, prior, { minPlayed = 10 } = {}) {
  function withDelta(curKey, priorKey = curKey) {
    const cur = current[curKey]
    const pr  = prior[priorKey]
    const delta = (pr && pr.played >= minPlayed && cur.pct != null && pr.pct != null)
      ? cur.pct - pr.pct
      : null
    return { value: cur, delta }
  }
  function withoutDelta(curKey) {
    return { value: current[curKey] }
  }
  function openingDelta() {
    const cur = current.opening_duel
    const pr  = prior.opening_duel
    const priorTotal = (prior.first_kills || 0) + (prior.first_deaths || 0)
    const delta = (priorTotal >= minPlayed && cur.pct != null && pr.pct != null)
      ? cur.pct - pr.pct
      : null
    return { value: cur, delta }
  }
  return {
    pistols:      withDelta('pistols'),
    anti_ecos:    withDelta('anti_ecos'),
    eco:          withDelta('eco'),
    force:        withoutDelta('force'),
    full_buy:     withDelta('full_buy'),
    first_kills:  current.first_kills,
    first_deaths: current.first_deaths,
    opening_duel: openingDelta(),
    five_v_four:  withDelta('five_v_four'),
    ct:           withDelta('ct'),
    t:            withDelta('t'),
  }
}
```

- [ ] **Step 4: Reload the test page in browser to verify PASS**

Reload `http://localhost:8080/team-stats-aggregate.test.html`. Open dev console.

Expected: all `PASS:` lines, zero `FAIL:` lines.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/team-stats-aggregate.js cs2-hub/team-stats-aggregate.test.html
git commit -m "feat(stats): pure team-stats aggregation + delta helpers"
```

---

## Phase 3 — Demo scoreboard panel

### Task 6: `scoreboard-team-stats.js` — pure render module

**Files:**
- Create: `cs2-hub/scoreboard-team-stats.js`
- Test:   `cs2-hub/scoreboard-team-stats.test.html`

- [ ] **Step 1: Write the failing test file**

Create `cs2-hub/scoreboard-team-stats.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<div id="root"></div>
<script type="module">
import { renderTeamStats } from './scoreboard-team-stats.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}

const fullA = {
  team: 'a',
  pistol_wins: 2, pistol_played: 2,
  five_v_four_wins: 3, five_v_four_played: 5,
  first_kills: 24, first_deaths: 18,
  eco_wins: 1, eco_played: 4, force_wins: 0, force_played: 2,
  anti_eco_wins: 3, anti_eco_played: 4,
  full_buy_wins: 12, full_buy_played: 18,
  ct_round_wins: 8, ct_rounds_played: 12,
  t_round_wins: 4,  t_rounds_played: 12,
}
const fullB = {
  team: 'b',
  pistol_wins: 0, pistol_played: 2,
  five_v_four_wins: 2, five_v_four_played: 5,
  first_kills: 18, first_deaths: 24,
  eco_wins: 0, eco_played: 4, force_wins: 1, force_played: 2,
  anti_eco_wins: 1, anti_eco_played: 4,
  full_buy_wins: 6, full_buy_played: 18,
  ct_round_wins: 8,  ct_rounds_played: 12,
  t_round_wins:  4,  t_rounds_played: 12,
}

// ---- Happy path ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  renderTeamStats(root, { teamA: fullA, teamB: fullB, teamAName: 'Forma', teamBName: 'NAVI' })
  const html = root.innerHTML
  assert(html.includes('Pistols'),         'tile label Pistols')
  assert(html.includes('Anti-ecos'),       'tile label Anti-ecos')
  assert(html.includes('Eco wins'),        'tile label Eco wins')
  assert(html.includes('Force-buy wins'),  'tile label Force-buy wins')
  assert(html.includes('Full-buy wins'),   'tile label Full-buy wins')
  assert(html.includes('First kills'),     'tile label First kills')
  assert(html.includes('First deaths'),    'tile label First deaths')
  assert(html.includes('Opening duel'),    'tile label Opening duel W%')
  assert(html.includes('5v4 conversion'),  'tile label 5v4 conversion')
  assert(html.includes('CT win rate'),     'tile label CT win rate')
  assert(html.includes('T win rate'),      'tile label T win rate')
  assert(html.includes('Forma'),           'team A name header')
  assert(html.includes('NAVI'),            'team B name header')
  // 2/2 = 100%
  assert(html.includes('100%'),            'A pistols 2/2 = 100%')
  // first kills count
  assert(html.includes('>24<'),            'A first_kills value rendered')
}

// ---- Divide-by-zero ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const zero = { ...fullA, pistol_wins: 0, pistol_played: 0 }
  renderTeamStats(root, { teamA: zero, teamB: fullB, teamAName: 'A', teamBName: 'B' })
  // pistols column for A should render —, not NaN or 0/0
  assert(!root.innerHTML.includes('NaN'), 'no NaN')
  // Verify the dash appears (we render `—` for divide-by-zero)
  assert(root.innerHTML.includes('—'),    'em-dash for divide-by-zero')
}

// ---- One team missing ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  renderTeamStats(root, { teamA: fullA, teamB: null, teamAName: 'Forma', teamBName: 'NAVI' })
  assert(root.innerHTML.includes('Forma'), 'team A still renders')
  // Team B column should show — placeholders rather than blank
  assert(root.innerHTML.includes('—'),     'team B column shows — placeholders')
}

// ---- Both teams missing ----
{
  const root = document.getElementById('root')
  root.innerHTML = 'WAS HERE'
  renderTeamStats(root, { teamA: null, teamB: null, teamAName: 'A', teamBName: 'B' })
  assert(root.innerHTML === '',  'both missing → empty render (no-op)')
}

// ---- Name escaping ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  renderTeamStats(root, { teamA: fullA, teamB: fullB, teamAName: '<script>x</script>', teamBName: 'OK' })
  assert(!root.innerHTML.includes('<script>x</script>'), 'team name HTML-escaped')
}
</script>
</body>
</html>
```

- [ ] **Step 2: Verify the test FAILS in browser**

Open `http://localhost:8080/scoreboard-team-stats.test.html` (server still running from earlier). Expect module-load failure in console.

- [ ] **Step 3: Implement `scoreboard-team-stats.js`**

Create `cs2-hub/scoreboard-team-stats.js`:

```js
// cs2-hub/scoreboard-team-stats.js
//
// Renders the side-by-side Team Stats panel beneath the player tables in
// the demo viewer's Scoreboard tab. Pure render — no fetching, no state.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function pct(wins, played) {
  if (played == null || played === 0) return null
  return wins / played
}

function fmtPct(p) {
  if (p == null) return '—'
  return `${Math.round(p * 100)}%`
}

function fmtWL(wins, played) {
  if (played == null || played === 0) return '—'
  return `${wins}–${played - wins}`
}

// "4–3 (57%)" / "—" if no rounds played
function fmtWLPct(wins, played) {
  const wl = fmtWL(wins, played)
  if (wl === '—') return '—'
  return `${wl} (${fmtPct(pct(wins, played))})`
}

function fmtCount(n) { return n == null ? '—' : String(n) }

// 11 tile definitions. Each one knows how to extract its value from a team row.
// `format` returns the display string for the given side; null rows → '—'.
const TILES = [
  { label: 'Pistols',         format: r => r ? fmtWLPct(r.pistol_wins,      r.pistol_played)     : '—' },
  { label: 'Anti-ecos',       format: r => r ? fmtWLPct(r.anti_eco_wins,    r.anti_eco_played)   : '—' },
  { label: 'Eco wins',        format: r => r ? fmtWLPct(r.eco_wins,         r.eco_played)        : '—' },
  { label: 'Force-buy wins',  format: r => r ? fmtWL(r.force_wins,          r.force_played)      : '—' },
  { label: 'Full-buy wins',   format: r => r ? fmtWLPct(r.full_buy_wins,    r.full_buy_played)   : '—' },
  { label: 'First kills',     format: r => r ? fmtCount(r.first_kills)  : '—' },
  { label: 'First deaths',    format: r => r ? fmtCount(r.first_deaths) : '—' },
  { label: 'Opening duel W%', format: r => {
      if (!r) return '—'
      const total = (r.first_kills || 0) + (r.first_deaths || 0)
      return fmtPct(total > 0 ? r.first_kills / total : null)
    } },
  { label: '5v4 conversion',  format: r => r ? fmtWLPct(r.five_v_four_wins, r.five_v_four_played) : '—' },
  { label: 'CT win rate',     format: r => r ? fmtWLPct(r.ct_round_wins,    r.ct_rounds_played)   : '—' },
  { label: 'T win rate',      format: r => r ? fmtWLPct(r.t_round_wins,     r.t_rounds_played)    : '—' },
]

export function renderTeamStats(container, { teamA, teamB, teamAName, teamBName }) {
  if (!container) return
  if (!teamA && !teamB) {
    container.innerHTML = ''
    return
  }
  const rows = TILES.map(t => `
    <tr>
      <td class="sb-ts-a">${esc(t.format(teamA))}</td>
      <td class="sb-ts-label">${esc(t.label)}</td>
      <td class="sb-ts-b">${esc(t.format(teamB))}</td>
    </tr>
  `).join('')

  container.innerHTML = `
    <div class="sb-team-stats-panel">
      <div class="sb-ts-header">
        <span class="sb-ts-name sb-ts-name-a">${esc(teamAName || 'Team A')}</span>
        <span class="sb-ts-title">Team Stats</span>
        <span class="sb-ts-name sb-ts-name-b">${esc(teamBName || 'Team B')}</span>
      </div>
      <table class="sb-ts-table">
        <tbody>${rows}</tbody>
      </table>
    </div>
  `
}
```

- [ ] **Step 4: Reload the test page to verify PASS**

Reload `http://localhost:8080/scoreboard-team-stats.test.html`. Open dev console — all `PASS:`, zero `FAIL:`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/scoreboard-team-stats.js cs2-hub/scoreboard-team-stats.test.html
git commit -m "feat(stats): scoreboard team stats panel render module"
```

---

### Task 7: Wire panel into `scoreboard.js`

**Files:**
- Modify: `cs2-hub/scoreboard.js`

- [ ] **Step 1: Add the team-stats fetch**

In `cs2-hub/scoreboard.js`, find the `Promise.all([...])` block around lines 18-27. Replace the entire `mountScoreboard` async block with:

```js
export async function mountScoreboard(root, demoId) {
  if (!root || !demoId) return
  const side = localStorage.getItem(SIDE_KEY) || 'all'

  root.innerHTML = `<div class="sb-loading">Loading stats…</div>`

  try {
    const [
      { data: players,   error: pe },
      { data: demo,      error: de },
      { data: teamStats, error: te },
    ] = await Promise.all([
      supabase.from('demo_players')
        .select('*').eq('demo_id', demoId),
      supabase.from('demos')
        .select('ct_team_name,t_team_name,team_a_first_side')
        .eq('id', demoId).maybeSingle(),
      supabase.from('demo_team_stats')
        .select('*').eq('demo_id', demoId),
    ])
    if (pe) throw pe
    if (de) throw de
    if (te) throw te

    const cleanPlayers = (players || []).filter(p => !isCoach(p.name))
    if (!cleanPlayers.length) {
      root.innerHTML = `<div class="sb-empty">No stats parsed for this demo yet.</div>`
      return
    }

    const aOnCtFirst = (demo?.team_a_first_side ?? 'ct') === 'ct'
    const teamAName = (aOnCtFirst ? demo?.ct_team_name : demo?.t_team_name) || 'Team A'
    const teamBName = (aOnCtFirst ? demo?.t_team_name  : demo?.ct_team_name) || 'Team B'

    const teamA = (teamStats || []).find(r => r.team === 'a') || null
    const teamB = (teamStats || []).find(r => r.team === 'b') || null

    render(root, { players: cleanPlayers, side, teamAName, teamBName, teamA, teamB })
  } catch (e) {
    console.error('[scoreboard]', e)
    root.innerHTML = `<div class="sb-empty">Failed to load stats: ${esc(e.message || String(e))}</div>`
  }
}
```

- [ ] **Step 2: Update `render()` to pass through `teamA`/`teamB`**

Replace the existing `render` function and `renderPlayerTables` invocation. Find:

```js
function render(root, state) {
  const { players, side, teamAName, teamBName } = state
  root.innerHTML = `
    <div class="sb-toolbar">
      <span class="sb-label">View</span>
      <button class="sb-side-btn ${side==='all'?'is-active':''}" data-side="all">All</button>
      <button class="sb-side-btn ${side==='ct'?'is-active':''}"  data-side="ct">CT</button>
      <button class="sb-side-btn ${side==='t'?'is-active':''}"   data-side="t">T</button>
    </div>
    <div id="sb-tables"></div>
  `
  for (const btn of root.querySelectorAll('.sb-side-btn')) {
    btn.addEventListener('click', () => {
      const newSide = btn.dataset.side
      localStorage.setItem(SIDE_KEY, newSide)
      render(root, { ...state, side: newSide })
    })
  }
  renderPlayerTables(root.querySelector('#sb-tables'), players, side, teamAName, teamBName)
}
```

Replace with:

```js
function render(root, state) {
  const { players, side, teamAName, teamBName, teamA, teamB } = state
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
  renderPlayerTables(root.querySelector('#sb-tables'), players, side, teamAName, teamBName)
  renderTeamStats(root.querySelector('#sb-team-stats'), { teamA, teamB, teamAName, teamBName })
}
```

- [ ] **Step 3: Add the import at the top of the file**

Find the existing imports near the top of `cs2-hub/scoreboard.js`:

```js
import { supabase } from './supabase.js'
import { isCoach } from './demo-player-filters.js'
```

Add a third import:

```js
import { supabase } from './supabase.js'
import { isCoach } from './demo-player-filters.js'
import { renderTeamStats } from './scoreboard-team-stats.js'
```

- [ ] **Step 4: Manual smoke test in browser**

With the static server still running (`cd cs2-hub && python -m http.server 8080`), navigate to a demo viewer URL in the browser, e.g. `http://localhost:8080/demo-viewer.html?id=<known-demo-uuid>`. If you don't know a demo UUID, ask the user — or open `demos.html` in the browser to pick one and copy the link. Click the Scoreboard tab.

Expected:
- Player tables for Team A and Team B render as before.
- BELOW them, a Team Stats panel appears with both team names and 11 rows.
- Numbers look sensible (pistols 0-2 / 1-2, etc).
- If anti-eco columns are still null for a not-yet-reparsed demo, the Anti-ecos row shows `—`/`—`.

If the panel doesn't appear:
- Check the Network tab for the `demo_team_stats` request — must return 200 with data.
- Check console for module-load errors.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/scoreboard.js
git commit -m "feat(stats): mount team stats panel in demo viewer scoreboard"
```

---

### Task 8: Scoreboard panel styles

**Files:**
- Modify: `cs2-hub/style.css` (append)

- [ ] **Step 1: Append styles**

Append to `cs2-hub/style.css`:

```css

/* ── Demo scoreboard: team stats panel ──────────────────── */
.sb-team-stats-panel {
  margin-top: 22px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow:
    inset 1px 1px 0 rgba(255,255,255,0.04),
    0 8px 32px rgba(0,0,0,0.35);
  overflow: hidden;
}
.sb-ts-header {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--glass-border);
  font-family: var(--display-font);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
.sb-ts-name      { font-weight: 700; }
.sb-ts-name-a    { text-align: left;  color: var(--side-ct); }
.sb-ts-name-b    { text-align: right; color: var(--side-t); }
.sb-ts-title     {
  text-align: center;
  color: var(--text-variant);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.sb-ts-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.sb-ts-table td {
  padding: 8px 18px;
  border-bottom: 1px solid var(--glass-border);
  font-size: 14px;
}
.sb-ts-table tbody tr:last-child td { border-bottom: none; }
.sb-ts-a        { text-align: left;   color: var(--text); }
.sb-ts-b        { text-align: right;  color: var(--text); }
.sb-ts-label    {
  text-align: center;
  color: var(--text-variant);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 600;
  white-space: nowrap;
  padding-left: 24px;
  padding-right: 24px;
}
```

- [ ] **Step 2: Reload the demo viewer in browser**

Refresh the same Scoreboard tab from Task 7. Expected:
- Panel matches the existing `.sb-team-block` visual language (glass background, blur, accent borders).
- Team A column left-aligned in CT blue, Team B column right-aligned in T orange, labels muted in the middle.
- Numbers line up via tabular numerals.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/style.css
git commit -m "style(stats): scoreboard team stats panel"
```

---

## Phase 4 — Results page section

### Task 9: `vods-team-stats.js` — render module

**Files:**
- Create: `cs2-hub/vods-team-stats.js`
- Test:   `cs2-hub/vods-team-stats.test.html`

- [ ] **Step 1: Write the failing test file**

Create `cs2-hub/vods-team-stats.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<div id="root"></div>
<script type="module">
import { renderTeamStats } from './vods-team-stats.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}

function rowsForOurTeam({ pistol_wins=0, pistol_played=0, first_kills=0, first_deaths=0,
  five_v_four_wins=0, five_v_four_played=0, eco_wins=0, eco_played=0,
  force_wins=0, force_played=0, anti_eco_wins=0, anti_eco_played=0,
  full_buy_wins=0, full_buy_played=0,
  ct_round_wins=0, ct_rounds_played=0, t_round_wins=0, t_rounds_played=0,
  demo_id='d1' }) {
  return { demo_id, team: 'a', pistol_wins, pistol_played, first_kills, first_deaths,
    five_v_four_wins, five_v_four_played, eco_wins, eco_played,
    force_wins, force_played, anti_eco_wins, anti_eco_played,
    full_buy_wins, full_buy_played,
    ct_round_wins, ct_rounds_played, t_round_wins, t_rounds_played }
}

// ---- Happy path: current rows only, no deltas ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const rowsCurrent = [rowsForOurTeam({
    pistol_wins: 6, pistol_played: 10, first_kills: 50, first_deaths: 40,
    five_v_four_wins: 8, five_v_four_played: 10, eco_wins: 2, eco_played: 8,
    force_wins: 1, force_played: 3, anti_eco_wins: 6, anti_eco_played: 8,
    full_buy_wins: 30, full_buy_played: 50,
    ct_round_wins: 40, ct_rounds_played: 80, t_round_wins: 35, t_rounds_played: 70,
  })]
  const ourTeamByDemoId = new Map([['d1', 'a']])
  renderTeamStats(root, { rowsCurrent, rowsPrior: [], ourTeamByDemoId })
  const html = root.innerHTML
  assert(html.includes('Pistols'),         'tile Pistols renders')
  assert(html.includes('Anti-ecos'),       'tile Anti-ecos renders')
  assert(html.includes('60%'),             'pistols 6/10 → 60%')
  assert(html.includes('75%'),             'anti-eco 6/8 → 75%')
  // count tiles
  assert(html.includes('>50<'),            'first_kills count')
  assert(html.includes('>40<'),            'first_deaths count')
  // no delta chips when prior is empty
  assert(!html.includes('rr-trend-up') && !html.includes('rr-trend-down'),
    'no delta chips when prior empty')
}

// ---- Empty current → renders nothing ----
{
  const root = document.getElementById('root')
  root.innerHTML = 'WAS HERE'
  renderTeamStats(root, { rowsCurrent: [], rowsPrior: [], ourTeamByDemoId: new Map() })
  assert(root.innerHTML === '', 'no rows → empty render')
}

// ---- Deltas appear on percentage tiles when prior has enough sample ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const rowsCurrent = [rowsForOurTeam({
    pistol_wins: 6, pistol_played: 10, first_kills: 50, first_deaths: 40,
    five_v_four_wins: 8, five_v_four_played: 10, eco_wins: 2, eco_played: 8,
    force_wins: 1, force_played: 3, anti_eco_wins: 6, anti_eco_played: 8,
    full_buy_wins: 30, full_buy_played: 50,
    ct_round_wins: 40, ct_rounds_played: 80, t_round_wins: 35, t_rounds_played: 70,
  })]
  const rowsPrior = [rowsForOurTeam({
    demo_id: 'd2',
    pistol_wins: 5, pistol_played: 10, first_kills: 45, first_deaths: 45,
    five_v_four_wins: 7, five_v_four_played: 10, eco_wins: 2, eco_played: 8,
    force_wins: 1, force_played: 3, anti_eco_wins: 5, anti_eco_played: 8,
    full_buy_wins: 25, full_buy_played: 50,
    ct_round_wins: 36, ct_rounds_played: 80, t_round_wins: 30, t_rounds_played: 70,
  })]
  const ourTeamByDemoId = new Map([['d1', 'a'], ['d2', 'a']])
  renderTeamStats(root, { rowsCurrent, rowsPrior, ourTeamByDemoId })
  const html = root.innerHTML
  // pistols delta = +10% (0.6 - 0.5)
  assert(html.includes('rr-trend-up'),  'up trend chip rendered when current > prior')
  // count tiles still have no delta visual
  // (we can't easily inspect per-tile here, but verify the chip total is ≤ 8 percentage tiles)
  const upCount = (html.match(/rr-trend-up/g)   || []).length
  const downCount = (html.match(/rr-trend-down/g) || []).length
  assert(upCount + downCount >= 1 && upCount + downCount <= 8,
    `delta chip count in [1,8], got ${upCount + downCount}`)
}

// ---- Demo with no ourTeamByDemoId entry is excluded ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const rowsCurrent = [
    rowsForOurTeam({ demo_id: 'd1', pistol_wins: 2, pistol_played: 2 }),  // ours
    { demo_id: 'd-orphan', team: 'a', pistol_wins: 99, pistol_played: 99,
      first_kills: 0, first_deaths: 0,
      five_v_four_wins: 0, five_v_four_played: 0, eco_wins: 0, eco_played: 0,
      force_wins: 0, force_played: 0, anti_eco_wins: 0, anti_eco_played: 0,
      full_buy_wins: 0, full_buy_played: 0,
      ct_round_wins: 0, ct_rounds_played: 0, t_round_wins: 0, t_rounds_played: 0 },  // no map entry
  ]
  const ourTeamByDemoId = new Map([['d1', 'a']])
  renderTeamStats(root, { rowsCurrent, rowsPrior: [], ourTeamByDemoId })
  // Only the d1 row should contribute → 2/2 pistols = 100%, not 101/101.
  assert(root.innerHTML.includes('100%'),  'orphan demo (no ourTeamByDemoId entry) excluded')
  assert(!root.innerHTML.includes('101'),  'orphan demo data not summed in')
}

// ---- Wrong-team row excluded (their team='a' but we're 'b' for that demo) ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const rowsCurrent = [
    rowsForOurTeam({ demo_id: 'd1', pistol_wins: 2, pistol_played: 2 }),       // ours team=a
    { demo_id: 'd2', team: 'a', pistol_wins: 0, pistol_played: 2, first_kills: 0, first_deaths: 0,
      five_v_four_wins: 0, five_v_four_played: 0, eco_wins: 0, eco_played: 0,
      force_wins: 0, force_played: 0, anti_eco_wins: 0, anti_eco_played: 0,
      full_buy_wins: 0, full_buy_played: 0,
      ct_round_wins: 0, ct_rounds_played: 0, t_round_wins: 0, t_rounds_played: 0 },  // not ours (we're 'b' on d2)
  ]
  const ourTeamByDemoId = new Map([['d1', 'a'], ['d2', 'b']])
  renderTeamStats(root, { rowsCurrent, rowsPrior: [], ourTeamByDemoId })
  // Only d1's row contributes → 2/2 = 100%
  assert(root.innerHTML.includes('100%'),  'wrong-side row excluded')
}
</script>
</body>
</html>
```

- [ ] **Step 2: Verify the test FAILS in browser**

Open `http://localhost:8080/vods-team-stats.test.html`. Expect module-load failures.

- [ ] **Step 3: Implement `vods-team-stats.js`**

Create `cs2-hub/vods-team-stats.js`:

```js
// cs2-hub/vods-team-stats.js
//
// Renders the aggregated Team Stats section on Results & Review.
// Reads demo_team_stats rows filtered to "our team" via ourTeamByDemoId,
// runs them through team-stats-aggregate, and emits an 11-tile grid.
// Percentage tiles get a trend chip when prior window has enough sample.

import { aggregateTeamStats, computeDeltas } from './team-stats-aggregate.js'

const TREND_ARROW = { up: '↗', down: '↘', flat: '▬' }
const DELTA_THRESHOLD = 0.005  // ignore deltas under 0.5% as flat

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

function fmtPct(p) { return p == null ? '—' : `${Math.round(p * 100)}%` }
function fmtWL(wins, played) {
  if (played == null || played === 0) return '—'
  return `${wins}–${played - wins}`
}
function fmtCount(n) { return n == null ? '—' : String(n) }

// "14–7 67%" or "—"
function fmtWLPct(wins, played, pct) {
  const wl = fmtWL(wins, played)
  if (wl === '—') return '—'
  return `${wl}  ${fmtPct(pct)}`
}

function trendClass(delta) {
  if (delta == null) return null
  if (delta >  DELTA_THRESHOLD) return 'up'
  if (delta < -DELTA_THRESHOLD) return 'down'
  return 'flat'
}

function trendChip(delta) {
  const cls = trendClass(delta)
  if (cls == null) return ''
  const sign = delta > 0 ? '+' : ''
  return `<span class="rr-trend rr-trend-${cls}">${TREND_ARROW[cls]} ${sign}${Math.round(delta * 100)}%</span>`
}

// Filter input rows to "our team" rows (using ourTeamByDemoId Map).
function ourRows(rows, ourTeamByDemoId) {
  if (!rows) return []
  return rows.filter(r => {
    const ours = ourTeamByDemoId?.get(r.demo_id)
    return ours && ours === r.team
  })
}

// Tile descriptors. Each one knows how to render itself from the `view` object
// returned by computeDeltas (or directly from `current` for the count tiles).
// `kind`: 'pct'   → { wins, played, pct } + optional delta
//         'count' → number, no delta
//         'wl'    → { wins, played } no pct, no delta (force-buy)
function tileDescriptors(view) {
  return [
    { label: 'Pistols',        kind: 'pct',   value: view.pistols.value,     delta: view.pistols.delta },
    { label: 'Anti-ecos',      kind: 'pct',   value: view.anti_ecos.value,   delta: view.anti_ecos.delta },
    { label: 'Eco wins',       kind: 'pct',   value: view.eco.value,         delta: view.eco.delta },
    { label: 'Force-buy wins', kind: 'wl',    value: view.force.value },
    { label: 'Full-buy wins',  kind: 'pct',   value: view.full_buy.value,    delta: view.full_buy.delta },
    { label: 'First kills',    kind: 'count', value: view.first_kills },
    { label: 'First deaths',   kind: 'count', value: view.first_deaths },
    { label: 'Opening duel W%', kind: 'pct-only', value: view.opening_duel.value, delta: view.opening_duel.delta },
    { label: '5v4 conversion', kind: 'pct',   value: view.five_v_four.value, delta: view.five_v_four.delta },
    { label: 'CT win rate',    kind: 'pct',   value: view.ct.value,          delta: view.ct.delta },
    { label: 'T win rate',     kind: 'pct',   value: view.t.value,           delta: view.t.delta },
  ]
}

function renderTile(t) {
  let valueHtml
  if (t.kind === 'pct') {
    valueHtml = `<div class="stat-value">${fmtWLPct(t.value.wins, t.value.played, t.value.pct)}</div>`
  } else if (t.kind === 'wl') {
    valueHtml = `<div class="stat-value">${fmtWL(t.value.wins, t.value.played)}</div>`
  } else if (t.kind === 'count') {
    valueHtml = `<div class="stat-value">${fmtCount(t.value)}</div>`
  } else if (t.kind === 'pct-only') {
    valueHtml = `<div class="stat-value">${fmtPct(t.value.pct)}</div>`
  }
  const chip = (t.kind === 'pct' || t.kind === 'pct-only') ? trendChip(t.delta) : ''
  return `
    <div class="stat-card rr-team-stat">
      <div class="stat-label">${esc(t.label)}${chip}</div>
      ${valueHtml}
    </div>
  `
}

export function renderTeamStats(container, { rowsCurrent, rowsPrior, ourTeamByDemoId }) {
  if (!container) return
  const ourCur = ourRows(rowsCurrent, ourTeamByDemoId)
  if (ourCur.length === 0) {
    container.innerHTML = ''
    return
  }
  const ourPrior = ourRows(rowsPrior, ourTeamByDemoId)
  const current = aggregateTeamStats(ourCur)
  const prior   = aggregateTeamStats(ourPrior)
  const view    = computeDeltas(current, prior)
  const tiles   = tileDescriptors(view).map(renderTile).join('')

  container.innerHTML = `
    <div class="rr-team-stats">
      <div class="rr-section-label">TEAM STATS</div>
      <div class="rr-team-stats-grid">${tiles}</div>
    </div>
  `
}
```

- [ ] **Step 4: Reload the test page to verify PASS**

Open `http://localhost:8080/vods-team-stats.test.html`. Console: all `PASS:`, zero `FAIL:`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/vods-team-stats.js cs2-hub/vods-team-stats.test.html
git commit -m "feat(stats): results-page team stats render module"
```

---

### Task 10: Wire section into `vods.html` + `vods.js`

**Files:**
- Modify: `cs2-hub/vods.html`
- Modify: `cs2-hub/vods.js`

- [ ] **Step 1: Add the section to `vods.html`**

In `cs2-hub/vods.html`, find the `<main class="main-content">` block (lines 14-20). Insert a new section between `#rr-hero` and `#rr-player-impact`:

```html
  <main class="main-content">
    <section id="rr-hero" class="rr-hero"><div class="loading">Loading…</div></section>
    <section id="rr-team-stats" class="rr-section"></section>
    <section id="rr-player-impact" class="rr-section"></section>
    <section id="rr-player-panel-slot" class="rr-section"></section>
    <section id="rr-map-pool" class="rr-section"></section>
    <section id="rr-match-reports" class="rr-section"></section>
  </main>
```

- [ ] **Step 2: Add the import in `vods.js`**

In `cs2-hub/vods.js`, find the import block at the top (lines 7-18). After:

```js
import { renderMapPool } from './vods-map-pool.js'
```

add:

```js
import { renderTeamStats } from './vods-team-stats.js'
```

- [ ] **Step 3: Fetch `demo_team_stats` in `fetchDemosForVodWindow`**

In `cs2-hub/vods.js`, locate `fetchDemosForVodWindow` (around lines 128-178). Find this block (around lines 162-167):

```js
  const { data: rows, error: e3 } = await supabase
    .from('demo_players')
    .select('*')
    .in('demo_id', demos.map(d => d.id))
    .in('steam_id', [...teamSteamIds])
  if (e3) throw e3
```

Add a parallel fetch + `ourTeamByDemoId` derivation. Replace from line 162 through the end of the function (`return { demos: demos || [], rowsAll, rowsCT, rowsT, demoToVod, demosById }`) with:

```js
  const demoIds = demos.map(d => d.id)
  const [{ data: rows, error: e3 }, { data: teamStatsRows, error: e4 }] = await Promise.all([
    supabase.from('demo_players')
      .select('*')
      .in('demo_id', demoIds)
      .in('steam_id', [...teamSteamIds]),
    supabase.from('demo_team_stats')
      .select('*')
      .in('demo_id', demoIds),
  ])
  if (e3) throw e3
  if (e4) throw e4

  const demosById = new Map((demos || []).map(d => [d.id, d]))
  for (const r of rows || []) {
    const d = demosById.get(r.demo_id)
    r.map = d?.map ?? null
  }
  const rowsAll = (rows || []).filter(r => r.side === 'all')
  const rowsCT  = (rows || []).filter(r => r.side === 'ct')
  const rowsT   = (rows || []).filter(r => r.side === 't')

  // Build ourTeamByDemoId: any of our roster's demo_players rows tells us
  // which team ('a' or 'b') we are for that demo. side='all' is enough.
  const ourTeamByDemoId = new Map()
  for (const r of rowsAll) {
    if (!ourTeamByDemoId.has(r.demo_id) && (r.team === 'a' || r.team === 'b')) {
      ourTeamByDemoId.set(r.demo_id, r.team)
    }
  }

  return {
    demos: demos || [], rowsAll, rowsCT, rowsT,
    demoToVod, demosById,
    teamStatsRows: teamStatsRows || [],
    ourTeamByDemoId,
  }
```

Also update the early-return on line 160 (`if (!(demos || []).length) return { demos: [], rowsAll: [], rowsCT: [], rowsT: [], demoToVod }`) to include the new fields:

```js
  if (!(demos || []).length) return {
    demos: [], rowsAll: [], rowsCT: [], rowsT: [],
    demoToVod, demosById: new Map(),
    teamStatsRows: [], ourTeamByDemoId: new Map(),
  }
```

And the no-roster-steam-ids early-return on line 130 (`if (!teamSteamIds.size) return empty`). Change the `empty` definition (line 129) to include the new fields too:

```js
  const empty = {
    demos: [], rowsAll: [], rowsCT: [], rowsT: [],
    demoToVod: new Map(), demosById: new Map(),
    teamStatsRows: [], ourTeamByDemoId: new Map(),
  }
```

- [ ] **Step 4: Partition team-stats rows and render in `rebuild()`**

In `cs2-hub/vods.js`, find `rebuild()` (around lines 190-253). After this existing block (around lines 212-217):

```js
  const { current: rowsCurrent, prior: rowsPrior } = partitionRows({
    rows: data.rowsAll,
    demosById: data.demosById,
    demoToVod: data.demoToVod,
    currentVodIds, priorVodIds, filter,
  })
```

Add immediately after:

```js
  const { current: teamStatsCurrent, prior: teamStatsPrior } = partitionRows({
    rows: data.teamStatsRows,
    demosById: data.demosById,
    demoToVod: data.demoToVod,
    currentVodIds, priorVodIds, filter,
  })
```

Then, in the same `rebuild()` function, find the `renderPlayerImpact(...)` call (around line 229). Immediately BEFORE it, add:

```js
  renderTeamStats(document.getElementById('rr-team-stats'), {
    rowsCurrent: teamStatsCurrent,
    rowsPrior:   teamStatsPrior,
    ourTeamByDemoId: data.ourTeamByDemoId,
  })
```

- [ ] **Step 5: Manual smoke test in browser**

With the static server running (`cd cs2-hub && python -m http.server 8080`), load `http://localhost:8080/vods.html`. Expected:
- Below the hero filter, a **TEAM STATS** section appears with 11 tile cards in a grid.
- Numbers reflect the current filter (e.g. "Last 10").
- Change filter pill (e.g. 30 days → 90 days). Tiles update.
- Percentage tiles (pistols, anti-ecos, eco, full-buy, opening duel, 5v4, CT, T) get trend chips (↗/↘/▬) when prior data exists. Count tiles (first kills, first deaths) and the force-buy tile do NOT show chips.
- If no demos in window, section disappears entirely.

If section doesn't appear at all:
- Check Network tab for the `demo_team_stats` request — should return 200.
- Check that `ourTeamByDemoId` has entries (console.log inside `rebuild`).
- Check that at least one row has `team` matching the map entry.

- [ ] **Step 6: Commit**

```bash
git add cs2-hub/vods.html cs2-hub/vods.js
git commit -m "feat(stats): aggregated team stats section on results page"
```

---

### Task 11: Results-page team stats grid styles

**Files:**
- Modify: `cs2-hub/style.css` (append)

- [ ] **Step 1: Append styles**

Append to `cs2-hub/style.css`:

```css

/* ── Results & Review: team stats section ────────────────── */
.rr-team-stats { margin-bottom: 32px; }
.rr-team-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
@media (max-width: 900px) {
  .rr-team-stats-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 600px) {
  .rr-team-stats-grid { grid-template-columns: 1fr; }
}
.rr-team-stat .stat-label { display: flex; align-items: center; gap: 8px; }
.rr-team-stat .stat-value { font-variant-numeric: tabular-nums; }
```

The existing `.stat-card`, `.stat-label`, `.stat-value`, and `.rr-trend-*` classes (already in `style.css`) carry the rest.

- [ ] **Step 2: Reload `vods.html`**

Expected:
- Tiles laid out 3-up on desktop, 2-up on tablet, 1-up on mobile (resize browser to confirm).
- Trend chip sits inline next to the stat label.
- Tabular numerals make 11–7 and 14–10 line up.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/style.css
git commit -m "style(stats): results-page team stats tile grid"
```

---

## Phase 5 — Manual end-to-end verification

### Task 12: Cross-surface verification

**Files:** none modified. Verification only.

- [ ] **Step 1: Spot-check a single demo across both surfaces**

Pick one parsed demo. Open its Scoreboard tab. Note the panel values for: Pistols, Anti-ecos, First kills, CT win rate.

On Results & Review, set the filter window to a range that includes *only* that single demo (use a narrow date range or filter down to the right match type).

Expected: the aggregated tiles equal the single demo's tiles. If they don't match, debug aggregation/filtering before shipping.

- [ ] **Step 2: Filter sweep**

On Results & Review, cycle through `Last 10` → `30 days` → `90 days` → `All time` and toggle match-type pills. Confirm:
- Tiles update on every change.
- Trend chips appear/disappear sensibly (prior window has <10 played → no chip).
- No console errors.

- [ ] **Step 3: Cross-check anti-eco against known demo**

Pick a demo where the opponent had an eco round. Open the round-by-round (if available) or your memory of the match. Confirm the anti-eco tile on the Scoreboard reflects what you know.

- [ ] **Step 4: Edge case — pre-reparse demo**

If any demo's anti-eco columns are still null (e.g. the worker hasn't finished reparsing it), confirm:
- Scoreboard: the Anti-ecos row shows `—` / `—` for both teams.
- Results: that demo silently contributes 0 to the anti-eco totals (treated as 0 by `sumWinsPlayed`).
- No console errors, no NaN, no broken rendering.

- [ ] **Step 5: Edge case — demo with no rostered player**

If such a demo exists (e.g. a stand-in match):
- Scoreboard: panel renders normally.
- Results: that demo is excluded from the aggregation (its team_stats row has no entry in `ourTeamByDemoId`).

- [ ] **Step 6: Final commit (if any cleanup arose)**

If you fixed any bugs during verification, commit them now:

```bash
git status
git diff
# review, then:
git add <files>
git commit -m "fix(stats): <specific fix>"
```

If verification was clean, no commit needed.

---

## Out of scope (do NOT implement)

- Per-side CT/T splits of pistols, anti-ecos, first kills/deaths, 5v4 (16 already-stored columns; UI deferred).
- Trend charts / sparklines / time series.
- "vs opponents (avg)" comparison column on the results page.
- Round-by-round drill-down ("which rounds were 5v4?").
- Per-map team stats split.
- Force-buy anti-eco defence (rounds where opponent forced).
- Bomb plant / defuse tiles (user removed from the design).
- Renaming or fixing the existing pre-Ship-1 mapping of "antieco buys → force_* columns" in `compute_team_stats`. That mislabeling pre-dates this work and is out of scope. The Force-buy wins tile reads whatever those columns contain today.

---

## Acceptance criteria

- [ ] `demo_team_stats` has populated `anti_eco_wins` / `anti_eco_played` columns for every demo (post-reparse).
- [ ] Parser unit tests pass (`vps && python -m pytest tests/test_stats.py -v`).
- [ ] All four `*.test.html` files report only `PASS:` lines in the browser console.
- [ ] Demo viewer's Scoreboard tab renders a Team Stats panel below player tables with 11 rows × 2 columns (or omits gracefully if no data).
- [ ] Results & Review renders a Team Stats section between hero and Player Impact with 11 tiles.
- [ ] Filter changes on Results & Review update the Team Stats tiles in sync with Player Impact.
- [ ] Percentage tiles show trend chips when prior window has ≥ 10 played rounds.
- [ ] No console errors at any point on either page.
- [ ] No regressions in existing player tables or other Results & Review sections.
