# Results & Review — Tactical Analyst Redesign

**Date:** 2026-05-15
**Status:** Draft — awaiting user review before plan
**Scope:** `cs2-hub/vods.html` + `cs2-hub/vods.js` (the page already titled "Results & Review — MIDROUND")

---

## 1. Goal

Replace the current Results & Review page with a tactical analyst-style layout that communicates performance, momentum, and player impact at a glance. Stay inside MIDROUND's existing design tokens — extend, do not depart.

The redesign restructures the page (hero → player impact → map pool → match reports) and changes the visual treatment, but ships only what the current data layer (`vods`, `demos`, `demo_players`, `roster`) supports without new ingestion work.

---

## 2. Constraints

- Use existing CSS variables in `cs2-hub/style.css`: `--accent`, `--danger`, `--warning`, `--special`, `--surface`, `--surface-high`, `--glass-bg`, `--glass-border`, `--text`, `--muted`, `--display-font`. Add one new token: `--role-lurker: #a855f7`.
- Reuse existing modules without rewriting their core: `vods-filter.js`, `roster-stats-aggregate.js` (`aggregatePlayer`, `aggregateByPlayer`, `aggregateByMap`, `applyTimeWindow`), `player-drawer.js`, `auto-fill-vod.js` (`linkDemosToVods`), `team-autocomplete.js` (`teamLogoEl`).
- Replace fully: `vods-team-stats.js`, `roster-stats.js`, `roster-stats-render.js` rendering surface, and the markup in `vods.html`.
- Keep the page URL (`vods.html`) and sidebar nav key (`'vods'`). Deep links from elsewhere keep working.

---

## 3. Out of Scope (deferred)

