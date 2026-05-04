# Antistrat Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-side drawer to `demo-viewer.html` and `analysis.html` that edits the same `opponents.antistrat` jsonb the detail page uses, so users can take notes while watching replays.

**Architecture:** Extract `MAP_POSITIONS` into a tiny shared constants module. Extract the position-grid + plan-sheet renderers from `opponent-detail.js` into a pure `antistrat-editor.js` module that the existing detail page and the new drawer both consume. Build `antistrat-drawer.js` to own the drawer DOM, opponent/map/side pickers, 500 ms-debounced Supabase autosave, and localStorage UI state. Mount the drawer on demo-viewer and analysis pages.

**Tech Stack:** Vanilla ES modules (no bundler), Supabase JS client, ad-hoc browser-and-Node test runner via the existing `*.test.html` pattern.

**Spec:** `docs/superpowers/specs/2026-05-04-antistrat-drawer.md`

---

## File Structure

**New files:**
- `cs2-hub/map-positions.js` — `MAP_POSITIONS` constant only. Imported by `antistrat-editor.js` and `opponent-detail.js`.
- `cs2-hub/antistrat-editor.js` — Pure render helpers `renderPositionsGrid` and `renderPlanSheet`. No DOM event wiring beyond the input listeners they need to call `onChange`. No Supabase. Exports a `wire(rootEl, onChange)` style — see Task 2.
- `cs2-hub/antistrat-editor.test.html` — Browser- and Node-runnable tests for the render helpers.
- `cs2-hub/antistrat-drawer.js` — DOM + Supabase. Exports `mountAntistratDrawer({ teamId })`. Owns toggle pill, drawer shell, sticky header pickers, body rendering via `antistrat-editor.js`, debounced autosave, localStorage state, KeyN shortcut.

**Modified files:**
- `cs2-hub/opponent-detail.js` — import `MAP_POSITIONS` from `map-positions.js`; replace inline `posGridHTML` and `gpSheetHTML` with calls into `antistrat-editor.js`. Save behavior unchanged.
- `cs2-hub/demo-viewer.js` + `cs2-hub/demo-viewer.html` — import and call `mountAntistratDrawer({ teamId })` after page init.
- `cs2-hub/analysis.js` + `cs2-hub/analysis.html` — same.

---

## Task 1: Extract `MAP_POSITIONS` into a shared module

**Files:**
- Create: `cs2-hub/map-positions.js`
- Modify: `cs2-hub/opponent-detail.js:18-31`

- [ ] **Step 1: Create the constants module**

Write `cs2-hub/map-positions.js`:

```js
// Position labels per map and side. Source of truth shared by
// opponent-detail.js and antistrat-editor.js. Order is significant —
// each side renders its grid in this exact left-to-right order.

export const MAP_POSITIONS = {
  ancient:  { t: ['A','MID','AWP','CAVE','B'],                    ct: ['A','MID','AWP','CAVE','B'] },
  mirage:   { t: ['A','MID','FLOAT','AWP','B'],                   ct: ['A','CON','AWP','SHORT','B'] },
  nuke:     { t: ['OUTSIDE','FLOAT','AWP','2ND LBY','LOBBY'],     ct: ['OUTSIDE','AWP','DOOR','A','RAMP'] },
  anubis:   { t: ['A','FLOAT','AWP','MID','B'],                   ct: ['B','CON','AWP','MID','A'] },
  inferno:  { t: ['BANANA','B SUP','AWP','MID','APPS'],           ct: ['B','B SUP','AWP','SHORT','APPS'] },
  overpass: { t: ['A','FLOAT','AWP','CON','B'],                   ct: ['A','AWP','ROT','SHORT','B'] },
  dust2:    { t: ['B','MID','FLOAT','AWP','LONG'],                ct: ['B','MID','AWP','LONG','ROT'] },
}
```

- [ ] **Step 2: Update `opponent-detail.js` to import the constant**

Edit `cs2-hub/opponent-detail.js`. Replace lines 18-31 (the `MAPS`/`MAP_LABELS`/`MAP_IMG`/`MAP_POSITIONS` block) with:

```js
import { MAP_POSITIONS } from './map-positions.js'

const MAPS = ['ancient','mirage','nuke','anubis','inferno','overpass','dust2']
const MAP_LABELS = { ancient:'Ancient', mirage:'Mirage', nuke:'Nuke', anubis:'Anubis', inferno:'Inferno', overpass:'Overpass', dust2:'Dust2' }
const MAP_IMG    = { dust2: 'dust' }
function mapImgUrl(map) { return `images/maps/${MAP_IMG[map] ?? map}.png` }
```

The `import` line goes alongside the existing imports at the top of the file (after the existing `import` block, before the `function esc(...)` declaration). The other constants stay in place — only `MAP_POSITIONS` is moved.

- [ ] **Step 3: Smoke-test the detail page in a browser**

