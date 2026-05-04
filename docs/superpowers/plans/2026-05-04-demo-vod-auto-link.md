# Demo ↔ Vod Auto-Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-fill `vods.maps[i].score_us/score_them`, `vods.result`, and (single-map only) `vods.demo_link` when a demo and a vod match on opponent + date.

**Architecture:** New pure module `cs2-hub/auto-fill-vod.js` with four exports (`normName`, `findCandidateVods`, `pickBestVod`, `scoresFromDemo`, `computeVodPatch`). Tests in `auto-fill-vod.test.html`. Two integration sites: `assign-teams-modal.js` (Trigger A — after modal save) and `schedule.js` (Trigger B — after pracc sync inserts new vods).

**Tech Stack:** Vanilla ES modules, Supabase JS client. No build step.

**Spec:** `docs/superpowers/specs/2026-05-04-demo-vod-auto-link.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `cs2-hub/auto-fill-vod.js` | new | Pure: normName, findCandidateVods, pickBestVod, scoresFromDemo, computeVodPatch |
| `cs2-hub/auto-fill-vod.test.html` | new | Browser/Node tests for all pure helpers |
| `cs2-hub/assign-teams-modal.js` | modify | After save, run auto-fill against vods, show toast |
| `cs2-hub/schedule.js` | modify | After pracc-sync vod insert, scan demos and patch new vods |

---

### Task 1: Pure module skeleton + `findCandidateVods` + tests

**Files:**
- Create: `cs2-hub/auto-fill-vod.js`
- Create: `cs2-hub/auto-fill-vod.test.html`

- [ ] **Step 1: Create `cs2-hub/auto-fill-vod.js` with `normName` and `findCandidateVods`**

```js
// Pure helpers for auto-linking uploaded demos to existing vods.
// No DOM, no Supabase — safe to import from a test page or Node.
//
// Spec: docs/superpowers/specs/2026-05-04-demo-vod-auto-link.md

// Normalize a team or opponent name for comparison: trim + lowercase.
// null/undefined → "" so comparison is total without throwing.
export function normName(s) {
  return (s ?? '').trim().toLowerCase()
}

// Calendar-day delta between two YYYY-MM-DD strings (or anything Date can parse).
// Returns abs difference in days, treating both as local midnight.
function daysApart(aStr, bStr) {
  if (!aStr || !bStr) return Infinity
  const a = new Date(`${aStr}T00:00:00`)
  const b = new Date(`${bStr}T00:00:00`)
  return Math.abs(Math.round((a - b) / 86400000))
}

// YYYY-MM-DD in local TZ. Mirror of localDateStr in pracc-sync.js — kept
// here so this module has no cross-imports. Two trivial copies > a coupling.
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Demo's best calendar date in local TZ. played_at is parser-derived (most
// accurate); fall back to created_at when the parser didn't fill it.
export function demoLocalDate(demo) {
  const ts = demo.played_at || demo.created_at
  if (!ts) return null
  return localDateStr(new Date(ts))
}

// Filter vods to those that could plausibly match the demo:
// - opponent name matches one of the demo's two team names (case-insensitive + trimmed)
// - match_date is within ±1 calendar day of demo date
// Returns a new array; never mutates input.
export function findCandidateVods(demo, vods) {
  if (!demo || !vods?.length) return []
  const demoDate = demoLocalDate(demo)
  if (!demoDate) return []
  const demoNames = [normName(demo.ct_team_name), normName(demo.t_team_name)].filter(Boolean)
  if (!demoNames.length) return []
  return vods.filter(v => {
    if (!v.opponent || !v.match_date) return false
    if (!demoNames.includes(normName(v.opponent))) return false
    return daysApart(v.match_date, demoDate) <= 1
  })
}
```

- [ ] **Step 2: Create `cs2-hub/auto-fill-vod.test.html`**

```html
<!DOCTYPE html>
<html>
<body>
<script type="module">
import {
  normName,
  demoLocalDate,
  findCandidateVods,
} from './auto-fill-vod.js'

function assert(condition, msg) {
  if (!condition) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}

// ---- normName ----
assert(normName('  NaVi  ') === 'navi', 'normName trims + lowercases')
assert(normName(null) === '', 'normName: null → ""')
assert(normName(undefined) === '', 'normName: undefined → ""')
assert(normName('') === '', 'normName: empty → ""')

// ---- demoLocalDate ----
{
  const d = { played_at: '2026-05-04T18:30:00' }
  assert(demoLocalDate(d) === '2026-05-04', 'demoLocalDate: uses played_at')
}
{
  const d = { played_at: null, created_at: '2026-05-04T22:00:00' }
  assert(demoLocalDate(d) === '2026-05-04', 'demoLocalDate: falls back to created_at')
}
{
  assert(demoLocalDate({}) === null, 'demoLocalDate: no timestamps → null')
}

