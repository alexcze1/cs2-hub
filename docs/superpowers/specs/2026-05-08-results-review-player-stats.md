# Results & Review — Player Stats Integration

**Status:** approved design, ready for implementation plan
**Date:** 2026-05-08
**Scope:** Add a per-player career stats view to the Results & Review page, integrated with the existing team-level stats. Reads only — computation happens at demo parse-time (already shipped).

## Goal

Coaches and players need to see individual performance across the team's match history, alongside team-level results. Today this only exists per-demo (in the demo viewer's Scoreboard overlay). We surface aggregated player stats on Results & Review (`vods.html`), filterable by time window and match type, with a drawer for deep per-player breakdowns. The team stat cards already on the page respect the same filter, so the two views stay coherent.

## Architecture

```
roster (existing)               demo_players (existing, populated)
  + steam_id text                 - steam_id, kills, deaths, adr, rating,
                                    hs_pct, kast_pct, multi_2k..5k,
                                    opening_kills, opening_deaths,
                                    clutches_won/lost, utility_dmg,
                                    flash_assists, traded_deaths,
                                    impact_rating, rounds_played,
                                    side ('all'|'ct'|'t'), team ('a'|'b')
        ↓ join on steam_id
roster-stats-aggregate.js       (pure functions, weighted by rounds)
        ↓
vods.js (orchestrator)
  ├── vods-filter.js            filter pills + tournaments toggle
  ├── vods-team-stats.js        existing top cards + map pool, filter-aware
  ├── roster-stats.js           NEW: roster band, click → drawer
  └── player-drawer.js          NEW: side drawer with full player breakdown
```

## Schema

### `roster` — add Steam ID

```sql
alter table roster add column if not exists steam_id text;
create index if not exists roster_steam_id_idx on roster (team_id, steam_id);
```

- Nullable. Roster rows without a Steam ID render in a disabled state.
- No unique constraint — borrowed-account scenarios are rare-but-legitimate; we surface a soft warning in the modal instead.
- One-time backfill via `roster-steam-backfill.js` (suggester only — final pick is user-confirmed in the roster modal).

No changes to `demo_players` or `demo_team_stats`. They already carry every metric we render.

## Data flow

### Match-pool resolution

Given the filter state `{ window, tournamentsOnly }`:

1. `select id, steam_id from roster where team_id=? and steam_id is not null` → `teamSteamIds` set.
2. `select * from vods where team_id=? and dismissed=false` (existing query), filtered client-side by:
   - `match_type = 'tournament'` if `tournamentsOnly` (the schema constrains this to `'scrim'|'tournament'|'pug'`)
   - `match_date >= cutoff(window)` for `'30d'|'90d'`
   - last 10 by `match_date` for `'10'`
   - all rows for `'all'`
3. Extract seed `demo_id` from each vod's `demo_link` field (format `demo-viewer.html?id=<uuid>` — populated by `auto-fill-vod.js` for single-demo vods).
4. **Series expansion** — Bo3/Bo5 vods have only one demo in `demo_link`; the rest share `series_id`. So:
   - `select id, series_id, played_at, map from demos where id IN (seedDemoIds)` → seed rows.
   - For each non-null `series_id`, `select id, played_at, map from demos where series_id IN (seriesIds)` → sibling rows.
   - Union seed + sibling demo IDs → `demoIds`.
5. `select * from demo_players where demo_id IN (demoIds) and side='all' and steam_id IN (teamSteamIds)` — one row per `(player, demo)` for our players only. Filtering by roster steam_ids (instead of `team='a'`) is robust to which side our team started on and naturally drops opponents and stand-ins.
6. Group by `steam_id`, aggregate (rules below), join roster on `steam_id` for display. Per-map breakdown re-joins the demos table on `map`. Recent-matches list re-joins demos for `played_at`/`map` and vods (by extracting demo_id back to vod via the same `demo_link`/`series_id` chain) for opponent + W/L.

**No-demo edge case:** if a vod has no `demo_link` (manually entered, never auto-linked), it contributes no demos to the per-player aggregation regardless of filter — same behavior as today's team Match Record card silently does for vods without parsed demos.

### Aggregation rules (weighted by `rounds_played`)

| Stat group | Stats | Aggregation |
|---|---|---|
| Counted sums | `kills`, `deaths`, `assists`, `multi_2k`–`multi_5k`, `opening_kills`, `opening_deaths`, `clutches_won`, `clutches_lost`, `flash_assists`, `traded_deaths` | `Σ` |
| Per-round rates | `adr`, `utility_dmg`, `impact_rating` | `Σ(stat × rounds) / Σ(rounds)` |
| Percentages | `hs_pct`, `kast_pct` | weighted avg by rounds |
| Rating | `rating` | weighted avg by rounds (HLTV-style; demos already store per-demo rating) |
| Derived | `kd` | `Σ kills / Σ deaths` |

