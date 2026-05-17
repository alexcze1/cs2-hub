# Team Stats — Design

**Status:** approved design, ready for implementation plan
**Date:** 2026-05-18
**Scope:** Add per-team summary stats to two surfaces — (1) a Team Stats panel inside the demo viewer's Scoreboard tab (single match, both teams side-by-side), and (2) an aggregated Team Stats section on the Results & Review page (`vods.html`, our team only, filter-aware with deltas on percentage tiles). One parser change adds anti-eco counters; otherwise reads what `demo_team_stats` already stores.

## Goal

Coaches need to see *how* matches were won/lost at a team level — pistols, anti-ecos, opening duels, side win rates, conversion rates — without reading per-player tables. Per-demo team stats answer "what happened in this map." Aggregated team stats answer "what's our team identity across the last 30 days." Both surfaces read the same `demo_team_stats` table; computation happens at parse-time, browser only reads.

## Architecture

```
.dem (Storage)
  ↓ VPS worker (vps/main.py + vps/demo_parser.py)
demo_team_stats (existing — +2 anti-eco columns)
  ↓ Supabase RLS via demos.uploaded_by
demo viewer Scoreboard tab     Results & Review page
  ├ scoreboard.js              ├ vods.js
  └ scoreboard-team-stats.js   ├ vods-team-stats.js
    (NEW)                      └ team-stats-aggregate.js
                                 (all NEW)
```

## Schema

### `demo_team_stats` — add anti-eco

```sql
alter table demo_team_stats add column if not exists anti_eco_wins   int;
alter table demo_team_stats add column if not exists anti_eco_played int;
```

Idempotent. No other schema changes. All other tiles (pistols, 5v4, eco/force/full-buy, first kills/deaths, CT/T win rate) already exist in the table from Ship 1.

**Anti-eco definition:**
- For team A's row, `anti_eco_played` = count of rounds where team B's buy was classified as `eco` (not force, not full-buy).
- `anti_eco_wins` = subset of those rounds team A won.
- Symmetric for team B's row.
- Force-buy defence is **not** anti-eco — different buy state, different decision space. Could be added as a separate tile later if needed.

## Parser

### `vps/demo_parser.py::compute_team_stats`

The function already iterates every round and classifies each team's buy via `_classify_buy(own_value, opp_value, is_pistol)`. Anti-eco counters slot into the same loop:

```python
# inside the round loop, after classifying both teams' buys
if b_buy == 'eco':
    a['anti_eco_played'] += 1
    if winner == a_side: a['anti_eco_wins'] += 1
if a_buy == 'eco':
    b['anti_eco_played'] += 1
    if winner == b_side: b['anti_eco_wins'] += 1
```

Initialize counters in the same `pistol_wins: 0, pistol_played: 0, ...` block.

### `vps/main.py`

`_TEAM_STAT_COLS` is the column list driving the `INSERT ... VALUES` statement. Add `anti_eco_wins` and `anti_eco_played` to that tuple in the same order as the dict keys. No other changes.

### Backfill

Flip every `demos.processing_status` to `pending`. Worker re-runs them through `compute_team_stats`. Same playbook as Ship 1. Demos not yet reparsed render with `—` for the anti-eco tile only — all other tiles unaffected.

## Surface 1 — Demo Scoreboard

### Layout

Below both player tables (Team A players → Team B players → Team Stats panel). Side toggle (All/CT/T) does NOT affect this panel — it always shows full-match team stats. The CT/T win-rate tiles inherently carry the side breakdown.

```
┌─ Team Stats ────────────────────────────────────────────────┐
│   {Team A name}            STAT             {Team B name}   │
│        4–3 (57%)         Pistols              3–4 (43%)     │
│        5–2 (71%)         Anti-ecos            2–5 (29%)     │
│        1–4 (20%)         Eco wins             4–1 (80%)     │
│        2–3              Force-buy wins         3–2          │
│       18–12 (60%)        Full-buy wins       12–18 (40%)    │
│           24             First kills              18         │
│           18             First deaths             24         │
│         57%             Opening duel W%         43%          │
│        4–5 (80%)        5v4 conversion        2–3 (67%)     │
│        14–10 (58%)       CT win rate         11–13 (46%)    │
│        10–14 (42%)        T win rate         13–11 (54%)    │
└─────────────────────────────────────────────────────────────┘
```