// ---- findCandidateVods ----
const baseDemo = {
  played_at: '2026-05-04T18:00:00',
  ct_team_name: 'NaVi',
  t_team_name: 'Astralis',
}
{
  const out = findCandidateVods(baseDemo, [])
  assert(out.length === 0, 'findCandidateVods: empty vods → []')
}
{
  // Same opponent, same day
  const vods = [{ id: 'v1', opponent: 'Astralis', match_date: '2026-05-04', maps: [] }]
  assert(findCandidateVods(baseDemo, vods).length === 1, 'same opponent + same day matches')
}
{
  // Case-insensitive
  const vods = [{ id: 'v1', opponent: 'astralis', match_date: '2026-05-04', maps: [] }]
  assert(findCandidateVods(baseDemo, vods).length === 1, 'case-insensitive opponent match')
}
{
  // ±1 day
  const vods = [
    { id: 'v1', opponent: 'Astralis', match_date: '2026-05-03', maps: [] },
    { id: 'v2', opponent: 'Astralis', match_date: '2026-05-05', maps: [] },
  ]
  assert(findCandidateVods(baseDemo, vods).length === 2, '±1 day in either direction matches')
}
{
  // ±2 days = excluded
  const vods = [{ id: 'v1', opponent: 'Astralis', match_date: '2026-05-02', maps: [] }]
  assert(findCandidateVods(baseDemo, vods).length === 0, '±2 days rejected')
}
{
  // Different opponent
  const vods = [{ id: 'v1', opponent: 'Vitality', match_date: '2026-05-04', maps: [] }]
  assert(findCandidateVods(baseDemo, vods).length === 0, 'unrelated opponent rejected')
}
{
  // Demo opponent matches ct side
  const demo = { ...baseDemo, ct_team_name: 'Astralis', t_team_name: 'NaVi' }
  const vods = [{ id: 'v1', opponent: 'astralis', match_date: '2026-05-04', maps: [] }]
  assert(findCandidateVods(demo, vods).length === 1, 'either ct or t side name matches')
}
{
  // Demo with no team names at all
  const demo = { played_at: '2026-05-04T18:00:00' }
  const vods = [{ id: 'v1', opponent: 'Astralis', match_date: '2026-05-04', maps: [] }]
  assert(findCandidateVods(demo, vods).length === 0, 'no team names → no candidates')
}
{
  // Vod with no opponent
  const vods = [{ id: 'v1', opponent: null, match_date: '2026-05-04', maps: [] }]
  assert(findCandidateVods(baseDemo, vods).length === 0, 'vod without opponent excluded')
}

console.log('Task 1 tests done')
</script>
</body>
</html>
```

- [ ] **Step 3: Run tests via Node**

```bash
cd cs2-hub && node --input-type=module < <(awk '/<script type="module">/,/<\/script>/' auto-fill-vod.test.html | sed '1d;$d')
```

Expected: all PASS lines, then "Task 1 tests done". No FAIL.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/auto-fill-vod.js cs2-hub/auto-fill-vod.test.html
git commit -m "feat(vods): pure auto-fill helpers + findCandidateVods

normName, demoLocalDate, and findCandidateVods are the entry points for
linking demos to vods on opponent + ±1 day. Tests cover the matching
window, case sensitivity, missing fields, and demo/vod side flips."
```

---

### Task 2: `pickBestVod` + tests

**Files:**
- Modify: `cs2-hub/auto-fill-vod.js`
- Modify: `cs2-hub/auto-fill-vod.test.html`

- [ ] **Step 1: Add `pickBestVod` to `cs2-hub/auto-fill-vod.js`**

Append after `findCandidateVods`:

```js
// True when no slot in vod.maps[] has scores. We prefer these vods because
// they are usually fresh pracc stubs ready to be filled in.
function isUnscored(vod) {
  if (!vod.maps || vod.maps.length === 0) return true
  return vod.maps.every(s => s.score_us == null && s.score_them == null)
}

// Pick the single best vod from candidates. Sort by:
// 1. unscored (empty/all-empty maps) first — fresh stubs > already-filled
// 2. closer to the demo's date — same-day before ±1
// 3. earlier created_at — deterministic tiebreak
// Returns null on empty.
export function pickBestVod(candidates, demo) {
  if (!candidates?.length) return null
  const demoDate = demoLocalDate(demo)
  const sorted = [...candidates].sort((a, b) => {
    const au = isUnscored(a) ? 0 : 1
    const bu = isUnscored(b) ? 0 : 1
    if (au !== bu) return au - bu
    const ad = daysApart(a.match_date, demoDate)
    const bd = daysApart(b.match_date, demoDate)
    if (ad !== bd) return ad - bd
    return (a.created_at || '').localeCompare(b.created_at || '')
  })
  return sorted[0]
}
```

Note: `daysApart` is already defined in the module from Task 1 (private to module).

- [ ] **Step 2: Append tests to `cs2-hub/auto-fill-vod.test.html`**

Add these tests before the final `console.log('Task 1 tests done')` line, and update the import line:

Change:
```js
import {
  normName,
  demoLocalDate,
  findCandidateVods,
} from './auto-fill-vod.js'
```

To:
```js
import {
  normName,
  demoLocalDate,
  findCandidateVods,
  pickBestVod,
} from './auto-fill-vod.js'
```

Then append before the final `console.log`:

```js
// ---- pickBestVod ----
{
  assert(pickBestVod([], baseDemo) === null, 'pickBestVod: empty → null')
}
{
  const vods = [{ id: 'v1', opponent: 'Astralis', match_date: '2026-05-04', maps: [], created_at: '2026-05-04T10:00:00' }]
  assert(pickBestVod(vods, baseDemo).id === 'v1', 'single candidate returned')
}
{
  // empty maps wins over filled
  const vods = [
    { id: 'filled', opponent: 'Astralis', match_date: '2026-05-04', maps: [{ map: 'mirage', score_us: 13, score_them: 7 }], created_at: '2026-05-04T09:00:00' },
    { id: 'empty',  opponent: 'Astralis', match_date: '2026-05-04', maps: [], created_at: '2026-05-04T10:00:00' },
  ]
  assert(pickBestVod(vods, baseDemo).id === 'empty', 'empty-maps vod wins')
}
{
  // all-empty-scores wins over filled
  const vods = [
    { id: 'filled',   opponent: 'Astralis', match_date: '2026-05-04', maps: [{ map: 'mirage', score_us: 13, score_them: 7 }] },
    { id: 'unscored', opponent: 'Astralis', match_date: '2026-05-04', maps: [{ map: 'inferno' }] },
  ]
  assert(pickBestVod(vods, baseDemo).id === 'unscored', 'maps-without-scores treated as unscored')
}
{
  // both unscored: closer date wins
  const vods = [
    { id: 'far',   opponent: 'Astralis', match_date: '2026-05-05', maps: [] },
    { id: 'close', opponent: 'Astralis', match_date: '2026-05-04', maps: [] },
  ]
  assert(pickBestVod(vods, baseDemo).id === 'close', 'closer date wins among unscored')
}
{
  // both unscored, same date: earlier created_at wins
  const vods = [
    { id: 'late',  opponent: 'Astralis', match_date: '2026-05-04', maps: [], created_at: '2026-05-04T15:00:00' },
    { id: 'early', opponent: 'Astralis', match_date: '2026-05-04', maps: [], created_at: '2026-05-04T08:00:00' },
  ]
  assert(pickBestVod(vods, baseDemo).id === 'early', 'earlier created_at tiebreak')
}
```

- [ ] **Step 3: Run tests**

```bash
cd cs2-hub && node --input-type=module < <(awk '/<script type="module">/,/<\/script>/' auto-fill-vod.test.html | sed '1d;$d')
```

Expected: all PASS, no FAIL.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/auto-fill-vod.js cs2-hub/auto-fill-vod.test.html
git commit -m "feat(vods): pickBestVod ranks unscored before filled

