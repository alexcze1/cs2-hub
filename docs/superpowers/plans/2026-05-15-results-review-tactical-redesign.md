# Results & Review Tactical Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the cs2-hub Results & Review page (`vods.html` + `vods.js`) into a 4-section analyst-style layout: hero → player impact → map pool → match reports.

**Architecture:** Single-page in-place rewrite. The page orchestrator (`vods.js`) loads all data once, then re-derives every section from pure helper modules on each filter change. Each new section module owns its own DOM render + its own `.test.html`. The existing filter, drawer, aggregation, and demo↔vod linker modules are reused unchanged (filter gets a small extension only).

**Tech Stack:** Vanilla ES modules, Supabase JS client, plain CSS. Browser-based tests as `*.test.html` files using inline `console.log('PASS'/'FAIL')` assertions (matches existing pattern in `cs2-hub/`).

**Spec:** `docs/superpowers/specs/2026-05-15-results-review-tactical-redesign.md`

---

## Conventions used throughout this plan

- Working dir: `C:\Users\A\Documents\claude` (repo root). All paths in steps are relative to that.
- Run a `.test.html` by opening it in a browser; assertions log `PASS:` / `FAIL:` to the DevTools console. "Run test" = open file in browser, open DevTools console, confirm all lines are `PASS:` and there are no `FAIL:` lines.
- Git commits are local only — do NOT push.
- Indentation in code blocks below uses 2 spaces (matches existing code).

---

## Task 1: Add `--role-lurker` CSS token

**Files:**
- Modify: `cs2-hub/style.css` (top of file, in the `:root` block)

- [ ] **Step 1: Locate the `:root` block in `cs2-hub/style.css`**

Open the file and find the line `--side-ct: #4fc3f7;` (sits inside `:root`).

- [ ] **Step 2: Add the lurker role token immediately after `--side-ct`**

Insert this single line after the `--side-ct` line:

```css
  --role-lurker: #a855f7;
```

- [ ] **Step 3: Verify token is parseable**

Open any cs2-hub page (e.g., `cs2-hub/dashboard.html`) in a browser. In DevTools console:

```js
getComputedStyle(document.documentElement).getPropertyValue('--role-lurker').trim()
```

Expected: `#a855f7`

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/style.css
git commit -m "feat(style): add --role-lurker token for results & review"
```

---

## Task 2: Build `vods-trend.js` (trend + window helpers)

**Files:**
- Create: `cs2-hub/vods-trend.js`
- Test: `cs2-hub/vods-trend.test.html`

This module contains two pure helpers shared by player-impact and map-pool: `computeTrend(curr, prev, threshold)` returns `'up'|'down'|'flat'|'unknown'`, and `splitVodsByWindow(allVods, filter)` returns `{current, prior}` arrays so callers can run aggregations on both.

- [ ] **Step 1: Write the failing test file**

Create `cs2-hub/vods-trend.test.html` with this exact content:

```html
<!DOCTYPE html>
<html>
<body>
<script type="module">
import { computeTrend, splitVodsByWindow } from './vods-trend.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}

// ---- computeTrend ----
{
  assert(computeTrend(1.10, 1.05, 0.03) === 'up',   'curr - prev > threshold → up')
  assert(computeTrend(1.00, 1.10, 0.03) === 'down', 'curr - prev < -threshold → down')
  assert(computeTrend(1.05, 1.04, 0.03) === 'flat', 'within threshold → flat')
  assert(computeTrend(1.05, 1.05, 0.03) === 'flat', 'equal → flat')
  assert(computeTrend(1.10, null, 0.03) === 'unknown', 'null prior → unknown')
  assert(computeTrend(null, 1.10, 0.03) === 'unknown', 'null curr → unknown')
  assert(computeTrend(null, null, 0.03) === 'unknown', 'both null → unknown')
}

// ---- splitVodsByWindow: 'all' → no prior ----
{
  const vods = [
    { id: 'a', match_date: '2026-05-10' },
    { id: 'b', match_date: '2026-05-08' },
  ]
  const out = splitVodsByWindow(vods, { window: 'all' }, new Date('2026-05-15'))
  assert(out.current.length === 2, "window=all → all vods in current")
  assert(out.prior.length === 0,   "window=all → empty prior")
}

// ---- splitVodsByWindow: 'Last 10' ----
{
  const vods = Array.from({length: 25}, (_, i) => ({
    id: `v${i}`, match_date: `2026-04-${String(25 - i).padStart(2,'0')}`,
  }))
  const out = splitVodsByWindow(vods, { window: '10' }, new Date('2026-05-15'))
  assert(out.current.length === 10, "Last 10 → 10 in current")
  assert(out.current[0].id === 'v0', "current includes newest")
  assert(out.prior.length === 10, "Last 10 → 10 in prior (matches 11..20)")
  assert(out.prior[0].id === 'v10', "prior starts after current")
}

// ---- splitVodsByWindow: '30d' ----
{
  const vods = [
    { id: 'recent', match_date: '2026-05-10' },        // current (within 30d of 2026-05-15)
    { id: 'edge',   match_date: '2026-04-16' },        // current (30 days back exactly)
    { id: 'prior',  match_date: '2026-04-01' },        // prior (in days 30..60 back)
    { id: 'old',    match_date: '2026-03-01' },        // outside both windows
  ]
  const out = splitVodsByWindow(vods, { window: '30d' }, new Date('2026-05-15'))
  const ids = (arr) => arr.map(v => v.id).sort()
  assert(ids(out.current).join(',') === 'edge,recent', '30d current = recent + edge')
  assert(ids(out.prior).join(',')   === 'prior',       '30d prior = prior only')
}

console.log('all done')
</script>
</body>
</html>
```

- [ ] **Step 2: Open the test in a browser; verify it fails**

Open `cs2-hub/vods-trend.test.html` in a browser. DevTools console.

Expected: an error like `Failed to fetch dynamically imported module: .../vods-trend.js` (the module doesn't exist yet). No `PASS:` lines.

- [ ] **Step 3: Create `cs2-hub/vods-trend.js`**

```js
// cs2-hub/vods-trend.js
//
// Pure helpers used by player-impact and map-pool to render trend arrows.
// `computeTrend`: classifies a current-vs-prior delta into up/down/flat/unknown.
// `splitVodsByWindow`: partitions vods into the current selected window and
// the same-length window immediately preceding it.

export function computeTrend(curr, prev, threshold) {
  if (curr == null || prev == null) return 'unknown'
  const delta = curr - prev
  if (delta >  threshold) return 'up'
  if (delta < -threshold) return 'down'
  return 'flat'
}

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function addDays(date, n) {
  const d = new Date(date); d.setDate(d.getDate() + n); return d
}

// allVods: sorted newest-first (matches the existing vods.js load order).
// filter:  { window: '10' | '30d' | '90d' | 'all' }
// now:     injectable for tests; defaults to new Date()
// Returns: { current, prior } — both arrays of vod objects (no copies).
export function splitVodsByWindow(allVods, filter, now = new Date()) {
  if (!Array.isArray(allVods) || allVods.length === 0) return { current: [], prior: [] }
  const w = filter?.window ?? '10'
  if (w === 'all') return { current: allVods.slice(), prior: [] }

  if (w === '10') {
    const sorted = [...allVods]
      .filter(v => v.match_date)
      .sort((a, b) => String(b.match_date).localeCompare(String(a.match_date)))
    return { current: sorted.slice(0, 10), prior: sorted.slice(10, 20) }
  }

  const days = w === '30d' ? 30 : w === '90d' ? 90 : null
  if (days == null) return { current: allVods.slice(), prior: [] }

  const currentCutoff = ymd(addDays(now, -days))
  const priorCutoff   = ymd(addDays(now, -days * 2))
  const current = allVods.filter(v => v.match_date && String(v.match_date) >= currentCutoff)
  const prior   = allVods.filter(v => v.match_date
    && String(v.match_date) >= priorCutoff
    && String(v.match_date) <  currentCutoff)
  return { current, prior }
}
```

- [ ] **Step 4: Reload the test in the browser; verify all PASS**

Reload `cs2-hub/vods-trend.test.html`. DevTools console.

Expected: every line starts with `PASS:`. No `FAIL:` lines. Final line is `all done`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/vods-trend.js cs2-hub/vods-trend.test.html
git commit -m "feat(vods): pure trend + window-split helpers"
```

---

## Task 3: Extend `vods-filter.js` to a 4-way matchType filter

**Files:**
- Modify: `cs2-hub/vods-filter.js`
- Modify: `cs2-hub/vods-filter.test.html`

Today `vods-filter.js` exports `{ window, tournamentsOnly: boolean }`. The new design needs a 4-way pill group (`all | scrim | tournament | pug`). Bump the storage key from `vods:filter:v1` to `vods:filter:v2` so the new shape doesn't try to read legacy state.

Visual mounting (the pill row markup) gets moved into the hero in Task 5; here we just change the state shape, persistence, and the existing markup that still ships from this module (the hero will call `mountFilter` into a slot inside itself).

- [ ] **Step 1: Replace `cs2-hub/vods-filter.js` with this content**

```js
// cs2-hub/vods-filter.js
//
// Filter row for Results & Review. Emits filter state on mount (from
// localStorage) and on every change. Mounted by the hero into its own slot.

export const FILTER_KEY = 'vods:filter:v2'

const WINDOWS  = ['10', '30d', '90d', 'all']
const MATCH_TYPES = ['all', 'scrim', 'tournament', 'pug']

export function defaultFilter() {
  return { window: '10', matchType: 'all' }
}

function loadFilter() {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw) return defaultFilter()
    const parsed = JSON.parse(raw)
    return {
      window:    WINDOWS.includes(parsed.window) ? parsed.window : '10',
      matchType: MATCH_TYPES.includes(parsed.matchType) ? parsed.matchType : 'all',
    }
  } catch { return defaultFilter() }
}

function saveFilter(f) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)) } catch {}
}

const WINDOW_PILLS = [
  { key: '10',  label: 'Last 10' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All time' },
]
const TYPE_PILLS = [
  { key: 'all',        label: 'All' },
  { key: 'scrim',      label: 'Scrim' },
  { key: 'tournament', label: 'Tourn.' },
  { key: 'pug',        label: 'Pug' },
]

export function mountFilter(root, onChange) {
  let state = loadFilter()

  function render() {
    root.innerHTML = `
      <div class="vods-filter-row">
        <div class="vods-filter-pills" data-group="window">
          ${WINDOW_PILLS.map(p => `
            <button type="button" class="vods-filter-pill ${state.window === p.key ? 'is-active' : ''}"
                    data-window="${p.key}">${p.label}</button>
          `).join('')}
        </div>
        <div class="vods-filter-pills" data-group="type">
          ${TYPE_PILLS.map(p => `
            <button type="button" class="vods-filter-pill ${state.matchType === p.key ? 'is-active' : ''}"
                    data-type="${p.key}">${p.label}</button>
          `).join('')}
        </div>
      </div>
    `
    for (const btn of root.querySelectorAll('[data-window]')) {
      btn.addEventListener('click', () => {
        if (state.window === btn.dataset.window) return
        state = { ...state, window: btn.dataset.window }
        saveFilter(state); render(); onChange(state)
      })
    }
    for (const btn of root.querySelectorAll('[data-type]')) {
      btn.addEventListener('click', () => {
        if (state.matchType === btn.dataset.type) return
        state = { ...state, matchType: btn.dataset.type }
        saveFilter(state); render(); onChange(state)
      })
    }
  }

  render()
  onChange(state)
}
```

