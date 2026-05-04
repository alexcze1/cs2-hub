# Demo ↔ Vod Auto-Link

**Date:** 2026-05-04
**Status:** Approved

## Problem

Today, uploaded demos and the match log (`vods`) live in separate worlds:

- Pracc sync inserts a `vods` row when a scrim is scheduled — opponent + date + (sometimes) one map name in `maps[]`. No score.
- The user uploads a demo. Once parsed and named (via the assign-teams modal we just shipped), the demo carries `team_a_score`, `team_b_score`, `ct_team_name`, `t_team_name`, `map`, `played_at` — everything needed to fill in the score on the matching vod.
- But these never get connected. The user has to open the vod and manually type the score.

We want the connection to happen automatically: when a demo gets named (or when a new vod arrives via pracc sync), if there's a matching vod (or matching demo) on the other side, fill in the scores.

## Goals

- After the assign-teams modal saves, any matching vod gets its scores auto-filled and the user gets a quick visual signal it happened.
- After pracc sync inserts a new vod, if matching demos already exist, their scores fill the new vod silently in the background.
- Pure logic is unit-testable with no DOM/Supabase dependency.
- Never overwrites a score that's already there (manual edits or earlier auto-fills are preserved).

## Non-goals

- No backend / VPS changes. All logic in the browser modules.
- No new DB columns or migrations. Reuses `vods.maps` (jsonb), `vods.result`, `vods.demo_link`.
- No fuzzy / Levenshtein opponent matching. Case-insensitive + trimmed only.
- No retroactive bulk migration of historical demos / vods. Only triggers on save / insert events going forward. (The user can re-open and re-save a name to retrigger.)

## Approach

### Module split

One new pure module + two integration sites.

- **`cs2-hub/auto-fill-vod.js`** — pure module. No DOM, no Supabase. Exports:
  - `normName(name)` — trim + lowercase
  - `findCandidateVods(demo, vods)` — pure filter
  - `pickBestVod(candidates, demo)` — pure ranker
  - `scoresFromDemo(demo, opponentName)` — derives `{ score_us, score_them }` from demo + opponent name + `team_a_first_side`
  - `computeVodPatch(demos, vod)` — given one demo or all demos in a series and the chosen vod, produces a partial `{ maps, result?, demo_link? }` patch (or `null` if nothing to fill)

- **`cs2-hub/auto-fill-vod.test.html`** — Node/browser-runnable tests for all four pure helpers. Same pattern as `pracc-sync.test.html` and `assign-teams.test.html`.

- **`cs2-hub/assign-teams-modal.js`** — modified. After the existing supabase update succeeds (just before resolve), call a new helper `tryAutoFillVod(supabase, savedDemos, teamId)` that fetches candidate vods, applies the patch, and triggers a one-shot toast if anything was filled.

- **`cs2-hub/schedule.js`** — modified. The existing pracc-sync IIFE that inserts new vods is extended: after inserting, fetch ready+named demos in the relevant date window, group by series, and apply patches to the just-inserted vods.

### Algorithm: `findCandidateVods(demo, vods)`

```
demoDate = the YYYY-MM-DD of demo.played_at (or demo.created_at as fallback)
demoNames = [normName(demo.ct_team_name), normName(demo.t_team_name)]

return vods.filter(v =>
  v.opponent &&
  demoNames.includes(normName(v.opponent)) &&
  abs(daysBetween(v.match_date, demoDate)) <= 1
)
```

`daysBetween` is calendar-day-difference (parses both as local dates). One-day-window in either direction.

### Algorithm: `pickBestVod(candidates, demo)`

Sort by:
1. `(maps?.length === 0 || all slots empty-of-scores)` first — fresh stubs preferred over filled vods
2. `abs(daysBetween(v.match_date, demoDate))` ascending — same-day before ±1
3. `created_at` ascending — deterministic tiebreak

Return the first; or `null` if `candidates.length === 0`.

### Algorithm: `scoresFromDemo(demo, opponentName)`

```
if !demo.team_a_first_side or demo.team_a_score == null or demo.team_b_score == null:
  return null   # parser hasn't populated; can't fill

# team_a is the team that started on team_a_first_side.
# So team_a's name = ct_team_name if team_a_first_side === 'ct', else t_team_name.
teamAName = team_a_first_side === 'ct' ? ct_team_name : t_team_name
teamBName = team_a_first_side === 'ct' ? t_team_name  : ct_team_name

# Identify "us" — the team whose name is NOT the opponent.
opp = normName(opponentName)
if normName(teamAName) === opp:  # team_a is them
  return { score_us: team_b_score, score_them: team_a_score }
if normName(teamBName) === opp:  # team_b is them
  return { score_us: team_a_score, score_them: team_b_score }
return null   # neither name matches; should not happen post-filter
```