Fresh pracc stubs (empty maps or all-empty-scores) win over already-filled
vods. Closer date breaks the next tie; created_at is the deterministic
final tiebreak."
```

---

### Task 3: `scoresFromDemo` + tests

**Files:**
- Modify: `cs2-hub/auto-fill-vod.js`
- Modify: `cs2-hub/auto-fill-vod.test.html`

- [ ] **Step 1: Add `scoresFromDemo` to `cs2-hub/auto-fill-vod.js`**

Append:

```js
// Map team_a_score / team_b_score to score_us / score_them given who the
// opponent is. Requires team_a_first_side to know which team the team_a_*
// totals belong to (the team that started on that side becomes that side's
// "team_a" in the parser's accounting).
//
// Returns null if any required field is missing or the opponent name doesn't
// match either team — those demos can't be auto-filled.
export function scoresFromDemo(demo, opponentName) {
  const a = demo.team_a_score
  const b = demo.team_b_score
  const fs = demo.team_a_first_side
  if (a == null || b == null || !fs) return null
  if (fs !== 'ct' && fs !== 't') return null

  const teamAName = fs === 'ct' ? demo.ct_team_name : demo.t_team_name
  const teamBName = fs === 'ct' ? demo.t_team_name  : demo.ct_team_name
  const opp = normName(opponentName)
  if (normName(teamAName) === opp) return { score_us: b, score_them: a }
  if (normName(teamBName) === opp) return { score_us: a, score_them: b }
  return null
}
```

- [ ] **Step 2: Append tests to `cs2-hub/auto-fill-vod.test.html`**

Update import to add `scoresFromDemo`. Append before final `console.log`:

```js
// ---- scoresFromDemo ----
{
  // team_a starts CT, opponent is on CT side (i.e. opponent IS team_a) → score_us = team_b_score
  const demo = {
    ct_team_name: 'Astralis', t_team_name: 'NaVi',
    team_a_first_side: 'ct', team_a_score: 13, team_b_score: 7,
  }
  const r = scoresFromDemo(demo, 'Astralis')
  assert(r.score_us === 7 && r.score_them === 13, 'team_a is opponent (CT start) → us = team_b')
}
{
  // team_a starts CT, opponent is on T side (opponent IS team_b) → score_us = team_a_score
  const demo = {
    ct_team_name: 'NaVi', t_team_name: 'Astralis',
    team_a_first_side: 'ct', team_a_score: 13, team_b_score: 7,
  }
  const r = scoresFromDemo(demo, 'Astralis')
  assert(r.score_us === 13 && r.score_them === 7, 'team_b is opponent (T start) → us = team_a')
}
{
  // team_a starts T, opponent is on T side (opponent IS team_a) → score_us = team_b_score
  const demo = {
    ct_team_name: 'NaVi', t_team_name: 'Astralis',
    team_a_first_side: 't', team_a_score: 11, team_b_score: 13,
  }
  const r = scoresFromDemo(demo, 'Astralis')
  assert(r.score_us === 13 && r.score_them === 11, 'team_a is opponent (T start) → us = team_b')
}
{
  // missing scores
  const demo = { ct_team_name: 'A', t_team_name: 'B', team_a_first_side: 'ct' }
  assert(scoresFromDemo(demo, 'A') === null, 'missing scores → null')
}
{
  // missing team_a_first_side
  const demo = { ct_team_name: 'A', t_team_name: 'B', team_a_score: 13, team_b_score: 7 }
  assert(scoresFromDemo(demo, 'A') === null, 'missing first_side → null')
}
{
  // opponent matches neither
  const demo = {
    ct_team_name: 'A', t_team_name: 'B',
    team_a_first_side: 'ct', team_a_score: 13, team_b_score: 7,
  }
  assert(scoresFromDemo(demo, 'C') === null, 'unknown opponent → null')
}
{
  // case-insensitive
  const demo = {
    ct_team_name: 'AsTrALiS', t_team_name: 'NaVi',
    team_a_first_side: 'ct', team_a_score: 13, team_b_score: 7,
  }
  const r = scoresFromDemo(demo, 'astralis')
  assert(r && r.score_us === 7, 'case-insensitive opponent comparison')
}
```

- [ ] **Step 3: Run tests**

Same command. Expected all PASS.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/auto-fill-vod.js cs2-hub/auto-fill-vod.test.html
git commit -m "feat(vods): scoresFromDemo derives us/them from team_a_first_side

Maps the demo's team_a_score/team_b_score totals to a {score_us, score_them}
pair given the opponent's name. Honors team_a_first_side so the totals
attach to the correct side. Skips demos missing any required field."
```

---

### Task 4: `computeVodPatch` + tests

**Files:**
- Modify: `cs2-hub/auto-fill-vod.js`
- Modify: `cs2-hub/auto-fill-vod.test.html`

- [ ] **Step 1: Add `computeVodPatch` to `cs2-hub/auto-fill-vod.js`**

Append:

```js
// Build a patch for `vod` from one or more demos (a series can apply
// multiple demos to the same vod). Returns null if no slot would be filled.
//
// Patch shape: { maps, result?, demo_link?, _filledMapNames }
// _filledMapNames is metadata for the caller (toast/log); strip before
// sending to Supabase.
//
// Rules:
//   - Match each demo to a slot by map name (case-insensitive). If no name
//     match, claim the first slot whose .map is empty. If no empty slot,
//     append a new slot.
//   - NEVER overwrite a slot that already has score_us or score_them.
//   - After applying all demos, if every slot in maps has both scores set,
//     derive `result` (win/loss/draw) from map-wins.
//   - For a single non-series demo: also set demo_link if vod has none.
export function computeVodPatch(demosArg, vod) {
  if (!vod) return null
  const demos = Array.isArray(demosArg) ? demosArg : [demosArg]
  if (!demos.length) return null

  const newMaps = (vod.maps ?? []).map(s => ({ ...s }))
  const filledMapNames = []
  let filledAny = false

  for (const demo of demos) {
    const scores = scoresFromDemo(demo, vod.opponent)
    if (!scores) continue
    const demoMap = (demo.map || '').toLowerCase()

    // (a) map-name match
    let slotIdx = demoMap
      ? newMaps.findIndex(s => (s.map || '').toLowerCase() === demoMap)
      : -1

    // (b) empty-name slot — claim it
    if (slotIdx === -1) {
      slotIdx = newMaps.findIndex(s => !s.map)
      if (slotIdx !== -1 && demo.map) newMaps[slotIdx].map = demo.map
    }

    // (c) append new slot
    if (slotIdx === -1) {
      newMaps.push({ map: demo.map })
      slotIdx = newMaps.length - 1
    }

    const slot = newMaps[slotIdx]
    if (slot.score_us != null || slot.score_them != null) continue   // never overwrite

    slot.score_us = scores.score_us
    slot.score_them = scores.score_them
    filledAny = true
    if (demo.map) filledMapNames.push(demo.map)
  }

  if (!filledAny) return null

  const patch = { maps: newMaps, _filledMapNames: filledMapNames }

  // Result: only if every slot has both scores.
  if (newMaps.every(s => s.score_us != null && s.score_them != null)) {
    let usWins = 0, themWins = 0
    for (const s of newMaps) {
      if (s.score_us > s.score_them) usWins++
      else if (s.score_us < s.score_them) themWins++
    }
    if (usWins > themWins) patch.result = 'win'
    else if (themWins > usWins) patch.result = 'loss'
    else patch.result = 'draw'
  }

  // Demo link: only for single non-series demos.
  if (demos.length === 1 && !demos[0].series_id && !vod.demo_link && demos[0].id) {
    patch.demo_link = `demo-viewer.html?id=${demos[0].id}`
  }

  return patch
}
```

