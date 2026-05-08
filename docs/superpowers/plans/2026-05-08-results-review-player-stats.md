# Results & Review — Player Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-player career stats view to the Results & Review page (`cs2-hub/vods.html`) — a roster band that opens a side drawer with comprehensive player stats, plus a shared filter (time window + tournaments-only) that drives both team and per-player views.

**Architecture:** All player stats already exist in `demo_players` (parsed at demo upload time on the VPS). This work is read-side only: a new `steam_id` column on `roster` links roster rows to `demo_players.steam_id`; a pure aggregation module rolls those rows up; new UI modules render the band, drawer, and filter and wire into a slimmed `vods.js` orchestrator.

**Tech Stack:** Vanilla ES modules (no framework), Supabase JS client, browser-loaded `*.test.html` files for unit tests, CSS variables for theming. The repo's pattern is `import { thing } from './file.js'` from sibling modules; tests live as standalone HTML pages that print `PASS`/`FAIL` via `console.log`.

**Spec:** `docs/superpowers/specs/2026-05-08-results-review-player-stats.md`

---

## File map

```
cs2-hub/
  supabase-roster-steamid-migration.sql  (new)  — schema migration
  roster.html                             (mod)  — Steam ID input field markup
  roster.js                               (mod)  — Steam ID save logic, suggester button
  roster-steam-backfill.js                (new)  — pure suggester logic
  roster-steam-backfill.test.html         (new)  — suggester tests
  demo-player-filters.js                  (new)  — shared isCoach + side helpers
  scoreboard.js                           (mod)  — use shared filter
  roster-stats-aggregate.js               (new)  — pure aggregation functions
  roster-stats-aggregate.test.html        (new)  — aggregation tests
  vods-filter.js                          (new)  — filter row component
  vods-filter.test.html                   (new)  — filter component tests
  vods-team-stats.js                      (new)  — extracted team stats renderer
  roster-stats.js                         (new)  — roster band renderer
  player-drawer.js                        (new)  — drawer component
  player-drawer.test.html                 (new)  — drawer lifecycle tests
  vods.html                               (mod)  — adds filter/roster slots
  vods.js                                 (mod)  — orchestrator only
  style.css                               (mod)  — band, card, drawer styles
```

---

### Task 1: Schema migration — add `steam_id` to roster

**Files:**
- Create: `cs2-hub/supabase-roster-steamid-migration.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- cs2-hub/supabase-roster-steamid-migration.sql
-- Idempotent: safe to re-run.

alter table roster add column if not exists steam_id text;
create index if not exists roster_steam_id_idx on roster (team_id, steam_id);
```

- [ ] **Step 2: Run the migration in Supabase SQL editor**

Paste the file contents into the SQL editor and run. Verify with:

```sql
select column_name from information_schema.columns
  where table_name='roster' and column_name='steam_id';
-- Expected: one row, "steam_id"
```

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/supabase-roster-steamid-migration.sql
git commit -m "feat(roster): add steam_id column for stat linkage"
```

---

### Task 2: Add Steam ID input to roster modal (markup)

**Files:**
- Modify: `cs2-hub/roster.html` (form-group block inside the modal)

- [ ] **Step 1: Add the Steam ID form group below the Role select**

Find this block in `roster.html`:

```html
        <div class="form-group">
          <label class="form-label">Role</label>
          <select class="form-select" id="f-role">
            ...
          </select>
        </div>
        <div class="error-msg" id="modal-error" style="display:none"></div>
```

Insert a new form-group between the Role select and the error-msg div:

```html
        <div class="form-group">
          <label class="form-label">Steam ID <span style="color:var(--muted);font-weight:400">(optional — enables stat tracking)</span></label>
          <div style="display:flex;gap:8px">
            <input class="form-input" id="f-steam-id" placeholder="76561198…" autocomplete="off" style="flex:1"/>
            <button type="button" class="btn btn-ghost btn-sm" id="suggest-steam-btn">Suggest</button>
          </div>
          <div id="suggest-results" style="display:none;margin-top:6px"></div>
          <div id="steam-warning" style="display:none;margin-top:6px;font-size:12px;color:var(--warning)"></div>
        </div>
```

- [ ] **Step 2: Verify the page still loads**

Open `cs2-hub/roster.html` in the browser, click "+ Add Player" — the new Steam ID row should appear, but the Suggest button does nothing yet.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/roster.html
git commit -m "feat(roster): add Steam ID input markup to player modal"
```

---

### Task 3: Wire Steam ID save in `roster.js`

**Files:**
- Modify: `cs2-hub/roster.js`

- [ ] **Step 1: Read the current value into the modal on open**

Find the `openModal` function. Add the Steam ID line right after the Role line:

```js
function openModal(id = null) {
  editingId = id
  const p = id ? allPlayers.find(x => x.id === id) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Player' : 'Add Player'
  document.getElementById('f-username').value = p?.username ?? ''
  document.getElementById('f-nickname').value = p?.nickname ?? ''
  document.getElementById('f-role').value     = p?.role     ?? ''
  document.getElementById('f-steam-id').value = p?.steam_id ?? ''
  document.getElementById('suggest-results').style.display = 'none'
  document.getElementById('steam-warning').style.display = 'none'
  document.getElementById('delete-player-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  updateAvatarPreview(p?.nickname || p?.username || '')
  document.getElementById('modal').style.display = 'flex'
}
```

- [ ] **Step 2: Validate + save the Steam ID**

Find the save click handler (around line 92). Replace the body with:

```js
document.getElementById('save-player-btn').addEventListener('click', async () => {
  const username = document.getElementById('f-username').value.trim()
  const nickname = document.getElementById('f-nickname').value.trim() || null
  const role     = document.getElementById('f-role').value || null
  const steamRaw = document.getElementById('f-steam-id').value.trim()
  const steam_id = steamRaw === '' ? null : steamRaw
  const errEl    = document.getElementById('modal-error')
  if (!username) { errEl.textContent = 'Display name is required.'; errEl.style.display = 'block'; return }
  if (steam_id && !/^7656119\d{10}$/.test(steam_id)) {
    errEl.textContent = 'Steam ID must be a 17-digit Steam64 starting with 7656119.'
    errEl.style.display = 'block'; return
  }

  const payload = { username, nickname, role, steam_id, team_id: getTeamId() }
  let error
  if (editingId) {
    ;({ error } = await supabase.from('roster').update(payload).eq('id', editingId))
  } else {
    ;({ error } = await supabase.from('roster').insert(payload))
  }
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  const wasEditing = !!editingId
  closeModal(); toast(wasEditing ? 'Player updated' : 'Player added'); loadRoster()
})
```

- [ ] **Step 3: Manual test**

In the browser: open the Roster page, edit a player, type a malformed Steam ID, click Save → see the validation error. Type a valid 17-digit ID starting with `7656119` → save succeeds. Reopen the same player → field reflects the saved value.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/roster.js
git commit -m "feat(roster): persist Steam ID with validation"
```

---

### Task 4: Backfill suggester — pure logic + tests (TDD)

**Files:**
- Create: `cs2-hub/roster-steam-backfill.js`
- Create: `cs2-hub/roster-steam-backfill.test.html`

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/roster-steam-backfill.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<script type="module">
import { rankCandidates } from './roster-steam-backfill.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}

const nickname = 'fl0m'
const assignedSteamIds = new Set(['76561198000000001', '76561198000000002'])

// Empty input
assert(rankCandidates([], nickname, assignedSteamIds).length === 0, 'empty demos → []')

// Filter: only rows whose name matches nickname (case-insensitive contains)
{
  const rows = [
    { steam_id: '76561198000000010', name: 'fl0m' },
    { steam_id: '76561198000000011', name: 'fl0m'  },
    { steam_id: '76561198000000012', name: 'k0nfig' },
  ]
  const out = rankCandidates(rows, nickname, new Set())
  assert(out.length === 2, 'matches nickname only')
  assert(out[0].steam_id === '76561198000000010', 'first candidate is most-frequent steam_id')
  assert(out[0].count === 1, 'count is 1 for unique appearance')
}

// Frequency ranking
{
  const rows = [
    { steam_id: 'A', name: 'fl0m' },
    { steam_id: 'A', name: 'fl0m' },
    { steam_id: 'A', name: 'fl0m' },
    { steam_id: 'B', name: 'fl0m' },
  ]
  const out = rankCandidates(rows, 'fl0m', new Set())
  assert(out[0].steam_id === 'A' && out[0].count === 3, 'A ranks first with count 3')
  assert(out[1].steam_id === 'B' && out[1].count === 1, 'B ranks second with count 1')
}

// Already-assigned steam_ids excluded
{
  const rows = [
    { steam_id: '76561198000000001', name: 'fl0m' },  // assigned
    { steam_id: '76561198000000099', name: 'fl0m' },
  ]
  const out = rankCandidates(rows, 'fl0m', assignedSteamIds)
  assert(out.length === 1, 'assigned steam_id excluded')
  assert(out[0].steam_id === '76561198000000099', 'remaining candidate returned')
}

// Case-insensitive nickname match
{
  const rows = [{ steam_id: 'X', name: 'FL0M' }]
  const out = rankCandidates(rows, 'fl0m', new Set())
  assert(out.length === 1, 'case-insensitive match')
}

// Substring match (e.g., "MIDROUND fl0m")
{
  const rows = [{ steam_id: 'X', name: 'MIDROUND fl0m' }]
  const out = rankCandidates(rows, 'fl0m', new Set())
  assert(out.length === 1, 'substring match works')
}

// Null/empty name rows are dropped
{
  const rows = [
    { steam_id: 'X', name: null },
    { steam_id: 'Y', name: '' },
    { steam_id: 'Z', name: 'fl0m' },
  ]
  const out = rankCandidates(rows, 'fl0m', new Set())
  assert(out.length === 1 && out[0].steam_id === 'Z', 'null/empty names dropped')
}
</script>
</body>
</html>
```

- [ ] **Step 2: Run the test (it should fail with import error)**

Open `cs2-hub/roster-steam-backfill.test.html` in the browser, open DevTools console.
Expected: error like `Failed to resolve module specifier './roster-steam-backfill.js'`.