- [ ] **Step 2: Replace `cs2-hub/vods-filter.test.html` with this content**

```html
<!DOCTYPE html>
<html>
<body>
<div id="mount"></div>
<script type="module">
import { mountFilter, FILTER_KEY, defaultFilter } from './vods-filter.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}

// Default state
{
  localStorage.removeItem(FILTER_KEY)
  const f = defaultFilter()
  assert(f.window === '10', 'default window = 10')
  assert(f.matchType === 'all', 'default matchType = all')
}

// Mount + click window pill → emits new state, persists
{
  localStorage.removeItem(FILTER_KEY)
  const root = document.getElementById('mount')
  root.innerHTML = ''
  const states = []
  mountFilter(root, (s) => states.push(s))

  root.querySelector('[data-window="90d"]').click()
  assert(states.length === 2, 'mount emission + click = two emissions')
  assert(states[1].window === '90d', 'state has window=90d')
  const stored = JSON.parse(localStorage.getItem(FILTER_KEY))
  assert(stored.window === '90d', 'persisted to localStorage')
}

// Click match-type pill → emits new state
{
  localStorage.removeItem(FILTER_KEY)
  const root = document.getElementById('mount')
  root.innerHTML = ''
  const states = []
  mountFilter(root, (s) => states.push(s))

  root.querySelector('[data-type="tournament"]').click()
  assert(states.length === 2, 'mount + type-click = two emissions')
  assert(states[1].matchType === 'tournament', 'matchType = tournament')

  root.querySelector('[data-type="pug"]').click()
  assert(states.length === 3, 'two type-clicks = three emissions total')
  assert(states[2].matchType === 'pug', 'matchType switched to pug')

  // Clicking the already-active pill does not re-emit
  root.querySelector('[data-type="pug"]').click()
  assert(states.length === 3, 'clicking active pill is a no-op')
}

// Mount restores from localStorage
{
  localStorage.setItem(FILTER_KEY, JSON.stringify({ window: '30d', matchType: 'tournament' }))
  const root = document.getElementById('mount')
  root.innerHTML = ''
  const states = []
  mountFilter(root, (s) => states.push(s))

  assert(states[0].window === '30d',          'restored window=30d')
  assert(states[0].matchType === 'tournament', 'restored matchType=tournament')
  assert(root.querySelector('[data-window="30d"]').classList.contains('is-active'), '30d pill marked active')
  assert(root.querySelector('[data-type="tournament"]').classList.contains('is-active'), 'tournament pill marked active')
}

// Junk in localStorage → falls back to defaults
{
  localStorage.setItem(FILTER_KEY, '{"window":"bogus","matchType":"nonsense"}')
  const root = document.getElementById('mount')
  root.innerHTML = ''
  const states = []
  mountFilter(root, (s) => states.push(s))
  assert(states[0].window === '10', 'bogus window → fallback to 10')
  assert(states[0].matchType === 'all', 'bogus matchType → fallback to all')
}

console.log('all done')
</script>
</body>
</html>
```

- [ ] **Step 3: Run the test**

Open `cs2-hub/vods-filter.test.html` in a browser.

Expected: all `PASS:`, no `FAIL:`, ends with `all done`.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/vods-filter.js cs2-hub/vods-filter.test.html
git commit -m "feat(vods-filter): replace tournamentsOnly with matchType pill group"
```

---

## Task 4: Rewrite `vods.html` markup

**Files:**
- Modify: `cs2-hub/vods.html` (full replace)

- [ ] **Step 1: Overwrite `cs2-hub/vods.html` with this exact content**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <link rel="icon" type="image/png" href="images/favicon.png">
  <link rel="apple-touch-icon" href="images/favicon.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Results & Review — MIDROUND</title>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>
<div class="app-shell">
  <nav class="sidebar" id="sidebar"></nav>
  <main class="main-content">
    <section id="rr-hero" class="rr-hero"><div class="loading">Loading…</div></section>
    <section id="rr-player-impact" class="rr-section"></section>
    <section id="rr-map-pool" class="rr-section"></section>
    <section id="rr-match-reports" class="rr-section"></section>
  </main>
</div>
<script type="module" src="vods.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add cs2-hub/vods.html
git commit -m "feat(results): replace vods.html shell with 4-section layout"
```

---

## Task 5: Build `vods-hero.js`

**Files:**
- Create: `cs2-hub/vods-hero.js`
- Test: `cs2-hub/vods-hero.test.html`

The hero owns: record numerals, round WR, best/worst map, sparkline (last 10 round-WR per match), filter pill slot, `+ Add Match` button. Public API: `renderHero(root, { vods, filterSlotId })` and `computeHeroStats(vods)` (pure, exported for testing).

`renderHero` writes the static structure once and the dynamic numbers on every call. The caller (`vods.js`) calls `mountFilter` into the slot after the first render.

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/vods-hero.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<div id="root"></div>
<script type="module">
import { computeHeroStats, renderHero } from './vods-hero.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}

// ---- computeHeroStats: full data ----
{
  const vods = [
    { id: 'a', result: 'win',  match_date: '2026-05-10',
      maps: [{ map: 'mirage', score_us: 13, score_them: 8 }] },
    { id: 'b', result: 'loss', match_date: '2026-05-08',
      maps: [{ map: 'anubis', score_us: 7, score_them: 13 }] },
    { id: 'c', result: 'win',  match_date: '2026-05-05',
      maps: [
        { map: 'mirage', score_us: 13, score_them: 11 },
        { map: 'nuke',   score_us: 8,  score_them: 13 },
        { map: 'mirage', score_us: 13, score_them: 9 },
      ] },
    { id: 'd', result: 'draw', match_date: '2026-05-01',
      maps: [{ map: 'inferno', score_us: 12, score_them: 12 }] },
  ]
  const s = computeHeroStats(vods)
  assert(s.record.w === 2 && s.record.l === 1 && s.record.d === 1, 'record counts w/l/d')
  // totalRW = 13+7+13+8+13+12 = 66
  // totalRL = 8+13+11+13+9+12 = 66
  assert(s.totalRW === 66 && s.totalRL === 66, 'rounds sum across all maps')
  assert(s.roundWR === 50, '66/(66+66)=50%')
  assert(s.bestMap?.map === 'mirage', 'best map = mirage (3 plays, 100% WR)')
  assert(s.worstMap?.map === 'anubis' || s.worstMap?.map === 'nuke', 'worst is anubis or nuke (single-loss maps)')
  assert(s.sparkline.length === 4, 'sparkline = one entry per vod (no padding)')
  assert(s.sparkline[0].pct === Math.round(13/21 * 100), 'sparkline[0] pct from match a')
}

// ---- computeHeroStats: best/worst require samples >= 3 ----
{
  const vods = [
    { id: 'a', result: 'win',  match_date: '2026-05-10', maps: [{ map: 'mirage', score_us: 13, score_them: 8 }] },
    { id: 'b', result: 'win',  match_date: '2026-05-09', maps: [{ map: 'mirage', score_us: 13, score_them: 10 }] },
  ]
  const s = computeHeroStats(vods)
  assert(s.bestMap === null,  'mirage with 2 plays → bestMap null (need 3+)')
  assert(s.worstMap === null, 'mirage with 2 plays → worstMap null')
}

// ---- computeHeroStats: empty vods ----
{
  const s = computeHeroStats([])
  assert(s.record.w === 0 && s.record.l === 0 && s.record.d === 0, 'empty → zero record')
  assert(s.roundWR === null, 'empty → roundWR null')
  assert(s.bestMap === null && s.worstMap === null, 'empty → no maps')
  assert(s.sparkline.length === 0, 'empty → empty sparkline')
}

// ---- renderHero: full data renders numerals ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const vods = [
    { id: 'a', result: 'win',  match_date: '2026-05-10', maps: [{ map: 'mirage', score_us: 13, score_them: 8 }] },
    { id: 'b', result: 'loss', match_date: '2026-05-08', maps: [{ map: 'anubis', score_us: 7,  score_them: 13 }] },
  ]
  renderHero(root, { vods, filterSlotId: 'rr-filter-slot' })

  const record = root.querySelector('.rr-hero-record').textContent
  assert(record.includes('1W'), 'record renders 1W')
  assert(record.includes('1L'), 'record renders 1L')
  assert(root.querySelector('#rr-filter-slot') !== null, 'filter slot present')
  assert(root.querySelector('.rr-add-match'), 'Add Match button rendered')
}

// ---- renderHero: empty state collapses to CTA only ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  renderHero(root, { vods: [], filterSlotId: 'rr-filter-slot' })
  assert(root.querySelector('.rr-hero-empty'), 'empty hero has empty marker')
  assert(root.querySelector('.rr-add-match'), 'Add Match CTA still present in empty state')
  assert(root.querySelector('.rr-hero-record') === null, 'no record numerals in empty state')
}

console.log('all done')
</script>
</body>
</html>
```

- [ ] **Step 2: Run the test; verify it fails**

Open in browser. Expected: import error (`vods-hero.js` not yet created). No `PASS:` lines.

- [ ] **Step 3: Create `cs2-hub/vods-hero.js`**

```js
// cs2-hub/vods-hero.js
//
// Renders the Results & Review hero: record, round WR, best/worst map,
// sparkline (last 10 round-WR), filter pill slot, +Add Match button.
// computeHeroStats is exported for unit testing.

function pct(n, d) { return d === 0 ? null : Math.round((n / d) * 100) }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const MIN_BEST_WORST_SAMPLES = 3

