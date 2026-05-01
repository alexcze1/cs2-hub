# Multi-Round Analysis Tool — Design Spec

**Status:** Draft for implementation
**Date:** 2026-05-01
**Subsystem:** CS2 Hub — Demo analysis (Subsystem A of the multi-round + public-corpus plan)

## Goal

Add a new top-level "Analysis" page to the CS2 Hub that lets a user pick any team and analyse all of that team's uploaded demos together — overlaying many rounds on the same map, and visualising every grenade landing across the filtered round set. Modeled on cs2.cam's multi-round analysis + grenade mode, scoped down to what's useful and shippable on the current data corpus (private uploads only; public HLTV corpus is a separate subsystem).

## Non-goals

- Heatmap mode
- Pattern search across grenades (clustering by position+timing tolerance)
- "Copy setpos" lineup-practice helper
- Sharable round-set playlists
- Public HLTV corpus integration
- Economy / situations / weapon-presence filters
- Player-level toggles (show/hide individual players from the overlay)
- Edits to the existing single-demo viewer

## Page structure & navigation

**New files:** `cs2-hub/analysis.html` and `cs2-hub/analysis.js`. New sidebar entry "Analysis" added between "Demos" and "Stratbook" in `cs2-hub/layout.js`.

**Layout (top → bottom):**

```
┌─────────────────────────────────────────────────────────────┐
│  Analysis      [Team picker: FaZe ▾]      [Overlay │ Grenade] │ ← header bar
├──────────┬──────────────────────────────────────────────────┤
│          │                                                  │
│ FILTERS  │              MAP CANVAS                          │
│          │              (full-bleed, letterboxed)           │
│ Map ▾    │                                                  │
│ Side     │                                                  │
│ Opp. ▾   │                                                  │
│ Date     │                                                  │
│ Won/Lost │                                                  │
│ Bombsite │                                                  │
│          │                                                  │
│ Result:  │                                                  │
│ N rounds │                                                  │
│ from M   │                                                  │
│ demos    │                                                  │
├──────────┴──────────────────────────────────────────────────┤
│  ◀  ──────●─────────────  0:42 / 1:55      ½× 1× 2× 4×       │ ← timeline (Overlay only)
└─────────────────────────────────────────────────────────────┘
```