- [ ] **Step 3: Implement the suggester**

Create `cs2-hub/roster-steam-backfill.js`:

```js
// cs2-hub/roster-steam-backfill.js
//
// Pure helpers for suggesting Steam IDs to attach to roster rows.
// Input: demo_players rows from recent demos. Output: ranked candidates.

// Rank steam_ids whose appearance name contains the given nickname.
// Excludes steam_ids already assigned to other roster rows.
// Returns [{ steam_id, name, count }, ...] sorted by count desc.
export function rankCandidates(rows, nickname, assignedSteamIds) {
  if (!rows?.length || !nickname) return []
  const target = String(nickname).toLowerCase()
  const counts = new Map() // steam_id → { name, count }

  for (const r of rows) {
    if (!r?.steam_id || !r.name) continue
    if (assignedSteamIds && assignedSteamIds.has(r.steam_id)) continue
    if (!String(r.name).toLowerCase().includes(target)) continue
    const cur = counts.get(r.steam_id)
    if (cur) cur.count++
    else counts.set(r.steam_id, { steam_id: r.steam_id, name: r.name, count: 1 })
  }

  return [...counts.values()].sort((a, b) => b.count - a.count)
}
```

- [ ] **Step 4: Re-open the test page; all PASS**

Open `cs2-hub/roster-steam-backfill.test.html`. Console shows 8 PASS lines and zero FAIL.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/roster-steam-backfill.js cs2-hub/roster-steam-backfill.test.html
git commit -m "feat(roster): add Steam ID candidate suggester (pure logic + tests)"
```

---

### Task 5: Wire suggester into roster modal

**Files:**
- Modify: `cs2-hub/roster.js`

- [ ] **Step 1: Import the suggester at the top of `roster.js`**

```js
import { rankCandidates } from './roster-steam-backfill.js'
```

- [ ] **Step 2: Add the click handler for the Suggest button**

Append at the bottom of `roster.js`, just before `loadRoster()`:

```js
function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML
}

document.getElementById('suggest-steam-btn').addEventListener('click', async () => {
  const nickname = document.getElementById('f-nickname').value.trim()
  const resultsEl = document.getElementById('suggest-results')
  if (!nickname) {
    resultsEl.style.display = 'block'
    resultsEl.innerHTML = `<div style="font-size:12px;color:var(--muted)">Enter a nickname above first.</div>`
    return
  }

  // Fetch recent demos for this team and their players
  const teamId = getTeamId()
  const { data: demos, error: derr } = await supabase
    .from('demos')
    .select('id')
    .eq('team_id', teamId)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(30)
  if (derr) {
    resultsEl.style.display = 'block'
    resultsEl.innerHTML = `<div style="font-size:12px;color:var(--danger)">Failed to load demos: ${escapeHtml(derr.message)}</div>`
    return
  }
  const demoIds = (demos ?? []).map(d => d.id)
  if (!demoIds.length) {
    resultsEl.style.display = 'block'
    resultsEl.innerHTML = `<div style="font-size:12px;color:var(--muted)">No demos uploaded yet.</div>`
    return
  }

  const { data: rows, error: perr } = await supabase
    .from('demo_players')
    .select('steam_id,name')
    .in('demo_id', demoIds)
    .eq('side', 'all')
  if (perr) {
    resultsEl.style.display = 'block'
    resultsEl.innerHTML = `<div style="font-size:12px;color:var(--danger)">Failed to load players: ${escapeHtml(perr.message)}</div>`
    return
  }

  // Exclude steam_ids already assigned to other roster rows (not this one)
  const assigned = new Set(
    allPlayers
      .filter(p => p.steam_id && p.id !== editingId)
      .map(p => p.steam_id)
  )
  const candidates = rankCandidates(rows ?? [], nickname, assigned).slice(0, 5)

  if (!candidates.length) {
    resultsEl.style.display = 'block'
    resultsEl.innerHTML = `<div style="font-size:12px;color:var(--muted)">No matches in last 30 demos.</div>`
    return
  }

  resultsEl.style.display = 'block'
  resultsEl.innerHTML = candidates.map(c => `
    <button type="button" class="btn btn-ghost btn-sm" data-pick="${escapeHtml(c.steam_id)}"
            style="display:flex;justify-content:space-between;width:100%;margin-bottom:4px;text-align:left">
      <span>${escapeHtml(c.name)} <span style="color:var(--muted)">·</span> <code style="font-family:monospace;font-size:11px">${escapeHtml(c.steam_id)}</code></span>
      <span style="color:var(--muted);font-size:11px">${c.count} demo${c.count === 1 ? '' : 's'}</span>
    </button>
  `).join('')

  resultsEl.querySelectorAll('[data-pick]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('f-steam-id').value = btn.dataset.pick
      resultsEl.style.display = 'none'
    })
  })
})
```

- [ ] **Step 3: Add soft-warning logic for duplicate Steam IDs**

In `roster.js`, replace the save click handler (the one you wrote in Task 3) so it warns when the Steam ID is already attached elsewhere. Insert this block right before the `const payload = ...` line:

```js
  // Soft warning: same Steam ID assigned to another roster row?
  const dup = steam_id ? allPlayers.find(p => p.steam_id === steam_id && p.id !== editingId) : null
  const warnEl = document.getElementById('steam-warning')
  if (dup && !warnEl.dataset.confirmed) {
    warnEl.style.display = 'block'
    warnEl.textContent = `This Steam ID is already assigned to ${dup.username}. Click Save again to confirm.`
    warnEl.dataset.confirmed = '1'
    return
  }
  warnEl.style.display = 'none'
  delete warnEl.dataset.confirmed
```

- [ ] **Step 4: Manual test**

1. Open Roster, edit a player who has a known nickname matching one of your demos.
2. Click Suggest → see ranked candidates with counts.
3. Click a candidate → field populates, dropdown closes.
4. Save → success.
5. Edit a different player, paste the same Steam ID → see the soft warning. Click Save again → now saves (and a duplicate exists, which is intentionally allowed).

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/roster.js
git commit -m "feat(roster): wire Steam ID suggester + duplicate warning into modal"
```

---

### Task 6: Extract shared demo-player filters

**Files:**
- Create: `cs2-hub/demo-player-filters.js`
- Modify: `cs2-hub/scoreboard.js`

- [ ] **Step 1: Create the shared module**

Create `cs2-hub/demo-player-filters.js`:

```js
// cs2-hub/demo-player-filters.js
//
// Shared filters for demo_players rows. Used by the per-demo scoreboard
// and the cross-demo roster aggregation.

// Coach-slot players have names starting with "COACH" and sit at spawn
// dying every round. Defensive filter for demos parsed before the backend
// scrub was added.
export const isCoach = (name) => /^\s*COACH/i.test(String(name || ''))

// Drop coach rows from a list of demo_players.
export const stripCoaches = (rows) => (rows || []).filter(r => !isCoach(r.name))
```

- [ ] **Step 2: Migrate `scoreboard.js` to use the shared filter**

In `cs2-hub/scoreboard.js`, replace lines 11-13:

```js
// CS2 coach-slot players have names starting with "COACH" and sit at spawn
// dying every round. Defensive filter for demos parsed before the backend
// scrub was added.
const isCoach = (name) => /^\s*COACH/i.test(String(name || ''))
```

with an import at the top of the file (right after the existing `import { supabase } …`):

```js
import { isCoach } from './demo-player-filters.js'
```

- [ ] **Step 3: Manual test**

Open the demo viewer in the browser, switch to the Scoreboard overlay → it should still load and look identical. No COACH rows.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/demo-player-filters.js cs2-hub/scoreboard.js
git commit -m "refactor(scoreboard): extract isCoach filter to shared module"
```

---

### Task 7: Aggregation logic — pure functions + tests (TDD)

**Files:**
- Create: `cs2-hub/roster-stats-aggregate.js`
- Create: `cs2-hub/roster-stats-aggregate.test.html`

- [ ] **Step 1: Write the failing tests**

Create `cs2-hub/roster-stats-aggregate.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<script type="module">
import {
  aggregatePlayer,
  aggregateByPlayer,
  aggregateByMap,
  applyTimeWindow,
  cutoffDateFor,
} from './roster-stats-aggregate.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}
function approx(a, b, eps = 0.001) { return Math.abs(a - b) < eps }

// ---- aggregatePlayer ----
{
  const out = aggregatePlayer([])
  assert(out.matches === 0 && out.rounds === 0, 'empty rows → matches=0 rounds=0')
  assert(out.rating == null, 'empty rows → rating=null')
}
{
  // Single demo, single side='all' row
  const rows = [{
    rounds_played: 24, kills: 20, deaths: 15, assists: 5,
    adr: 80, rating: 1.10, hs_pct: 0.50, kast_pct: 0.70,
    multi_2k: 4, multi_3k: 1, multi_4k: 0, multi_5k: 0,
    opening_kills: 5, opening_deaths: 3,
    clutches_won: 1, clutches_lost: 0,
    utility_dmg: 200, flash_assists: 3, traded_deaths: 4, impact_rating: 1.05,
  }]
  const out = aggregatePlayer(rows)
  assert(out.matches === 1, 'matches=1')
  assert(out.rounds === 24, 'rounds=24')
  assert(out.kills === 20 && out.deaths === 15 && out.assists === 5, 'sums match')
  assert(approx(out.adr, 80), 'adr=80')
  assert(approx(out.rating, 1.10), 'rating=1.10')
  assert(approx(out.kd, 20/15), 'kd derived')
  assert(approx(out.utility_dmg_per_round, 200/24), 'util/round derived')
}
{
  // Two demos with different round counts → weighted average
  const rows = [
    { rounds_played: 20, rating: 1.00, adr: 70, hs_pct: 0.50, kast_pct: 0.70,
      kills: 10, deaths: 10, assists: 0, multi_2k: 0, multi_3k: 0, multi_4k: 0, multi_5k: 0,
      opening_kills: 0, opening_deaths: 0, clutches_won: 0, clutches_lost: 0,
      utility_dmg: 0, flash_assists: 0, traded_deaths: 0, impact_rating: 1.00 },
    { rounds_played: 30, rating: 1.20, adr: 90, hs_pct: 0.60, kast_pct: 0.80,
      kills: 30, deaths: 20, assists: 0, multi_2k: 0, multi_3k: 0, multi_4k: 0, multi_5k: 0,
      opening_kills: 0, opening_deaths: 0, clutches_won: 0, clutches_lost: 0,
      utility_dmg: 0, flash_assists: 0, traded_deaths: 0, impact_rating: 1.10 },
  ]
  const out = aggregatePlayer(rows)
  assert(out.matches === 2, 'two demos → matches=2')
  assert(out.rounds === 50, 'rounds sum to 50')
  // weighted: (1.00*20 + 1.20*30)/50 = (20+36)/50 = 1.12
  assert(approx(out.rating, 1.12), 'rating weighted by rounds')
  assert(approx(out.adr, (70*20 + 90*30) / 50), 'adr weighted by rounds')
  assert(approx(out.hs_pct, (0.50*20 + 0.60*30) / 50), 'hs_pct weighted')
  assert(approx(out.kast_pct, (0.70*20 + 0.80*30) / 50), 'kast_pct weighted')
  assert(out.kills === 40 && out.deaths === 30, 'kills/deaths summed')
  assert(approx(out.kd, 40/30), 'kd derived')
}