export function computeHeroStats(vods) {
  const record = { w: 0, l: 0, d: 0 }
  let totalRW = 0, totalRL = 0
  const byMap = {}    // map → { rw, rl, plays }

  const sortedByDate = [...(vods || [])]
    .filter(v => v.match_date)
    .sort((a, b) => String(b.match_date).localeCompare(String(a.match_date)))

  for (const v of vods || []) {
    const maps = v.maps ?? []
    let mw = 0, ml = 0
    for (const m of maps) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      totalRW += us; totalRL += them
      if (!byMap[m.map]) byMap[m.map] = { rw: 0, rl: 0, plays: 0, w: 0, l: 0 }
      const slot = byMap[m.map]
      slot.rw += us; slot.rl += them; slot.plays++
      if (us > them) { mw++; slot.w++ }
      else if (them > us) { ml++; slot.l++ }
    }
    if (mw > ml) record.w++
    else if (ml > mw) record.l++
    else if (maps.length) record.d++
  }

  const totalRounds = totalRW + totalRL
  const roundWR = totalRounds === 0 ? null : Math.round((totalRW / totalRounds) * 100)

  const eligible = Object.entries(byMap)
    .filter(([, s]) => s.plays >= MIN_BEST_WORST_SAMPLES)
    .map(([map, s]) => ({ map, wr: pct(s.w, s.w + s.l), plays: s.plays }))
  const ranked = [...eligible].sort((a, b) => (b.wr ?? -1) - (a.wr ?? -1))
  const bestMap  = ranked[0] ?? null
  const worstMap = ranked.length >= 2 ? ranked[ranked.length - 1] : null

  const sparkline = sortedByDate.slice(0, 10).map(v => {
    let rw = 0, rl = 0
    for (const m of v.maps ?? []) { rw += m.score_us ?? 0; rl += m.score_them ?? 0 }
    const total = rw + rl
    return { id: v.id, pct: total === 0 ? 0 : Math.round((rw / total) * 100) }
  })

  return { record, totalRW, totalRL, roundWR, bestMap, worstMap, sparkline }
}

export function renderHero(root, { vods, filterSlotId }) {
  if (!vods || vods.length === 0) {
    root.innerHTML = `
      <div class="rr-hero-empty">
        <div class="rr-hero-title">RESULTS &amp; REVIEW</div>
        <h2 class="rr-hero-empty-msg">No matches yet</h2>
        <a class="rr-add-match" href="vod-detail.html">+ Add Match</a>
      </div>`
    return
  }

  const s = computeHeroStats(vods)
  const bars = s.sparkline.map(p =>
    `<span class="rr-spark-bar" style="height:${Math.max(p.pct, 4)}%"></span>`
  ).join('')

  root.innerHTML = `
    <div class="rr-hero-grid">
      <div class="rr-hero-left">
        <div class="rr-hero-title">RESULTS &amp; REVIEW</div>
        <div class="rr-hero-record">
          <span class="rr-hero-w">${s.record.w}W</span>
          <span class="rr-hero-sep">—</span>
          <span class="rr-hero-l">${s.record.l}L</span>
          ${s.record.d ? `<span class="rr-hero-sep">—</span><span class="rr-hero-d">${s.record.d}D</span>` : ''}
        </div>
        <div class="rr-hero-subgrid">
          <div class="rr-kv"><div class="rr-kv-k">Round WR</div><div class="rr-kv-v">${s.roundWR == null ? '—' : s.roundWR + '%'}</div></div>
          <div class="rr-kv"><div class="rr-kv-k">Best map</div><div class="rr-kv-v">${s.bestMap ? esc(capitalize(s.bestMap.map)) + ' ' + s.bestMap.wr + '%' : '—'}</div></div>
          <div class="rr-kv"><div class="rr-kv-k">Weakest</div><div class="rr-kv-v">${s.worstMap ? esc(capitalize(s.worstMap.map)) + ' ' + s.worstMap.wr + '%' : '—'}</div></div>
        </div>
        <a class="rr-add-match" href="vod-detail.html">+ Add Match</a>
      </div>
      <div class="rr-hero-right">
        <div class="rr-section-label">Trend · Last 10</div>
        <div class="rr-spark">${bars || '<span class="rr-muted">No matches</span>'}</div>
        <div id="${esc(filterSlotId)}" class="rr-filter-slot"></div>
      </div>
    </div>`
}
```

- [ ] **Step 4: Reload the test; verify all PASS**

Open `cs2-hub/vods-hero.test.html` in browser. Expected: all `PASS:`, ends with `all done`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/vods-hero.js cs2-hub/vods-hero.test.html
git commit -m "feat(results): hero section with record, round WR, sparkline, filter slot"
```

---

## Task 6: Build `vods-player-impact.js`

**Files:**
- Create: `cs2-hub/vods-player-impact.js`
- Test: `cs2-hub/vods-player-impact.test.html`

Renders the 5-up role-coded player grid. Each card: nickname, role label, rating + trend arrow, two role-specific supporting metrics, an "impact" bar normalized across the team. Click opens the existing drawer (caller wires the callback).

Public API:
- `renderPlayerImpact(root, { roster, rowsCurrent, rowsPrior, onPick })`
- `roleColorVar(role)` exported for shared use

Trend uses `computeTrend(rating_curr, rating_prior, 0.03)` from Task 2. Impact bar normalizes `impact_rating` across the team in the current window into `[0, 100]`.

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/vods-player-impact.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<div id="root"></div>
<script type="module">
import { renderPlayerImpact, roleColorVar } from './vods-player-impact.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}

// ---- roleColorVar ----
{
  assert(roleColorVar('IGL')     === 'var(--warning)',     'IGL → warning')
  assert(roleColorVar('Entry')   === 'var(--danger)',      'Entry → danger')
  assert(roleColorVar('AWPer')   === 'var(--special)',     'AWPer → special')
  assert(roleColorVar('Support') === 'var(--accent)',      'Support → accent')
  assert(roleColorVar('Lurker')  === 'var(--role-lurker)', 'Lurker → role-lurker')
  assert(roleColorVar('Player')  === 'var(--muted)',       'unknown role → muted')
}

function mkRow(over) {
  return {
    rounds_played: 24, kills: 20, deaths: 15, assists: 0,
    adr: 80, rating: 1.10, hs_pct: 0.5, kast_pct: 0.7,
    multi_2k: 0, multi_3k: 0, multi_4k: 0, multi_5k: 0,
    opening_kills: 5, opening_deaths: 3,
    clutches_won: 1, clutches_lost: 3,
    utility_dmg: 200, flash_assists: 2, traded_deaths: 4, impact_rating: 1.05,
    ...over,
  }
}

// ---- renderPlayerImpact: full roster + role colors + trend ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const roster = [
    { id: '1', nickname: 'PrimeUlt', role: 'IGL',     steam_id: 'A' },
    { id: '2', nickname: 'Libra',    role: 'Entry',   steam_id: 'B' },
    { id: '3', nickname: 'jXy',      role: 'AWPer',   steam_id: 'C' },
    { id: '4', nickname: 'noctis',   role: 'Lurker',  steam_id: 'D' },
    { id: '5', nickname: 'echo',     role: 'Support', steam_id: 'E' },
    { id: '6', nickname: 'CoachX',   role: 'Coach',   steam_id: 'X' }, // excluded
  ]
  const rowsCurrent = [
    { steam_id: 'A', ...mkRow({ rating: 1.04, impact_rating: 0.95 }) },
    { steam_id: 'B', ...mkRow({ rating: 1.18, impact_rating: 1.18 }) },
    { steam_id: 'C', ...mkRow({ rating: 1.05, impact_rating: 1.00 }) },
    { steam_id: 'D', ...mkRow({ rating: 1.11, impact_rating: 1.10 }) },
    { steam_id: 'E', ...mkRow({ rating: 0.94, impact_rating: 0.85 }) },
  ]
  const rowsPrior = [
    { steam_id: 'A', ...mkRow({ rating: 0.99 }) }, // → up (delta +0.05)
    { steam_id: 'B', ...mkRow({ rating: 1.20 }) }, // → flat (delta -0.02)
    { steam_id: 'C', ...mkRow({ rating: 1.20 }) }, // → down (delta -0.15)
    { steam_id: 'D', ...mkRow({ rating: 1.10 }) }, // → flat
    // E has no prior data → unknown
  ]

  const picks = []
  renderPlayerImpact(root, { roster, rowsCurrent, rowsPrior, onPick: (p) => picks.push(p) })

  const cards = root.querySelectorAll('.rr-player-card')
  assert(cards.length === 5, 'renders one card per non-staff roster member')

  const findCard = (nick) => [...cards].find(c => c.querySelector('.rr-player-name')?.textContent === nick)

  assert(findCard('PrimeUlt')?.dataset.role === 'IGL',  'IGL card has data-role=IGL')
  assert(findCard('Libra')?.dataset.role === 'Entry',   'Entry card has data-role=Entry')
  assert(findCard('jXy')?.dataset.role === 'AWPer',     'AWPer card has data-role=AWPer')
  assert(findCard('noctis')?.dataset.role === 'Lurker', 'Lurker card has data-role=Lurker')
  assert(findCard('echo')?.dataset.role === 'Support',  'Support card has data-role=Support')

  assert(findCard('PrimeUlt').dataset.trend === 'up',      'PrimeUlt trend=up')
  assert(findCard('Libra').dataset.trend === 'flat',       'Libra trend=flat')
  assert(findCard('jXy').dataset.trend === 'down',         'jXy trend=down')
  assert(findCard('echo').dataset.trend === 'unknown',     'echo no prior → trend=unknown')

  // Impact bar normalization: team min=0.85 (echo), max=1.18 (Libra).
  // Libra should be at 100%, echo at 0%.
  const libraBar = findCard('Libra').querySelector('.rr-impact-fill')
  assert(libraBar && libraBar.style.width === '100%', 'Libra impact bar at 100%')
  const echoBar = findCard('echo').querySelector('.rr-impact-fill')
  assert(echoBar && echoBar.style.width === '0%', 'echo impact bar at 0%')

  // Click pipes through onPick
  findCard('PrimeUlt').click()
  assert(picks.length === 1 && picks[0].nickname === 'PrimeUlt', 'click → onPick')
}

// ---- Empty current rows → "no matches in window" markers per card ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const roster = [
    { id: '1', nickname: 'PrimeUlt', role: 'IGL', steam_id: 'A' },
  ]
  renderPlayerImpact(root, { roster, rowsCurrent: [], rowsPrior: [], onPick: () => {} })
  const card = root.querySelector('.rr-player-card')
  assert(card !== null, 'card still renders')
  assert(card.classList.contains('rr-player-card-empty'), 'card has empty class')
  assert(card.querySelector('.rr-impact-bar') === null, 'no impact bar when no data')
}

