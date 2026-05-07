# Demo Stats — Design (Ship 1: per-demo scoreboard)

**Status:** approved design, ready for implementation plan
**Date:** 2026-05-07
**Scope:** Ship 1 of 2. Adds per-demo player + team stats to the demo viewer as a "Scoreboard" tab. Aggregate cross-demo page lands in Ship 2.

## Goal

Surface a HLTV-style scoreboard for every uploaded demo:
- Per-player stats: K/D/A, rating, ADR, HS%, KAST%, multi-kills, opening duels, clutches, utility damage, flash assists, traded deaths, impact rating.
- Per-team stats: pistol round W/L, 5v4 conversion, first kills/deaths, eco/force/full-buy wins, bomb plants/defuses, CT/T side win rates.
- All stats split per side (All / CT / T).

Computation happens on the VPS at parse-time. The browser only reads.

## Architecture

```
.dem (Storage)
  ↓ VPS worker (vps/main.py + vps/demo_parser.py)
demos.match_data / match_data_slim   (existing)
demo_players                         (existing table, populate unused cols + add new)
demo_team_stats                      (new table)
  ↓ Supabase RLS via demos.uploaded_by
analysis.html — Scoreboard tab       (new UI)
```

**Decisions:**
- All stats computed at parse-time on the VPS. Browser does no recomputation.
- Stats stored in queryable tables (not jsonb-only) so Ship 2's aggregate page is a `select sum(...) group by steam_id`.
- Backfill = full reparse of existing demos. Single source of truth for stat formulas.
- Round-level drill-down (e.g., who got first kill in round 7) stays in `match_data` jsonb where it already lives.

## Schema

### `demo_players` — relax + extend

The existing table has unused columns (`kills`, `deaths`, `assists`, `adr`, `rating`). We populate them and add the missing HLTV-grade stats. Three rows per player per demo: `side='all'`, `side='ct'`, `side='t'`.

```sql
-- relax side check to allow 'all'
alter table demo_players drop constraint if exists demo_players_side_check;
alter table demo_players add constraint demo_players_side_check
  check (side in ('all','ct','t'));

-- new columns
alter table demo_players add column team            text check (team in ('a','b'));  -- which roster
alter table demo_players add column hs_pct          float;
alter table demo_players add column kast_pct        float;
alter table demo_players add column multi_2k        int;
alter table demo_players add column multi_3k        int;
alter table demo_players add column multi_4k        int;
alter table demo_players add column multi_5k        int;
alter table demo_players add column opening_kills   int;
alter table demo_players add column opening_deaths  int;
alter table demo_players add column clutches_won    int;
alter table demo_players add column clutches_lost   int;
alter table demo_players add column utility_dmg     int;
alter table demo_players add column flash_assists   int;
alter table demo_players add column traded_deaths   int;
alter table demo_players add column impact_rating   float;
alter table demo_players add column rounds_played   int;

create unique index demo_players_unique_side
  on demo_players (demo_id, steam_id, side);
```

### `demo_team_stats` — new

Two rows per demo: `team='a'`, `team='b'`. Wide flat table — column count is fine at 2 rows/demo.

```sql
create table demo_team_stats (
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
create policy "team stats follow demo"
  on demo_team_stats for select
  using (exists (
    select 1 from demos d
    where d.id = demo_id and d.uploaded_by = auth.uid()
  ));
```

## Stat formulas

Per-player, computed three times (all / ct / t).

| Stat | Formula |
|---|---|
| `kills` | count of `kills` events where `attacker_sid == player`, team-kill excluded |
| `deaths` | count where `victim_sid == player` |
| `assists` | parser-reported assister |
| `adr` | `total_damage / rounds_played` (kill-damage only in v1; documented limitation — see Open Risks) |
| `hs_pct` | `headshot_kills / kills` |
| `kast_pct` | rounds with at least one of: Kill, Assist, Survived, Traded death (death avenged within 5s) |
| `multi_2k`/`3k`/`4k`/`5k` | rounds where the player got exactly N kills |
| `opening_kills` | rounds where this player got the first kill of the round |
| `opening_deaths` | rounds where this player was the first death of the round |
| `clutches_won` | won a 1vN where N≥1 (last alive on team and won round) |
| `clutches_lost` | last alive on team and lost |
| `utility_dmg` | sum of grenade-detonation damage attributed to this player (HE + molotov + incendiary) |
| `flash_assists` | enemy was flashed by this player at time of teammate kill (≤2s window) |
| `traded_deaths` | died, then attacker killed by teammate within 5s |
| `impact_rating` | `(opening_kills + clutches_won + multi_3k + multi_4k + multi_5k) / rounds_played` |
| `rating` | HLTV 1.0 (formula below) |
| `rounds_played` | rounds where the player was alive at round-start |