// ---- aggregateByPlayer ----
{
  const rows = [
    { steam_id: 'A', rounds_played: 24, rating: 1.10, kills: 20, deaths: 15, assists: 0,
      adr: 80, hs_pct: 0.5, kast_pct: 0.7, multi_2k: 0, multi_3k: 0, multi_4k: 0, multi_5k: 0,
      opening_kills: 0, opening_deaths: 0, clutches_won: 0, clutches_lost: 0,
      utility_dmg: 0, flash_assists: 0, traded_deaths: 0, impact_rating: 1.0 },
    { steam_id: 'B', rounds_played: 24, rating: 0.90, kills: 10, deaths: 18, assists: 0,
      adr: 60, hs_pct: 0.5, kast_pct: 0.7, multi_2k: 0, multi_3k: 0, multi_4k: 0, multi_5k: 0,
      opening_kills: 0, opening_deaths: 0, clutches_won: 0, clutches_lost: 0,
      utility_dmg: 0, flash_assists: 0, traded_deaths: 0, impact_rating: 1.0 },
    { steam_id: 'A', rounds_played: 24, rating: 1.30, kills: 25, deaths: 12, assists: 0,
      adr: 95, hs_pct: 0.5, kast_pct: 0.7, multi_2k: 0, multi_3k: 0, multi_4k: 0, multi_5k: 0,
      opening_kills: 0, opening_deaths: 0, clutches_won: 0, clutches_lost: 0,
      utility_dmg: 0, flash_assists: 0, traded_deaths: 0, impact_rating: 1.0 },
  ]
  const out = aggregateByPlayer(rows)
  assert(out.size === 2, 'two distinct players')
  assert(out.get('A').matches === 2, 'A has 2 matches')
  assert(approx(out.get('A').rating, 1.20), 'A rating averaged')
  assert(out.get('B').matches === 1, 'B has 1 match')
}

// ---- aggregateByMap ----
{
  const rows = [
    { map: 'mirage', rounds_played: 24, rating: 1.10, kills: 20, deaths: 10, assists: 0,
      adr: 80, hs_pct: 0.5, kast_pct: 0.7, multi_2k: 0, multi_3k: 0, multi_4k: 0, multi_5k: 0,
      opening_kills: 0, opening_deaths: 0, clutches_won: 0, clutches_lost: 0,
      utility_dmg: 0, flash_assists: 0, traded_deaths: 0, impact_rating: 1.0 },
    { map: 'inferno', rounds_played: 24, rating: 0.95, kills: 15, deaths: 15, assists: 0,
      adr: 70, hs_pct: 0.5, kast_pct: 0.7, multi_2k: 0, multi_3k: 0, multi_4k: 0, multi_5k: 0,
      opening_kills: 0, opening_deaths: 0, clutches_won: 0, clutches_lost: 0,
      utility_dmg: 0, flash_assists: 0, traded_deaths: 0, impact_rating: 1.0 },
    { map: 'mirage', rounds_played: 24, rating: 1.30, kills: 25, deaths: 12, assists: 0,
      adr: 95, hs_pct: 0.5, kast_pct: 0.7, multi_2k: 0, multi_3k: 0, multi_4k: 0, multi_5k: 0,
      opening_kills: 0, opening_deaths: 0, clutches_won: 0, clutches_lost: 0,
      utility_dmg: 0, flash_assists: 0, traded_deaths: 0, impact_rating: 1.0 },
  ]
  const out = aggregateByMap(rows)
  assert(out.length === 2, 'two maps')
  assert(out[0].map === 'mirage' && approx(out[0].agg.rating, 1.20), 'mirage first (sorted by rating)')
  assert(out[1].map === 'inferno', 'inferno second')
}

// ---- cutoffDateFor / applyTimeWindow ----
{
  // Use a fixed "now" so the test is deterministic
  const now = new Date('2026-05-08T12:00:00Z')
  assert(cutoffDateFor('all', now) === null, 'all → null cutoff')
  assert(cutoffDateFor('30d', now).toISOString().slice(0,10) === '2026-04-08', '30d cutoff = 30 days ago')
  assert(cutoffDateFor('90d', now).toISOString().slice(0,10) === '2026-02-07', '90d cutoff = 90 days ago')
}
{
  const vods = [
    { id: 1, match_date: '2026-05-07' },
    { id: 2, match_date: '2026-04-01' },
    { id: 3, match_date: '2026-01-15' },
    { id: 4, match_date: '2025-11-01' },
  ]
  const now = new Date('2026-05-08T00:00:00Z')
  assert(applyTimeWindow(vods, 'all', now).length === 4, 'all → all rows')
  assert(applyTimeWindow(vods, '30d', now).length === 2, '30d → 2 rows')
  assert(applyTimeWindow(vods, '90d', now).length === 3, '90d → 3 rows')
  // Last 10 — fewer than 10 vods, returns all sorted desc by date
  const last10 = applyTimeWindow(vods, '10', now)
  assert(last10.length === 4 && last10[0].id === 1, '10 → all sorted desc by match_date')
}
{
  // Last 10 with more than 10 vods
  const many = []
  for (let i = 1; i <= 15; i++) many.push({ id: i, match_date: `2026-04-${String(i).padStart(2,'0')}` })
  const out = applyTimeWindow(many, '10', new Date('2026-05-08'))
  assert(out.length === 10, 'last 10 caps at 10')
  assert(out[0].id === 15, 'last 10 sorted desc — newest first')
}
</script>
</body>
</html>
```

- [ ] **Step 2: Run the test (it should fail with import error)**

Open `cs2-hub/roster-stats-aggregate.test.html`. Console: import resolution failure.

- [ ] **Step 3: Implement the aggregation module**

Create `cs2-hub/roster-stats-aggregate.js`:

```js
// cs2-hub/roster-stats-aggregate.js
//
// Pure helpers to aggregate `demo_players` rows into per-player career stats,
// per-map breakdowns, and side splits. Weighted by rounds_played.
// All inputs are arrays of demo_players rows — caller fetches & filters first.

const SUM_FIELDS = [
  'kills', 'deaths', 'assists',
  'multi_2k', 'multi_3k', 'multi_4k', 'multi_5k',
  'opening_kills', 'opening_deaths',
  'clutches_won', 'clutches_lost',
  'flash_assists', 'traded_deaths',
]
const PER_ROUND_FIELDS  = ['adr', 'utility_dmg', 'impact_rating']
const PERCENT_FIELDS    = ['hs_pct', 'kast_pct']
const RATING_FIELD      = 'rating'

// Aggregate a list of demo_players rows for ONE player into a single stats object.
// Returns nulls for averaged stats when no rounds were played.
export function aggregatePlayer(rows) {
  const out = { matches: 0, rounds: 0 }
  for (const f of SUM_FIELDS) out[f] = 0

  if (!rows || rows.length === 0) {
    for (const f of PER_ROUND_FIELDS) out[f] = null
    for (const f of PERCENT_FIELDS)   out[f] = null
    out.rating = null
    out.kd = null
    out.utility_dmg_per_round = null
    return out
  }

  let totalRounds = 0
  // Weighted accumulators
  const wsum = {}
  for (const f of [...PER_ROUND_FIELDS, ...PERCENT_FIELDS, RATING_FIELD]) wsum[f] = 0

  for (const r of rows) {
    out.matches++
    const rd = r.rounds_played || 0
    totalRounds += rd
    for (const f of SUM_FIELDS) out[f] += r[f] || 0
    for (const f of [...PER_ROUND_FIELDS, ...PERCENT_FIELDS, RATING_FIELD]) {
      wsum[f] += (r[f] || 0) * rd
    }
  }

  out.rounds = totalRounds
  if (totalRounds > 0) {
    for (const f of [...PER_ROUND_FIELDS, ...PERCENT_FIELDS, RATING_FIELD]) {
      out[f] = wsum[f] / totalRounds
    }
  } else {
    for (const f of [...PER_ROUND_FIELDS, ...PERCENT_FIELDS, RATING_FIELD]) out[f] = null
  }

  out.kd = out.deaths > 0 ? out.kills / out.deaths : (out.kills > 0 ? Infinity : null)
  out.utility_dmg_per_round = totalRounds > 0 ? out.utility_dmg / totalRounds : null

  return out
}

// Aggregate rows grouped by steam_id. Returns Map<steam_id, aggregatePlayer-result>.
export function aggregateByPlayer(rows) {
  const buckets = new Map()
  for (const r of rows || []) {
    if (!r.steam_id) continue
    if (!buckets.has(r.steam_id)) buckets.set(r.steam_id, [])
    buckets.get(r.steam_id).push(r)
  }
  const out = new Map()
  for (const [sid, list] of buckets) out.set(sid, aggregatePlayer(list))
  return out
}