- [ ] **Step 2: Append tests to `cs2-hub/auto-fill-vod.test.html`**

Update import to add `computeVodPatch`. Append before final `console.log`:

```js
// ---- computeVodPatch ----
function makeDemo(over = {}) {
  return {
    id: 'd1', map: 'mirage',
    ct_team_name: 'NaVi', t_team_name: 'Astralis',
    team_a_first_side: 'ct', team_a_score: 13, team_b_score: 7,
    series_id: null,
    ...over,
  }
}

{
  // Single demo, vod has empty stub for same map — fill it
  const vod = { id: 'v', opponent: 'NaVi', maps: [{ map: 'mirage' }] }
  const p = computeVodPatch(makeDemo(), vod)
  assert(p && p.maps[0].score_us === 7 && p.maps[0].score_them === 13, 'single demo fills matching map')
  assert(p.result === 'loss', 'single map all-filled derives result (us=7, them=13 → loss)')
  assert(p.demo_link === 'demo-viewer.html?id=d1', 'single non-series demo sets demo_link')
}
{
  // Vod with empty maps[] — append
  const vod = { id: 'v', opponent: 'NaVi', maps: [] }
  const p = computeVodPatch(makeDemo(), vod)
  assert(p.maps.length === 1 && p.maps[0].map === 'mirage', 'empty maps[] gets new slot')
  assert(p.maps[0].score_us === 7, 'score_us correct')
}
{
  // Slot already has scores — never overwrite
  const vod = { id: 'v', opponent: 'NaVi', maps: [{ map: 'mirage', score_us: 5, score_them: 13 }] }
  const p = computeVodPatch(makeDemo(), vod)
  assert(p === null, 'never overwrite → null patch')
}
{
  // Slot for different map: appended; result NOT derived (one slot still empty)
  const vod = { id: 'v', opponent: 'NaVi', maps: [{ map: 'inferno' }] }
  const p = computeVodPatch(makeDemo({ map: 'mirage' }), vod)
  assert(p.maps.length === 2, 'mismatched-map demo appends new slot')
  assert(p.maps[1].map === 'mirage' && p.maps[1].score_us === 7, 'new slot scored')
  assert(!p.result, 'result not derived while a slot is still empty')
}
{
  // Empty-named slot is claimed (gets map name + scores)
  const vod = { id: 'v', opponent: 'NaVi', maps: [{}] }
  const p = computeVodPatch(makeDemo(), vod)
  assert(p.maps[0].map === 'mirage', 'empty-named slot gets the demo map name')
  assert(p.maps[0].score_us === 7, 'empty-named slot gets the score')
}
{
  // Series of 3 demos, vod has 3 empty stubs — all fill, result derived
  const vod = { id: 'v', opponent: 'NaVi', maps: [{ map: 'mirage' }, { map: 'inferno' }, { map: 'nuke' }] }
  const demos = [
    makeDemo({ id: 'd1', map: 'mirage',  series_id: 's1', team_a_score: 13, team_b_score: 7 }),
    makeDemo({ id: 'd2', map: 'inferno', series_id: 's1', team_a_score: 5,  team_b_score: 13 }),
    makeDemo({ id: 'd3', map: 'nuke',    series_id: 's1', team_a_score: 13, team_b_score: 11 }),
  ]
  const p = computeVodPatch(demos, vod)
  // Demo's "us" is whichever team is NOT the opponent. opponent='NaVi' = ct_team_name = team_a's
  // team since first_side='ct'. So us = team_b.
  // d1: us=7 them=13 → loss; d2: us=13 them=5 → win; d3: us=11 them=13 → loss. usWins=1 themWins=2 → loss.
  assert(p.result === 'loss', 'series 1-2 → loss')
  assert(!p.demo_link, 'series does not set demo_link')
}
{
  // Series, vod with 2 already-filled slots, third empty
  const vod = { id: 'v', opponent: 'NaVi', maps: [
    { map: 'mirage',  score_us: 13, score_them: 7 },
    { map: 'inferno', score_us: 5,  score_them: 13 },
    { map: 'nuke' },
  ] }
  const demos = [
    makeDemo({ id: 'd1', map: 'mirage',  series_id: 's1' }),  // would fill but skipped (already scored)
    makeDemo({ id: 'd3', map: 'nuke',    series_id: 's1', team_a_score: 13, team_b_score: 11 }),
  ]
  const p = computeVodPatch(demos, vod)
  // Original mirage 13-7 preserved (not overwritten); inferno 5-13 preserved; nuke filled with us=11 them=13.
  assert(p.maps[0].score_us === 13, 'pre-existing mirage score preserved')
  assert(p.maps[2].score_us === 11, 'nuke filled')
  assert(p.result === 'loss', 'series 1-2 (us wins one, opponent wins two) → loss')
}
{
  // Series of 3 demos, vod has 4 empty slots — 3 filled, 1 still empty, no result
  const vod = { id: 'v', opponent: 'NaVi', maps: [
    { map: 'mirage' }, { map: 'inferno' }, { map: 'nuke' }, { map: 'ancient' },
  ] }
  const demos = [
    makeDemo({ id: 'd1', map: 'mirage',  series_id: 's1' }),
    makeDemo({ id: 'd2', map: 'inferno', series_id: 's1' }),
    makeDemo({ id: 'd3', map: 'nuke',    series_id: 's1' }),
  ]
  const p = computeVodPatch(demos, vod)
  assert(p.maps[3].score_us == null, 'fourth slot remains empty')
  assert(!p.result, 'result not derived when a slot remains empty')
}
{
  // Series where only 1 demo has valid scores
  const vod = { id: 'v', opponent: 'NaVi', maps: [{ map: 'mirage' }, { map: 'inferno' }] }
  const demos = [
    makeDemo({ id: 'd1', map: 'mirage', series_id: 's1' }),
    makeDemo({ id: 'd2', map: 'inferno', series_id: 's1', team_a_first_side: null }),  // skipped
  ]
  const p = computeVodPatch(demos, vod)
  assert(p.maps[0].score_us === 7, 'first slot filled')
  assert(p.maps[1].score_us == null, 'second slot still empty (skipped demo)')
  assert(!p.result, 'result not derived')
}
{
  // No matching demo (opponent doesn't appear) → null
  const vod = { id: 'v', opponent: 'Vitality', maps: [{ map: 'mirage' }] }
  const p = computeVodPatch(makeDemo(), vod)
  assert(p === null, 'no opponent match → null')
}
{
  // demo_link skipped if vod already has one
  const vod = { id: 'v', opponent: 'NaVi', maps: [{ map: 'mirage' }], demo_link: 'demo-viewer.html?id=existing' }
  const p = computeVodPatch(makeDemo(), vod)
  assert(p.demo_link === undefined, 'existing demo_link not overwritten')
}
```