### Algorithm: `computeVodPatch(demos, vod)`

```
demos can be a single demo or an array (a series). Normalize to array.

newMaps = clone(vod.maps ?? [])
filledAny = false
filledMapNames = []   # track for the toast / log

for demo in demos:
  # Skip demos missing required fields.
  scores = scoresFromDemo(demo, vod.opponent)
  if !scores: continue

  demoMap = (demo.map || '').toLowerCase()

  # Find slot. Three priorities:
  # (a) slot.map matches demo.map (case-insensitive)
  # (b) slot has no map name set (empty stub) — fill its map AND scores
  # (c) maps[] is empty — append a new slot
  let slotIdx = newMaps.findIndex(s => (s.map || '').toLowerCase() === demoMap && demoMap)
  if slotIdx === -1:
    slotIdx = newMaps.findIndex(s => !s.map)
    if slotIdx !== -1: newMaps[slotIdx].map = demo.map   # claim the empty stub
  if slotIdx === -1:
    newMaps.push({ map: demo.map })
    slotIdx = newMaps.length - 1

  slot = newMaps[slotIdx]

  # Never overwrite.
  if slot.score_us != null || slot.score_them != null: continue

  slot.score_us = scores.score_us
  slot.score_them = scores.score_them
  filledAny = true
  filledMapNames.push(demo.map)

if !filledAny: return null

patch = { maps: newMaps, _filledMapNames: filledMapNames }   # _filledMapNames is metadata for the caller (toast); strip before sending

# Result derivation: only when EVERY slot now has scores.
if newMaps.every(s => s.score_us != null && s.score_them != null):
  let usWins = newMaps.filter(s => s.score_us > s.score_them).length
  let themWins = newMaps.filter(s => s.score_us < s.score_them).length
  if usWins > themWins:      patch.result = 'win'
  else if themWins > usWins: patch.result = 'loss'
  else:                       patch.result = 'draw'

# Demo link: only meaningful for single-map non-series uploads. Setting it
# for a series picks an arbitrary demo, which is misleading.
if demos.length === 1 && !demos[0].series_id && !vod.demo_link:
  patch.demo_link = `demo-viewer.html?id=${demos[0].id}`

return patch
```

The `_filledMapNames` field is a private convention between the pure helper and the integration code. The integration strips it before calling `supabase.from('vods').update(patch)`.

### Trigger A: assign-teams modal save

In `cs2-hub/assign-teams-modal.js`, after the existing batch `update` finishes successfully (the loop that writes `ct_team_name`, `t_team_name`, etc.), and before the modal resolves, call:

```js
await tryAutoFillFromModal(supabase, savedDemoRows, teamId)
```

`savedDemoRows` is the list of demos whose names were just persisted. The helper:

1. For each demo, fetch candidate vods:
   ```js
   const { data: vods } = await supabase
     .from('vods')
     .select('id, opponent, match_date, maps, result, demo_link, created_at')
     .eq('team_id', teamId)
     .gte('match_date', dateMinus1)
     .lte('match_date', datePlus1)
   ```
   (One query per series, broadest date range covering all demos in series.)

2. Filter via `findCandidateVods` + `pickBestVod`.

3. Group demos by chosen vod (a series can map to one vod; or different demos in the series may map to different vods if pracc made one-event-per-map).

4. For each (vod, demos) group: `computeVodPatch(demos, vod)` → strip `_filledMapNames` → `update`.

5. If any patches applied: show a toast like:
   `"Linked match vs Astralis — added scores for mirage, inferno"`
   (Uses a tiny inline toast — append a styled `<div>` to `body`, fade in, fade out after 4s. ~30 lines of self-contained code.)

Error handling: any DB error in the auto-fill is caught and console.warn'd; it never fails the modal save. The names were already persisted by the time we get here.

### Trigger B: pracc sync after insert

In `cs2-hub/schedule.js`, the existing IIFE around line 67-88 already does the insert. After `supabase.from('vods').insert(newPayloads)`, capture the inserted ids by re-querying (or use `.insert(...).select()`), then:

1. Compute the date window (min and max `match_date` across `newPayloads` ± 1 day).

2. Fetch demos:
   ```js
   const { data: demos } = await supabase
     .from('demos')
     .select('id, series_id, ct_team_name, t_team_name, map, team_a_score, team_b_score, team_a_first_side, played_at, created_at')
     .eq('team_id', teamId)
     .eq('status', 'ready')
     .not('ct_team_name', 'is', null)
     .gte('played_at', dateRangeStart)
     .lte('played_at', dateRangeEnd)
   ```

3. Group demos by `series_id` (singletons keep their own group keyed by demo id).

4. For each just-inserted vod, find candidate demo-groups via `findCandidateVods` (run inverted: a vod is "matching" for a demo group if any demo in the group passes the filter). Pick best group. Apply patch. Update.