// Aggregate rows grouped by `map` (rows must include a `map` property — caller
// is expected to join demos.map onto demo_players rows before calling).
// Returns array sorted by rating desc: [{ map, agg }].
export function aggregateByMap(rows) {
  const buckets = new Map()
  for (const r of rows || []) {
    if (!r.map) continue
    if (!buckets.has(r.map)) buckets.set(r.map, [])
    buckets.get(r.map).push(r)
  }
  const out = []
  for (const [m, list] of buckets) out.push({ map: m, agg: aggregatePlayer(list) })
  out.sort((a, b) => (b.agg.rating ?? 0) - (a.agg.rating ?? 0))
  return out
}

// Compute the cutoff Date for a window key. Returns null for 'all'.
// `now` is injectable so tests can run deterministically.
export function cutoffDateFor(window, now = new Date()) {
  const days = window === '30d' ? 30 : window === '90d' ? 90 : null
  if (days == null) return null
  const d = new Date(now)
  d.setDate(d.getDate() - days)
  return d
}

// Apply the window filter to a list of vods (objects with `match_date`
// of the form 'YYYY-MM-DD' or ISO timestamp). For 'all', returns input
// untouched. For '30d'/'90d', filters by cutoff. For '10', returns the
// last 10 vods sorted by match_date desc.
export function applyTimeWindow(vods, window, now = new Date()) {
  if (!Array.isArray(vods)) return []
  if (window === 'all') return vods
  if (window === '10') {
    return [...vods]
      .filter(v => v.match_date)
      .sort((a, b) => String(b.match_date).localeCompare(String(a.match_date)))
      .slice(0, 10)
  }
  const cutoff = cutoffDateFor(window, now)
  if (!cutoff) return vods
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  return vods.filter(v => v.match_date && String(v.match_date) >= cutoffStr)
}
```

- [ ] **Step 4: Re-open the test page**

Refresh `cs2-hub/roster-stats-aggregate.test.html`. Console shows ~25 PASS lines, zero FAIL.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/roster-stats-aggregate.js cs2-hub/roster-stats-aggregate.test.html
git commit -m "feat(stats): pure aggregation helpers for per-player career stats"
```

---

### Task 8: Filter component — `vods-filter.js` + tests (TDD)

**Files:**
- Create: `cs2-hub/vods-filter.js`
- Create: `cs2-hub/vods-filter.test.html`

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/vods-filter.test.html`:

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
  assert(f.tournamentsOnly === false, 'default tournamentsOnly = false')
}

// Mount + click pill → emits new state, persists to localStorage
{
  localStorage.removeItem(FILTER_KEY)
  const root = document.getElementById('mount')
  root.innerHTML = ''
  const states = []
  mountFilter(root, (s) => states.push(s))

  const pill90 = root.querySelector('[data-window="90d"]')
  pill90.click()

  assert(states.length === 1, 'one emission after click')
  assert(states[0].window === '90d', 'state has window=90d')
  const stored = JSON.parse(localStorage.getItem(FILTER_KEY))
  assert(stored.window === '90d', 'persisted to localStorage')
}

// Toggle tournamentsOnly
{
  localStorage.removeItem(FILTER_KEY)
  const root = document.getElementById('mount')
  root.innerHTML = ''
  const states = []
  mountFilter(root, (s) => states.push(s))

  const toggle = root.querySelector('#vods-tournaments-toggle')
  toggle.click()

  assert(states.length === 1, 'one emission')
  assert(states[0].tournamentsOnly === true, 'tournamentsOnly toggled on')
  toggle.click()
  assert(states[1].tournamentsOnly === false, 'toggled back off')
}

// Mount restores from localStorage
{
  localStorage.setItem(FILTER_KEY, JSON.stringify({ window: '30d', tournamentsOnly: true }))
  const root = document.getElementById('mount')
  root.innerHTML = ''
  let initial = null
  mountFilter(root, (s) => { if (initial == null) initial = s })

  // Initial callback should fire on mount with restored state
  assert(initial?.window === '30d', 'restored window from storage')
  assert(initial?.tournamentsOnly === true, 'restored tournamentsOnly from storage')
  assert(root.querySelector('[data-window="30d"]').classList.contains('is-active'), '30d pill is active')
}
</script>
</body>
</html>
```

- [ ] **Step 2: Run the test (should fail with import error)**

Open the test page. Console shows the unresolved-module error.

- [ ] **Step 3: Implement the filter component**

Create `cs2-hub/vods-filter.js`:

```js
// cs2-hub/vods-filter.js
//
// Renders the filter row above the team stats grid on Results & Review.
// Emits filter state on mount (from localStorage) and on every change.

export const FILTER_KEY = 'vods:filter:v1'

export function defaultFilter() {
  return { window: '10', tournamentsOnly: false }
}

function loadFilter() {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw) return defaultFilter()
    const parsed = JSON.parse(raw)
    return {
      window: ['10','30d','90d','all'].includes(parsed.window) ? parsed.window : '10',
      tournamentsOnly: !!parsed.tournamentsOnly,
    }
  } catch { return defaultFilter() }
}

function saveFilter(f) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)) } catch {}
}

const PILLS = [
  { key: '10',  label: 'Last 10' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All time' },
]

// Mount the filter row inside `root`. Calls `onChange(state)` on mount and
// on every subsequent change.
export function mountFilter(root, onChange) {
  let state = loadFilter()

  function render() {
    root.innerHTML = `
      <div class="vods-filter-row">
        <div class="vods-filter-pills">
          ${PILLS.map(p => `
            <button type="button" class="vods-filter-pill ${state.window === p.key ? 'is-active' : ''}"
                    data-window="${p.key}">${p.label}</button>
          `).join('')}
        </div>
        <label class="vods-filter-toggle">
          <input type="checkbox" id="vods-tournaments-toggle" ${state.tournamentsOnly ? 'checked' : ''}/>
          <span>Tournaments only</span>
        </label>
      </div>
    `
    for (const btn of root.querySelectorAll('[data-window]')) {
      btn.addEventListener('click', () => {
        if (state.window === btn.dataset.window) return
        state = { ...state, window: btn.dataset.window }
        saveFilter(state); render(); onChange(state)
      })
    }
    root.querySelector('#vods-tournaments-toggle').addEventListener('change', (e) => {
      state = { ...state, tournamentsOnly: !!e.target.checked }
      saveFilter(state); onChange(state)
    })
  }

  render()
  onChange(state)
}
```

- [ ] **Step 4: Re-open the test page; all PASS**

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/vods-filter.js cs2-hub/vods-filter.test.html
git commit -m "feat(vods): filter row component (window pills + tournaments toggle)"
```

---

### Task 9: Extract team stats renderer

**Files:**
- Create: `cs2-hub/vods-team-stats.js`

- [ ] **Step 1: Create the team-stats module**

Create `cs2-hub/vods-team-stats.js`. This is a near-verbatim extract of the team-stats and map-breakdown blocks already in `vods.js` lines 28–130, repackaged as a function that takes already-filtered vods.

```js
// cs2-hub/vods-team-stats.js
//
// Renders the top 4-card stats grid + Map Pool Performance for a given
// list of vods. Pure UI — no Supabase calls. Caller passes filtered vods.

const MAP_IMG = { dust2: 'dust' }
function mapImgUrl(map) { return `images/maps/${MAP_IMG[map] ?? map}.png` }
function pct(n, d) { return d === 0 ? 0 : Math.round((n / d) * 100) }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }

export function renderTeamStats(rootStats, rootMaps, vods) {
  if (!vods?.length) {
    rootStats.innerHTML = ''
    rootMaps.innerHTML = ''
    return
  }

  const record = { w: 0, l: 0, d: 0 }
  let totalRW = 0, totalRL = 0
  const mapStats = {}

  for (const v of vods) {
    const maps = v.maps ?? []
    let mw = 0, ml = 0
    for (const m of maps) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      totalRW += us; totalRL += them
      if (!mapStats[m.map]) mapStats[m.map] = { w: 0, l: 0, rw: 0, rl: 0 }
      mapStats[m.map].rw += us
      mapStats[m.map].rl += them
      if (us > them) { mw++; mapStats[m.map].w++ }
      else if (them > us) { ml++; mapStats[m.map].l++ }
    }
    if (mw > ml) record.w++
    else if (ml > mw) record.l++
    else if (maps.length) record.d++
  }

  const totalMatches = record.w + record.l + record.d
  const roundWinPct  = pct(totalRW, totalRW + totalRL)

  const bestMapEntry = Object.entries(mapStats)
    .filter(([, s]) => s.w + s.l >= 2)
    .sort(([, a], [, b]) => pct(b.w, b.w + b.l) - pct(a.w, a.w + a.l))[0]

  const recentForm = vods.slice(0, 5).map(v => {
    const maps = v.maps ?? []
    let mw = 0, ml = 0
    for (const m of maps) {
      if ((m.score_us ?? 0) > (m.score_them ?? 0)) mw++
      else if ((m.score_them ?? 0) > (m.score_us ?? 0)) ml++
    }
    if (mw > ml) return 'W'
    if (ml > mw) return 'L'
    return 'D'
  })

  rootStats.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Match Record</div>
      <div class="stat-value" style="font-size:20px">${record.w}W — ${record.l}L${record.d ? ' — ' + record.d + 'D' : ''}</div>
      <div class="stat-sub">${totalMatches} match${totalMatches !== 1 ? 'es' : ''} · ${pct(record.w, totalMatches)}% win rate</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Round Win Rate</div>
      <div class="stat-value">${roundWinPct}%</div>
      <div class="stat-sub">${totalRW}W — ${totalRL}L rounds</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Best Map</div>
      <div class="stat-value" style="font-size:18px">${bestMapEntry ? capitalize(bestMapEntry[0]) : '—'}</div>
      <div class="stat-sub">${bestMapEntry ? pct(bestMapEntry[1].w, bestMapEntry[1].w + bestMapEntry[1].l) + '% win rate' : 'Need 2+ games per map'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Recent Form</div>
      <div class="form-dots">${recentForm.map(r => `<span class="form-dot form-dot-${r === 'W' ? 'win' : r === 'L' ? 'loss' : 'draw'}">${r}</span>`).join('')}</div>
      <div class="stat-sub">Last ${recentForm.length} matches</div>
    </div>
  `

  const sortedMaps = Object.entries(mapStats).sort(([, a], [, b]) => (b.w + b.l) - (a.w + a.l))
  rootMaps.innerHTML = `
    <div class="map-breakdown-grid">
      ${sortedMaps.map(([map, s]) => {
        const games = s.w + s.l
        const wp  = pct(s.w, games)
        const rp  = pct(s.rw, s.rw + s.rl)
        const img = mapImgUrl(map)
        const barColor = wp >= 60 ? 'var(--success)' : wp >= 45 ? 'var(--accent)' : 'var(--danger)'
        const labelColor = wp >= 60 ? 'var(--success)' : wp >= 45 ? 'var(--muted)' : 'var(--danger)'
        const label = wp >= 60 ? 'STRONG' : wp >= 45 ? 'EVEN' : 'WEAK'
        return `
          <div class="map-stat-card">
            <img src="${img}" class="map-stat-bg" aria-hidden="true">
            <div class="map-stat-body">
              <div class="map-stat-top">
                <span class="map-stat-name">${capitalize(map)}</span>
                <span class="map-stat-label" style="color:${labelColor}">${label}</span>
              </div>
              <div class="map-stat-record">${s.w}W — ${s.l}L <span style="color:var(--muted);font-weight:400">(${games} game${games !== 1 ? 's' : ''})</span></div>
              <div class="map-stat-bar-wrap">
                <div class="map-stat-bar" style="width:${wp}%;background:${barColor}"></div>
              </div>
              <div class="map-stat-footer">
                <span class="map-stat-pct" style="color:${barColor}">${wp}% win rate</span>
                <span class="map-stat-rounds">${rp}% rounds</span>
              </div>
            </div>
          </div>
        `
      }).join('')}
    </div>
  `
}
```

- [ ] **Step 2: Commit (no behavior change yet — vods.js still in charge)**

```bash
git add cs2-hub/vods-team-stats.js
git commit -m "refactor(vods): extract team stats renderer to its own module"
```

---

### Task 10: Player drawer skeleton + tests

**Files:**
- Create: `cs2-hub/player-drawer.js`
- Create: `cs2-hub/player-drawer.test.html`

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/player-drawer.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<script type="module">
import { mountDrawer } from './player-drawer.js'

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); return }
  console.log('PASS:', msg)
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

