# Demo Team Assignment Overhaul

**Date:** 2026-05-04
**Status:** Approved

## Problem

Two issues in the existing demo team-name assignment flow:

1. **Multi-map series falls back to per-map naming.** `detectRosters` requires every CT-side player on map N to be a strict subset of either roster from map 1's `frames[0]`. Any single substitution breaks this, and so does any case where `frames[0]` was captured before all 10 players spawned in. The user reports this fails on virtually every series, defeating the "name once, applies to all maps" UX.

2. **Naming is opt-in.** The realtime listener auto-pops the modal when parsing finishes, but if the user dismisses it (or uploaded the demo on another device, or opens an old unnamed demo) the viewer renders without team labels and there is no further nudge.

## Goals

- Multi-map series with the same lineup (or a single sub) names once, applies to every map.
- Opening a demo without team names blocks the viewer until names are entered.
- Existing realtime auto-pop on the demos list stays — the viewer gate is purely additive.
- Pure detection logic is unit-testable.

## Non-goals

- No backend changes. The VPS parser is not touched.
- No DB migration. We rely on existing `ct_team_name` / `t_team_name` columns.
- No change to the legacy by-side modal — it remains the fallback for genuine multi-lineup series.
- No change to single-demo (non-series) behavior beyond the added viewer gate.

## Approach

### Module split

Three new files; existing `demos.js` and `demo-viewer.js` become consumers.

- **`cs2-hub/assign-teams.js`** — pure module. No DOM, no Supabase. Exports:
  - `pickStartFrame(matchData)`
  - `detectRosters(demos)`
  - `namesForDemo(demo, rosterA, rosterB, nameA, nameB)`

- **`cs2-hub/assign-teams-modal.js`** — DOM + Supabase. Exports:
  - `showAssignTeamsModal(demoIdOrSeries, opts?)` where `opts` may include `onCancel` and `blocking`
  - `showLegacyBySideModal(demoId)`
  - Imports `attachTeamAutocomplete` and uses `assign-teams.js` for detection.

- **`cs2-hub/assign-teams.test.html`** — test page following the `pracc-sync.test.html` pattern. Tests the pure module only.

`demos.js` keeps its realtime-listener auto-pop (`maybeAutoOpenAssignModal`) and just imports the modal from the new file. `demo-viewer.js` imports the modal and adds the entry gate.

### Algorithm: `pickStartFrame(matchData)`

```
frames = matchData?.frames
if !frames or frames.length === 0: return null
for fr in frames:
  ct = fr.players filter team === 'ct'
  t  = fr.players filter team === 't'
  if ct.length >= 5 and t.length >= 5: return fr
return frames[0]   # best-effort fallback
```

Rationale: warmup or pre-spawn frames may have fewer than 10 players. We skip past them. If no frame ever has 5+5 (parser quirk or recording cut short), we degrade to today's behavior rather than refusing to detect anything.

### Algorithm: `detectRosters(demos)`

Anchor on map 1 = earliest `created_at`.

```
sorted = demos sorted by created_at asc
m1 = sorted[0]
fr = pickStartFrame(m1.match_data)
if !fr: return { rosterA: [], rosterB: [], confident: false }

meta = m1.match_data.players_meta ?? {}
nameOf = p => meta[p.steam_id]?.name ?? p.name ?? ''

rosterA = fr.players.filter(p => p.team === 'ct').map(...)   # 5 players ideally
rosterB = fr.players.filter(p => p.team === 't').map(...)

confident = rosterA.length === 5 and rosterB.length === 5
idsA = Set of rosterA steam_ids
idsB = Set of rosterB steam_ids

for d in sorted.slice(1):
  fr2 = pickStartFrame(d.match_data)
  if !fr2: continue   # skip — can't check this map, don't fail outright
  ctIds = fr2.players.filter(team === 'ct').map(steam_id)
  if ctIds.length < 5: continue   # incomplete — same reasoning
  overlapA = count of ctIds where id ∈ idsA
  overlapB = count of ctIds where id ∈ idsB
  if overlapA >= 3:   continue   # same A on CT
  if overlapB >= 3:   continue   # same B on CT
  # Neither side has majority → real lineup change
  confident = false
  break

return { rosterA, rosterB, confident }
```

The threshold is `≥3 of 5`. Because rosterA and rosterB are disjoint (CT and T from the same frame), at most one side can hit ≥3 in any 5-player CT lineup. No tie possible.

### Algorithm: `namesForDemo(demo, rosterA, rosterB, nameA, nameB)`