- [ ] **Step 3: Run tests**

```bash
cd cs2-hub && node --input-type=module < <(awk '/<script type="module">/,/<\/script>/' auto-fill-vod.test.html | sed '1d;$d')
```

Expected: all PASS, no FAIL.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/auto-fill-vod.js cs2-hub/auto-fill-vod.test.html
git commit -m "feat(vods): computeVodPatch builds the auto-fill patch

Single demo or series → one patch per vod. Map-name slot match falls
back to claiming an empty-named stub, then to appending. Never
overwrites existing scores. Result is derived only when every slot has
both scores. demo_link set only for single non-series uploads."
```

---

### Task 5: Trigger A — wire into assign-teams modal save

**Files:**
- Modify: `cs2-hub/assign-teams-modal.js`

- [ ] **Step 1: Read the existing save handler in `cs2-hub/assign-teams-modal.js`**

Look around lines 100-130 — the part where the modal `await supabase.from('demos').update(...)` for each demo, then calls `opts.onSave?.()`. We'll insert the auto-fill between the successful update and the resolve.

- [ ] **Step 2: Add imports at the top of `cs2-hub/assign-teams-modal.js`**

```js
import {
  findCandidateVods,
  pickBestVod,
  computeVodPatch,
  demoLocalDate,
} from './auto-fill-vod.js'
```

- [ ] **Step 3: Add a tiny toast helper at the top of the file (after `esc()`)**

```js
// Lightweight one-shot toast. Appended to <body>, fades out after 4s.
// Inline to keep this module self-contained — promote to a util later if a
// third caller appears.
function showToast(msg) {
  const el = document.createElement('div')
  el.textContent = msg
  el.style.cssText = [
    'position:fixed', 'right:24px', 'bottom:24px', 'z-index:99999',
    'background:#2b2b2b', 'color:#fff', 'padding:12px 16px',
    'border-radius:6px', 'font-family:sans-serif', 'font-size:14px',
    'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
    'opacity:0', 'transition:opacity 200ms ease-out',
    'max-width:360px',
  ].join(';')
  document.body.appendChild(el)
  requestAnimationFrame(() => { el.style.opacity = '1' })
  setTimeout(() => {
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 250)
  }, 4000)
}
```

- [ ] **Step 4: Add the auto-fill helper function (place before the `showAssignTeamsModal` export)**

```js
// After demo names are saved, look for matching vods and fill in scores.
// Idempotent + best-effort: any DB error is logged and swallowed so it never
// breaks the modal save.
//
// `savedDemos` is the full set of demos whose names were just persisted (the
// `demos` array inside showAssignTeamsModal — names already attached).
async function tryAutoFillVods(savedDemos, teamId) {
  if (!savedDemos?.length || !teamId) return
  try {
    // Fetch candidate vods in a single query covering the demos' date window.
    const dates = savedDemos.map(demoLocalDate).filter(Boolean).sort()
    if (!dates.length) return
    const minDate = dates[0]
    const maxDate = dates[dates.length - 1]
    // Widen by one day on each side to cover the ±1 window.
    const widen = (d, delta) => {
      const dt = new Date(`${d}T00:00:00`)
      dt.setDate(dt.getDate() + delta)
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    }
    const { data: vods, error } = await supabase
      .from('vods')
      .select('id, opponent, match_date, maps, result, demo_link, created_at')
      .eq('team_id', teamId)
      .gte('match_date', widen(minDate, -1))
      .lte('match_date', widen(maxDate, 1))
    if (error) { console.warn('[auto-fill] vod fetch failed:', error.message); return }
    if (!vods?.length) return

    // Pair each demo with its best vod. Group by chosen vod so a series
    // (or two demos pointing at the same vod) becomes one update.
    const groups = new Map()  // vodId → { vod, demos: [] }
    for (const demo of savedDemos) {
      const cands = findCandidateVods(demo, vods)
      const chosen = pickBestVod(cands, demo)
      if (!chosen) continue
      let g = groups.get(chosen.id)
      if (!g) { g = { vod: chosen, demos: [] }; groups.set(chosen.id, g) }
      g.demos.push(demo)
    }

    const filledLines = []
    for (const { vod, demos } of groups.values()) {
      const patch = computeVodPatch(demos, vod)
      if (!patch) continue
      const { _filledMapNames, ...dbPatch } = patch
      const { error: upErr } = await supabase.from('vods').update(dbPatch).eq('id', vod.id)
      if (upErr) { console.warn('[auto-fill] vod update failed:', upErr.message); continue }
      filledLines.push(`${vod.opponent} (${_filledMapNames.join(', ')})`)
    }

    if (filledLines.length) {
      showToast(`Linked match: ${filledLines.join('; ')}`)
    }
  } catch (e) {
    console.warn('[auto-fill] unexpected error:', e)
  }
}
```

- [ ] **Step 5: Find the existing save success path and call `tryAutoFillVods`**

In the existing `showAssignTeamsModal` save handler (it does `await supabase.from('demos').update(...)` per demo, then `opts.onSave?.()`, then `resolve(...)`), insert the auto-fill call AFTER the demo updates succeed and BEFORE `opts.onSave?.()` so the user sees the toast even before the list refresh. Pass the demos array (with names attached locally so `findCandidateVods` works).

Specifically: in the click handler for the Save button, after the loop that updates each demo's `ct_team_name`/`t_team_name`/`team_a_first_side`, add:

```js
// Attach the just-saved names to the in-memory demo objects so the
// auto-fill helper can read them (the modal doesn't re-fetch).
for (const d of demos) {
  d.ct_team_name = ctName
  d.t_team_name  = tName
}
const teamId = demos[0]?.team_id
await tryAutoFillVods(demos, teamId)
```

If the existing handler doesn't have the team_id available, fetch it once via `getTeamId` from `supabase.js` (already imported pattern in `demos.js`). If `team_id` is on the demo row itself (it is — see `cs2-hub/supabase-demos.sql`), use that. Read the existing modal code to confirm the variable names before editing.

Same change in `showLegacyBySideModal`'s save handler — its in-memory shape uses `ct_team_name` / `t_team_name` per demo too.

- [ ] **Step 6: Syntax-check + manual smoke**

```bash
cd /c/Users/A/Documents/claude && node --input-type=module --check < cs2-hub/assign-teams-modal.js
```

Expected: silent (exit 0).

- [ ] **Step 7: Commit**

```bash
git add cs2-hub/assign-teams-modal.js
git commit -m "feat(vods): auto-fill matching vods from assign-teams modal save