const drawer = mountDrawer()

// Initially closed
assert(document.querySelector('.player-drawer').getAttribute('aria-hidden') === 'true', 'starts hidden')

// Open with empty-state body
drawer.open({
  title: 'fl0m',
  subtitle: 'IGL · 0 matches · 0 rounds · Last 10',
  body: `<div class="pd-empty">No data for selected filter.</div>`,
})
assert(document.querySelector('.player-drawer').getAttribute('aria-hidden') === 'false', 'open() shows drawer')
assert(document.querySelector('.player-drawer .pd-title').textContent === 'fl0m', 'title rendered')

// Esc closes
const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
document.dispatchEvent(ev)
assert(document.querySelector('.player-drawer').getAttribute('aria-hidden') === 'true', 'Esc closes')

// Backdrop click closes
drawer.open({ title: 'x', subtitle: 'y', body: '' })
document.querySelector('.player-drawer-backdrop').click()
assert(document.querySelector('.player-drawer').getAttribute('aria-hidden') === 'true', 'backdrop click closes')

// Open while already open swaps content (no flicker test — just content swap)
drawer.open({ title: 'A', subtitle: 's', body: '' })
drawer.open({ title: 'B', subtitle: 's', body: '' })
assert(document.querySelector('.player-drawer .pd-title').textContent === 'B', 'second open swaps title')

// Close button
drawer.open({ title: 'x', subtitle: 'y', body: '' })
document.querySelector('.player-drawer-close').click()
assert(document.querySelector('.player-drawer').getAttribute('aria-hidden') === 'true', 'close button works')

// onClose callback
let closedCount = 0
drawer.open({ title: 'x', subtitle: 'y', body: '', onClose: () => closedCount++ })
drawer.close()
assert(closedCount === 1, 'onClose fires on close')
</script>
</body>
</html>
```

- [ ] **Step 2: Run the test (fail)**

Open the page; console shows the unresolved-module error.

- [ ] **Step 3: Implement the drawer**

Create `cs2-hub/player-drawer.js`:

```js
// cs2-hub/player-drawer.js
//
// Single drawer instance mounted into <body>. Slide-in panel from the right
// with a click-dismissable backdrop. Open is idempotent (calling open()
// while already open swaps content without animation).

let mounted = null

function ensureMounted() {
  if (mounted) return mounted
  const wrap = document.createElement('div')
  wrap.className = 'player-drawer'
  wrap.setAttribute('aria-hidden', 'true')
  wrap.innerHTML = `
    <div class="player-drawer-backdrop"></div>
    <aside class="player-drawer-panel" role="dialog" aria-modal="true">
      <header class="pd-header">
        <div>
          <div class="pd-title"></div>
          <div class="pd-subtitle"></div>
        </div>
        <button type="button" class="player-drawer-close" aria-label="Close">×</button>
      </header>
      <div class="pd-body"></div>
    </aside>
  `
  document.body.appendChild(wrap)

  let onCloseCb = null

  function close() {
    wrap.setAttribute('aria-hidden', 'true')
    if (typeof onCloseCb === 'function') { const cb = onCloseCb; onCloseCb = null; cb() }
  }

  wrap.querySelector('.player-drawer-backdrop').addEventListener('click', close)
  wrap.querySelector('.player-drawer-close').addEventListener('click', close)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wrap.getAttribute('aria-hidden') === 'false') close()
  })

  mounted = {
    el: wrap,
    open({ title, subtitle, body, onClose }) {
      // Replace the previous onClose without firing it (it's a swap, not a close).
      onCloseCb = onClose ?? null
      wrap.querySelector('.pd-title').textContent = title ?? ''
      wrap.querySelector('.pd-subtitle').textContent = subtitle ?? ''
      wrap.querySelector('.pd-body').innerHTML = body ?? ''
      wrap.setAttribute('aria-hidden', 'false')
      // Scroll body to top on open
      wrap.querySelector('.pd-body').scrollTop = 0
    },
    close,
    isOpen() { return wrap.getAttribute('aria-hidden') === 'false' },
  }
  return mounted
}

// Returns the singleton drawer controller. Mounts on first call.
export function mountDrawer() {
  return ensureMounted()
}
```

- [ ] **Step 4: Re-open the test page — all PASS**

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/player-drawer.js cs2-hub/player-drawer.test.html
git commit -m "feat(vods): player-drawer skeleton (open/close, Esc, backdrop)"
```

---

### Task 11: Roster band component

**Files:**
- Create: `cs2-hub/roster-stats.js`

- [ ] **Step 1: Create the roster band module**

Create `cs2-hub/roster-stats.js`:

```js
// cs2-hub/roster-stats.js
//
// Renders the "Roster · Career Stats" band on Results & Review.
// Cards show name + role + Rating; click opens the player drawer.

import { aggregateByPlayer } from './roster-stats-aggregate.js'

const ROLE_ORDER = { IGL: 0, Entry: 1, AWPer: 2, Lurker: 3, Support: 4 }
const STAFF_ROLES = new Set(['Coach', 'Manager'])

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function fmtRating(r) { return r == null ? '—' : r.toFixed(2) }

// Sort roster: role priority first, then nickname/username.
function sortRoster(roster) {
  return [...roster]
    .filter(p => !STAFF_ROLES.has(p.role))
    .sort((a, b) => {
      const ra = ROLE_ORDER[a.role] ?? 99
      const rb = ROLE_ORDER[b.role] ?? 99
      if (ra !== rb) return ra - rb
      return String(a.username || '').localeCompare(String(b.username || ''))
    })
}

// roster   : [{ id, username, nickname, role, steam_id }]
// rows     : array of demo_players rows for the team (already filtered to side='all')
// onPick   : called with the roster row when its card is clicked
export function renderRosterBand(root, { roster, rows, onPick }) {
  const sorted = sortRoster(roster)
  if (!sorted.length) {
    root.innerHTML = `<div class="rb-empty">No players on roster.</div>`
    return
  }

  const aggMap = aggregateByPlayer(rows ?? [])

  root.innerHTML = `<div class="roster-band-grid">${sorted.map(p => {
    const hasSteam = !!p.steam_id
    const agg = hasSteam ? aggMap.get(p.steam_id) : null
    const hasData = !!(agg && agg.matches > 0)

    if (!hasSteam) {
      return `
        <button type="button" class="rb-card rb-card-disabled" data-action="add-steam" data-id="${esc(p.id)}">
          <div class="rb-name">${esc(p.username)}</div>
          <div class="rb-role">${esc(p.role || 'Player')}</div>
          <div class="rb-cta">Add Steam ID →</div>
        </button>`
    }

    return `
      <button type="button" class="rb-card ${hasData ? '' : 'rb-card-empty'}" data-action="open" data-id="${esc(p.id)}">
        <div class="rb-name">${esc(p.username)}</div>
        <div class="rb-role">${esc(p.role || 'Player')}</div>
        <div class="rb-rating-block">
          <div class="rb-rating-label">Rating</div>
          <div class="rb-rating-value">${hasData ? fmtRating(agg.rating) : '—'}</div>
        </div>
        ${hasData ? '' : `<div class="rb-sub">No matches in window</div>`}
      </button>`
  }).join('')}</div>`

  for (const btn of root.querySelectorAll('[data-action="open"]')) {
    btn.addEventListener('click', () => {
      const player = sorted.find(p => p.id === btn.dataset.id)
      if (player) onPick(player)
    })
  }
  for (const btn of root.querySelectorAll('[data-action="add-steam"]')) {
    btn.addEventListener('click', () => {
      window.location.href = `roster.html?edit=${encodeURIComponent(btn.dataset.id)}`
    })
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add cs2-hub/roster-stats.js
git commit -m "feat(vods): roster band renderer with click-to-open + empty/no-steam states"
```