// ---- Null impact_rating → bar hidden ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const roster = [{ id: '1', nickname: 'X', role: 'Lurker', steam_id: 'A' }]
  const rows = [{ steam_id: 'A', ...mkRow({ impact_rating: null }) }]
  renderPlayerImpact(root, { roster, rowsCurrent: rows, rowsPrior: [], onPick: () => {} })
  assert(root.querySelector('.rr-impact-bar') === null, 'null impact → no bar')
}

console.log('all done')
</script>
</body>
</html>
```

- [ ] **Step 2: Run the test; verify it fails**

Open in browser. Expected: import error.

- [ ] **Step 3: Create `cs2-hub/vods-player-impact.js`**

```js
// cs2-hub/vods-player-impact.js
//
// Renders the role-coded player grid for Results & Review. One card per
// non-staff roster member. Click → onPick(player) (caller opens drawer).

import { aggregatePlayer } from './roster-stats-aggregate.js'
import { computeTrend } from './vods-trend.js'

const STAFF_ROLES = new Set(['Coach', 'Manager', 'Bench', 'Unassigned'])
const ROLE_ORDER  = { IGL: 0, Entry: 1, AWPer: 2, Lurker: 3, Support: 4 }
const TREND_THRESHOLD = 0.03

const ROLE_COLOR_MAP = {
  IGL:     'var(--warning)',
  Entry:   'var(--danger)',
  AWPer:   'var(--special)',
  Support: 'var(--accent)',
  Lurker:  'var(--role-lurker)',
}
export function roleColorVar(role) {
  return ROLE_COLOR_MAP[role] ?? 'var(--muted)'
}

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function fmt(n, dec = 2) { return n == null ? '—' : Number(n).toFixed(dec) }
function fmtPct(p) { return p == null ? '—' : `${Math.round(p * 100)}%` }
function fmtKD(kd) { return kd == null ? '—' : !isFinite(kd) ? '∞' : kd.toFixed(2) }
const TREND_ARROW = { up: '↗', down: '↘', flat: '▬', unknown: '' }

function rowsBySteamId(rows) {
  const m = new Map()
  for (const r of rows || []) {
    if (!r.steam_id) continue
    if (!m.has(r.steam_id)) m.set(r.steam_id, [])
    m.get(r.steam_id).push(r)
  }
  return m
}

// Two supporting metrics per role.
function supportingMetrics(role, agg) {
  const openTotal = (agg.opening_kills || 0) + (agg.opening_deaths || 0)
  const openPct = openTotal > 0 ? agg.opening_kills / openTotal : null
  const clutchTotal = (agg.clutches_won || 0) + (agg.clutches_lost || 0)
  const clutchPct = clutchTotal > 0 ? agg.clutches_won / clutchTotal : null

  switch (role) {
    case 'IGL':     return [['KAST', fmtPct(agg.kast_pct)], ['Util/r', fmt(agg.utility_dmg_per_round, 1)]]
    case 'Entry':   return [['Open %', fmtPct(openPct)], ['K/D', fmtKD(agg.kd)]]
    case 'AWPer':   return [['Open %', fmtPct(openPct)], ['KAST', fmtPct(agg.kast_pct)]]
    case 'Support': return [['Util/r', fmt(agg.utility_dmg_per_round, 1)], ['KAST', fmtPct(agg.kast_pct)]]
    case 'Lurker':  return [['Clutch %', fmtPct(clutchPct)], ['K/D', fmtKD(agg.kd)]]
    default:        return [['K/D', fmtKD(agg.kd)], ['KAST', fmtPct(agg.kast_pct)]]
  }
}

export function renderPlayerImpact(root, { roster, rowsCurrent, rowsPrior, onPick }) {
  const sorted = (roster || [])
    .filter(p => !STAFF_ROLES.has(p.role))
    .sort((a, b) => {
      const ra = ROLE_ORDER[a.role] ?? 99
      const rb = ROLE_ORDER[b.role] ?? 99
      if (ra !== rb) return ra - rb
      return String(a.nickname || '').localeCompare(String(b.nickname || ''))
    })

  if (sorted.length === 0) {
    root.innerHTML = `<div class="rr-section-label">PLAYER IMPACT</div>
      <div class="rr-empty">No players on roster.</div>`
    return
  }

  const curBySid   = rowsBySteamId(rowsCurrent)
  const priorBySid = rowsBySteamId(rowsPrior)

  // Per-player aggregates (current window only).
  const aggCurrent = new Map()
  for (const p of sorted) {
    if (!p.steam_id) { aggCurrent.set(p.id, null); continue }
    const rows = curBySid.get(p.steam_id) ?? []
    aggCurrent.set(p.id, rows.length ? aggregatePlayer(rows) : null)
  }

  // Team min/max impact_rating across players with data — used to normalize bars.
  let minImp = +Infinity, maxImp = -Infinity
  for (const agg of aggCurrent.values()) {
    if (!agg || agg.impact_rating == null) continue
    if (agg.impact_rating < minImp) minImp = agg.impact_rating
    if (agg.impact_rating > maxImp) maxImp = agg.impact_rating
  }
  const impSpan = maxImp - minImp

  function impactPct(impact) {
    if (impact == null) return null
    if (impSpan === 0) return 50
    return Math.round(((impact - minImp) / impSpan) * 100)
  }

  const cards = sorted.map(p => {
    const agg = aggCurrent.get(p.id)
    const hasData = !!(agg && agg.matches > 0)

    let trend = 'unknown'
    if (hasData && p.steam_id) {
      const priorRows = priorBySid.get(p.steam_id) ?? []
      const priorAgg = priorRows.length ? aggregatePlayer(priorRows) : null
      trend = computeTrend(agg.rating, priorAgg?.rating ?? null, TREND_THRESHOLD)
    }

    const supports = hasData ? supportingMetrics(p.role, agg) : []
    const impPct = hasData ? impactPct(agg.impact_rating) : null

    return `
      <button type="button"
              class="rr-player-card ${hasData ? '' : 'rr-player-card-empty'}"
              data-id="${esc(p.id)}"
              data-role="${esc(p.role)}"
              data-trend="${trend}"
              style="--rr-role-color:${roleColorVar(p.role)}">
        <div class="rr-player-name">${esc(p.nickname || '—')}</div>
        <div class="rr-player-role">${esc(p.role || 'Player')}</div>
        <div class="rr-player-rating">
          ${hasData ? fmt(agg.rating) : '—'}
          ${trend !== 'unknown' && hasData ? `<span class="rr-trend rr-trend-${trend}">${TREND_ARROW[trend]}</span>` : ''}
        </div>
        ${hasData ? `
          <div class="rr-player-supports">
            ${supports.map(([k, v]) => `<span class="rr-support"><span class="rr-support-k">${esc(k)}</span> <span class="rr-support-v">${esc(v)}</span></span>`).join('')}
          </div>
        ` : ''}
        ${hasData && impPct != null ? `
          <div class="rr-impact-bar"><div class="rr-impact-fill" style="width:${impPct}%"></div></div>
        ` : ''}
        ${hasData ? '' : '<div class="rr-player-empty-msg">No matches in window</div>'}
      </button>`
  }).join('')

  root.innerHTML = `
    <div class="rr-section-label">PLAYER IMPACT</div>
    <div class="rr-player-grid">${cards}</div>`

  for (const btn of root.querySelectorAll('.rr-player-card')) {
    btn.addEventListener('click', () => {
      const player = sorted.find(p => p.id === btn.dataset.id)
      if (player && typeof onPick === 'function') onPick(player)
    })
  }
}
```

- [ ] **Step 4: Reload the test; verify all PASS**

Open `cs2-hub/vods-player-impact.test.html`. Expected: all `PASS:`, ends `all done`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/vods-player-impact.js cs2-hub/vods-player-impact.test.html
git commit -m "feat(results): player impact grid with role colors + trend + impact bars"
```

---

## Task 7: Build `vods-map-pool.js`

**Files:**
- Create: `cs2-hub/vods-map-pool.js`
- Test: `cs2-hub/vods-map-pool.test.html`

Table layout. Columns: Map / WR / Sample / Trend / Confidence. Confidence is sample-size only: `HIGH ≥ 8`, `MEDIUM 4–7`, `LOW < 4`. Trend is `±5%` window comparison.

When a row is clicked, emits a `CustomEvent('rr:filter-map', { detail: { map }})` on the element. Toggle behavior: clicking the currently-active row clears the filter.

Public API: `renderMapPool(root, { vodsCurrent, vodsPrior, activeMap })` + `computeMapPool(vods)` exported for testing.

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/vods-map-pool.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<div id="root"></div>
<script type="module">
import { renderMapPool, computeMapPool, confidenceLabel } from './vods-map-pool.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}

// ---- confidenceLabel boundaries ----
{
  assert(confidenceLabel(3) === 'LOW',    '3 plays → LOW')
  assert(confidenceLabel(4) === 'MEDIUM', '4 plays → MEDIUM')
  assert(confidenceLabel(7) === 'MEDIUM', '7 plays → MEDIUM')
  assert(confidenceLabel(8) === 'HIGH',   '8 plays → HIGH')
  assert(confidenceLabel(0) === 'LOW',    '0 plays → LOW')
}

// ---- computeMapPool ----
{
  const vods = [
    { maps: [{ map: 'mirage', score_us: 13, score_them: 8 }] },
    { maps: [{ map: 'mirage', score_us: 13, score_them: 11 }] },
    { maps: [{ map: 'mirage', score_us: 9,  score_them: 13 }] },
    { maps: [{ map: 'anubis', score_us: 7,  score_them: 13 }] },
  ]
  const out = computeMapPool(vods)
  const mirage = out.find(r => r.map === 'mirage')
  const anubis = out.find(r => r.map === 'anubis')
  assert(mirage.plays === 3, 'mirage plays = 3')
  assert(mirage.w === 2 && mirage.l === 1, 'mirage 2W-1L')
  assert(mirage.wr === Math.round(2/3*100), 'mirage WR rounded')
  assert(mirage.confidence === 'LOW', 'mirage 3 plays → LOW confidence')
  assert(anubis.plays === 1, 'anubis plays = 1')
}

// ---- renderMapPool wires click → CustomEvent ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const vods = [
    { maps: [{ map: 'mirage', score_us: 13, score_them: 8 }] },
    { maps: [{ map: 'mirage', score_us: 13, score_them: 9 }] },
    { maps: [{ map: 'inferno', score_us: 13, score_them: 12 }] },
  ]
  renderMapPool(root, { vodsCurrent: vods, vodsPrior: [], activeMap: null })

  const rows = root.querySelectorAll('[data-map]')
  assert(rows.length === 2, 'one row per distinct map')

  let received = null
  root.addEventListener('rr:filter-map', (e) => { received = e.detail.map })
  root.querySelector('[data-map="mirage"]').click()
  assert(received === 'mirage', 'click → CustomEvent with detail.map=mirage')
}