Two-column comparison, stat label down the middle. Tabular numerals.

### Tiles (11)

| # | Tile | Source columns | Format |
|---|---|---|---|
| 1 | Pistols | `pistol_wins / pistol_played` | `W–L (pct%)` |
| 2 | Anti-ecos | `anti_eco_wins / anti_eco_played` | `W–L (pct%)` |
| 3 | Eco wins | `eco_wins / eco_played` | `W–L (pct%)` |
| 4 | Force-buy wins | `force_wins / force_played` | `W–L` (no pct, sample size small) |
| 5 | Full-buy wins | `full_buy_wins / full_buy_played` | `W–L (pct%)` |
| 6 | First kills | `first_kills` | count |
| 7 | First deaths | `first_deaths` | count |
| 8 | Opening duel W% | `first_kills / (first_kills + first_deaths)` | `pct%` |
| 9 | 5v4 conversion | `five_v_four_wins / five_v_four_played` | `W–L (pct%)` |
| 10 | CT win rate | `ct_round_wins / ct_rounds_played` | `W–L (pct%)` |
| 11 | T win rate | `t_round_wins / t_rounds_played` | `W–L (pct%)` |

Bomb plants and bomb defuses are NOT shown (deliberate omission per user direction).

### Module: `scoreboard-team-stats.js`

```js
export function renderTeamStats(container, { teamA, teamB, teamAName, teamBName }) {
  // teamA, teamB = demo_team_stats rows or null
  // If neither row exists, no-op (caller renders nothing).
  // If one row missing, render only the present column with the other dim.
}
```

Pure render. No data fetching. Tested via `scoreboard-team-stats.test.html`:
- All 11 tiles render with correct formulas
- Divide-by-zero → `—`
- Missing team B row → only team A column rendered, with team B column showing `—` placeholders
- Name escaping (mirrors `esc()` from `scoreboard.js`)

### Wiring in `scoreboard.js`

`mountScoreboard` adds a third parallel query:

```js
const [
  { data: players, error: pe },
  { data: demo,    error: de },
  { data: teamStats, error: te },
] = await Promise.all([
  supabase.from('demo_players').select('*').eq('demo_id', demoId),
  supabase.from('demos').select('ct_team_name,t_team_name,team_a_first_side').eq('id', demoId).maybeSingle(),
  supabase.from('demo_team_stats').select('*').eq('demo_id', demoId),
])
```

`render()` receives `teamStats` in state. After the player tables, calls `renderTeamStats(panel, { teamA, teamB, teamAName, teamBName })` where `teamA = teamStats.find(r => r.team === 'a')`. If `teamStats` is empty (parse failure or pre-Ship-1 demo), the panel container stays empty — no error.

## Surface 2 — Results & Review page

### Placement

New `<section id="rr-team-stats">` between `#rr-hero` and `#rr-player-impact` in `vods.html`. Reads the filter mounted in the hero (same filter that drives Player Impact, Map Pool, Match Reports).

### Layout

Single column of 11 tiles in a responsive grid (3-up desktop, 2-up tablet, 1-up mobile). Reuses `.stat-card`, `.stat-label`, `.stat-value`, `.delta-up`, `.delta-down` from `style.css`. No new color tokens.

Percentage tiles (pistols, anti-ecos, eco, full-buy, 5v4, CT, T, opening duel W%) get a delta chip when prior-window data is sufficient:

```
┌────────────────────────┐
│ Pistols                │
│ 14–7  67%   ▲ +5%      │
└────────────────────────┘
```

Count-only tiles (first kills, first deaths) and small-sample tiles (force-buy) do NOT show deltas — deltas on raw counts mostly just reflect match volume.

### Data flow

The existing `fetchDemosForVodWindow` already loads `demos` + `demo_players` for the windowed match pool. Add one parallel fetch:

```js
const { data: teamStats, error: e4 } = await supabase
  .from('demo_team_stats')
  .select('*')
  .in('demo_id', demos.map(d => d.id))
```