### Caching

In-memory JS object keyed by `(window, tournamentsOnly, version)`, invalidated on filter change. No server-side cache — Supabase reads at this scale (~50–100 demos) are sub-second.

## UI

### Page structure (`vods.html`)

```
┌──────────────────────────────────────┐
│ Page header (existing)               │
├──────────────────────────────────────┤
│ Filter row [10|30d|90d|All] [Tour☐] │ ← NEW
├──────────────────────────────────────┤
│ Top stats grid (4 cards, existing)   │ filter-aware
├──────────────────────────────────────┤
│ Roster · Career Stats                │ ← NEW
│ [card][card][card][card][card]       │
├──────────────────────────────────────┤
│ Map Pool Performance (existing)      │ filter-aware
├──────────────────────────────────────┤
│ Match History (existing)             │ unchanged
└──────────────────────────────────────┘
                                  ┌─────────────────┐
                                  │ Player drawer   │ ← slides in on card click
                                  │ (right side)    │
                                  └─────────────────┘
```

### Filter row (`vods-filter.js`)

- Pill group: `Last 10` (default) · `30 days` · `90 days` · `All time`
- Toggle: `Tournaments only` (off by default)
- State persisted to `localStorage['vods:filter:v1']`
- Emits `{ window, tournamentsOnly }` via callback. Filter changes trigger re-render of team stats, roster band, and (if open) drawer.

### Roster band (`roster-stats.js`)

- Reads roster filtered to `team_id`, `role NOT IN ('Coach','Manager')`.
- Order: role priority `[IGL, Entry, AWPer, Lurker, Support]`, ties broken by nickname.
- Card: `<button class="player-card">` (keyboard accessible). Content: `username` (display name), `role` chip, `Rating value`. Tabular nums.
- States:
  - **Active**: rating value rendered, click opens drawer.
  - **No Steam ID**: greyed border, `Add Steam ID →` subtitle linking to `roster.html?edit=<id>`. Click goes to roster modal, not drawer.
  - **No matches in window**: `—` for rating, subtitle `No matches in window`. Click still opens drawer (which shows full empty state with "View all-time" shortcut).

### Player drawer (`player-drawer.js`)

Slides in from the right, 480px wide, full viewport height. Backdrop dims page (does not lock scroll). Closes on: backdrop click, Esc, close button, filter change. Focus trapped inside drawer while open.

**Sections in order:**

1. **Header** — avatar (initial in colored tile until HLTV avatars wire up), name, role, `{N} matches · {R} rounds · {window label}`
2. **Side splits strip** — three pills: `CT Rating`, `T Rating`, and overall `K/D` (latter not strictly a side split, but lives in the same compact pill row as a quick-glance complement)
3. **Headline grid** (5 cards) — `Rating`, `ADR`, `KAST%`, `HS%`, `Impact`
4. **Opening duels** (3 cards) — `Win %`, `First Kills`, `First Deaths`
5. **Clutches & Multi-kills** (4 cards) — `1vX won`, `3K`, `4K`, `Util DMG/round`
6. **Per-map** rows — for every map the player has played in window: `map · rating · W—L`, sorted by rating desc
7. **Recent matches** rows — last 10 demos in window: `vs opponent · map · rating · W/L`, links to `vod-detail.html?id=<vod>`

### Roster modal — Steam ID field (`roster.js`)

- Text input below the existing Nickname row, `placeholder="76561198…"`.
- Validation regex: `/^7656119\d{10}$/`. Empty allowed.
- "Suggest from recent demos" button → calls `roster-steam-backfill.js`. Returns top-N candidate `(steam_id, name, demo_count)` triples from the team's last 30 demos that aren't already assigned to another roster row. Displayed as a dropdown — user picks one, value populates the input.
- Soft warning banner if the entered ID is already assigned to another roster row: `This Steam ID is already assigned to {name}. Save anyway?`

### Style additions (`style.css`)

New tokens for the roster band, player card, drawer overlay/panel, drawer section labels. Reuses existing `--accent`, `--success`, `--danger`, `--muted`, `.stat-card`, `.stat-label`, `.stat-value`. No new color tokens.

## Module structure