---

### Task 12: Drawer content renderer

**Files:**
- Create: `cs2-hub/roster-stats-render.js`

- [ ] **Step 1: Create the drawer body renderer**

Create `cs2-hub/roster-stats-render.js`:

```js
// cs2-hub/roster-stats-render.js
//
// Builds the HTML body for a single player's drawer. Pure functions —
// caller fetches data and passes pre-filtered rows.

import { aggregatePlayer, aggregateByMap } from './roster-stats-aggregate.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function fmt(n, d = 2) { return n == null ? '—' : Number(n).toFixed(d) }
function fmtPct(p) { return p == null ? '—' : `${Math.round(p * 100)}%` }
function fmtInt(n) { return n == null ? '—' : String(Math.round(n)) }
function fmtKD(kd) { return kd == null ? '—' : !isFinite(kd) ? '∞' : kd.toFixed(2) }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }

const WINDOW_LABELS = { '10': 'Last 10', '30d': 'Last 30 days', '90d': 'Last 90 days', 'all': 'All time' }
export function windowLabel(w) { return WINDOW_LABELS[w] ?? '' }

// rowsAll  : demo_players rows for THIS player only, side='all', joined to demos.map
// rowsCT   : same player, side='ct'
// rowsT    : same player, side='t'
// recent   : up to 10 demos this player played, in reverse chronological order,
//            each: { vod_id, opponent, map, rating, result }   (pre-resolved by caller)
export function buildPlayerDrawerBody({ rowsAll, rowsCT, rowsT, recent }) {
  const all  = aggregatePlayer(rowsAll)
  const ct   = aggregatePlayer(rowsCT)
  const t    = aggregatePlayer(rowsT)
  const maps = aggregateByMap(rowsAll)

  if (all.matches === 0) {
    return `<div class="pd-empty">
      No matches in selected window.
      <div class="pd-empty-cta"><button type="button" id="pd-view-alltime" class="btn btn-ghost btn-sm">View all-time</button></div>
    </div>`
  }

  // Side splits strip
  const splits = `
    <div class="pd-splits">
      <div class="pd-split-pill"><span class="pd-split-label">CT Rating</span><span class="pd-split-value">${fmt(ct.rating)}</span></div>
      <div class="pd-split-pill"><span class="pd-split-label">T Rating</span><span class="pd-split-value">${fmt(t.rating)}</span></div>
      <div class="pd-split-pill"><span class="pd-split-label">K/D</span><span class="pd-split-value">${fmtKD(all.kd)}</span></div>
    </div>`

  // Headline grid (5)
  const headline = `
    <div class="pd-section-label">Headline</div>
    <div class="pd-grid pd-grid-5">
      ${miniCard('Rating', fmt(all.rating))}
      ${miniCard('ADR', fmt(all.adr, 1))}
      ${miniCard('KAST', fmtPct(all.kast_pct))}
      ${miniCard('HS%', fmtPct(all.hs_pct))}
      ${miniCard('Impact', fmt(all.impact_rating))}
    </div>`

  // Opening duels
  const openTotal = (all.opening_kills || 0) + (all.opening_deaths || 0)
  const openPct = openTotal > 0 ? all.opening_kills / openTotal : null
  const opening = `
    <div class="pd-section-label">Opening Duels</div>
    <div class="pd-grid pd-grid-3">
      ${miniCard('Win %', fmtPct(openPct))}
      ${miniCard('First Kills', fmtInt(all.opening_kills))}
      ${miniCard('First Deaths', fmtInt(all.opening_deaths))}
    </div>`

  // Clutches & multi-kills
  const clutches = `
    <div class="pd-section-label">Clutches &amp; Multi-kills</div>
    <div class="pd-grid pd-grid-4">
      ${miniCard('1vX Won', fmtInt(all.clutches_won))}
      ${miniCard('3K', fmtInt(all.multi_3k))}
      ${miniCard('4K+', fmtInt((all.multi_4k || 0) + (all.multi_5k || 0)))}
      ${miniCard('Util/round', fmt(all.utility_dmg_per_round, 1))}
    </div>`

  // Per-map
  const mapRows = maps.length === 0
    ? `<div class="pd-empty-row">No map data.</div>`
    : maps.map(({ map, agg }) => `
        <div class="pd-row">
          <span class="pd-row-left">${esc(capitalize(map))}</span>
          <span class="pd-row-right">${fmt(agg.rating)} <span class="pd-muted">· ${agg.matches} match${agg.matches === 1 ? '' : 'es'}</span></span>
        </div>`).join('')
  const perMap = `
    <div class="pd-section-label">Per Map</div>
    <div class="pd-rows">${mapRows}</div>`

  // Recent matches
  const recentRows = (recent || []).length === 0
    ? `<div class="pd-empty-row">No recent matches.</div>`
    : recent.map(r => `
        <a class="pd-row pd-row-link" href="vod-detail.html?id=${esc(r.vod_id)}">
          <span class="pd-row-left">vs ${esc(r.opponent)} <span class="pd-muted">· ${esc(capitalize(r.map))}</span></span>
          <span class="pd-row-right">${fmt(r.rating)} <span class="pd-result pd-result-${r.result}">${r.result.toUpperCase()}</span></span>
        </a>`).join('')
  const recentSection = `
    <div class="pd-section-label">Recent Matches</div>
    <div class="pd-rows">${recentRows}</div>`

  return splits + headline + opening + clutches + perMap + recentSection
}

function miniCard(label, value) {
  return `<div class="pd-card"><div class="pd-card-label">${esc(label)}</div><div class="pd-card-value">${esc(value)}</div></div>`
}

export function buildSubtitle(player, windowKey, matches, rounds) {
  const role = player.role || 'Player'
  return `${role} · ${matches} match${matches === 1 ? '' : 'es'} · ${rounds} round${rounds === 1 ? '' : 's'} · ${windowLabel(windowKey)}`
}
```

- [ ] **Step 2: Commit**

```bash
git add cs2-hub/roster-stats-render.js
git commit -m "feat(vods): drawer body renderer for player career stats"
```

---

### Task 13: Wire everything into `vods.html` + `vods.js`

**Files:**
- Modify: `cs2-hub/vods.html`
- Modify: `cs2-hub/vods.js`

- [ ] **Step 1: Update `vods.html` to add filter and roster slots**

Replace the `#stats-section` block in `cs2-hub/vods.html` (around lines 23–27) with:

```html
    <div id="filter-slot"></div>

    <div id="stats-section" style="display:none">
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)" id="top-stats"></div>

      <div class="section-label" style="margin-top:24px">Roster · Career Stats</div>
      <div id="roster-band"></div>

      <div class="section-label" style="margin-top:24px">Map Pool Performance</div>
      <div id="map-breakdown"></div>
    </div>
```

- [ ] **Step 2: Replace `vods.js` with the orchestrator**

Replace the entire contents of `cs2-hub/vods.js` with:

```js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { getTeamLogo, teamLogoEl } from './team-autocomplete.js'
import { mountFilter } from './vods-filter.js'
import { renderTeamStats } from './vods-team-stats.js'
import { renderRosterBand } from './roster-stats.js'
import { mountDrawer } from './player-drawer.js'
import { buildPlayerDrawerBody, buildSubtitle, windowLabel } from './roster-stats-render.js'
import { applyTimeWindow } from './roster-stats-aggregate.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function formatDate(d) { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }

await requireAuth()
renderSidebar('vods')

const teamId = getTeamId()
const drawer = mountDrawer()

// ── Load all data once ──────────────────────────────────────────
const [vodsRes, rosterRes] = await Promise.all([
  supabase.from('vods').select('*').eq('team_id', teamId).eq('dismissed', false).order('match_date', { ascending: false }),
  supabase.from('roster').select('*').eq('team_id', teamId),
])
if (vodsRes.error) {
  document.getElementById('vods-list').innerHTML = `<div class="empty-state"><h3>Failed to load matches</h3><p>${esc(vodsRes.error.message)}</p></div>`
  throw vodsRes.error
}
const allVods   = vodsRes.data ?? []
const roster    = rosterRes.data ?? []
const teamSteamIds = new Set(roster.map(p => p.steam_id).filter(Boolean))

if (!allVods.length) {
  document.getElementById('vods-list').innerHTML = `<div class="empty-state"><h3>No matches yet</h3><p>Add your first result above.</p></div>`
} else {
  document.getElementById('stats-section').style.display = 'block'
}

// ── Resolve demo set + demo_players for the filtered vod set ────
async function fetchPlayerRowsForVods(filteredVods) {
  // Step 1: extract seed demo IDs from vod.demo_link strings.
  const seedDemoIds = filteredVods
    .map(v => {
      const m = /id=([0-9a-fA-F-]{36})/.exec(v.demo_link || '')
      return m ? m[1] : null
    })
    .filter(Boolean)
  if (!seedDemoIds.length) return { rowsAll: [], rowsCT: [], rowsT: [], demosById: new Map() }

  // Step 2: load seed demo rows (for series_id + map + played_at).
  const { data: seedDemos, error: e1 } = await supabase
    .from('demos')
    .select('id,series_id,map,played_at,opponent_name')
    .in('id', seedDemoIds)
  if (e1) throw e1

  // Step 3: expand series → sibling demos.
  const seriesIds = [...new Set((seedDemos || []).map(d => d.series_id).filter(Boolean))]
  let allDemos = seedDemos || []
  if (seriesIds.length) {
    const { data: siblings, error: e2 } = await supabase
      .from('demos')
      .select('id,series_id,map,played_at,opponent_name')
      .in('series_id', seriesIds)
    if (e2) throw e2
    const known = new Set(allDemos.map(d => d.id))
    for (const d of siblings || []) if (!known.has(d.id)) allDemos.push(d)
  }
  const demoIds = allDemos.map(d => d.id)
  const demosById = new Map(allDemos.map(d => [d.id, d]))

  if (!teamSteamIds.size || !demoIds.length) return { rowsAll: [], rowsCT: [], rowsT: [], demosById }

  // Step 4: load demo_players for our roster's steam_ids only.
  const teamSteamIdList = [...teamSteamIds]
  const { data: rows, error: e3 } = await supabase
    .from('demo_players')
    .select('*')
    .in('demo_id', demoIds)
    .in('steam_id', teamSteamIdList)
  if (e3) throw e3

  // Attach demos.map to each row for per-map aggregation.
  for (const r of rows || []) {
    const d = demosById.get(r.demo_id)
    r.map = d?.map ?? null
  }
  const rowsAll = (rows || []).filter(r => r.side === 'all')
  const rowsCT  = (rows || []).filter(r => r.side === 'ct')
  const rowsT   = (rows || []).filter(r => r.side === 't')
  return { rowsAll, rowsCT, rowsT, demosById }
}

function filterVods(filter) {
  let pool = allVods
  if (filter.tournamentsOnly) pool = pool.filter(v => v.match_type === 'tournament')
  return applyTimeWindow(pool, filter.window)
}

// Map a demo back to its vod by extracting the demo_id from vod.demo_link
// AND scanning for siblings via series_id. Used to produce W/L for the
// drawer's recent-matches section.
function buildDemoToVodMap(filteredVods, demosById) {
  const seedToVod = new Map() // demo_id → vod
  for (const v of filteredVods) {
    const m = /id=([0-9a-fA-F-]{36})/.exec(v.demo_link || '')
    if (m) seedToVod.set(m[1], v)
  }
  const seriesToVod = new Map() // series_id → vod
  for (const [demoId, v] of seedToVod) {
    const d = demosById.get(demoId)
    if (d?.series_id) seriesToVod.set(d.series_id, v)
  }
  // Now build demo_id → vod for every demo
  const demoToVod = new Map()
  for (const [demoId, d] of demosById) {
    if (seedToVod.has(demoId)) demoToVod.set(demoId, seedToVod.get(demoId))
    else if (d.series_id && seriesToVod.has(d.series_id)) demoToVod.set(demoId, seriesToVod.get(d.series_id))
  }
  return demoToVod
}

// W/L for a single demo: derived from per-map vod.maps[].score_us/score_them
// matched on map name. Falls back to 'd' (draw/unknown).
function demoResult(demo, vod) {
  if (!vod || !demo) return 'd'
  const slot = (vod.maps || []).find(m => String(m.map).toLowerCase() === String(demo.map).toLowerCase())
  if (!slot || slot.score_us == null || slot.score_them == null) return 'd'
  if (slot.score_us > slot.score_them) return 'w'
  if (slot.score_us < slot.score_them) return 'l'
  return 'd'
}

// ── Match history list (existing, unchanged behavior) ─────────
async function renderMatchList(vods) {
  const el = document.getElementById('vods-list')
  if (!vods.length) {
    el.innerHTML = `<div class="empty-state"><h3>No matches in window</h3><p>Try a wider time window.</p></div>`
    return
  }
  const logos = await Promise.all(vods.map(v => getTeamLogo(v.opponent ?? v.title)))

  function deriveInsights(maps) {
    if (!maps?.length) return []
    const out = []
    let totalUs = 0, totalThem = 0
    let bestMap = null, worstMap = null, closest = null
    for (const m of maps) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      totalUs += us; totalThem += them
      const diff = us - them
      if (!bestMap  || diff > bestMap.diff)  bestMap  = { ...m, diff, us, them }
      if (!worstMap || diff < worstMap.diff) worstMap = { ...m, diff, us, them }
      const margin = Math.abs(diff)
      if (us + them > 0 && (!closest || margin < Math.abs(closest.diff))) closest = { ...m, diff, us, them }
    }
    const overallDiff = totalUs - totalThem
    if (Math.abs(overallDiff) >= 6) out.push({ text: `Round diff ${overallDiff > 0 ? '+' : ''}${overallDiff}`, cls: overallDiff > 0 ? 'positive' : 'negative' })
    if (bestMap && bestMap.diff > 4) out.push({ text: `Strong on ${capitalize(bestMap.map)} ${bestMap.us}–${bestMap.them}`, cls: 'positive' })
    if (worstMap && worstMap.diff < -4 && worstMap.map !== bestMap?.map) out.push({ text: `Lost ${capitalize(worstMap.map)} ${worstMap.us}–${worstMap.them}`, cls: 'negative' })
    if (maps.length >= 2 && closest && Math.abs(closest.diff) <= 2 && closest.map !== bestMap?.map && closest.map !== worstMap?.map) out.push({ text: `Close fight on ${capitalize(closest.map)} ${closest.us}–${closest.them}`, cls: '' })
    return out.slice(0, 3)
  }
  function aggregateScore(maps) {
    let mw = 0, ml = 0
    for (const m of maps ?? []) {
      if ((m.score_us ?? 0) > (m.score_them ?? 0)) mw++
      else if ((m.score_them ?? 0) > (m.score_us ?? 0)) ml++
    }
    return { mw, ml }
  }

  el.innerHTML = vods.map((v, vi) => {
    const maps = v.maps ?? []
    const { mw, ml } = aggregateScore(maps)
    const result = mw > ml ? 'win' : ml > mw ? 'loss' : maps.length ? 'draw' : 'draw'
    const oppName = v.opponent ?? v.title
    const mapsLabel = maps.length === 1
      ? `${capitalize(maps[0].map)} · ${maps[0].score_us ?? '?'}–${maps[0].score_them ?? '?'}`
      : maps.length > 1
        ? `BO${maps.length} · ${maps.map(m => capitalize(m.map)).join(' / ')}`
        : 'No maps'
    const insights = deriveInsights(maps)
    return `
      <a class="match-card match-card-${result}" href="vod-detail.html?id=${v.id}">
        <div class="match-result">
          <span class="match-result-tag match-result-${result}">${result === 'draw' ? 'DRAW' : result.toUpperCase()}</span>
          <span class="match-result-score match-result-score-${result}">${mw}–${ml}</span>
        </div>
        <div class="match-body">
          <div class="match-opponent">
            ${teamLogoEl(logos[vi], oppName, 28)}
            <span>vs ${esc(oppName)}</span>
            ${v.external_uid ? '<span class="pracc-badge">PRACC</span>' : ''}
          </div>
          <div class="match-opponent-meta">${esc(mapsLabel)}</div>
          ${insights.length ? `<div class="match-bullets">${insights.map(i =>
            `<span class="match-bullet ${i.cls ? 'match-bullet-' + i.cls : ''}">${esc(i.text)}</span>`
          ).join('')}</div>` : ''}
        </div>
        <div class="match-meta">
          <div>${esc(v.match_type ?? '')}</div>
          <div class="match-meta-date">${v.match_date ? formatDate(v.match_date) : '—'}</div>
        </div>
      </a>
    `
  }).join('')
}

// ── Drawer open: fetch player-specific data + render body ─────
let lastDataset = null  // { filter, vods, rowsAll, rowsCT, rowsT, demosById, demoToVod }

async function openPlayerDrawer(player) {
  if (!lastDataset) return
  const { rowsAll, rowsCT, rowsT, demosById, demoToVod, filter } = lastDataset
  const sid = player.steam_id

  const myAll = rowsAll.filter(r => r.steam_id === sid)
  const myCT  = rowsCT.filter(r  => r.steam_id === sid)
  const myT   = rowsT.filter(r   => r.steam_id === sid)

  const matches = myAll.length
  const rounds  = myAll.reduce((s, r) => s + (r.rounds_played || 0), 0)

  const recent = myAll
    .map(r => {
      const demo = demosById.get(r.demo_id)
      const vod = demo ? demoToVod.get(r.demo_id) : null
      return {
        vod_id: vod?.id,
        opponent: vod?.opponent ?? demo?.opponent_name ?? '—',
        map: demo?.map ?? '—',
        rating: r.rating,
        result: demoResult(demo, vod),
        played_at: demo?.played_at ?? null,
      }
    })
    .sort((a, b) => String(b.played_at || '').localeCompare(String(a.played_at || '')))
    .slice(0, 10)

  drawer.open({
    title: player.username,
    subtitle: buildSubtitle(player, filter.window, matches, rounds),
    body: buildPlayerDrawerBody({ rowsAll: myAll, rowsCT: myCT, rowsT: myT, recent }),
  })

  // Wire "View all-time" CTA inside empty-state body
  const cta = document.getElementById('pd-view-alltime')
  if (cta) {
    cta.addEventListener('click', () => {
      const f = JSON.parse(localStorage.getItem('vods:filter:v1') || '{}')
      f.window = 'all'; f.tournamentsOnly = !!f.tournamentsOnly
      localStorage.setItem('vods:filter:v1', JSON.stringify(f))
      window.location.reload()
    })
  }
}

// ── Top-level: rebuild whole view on filter change ────────────
async function rebuild(filter) {
  const filteredVods = filterVods(filter)

  await renderMatchList(filteredVods)
  renderTeamStats(document.getElementById('top-stats'), document.getElementById('map-breakdown'), filteredVods)

  const { rowsAll, rowsCT, rowsT, demosById } = await fetchPlayerRowsForVods(filteredVods)
  const demoToVod = buildDemoToVodMap(filteredVods, demosById)

  lastDataset = { filter, vods: filteredVods, rowsAll, rowsCT, rowsT, demosById, demoToVod }

  renderRosterBand(document.getElementById('roster-band'), {
    roster, rows: rowsAll, onPick: openPlayerDrawer,
  })

  // If the drawer is open, refresh its content with the new dataset
  if (drawer.isOpen()) {
    // Find the currently-open player by their displayed name (best effort).
    const openName = document.querySelector('.player-drawer .pd-title')?.textContent
    const player = roster.find(p => p.username === openName)
    if (player && player.steam_id) openPlayerDrawer(player)
    else drawer.close()
  }
}

// Mount filter; mountFilter calls back synchronously on mount + on each change.
mountFilter(document.getElementById('filter-slot'), (filter) => { rebuild(filter) })
```

- [ ] **Step 3: Manual test (data-only — styles still missing, may look unstyled)**