- Header: team picker (left), title, mode pills (right).
- Left rail (~200 px): filter panel + live "N rounds matched / from M demos" readout.
- Center: canvas, letterboxed square map render (same approach as existing demo viewer's `tc()` / `mapSize` helpers).
- Bottom timeline: present in **Overlay** mode only, hidden in **Grenade** mode.

**Empty states:**
- Before a team is picked: dark canvas, "Pick a team to begin." centered.
- Team picked but filters yield zero rounds: "0 rounds match — try widening filters."

**URL state:** every filter and the current mode is encoded in the query string for sharing/bookmarking, e.g. `analysis.html?team=FaZe&map=de_mirage&side=ct&mode=overlay`.

## Data architecture — slim payload

**Why:** the existing `match_data` JSONB column is multi-megabyte per demo (full 64 Hz frames, kills, shots, weapons, hp, money, equipment). For the analysis tool we need only the subset that drives overlay/grenade rendering. Serving the full payload N times per analysis session burns Supabase free-tier egress quickly. Producing a slim derivative at parse time gives ~10× bandwidth reduction with no other changes.

**New column:** `match_data_slim jsonb` on the `demos` table, populated alongside `match_data` at parse time by the VPS parser.

**Slim payload shape (per demo):**

```json
{
  "meta": { "tick_rate": 64, "map": "de_mirage" },
  "rounds": [
    {
      "idx": 0,
      "side_team_a": "ct",
      "freeze_end_tick": 12480,
      "end_tick": 19200,
      "winner": "ct",
      "won_by": "elimination",
      "bomb_planted_site": null
    }
  ],
  "frames": [
    {
      "tick": 12480,
      "round_idx": 0,
      "players": [
        { "steam_id": "...", "team": "ct", "x": 123.4, "y": 567.8, "alive": true, "yaw": 90 }
      ]
    }
  ],
  "grenades": [
    {
      "round_idx": 0,
      "type": "smoke",
      "thrower_sid": "...",
      "thrower_team": "ct",
      "throw_tick": 13120,
      "land_x": 234,
      "land_y": 567,
      "trajectory": [[x, y], [x, y]]
    }
  ]
}
```

**Reductions vs full `match_data`:**
- Frames downsampled from 64 Hz → 4 Hz (every 16th tick). Smooth enough for overlay playback at typical viewing speeds.
- Per-frame players carry only `steam_id`, `team`, `x`, `y`, `alive`, `yaw` — drop `hp`, `weapon`, `money`, `equipment`, `flashed_until`, etc.
- Grenades retain landing coords + a sparse trajectory (~10 points) — drop full per-tick path.
- Drop entirely from slim: `kills`, `shots`, `bomb` event timeline (these stay on `match_data` for the single-demo viewer).

**Estimated size:** ~300–800 KB per demo (vs. 3–8 MB for full).

**Storage location decision:** v1 uses a JSONB column on `demos`. Migration to Supabase Storage (file-per-demo) is a viable later optimisation if egress or row-size becomes problematic; the slim payload shape is identical either way.

**Indexes** for filter queries on `demos`:
- `(ct_team_name, map)` and `(t_team_name, map)` — covers the common "team + map" lookup pattern.

**RLS:** no changes. `match_data_slim` inherits the existing row-level policies on `demos`.

## Ingest changes (VPS parser)

**File:** `vps/demo_parser.py`

Add a `build_slim_payload(parsed)` function that derives the slim shape from the parser's existing in-memory state. Call it after the full `match_data` is assembled. Write both columns in the same `UPDATE` statement so they stay consistent.

**Backfill:** one-time script `vps/backfill_slim.py` that reads each demo's `match_data`, computes slim, writes the column. Run once after deploy. Demos missing slim after backfill are treated as "skipped" by the analysis page (warning chip, not a hard error).

## Client data flow

### Step 1 — Corpus list (cheap, metadata only)

When a team is picked, fetch the demo list with no payloads:

```sql
select id, map, played_at, ct_team_name, t_team_name,
       score_ct, score_t,
       team_a_first_side, team_a_score, team_b_score
from demos
where status = 'ready'
  and (ct_team_name = :team or t_team_name = :team)
order by played_at desc
```

~1 KB per row. Used to populate the Map and Opponent dropdowns (only values present in the corpus appear) and the "M demos available" readout.

### Step 2 — Apply demo-level filters in client

Filters that prune at this step (no payload fetch yet): map, opponent, date range, last-N-matches.

### Step 3 — Fetch slim payloads for the narrowed demo set (parallel)

```js
const { data } = await supabase
  .from('demos')
  .select('id, match_data_slim, team_a_first_side')
  .in('id', narrowedIds)
```

Cached by demo `id` in a session-lifetime `Map`. Switching filters that don't change the demo set does not refetch.

### Step 4 — Build the round set in client

For each loaded demo:
- For each round, decide which roster the *selected team* was on that round, using `team_a_first_side` + `round.side_team_a`. **Per-round side mapping is the only correct way** — never trust frame-level `team` field for cross-match comparison, because rosters swap sides at halftime.
- Apply round-level filters: side (only rounds where the selected team was on the chosen side), won/lost, bomb plant site.
- Emit a `RenderRound` record:

```js
{ demoId, roundIdx, freezeEndTick, endTick, frames, grenades, hue }
```

`hue` is assigned from a fixed 20-color palette, cycled by index across the matched round set.

### Step 5 — Round set drives both modes

- **Overlay**: per animation frame, for each `RenderRound`, look up `frames[currentRelativeTick + freezeEndTick]` (binary search on the sparse 4 Hz frames, snap to nearest), draw each player as a faint hued dot.
- **Grenade Mode**: flatten all `grenades` arrays → render landing positions on the map and in the right-side list panel.

### Performance budget

- 10 demos × ~600 KB slim ≈ 6 MB transfer, ~1–2 s on average broadband.
- 10 demos × ~12 rounds avg × 10 players ≈ 1200 dots per animation frame in overlay — comfortable for canvas 2D at 60 fps.
- LRU-evict slim payloads beyond 50 demo IDs cached.
- No artificial cap on corpus size. Soft "Loading N demos, this may take a moment…" notice when N > 15.

## Overlay mode rendering

**Time model:** all rounds aligned to **round-relative tick** = `currentTick - freezeEndTick`. Round 0:00 = freeze ends, action starts. Timeline max = the longest matched round's duration. Shorter rounds simply stop emitting frames once their `endTick` is past.

**Animation loop** (reuses pattern from `cs2-hub/demo-viewer.js`):
- `state.relTick` advances at `tickRate × speed` per real second.
- Per frame: iterate all `RenderRound`s, find the nearest frame at `relTick + freezeEndTick`, draw each player as a hued dot at `(x, y)`.

**Visual treatment:**
- Each round assigned a distinct hue from a fixed ~20-color palette, cycled. All 10 players in a round share that hue. Lets the eye trace one round's path even with many rounds overlaid.
- Player dots: ~3 px radius, opacity 0.35.
- Optional **trail**: each player draws a fading polyline of the last ~30 frames (~7.5 s of round time). Toggleable via a small overlay control. Off by default (cheaper to render).
- Side coloring (CT blue / T orange) **off** in overlay mode — would fight with per-round hue. When the Side filter is set to **Both**, hues still differentiate rounds rather than sides; expect visual density to be high in that case.
- Dead players: stop drawing (no ghosts).

**Hover interaction (nice-to-have, may slip from v1):** hovering near a dot highlights all dots from that same round (brighten its hue, dim others) and shows a tooltip "Round 14 — vs NaVi 2026-04-12".

**Timeline:** single track 0:00 → max-round-length. Scrubbing jumps all rounds simultaneously to that relative tick. Play/pause + speed buttons (½× / 1× / 2× / 4×). Same component pattern as the demo viewer's swimlane.

**Map render:** reuse `worldToCanvas` from `cs2-hub/demo-map-data.js` and the letterboxed-square approach from the existing viewer (`tc()` helper, `mapSize = min(cw, ch)`).

## Grenade mode rendering

**Layout shift in this mode:**
- Bottom timeline hidden.
- Right-side panel appears (~280 px) listing every grenade in the filtered round set.
- Map fills the remaining width.

**Map rendering:**
- Each grenade in the filtered round set drawn as an icon at `(land_x, land_y)`:
  - **Smoke:** soft grey circle, ~24 px diameter (matches in-game smoke radius; density visually obvious where multiple smokes overlap).
  - **Molotov:** orange flame icon.
  - **Flash:** small yellow circle.
  - **HE:** small green circle.
- Reuse the icons/sprites already in `demo-viewer.js`'s `renderGrenades`.
- **Trajectory lines off by default** (would clutter at scale). Toggle: "Show throw paths" — when on, draws thin polyline from thrower position to landing for each grenade.

**Right-side panel — grenade list:**

```
┌─────────────────────────────┐
│  142 grenades               │
│  [All ▾] [Smoke|Moly|Flash|HE]   ← type filter pills
│  Sort: [Round ▾]            │
├─────────────────────────────┤
│ ◉ Smoke  R3   karrigan      │
│   1:20  CT  → CT smoke A    │
│ ◉ Moly   R3   ropz          │
│   1:18  CT  → CT moly mid   │
│ ◉ Flash  R5   broky         │
│   ...                       │
└─────────────────────────────┘
```

- Click a row → highlight that grenade on the map (pulse animation, dim all others).
- Hover a grenade on map → corresponding row scrolls into view + highlights.
- Sort options: by round, by type, by thrower.

## Filter panel UI

Left rail (~200 px), top-to-bottom:

```
┌──────────────────────┐
│ FILTERS              │  ← .label
│                      │
│ Map                  │
│ ┌──────────────────┐ │
│ │ Mirage         ▾ │ │  ← only maps present in corpus
│ └──────────────────┘ │
│                      │
│ Side                 │
│ [ CT ] [ T ] [Both]  │  ← segmented
│                      │
│ Opponent             │
│ ┌──────────────────┐ │
│ │ Any opponent   ▾ │ │  ← only opponents present
│ └──────────────────┘ │
│                      │
│ Date                 │
│ ○ All time           │
│ ● Last 30 days       │
│ ○ Last 10 matches    │
│ ○ Custom...          │
│                      │
│ Outcome              │
│ [Won] [Lost] [All]   │
│                      │
│ Bomb plant           │
│ [A] [B] [None] [All] │
│                      │
│ ─────────────────    │
│  ✓ 84 rounds         │  ← live readout
│    from 8 demos      │
│                      │
│ [ Reset filters ]    │
└──────────────────────┘
```

**Behaviour:**
- Dropdowns are **populated from the loaded corpus** — if the team never played Anubis, Anubis isn't in the Map dropdown. Same for Opponents.
- All filters compose with **AND** logic.
- Each filter change updates the URL and the rounds-matched readout immediately.
- "Reset filters" clears everything except team + map (those are baseline).
- **Stale-filter handling on team change:** if the new team's corpus doesn't contain a value referenced in the URL/state (e.g. a map the new team never played), that filter resets to its default (Map → first available map; Opponent → "Any").

**Mode toggle (top-of-canvas, not in filter panel):**
- Two pills: **Overlay** | **Grenade**. Active pill highlighted with the hub's accent purple.
- Switching modes preserves all filters — only the rendering and right-panel/timeline visibility changes.

**Visual style:** matches the existing hub's dark UI; reuses input/dropdown styling and CSS variables from `cs2-hub/style.css`.

## Error handling & edge cases

| Scenario | Behaviour |
|---|---|
| Team picker query fails (network) | Toast error + retry button; sidebar/header still navigable |
| Some demos have null `match_data_slim` (older demos pre-backfill) | Skip silently in render; show warning chip "N demos skipped — pending re-parse" |
| Selected map/filter combination yields zero rounds | Empty-state message in canvas, filter readout shows "0 rounds" |
| `worldToCanvas` returns out-of-bounds coords (corrupt parse) | Clip to map bounds; log to console; don't crash render loop |
| Slim payload fetch partially fails (one demo errors) | Continue with the rest; chip shows "N demo(s) failed to load" |

**Edge cases to handle explicitly:**
- **Halftime side-swap:** rosters swap sides at halftime in CS2. Per-round side mapping using `team_a_first_side` + `round.side_team_a` is the only correct way to filter; never trust the per-frame `team` field across rounds.
- **Maps without `_viewer.png`:** fall back to `_radar.png`, then to a flat dark canvas — same fallback chain as the existing viewer.
- **Demo with zero matching rounds after filtering:** still cached as "loaded", just contributes nothing to the render set.
- **Round-length variance:** the longest matched round sets the timeline max; shorter rounds stop emitting frames past their `endTick`.
- **Browser tab memory:** LRU eviction of slim payloads beyond 50 demos cached.

## Testing

**Unit tests (vitest, new):**
- `buildSlimPayload(parsed)` — fixed parsed-demo input → expected slim output. Run against a real parsed demo fixture committed to the repo.
- `narrowRoundsForTeam(slimPayloads, filters)` — corpus filtering pure function. Drives all the side-mapping correctness; the most fragile piece of logic and the one most worth pinning with tests.

**VPS parser change:** test with the existing pytest suite under `vps/tests/`; add `vps/tests/test_slim_payload.py` with one fixture demo and assertions on key slim-payload fields.

**Manual integration checklist** (in implementation plan):
- Pick team X, select Mirage CT, verify rounds-matched count matches a hand-computed expected value.
- Switch to Grenade Mode, verify smoke landings appear at sensible coords on Mirage A site.
- Filter to "won + bomb planted A", verify only those rounds remain.
- Refresh the page with all filters in URL — state restores correctly.

**No e2e/browser tests** — out of scope for this codebase's testing footprint.

## File map

| File | Change |
|---|---|
| `cs2-hub/analysis.html` | New — page shell, layout, styling |
| `cs2-hub/analysis.js` | New — corpus query, filter logic, render loop, mode toggling |
| `cs2-hub/layout.js` | Add "Analysis" sidebar entry |
| `cs2-hub/style.css` | Minor additions for filter panel components if needed |
| `cs2-hub/supabase-demos.sql` | Migration: add `match_data_slim jsonb` column + indexes |
| `vps/demo_parser.py` | Add `build_slim_payload(parsed)`; write to both columns at parse end |
| `vps/backfill_slim.py` | New — one-time backfill script for already-parsed demos |
| `vps/tests/test_slim_payload.py` | New — fixture-based unit test for slim payload shape |
| `cs2-hub/__tests__/analysis.test.js` (or co-located) | New — vitest tests for `narrowRoundsForTeam` |

## Out of scope (deferred to follow-up specs)

- Heatmap mode
- Grenade pattern search (clustering by position+timing tolerance)
- "Copy setpos" lineup-practice helper
- Sharable round-set playlists
- Public HLTV corpus integration (Subsystem B)
- Economy / situations / weapon-presence / player-advantage filters
- Player-level toggles (show/hide individual players from the overlay)
- Hover-to-highlight-round interaction (may slip from v1)