After persisting team names, look up candidate vods (same opponent,
±1 day) and patch their scores from the demo. Per-series demos are
grouped so one vod gets one update. A small inline toast surfaces
which match was linked. Errors are caught and never block save."
```

---

### Task 6: Trigger B — wire into pracc sync after insert

**Files:**
- Modify: `cs2-hub/schedule.js`

- [ ] **Step 1: Read the existing pracc-sync IIFE in `cs2-hub/schedule.js`**

The relevant block is around lines 67-88. We need:
1. The `insert(newPayloads)` to also `.select()` so we get the inserted ids back.
2. After backfill, scan demos in the inserted vods' date window and patch each new vod.

- [ ] **Step 2: Add imports at the top of `cs2-hub/schedule.js`**

```js
import {
  findCandidateVods,
  pickBestVod,
  computeVodPatch,
} from './auto-fill-vod.js'
```

- [ ] **Step 3: Modify the IIFE — capture inserted ids, then run auto-fill**

Replace:

```js
const newPayloads = computePraccVodsToInsert(praccEvents, existingUids, teamId)
if (newPayloads.length) {
  await supabase.from('vods').insert(newPayloads)
}
```

With:

```js
const newPayloads = computePraccVodsToInsert(praccEvents, existingUids, teamId)
let insertedVods = []
if (newPayloads.length) {
  const { data: inserted } = await supabase
    .from('vods')
    .insert(newPayloads)
    .select('id, opponent, match_date, maps, result, demo_link, created_at')
  insertedVods = inserted ?? []
}
```

Then, after the existing backfill loop, append:

```js
// Auto-link: if any of the just-inserted vods has a matching uploaded demo
// (same opponent, ±1 day, named), patch the vod's scores. Silent on
// failure — this is opportunistic.
if (insertedVods.length) {
  try {
    const dates = insertedVods.map(v => v.match_date).sort()
    const widen = (d, delta) => {
      const dt = new Date(`${d}T00:00:00`)
      dt.setDate(dt.getDate() + delta)
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    }
    const { data: demos } = await supabase
      .from('demos')
      .select('id, series_id, ct_team_name, t_team_name, map, team_a_score, team_b_score, team_a_first_side, played_at, created_at')
      .eq('team_id', teamId)
      .eq('status', 'ready')
      .not('ct_team_name', 'is', null)
      .gte('played_at', `${widen(dates[0], -1)}T00:00:00`)
      .lte('played_at', `${widen(dates[dates.length - 1], 1)}T23:59:59`)

    if (demos?.length) {
      // For each vod, find demos that match. (Inverted: find candidates per
      // demo, group by vod.)
      const groups = new Map()  // vodId → { vod, demos: [] }
      for (const demo of demos) {
        const cands = findCandidateVods(demo, insertedVods)
        const chosen = pickBestVod(cands, demo)
        if (!chosen) continue
        let g = groups.get(chosen.id)
        if (!g) { g = { vod: chosen, demos: [] }; groups.set(chosen.id, g) }
        g.demos.push(demo)
      }
      for (const { vod, demos: ds } of groups.values()) {
        const patch = computeVodPatch(ds, vod)
        if (!patch) continue
        const { _filledMapNames, ...dbPatch } = patch
        await supabase.from('vods').update(dbPatch).eq('id', vod.id)
        console.log('[auto-fill] linked vod', vod.id, 'maps', _filledMapNames)
      }
    }
  } catch (e) {
    console.warn('[auto-fill] pracc-sync trigger failed:', e)
  }
}
```

- [ ] **Step 4: Syntax-check**

```bash
cd /c/Users/A/Documents/claude && node --input-type=module --check < cs2-hub/schedule.js
```

Expected: silent.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/schedule.js
git commit -m "feat(vods): auto-link demos to newly synced pracc vods

After pracc sync inserts new vods, scan ready+named demos in the same
date window and apply the same auto-fill logic the modal uses. Runs
silently in the background; errors are logged, never thrown."
```