**HLTV 1.0 rating:**

```
KillRating       = kills / rounds / 0.679
SurvivalRating   = (rounds - deaths) / rounds / 0.317
RoundsWithMultiK = (1*1k + 4*2k + 9*3k + 16*4k + 25*5k) / rounds / 1.277
Rating = (KillRating + 0.7*SurvivalRating + RoundsWithMultiK) / 2.7
```

Per-team:

| Stat | Formula |
|---|---|
| `pistol_wins` / `_played` | wins on round 1 and round 13 (or first round of each half) |
| `five_v_four_wins` / `_played` | rounds where team had a man advantage at any point |
| `five_v_four_t_wins`, `_ct_wins` | same, split by team's side that round |
| `first_kills` / `first_deaths` | sum of opening_kills / opening_deaths across roster |
| `eco/force/full_buy_*` | classified via existing `_classify_buy(own_value, opp_value, is_pistol)` |
| `bomb_plants` / `bomb_defuses` | from existing `bomb` events |
| `ct_round_wins` / `t_round_wins` | from `rounds[*].winner_side` cross-referenced with `team_a_first_side` |

**5v4 detection:** scan frames; if at any frame in the round one team had +1 alive count, mark the round as 5v4 (regardless of trade-rebound). Documented choice — alternative "first contact left team at 5v4" is stricter; we picked permissive.

## Parser additions

In `vps/demo_parser.py`:

```python
def compute_player_stats(parsed) -> list[dict]:
    """Returns 3 rows per player (all/ct/t) ready for demo_players upsert.

    Walks parsed['kills'] grouped by round + side. Per round, tracks
    who got opening kill/death, who survived, multi-kill counts.
    Uses _team_at(sid, tick) for halftime correctness."""

def compute_team_stats(parsed) -> list[dict]:
    """Returns 2 rows (team_a, team_b) for demo_team_stats upsert.

    Walks rounds, classifies each via _classify_buy + _is_pistol_round.
    Counts pistol/5v4/eco/force/full-buy wins. Sums opening_kills/deaths
    from compute_player_stats output. Detects 5v4 via frames pass."""
```

New helpers:

| Helper | Purpose |
|---|---|
| `_first_event_per_round(events, key)` | first kill/death per round |
| `_alive_count_at(frame, side)` | for 5v4 detection |
| `_was_traded(kills, victim_idx, window=5s)` | KAST + traded_deaths |
| `_clutch_outcome(round_idx, parsed)` | 1vN detection from frames |
| `_grenade_damage_attribution(grenades, kills)` | utility_dmg |
| `_flash_assist(kill, flashes, window=2s)` | flash_assists |

In `vps/main.py`, after `parse_demo()` succeeds:

```python
parsed = parse_demo(dem_path)
slim   = build_slim_payload(parsed)
player_rows = compute_player_stats(parsed)
team_rows   = compute_team_stats(parsed)

# delete existing rows for this demo_id (idempotent reparse), then upsert
```

Each compute function wrapped in try/except — one failing doesn't block the other or block playback storage.

## UI — Scoreboard tab

In `analysis.html` (the demo viewer):