// ---- Active map toggles off on second click ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const vods = [{ maps: [{ map: 'mirage', score_us: 13, score_them: 8 }] }]
  renderMapPool(root, { vodsCurrent: vods, vodsPrior: [], activeMap: 'mirage' })

  const row = root.querySelector('[data-map="mirage"]')
  assert(row.classList.contains('is-active'), 'active row marked')

  let received = '__not_set__'
  root.addEventListener('rr:filter-map', (e) => { received = e.detail.map })
  row.click()
  assert(received === null, 'click on active row → emits map=null (clear filter)')
}

// ---- Empty vods → empty marker ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  renderMapPool(root, { vodsCurrent: [], vodsPrior: [], activeMap: null })
  assert(root.querySelector('.rr-empty'), 'empty state rendered')
}

// ---- Trend column ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const cur = [
    { maps: [{ map: 'mirage', score_us: 13, score_them: 6 }] },
    { maps: [{ map: 'mirage', score_us: 13, score_them: 7 }] }, // 100% wr
  ]
  const prior = [
    { maps: [{ map: 'mirage', score_us: 8,  score_them: 13 }] }, // 0% wr
  ]
  renderMapPool(root, { vodsCurrent: cur, vodsPrior: prior, activeMap: null })
  const row = root.querySelector('[data-map="mirage"]')
  assert(row.dataset.trend === 'up', 'mirage went 0% → 100% → trend up')
}

console.log('all done')
</script>
</body>
</html>
```

- [ ] **Step 2: Run; verify failure**

Open the test in browser. Expected: import error.

- [ ] **Step 3: Create `cs2-hub/vods-map-pool.js`**

```js
// cs2-hub/vods-map-pool.js
//
// Map Pool Intelligence table. Per-map: WR, sample, trend, confidence.
// Row click emits CustomEvent('rr:filter-map', { detail: { map: <name|null> }}).
// Clicking the currently-active row emits null (clear filter).

import { computeTrend } from './vods-trend.js'

const TREND_THRESHOLD_PCT = 5
const CONF_HIGH = 8
const CONF_MED  = 4

const TREND_ARROW = { up: '↗', down: '↘', flat: '▬', unknown: '' }

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function pct(n, d) { return d === 0 ? null : Math.round((n / d) * 100) }

export function confidenceLabel(plays) {
  if (plays >= CONF_HIGH) return 'HIGH'
  if (plays >= CONF_MED)  return 'MEDIUM'
  return 'LOW'
}

// Returns rows sorted by plays desc (then WR desc).
export function computeMapPool(vods) {
  const by = {}
  for (const v of vods || []) {
    for (const m of v.maps ?? []) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      if (!by[m.map]) by[m.map] = { map: m.map, w: 0, l: 0, plays: 0 }
      by[m.map].plays++
      if (us > them) by[m.map].w++
      else if (them > us) by[m.map].l++
    }
  }
  return Object.values(by)
    .map(r => ({ ...r, wr: pct(r.w, r.w + r.l), confidence: confidenceLabel(r.plays) }))
    .sort((a, b) => b.plays - a.plays || (b.wr ?? -1) - (a.wr ?? -1))
}

export function renderMapPool(root, { vodsCurrent, vodsPrior, activeMap }) {
  const rows  = computeMapPool(vodsCurrent || [])
  const prior = computeMapPool(vodsPrior   || [])
  const priorByMap = new Map(prior.map(r => [r.map, r]))

  if (rows.length === 0) {
    root.innerHTML = `<div class="rr-section-label">MAP POOL INTELLIGENCE</div>
      <div class="rr-empty">No map data yet.</div>`
    return
  }

  const headerHtml = `
    <div class="rr-map-row rr-map-row-head">
      <div>Map</div><div>WR</div><div>Sample</div><div>Trend</div><div>Confidence</div>
    </div>`
  const bodyHtml = rows.map(r => {
    const trend = computeTrend(r.wr, priorByMap.get(r.map)?.wr ?? null, TREND_THRESHOLD_PCT)
    const isActive = r.map === activeMap
    const confClass = r.confidence === 'HIGH' ? 'rr-conf-high' :
                      r.confidence === 'MEDIUM' ? 'rr-conf-med' : 'rr-conf-low'
    return `
      <div class="rr-map-row ${isActive ? 'is-active' : ''}"
           data-map="${esc(r.map)}"
           data-trend="${trend}">
        <div>${esc(capitalize(r.map))}</div>
        <div>${r.wr == null ? '—' : r.wr + '%'}</div>
        <div>${r.plays} map${r.plays === 1 ? '' : 's'}</div>
        <div class="rr-trend-cell rr-trend-${trend}">${TREND_ARROW[trend] || ''}</div>
        <div class="rr-conf ${confClass}">${r.confidence}</div>
      </div>`
  }).join('')

  root.innerHTML = `
    <div class="rr-section-label">MAP POOL INTELLIGENCE</div>
    <div class="rr-map-table">${headerHtml}${bodyHtml}</div>`

  for (const el of root.querySelectorAll('[data-map]')) {
    el.addEventListener('click', () => {
      const next = el.classList.contains('is-active') ? null : el.dataset.map
      root.dispatchEvent(new CustomEvent('rr:filter-map', {
        bubbles: true,
        detail: { map: next },
      }))
    })
  }
}
```

- [ ] **Step 4: Reload test; all PASS**

Expected: all `PASS:`, ends with `all done`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/vods-map-pool.js cs2-hub/vods-map-pool.test.html
git commit -m "feat(results): map pool table with confidence + trend + filter event"
```

---

## Task 8: Build `vods-match-reports.js`

**Files:**
- Create: `cs2-hub/vods-match-reports.js`
- Test: `cs2-hub/vods-match-reports.test.html`

One card per vod. 4px left border by result. Header `WIN/LOSS/DRAW vs <opponent>`. Meta line `<maps label> · <match_type> · <date>`. Big score: BO1 → `score_us — score_them`. BOn → per-map stacked rows. Right column: top 3 performers by rating from the linked demo's `demo_players` rows (caller passes them in a map).

Listens (caller wires) for `rr:filter-map` to filter down to that map's vods. Public API:
- `renderMatchReports(root, { vods, demoToVod, demoPlayersByDemoId, mapFilter })`

`demoToVod` is `Map<demo_id, vod>` (from existing `linkDemosToVods`). `demoPlayersByDemoId` is `Map<demo_id, demo_players_row[]>` (the orchestrator partitions the same `rowsAll` it already fetches for player impact). `mapFilter` is a string or null.

PRACC badge: existing match list shows it when `v.external_uid` is truthy. Preserve that.

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/vods-match-reports.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<div id="root"></div>
<script type="module">
import { renderMatchReports } from './vods-match-reports.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}

// ---- BO1: single map, score rendered as score_us — score_them ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const vods = [{
    id: 'v1', opponent: 'ROUNDS', result: 'win',
    match_type: 'scrim', match_date: '2026-05-13',
    maps: [{ map: 'mirage', score_us: 16, score_them: 8 }],
  }]
  renderMatchReports(root, { vods, demoToVod: new Map(), demoPlayersByDemoId: new Map(), mapFilter: null })

  const card = root.querySelector('.rr-match-card')
  assert(card !== null, 'card rendered')
  assert(card.dataset.result === 'win', 'data-result=win')
  assert(card.querySelector('.rr-match-score').textContent.trim().replace(/\s+/g, ' ') === '16 — 8', 'BO1 score')
  assert(card.querySelector('.rr-match-head').textContent.includes('ROUNDS'), 'opponent in header')
}

// ---- BO3: stacked per-map scores ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const vods = [{
    id: 'v2', opponent: 'SAMURAI', result: 'loss',
    match_type: 'tournament', match_date: '2026-05-11',
    maps: [
      { map: 'mirage', score_us: 16, score_them: 12 },
      { map: 'anubis', score_us: 9,  score_them: 16 },
      { map: 'nuke',   score_us: 11, score_them: 16 },
    ],
  }]
  renderMatchReports(root, { vods, demoToVod: new Map(), demoPlayersByDemoId: new Map(), mapFilter: null })
  const rows = root.querySelectorAll('.rr-match-bo-row')
  assert(rows.length === 3, 'BO3 → 3 score rows')
}

// ---- Top 3 performers from linked demo ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const vods = [{
    id: 'v3', opponent: 'TEAM', result: 'win',
    match_type: 'scrim', match_date: '2026-05-10',
    maps: [{ map: 'mirage', score_us: 16, score_them: 5 }],
  }]
  const demo = { id: 'd1', map: 'mirage' }
  const demoToVod = new Map([['d1', vods[0]]])
  const demoPlayersByDemoId = new Map([['d1', [
    { steam_id: 'A', name: 'jXy',    rating: 1.22, rounds_played: 21, side: 'all' },
    { steam_id: 'B', name: 'Libra',  rating: 1.18, rounds_played: 21, side: 'all' },
    { steam_id: 'C', name: 'noctis', rating: 1.09, rounds_played: 21, side: 'all' },
    { steam_id: 'D', name: 'echo',   rating: 0.92, rounds_played: 21, side: 'all' },
    { steam_id: 'E', name: 'foo',    rating: 1.30, rounds_played: 21, side: 'ct' }, // excluded: side != 'all'
  ]]])
  renderMatchReports(root, { vods, demoToVod, demoPlayersByDemoId, mapFilter: null })

  const perf = root.querySelector('.rr-match-performers').textContent
  assert(perf.includes('jXy'),    'jXy listed')
  assert(perf.includes('Libra'),  'Libra listed')
  assert(perf.includes('noctis'), 'noctis listed')
  assert(!perf.includes('echo'),  'echo (4th) not listed')
  assert(!perf.includes('foo'),   'foo (side=ct) not listed')
}

// ---- Missing demo → no performers section ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const vods = [{
    id: 'v4', opponent: 'X', result: 'loss',
    match_type: 'pug', match_date: '2026-05-09',
    maps: [{ map: 'inferno', score_us: 4, score_them: 13 }],
  }]
  renderMatchReports(root, { vods, demoToVod: new Map(), demoPlayersByDemoId: new Map(), mapFilter: null })
  const card = root.querySelector('.rr-match-card')
  assert(card !== null, 'card still renders without demo')
  assert(card.querySelector('.rr-match-performers') === null, 'no performers section')
}