- T-side / CT-side win rate per map
- Round-momentum bars or round-by-round dots
- Tactical Insights panel (force-buy %, scrim-vs-official splits, AI-style call-outs)
- Radar graph (Aim / Util / Clutch / Pos / Trading)
- LAN / Online match-type filter (schema doesn't store it)

These can come back as a Phase 2 spec when their data is in place.

---

## 4. Page Structure

Top-to-bottom, single column, max-width matches the rest of the app (`.main-content`):

```
┌─────────────────────────────────────────────────────────────────┐
│ 1 · HERO                                                        │
│   Record (W-L-D)   |  Trend sparkline                           │
│   Round WR %       |  Filter pills                              │
│   Best / Weakest   |  + Add Match                               │
├─────────────────────────────────────────────────────────────────┤
│ 2 · PLAYER IMPACT                                               │
│   [card] [card] [card] [card] [card]   (5-up, role-bordered)    │
├─────────────────────────────────────────────────────────────────┤
│ 3 · MAP POOL                                                    │
│   Map | WR | Sample | Trend | Confidence       (table)          │
├─────────────────────────────────────────────────────────────────┤
│ 4 · MATCH REPORTS                                               │
│   [result vs opponent · map · type · date · score · top perfs]  │
│   [result vs opponent · ...]                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Data Model

All values derive from existing tables. No schema changes.

### Inputs
- **`vods`** for team, filtered to `dismissed = false`, ordered `match_date desc`. Fields used: `id, opponent, result, match_type, match_date, maps (jsonb: [{map, score_us, score_them}])`.
- **`demos`** linked via `linkDemosToVods` (best-effort). Fields used: `id, map, played_at, score_ct, score_t`.
- **`demo_players`** rows for any `steam_id` in the team's `roster`, filtered to the same date window as the hero filter.
- **`roster`** for nickname / role / steam_id, excluding `Coach / Manager / Bench / Unassigned`.

### Hero derivations
- `record = {w, l, d}` — count vods by `result` in window.
- `roundWR` — sum `score_us` and `(score_us + score_them)` across `vods.maps[]` in window. `null` when zero rounds.
- `bestMap` / `worstMap` — `aggregateByMap` of vods.maps[] (per-map WR weighted by maps played); pick top and bottom with `samples ≥ 3`. `null` if no map has enough data.
- `sparkline` — last 10 vods (by `match_date desc`), each rendered as a bar height proportional to that match's round WR.

### Player Impact derivations
- For each non-staff roster member, run `aggregatePlayer` over `demo_players` rows in window for that `steam_id`.
- Trend arrow: compare `agg.rating` in the current selected window vs the same-length window of vods immediately preceding it (e.g., if window is `30d`, prior is the 30 days before that; if window is `Last 10`, prior is the 10 matches before those). Threshold `±0.03` → `↗` / `↘` / `▬`. If prior window has zero rounds, show `▬`.
- Impact bar: normalize `impact_rating` across the team in window (`x` mapped from team min → team max into `0..100`). When `impact_rating` is null, hide the bar.

### Map Pool derivations
- `aggregateByMap` on `vods.maps[]` for WR; sample = number of maps played on that map in window.
- Trend: same window-vs-prior-window comparison on WR. Threshold `±5%`.
- Confidence: `HIGH` if `samples ≥ 8`, `MEDIUM` if `4–7`, `LOW` if `< 4`. v1 uses sample size only — variance heuristics can come later.

### Match Reports derivations
- One card per vod **within the currently selected filter window**, in `match_date desc` order. All four sections (hero, player impact, map pool, match reports) respond to the same filter; there is no separate "show all matches" override.
- Score: from `vod.maps[]`. BO1 → single `score_us — score_them`. BOn → stack each map's score with map label.
- Top performers: take the demo linked to the vod via `linkDemosToVods`; pick the top 3 roster `demo_players` rows by rating (rounds-weighted). Skip if no linked demo.

---

## 6. Visual Treatment

### Tokens
- All existing tokens stay. Add `--role-lurker: #a855f7` to `cs2-hub/style.css` `:root`.
- Role color map:
  - `IGL` → `--warning` (#ffb347)
  - `Entry` → `--danger` (#ff4d4d)
  - `AWPer` → `--special` (#3aa0ff)
  - `Support` → `--accent` (#00ff9c)
  - `Lurker` → `--role-lurker` (#a855f7)

### Hero
- `background: var(--glass-bg)` over a 3%-opacity grid overlay (CSS gradient lines every 32px, no image asset).
- `border: 1px solid var(--glass-border)`.
- `box-shadow: 0 0 30px rgba(0,255,156,0.08)` (matches the doc's hero glow but uses existing accent).
- Record numerals: `font-family: var(--display-font)`, `font-size: 44px`, `font-weight: 800`, color-split (`--accent` / `--danger` / `--muted`).
- Section labels: `font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted)`.

### Player cards
- `background: var(--glass-bg)`, `border: 1px solid var(--glass-border)`, `border-left: 3px solid <role-color>`.
- Hover: `transform: translateY(-2px); box-shadow: 0 0 20px rgba(0,255,156,0.14); transition: 220ms ease`.
- Rating numeral 24px, role label 9px uppercase letterspaced.
- Impact bar 4px tall, `--accent` fill on translucent track.

### Map pool table
- Borderless rows, 1px bottom divider at `rgba(255,255,255,0.04)`.
- Confidence label colored: HIGH `--accent`, MEDIUM `--warning`, LOW `--danger`.
- Row hover: `background: rgba(255,255,255,0.03); cursor: pointer`. Click filters Match Reports below to that map.

### Match cards
- `background: rgba(15,25,38,0.5)`, `border-radius: 8px`, padding 14px.
- 4px left border: win `--accent`, loss `--danger`, draw `--muted`.
- Score numeral 26px, `var(--display-font)`, 800.
- Click → existing `vod-detail.html?id=<id>`.

### Filters
- Pills live in the hero's right column. Two pill groups: time window (`Last 10 / 30d / 90d / All`) and match type (`All / Scrim / Tourn. / Pug`).
- Reuse `vods-filter.js`'s state; rendering moves into the hero component. The filter behavior is unchanged — same window logic, same match_type values.

### Empty states
- No matches at all: hero collapses to a single "Add your first match" CTA, all sections below hidden.
- Matches exist but window is empty: hero shows totals=0, sections below show their own empty messages ("No matches in window", "No map data yet", etc.).

---

## 7. File-Level Changes

### Replace
- `cs2-hub/vods.html` — new markup: hero shell + 4 section slots.
- `cs2-hub/vods.js` — new orchestrator that renders the hero + delegates to per-section modules.
- `cs2-hub/vods-team-stats.js` — replaced by `vods-hero.js`.
- `cs2-hub/roster-stats.js` — replaced by `vods-player-impact.js`.
- `cs2-hub/roster-stats-render.js` — drawer body builder stays (still used by `player-drawer.js`), but the band-card rendering it does for the old layout is removed.

### Add
- `cs2-hub/vods-hero.js` — renders hero section, owns the sparkline and the filter pill row.
- `cs2-hub/vods-player-impact.js` — renders the 5-up player grid with trend arrows and impact bars.
- `cs2-hub/vods-map-pool.js` — renders the map table, emits a "filter to map" event.
- `cs2-hub/vods-match-reports.js` — renders the match cards, listens for "filter to map".
- `cs2-hub/vods-trend.js` — pure helper: `computeTrend(currentValue, priorValue, threshold)` → `'up' | 'down' | 'flat'`. Reused by player impact and map pool.

### Keep unchanged
- `cs2-hub/vods-filter.js` (filter state machine — caller just mounts it differently)
- `cs2-hub/roster-stats-aggregate.js` (pure aggregation helpers)
- `cs2-hub/player-drawer.js` (drawer plumbing)
- `cs2-hub/auto-fill-vod.js` (demo↔vod linker)

### Style
- Append a `/* ── Results & Review (tactical) ── */` block to `cs2-hub/style.css` with the new classes. Reuse tokens; only one new token (`--role-lurker`).

---

## 8. Testing

Match the codebase's existing pattern of `*.test.html` files driven by inline assertions.

- `cs2-hub/vods-trend.test.html` — unit tests for `computeTrend`: above/below threshold, null prior, zero values.
- `cs2-hub/vods-hero.test.html` — render with fixtures: full data, empty window, no matches at all. Assert record numerals, round WR string, best/worst presence.
- `cs2-hub/vods-player-impact.test.html` — render with a mock roster + demo_players fixture covering all 5 roles, a player with null impact, a player with no matches. Assert role color class and trend arrow per card.
- `cs2-hub/vods-map-pool.test.html` — confidence labels at the 3/4/7/8 boundaries; map click emits the filter event with correct map.
- `cs2-hub/vods-match-reports.test.html` — BO1 vs BO3 score rendering, top-3 selection from demo_players, missing-demo case (card with no top performers section).

`roster-stats-aggregate.test.html` keeps passing untouched.

---

## 9. Migration / Risk

- No DB changes, no migrations.
- The page name and URL don't change, so sidebar nav, deep links, and existing `vods.html` references in `dashboard.js` / `schedule.js` / `opponent-detail.js` / `stratbook.js` continue to work.
- `vod-detail.html` (the per-match edit page) is unchanged — Match Report cards link into it as today.
- Old modules being removed (`vods-team-stats.js`, `roster-stats.js`) are only imported by `vods.js`. No external consumers. Confirmed via grep on import strings.

---

## 10. Open Questions

None. All scope locked in brainstorming Q1–Q2 and design walkthrough.