- Add a tab strip: `Playback` | `Scoreboard`. Existing playback view unchanged.
- Scoreboard panel layout:
  - Side toggle: `All` / `CT` / `T` — re-queries by `side` column. Selection persists per session in `localStorage`.
  - **Team A scoreboard** (your team, blue accent): table with columns Player · K · D · A · +/– · ADR · HS% · KAST · Multi (2k/3k/4k/5k) · Open (K–D) · Clutch (W–L) · Rating. Sorted by Rating desc.
  - **Team B scoreboard** (opponent, red accent): same columns.
  - **Team stats panel** below both rosters: 4-column tile grid showing pistol record, 5v4 conversion (with CT/T split), first kills, first deaths, eco wins, force wins, full-buy wins, CT/T side splits.
- Stacked layout (not side-by-side) — chosen because demo viewer content area is ~1100px wide and side-by-side cramps the columns.
- 12 columns is dense by design; player drill-down (kill timeline, round-by-round) is deferred to a follow-up.

**Empty states:**
- Demo never parsed: "No stats parsed for this demo yet — re-queue parser?" with button.
- Demo currently parsing: "Stats parsing… (auto-refreshes when ready)" with poll on `demos.processing_status`.
- Stats compute failed for this demo: "Stats unavailable" message; playback still works.

**Side-toggle edge case:** if a player only played one side (sub mid-half), the other side shows `—` for their row.

## Edge cases

| Case | Handling |
|---|---|
| Parser stat compute fails | wrap each function in try/except; log; write empty rows so demo isn't stuck. Playback unaffected. |
| Forfeit / partial demos | compute what's available; `rounds_played` reflects actual rounds. |
| OT rounds | counted as regular rounds for stats; sides follow standard OT rules via `_team_at`. |
| Subs / disconnects | per-player `rounds_played` is accurate (alive at round-start). Rating denominators use that, not match length. |
| Bots | skipped via existing parser bot detection. |
| Halftime side swap | all per-side splits use existing `_team_at(sid, tick)` (handles `team_a_first_side` correctly). |
| Tied / unfinished matches | OT rounds count; map W/L reflects final score. |

## Backfill

1. Apply schema migrations (relax `demo_players.side` check, add columns, create `demo_team_stats`, add unique index).
2. Truncate any existing rows in `demo_players` (currently empty in practice; reparse will repopulate).
3. Deploy parser changes to VPS.
4. Flip every existing demo's `processing_status` back to `pending`.
5. Worker re-runs them through the parse + new compute pass.

Single codepath, no risk of two divergent stat implementations.

For a much larger demo library this would be slow. The fallback (one-off script computing stats from existing `match_data` jsonb) is documented but not implemented in Ship 1.

## Security

- All reads RLS-scoped via `demos.uploaded_by = auth.uid()`.
- `demo_team_stats` policy mirrors existing `demo_players` pattern (subquery to demos).
- No new write paths from the browser; all writes happen in the VPS worker via service-role key.

## Out of scope (Ship 2)

- Aggregate stats page across demos.
- Roster identification ("your 5 steam_ids") — auto-detect + edit UI.
- Filters: by map, date range, opponent.
- Per-player drill-down (kill timeline, round-by-round).
- Career stats per player.

## Open risks

1. **ADR includes only kill damage.** `demoparser2` may not surface non-fatal damage in the events we currently capture. Ship 1 documents this limitation; if numbers feel wrong after launch, add a damage-event capture pass.
2. **Utility damage attribution.** Same caveat — depends on whether grenade-detonation damage events are exposed. Start with what we can attribute; refine if gappy.
3. **Backfill cost.** Full reparse of every demo is fine for current library size. Becomes expensive at scale; documented fallback exists.

## Acceptance criteria

- [ ] Schema migrations applied on Supabase.
- [ ] Parser writes `demo_players` (3 rows/player) and `demo_team_stats` (2 rows/demo) for every newly-uploaded demo.
- [ ] Existing demos backfilled by reparse.
- [ ] Demo viewer has a `Scoreboard` tab next to `Playback`.
- [ ] Side toggle (All/CT/T) re-queries and re-renders correctly.
- [ ] Player table shows all 12 columns with correct formulas (spot-check against HLTV for a known match).
- [ ] Team stats panel renders 8 tiles with correct formulas.
- [ ] Compute failures don't block playback or get the demo stuck.
- [ ] RLS verified: a different user cannot read another team's `demo_players` / `demo_team_stats` rows.