// ---- mapFilter narrows the list ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const vods = [
    { id: 'a', opponent: 'X', result: 'win',  match_type: 'scrim', match_date: '2026-05-10',
      maps: [{ map: 'mirage', score_us: 16, score_them: 8 }] },
    { id: 'b', opponent: 'Y', result: 'loss', match_type: 'scrim', match_date: '2026-05-09',
      maps: [{ map: 'anubis', score_us: 6, score_them: 16 }] },
    { id: 'c', opponent: 'Z', result: 'win',  match_type: 'scrim', match_date: '2026-05-08',
      maps: [
        { map: 'mirage', score_us: 16, score_them: 10 },
        { map: 'anubis', score_us: 8, score_them: 16 },
        { map: 'mirage', score_us: 16, score_them: 12 },
      ] },
  ]
  renderMatchReports(root, { vods, demoToVod: new Map(), demoPlayersByDemoId: new Map(), mapFilter: 'mirage' })
  const cards = root.querySelectorAll('.rr-match-card')
  assert(cards.length === 2, 'mapFilter=mirage → 2 cards (a, c)')
}

// ---- PRACC badge ----
{
  const root = document.getElementById('root')
  root.innerHTML = ''
  const vods = [{
    id: 'p', opponent: 'X', result: 'win',
    match_type: 'scrim', match_date: '2026-05-13',
    external_uid: 'pracc-123',
    maps: [{ map: 'mirage', score_us: 13, score_them: 8 }],
  }]
  renderMatchReports(root, { vods, demoToVod: new Map(), demoPlayersByDemoId: new Map(), mapFilter: null })
  assert(root.querySelector('.rr-pracc-badge') !== null, 'PRACC badge rendered when external_uid set')
}

console.log('all done')
</script>
</body>
</html>
```

- [ ] **Step 2: Run; verify failure**

Open the test. Expected: import error.

- [ ] **Step 3: Create `cs2-hub/vods-match-reports.js`**

```js
// cs2-hub/vods-match-reports.js
//
// Per-vod match cards. Pure render — orchestrator passes in the linked
// demo map and the demo_players rows. mapFilter narrows the list.

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function deriveResult(vod) {
  let mw = 0, ml = 0
  for (const m of vod.maps ?? []) {
    if ((m.score_us ?? 0) > (m.score_them ?? 0)) mw++
    else if ((m.score_them ?? 0) > (m.score_us ?? 0)) ml++
  }
  if (mw > ml) return 'win'
  if (ml > mw) return 'loss'
  if ((vod.maps ?? []).length) return 'draw'
  return vod.result ?? 'draw'
}

function findDemoForVod(vod, demoToVod) {
  // demoToVod is Map<demo_id, vod>. Reverse-scan to find the demo linked to this vod.
  for (const [demoId, v] of demoToVod) {
    if (v?.id === vod.id) return demoId
  }
  return null
}

function topPerformers(demoId, demoPlayersByDemoId) {
  if (!demoId) return []
  const rows = (demoPlayersByDemoId.get(demoId) ?? []).filter(r => r.side === 'all')
  return [...rows]
    .filter(r => r.rating != null)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 3)
}

export function renderMatchReports(root, { vods, demoToVod, demoPlayersByDemoId, mapFilter }) {
  const filtered = (vods || []).filter(v => {
    if (!mapFilter) return true
    return (v.maps ?? []).some(m => String(m.map).toLowerCase() === String(mapFilter).toLowerCase())
  })

  if (filtered.length === 0) {
    root.innerHTML = `
      <div class="rr-section-label">MATCH REPORTS${mapFilter ? ` · ${esc(capitalize(mapFilter))}` : ''}</div>
      <div class="rr-empty">${mapFilter ? `No matches on ${esc(capitalize(mapFilter))} in window.` : 'No matches in window.'}</div>`
    return
  }

  const cards = filtered.map(v => {
    const result = deriveResult(v)
    const maps = v.maps ?? []
    const opponent = v.opponent ?? v.title ?? '—'

    const scoreHtml = maps.length === 1
      ? `<div class="rr-match-score">${maps[0].score_us ?? '?'} <span class="rr-match-score-sep">—</span> ${maps[0].score_them ?? '?'}</div>`
      : `<div class="rr-match-bo">${maps.map(m =>
          `<div class="rr-match-bo-row">
             <span class="rr-match-bo-map">${esc(capitalize(m.map))}</span>
             <span class="rr-match-bo-score">${m.score_us ?? '?'} — ${m.score_them ?? '?'}</span>
           </div>`).join('')}</div>`

    const mapLabel = maps.length === 0
      ? 'No maps'
      : maps.length === 1
        ? capitalize(maps[0].map)
        : `BO${maps.length}`

    const demoId = findDemoForVod(v, demoToVod || new Map())
    const performers = topPerformers(demoId, demoPlayersByDemoId || new Map())
    const perfHtml = performers.length
      ? `<div class="rr-match-performers">
           <div class="rr-match-performers-label">Top performers</div>
           ${performers.map(p =>
             `<span class="rr-match-perf"><b>${esc(p.name)}</b> ${p.rating.toFixed(2)}</span>`
           ).join(' · ')}
         </div>`
      : ''

    return `
      <a class="rr-match-card rr-match-${result}" data-result="${result}" href="vod-detail.html?id=${esc(v.id)}">
        <div class="rr-match-left">
          <div class="rr-match-head">
            <span class="rr-match-tag rr-match-tag-${result}">${result.toUpperCase()}</span>
            <span class="rr-match-vs">vs ${esc(opponent)}</span>
            ${v.external_uid ? '<span class="rr-pracc-badge">PRACC</span>' : ''}
          </div>
          <div class="rr-match-meta">
            <span>${esc(mapLabel)}</span>
            <span class="rr-match-dot">·</span>
            <span>${esc(capitalize(v.match_type ?? ''))}</span>
            <span class="rr-match-dot">·</span>
            <span>${formatDate(v.match_date)}</span>
          </div>
        </div>
        <div class="rr-match-mid">${scoreHtml}</div>
        <div class="rr-match-right">${perfHtml}</div>
      </a>`
  }).join('')

  root.innerHTML = `
    <div class="rr-section-label">MATCH REPORTS${mapFilter ? ` · ${esc(capitalize(mapFilter))} <button type="button" class="rr-clear-map">clear</button>` : ''}</div>
    <div class="rr-match-list">${cards}</div>`

  const clearBtn = root.querySelector('.rr-clear-map')
  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      root.dispatchEvent(new CustomEvent('rr:filter-map', { bubbles: true, detail: { map: null } }))
    })
  }
}
```

- [ ] **Step 4: Reload test; all PASS**

Expected: all `PASS:`, ends with `all done`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/vods-match-reports.js cs2-hub/vods-match-reports.test.html
git commit -m "feat(results): match report cards with score + top performers + map filter"
```

---

## Task 9: Rewrite `vods.js` orchestrator

**Files:**
- Modify: `cs2-hub/vods.js` (full replace)

Loads vods + roster + team once on boot. On every filter change:
1. Splits `allVods` into `currentVods` / `priorVods` via `splitVodsByWindow`.
2. Applies match-type filter on top of the current/prior windows.
3. Fetches `demos` + `demo_players` covering both windows (single query each, widened date range).
4. Calls each section's render with the right slice.
5. Listens for `rr:filter-map` at the document level to set `state.mapFilter` and re-render only match reports.
6. Drawer integration: clicking a player card calls `openPlayerDrawer`, identical to current behavior.

- [ ] **Step 1: Overwrite `cs2-hub/vods.js`**