**"Which row is us?"** — Build `ourTeamByDemoId: Map<demo_id, 'a'|'b'>` from the loaded `demo_players` rows (already filtered to `teamSteamIds`). Any row's `team` column tells us which side is us for that demo. Demos with no rostered player row → excluded from team-stats aggregation (we can't identify our side).

**Partitioning into current/prior windows:** reuse the existing `partitionRows` helper in `vods.js` — it operates on any row with a `demo_id` field. Returns `{ rowsCurrent, rowsPrior }`. Filter each to only "our team" rows using `ourTeamByDemoId`.

### Aggregation (`team-stats-aggregate.js`)

Pure module. No Supabase. Mirrors the `roster-stats-aggregate.js` pattern.

```js
export function aggregateTeamStats(rows) {
  // rows: array of "our team" demo_team_stats rows (already filtered to our side).
  // Returns:
  // {
  //   pistols:        { wins, played, pct },
  //   anti_ecos:      { wins, played, pct },
  //   eco:            { wins, played, pct },
  //   force:          { wins, played },        // no pct
  //   full_buy:       { wins, played, pct },
  //   first_kills:    n,
  //   first_deaths:   n,
  //   opening_duel:   { pct },
  //   five_v_four:    { wins, played, pct },
  //   ct:             { wins, played, pct },
  //   t:              { wins, played, pct },
  // }
  // pct is null when played === 0.
}

export function computeDeltas(current, prior, { minPlayed = 10 } = {}) {
  // Returns same shape as aggregate, but each pct field becomes { value, delta }.
  // delta = current.pct - prior.pct, only if prior.played >= minPlayed.
  // Otherwise delta = null.
  // Non-pct tiles get { value }, no delta.
}
```

### Module: `vods-team-stats.js`

```js
export function renderTeamStats(container, { rowsCurrent, rowsPrior, ourTeamByDemoId }) {
  // 1. Filter rowsCurrent/rowsPrior to "our team" rows using ourTeamByDemoId.
  // 2. const current = aggregateTeamStats(ourCurrent)
  // 3. const prior   = aggregateTeamStats(ourPrior)
  // 4. const view    = computeDeltas(current, prior)
  // 5. Render 11 tiles. Percentage tiles show delta chip when delta != null.
  // 6. If current.* are all zero-denominator, render nothing.
}
```

### Wiring in `vods.js`

Add to the rebuild flow:

```js
const teamStatsPartition = partitionRows({
  rows: data.teamStatsRows,
  demosById: data.demosById,
  demoToVod: data.demoToVod,
  currentVodIds, priorVodIds, filter,
})

renderTeamStats(document.getElementById('rr-team-stats'), {
  rowsCurrent: teamStatsPartition.current,
  rowsPrior:   teamStatsPartition.prior,
  ourTeamByDemoId,
})
```

`ourTeamByDemoId` is built once inside `fetchDemosForVodWindow` and added to its return value.

## Module structure

```
vps/demo_parser.py            (modified — anti-eco counters in compute_team_stats)
vps/main.py                   (modified — add anti_eco_* to _TEAM_STAT_COLS)
vps/tests/test_stats.py       (modified — anti-eco test cases)

cs2-hub/
  supabase-stats-migration.sql        (modified — add 2 anti-eco columns, idempotent)
  scoreboard.js                       (modified — fetch demo_team_stats, mount panel)
  scoreboard-team-stats.js            (new — render module)
  scoreboard-team-stats.test.html     (new)
  vods.js                             (modified — fetch demo_team_stats, mount section)
  vods.html                           (modified — add <section id="rr-team-stats">)
  vods-team-stats.js                  (new — render module)
  vods-team-stats.test.html           (new)
  team-stats-aggregate.js             (new — pure aggregation + delta computation)
  team-stats-aggregate.test.html      (new)
  style.css                           (modified — team stats panel + tile grid styles)
```

## Edge cases