---

### Task 7: Final verification + push

- [ ] **Step 1: Run all tests one final time**

```bash
cd /c/Users/A/Documents/claude/cs2-hub && \
  node --input-type=module < <(awk '/<script type="module">/,/<\/script>/' auto-fill-vod.test.html | sed '1d;$d') && \
  node --input-type=module < <(awk '/<script type="module">/,/<\/script>/' assign-teams.test.html | sed '1d;$d') && \
  echo "ALL TESTS DONE"
```

Expected: all PASS, no FAIL, ends with "ALL TESTS DONE".

- [ ] **Step 2: Module-mode syntax-check all touched files**

```bash
cd /c/Users/A/Documents/claude && for f in \
  cs2-hub/auto-fill-vod.js \
  cs2-hub/assign-teams-modal.js \
  cs2-hub/schedule.js \
; do node --input-type=module --check < "$f" && echo "OK: $f"; done
```

Expected: `OK:` for each.

- [ ] **Step 3: Final commit if anything trailing, then push**

```bash
git status -sb
git push origin master
```

Expected: master is pushed to origin/master, status shows tree clean for tracked files.

---

## Out of scope

- Retroactive bulk auto-fill of historical demos and vods. Triggers fire only on new events.
- A "linked vod" link from the demo viewer back to the vod row. The reverse direction (vod → demo) is set via `demo_link`; vod-from-demo can be a follow-up.
- Toast component library; the inline toast is intentionally minimal.
- Fuzzy or token-based opponent matching. Case-insensitive + trimmed only.