5. Console.log a summary; no UI surface (this runs silently as part of calendar render).

### Schema fact-check

- `demos`: `id`, `team_id`, `status`, `map`, `played_at`, `team_a_score`, `team_b_score`, `team_a_first_side` (`'ct'|'t'`), `ct_team_name`, `t_team_name`, `series_id`. Verified against `cs2-hub/supabase-demos.sql`.
- `vods`: `id`, `team_id`, `opponent`, `match_date` (date), `maps` (jsonb array of `{map, score_us?, score_them?}`), `result` (`'win'|'loss'|'draw'`), `demo_link`. Verified against `cs2-hub/supabase-setup.sql`.

## Behavior matrix

| Scenario | Result |
|---|---|
| Modal save, no matching vod | No-op. No toast. |
| Modal save, single demo, fresh pracc-stub vod (empty maps) | Vod gets `maps: [{map, score_us, score_them}]`, `result`, `demo_link`. Toast. |
| Modal save, single demo, vod with manual score in slot | Skipped. Toast not shown. |
| Modal save, BO3 series, three pracc-stub vods (one per map) | Each demo fills its own vod. Toast lists all maps. |
| Modal save, BO3 series, one vod with three map slots | All three slots filled in one update. `result` derived. Toast. |
| Modal save, demo with missing `team_a_first_side` | Silent skip for that demo only. |
| Pracc sync inserts new vod, demo already named with matching opponent + date | Vod auto-fills silently. Console log. |
| Two candidate vods (same opponent, ±1 day) | Pick: empty-maps first, then closest date. |
| Vod's opponent is "NaVi", demo's t_team_name is "navi" | Match (case-insensitive). |
| Demo's both team names equal vod opponent | Edge case; fall through (unrealistic in practice). |

## Testing

`cs2-hub/auto-fill-vod.test.html` covers all pure helpers:

**`normName`**:
- Trims and lowercases. `"  NaVi  "` → `"navi"`. Null/undefined → `""`.

**`findCandidateVods`**:
- Empty vods → empty.
- Same opponent, same day → match.
- Same opponent, ±1 day → match.
- Same opponent, ±2 days → no match.
- Different opponent → no match.
- Case-insensitive match.
- Demo with no team names → empty.

**`pickBestVod`**:
- One candidate → returns it.
- Two candidates: one with empty maps[] → empty wins.
- Two candidates: one with all-empty-scores maps[] → preferred over filled.
- Two candidates same maps state → closer-date wins.
- Empty list → null.

**`scoresFromDemo`**:
- team_a_first_side='ct', team_a is opponent (matches ct_team_name) → score_us = team_b_score.
- team_a_first_side='ct', team_b is opponent (matches t_team_name) → score_us = team_a_score.
- team_a_first_side='t', symmetric.
- Missing scores → null.
- Missing team_a_first_side → null.
- Opponent name matches neither team → null.

**`computeVodPatch`**:
- Single demo, vod with one empty stub matching map → fills, sets result, sets demo_link.
- Single demo, vod with empty maps[] → appends, sets result, sets demo_link.
- Single demo, vod slot already has scores → null patch.
- Single demo, vod slot for different map → appends new slot, no result (other slot still empty).
- Series of 3 demos, vod with 3 empty slots → all filled, result derived.
- Series of 3 demos, vod with 3 slots and two already scored → the third slot gets filled; since all three are now scored, result IS derived.
- Series of 3 demos, vod with 4 empty slots → 3 filled; 1 still empty, so result is NOT derived.
- Series of 3 demos, only 1 has valid scores (parser quirk) → fills 1; remaining slots still empty, result not set.
- Series → no demo_link set.

## Files touched

**New:**
- `cs2-hub/auto-fill-vod.js`
- `cs2-hub/auto-fill-vod.test.html`

**Modified:**
- `cs2-hub/assign-teams-modal.js` — call auto-fill after save, show toast.
- `cs2-hub/schedule.js` — call auto-fill after pracc-sync vod insert.

## Risks

- **Inserted-vod ids:** `supabase.from('vods').insert(newPayloads)` doesn't return ids by default. We need `.select()` to get them, or re-query by `external_uid`. Plan calls `.select()` to keep it simple.
- **Race between trigger A and trigger B:** if a demo and vod both arrive close in time, both triggers may fire. Both produce idempotent patches (never overwrite), so the second one is a no-op.
- **Toast rendering during modal close:** the modal removes its overlay before resolving. The toast is appended to `document.body` independently — it's not parented to the overlay, so it survives the modal close.
- **Demos.js currently passes `{ onSave: loadDemos }` — the auto-fill runs INSIDE the modal, so the toast shows BEFORE `loadDemos` refreshes the list. Fine — they're independent UIs.**