1. Open Results & Review with seeded demos → top stats grid renders, roster band renders below it (likely unstyled), map pool renders, match history renders.
2. Click a roster card with stats → drawer slides in with full content.
3. Esc / backdrop / × button → drawer closes.
4. Change filter pill → top stats, roster band, and match history all update.
5. Toggle Tournaments only → only tournament-type matches contribute.
6. Roster card with no Steam ID → click goes to roster.html?edit=…

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/vods.html cs2-hub/vods.js
git commit -m "feat(vods): wire filter + roster band + player drawer into Results & Review"
```

---

### Task 14: Style polish

**Files:**
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Append the new style block to `style.css`**

Append to the end of `cs2-hub/style.css`:

```css
/* ───────────────────────────────────────────
   Results & Review — filter row
   ─────────────────────────────────────────── */
.vods-filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.vods-filter-pills {
  display: inline-flex;
  background: var(--surface-low);
  border: 1px solid var(--border-solid);
  border-radius: 8px;
  padding: 4px;
  gap: 2px;
}
.vods-filter-pill {
  background: transparent;
  border: 0;
  color: var(--text-variant);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms, color 120ms;
}
.vods-filter-pill:hover { color: var(--text); }
.vods-filter-pill.is-active {
  background: var(--accent-dim);
  color: var(--accent-light);
  font-weight: 600;
}
.vods-filter-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-variant);
  cursor: pointer;
  user-select: none;
}
.vods-filter-toggle input[type="checkbox"] {
  width: 14px; height: 14px;
  accent-color: var(--accent);
  cursor: pointer;
}

/* ───────────────────────────────────────────
   Roster band (career stats cards)
   ─────────────────────────────────────────── */
.roster-band-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 900px) {
  .roster-band-grid { grid-template-columns: repeat(2, 1fr); }
}
.rb-card {
  background: var(--surface);
  border: 1px solid var(--border-solid);
  border-top: 2px solid var(--accent);
  border-radius: 8px;
  padding: 14px;
  text-align: left;
  font-family: inherit;
  color: var(--text);
  cursor: pointer;
  transition: border-color 120ms, transform 120ms, box-shadow 120ms;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rb-card:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
  box-shadow: var(--accent-glow);
}
.rb-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.2;
}
.rb-role {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
  margin-bottom: 8px;
}
.rb-rating-block {
  margin-top: auto;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.rb-rating-label {
  font-size: 9px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.rb-rating-value {
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.rb-card-disabled {
  border-top-color: var(--border-solid);
  background: var(--surface-low);
  color: var(--muted);
}
.rb-card-disabled:hover {
  border-color: var(--muted);
  box-shadow: none;
}
.rb-card-empty .rb-rating-value { color: var(--muted); }
.rb-cta {
  font-size: 11px;
  color: var(--accent);
  margin-top: 6px;
}
.rb-sub {
  font-size: 10px;
  color: var(--muted);
  margin-top: 2px;
}
.rb-empty {
  padding: 20px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}

/* ───────────────────────────────────────────
   Player drawer
   ─────────────────────────────────────────── */
.player-drawer { position: fixed; inset: 0; z-index: 100; pointer-events: none; }
.player-drawer[aria-hidden="false"] { pointer-events: auto; }

.player-drawer-backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.4);
  opacity: 0;
  transition: opacity 160ms;
}
.player-drawer[aria-hidden="false"] .player-drawer-backdrop { opacity: 1; }

.player-drawer-panel {
  position: absolute;
  right: 0; top: 0; bottom: 0;
  width: min(480px, 100vw);
  background: var(--surface);
  border-left: 1px solid var(--border-solid);
  box-shadow: -16px 0 40px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 200ms cubic-bezier(.2,.8,.2,1);
}
.player-drawer[aria-hidden="false"] .player-drawer-panel { transform: translateX(0); }

.pd-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.pd-title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 22px; font-weight: 700;
  color: var(--text);
  line-height: 1.1;
}
.pd-subtitle {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}
.player-drawer-close {
  background: none; border: 0; color: var(--muted);
  font-size: 24px; line-height: 1;
  cursor: pointer; padding: 0 4px;
}
.player-drawer-close:hover { color: var(--text); }

.pd-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px 24px;
}
.pd-section-label {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
  margin: 16px 0 8px;
}
.pd-section-label:first-child { margin-top: 0; }

.pd-splits {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}
.pd-split-pill {
  flex: 1;
  background: var(--surface-low);
  border: 1px solid var(--border-solid);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.pd-split-label {
  font-size: 9px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.pd-split-value {
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}

.pd-grid { display: grid; gap: 6px; }
.pd-grid-3 { grid-template-columns: repeat(3, 1fr); }
.pd-grid-4 { grid-template-columns: repeat(4, 1fr); }
.pd-grid-5 { grid-template-columns: repeat(5, 1fr); }

.pd-card {
  background: var(--surface-low);
  border: 1px solid var(--border-solid);
  border-radius: 6px;
  padding: 8px 10px;
}
.pd-card-label {
  font-size: 9px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.pd-card-value {
  font-size: 16px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  margin-top: 2px;
}

.pd-rows { display: flex; flex-direction: column; gap: 4px; }
.pd-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--surface-low);
  border-radius: 4px;
  padding: 8px 10px;
  font-size: 12px;
  text-decoration: none;
  color: var(--text);
}
.pd-row-link:hover {
  background: var(--surface-high);
  color: var(--accent-light);
}
.pd-row-left { color: var(--text); }
.pd-row-right {
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.pd-muted { color: var(--muted); font-weight: 400; }
.pd-result {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.5px;
  margin-left: 8px;
  padding: 2px 6px;
  border-radius: 3px;
}
.pd-result-w { background: rgba(0,255,156,0.15); color: var(--success); }
.pd-result-l { background: rgba(255,77,77,0.15);  color: var(--danger); }
.pd-result-d { background: var(--border);          color: var(--muted); }

.pd-empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
.pd-empty-cta { margin-top: 12px; }
.pd-empty-row {
  padding: 12px;
  text-align: center;
  color: var(--muted);
  font-size: 11px;
  background: var(--surface-low);
  border-radius: 4px;
}
```

- [ ] **Step 2: Reload Results & Review and verify the visual end-to-end pass**

Open `cs2-hub/vods.html` in the browser. Confirm:

1. Filter row pills + tournaments toggle render and feel like the rest of the app.
2. Roster band: 5 cards in a row, neon-green top accent, hover lift.
3. Click a player → drawer slides in from the right, has CT/T/K/D pills, headline grid (5 cards), opening duels (3), clutches (4), per-map rows, recent matches rows. Numbers consistent.
4. Drawer close: × / Esc / backdrop click all work.
5. Disabled card style: greyed border, "Add Steam ID →" CTA. Click → roster.html?edit=…
6. Empty card style: rating shows `—`, subtitle `No matches in window`. Click opens drawer with empty state + "View all-time" button.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/style.css
git commit -m "style(vods): roster band + player drawer styling"
```

---

### Task 15: Edit-deeplink support on roster page

**Files:**
- Modify: `cs2-hub/roster.js`

- [ ] **Step 1: Auto-open the edit modal when `?edit=<id>` is in the URL**

Append to the bottom of `cs2-hub/roster.js`, after `loadRoster()`:

```js
// Deep-link support: ?edit=<rosterId> opens the modal directly.
// Used by the roster band's "Add Steam ID →" disabled card.
{
  const params = new URLSearchParams(window.location.search)
  const editId = params.get('edit')
  if (editId) {
    // Wait for loadRoster() to finish populating allPlayers before opening.
    const wait = setInterval(() => {
      if (allPlayers.length && allPlayers.find(p => p.id === editId)) {
        clearInterval(wait)
        openModal(editId)
        // Focus the Steam ID field for fast entry.
        document.getElementById('f-steam-id').focus()
      }
    }, 50)
    // Give up after 5 seconds so the page isn't permanently polling.
    setTimeout(() => clearInterval(wait), 5000)
  }
}
```

- [ ] **Step 2: Manual test**

1. Visit `roster.html?edit=<some-roster-id>` directly → modal opens, Steam ID field focused.
2. Click an "Add Steam ID →" card on Results & Review → roster page opens, modal opens for that player.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/roster.js
git commit -m "feat(roster): support ?edit=<id> deep-link from roster band CTA"
```

---

### Task 16: Final end-to-end verification

- [ ] **Step 1: Run all unit tests**

Open each test page in the browser and verify zero FAIL lines:
- `cs2-hub/roster-steam-backfill.test.html`
- `cs2-hub/roster-stats-aggregate.test.html`
- `cs2-hub/vods-filter.test.html`
- `cs2-hub/player-drawer.test.html`

Also verify the existing tests still pass:
- `cs2-hub/auto-fill-vod.test.html`
- `cs2-hub/assign-teams.test.html`
- `cs2-hub/analysis-rounds.test.html`

- [ ] **Step 2: Internal consistency check — pick one player, one demo**

1. Open Results & Review with the time filter set to `All time`.
2. Click a roster player whose stats you can verify against a single recent demo.
3. Note the headline numbers in the drawer.
4. Open that demo in `demo-viewer.html`, switch to the Scoreboard overlay, find the same player.
5. Confirm: K/D/A, ADR, HS%, KAST, Rating numbers match for that single demo when only that demo is in the filter window. (Use `Last 10` and verify if needed by isolating to that one match by date.)

- [ ] **Step 3: Edge case sweep**

1. Roster row without Steam ID → disabled card, link works.
2. Roster row with Steam ID but no demos → empty card + drawer empty state with "View all-time" works.
3. Tournaments-only toggle → reduces both team stats and roster numbers consistently.
4. Filter change while drawer open → drawer reloads with new numbers.
5. Click same card while drawer open showing that player → drawer closes (toggle).
6. Click different card while drawer open → swaps content.
7. Bo3 series demos → all sibling demos counted (verify by comparing match count to vod count for a known Bo3).

- [ ] **Step 4: Commit any last fixes; tag the rollout**

```bash
git status                       # confirm clean
git log --oneline -20            # review the feature's commits
```
