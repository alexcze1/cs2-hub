# Antistrat Drawer (Demo Viewer + Analysis)

**Date:** 2026-05-04
**Status:** Approved

## Problem

Antistrats are edited only on `opponent-detail.html`. While the user is watching demos in `demo-viewer.html` or working in `analysis.html`, they want to write down observations into the antistrat in real time. Today they have to leave the replay to do it, which breaks the analysis flow.

## Goals

- A right-side drawer on `demo-viewer.html` and `analysis.html` that edits the same `opponents.antistrat` jsonb the detail page already uses.
- Notes persist live (autosave), so the user never loses observations.
- Drawer state (open/closed, last opponent / map / side) persists across sessions.
- No regressions on `opponent-detail.html` — it keeps its explicit Save button and current behavior.

## Non-goals

- No DB schema change. The `opponents.antistrat` jsonb stays as-is.
- No realtime sync between two tabs editing the same opponent (last-write-wins is acceptable).
- No mobile-optimized layout. Desktop only. On viewports narrower than 720px the drawer's toggle pill is hidden and `mountAntistratDrawer` is a no-op.
- No automatic opponent or map detection from the current replay — both pickers are manual (per design decision).
- No new antistrat fields. Drawer renders the existing position grid + plan sheet for ONE side at a time.

## Approach

### Module split

Two new files; existing `opponent-detail.js` becomes a consumer.

- **`cs2-hub/antistrat-editor.js`** — pure-ish render module. No Supabase, no DOM event wiring beyond input listeners. Exports:
  - `renderPositionsGrid(map, side, antistratData, onChange)` — returns HTML string + a wire function for input listeners.
  - `renderPlanSheet(map, side, antistratData, onChange)` — same pattern for the plan section (pistols, antiecos, tendencies, exploits, solutions).
  - Imports `MAP_POSITIONS` from `cs2-hub/map-positions.js` (extracted from `opponent-detail.js` as part of this work).
  - `onChange(field, value)` is invoked with a normalized path (e.g. `{ map, side, kind: 'position', pos }` or `{ map, side, kind: 'plan', field }`) so the caller decides how to persist.

- **`cs2-hub/antistrat-drawer.js`** — DOM + Supabase. Exports `mountAntistratDrawer({ teamId })`. Owns:
  - The toggle pill, drawer shell, sticky header (opponent dropdown, map dropdown, T/CT toggle, link to detail page, close button).
  - Loading opponents from Supabase and rendering pickers.
  - Calling `antistrat-editor.js` to render the body.
  - The 500ms debounced autosave loop that PATCHes `opponents.antistrat`.
  - LocalStorage persistence of UI state.
  - Keyboard shortcut binding.

### Modifications

- `cs2-hub/opponent-detail.js` — refactor to import from `antistrat-editor.js`. Behavior unchanged: Save button still commits, no autosave introduced. This is purely an extraction so the drawer can reuse the same rendering.
- `cs2-hub/demo-viewer.js`, `cs2-hub/demo-viewer.html` — import and call `mountAntistratDrawer` after page init. Drawer DOM is appended to `<body>`, not inside the viewer's layout shell, so it overlays cleanly.
- `cs2-hub/analysis.js`, `cs2-hub/analysis.html` — same.

### Data flow

1. **Mount.** `mountAntistratDrawer({ teamId })` runs after page init. Reads `localStorage` keys `antistratDrawer.<teamId>.{open,opponentId,map,side}`. If `open=true`, drawer slides in immediately; otherwise stays closed.

2. **Open.** First open per session triggers a one-shot fetch:
   ```js
   supabase.from('opponents').select('id, name, antistrat, selected_maps').eq('team_id', teamId).order('name')
   ```
   Result cached in module-local memory. Header dropdown populates with opponent names. If opponents list is empty: drawer body shows an empty state with a link to `opponents.html`.

3. **Pick opponent.** Sets `state.opponentId`, persists to localStorage, repopulates the map dropdown from the chosen opponent's `selected_maps[]`. If empty: drawer body shows "Add maps to this opponent" with a link to `opponent-detail.html?id=<opponentId>`.

4. **Pick map + side.** State updates and the body re-renders via `antistrat-editor.js` for the chosen `(opponent.antistrat[map], side)`.

5. **Edit.** Each input fires `onChange` immediately into a local working copy of the opponent's `antistrat` object. A 500ms-debounced save flushes the working copy to Supabase:
   ```js
   supabase.from('opponents').update({ antistrat: workingCopy }).eq('id', opponentId)
   ```
   Per-section "✓ saved" indicator next to the title flickers green for ~1s on success; red dot on error (with `console.warn`). The whole `antistrat` jsonb is rewritten each save — same pattern as the existing detail-page Save handler.