Open `cs2-hub/opponent-detail.html` (e.g. via the project's existing local server). Pick an opponent that has antistrat data. Confirm:
- Map selector still toggles maps.
- Position grid renders for the active map.
- All position labels and prefilled values appear.
- Save button still saves and reloads correctly.

Expected: identical behavior to before, no console errors.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/map-positions.js cs2-hub/opponent-detail.js
git commit -m "refactor(antistrat): extract MAP_POSITIONS into shared module"
```

---

## Task 2: Build `antistrat-editor.js` with render helpers (TDD)

**Files:**
- Create: `cs2-hub/antistrat-editor.js`
- Create: `cs2-hub/antistrat-editor.test.html`

The renderer is structured so each export returns `{ html, wire(rootEl) }`. The caller injects `html` into a container, then calls `wire(container)` to attach `input` listeners. `onChange` is a normalized callback (see spec §Approach).

- [ ] **Step 1: Write the failing tests**

Write `cs2-hub/antistrat-editor.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<script type="module">
import {
  renderPositionsGrid,
  renderPlanSheet,
  ensureMapAntistrat,
} from './antistrat-editor.js'
import { MAP_POSITIONS } from './map-positions.js'

function assert(condition, msg) {
  if (!condition) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}

// ---- ensureMapAntistrat ----
{
  const a = {}
  ensureMapAntistrat(a, 'mirage')
  assert(a.mirage, 'creates entry for missing map')
  assert(Object.keys(a.mirage.t_positions).length === 5, 't_positions seeded with 5 keys')
  assert(Object.keys(a.mirage.ct_positions).length === 5, 'ct_positions seeded with 5 keys')
  assert(a.mirage.t_plan.tendencies === '', 't_plan fields seeded empty')
  assert(a.mirage.ct_plan.solutions === '', 'ct_plan fields seeded empty')
}
{
  const existing = { mirage: { t_positions: { A: 'foo' }, ct_positions: {}, t_plan: {}, ct_plan: {} } }
  ensureMapAntistrat(existing, 'mirage')
  assert(existing.mirage.t_positions.A === 'foo', 'does not overwrite existing data')
}

// ---- renderPositionsGrid ----
{
  const data = { mirage: { t_positions: { A: 'player1', MID: '' }, ct_positions: {}, t_plan: {}, ct_plan: {} } }
  const { html } = renderPositionsGrid('mirage', 't', data)
  for (const pos of MAP_POSITIONS.mirage.t) {
    assert(html.includes(`data-pos="${pos}"`), `grid contains input for position ${pos}`)
  }
  assert(html.includes('value="player1"'), 'prefills A=player1')
}
if (typeof document !== 'undefined') {
  // wire fires onChange with normalized payload (browser-only — needs DOM)
  const data = { mirage: { t_positions: { A: '' }, ct_positions: {}, t_plan: {}, ct_plan: {} } }
  let last = null
  const root = document.createElement('div')
  const { html, wire } = renderPositionsGrid('mirage', 't', data, p => { last = p })
  root.innerHTML = html
  wire(root)
  const input = root.querySelector('input[data-pos="A"]')
  input.value = 'newplayer'
  input.dispatchEvent(new Event('input'))
  assert(last && last.kind === 'position', 'onChange payload kind=position')
  assert(last.map === 'mirage' && last.side === 't', 'onChange payload map+side')
  assert(last.pos === 'A' && last.value === 'newplayer', 'onChange payload pos+value')
  assert(data.mirage.t_positions.A === 'newplayer', 'wire mutates working copy in place')
}
{
  // empty antistratData[map] does not throw
  const { html } = renderPositionsGrid('mirage', 't', {})
  assert(html.length > 0, 'renders with empty data, no crash')
  assert(!html.includes('value="player'), 'no prefilled values when data missing')
}

// ---- renderPlanSheet ----
{
  const data = { mirage: { t_positions: {}, ct_positions: {}, t_plan: {}, ct_plan: { tendencies: 'they rush B' } } }
  const { html } = renderPlanSheet('mirage', 'ct', data)
  for (const f of ['pistols','antiecos','tendencies','exploits','solutions','style','forces']) {
    assert(html.includes(`data-field="${f}"`), `plan sheet contains textarea for ${f}`)
  }
  assert(html.includes('they rush B'), 'plan sheet prefills existing field')
}
if (typeof document !== 'undefined') {
  // wire fires onChange for plan field (browser-only — needs DOM)
  const data = { mirage: { t_positions: {}, ct_positions: {}, t_plan: {}, ct_plan: {} } }
  let last = null
  const root = document.createElement('div')
  const { html, wire } = renderPlanSheet('mirage', 'ct', data, p => { last = p })
  root.innerHTML = html
  wire(root)
  const ta = root.querySelector('textarea[data-field="tendencies"]')
  ta.value = 'observation'
  ta.dispatchEvent(new Event('input'))
  assert(last && last.kind === 'plan', 'onChange payload kind=plan')
  assert(last.map === 'mirage' && last.side === 'ct', 'plan onChange payload map+side')
  assert(last.field === 'tendencies' && last.value === 'observation', 'plan onChange payload field+value')
  assert(data.mirage.ct_plan.tendencies === 'observation', 'wire mutates plan in place')
}

console.log('antistrat-editor tests done')
</script>
</body>
</html>
```

- [ ] **Step 2: Run tests to verify they fail**

Extract the script tag and run with Node:

```bash
awk '/<script type="module">/,/<\/script>/' cs2-hub/antistrat-editor.test.html | sed '1d;$d' > /tmp/antistrat-editor.test.mjs
cd cs2-hub && node /tmp/antistrat-editor.test.mjs 2>&1 | tail -40
```

Expected: errors importing `antistrat-editor.js` (file does not exist yet).

- [ ] **Step 3: Implement `cs2-hub/antistrat-editor.js`**

```js
// Pure render helpers for the antistrat editor surface (position grid + plan
// sheet). No DOM globals, no Supabase. Each helper returns { html, wire }:
//   html — markup string the caller injects into a container
//   wire(rootEl) — attaches `input` listeners that mutate the working-copy
//     antistrat object in place AND call the optional onChange callback with
//     a normalized payload, so the caller can drive autosave / dirty flags.
//
// Spec: docs/superpowers/specs/2026-05-04-antistrat-drawer.md

import { MAP_POSITIONS } from './map-positions.js'

const PLAN_FIELDS = ['pistols','style','antiecos','forces','tendencies','exploits','solutions']
const PLAN_LABELS = { pistols:'PISTOLS', style:'STYLE', antiecos:'ANTIECOS', forces:'FORCES', tendencies:'TENDENCIES AND TELLS', exploits:'EXPLOITS', solutions:'SOLUTIONS' }
const PLAN_CLASSES = { pistols:'pistols-label', style:'style-label', antiecos:'antiecos-label', forces:'forces-label', tendencies:'tendencies-label', exploits:'exploits-label', solutions:'solutions-label' }
const PLAN_PLACEHOLDERS = {
  pistols: 'Pistol round tendencies…', style: 'AWP roles, special player habits…',
  antiecos: 'Anti-eco approach…', forces: 'Force buy patterns…',
  tendencies: 'Recurring patterns, giveaways…', exploits: 'Weaknesses we can abuse…',
  solutions: 'Our adjustments and counters…',
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Seed an empty per-map record on the working antistrat object so callers
// can mutate `t_positions[pos]` etc. without first checking shape.
export function ensureMapAntistrat(antistrat, map) {
  if (antistrat[map]) return
  const tPos = {};  MAP_POSITIONS[map].t.forEach(p => { tPos[p] = '' })
  const ctPos = {}; MAP_POSITIONS[map].ct.forEach(p => { ctPos[p] = '' })
  antistrat[map] = {
    t_positions:  tPos,
    ct_positions: ctPos,
    t_plan:  Object.fromEntries(PLAN_FIELDS.map(f => [f, ''])),
    ct_plan: Object.fromEntries(PLAN_FIELDS.map(f => [f, ''])),
  }
}

export function renderPositionsGrid(map, side, antistratData, onChange) {
  const positions = MAP_POSITIONS[map]?.[side] ?? []
  const data = antistratData?.[map]?.[`${side}_positions`] ?? {}
  const html = `<div class="pos-grid">
    ${positions.map(pos => `
      <div class="pos-cell">
        <div class="pos-label">${esc(pos)}</div>
        <input class="form-input pos-input" style="padding:6px 8px;font-size:13px"
          data-map="${esc(map)}" data-side="${esc(side)}" data-pos="${esc(pos)}"
          placeholder="player" value="${esc(data[pos] ?? '')}"/>
      </div>
    `).join('')}
  </div>`

  function wire(rootEl) {
    rootEl.querySelectorAll('input.pos-input').forEach(inp => {
      inp.addEventListener('input', e => {
        const { map: m, side: s, pos } = e.target.dataset
        const val = e.target.value
        if (antistratData[m]) antistratData[m][`${s}_positions`][pos] = val
        if (onChange) onChange({ map: m, side: s, kind: 'position', pos, value: val })
      })
    })
  }

  return { html, wire }
}

export function renderPlanSheet(map, side, antistratData, onChange) {
  const d = antistratData?.[map]?.[`${side}_plan`] ?? {}
  const pairs = [['pistols','style'], ['antiecos','forces']]
  const singles = ['tendencies','exploits','solutions']
  const html = `<div class="gameplan-sheet" style="margin-top:12px">
    ${pairs.map(([a, b]) => `
      <div class="gameplan-split">
        <div class="gameplan-block">
          <div class="gameplan-section-label ${PLAN_CLASSES[a]}">${PLAN_LABELS[a]}</div>
          <textarea class="form-textarea gameplan-textarea gp-field" data-map="${esc(map)}" data-side="${esc(side)}" data-field="${a}" placeholder="${esc(PLAN_PLACEHOLDERS[a])}">${esc(d[a] ?? '')}</textarea>
        </div>
        <div class="gameplan-block">
          <div class="gameplan-section-label ${PLAN_CLASSES[b]}">${PLAN_LABELS[b]}</div>
          <textarea class="form-textarea gameplan-textarea gp-field" data-map="${esc(map)}" data-side="${esc(side)}" data-field="${b}" placeholder="${esc(PLAN_PLACEHOLDERS[b])}">${esc(d[b] ?? '')}</textarea>
        </div>
      </div>
    `).join('')}
    ${singles.map(f => `
      <div class="gameplan-section-label ${PLAN_CLASSES[f]}">${PLAN_LABELS[f]}</div>
      <textarea class="form-textarea gameplan-textarea gp-field" style="min-height:70px" data-map="${esc(map)}" data-side="${esc(side)}" data-field="${f}" placeholder="${esc(PLAN_PLACEHOLDERS[f])}">${esc(d[f] ?? '')}</textarea>
    `).join('')}
  </div>`

  function wire(rootEl) {
    rootEl.querySelectorAll('textarea.gp-field').forEach(ta => {
      ta.addEventListener('input', e => {
        const { map: m, side: s, field } = e.target.dataset
        const val = e.target.value
        if (antistratData[m]) antistratData[m][`${s}_plan`][field] = val
        if (onChange) onChange({ map: m, side: s, kind: 'plan', field, value: val })
      })
    })
  }

  return { html, wire }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
awk '/<script type="module">/,/<\/script>/' cs2-hub/antistrat-editor.test.html | sed '1d;$d' > /tmp/antistrat-editor.test.mjs
cd cs2-hub && node /tmp/antistrat-editor.test.mjs 2>&1 | tail -40
```

Expected: all `PASS:` lines for the non-DOM tests, no `FAIL:`, ends with `antistrat-editor tests done`. The two wire-tests are guarded by `if (typeof document !== 'undefined')` so they are skipped in Node and only run in the browser. Open the test file in a browser to exercise the wire path:

```bash
# In a browser, navigate to cs2-hub/antistrat-editor.test.html and check the
# devtools console for PASS/FAIL output. All assertions should be PASS.
```

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/antistrat-editor.js cs2-hub/antistrat-editor.test.html
git commit -m "feat(antistrat): add pure render helpers for positions+plan"
```

---

## Task 3: Refactor `opponent-detail.js` to consume `antistrat-editor.js`

**Files:**
- Modify: `cs2-hub/opponent-detail.js:122-186` (replace `posGridHTML`, `gpSheetHTML`, `renderGameplans`)

The detail page keeps its single Save button and current behavior. We only swap the inline renderers for module calls. `MAP_POSITIONS` is already imported (Task 1).

- [ ] **Step 1: Add the editor import**

In `cs2-hub/opponent-detail.js`, alongside the other imports at the top, add:

```js
import { renderPositionsGrid, renderPlanSheet, ensureMapAntistrat } from './antistrat-editor.js'
```

- [ ] **Step 2: Replace `ensureMapData` with the editor's helper**

Delete the local `ensureMapData(map)` function (currently at lines 50-60). Replace all callers (`ensureMapData(map)` → `ensureMapAntistrat(antistrat, map)`). Confirm with:

```bash
grep -n "ensureMapData\|ensureMapAntistrat" cs2-hub/opponent-detail.js
```

Expected: only `ensureMapAntistrat(antistrat, ...)` calls remain.

- [ ] **Step 3: Replace `posGridHTML` and `gpSheetHTML` with editor-based equivalents**

Delete `posGridHTML` (currently lines 122-135) and `gpSheetHTML` (currently lines 137-167). Rewrite `renderGameplans` (currently lines 169-186) to use the editor module:

```js
function renderGameplans() {
  const el = document.getElementById('gameplan-panels')
  const map = selectedMaps[activeMapIdx]
  if (!map) { el.innerHTML = ''; return }
  ensureMapAntistrat(antistrat, map)

  const ctPositions = renderPositionsGrid(map, 't',  antistrat) // their T lineup, rendered above CT plan
  const tPositions  = renderPositionsGrid(map, 'ct', antistrat) // their CT lineup, rendered above T plan
  const ctPlan      = renderPlanSheet(map, 'ct', antistrat)
  const tPlan       = renderPlanSheet(map, 't',  antistrat)

  el.innerHTML = `
    <div class="gameplan-sheet" style="margin-top:16px">
      <div class="gameplan-title ct-title">CT GAMEPLAN <span style="font-weight:400;opacity:0.7">— vs their T side</span></div>
      <div class="gameplan-section-label t-positions-label">THEIR T-SIDE LINEUP</div>
      <div style="padding:10px 14px 14px">${ctPositions.html}</div>
      ${ctPlan.html}
    </div>
    <div class="gameplan-sheet" style="margin-top:16px">
      <div class="gameplan-title t-title">T GAMEPLAN <span style="font-weight:400;opacity:0.7">— vs their CT side</span></div>
      <div class="gameplan-section-label ct-positions-label">THEIR CT-SIDE LINEUP</div>
      <div style="padding:10px 14px 14px">${tPositions.html}</div>
      ${tPlan.html}
    </div>
  `

  ctPositions.wire(el); tPositions.wire(el)
  ctPlan.wire(el);      tPlan.wire(el)

  // Auto-grow textareas (preserve existing behavior).
  el.querySelectorAll('.gameplan-textarea').forEach(ta => {
    autoExpand(ta)
    ta.addEventListener('input', () => autoExpand(ta))
  })
}
```

The `printSheetHTML` function (lines 198-235) stays as-is — print uses its own renderer because the print layout differs from the on-screen layout.

`saveActivePlan` (lines 188-195) is still called by the map-selector, tab-switch, and Save handlers; it remains needed because the editor module mutates `antistrat` in place via `wire`, which means `saveActivePlan` is now redundant for the in-place fields. Leave the function in place but it becomes a no-op for the editor fields — the existing code path that reads from `.gp-field` data attributes still exits cleanly because mutating already happened. **Do not delete `saveActivePlan`** — `window.printAntistrat` calls it, and the worst case is it overwrites already-current values with the same already-current values.

- [ ] **Step 4: Smoke-test the detail page in a browser**

Open `cs2-hub/opponent-detail.html` for an existing opponent that has data on multiple maps. Confirm:
- Map selector toggles maps as before.
- Map tabs switch as before.
- Position grid renders with prefilled values, edits stick.
- Plan textareas render with prefilled values, edits stick.
- Auto-expand still works on textareas.
- Save button persists changes; reload reads them back identically.
- Print (window.printAntistrat) still produces the print sheet correctly.

Expected: identical user-visible behavior to before this task.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/opponent-detail.js
git commit -m "refactor(antistrat): consume antistrat-editor renderers from detail page"
```

---

## Task 4: Build `antistrat-drawer.js` and mount on demo-viewer

**Files:**
- Create: `cs2-hub/antistrat-drawer.js`
- Modify: `cs2-hub/demo-viewer.js` (add import + mount call), `cs2-hub/demo-viewer.html` (no change needed if the script tag covers the full module graph; verify)

This task builds the drawer from scratch and integrates with one host page. The next task adds the second host (analysis).

- [ ] **Step 1: Add drawer styles to `cs2-hub/style.css`**

Append at the end of `cs2-hub/style.css`:

```css
/* ── Antistrat Drawer ───────────────────────────────────────── */
.antistrat-pill {
  position: fixed; right: 0; top: 50%; transform: translateY(-50%);
  background: var(--accent); color: var(--bg, #fff);
  border: none; border-radius: 8px 0 0 8px;
  padding: 14px 8px; cursor: pointer; z-index: 90;
  writing-mode: vertical-rl; text-orientation: mixed;
  font-size: 12px; font-weight: 700; letter-spacing: 1px;
  box-shadow: -2px 0 8px rgba(0,0,0,0.15);
}
.antistrat-pill:hover { filter: brightness(1.1); }

.antistrat-drawer {
  position: fixed; top: 0; right: 0; height: 100vh; width: 480px;
  background: var(--surface, #fff); color: var(--text, #000);
  box-shadow: -4px 0 16px rgba(0,0,0,0.25);
  transform: translateX(100%); transition: transform 200ms ease;
  z-index: 95; display: flex; flex-direction: column;
}
.antistrat-drawer.open { transform: translateX(0); }

.antistrat-drawer-header {
  padding: 12px 14px; border-bottom: 1px solid var(--border);
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  background: var(--surface);
}
.antistrat-drawer-header select,
.antistrat-drawer-header button { font-size: 13px; }
.antistrat-drawer-header .side-toggle button {
  padding: 4px 10px; border: 1px solid var(--border);
  background: var(--surface); cursor: pointer;
}
.antistrat-drawer-header .side-toggle button.active { background: var(--accent); color: #fff; }
.antistrat-drawer-header .save-status { margin-left: auto; font-size: 11px; opacity: 0.7; }
.antistrat-drawer-header .save-status.ok { color: #2c8f4a; opacity: 1; }
.antistrat-drawer-header .save-status.err { color: #c0392b; opacity: 1; }
.antistrat-drawer-header .close-btn,
.antistrat-drawer-header .open-detail {
  background: transparent; border: 1px solid var(--border); padding: 4px 8px; cursor: pointer;
  text-decoration: none; color: inherit; font-size: 12px;
}

.antistrat-drawer-body { flex: 1; overflow: auto; padding: 12px 14px; }
.antistrat-drawer-empty { padding: 24px 14px; opacity: 0.7; font-size: 13px; }
.antistrat-drawer-empty a { color: var(--accent); }
```

- [ ] **Step 2: Write `cs2-hub/antistrat-drawer.js`**

```js
// Right-side drawer that lets users edit opponent antistrats while watching
// demos or doing analysis. Shares render helpers with opponent-detail via
// antistrat-editor.js. Owns: toggle pill, drawer shell, sticky header
// pickers, debounced Supabase autosave, localStorage UI state, KeyN shortcut.
//
// Public API: mountAntistratDrawer({ teamId }) — call once per page after
// page init. No-op on viewports narrower than 720px.
//
// Spec: docs/superpowers/specs/2026-05-04-antistrat-drawer.md

import { supabase } from './supabase.js'
import { renderPositionsGrid, renderPlanSheet, ensureMapAntistrat } from './antistrat-editor.js'

const NARROW_THRESHOLD = 720
const SAVE_DEBOUNCE_MS = 500

function lsKey(teamId, suffix) { return `antistratDrawer.${teamId}.${suffix}` }
function readLs(teamId, suffix, fallback) {
  try { const v = localStorage.getItem(lsKey(teamId, suffix)); return v == null ? fallback : JSON.parse(v) }
  catch { return fallback }
}
function writeLs(teamId, suffix, value) {
  try { localStorage.setItem(lsKey(teamId, suffix), JSON.stringify(value)) } catch {}
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function mountAntistratDrawer({ teamId }) {
  if (!teamId) return
  if (typeof window === 'undefined') return
  if (window.innerWidth < NARROW_THRESHOLD) return

  // ---- DOM scaffolding ----
  const pill = document.createElement('button')
  pill.className = 'antistrat-pill'
  pill.type = 'button'
  pill.textContent = 'Antistrat'
  document.body.appendChild(pill)

  const drawer = document.createElement('aside')
  drawer.className = 'antistrat-drawer'
  drawer.innerHTML = `
    <div class="antistrat-drawer-header">
      <select class="opponent-select"><option value="">Loading…</option></select>
      <select class="map-select"><option value="">—</option></select>
      <span class="side-toggle">
        <button type="button" data-side="t" class="active">T</button>
        <button type="button" data-side="ct">CT</button>
      </span>
      <span class="save-status" aria-live="polite"></span>
      <a class="open-detail" href="#" target="_blank" rel="noopener">Open detail →</a>
      <button type="button" class="close-btn" aria-label="Close">✕</button>
    </div>
    <div class="antistrat-drawer-body"></div>
  `
  document.body.appendChild(drawer)

  const opponentSelect = drawer.querySelector('.opponent-select')
  const mapSelect      = drawer.querySelector('.map-select')
  const sideButtons    = drawer.querySelectorAll('.side-toggle button')
  const statusEl       = drawer.querySelector('.save-status')
  const detailLink     = drawer.querySelector('.open-detail')
  const closeBtn       = drawer.querySelector('.close-btn')
  const bodyEl         = drawer.querySelector('.antistrat-drawer-body')

  // ---- State ----
  const state = {
    open:        readLs(teamId, 'open', false),
    opponentId:  readLs(teamId, 'opponentId', null),
    map:         readLs(teamId, 'map', null),
    side:        readLs(teamId, 'side', 't'),
    opponents:   null,           // null = unloaded; [] = loaded empty
    workingCopy: null,           // antistrat object for current opponent
    saveTimer:   null,
    saving:      false,
  }

  function setOpen(open) {
    state.open = open
    drawer.classList.toggle('open', open)
    writeLs(teamId, 'open', open)
    if (open && state.opponents == null) loadOpponents()
    if (open) renderBody()
    if (!open) flushPendingSave()
  }

  function setStatus(kind, msg) {
    statusEl.className = 'save-status' + (kind ? ' ' + kind : '')
    statusEl.textContent = msg ?? ''
    if (kind === 'ok') {
      clearTimeout(setStatus._t)
      setStatus._t = setTimeout(() => { statusEl.className = 'save-status'; statusEl.textContent = '' }, 1000)
    }
  }

  // ---- Loading ----
  async function loadOpponents() {
    const { data, error } = await supabase
      .from('opponents')
      .select('id, name, antistrat, favored_maps')
      .eq('team_id', teamId)
      .order('name')
    if (error) { console.warn('antistrat drawer: opponents load failed', error); state.opponents = []; renderBody(); return }
    state.opponents = data ?? []

    // Populate dropdown
    opponentSelect.innerHTML = `<option value="">— pick opponent —</option>` +
      state.opponents.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')
    if (state.opponentId && state.opponents.find(o => o.id === state.opponentId)) {
      opponentSelect.value = state.opponentId
      hydrateForOpponent()
    }
    renderBody()
  }

  function getCurrentOpponent() {
    return state.opponents?.find(o => o.id === state.opponentId) ?? null
  }

  function hydrateForOpponent() {
    const opp = getCurrentOpponent()
    state.workingCopy = opp ? (opp.antistrat ?? {}) : null
    detailLink.href = opp ? `opponent-detail.html?id=${encodeURIComponent(opp.id)}` : '#'

    // Map dropdown from favored_maps
    const favored = opp?.favored_maps ?? []
    mapSelect.innerHTML = `<option value="">— pick map —</option>` +
      favored.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
    if (state.map && favored.includes(state.map)) {
      mapSelect.value = state.map
    } else {
      state.map = null
      writeLs(teamId, 'map', null)
    }
  }

  // ---- Render ----
  function renderBody() {
    if (state.opponents == null) { bodyEl.innerHTML = `<div class="antistrat-drawer-empty">Loading opponents…</div>`; return }
    if (state.opponents.length === 0) {
      bodyEl.innerHTML = `<div class="antistrat-drawer-empty">No opponents yet. <a href="opponents.html">Add one →</a></div>`; return
    }
    const opp = getCurrentOpponent()
    if (!opp) { bodyEl.innerHTML = `<div class="antistrat-drawer-empty">Pick an opponent above.</div>`; return }
    const favored = opp.favored_maps ?? []
    if (!favored.length) {
      bodyEl.innerHTML = `<div class="antistrat-drawer-empty">No maps yet for ${esc(opp.name)}. <a href="opponent-detail.html?id=${esc(opp.id)}" target="_blank" rel="noopener">Add maps →</a></div>`; return
    }
    if (!state.map) { bodyEl.innerHTML = `<div class="antistrat-drawer-empty">Pick a map above.</div>`; return }

    ensureMapAntistrat(state.workingCopy, state.map)

    const oppPosSide = state.side === 'ct' ? 't' : 'ct'  // their lineup vs our side
    const positions = renderPositionsGrid(state.map, oppPosSide, state.workingCopy, scheduleSave)
    const plan      = renderPlanSheet(state.map, state.side,    state.workingCopy, scheduleSave)

    bodyEl.innerHTML = `
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;opacity:0.7;margin-bottom:6px">THEIR ${oppPosSide.toUpperCase()} LINEUP</div>
      ${positions.html}
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;opacity:0.7;margin-top:14px;margin-bottom:6px">${state.side.toUpperCase()} GAMEPLAN</div>
      ${plan.html}
    `
    positions.wire(bodyEl)
    plan.wire(bodyEl)
  }

  // ---- Save ----
  function scheduleSave() {
    setStatus(null, 'editing…')
    clearTimeout(state.saveTimer)
    state.saveTimer = setTimeout(flushPendingSave, SAVE_DEBOUNCE_MS)
  }

  async function flushPendingSave() {
    clearTimeout(state.saveTimer)
    state.saveTimer = null
    const opp = getCurrentOpponent()
    if (!opp || !state.workingCopy) return
    if (state.saving) return  // avoid overlapping writes; next change will reschedule
    state.saving = true
    setStatus(null, 'saving…')
    const { error } = await supabase
      .from('opponents')
      .update({ antistrat: state.workingCopy })
      .eq('id', opp.id)
    state.saving = false
    if (error) { console.warn('antistrat drawer save failed', error); setStatus('err', '✗ save failed'); return }
    // Update cached opponent so re-renders see persisted data.
    opp.antistrat = state.workingCopy
    setStatus('ok', '✓ saved')
  }

  // ---- Wiring ----
  pill.addEventListener('click', () => setOpen(!state.open))
  closeBtn.addEventListener('click', () => setOpen(false))

  opponentSelect.addEventListener('change', e => {
    flushPendingSave()
    state.opponentId = e.target.value || null
    writeLs(teamId, 'opponentId', state.opponentId)
    hydrateForOpponent()
    renderBody()
  })

  mapSelect.addEventListener('change', e => {
    flushPendingSave()
    state.map = e.target.value || null
    writeLs(teamId, 'map', state.map)
    renderBody()
  })

  sideButtons.forEach(btn => btn.addEventListener('click', () => {
    state.side = btn.dataset.side
    writeLs(teamId, 'side', state.side)
    sideButtons.forEach(b => b.classList.toggle('active', b.dataset.side === state.side))
    renderBody()
  }))
  // Initialize active side button from persisted state.
  sideButtons.forEach(b => b.classList.toggle('active', b.dataset.side === state.side))

  document.addEventListener('keydown', e => {
    if (e.code !== 'KeyN') return
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    e.preventDefault()
    setOpen(!state.open)
  })

  // Flush save before leaving the page.
  window.addEventListener('beforeunload', () => { flushPendingSave() })

  // Initial open if persisted.
  if (state.open) setOpen(true)
}
```

- [ ] **Step 3: Mount the drawer on `demo-viewer.js`**

In `cs2-hub/demo-viewer.js`, add to the import block at the top:

```js
import { getTeamId } from './supabase.js'
import { mountAntistratDrawer } from './antistrat-drawer.js'
```

(`supabase` is already imported from `./supabase.js`; add `getTeamId` to that import line if it isn't already there. Otherwise add a new import line as shown.)

Find a clear post-init point in `demo-viewer.js` — the very bottom of the module is fine since the file is `await requireAuth()`-gated and runs top-to-bottom. Append:

```js
// Antistrat drawer (no-op on narrow viewports).
mountAntistratDrawer({ teamId: getTeamId() })
```

- [ ] **Step 4: Verify `demo-viewer.html` does not need changes**

```bash
grep -n 'demo-viewer.js\|<script' cs2-hub/demo-viewer.html
```

Expected: a single `<script type="module" src="demo-viewer.js"></script>` (or similar). The drawer module is imported by `demo-viewer.js`, so no HTML change is required. If the grep shows something different, mention it in the commit message but proceed.

- [ ] **Step 5: Smoke-test the drawer on demo-viewer in a browser**

Open `cs2-hub/demo-viewer.html?id=<some-demo-id>`. Verify:
- Toggle pill appears on the right edge.
- Click toggles drawer open/closed (slides 200 ms).
- `KeyN` toggles drawer when not focused in input/textarea.
- Opponent dropdown loads and is selectable.
- Map dropdown populates from selected opponent's `favored_maps`.
- T/CT toggle re-renders body.
- Editing a position input or plan textarea fires `editing…` then `✓ saved` ~500 ms later.
- Reload — drawer reopens at last opponent/map/side; data persisted.
- Resize window below 720 px and refresh — pill does not appear (verify by reload, not live resize).

Expected: all of the above behaves as described.

- [ ] **Step 6: Commit**

```bash
git add cs2-hub/antistrat-drawer.js cs2-hub/style.css cs2-hub/demo-viewer.js
git commit -m "feat(antistrat): right-side drawer mounted on demo-viewer"
```

---

## Task 5: Mount the drawer on `analysis.html`

**Files:**
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Add the imports**

In `cs2-hub/analysis.js`, alongside the existing imports at the top, add:

```js
import { getTeamId } from './supabase.js'
import { mountAntistratDrawer } from './antistrat-drawer.js'
```

If `getTeamId` is not currently imported from `./supabase.js`, add it to the existing `supabase` import line: `import { supabase, getTeamId } from './supabase.js'`.

- [ ] **Step 2: Mount the drawer at the bottom of the module**

Append to the very end of `cs2-hub/analysis.js`:

```js
// Antistrat drawer (no-op on narrow viewports).
mountAntistratDrawer({ teamId: getTeamId() })
```

- [ ] **Step 3: Smoke-test on analysis page**

Open `cs2-hub/analysis.html`. Verify the same checklist from Task 4 Step 5: pill, KeyN, pickers, autosave indicator, persistence, narrow-viewport no-op.

Expected: identical drawer behavior to demo-viewer.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/analysis.js
git commit -m "feat(antistrat): mount drawer on analysis page"
```

---

## Task 6: End-to-end verification + push

**Files:** None modified (verification only).

- [ ] **Step 1: Re-run the editor tests**

```bash
awk '/<script type="module">/,/<\/script>/' cs2-hub/antistrat-editor.test.html | sed '1d;$d' > /tmp/antistrat-editor.test.mjs
cd cs2-hub && node /tmp/antistrat-editor.test.mjs 2>&1 | tail -40
```

Expected: all `PASS:`, no `FAIL:`.

- [ ] **Step 2: Re-run pre-existing auto-fill-vod tests (no regressions)**

```bash
awk '/<script type="module">/,/<\/script>/' cs2-hub/auto-fill-vod.test.html | sed '1d;$d' > /tmp/auto-fill-vod.test.mjs
cd cs2-hub && node /tmp/auto-fill-vod.test.mjs 2>&1 | tail -10
```

Expected: same `PASS` count as before this branch (63 PASS / 0 FAIL).

- [ ] **Step 3: Cross-tab last-write-wins smoke**

Open `cs2-hub/opponent-detail.html?id=<id>` in tab A. Open `cs2-hub/demo-viewer.html?id=<demo>` in tab B with the drawer open on the same opponent. Edit a position note in tab B; wait for ✓ saved. In tab A, hit Save with a different value for the same field. Reload tab B's drawer (close + reopen) and confirm it now reads tab A's value. Acceptable per spec — "last write wins, no crash".

- [ ] **Step 4: Push to origin/master**

```bash
git status
git log --oneline -10
git push origin master
```

Expected: `git status` clean, recent commits include all 5 implementation commits + spec fix, push succeeds.

---

## Notes for the executing agent

- The spec is at `docs/superpowers/specs/2026-05-04-antistrat-drawer.md`. Read it before starting.
- The detail-page extraction (Task 1 + Task 3) is mechanically straightforward but high-blast-radius — the smoke test in Task 1 Step 3 and Task 3 Step 4 are non-negotiable. Do not skip them.
- `MAP_POSITIONS` keys are `t`/`ct` (lowercase). Plan side is also `t`/`ct`. Position keys are uppercase strings like `'A'`, `'BANANA'`.
- Database column on the `opponents` table is `favored_maps` (not `selected_maps`). The spec was corrected to match.
- Schema for `antistrat`: `{ [map]: { t_positions: {pos→string}, ct_positions: {pos→string}, t_plan: {field→string}, ct_plan: {field→string} } }`.
- Drawer body shows ONE side at a time (per spec). Renders `THEIR <opposite> LINEUP` (the position grid) above `<own-side> GAMEPLAN` (the plan sheet).
- `team_id` for `mountAntistratDrawer` comes from `getTeamId()` in `cs2-hub/supabase.js`.
- Keyboard guard pattern (`e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'`) matches the existing demo-viewer pattern at `demo-viewer.js:1439`.