| Case | Handling |
|---|---|
| Pre-Ship-1 demo with no `demo_team_stats` rows | Scoreboard: panel omitted (container empty). Results: demo silently excluded from aggregation. |
| One team row exists, other missing | Scoreboard: only the present column rendered; absent column shows `—`. Results: that demo still contributes to aggregation for the team that has a row. |
| Anti-eco columns null (demo predates anti-eco backfill) | Anti-eco tile shows `—`. All other tiles render normally. |
| Demo with no rostered player on it (stand-in match, parser quirk) | Results: excluded from aggregation (can't identify our side). Scoreboard: shows both teams as normal. |
| `pistol_played = 0` (forfeit or partial demo) | Tile shows `—`. |
| `anti_eco_played = 0` (opponent never ecoed) | Tile shows `—`. |
| `five_v_four_played = 0` | Tile shows `—`. |
| `force_played = 0` | Tile shows `—`. |
| Prior window has < 10 rounds played for a stat | Delta chip omitted. Tile still shows current value. |
| All current-window stats zero (new team, no parsed demos) | Results section renders nothing (same as `vods-player-impact`). |
| Filter changes while data loading | Standard rebuild pattern — last filter wins. Same as existing sections. |
| Halftime side swap in parser | `compute_team_stats` already uses `_team_at(sid, tick)` for side correctness. Anti-eco classification piggybacks on the same per-round buy classification, so it's automatically half-aware. |

## Testing

| Test file | Coverage |
|---|---|
| `vps/tests/test_stats.py` (extend) | Anti-eco counters: opponent eco → counts; opponent force → doesn't count; we won round vs lost. Symmetry between team A and team B rows. Halftime side swap correctness. |
| `scoreboard-team-stats.test.html` | All 11 tiles render with correct formulas. Divide-by-zero → `—`. Missing team B row → only team A column rendered. Name escaping. |
| `team-stats-aggregate.test.html` | Multi-demo sum aggregation. Percentage math. Opening duel W% formula. Delta computation: `current.pct - prior.pct` when `prior.played >= 10`. Delta null when prior too small. Empty input → all `null` percentages. |
| `vods-team-stats.test.html` | Render snapshot: 11 tiles in correct order. Percentage tiles get delta chips. Count tiles do NOT get delta chips. Force-buy tile has no pct. Empty section renders nothing. |

**Manual end-to-end verification:**

1. Apply migration. Reparse demos. Confirm `demo_team_stats` has populated `anti_eco_*` columns.
2. Open a known demo's Scoreboard tab. Cross-check team stats panel against the demo's actual round-by-round (spot-check 2–3 tiles).
3. On Results & Review with the same demo in the window, confirm the aggregated tiles match — single-demo aggregation should equal the single demo's stats.
4. Change filter (10 → 30d → 90d → All). Tiles update; delta chips appear/disappear correctly based on prior-window sample size.
5. Add a demo where no rostered player has a steam_id matching the team — confirm it's excluded from Results aggregation but still shows on Scoreboard.

## Rollout

Single PR, additive. Order:

1. Schema migration (idempotent `alter table add column if not exists`).
2. Parser change (`demo_parser.py` + `main.py` + tests).
3. Reparse all demos (`update demos set processing_status='pending'`).
4. Spot-check `demo_team_stats` for non-null anti-eco columns.
5. `team-stats-aggregate.js` + tests.
6. `scoreboard-team-stats.js` + tests + wiring in `scoreboard.js`.
7. `vods-team-stats.js` + tests + wiring in `vods.js` + section in `vods.html`.
8. Style polish + manual end-to-end pass.

No feature flag — pages render gracefully without data (Edge cases table above).

## Security

- Migration is additive, idempotent.
- `demo_team_stats` already has RLS scoped via `demos.uploaded_by = auth.uid()` (from Ship 1). No new RLS needed.
- Browser does no writes — all writes happen in VPS worker via service-role key.
- HTML escaping mirrors existing pattern in `scoreboard.js` (`esc()`).

## Out of scope (deliberate v1)

- Per-side CT/T splits of pistols, anti-ecos, first kills/deaths, 5v4 (optional tiles considered in brainstorm — deferred).
- Trend chart / sparkline for any tile over time.
- "vs opponents (avg)" comparison column on results page.
- Round-by-round drill-down (which specific rounds were 5v4? which anti-ecos did we lose?).
- Per-map team stats split (would belong in Map Pool, not Team Stats).
- Force-buy anti-eco defence (rounds where opponent forced).
- Bomb plant / defuse tiles.