```js
// cs2-hub/vods.js
//
// Results & Review orchestrator. Loads data once, re-renders each section
// on filter change. Sections are pure render modules; this file owns the
// data layer + the drawer.

import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { mountFilter } from './vods-filter.js'
import { renderHero } from './vods-hero.js'
import { renderPlayerImpact } from './vods-player-impact.js'
import { renderMapPool } from './vods-map-pool.js'
import { renderMatchReports } from './vods-match-reports.js'
import { splitVodsByWindow } from './vods-trend.js'
import { mountDrawer } from './player-drawer.js'
import { buildPlayerDrawerBody, buildSubtitle } from './roster-stats-render.js'
import { linkDemosToVods } from './auto-fill-vod.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('vods')

const teamId = getTeamId()
const drawer = mountDrawer()

// ── Boot: load everything we need once ──────────────────────────
const [vodsRes, rosterRes, teamRes] = await Promise.all([
  supabase.from('vods').select('*').eq('team_id', teamId).eq('dismissed', false).order('match_date', { ascending: false }),
  supabase.from('roster').select('*').eq('team_id', teamId),
  supabase.from('teams').select('name').eq('id', teamId).maybeSingle(),
])
if (vodsRes.error) {
  document.getElementById('rr-hero').innerHTML =
    `<div class="empty-state"><h3>Failed to load matches</h3><p>${esc(vodsRes.error.message)}</p></div>`
  throw vodsRes.error
}
const allVods = vodsRes.data ?? []
const roster  = rosterRes.data ?? []
const ourTeamName = teamRes.data?.name ?? ''
const teamSteamIds = new Set(roster.map(p => p.steam_id).filter(Boolean))

// Mount the hero shell once so its filter slot exists.
const HERO_FILTER_SLOT = 'rr-filter-slot'
renderHero(document.getElementById('rr-hero'), { vods: allVods, filterSlotId: HERO_FILTER_SLOT })

if (allVods.length === 0) {
  document.getElementById('rr-player-impact').innerHTML = ''
  document.getElementById('rr-map-pool').innerHTML = ''
  document.getElementById('rr-match-reports').innerHTML = ''
}

// ── State ────────────────────────────────────────────────────────
let state = { filter: null, mapFilter: null, dataset: null }

function applyMatchTypeFilter(vods, matchType) {
  if (!matchType || matchType === 'all') return vods
  return vods.filter(v => v.match_type === matchType)
}

function widenDate(d, delta) {
  const dt = new Date(`${d}T00:00:00`)
  dt.setDate(dt.getDate() + delta)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

async function fetchDemosForVodWindow(vods) {
  const empty = { demos: [], rowsAll: [], rowsCT: [], rowsT: [], demoToVod: new Map() }
  if (!vods.length || !teamSteamIds.size) return empty

  const dates = vods.map(v => v.match_date).filter(Boolean).sort()
  if (!dates.length) return empty
  const minDate = widenDate(dates[0], -1)
  const maxDate = widenDate(dates[dates.length - 1], 1)

  const { data: demos, error: e1 } = await supabase
    .from('demos')
    .select('id,series_id,map,played_at,opponent_name,ct_team_name,t_team_name,created_at,status,team_id')
    .eq('team_id', teamId)
    .eq('status', 'ready')
    .gte('created_at', `${minDate}T00:00:00`)
    .lte('created_at', `${maxDate}T23:59:59`)
  if (e1) throw e1

  const demoToVod = linkDemosToVods(demos || [], vods)

  if (!(demos || []).length) return { demos: [], rowsAll: [], rowsCT: [], rowsT: [], demoToVod }

  const { data: rows, error: e3 } = await supabase
    .from('demo_players')
    .select('*')
    .in('demo_id', demos.map(d => d.id))
    .in('steam_id', [...teamSteamIds])
  if (e3) throw e3

  const demosById = new Map((demos || []).map(d => [d.id, d]))
  for (const r of rows || []) {
    const d = demosById.get(r.demo_id)
    r.map = d?.map ?? null
  }
  const rowsAll = (rows || []).filter(r => r.side === 'all')
  const rowsCT  = (rows || []).filter(r => r.side === 'ct')
  const rowsT   = (rows || []).filter(r => r.side === 't')
  return { demos: demos || [], rowsAll, rowsCT, rowsT, demoToVod, demosById }
}

function groupByDemoId(rows) {
  const m = new Map()
  for (const r of rows || []) {
    if (!r.demo_id) continue
    if (!m.has(r.demo_id)) m.set(r.demo_id, [])
    m.get(r.demo_id).push(r)
  }
  return m
}

async function rebuild(filter) {
  state.filter = filter
  const { current, prior } = splitVodsByWindow(allVods, filter)
  const currentFiltered = applyMatchTypeFilter(current, filter.matchType)
  const priorFiltered   = applyMatchTypeFilter(prior,   filter.matchType)

  // Re-render hero whenever the filtered current set changes
  renderHero(document.getElementById('rr-hero'), { vods: currentFiltered, filterSlotId: HERO_FILTER_SLOT })
  // Re-mount filter into the new slot (renderHero blew it away)
  mountFilter(document.getElementById(HERO_FILTER_SLOT), (f) => {
    // Avoid reentry: only rebuild if state actually changed
    if (JSON.stringify(f) === JSON.stringify(state.filter)) return
    rebuild(f)
  })

  // Single fetch covering BOTH windows for demo_players (used by both
  // player-impact's trend computation and match-reports' top performers).
  const union = [...currentFiltered, ...priorFiltered]
  const data = await fetchDemosForVodWindow(union)

  // Partition demo_players rows back into current vs prior by their demo's
  // played_at / created_at falling inside the corresponding vod date window.
  // For simplicity we partition by checking whether the demo links to a vod
  // in current vs prior.
  const currentVodIds = new Set(currentFiltered.map(v => v.id))
  const priorVodIds   = new Set(priorFiltered.map(v => v.id))
  const rowsCurrent = []
  const rowsPrior   = []
  for (const r of data.rowsAll) {
    const linkedVod = data.demoToVod.get(r.demo_id)
    if (linkedVod && currentVodIds.has(linkedVod.id)) rowsCurrent.push(r)
    else if (linkedVod && priorVodIds.has(linkedVod.id)) rowsPrior.push(r)
  }

  state.dataset = {
    filter,
    currentVods: currentFiltered,
    priorVods:   priorFiltered,
    rowsAll: data.rowsAll, rowsCT: data.rowsCT, rowsT: data.rowsT,
    demosById: data.demosById,
    demoToVod: data.demoToVod,
    rowsCurrent, rowsPrior,
  }

  renderPlayerImpact(document.getElementById('rr-player-impact'), {
    roster, rowsCurrent, rowsPrior, onPick: openPlayerDrawer,
  })
  renderMapPool(document.getElementById('rr-map-pool'), {
    vodsCurrent: currentFiltered, vodsPrior: priorFiltered, activeMap: state.mapFilter,
  })
  renderMatchReports(document.getElementById('rr-match-reports'), {
    vods: currentFiltered,
    demoToVod: data.demoToVod,
    demoPlayersByDemoId: groupByDemoId(data.rowsAll),
    mapFilter: state.mapFilter,
  })

  // Refresh drawer if open
  if (drawer.isOpen()) {
    const openName = document.querySelector('.player-drawer .pd-title')?.textContent
    const player = roster.find(p => p.nickname === openName)
    if (player && player.steam_id) openPlayerDrawer(player)
    else drawer.close()
  }
}

function demoOpponentName(demo) {
  const ct = (demo?.ct_team_name || '').trim()
  const t  = (demo?.t_team_name  || '').trim()
  const us = (ourTeamName || '').trim().toLowerCase()
  if (!ct && !t) return null
  const ctIsUs = !!ct && ct.toLowerCase() === us
  const tIsUs  = !!t  && t.toLowerCase()  === us
  if (ctIsUs && !tIsUs) return t || null
  if (tIsUs  && !ctIsUs) return ct || null
  if (ct && t) return `${ct} vs ${t}`
  return ct || t || null
}

function demoResult(demo, vod) {
  if (!vod || !demo) return 'd'
  const slot = (vod.maps || []).find(m => String(m.map).toLowerCase() === String(demo.map).toLowerCase())
  if (!slot || slot.score_us == null || slot.score_them == null) return 'd'
  if (slot.score_us > slot.score_them) return 'w'
  if (slot.score_us < slot.score_them) return 'l'
  return 'd'
}

async function openPlayerDrawer(player) {
  if (!state.dataset) return
  if (drawer.isOpen() && document.querySelector('.player-drawer .pd-title')?.textContent === player.nickname) {
    drawer.close(); return
  }
  const { rowsAll, rowsCT, rowsT, demosById, demoToVod, filter } = state.dataset
  const sid = player.steam_id
  const myAll = rowsAll.filter(r => r.steam_id === sid)
  const myCT  = rowsCT.filter(r  => r.steam_id === sid)
  const myT   = rowsT.filter(r   => r.steam_id === sid)
  const matches = myAll.length
  const rounds  = myAll.reduce((s, r) => s + (r.rounds_played || 0), 0)

  const recent = myAll
    .map(r => {
      const demo = demosById?.get(r.demo_id)
      const vod  = demo ? demoToVod.get(r.demo_id) : null
      return {
        vod_id: vod?.id,
        opponent: vod?.opponent ?? demoOpponentName(demo) ?? demo?.opponent_name ?? '—',
        map: demo?.map ?? '—',
        rating: r.rating,
        result: demoResult(demo, vod),
        played_at: demo?.played_at ?? demo?.created_at ?? null,
      }
    })
    .sort((a, b) => String(b.played_at || '').localeCompare(String(a.played_at || '')))
    .slice(0, 10)

  drawer.open({
    title: player.nickname,
    subtitle: buildSubtitle(player, filter.window, matches, rounds),
    body: buildPlayerDrawerBody({ rowsAll: myAll, rowsCT: myCT, rowsT: myT, recent }),
  })
}

// ── Wire map filter event (delegated at document level) ───────────
document.addEventListener('rr:filter-map', (e) => {
  state.mapFilter = e.detail?.map ?? null
  if (state.filter) rebuild(state.filter)
})

// ── Mount filter into the hero's filter slot ──────────────────────
mountFilter(document.getElementById(HERO_FILTER_SLOT), (f) => { rebuild(f) })
```

- [ ] **Step 2: Commit (no test for orchestrator — covered by manual smoke in Task 12)**

```bash
git add cs2-hub/vods.js
git commit -m "feat(results): rewrite vods.js orchestrator for tactical layout"
```

---

## Task 10: Add CSS for the new sections

**Files:**
- Modify: `cs2-hub/style.css` (append a new block at end of file)

- [ ] **Step 1: Append this block to the END of `cs2-hub/style.css`**