6. **Close.** Drawer hides; localStorage updates; pending debounced save flushes immediately on close.

### UI mechanics

- **Toggle pill:** fixed-position element on the right edge of the viewport, vertical orientation, label "Antistrat", always visible (z-index above replay UI but below modals). Click toggles drawer.
- **Keyboard:** `KeyN` toggles drawer. Ignored when focus is in an input/textarea (matching the existing demo-viewer keydown guard at `demo-viewer.js:1439`).
- **Drawer:** fixed-position `<aside>`, 480px wide, full viewport height, slides via `transform: translateX(...)` 200ms ease. Floating overlay — replay does NOT resize. Drop-shadow on left edge.
- **Sticky header:** opponent dropdown, map dropdown, T/CT toggle, "Open detail page →" link (right-aligned), close X button.
- **Body:** scrollable. Single side rendered at a time. Position grid on top, plan sheet below.
- **Narrow viewport:** at `window.innerWidth < 720`, `mountAntistratDrawer` returns early — toggle pill never renders, keybind not bound. Desktop only by design.

### Persistence semantics

- LocalStorage key prefix: `antistratDrawer.<teamId>.`
- Keys: `open` (bool), `opponentId` (string), `map` (string), `side` ('t'|'ct').
- On opponent delete or map removal that invalidates the persisted selection, drawer falls back to "no opponent selected" rather than throwing.

## Behavior matrix

| Scenario | Behavior |
|---|---|
| First visit, drawer never opened | Pill visible, drawer closed |
| Open drawer, no opponents in DB | Empty state with link to opponents.html |
| Pick opponent with no `selected_maps` | Body shows "Add maps to this opponent" + link |
| Edit a position note | 500ms after last keystroke → autosave + ✓ indicator |
| Save error (network) | Red dot indicator, console.warn, retry on next change |
| Close drawer with pending save | Pending save flushes immediately |
| Open `opponent-detail.html` and edit while drawer is open in another tab | Last write wins, no crash; on next drawer open the cache reloads |
| Toggle T/CT | Re-renders body for same map; no save needed (no field changed) |
| Reload page with drawer previously open | Drawer reopens at last opponent/map/side |
| `KeyN` while focused in an input | No-op (existing guard pattern) |

## Files touched

**New:**
- `cs2-hub/antistrat-drawer.js`
- `cs2-hub/antistrat-editor.js`
- `cs2-hub/map-positions.js` — extracted from `opponent-detail.js`, where `MAP_POSITIONS` currently lives inline. Imported by both `antistrat-editor.js` and `opponent-detail.js`.

**Modified:**
- `cs2-hub/opponent-detail.js` — switch to importing render helpers from `antistrat-editor.js`. Save behavior unchanged.
- `cs2-hub/opponent-detail.html` — none (selectors stay the same).
- `cs2-hub/demo-viewer.js`, `cs2-hub/demo-viewer.html` — call `mountAntistratDrawer({ teamId })` post-init.
- `cs2-hub/analysis.js`, `cs2-hub/analysis.html` — same.

## Testing

- **Unit tests** (`cs2-hub/antistrat-editor.test.html` — Node-runnable like `auto-fill-vod.test.html`):
  - `renderPositionsGrid` produces inputs for every position in `MAP_POSITIONS[map][side]`.
  - Inputs prefilled from `antistratData[map][side+'_positions'][pos]`.
  - `onChange` fires with correct `{ map, side, kind:'position', pos, value }` payload.
  - `renderPlanSheet` produces the expected fields (pistols/antiecos/tendencies/exploits/solutions).
  - Empty `antistratData` for a map returns inputs with empty values (no crash).

- **Manual smoke** (no automated browser test):
  - Open `demo-viewer.html?id=...`, toggle drawer with pill and `KeyN`. Pick opponent + map + side, type into a position note, watch the ✓ indicator, refresh, confirm note persisted.
  - Same on `analysis.html`.
  - Pre-existing flow on `opponent-detail.html` still saves via the Save button and reads back identical data.

## Risks

- **Extraction risk.** Moving render code out of `opponent-detail.js` is a refactor that could introduce bugs in the detail page. Mitigation: extract verbatim, no logic changes in the same commit, smoke-test the detail page after the move.
- **Concurrent writers.** Drawer + detail page open in two tabs and both editing the same `antistrat` will last-write-wins clobber. Acceptable per the brainstorming decision; revisit if it bites.
- **LocalStorage staleness.** Persisted `opponentId`/`map` may reference deleted records. Drawer falls back gracefully (empty body + dropdown stays at the top option), but the user briefly sees a stale selection name. Acceptable.
- **`KeyN` collision.** Confirmed not bound today on either page. If a future feature claims it, drawer keybind needs to move.