```
fr = pickStartFrame(demo.match_data)
if !fr: return { ct_team_name: null, t_team_name: null }

idsA = Set of rosterA steam_ids
ctIds = fr.players.filter(team === 'ct').map(steam_id)
overlapA = count of ctIds where id ∈ idsA
ctIsA = overlapA > (ctIds.length - overlapA)
# ↑ "more CT players are from roster A than not". Equivalent to majority.
# Tie or zero overlap → ctIsA = false → B on CT. Matches the legacy
# behavior of `ctIds.every(id => idsA.has(id))` which returned false when
# the CT side wasn't fully roster A.

return ctIsA
  ? { ct_team_name: nameA, t_team_name: nameB }
  : { ct_team_name: nameB, t_team_name: nameA }
```

This handles partial overlap (subs) gracefully: whichever roster contributes more players to a side wins that side's label.

### Viewer entry gate (in `demo-viewer.js`)

After the existing demo fetch, before any rendering:

```js
if (!demo.ct_team_name || !demo.t_team_name) {
  let target = demo.id
  if (demo.series_id) {
    const { data: sib } = await supabase
      .from('demos')
      .select('id,series_id,match_data,ct_team_name,t_team_name,created_at')
      .eq('series_id', demo.series_id)
      .order('created_at', { ascending: true })
    if (sib?.length) target = sib
  }
  const result = await showAssignTeamsModal(target, {
    onCancel: () => { window.location.href = 'demos.html' },
  })
  if (!result) return
  window.location.reload()
}
```

`onCancel` is invoked when the user clicks Cancel, presses Esc, or clicks the overlay backdrop. The modal resolves to `null` in those cases (existing contract). Save resolves to `{ nameA, nameB }`; we reload so the existing render path runs unchanged.

### Modal API change

Today `showAssignTeamsModal` takes only the id-or-array and resolves to `{ nameA, nameB }` or `null`. We add an optional second arg `opts`:

```ts
type AssignTeamsModalOpts = {
  onCancel?: () => void   // called when user cancels (resolve(null) is still emitted)
}
```

`opts` is optional and defaults to no-op. `demos.js` does not pass it. `demo-viewer.js` passes `onCancel` to redirect.

We do not change the modal's resolve shape, so existing callers keep working.

## Behavior matrix

| Scenario | Today | After |
|---|---|---|
| Series, identical 10 players | Often falls back to per-map (warmup frame) | Names once, applies to all |
| Series, 1 sub on map 2 | Always falls back to per-map | Names once, applies to all |
| Series, 3+ subs / different team | Falls back to per-map | Falls back to per-map (correct) |
| Single demo, named | Renders viewer | Renders viewer |
| Single demo, unnamed, opened | Renders viewer with side labels | Modal blocks, must save or cancel-to-list |
| Series demo, unnamed, opened | Renders viewer with side labels | Modal blocks, names all maps in series |
| Realtime auto-pop on parse-complete | Works | Works (unchanged) |

## Testing

Unit tests in `cs2-hub/assign-teams.test.html`:

- `pickStartFrame`:
  - Full first frame returns it.
  - Warmup frame (4+3) skipped; next 5+5 frame returned.
  - All frames partial → returns `frames[0]` (best-effort).
  - Empty `frames` → returns `null`.

- `detectRosters`:
  - Single demo, 5+5 → confident, rosters populated.
  - Two demos, same 10, sides swapped on map 2 → confident.
  - Two demos, 1 sub (4-of-5 overlap on a side) → confident.
  - Two demos, 3 subs (2-of-5 overlap) → not confident.
  - Map 1's `frames[0]` is 4+5 but `frames[1]` is 5+5 → confident with proper rosters.
  - Map 1 has only partial frames everywhere → not confident.

- `namesForDemo`:
  - Roster A on CT, full lineup → `ct_team_name === nameA`.
  - Roster A on T → `ct_team_name === nameB`.
  - One sub on this demo, A retains majority on CT → `ct_team_name === nameA`.
  - No frames → `{ ct_team_name: null, t_team_name: null }`.

Run via `node --input-type=module -e "..."` like `pracc-sync.test.html`.

No automated tests for the modal or viewer gate — exercised manually.

## Files touched

**New:**
- `cs2-hub/assign-teams.js`
- `cs2-hub/assign-teams-modal.js`
- `cs2-hub/assign-teams.test.html`

**Modified:**
- `cs2-hub/demos.js` — remove `detectRosters`, `namesForDemo`, `showAssignTeamsModal`, `showLegacyBySideModal`. Import them from new modules. Realtime auto-pop logic unchanged.
- `cs2-hub/demo-viewer.js` — add the entry gate after the demo fetch.

## Risks

- **Modal logic is moving but unchanged.** Risk of accidental behavior drift. Mitigated by extracting verbatim and only adding the `opts.onCancel` parameter.
- **`window.location.reload()` after Save** is a slightly heavier UX than re-fetching and re-rendering, but it guarantees the existing viewer init sequence runs cleanly with no half-initialized state. Acceptable for what is a one-time-per-demo flow.
- **Threshold of 3 is a magic constant.** Documented in code as a named const; if real-world data shows ≥4 needed (e.g., players sharing IDs across teams — unlikely), tweak in one place.