```css
/* ── Results & Review (tactical) ─────────────────────────────────── */
.rr-hero {
  position: relative;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-lg);
  padding: 22px 24px;
  box-shadow: 0 0 30px rgba(0, 255, 156, 0.08);
  overflow: hidden;
  margin-bottom: 22px;
}
.rr-hero::before {
  content: '';
  position: absolute; inset: 0;
  background-image:
    linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px);
  background-size: 32px 32px;
  pointer-events: none;
}
.rr-hero > * { position: relative; }
.rr-hero-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 28px; align-items: center; }
.rr-hero-empty { text-align: center; padding: 24px 0; }
.rr-hero-empty-msg { margin: 12px 0 18px; font-family: var(--display-font); font-weight: 700; }

.rr-hero-title,
.rr-section-label {
  font-family: var(--display-font);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 10px;
}
.rr-section-label { margin-top: 24px; }

.rr-hero-record {
  font-family: var(--display-font);
  font-size: 44px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1;
  display: flex; gap: 10px; align-items: baseline;
}
.rr-hero-record .rr-hero-w { color: var(--accent); }
.rr-hero-record .rr-hero-l { color: var(--danger); }
.rr-hero-record .rr-hero-d { color: var(--muted); }
.rr-hero-record .rr-hero-sep { color: var(--muted); font-weight: 400; }

.rr-hero-subgrid { display: flex; gap: 28px; margin-top: 16px; }
.rr-kv-k { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
.rr-kv-v { font-size: 18px; font-weight: 700; margin-top: 4px; color: var(--text); }

.rr-add-match {
  display: inline-block;
  margin-top: 16px;
  background: var(--accent);
  color: var(--accent-on);
  font-weight: 700;
  font-size: 12px;
  padding: 9px 16px;
  border-radius: var(--r-md);
  text-decoration: none;
  letter-spacing: 0.04em;
}
.rr-add-match:hover { box-shadow: var(--accent-glow); }

.rr-spark {
  height: 64px;
  display: flex; gap: 4px; align-items: flex-end;
  padding: 6px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
}
.rr-spark-bar {
  flex: 1;
  background: rgba(0, 255, 156, 0.4);
  border-radius: 2px;
  min-height: 4px;
}
.rr-filter-slot { margin-top: 14px; }

.vods-filter-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.vods-filter-pills {
  display: flex; gap: 3px;
  background: rgba(255,255,255,0.04);
  padding: 3px;
  border-radius: 7px;
}
.vods-filter-pill {
  border: none; background: transparent; cursor: pointer;
  color: var(--muted); padding: 5px 12px; font-size: 11px;
  border-radius: 5px;
  transition: background 0.12s, color 0.12s;
}
.vods-filter-pill:hover { color: var(--text); }
.vods-filter-pill.is-active { background: rgba(0,255,156,0.18); color: var(--accent); }

/* Player Impact */
.rr-section { margin-bottom: 22px; }
.rr-player-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 1100px) { .rr-player-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 700px)  { .rr-player-grid { grid-template-columns: repeat(2, 1fr); } }

.rr-player-card {
  display: block; text-align: left;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-left: 3px solid var(--rr-role-color, var(--muted));
  border-radius: var(--r-md);
  padding: 12px 14px;
  cursor: pointer;
  transition: transform 220ms ease, box-shadow 220ms ease;
  color: var(--text);
}
.rr-player-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 0 20px rgba(0,255,156,0.14);
}
.rr-player-card-empty { opacity: 0.55; }
.rr-player-name { font-weight: 700; font-size: 14px; }
.rr-player-role {
  font-family: var(--display-font);
  font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--muted); margin: 2px 0 8px;
}
.rr-player-rating {
  font-family: var(--display-font);
  font-size: 24px; font-weight: 800;
}
.rr-trend { font-size: 14px; margin-left: 4px; }
.rr-trend-up   { color: var(--accent); }
.rr-trend-down { color: var(--danger); }
.rr-trend-flat { color: var(--muted); }
.rr-player-supports {
  display: flex; flex-direction: column; gap: 4px;
  margin-top: 8px;
  font-size: 11px;
}
.rr-support-k { color: var(--muted); }
.rr-support-v { color: var(--text); font-weight: 600; margin-left: 4px; }
.rr-impact-bar { height: 4px; background: rgba(255,255,255,0.06); border-radius: 2px; margin-top: 10px; overflow: hidden; }
.rr-impact-fill { height: 100%; background: var(--accent); }
.rr-player-empty-msg { font-size: 11px; color: var(--muted); margin-top: 6px; }

/* Map Pool */
.rr-map-table {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
  overflow: hidden;
}
.rr-map-row {
  display: grid;
  grid-template-columns: 1.4fr 0.8fr 0.9fr 0.7fr 0.8fr;
  gap: 10px;
  padding: 11px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  font-size: 13px;
  align-items: center;
  cursor: pointer;
  transition: background 120ms;
}
.rr-map-row:last-child { border-bottom: none; }
.rr-map-row:hover { background: rgba(255,255,255,0.03); }
.rr-map-row.is-active { background: rgba(0,255,156,0.08); }
.rr-map-row-head {
  cursor: default;
  font-family: var(--display-font);
  font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--muted);
  background: rgba(255,255,255,0.02);
}
.rr-map-row-head:hover { background: rgba(255,255,255,0.02); }
.rr-conf-high { color: var(--accent); font-weight: 700; }
.rr-conf-med  { color: var(--warning); font-weight: 700; }
.rr-conf-low  { color: var(--danger); font-weight: 700; }

/* Match Reports */
.rr-match-list { display: flex; flex-direction: column; gap: 10px; }
.rr-match-card {
  display: grid;
  grid-template-columns: 1.2fr 1fr 1fr;
  gap: 16px;
  align-items: center;
  padding: 14px 16px;
  background: rgba(15,25,38,0.5);
  border: 1px solid var(--glass-border);
  border-left: 4px solid var(--muted);
  border-radius: var(--r-md);
  text-decoration: none;
  color: var(--text);
  transition: transform 220ms ease, box-shadow 220ms ease;
}
.rr-match-card:hover { transform: translateY(-2px); box-shadow: 0 0 20px rgba(0,255,156,0.14); }
.rr-match-win  { border-left-color: var(--accent); }
.rr-match-loss { border-left-color: var(--danger); }
.rr-match-draw { border-left-color: var(--muted); }
.rr-match-head { display: flex; align-items: center; gap: 8px; font-weight: 700; }
.rr-match-tag {
  font-family: var(--display-font);
  font-size: 10px; letter-spacing: 0.14em;
  padding: 2px 8px; border-radius: 4px;
}
.rr-match-tag-win  { background: rgba(0,255,156,0.15); color: var(--accent); }
.rr-match-tag-loss { background: rgba(255,77,77,0.15); color: var(--danger); }
.rr-match-tag-draw { background: rgba(255,255,255,0.08); color: var(--muted); }
.rr-match-meta { font-size: 11px; color: var(--muted); margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
.rr-match-dot { color: var(--muted); opacity: 0.5; }
.rr-match-score { font-family: var(--display-font); font-size: 26px; font-weight: 800; letter-spacing: -0.02em; }
.rr-match-score-sep { color: var(--muted); font-weight: 400; padding: 0 4px; }
.rr-match-bo { display: flex; flex-direction: column; gap: 4px; }
.rr-match-bo-row { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }
.rr-match-bo-map { color: var(--muted); }
.rr-match-bo-score { font-family: var(--display-font); font-weight: 700; }
.rr-match-performers { font-size: 11px; color: var(--text-variant); }
.rr-match-performers-label {
  font-family: var(--display-font);
  font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--muted); margin-bottom: 4px;
}
.rr-match-perf b { color: var(--text); font-weight: 700; }
.rr-pracc-badge {
  background: rgba(58,160,255,0.15);
  color: var(--special);
  font-size: 9px; font-family: var(--display-font);
  letter-spacing: 0.14em; padding: 2px 6px; border-radius: 4px;
}
.rr-clear-map {
  margin-left: 8px;
  background: transparent; border: none;
  color: var(--accent); font-size: 11px;
  cursor: pointer; text-decoration: underline;
}

.rr-empty {
  padding: 28px 16px;
  text-align: center;
  color: var(--muted);
  background: var(--glass-bg);
  border: 1px dashed var(--glass-border);
  border-radius: var(--r-md);
}

@media (max-width: 800px) {
  .rr-hero-grid { grid-template-columns: 1fr; }
  .rr-match-card { grid-template-columns: 1fr; }
}
```

- [ ] **Step 2: Commit**

```bash
git add cs2-hub/style.css
git commit -m "feat(style): tactical Results & Review section styles"
```

---

## Task 11: Remove dead modules

**Files:**
- Delete: `cs2-hub/vods-team-stats.js`
- Delete: `cs2-hub/roster-stats.js`

The new orchestrator no longer imports these. Confirm no external consumers, then delete.

- [ ] **Step 1: Confirm no other files import the dead modules**

Use Grep:

```
pattern: vods-team-stats|roster-stats(?!-)
path: cs2-hub
```

Expected matches: only the old `vods.js` (gone now) and the files themselves. If anything else imports them, STOP and report — investigation needed before deletion.

- [ ] **Step 2: Delete `cs2-hub/vods-team-stats.js`**

```bash
rm cs2-hub/vods-team-stats.js
```

- [ ] **Step 3: Delete `cs2-hub/roster-stats.js`**

```bash
rm cs2-hub/roster-stats.js
```

- [ ] **Step 4: Verify nothing imports `roster-stats.js` anymore** (`roster-stats-aggregate.js` and `roster-stats-render.js` are different files and stay)

```
pattern: from ['\"].*roster-stats['\"]
path: cs2-hub
```

Expected matches: zero.

- [ ] **Step 5: Commit**

```bash
git add -A cs2-hub
git commit -m "chore(results): remove dead vods-team-stats and roster-stats modules"
```

---

## Task 12: Manual smoke test

No automated end-to-end harness exists in this repo. Walk through the page in a real browser against the live Supabase team. Treat every red flag as a bug to file before declaring done.

- [ ] **Step 1: Open the live app and sign in**

Open `cs2-hub/login.html` in a local server (whichever the team uses for `cs2-hub/` — typically `npx serve` or VS Code Live Server). Sign in, pick a team that has at least 5 logged vods with linked demos.

- [ ] **Step 2: Open Results & Review (`cs2-hub/vods.html`)**

Expected:
- Hero shows record (Ws green, Ls red), Round WR %, Best/Weakest maps.
- Sparkline shows up to 10 vertical bars.
- Filter pills: `Last 10 / 30d / 90d / All time` + `All / Scrim / Tourn. / Pug`. `Last 10` and `All` are highlighted by default.
- `+ Add Match` button is visible top-left of the hero.

- [ ] **Step 3: Click each window pill** (`30 days`, `90 days`, `All time`, `Last 10`)

Each click should:
- Update the highlighted pill.
- Refresh hero numerals, player cards, map table, and match list.
- Persist across page reloads (verify by reloading after switching to `90 days`).

- [ ] **Step 4: Click each match-type pill** (`Scrim`, `Tourn.`, `Pug`, `All`)

Match list should narrow to only that type.

- [ ] **Step 5: Verify Player Impact**
- Five player cards (or however many non-staff roster members exist) in role order: IGL → Entry → AWP → Lurker → Support.
- Each card has its left border color matching its role.
- Trend arrows render where prior-window data exists.
- Impact bar widths look proportional (top player ~100%, bottom ~0% in a well-populated window).
- Clicking a card opens the drawer with the player's headline stats.

- [ ] **Step 6: Verify Map Pool**
- Header row visible, rows sorted by plays desc.
- Confidence label color: green for HIGH, orange for MEDIUM, red for LOW.
- Click a map row: section label updates to `MATCH REPORTS · <Map>`, list narrows to that map, "clear" link appears next to it. Active row is highlighted green.
- Click the "clear" link: map filter clears, full list returns, active row deselects.
- Click the same map row again: same behavior as "clear" (toggle-off).

- [ ] **Step 7: Verify Match Reports**
- Win cards have green left border, losses red, draws muted.
- BO1 cards show single big score. BO3 cards show 3 stacked map score rows.
- Top performers list shows up to 3 names with ratings when the demo is linked.
- Clicking a card navigates to `vod-detail.html?id=...`.
- PRACC badge appears on vods that have an `external_uid`.

- [ ] **Step 8: Verify empty-state behaviors**
- Switch to a team with zero matches (or filter to a window with zero results): hero collapses to "No matches yet" + Add CTA; other sections show empty placeholders ("No matches in window", "No map data yet").
- Console has no errors.

- [ ] **Step 9: Verify the page still navigates from elsewhere**
- From `dashboard.html`, click any link that points to `vods.html` — must arrive on the new page.
- From `opponent-detail.html`, same.

- [ ] **Step 10: Commit the smoke-test sign-off** (no code changes; commit only if a docs/CHANGELOG file needs updating — otherwise skip the commit)

If you encountered bugs during smoke, file them as new tasks and stop. Otherwise:

```bash
git status
# Should show: nothing to commit, working tree clean
```

---

## Task 13: Final verification + cleanup

- [ ] **Step 1: Run every test file once**

Open each in a browser, verify all `PASS:`:
- `cs2-hub/vods-trend.test.html`
- `cs2-hub/vods-filter.test.html`
- `cs2-hub/vods-hero.test.html`
- `cs2-hub/vods-player-impact.test.html`
- `cs2-hub/vods-map-pool.test.html`
- `cs2-hub/vods-match-reports.test.html`
- `cs2-hub/roster-stats-aggregate.test.html` (regression — must still pass untouched)

- [ ] **Step 2: Confirm git log**

```bash
git log --oneline -20
```

Expected: a sequence of ~10 commits from this plan, all prefixed `feat(...)` / `chore(...)` / `style(...)`, all local (no pushes).

- [ ] **Step 3: Done**

No further commits needed — the plan is complete.

---