```
cs2-hub/
  vods.js                          (modified — orchestrator only, ~60 lines)
  vods-filter.js                   (new)
  vods-team-stats.js               (new — extracted from vods.js)
  roster-stats.js                  (new)
  roster-stats-aggregate.js        (new — pure functions, testable)
  player-drawer.js                 (new)
  roster.js                        (modified — Steam ID field, suggester button)
  roster-steam-backfill.js         (new — suggester logic)
  demo-player-filters.js           (new — extracted isCoach + 'all'-row filter,
                                    shared with scoreboard.js)
  style.css                        (modified — band, card, drawer styles)
```

`vods.js` shrinks from ~215 lines to a thin orchestrator wiring filter → loaders → renderers.

## Edge cases

- **Vod has no `demo_link`** → counted in team Match Record (already is); excluded from per-player aggregation. Drawer's match count reflects parsed-stat demos only.
- **Vod's `demo_link` points at a non-existent demo** → defensive `where id = ANY(ids)` filters to extant rows.
- **Roster row with `steam_id` but zero demos in window** → card shows `—`, subtitle `No matches in window`. Drawer opens with empty state plus "View all-time" shortcut that switches the page filter to `All time`.
- **Demo has a `steam_id` not on roster** (stand-in, trial, parser quirk) → silently excluded from roster band aggregation. Surfaces only in the demo's own Scoreboard overlay.
- **Two roster rows assigned the same `steam_id`** → both cards show identical numbers. Soft warning shown in roster modal at save time; not blocked.
- **Coach-slot players** (`/^\s*COACH/i.test(name)`) → reuse existing `isCoach` filter, extracted to `demo-player-filters.js` and shared with `scoreboard.js`.
- **CT/T side rows + 'all' row** → headline aggregation uses `side='all'` only; side splits read `side IN ('ct','t')` rows. Matches existing scoreboard convention.
- **Bo3 series** (one vod, 2–3 demos) → counted as 1 toward W/L; per-player rounds and stats count each demo separately (correct — rounds are real rounds played).
- **Filter changes while drawer is open** → drawer reloads its data, scrolls to top.
- **Click same card twice** → drawer closes (toggle). Click different card while drawer open → swaps content, no close/open animation.
- **Tournaments-only toggle on** → only `match_type='tournament'` vods contribute. Scrims and PUGs drop out of both team stats and per-player aggregation simultaneously.

## Testing

Mirrors the repo's existing `*.test.html` pattern (browser-loaded, jsdom-style stubs).

| Test file | Coverage |
|---|---|
| `roster-stats-aggregate.test.html` | Weighted rating/ADR/KAST aggregation; per-map grouping; side split math; empty-input behavior. Pure functions, no Supabase. |
| `vods-filter.test.html` | Filter state shape; localStorage round-trip; cutoff math for `Last 10`/`30d`/`90d`/`all`; tournaments-only filter. |
| `roster-steam-backfill.test.html` | Candidate suggestion logic; deduping; exclusion of already-assigned IDs; ranking by demo count. |
| `player-drawer.test.html` | Open/close lifecycle; focus trap; Esc close; backdrop click; empty-state branch. |

**Manual end-to-end verification before claim-done:**

1. Load Results & Review with seeded demos.
2. For one player on one demo: drawer numbers match what `scoreboard.js` shows for that same player on that same demo.
3. Change filter — both team cards and roster band update; both reflect the same demo set.
4. Click each player; switch between players via roster band while drawer open.
5. Add a roster row without a Steam ID — verify disabled card and link-to-modal flow.

## Rollout

Single PR, additive change, no feature flag. Implementation order:

1. Migration: `alter table roster add column steam_id text` + index. Idempotent.
2. Roster modal: Steam ID field + "Suggest from recent demos" UX. Roster page works without anyone having a Steam ID yet.
3. Backfill suggester runs once; team owner fills in 5 IDs (~2 minutes).
4. `roster-stats-aggregate.js` + tests.
5. `vods-filter.js` + extracted `vods-team-stats.js` (no behavior change yet).
6. `roster-stats.js` + roster band wired into `vods.js`.
7. `player-drawer.js` + drawer wired in.
8. Style polish + manual end-to-end pass.

## Out of scope (deliberate)

- Dedicated player profile page (`player.html`) — drawer is enough for v1.
- Per-match scoreboard inline in Match History — already in demo viewer.
- Public/share links for player stats.
- Coach-vs-coach or player-vs-player comparisons.
- Charts, sparklines, time-series — text-only metrics in v1.
- HLTV-style player avatars on roster cards — placeholder initials until that infra lands.
