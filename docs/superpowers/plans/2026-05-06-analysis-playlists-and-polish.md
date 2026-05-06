# Analysis Page — Round Playlists & UX Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add team-shared, named round playlists to the cs2-hub analysis page (save rounds with notes, browse them in a fourth right-rail column, click-to-play single rounds or auto-walk a playlist), plus four UX-polish improvements (collapsible filter rail, keyboard shortcuts, loading/empty states, onboarding hint).

**Architecture:**
- Two new Supabase tables (`playlists`, `playlist_rounds`) with team-keyed RLS that mirrors the `demos` ownership model (read = same team, write = uploader).
- A new `playlists.js` data-layer module with pure helpers (TDD'd) and Supabase wrapper functions consumed by `analysis.js`.
- A new `playlist-rail.js` UI module that renders the fourth column (master/detail), the ★-button save popover, and play-all controls. Wires into existing `state.viewRoundIdx` / `state.gren.playlist` machinery in `analysis.js` rather than duplicating playback logic.
- Polish items live alongside existing analysis code (small CSS class toggles, one global `keydown` handler, simple `localStorage` keys).

**Tech Stack:**
- Vanilla ES modules, no build step (matches existing cs2-hub conventions).
- Supabase JS v2 (already imported via `cs2-hub/supabase.js`).
- HTML `*.test.html` files for unit tests of pure helpers (matches the `analysis-rounds.test.html` pattern).
- CSS uses existing tokens (`--accent`, `--glass-bg`, `--glass-border`, `--display-font`, etc.) — no new tokens.

**Spec:** `docs/superpowers/specs/2026-05-06-analysis-playlists-and-polish.md`

**File map (created or modified):**

- Create `cs2-hub/supabase-playlists.sql` — schema + RLS for `playlists`, `playlist_rounds`.
- Create `cs2-hub/playlists.js` — data layer (Supabase calls + pure helpers).
- Create `cs2-hub/playlists.test.html` — unit tests for the pure helpers.
- Create `cs2-hub/playlist-rail.js` — UI module (rail rendering, save popover, play-all wiring).
- Modify `cs2-hub/analysis.html` — add fourth-column markup, save-button slot, popover container, onboarding hint, keyboard-help overlay.
- Modify `cs2-hub/analysis.js` — wire `playlist-rail` into team-change / mode-change / single-round flows; add keyboard shortcuts; loading & empty state branches.
- Modify `cs2-hub/style.css` — playlist-rail styles, save-popover styles, collapsed-filter-rail variant, onboarding-hint styles, kb-help overlay styles.

---

## Task 1: SQL schema + RLS

**Files:**
- Create: `cs2-hub/supabase-playlists.sql`

- [ ] **Step 1: Write the SQL file**

```sql
-- cs2-hub/supabase-playlists.sql
-- Run in Supabase SQL Editor after supabase-demos.sql
--
-- Adds team-shared round playlists for the analysis page. RLS mirrors the
-- demos pattern: a user can read all playlists for any team they have
-- uploaded a demo for; writes are scoped to the row's creator.

create table playlists (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null,
  name        text not null,
  description text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table playlist_rounds (
  id          uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references playlists(id) on delete cascade,
  demo_id     uuid not null references demos(id)     on delete cascade,
  round_idx   int  not null,
  note        text,
  position    int  not null,
  added_by    uuid references auth.users(id),
  added_at    timestamptz default now(),
  unique (playlist_id, demo_id, round_idx)
);

create index playlists_team_updated_idx
  on playlists (team_id, updated_at desc);

create index playlist_rounds_playlist_position_idx
  on playlist_rounds (playlist_id, position);

alter table playlists        enable row level security;
alter table playlist_rounds  enable row level security;

-- playlists: any authenticated user who has uploaded a demo for the same team
-- can read; writes are scoped to created_by = auth.uid().
create policy "team_playlists_select" on playlists
  for select to authenticated
  using (team_id IN (
    select distinct team_id from demos d where d.uploaded_by = auth.uid()
  ));

create policy "team_playlists_insert" on playlists
  for insert to authenticated
  with check (
    created_by = auth.uid()
    AND team_id IN (
      select distinct team_id from demos d where d.uploaded_by = auth.uid()
    )
  );

create policy "team_playlists_update" on playlists
  for update to authenticated
  using (team_id IN (
    select distinct team_id from demos d where d.uploaded_by = auth.uid()
  ))
  with check (team_id IN (
    select distinct team_id from demos d where d.uploaded_by = auth.uid()
  ));

create policy "team_playlists_delete" on playlists
  for delete to authenticated
  using (team_id IN (
    select distinct team_id from demos d where d.uploaded_by = auth.uid()
  ));

-- playlist_rounds: gated through the parent playlist's team_id.
create policy "team_playlist_rounds_select" on playlist_rounds
  for select to authenticated
  using (playlist_id IN (
    select id from playlists p where p.team_id IN (
      select distinct team_id from demos d where d.uploaded_by = auth.uid()
    )
  ));

create policy "team_playlist_rounds_insert" on playlist_rounds
  for insert to authenticated
  with check (
    added_by = auth.uid()
    AND playlist_id IN (
      select id from playlists p where p.team_id IN (
        select distinct team_id from demos d where d.uploaded_by = auth.uid()
      )
    )
  );

create policy "team_playlist_rounds_update" on playlist_rounds
  for update to authenticated
  using (playlist_id IN (
    select id from playlists p where p.team_id IN (
      select distinct team_id from demos d where d.uploaded_by = auth.uid()
    )
  ));

create policy "team_playlist_rounds_delete" on playlist_rounds
  for delete to authenticated
  using (playlist_id IN (
    select id from playlists p where p.team_id IN (
      select distinct team_id from demos d where d.uploaded_by = auth.uid()
    )
  ));
```

- [ ] **Step 2: Run the migration manually in Supabase**

Tell the user to run this file in the Supabase SQL Editor (the project has no migration tool — every other `.sql` file under `cs2-hub/` is run by hand the same way; see the comment at the top of `supabase-demos.sql`).

After running, verify in the Supabase Dashboard:
- Tables `playlists` and `playlist_rounds` exist under the `public` schema.
- RLS shows "Enabled" for both.
- Inserting a row as the current user succeeds; reading another team's playlists returns nothing.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/supabase-playlists.sql
git commit -m "feat(playlists): add schema + RLS for team-shared round playlists"
```

---

## Task 2: `playlists.js` — pure helpers (TDD)

The module has two layers: pure helpers (no Supabase, easy to unit-test) and Supabase wrappers (Task 3). This task does only the pure helpers and their tests.

**Files:**
- Create: `cs2-hub/playlists.js`
- Test: `cs2-hub/playlists.test.html`

The pure helpers handle ordering / dedup / position math so the Supabase layer stays thin.

- [ ] **Step 1: Write the failing tests**

Create `cs2-hub/playlists.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<h1>playlists.js tests</h1>
<pre id="out"></pre>
<script type="module">
import { nextPosition, sortByPosition, dedupeKey, isRoundInPlaylist } from './playlists.js'

const out = document.getElementById('out')
let pass = 0, fail = 0
function assert(cond, msg) {
  const line = (cond ? '✓ ' : '✗ ') + msg
  out.textContent += line + '\n'
  if (cond) pass++; else fail++
}

// nextPosition: appends after the largest position; empty list returns 0.
assert(nextPosition([])           === 0, 'nextPosition([]) === 0')
assert(nextPosition([{position:0}]) === 1, 'nextPosition([0]) === 1')
assert(nextPosition([{position:5},{position:2},{position:9}]) === 10,
       'nextPosition picks max+1 even when unsorted')

// sortByPosition: stable ascending, does not mutate input.
const input = [{id:'b',position:2},{id:'a',position:0},{id:'c',position:1}]
const sorted = sortByPosition(input)
assert(sorted.map(r=>r.id).join(',') === 'a,c,b', 'sortByPosition orders ascending')
assert(input[0].id === 'b', 'sortByPosition does not mutate input')

// dedupeKey: stable identity for (demoId, roundIdx).
assert(dedupeKey('d1', 0) === dedupeKey('d1', 0), 'same key same demo+round')
assert(dedupeKey('d1', 0) !== dedupeKey('d1', 1), 'different round → different key')
assert(dedupeKey('d1', 0) !== dedupeKey('d2', 0), 'different demo → different key')

// isRoundInPlaylist: true when any row matches.
const rows = [{demo_id:'d1',round_idx:3},{demo_id:'d2',round_idx:0}]
assert(isRoundInPlaylist(rows, 'd1', 3)  === true,  'matches existing row')
assert(isRoundInPlaylist(rows, 'd1', 0)  === false, 'wrong round')
assert(isRoundInPlaylist(rows, 'd9', 3)  === false, 'wrong demo')
assert(isRoundInPlaylist([],   'd1', 3)  === false, 'empty list')

out.textContent += `\n${pass} passed, ${fail} failed`
</script>
</body>
</html>
```

- [ ] **Step 2: Run test, confirm it fails**

Open `cs2-hub/playlists.test.html` in the browser. Expected output: console error / blank page because `playlists.js` doesn't export those names yet.

- [ ] **Step 3: Implement the helpers**

Create `cs2-hub/playlists.js` with just the pure helpers (Supabase wrappers come in Task 3):

```javascript
// cs2-hub/playlists.js
//
// Team-shared round playlists for the analysis page. Two layers:
//   - Pure helpers (this section) — testable in isolation.
//   - Supabase wrappers (added in Task 3).

// ── Pure helpers ────────────────────────────────────────────────

/** Next `position` value when appending to a list of playlist_rounds rows. */
export function nextPosition(rows) {
  if (!rows.length) return 0
  let max = -1
  for (const r of rows) if (r.position > max) max = r.position
  return max + 1
}

/** Stable ascending-by-position copy. Does not mutate input. */
export function sortByPosition(rows) {
  return rows.slice().sort((a, b) => a.position - b.position)
}

/** Composite identity for (demoId, roundIdx) used for client-side dedup checks. */
export function dedupeKey(demoId, roundIdx) {
  return `${demoId}|${roundIdx}`
}

/** True if any row in the list points at (demoId, roundIdx). */
export function isRoundInPlaylist(rows, demoId, roundIdx) {
  for (const r of rows) {
    if (r.demo_id === demoId && r.round_idx === roundIdx) return true
  }
  return false
}
```

- [ ] **Step 4: Run test, confirm pass**

Reload `cs2-hub/playlists.test.html`. Expected: all assertions pass; final line `13 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/playlists.js cs2-hub/playlists.test.html
git commit -m "feat(playlists): add pure helpers for ordering and dedup"
```

---

## Task 3: `playlists.js` — Supabase data layer

**Files:**
- Modify: `cs2-hub/playlists.js`

These are thin Supabase wrappers; we don't unit-test them (they require a network round-trip). Manual smoke-test through the UI in later tasks.

- [ ] **Step 1: Add Supabase imports and CRUD wrappers**

Append to `cs2-hub/playlists.js`:

```javascript
// ── Supabase wrappers ───────────────────────────────────────────

import { supabase } from './supabase.js'

/** List all playlists for a team, sorted by most-recent activity first. */
export async function loadPlaylists(teamId) {
  const { data, error } = await supabase
    .from('playlists')
    .select('id, team_id, name, description, created_by, created_at, updated_at')
    .eq('team_id', teamId)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

/** List rounds inside a playlist, ordered by `position`. */
export async function loadPlaylistRounds(playlistId) {
  const { data, error } = await supabase
    .from('playlist_rounds')
    .select('id, playlist_id, demo_id, round_idx, note, position, added_by, added_at')
    .eq('playlist_id', playlistId)
    .order('position', { ascending: true })
  if (error) throw error
  return data ?? []
}

/** Find every playlist that already contains (demoId, roundIdx) for a team.
    Returns an array of { playlist_id, playlist_name, playlist_round_id, note }. */
export async function findRoundMemberships(teamId, demoId, roundIdx) {
  const { data, error } = await supabase
    .from('playlist_rounds')
    .select('id, note, playlist_id, playlists!inner(name, team_id)')
    .eq('demo_id', demoId)
    .eq('round_idx', roundIdx)
    .eq('playlists.team_id', teamId)
  if (error) throw error
  return (data ?? []).map(r => ({
    playlist_id:       r.playlist_id,
    playlist_name:     r.playlists?.name ?? '',
    playlist_round_id: r.id,
    note:              r.note ?? '',
  }))
}

/** Create a playlist. Returns the inserted row. */
export async function createPlaylist(teamId, name, userId) {
  const { data, error } = await supabase
    .from('playlists')
    .insert({ team_id: teamId, name, created_by: userId })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function renamePlaylist(playlistId, name) {
  const { error } = await supabase
    .from('playlists')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', playlistId)
  if (error) throw error
}

export async function deletePlaylist(playlistId) {
  const { error } = await supabase.from('playlists').delete().eq('id', playlistId)
  if (error) throw error
}

/** Append a round to a playlist. Caller passes the current rows so we can
    compute the next `position` without an extra round-trip. Touches the
    parent playlist's `updated_at` so the rail re-sorts on next load. */
export async function addRoundToPlaylist({ playlistId, demoId, roundIdx, note, currentRows, userId }) {
  const position = nextPosition(currentRows)
  const { data, error } = await supabase
    .from('playlist_rounds')
    .insert({
      playlist_id: playlistId,
      demo_id:     demoId,
      round_idx:   roundIdx,
      note:        note || null,
      position,
      added_by:    userId,
    })
    .select()
    .single()
  if (error) throw error
  await touchPlaylist(playlistId)
  return data
}

export async function removeRoundFromPlaylist(playlistRoundId, playlistId) {
  const { error } = await supabase
    .from('playlist_rounds')
    .delete()
    .eq('id', playlistRoundId)
  if (error) throw error
  await touchPlaylist(playlistId)
}

export async function updateRoundNote(playlistRoundId, note, playlistId) {
  const { error } = await supabase
    .from('playlist_rounds')
    .update({ note: note || null })
    .eq('id', playlistRoundId)
  if (error) throw error
  await touchPlaylist(playlistId)
}

/** Move a round to a new `position` value (caller computes the value). */
export async function reorderPlaylistRound(playlistRoundId, newPosition, playlistId) {
  const { error } = await supabase
    .from('playlist_rounds')
    .update({ position: newPosition })
    .eq('id', playlistRoundId)
  if (error) throw error
  await touchPlaylist(playlistId)
}

async function touchPlaylist(playlistId) {
  await supabase
    .from('playlists')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', playlistId)
}
```

- [ ] **Step 2: Verify the file parses**

Open `cs2-hub/playlists.test.html` in the browser. Expected: same 13 passed, 0 failed (the new exports don't break the test page; the import at the top still resolves).

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/playlists.js
git commit -m "feat(playlists): add Supabase CRUD wrappers"
```

---

## Task 4: Layout — fourth column markup + base CSS

We add the empty rail container and its styles. No data wiring yet (that comes in Task 5). The rail is hidden when no team is picked, matching the existing player/grenade panels.

**Files:**
- Modify: `cs2-hub/analysis.html`
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Add the rail markup to `analysis.html`**

In `cs2-hub/analysis.html`, inside `<div class="analysis-body">`, immediately after the `<aside class="grenade-panel" id="grenade-panel">…</aside>` block (around line 556), add:

```html
        <aside class="playlist-rail" id="playlist-rail">
          <!-- Rail content rendered by playlist-rail.js -->
        </aside>
```

- [ ] **Step 2: Add ★ button slot to round-nav**

In `cs2-hub/analysis.html`, replace the existing `<div class="pp-round-nav" id="pp-round-nav" …>` block (around line 513-517) with:

```html
          <div class="pp-round-nav" id="pp-round-nav" style="display:none">
            <button class="pp-nav-btn" id="pp-round-prev">◀</button>
            <span class="pp-round-label" id="pp-round-label">Round 1 / 1</span>
            <button class="pp-nav-btn pp-save-btn" id="pp-save-btn" title="Save round to playlist">☆</button>
            <button class="pp-nav-btn" id="pp-round-next">▶</button>
          </div>
```

- [ ] **Step 3: Add the popover and overlay containers**

In `cs2-hub/analysis.html`, just before the closing `</main>` (around line 576), add:

```html
    <div id="save-popover" class="save-popover" hidden></div>
    <div id="kb-help-overlay" class="kb-help-overlay" hidden></div>
    <div id="onboarding-hint" class="onboarding-hint" hidden></div>
```

- [ ] **Step 4: Add CSS for the rail**

Append to `cs2-hub/style.css` (at the end of the file):

```css
/* ── Analysis: playlist rail (4th column) ─────────────────────── */
.playlist-rail {
  flex: 0 0 220px;
  display: none; flex-direction: column;
  background: rgba(11,15,20,0.72);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-left: 1px solid var(--glass-border);
  overflow: hidden;
}
.playlist-rail.show { display: flex; }

.pr-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.pr-title {
  font-family: var(--display-font);
  font-size: 11px; font-weight: 700;
  color: var(--accent);
  text-transform: uppercase; letter-spacing: 0.18em;
  flex: 1; min-width: 0;
}
.pr-icon-btn {
  background: transparent;
  border: 1px solid var(--border-solid);
  color: var(--muted);
  width: 22px; height: 22px;
  border-radius: var(--r-sm);
  cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px;
  transition: color 0.15s, border-color 0.15s;
}
.pr-icon-btn:hover { color: var(--accent); border-color: var(--accent); }

.pr-list { flex: 1; overflow-y: auto; padding: 6px; }

.pr-pl-row {
  display: flex; flex-direction: column; gap: 2px;
  padding: 8px 10px; cursor: pointer;
  border-radius: var(--r-sm);
  border-left: 2px solid transparent;
  transition: background-color 0.12s, border-color 0.12s, color 0.12s;
}
.pr-pl-row:hover { background: rgba(0,255,156,0.06); }
.pr-pl-row.active {
  background: rgba(0,255,156,0.10);
  border-left-color: var(--accent);
}
.pr-pl-name { font-size: 13px; font-weight: 600; color: var(--text); }
.pr-pl-meta { font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }

.pr-round-row {
  display: grid;
  grid-template-columns: 28px 1fr 14px;
  gap: 8px; align-items: center;
  padding: 6px 8px; cursor: pointer;
  border-radius: var(--r-sm);
  border-left: 2px solid transparent;
  transition: background-color 0.12s, border-color 0.12s;
}
.pr-round-row:hover { background: rgba(0,255,156,0.06); }
.pr-round-row.active {
  background: rgba(0,255,156,0.10);
  border-left-color: var(--accent);
}
.pr-round-thumb {
  width: 28px; height: 28px;
  border-radius: var(--r-sm);
  background-size: cover; background-position: center;
  background-color: rgba(255,255,255,0.04);
}
.pr-round-meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.pr-round-title {
  font-size: 11px; color: var(--text); font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.pr-round-note {
  font-size: 10px; color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pr-round-side-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}
.pr-round-side-dot.ct { background: #4a90e2; }
.pr-round-side-dot.t  { background: #d99c2b; }
.pr-round-x {
  background: transparent; border: none; cursor: pointer;
  color: var(--muted); font-size: 13px; padding: 0; line-height: 1;
}
.pr-round-x:hover { color: var(--danger); }

.pr-empty {
  padding: 12px; font-size: 11px; color: var(--muted);
  text-align: center;
}
.pr-skel {
  height: 36px; margin: 6px 6px 0;
  background: linear-gradient(90deg, rgba(255,255,255,0.03), rgba(255,255,255,0.06), rgba(255,255,255,0.03));
  background-size: 200% 100%;
  animation: pr-skel-shimmer 1.4s ease-in-out infinite;
  border-radius: var(--r-sm);
}
@keyframes pr-skel-shimmer {
  0%   { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

.pr-detail-header {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.pr-back {
  background: transparent; border: none; cursor: pointer;
  color: var(--accent); font-size: 14px; padding: 0 4px;
}
.pr-detail-name { flex: 1; min-width: 0; font-size: 12px; font-weight: 700; color: var(--text); }
.pr-play-all {
  background: var(--accent); color: var(--accent-on);
  border: none; border-radius: var(--r-sm);
  padding: 4px 8px; font-size: 11px; font-weight: 700;
  cursor: pointer;
}

.pp-save-btn { font-size: 14px; color: var(--accent); }
.pp-save-btn.saved { color: var(--accent); }
```

- [ ] **Step 5: Smoke-test in browser**

Open `cs2-hub/analysis.html` in a browser. Expected: page renders, no JS errors. Rail container is in the DOM but `display: none` (no `.show` class). The ☆ button is in the round-nav block but the round-nav itself is hidden.

- [ ] **Step 6: Commit**

```bash
git add cs2-hub/analysis.html cs2-hub/style.css
git commit -m "feat(analysis): add playlist rail + save-button markup and base styles"
```

---

## Task 5: `playlist-rail.js` — render the playlist list

The rail has two views (master = list of playlists; detail = rounds in one playlist). This task implements the master view only and shows it after a team is picked. Detail view comes in Task 6.

**Files:**
- Create: `cs2-hub/playlist-rail.js`
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Create `playlist-rail.js` with mount + master render**

Create `cs2-hub/playlist-rail.js`:

```javascript
// cs2-hub/playlist-rail.js
//
// UI for the analysis-page playlist rail (4th column). Two views:
//   - Master: list of team playlists.
//   - Detail: rounds inside a single playlist.
// Wires into analysis.js via the {onLoadRound, onPlayAll, getCurrentTeamId,
// getDemoMeta} hooks passed at mount time.

import { toast } from './toast.js'
import { supabase } from './supabase.js'
import {
  loadPlaylists, loadPlaylistRounds,
  createPlaylist, renamePlaylist, deletePlaylist,
  addRoundToPlaylist, removeRoundFromPlaylist, updateRoundNote,
  findRoundMemberships, sortByPosition,
} from './playlists.js'

let host = null
let hooks = null
const state = {
  teamId:        null,
  playlists:     [],     // master list
  loadingMaster: false,
  openId:        null,   // when set, detail view is shown for this playlist id
  openRows:      [],     // playlist_rounds rows for openId, sorted by position
  loadingDetail: false,
  activeRoundKey: null,  // `${demoId}|${roundIdx}` of currently-playing playlist round
}

export function mount(rootEl, h) {
  host = rootEl
  hooks = h
  render()
}

export function unmount() {
  host = null
  hooks = null
}

export async function setTeam(teamId) {
  state.teamId = teamId
  state.openId = null
  state.openRows = []
  if (!teamId) { state.playlists = []; render(); return }
  state.loadingMaster = true
  render()
  try {
    state.playlists = await loadPlaylists(teamId)
  } catch (e) {
    console.error('[playlist-rail] loadPlaylists failed:', e)
    toast('Failed to load playlists', 'error')
    state.playlists = []
  }
  state.loadingMaster = false
  render()
}

/** Called from analysis.js whenever single-round playback enters/leaves a
    saved playlist round, so the rail can highlight the active row. */
export function setActiveRoundKey(key) {
  state.activeRoundKey = key
  render()
}

function render() {
  if (!host) return
  if (state.openId) renderDetail()
  else              renderMaster()
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function renderMaster() {
  const skel = state.loadingMaster
    ? `<div class="pr-skel"></div><div class="pr-skel"></div><div class="pr-skel"></div>`
    : ''
  const empty = !state.loadingMaster && !state.playlists.length
    ? `<div class="pr-empty">No playlists yet · click + to create one.</div>`
    : ''
  const rows = state.playlists.map(p => `
    <div class="pr-pl-row" data-id="${esc(p.id)}">
      <div class="pr-pl-name">${esc(p.name)}</div>
      <div class="pr-pl-meta">${formatRelative(p.updated_at)}</div>
    </div>
  `).join('')

  host.innerHTML = `
    <div class="pr-header">
      <span class="pr-title">Playlists</span>
      <button class="pr-icon-btn" id="pr-new" title="New playlist">+</button>
    </div>
    <div class="pr-list">${skel}${empty}${rows}</div>
  `

  host.querySelector('#pr-new').addEventListener('click', onNewPlaylistClick)
  for (const row of host.querySelectorAll('.pr-pl-row')) {
    row.addEventListener('click', () => openPlaylist(row.dataset.id))
  }
}

function formatRelative(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const days = Math.round((Date.now() - d.getTime()) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7)  return `${days}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

async function onNewPlaylistClick() {
  const name = prompt('Playlist name:')
  if (!name || !name.trim()) return
  if (!state.teamId) return
  try {
    const userId = (await supabase.auth.getUser()).data.user?.id
    const row = await createPlaylist(state.teamId, name.trim(), userId)
    state.playlists.unshift(row)
    toast('Playlist created')
    render()
  } catch (e) {
    console.error(e); toast('Failed to create playlist', 'error')
  }
}

async function openPlaylist(id) {
  state.openId = id
  state.openRows = []
  state.loadingDetail = true
  render()
  try {
    const rows = await loadPlaylistRounds(id)
    state.openRows = sortByPosition(rows)
  } catch (e) {
    console.error(e); toast('Failed to load playlist', 'error')
  }
  state.loadingDetail = false
  render()
}

// Detail view stubs — Task 6 fills these in.
function renderDetail() {
  host.innerHTML = `
    <div class="pr-detail-header">
      <button class="pr-back" id="pr-back">←</button>
      <span class="pr-detail-name">${esc(currentPlaylist()?.name ?? '')}</span>
    </div>
    <div class="pr-list"><div class="pr-empty">Detail view coming in Task 6.</div></div>
  `
  host.querySelector('#pr-back').addEventListener('click', () => {
    state.openId = null; state.openRows = []; render()
  })
}

function currentPlaylist() {
  return state.playlists.find(p => p.id === state.openId)
}
```

- [ ] **Step 2: Wire `playlist-rail` into `analysis.js`**

At the top of `cs2-hub/analysis.js` (after the existing imports around line 1-7), add:

```javascript
import * as playlistRail from './playlist-rail.js'
```

Then find `onTeamChanged()` (around line 127). Add the rail mount + setTeam at the end of the function:

```javascript
async function onTeamChanged() {
  if (!state.team) return
  showChip('Loading corpus…', 'info')
  state.corpus = await loadCorpus(state.team)
  hideChip('Loading corpus…')
  renderFilterRail()
  if (state.filters.map) loadMapImage(state.filters.map)
  await reloadRoundSet()

  // Mount + populate the playlist rail (added by Task 5).
  const railEl = document.getElementById('playlist-rail')
  railEl.classList.add('show')
  if (!railEl.dataset.mounted) {
    playlistRail.mount(railEl, {
      // Hooks added across Tasks 6-9. Task 5 only needs setTeam.
    })
    railEl.dataset.mounted = '1'
  }
  await playlistRail.setTeam(getTeamId())
}
```

- [ ] **Step 3: Smoke-test**

Reload `cs2-hub/analysis.html` in the browser, pick a team. Expected:
- The fourth column appears with header "PLAYLISTS" and a `+` button.
- Skeleton rows appear briefly, then either the empty-state message or the team's existing playlists.
- Clicking `+` prompts for a name and creates a row that appears at the top.
- Clicking a playlist row swaps the rail to a stub "detail" view; clicking `←` returns.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/playlist-rail.js cs2-hub/analysis.js
git commit -m "feat(analysis): mount playlist rail with master view and create flow"
```

---

## Task 6: Detail view — render rounds with thumbs/scores/notes

This task fills in `renderDetail()` and adds a small DOM helper for resolving each round's display info (map thumbnail, round number, score, side, note).

**Files:**
- Modify: `cs2-hub/playlist-rail.js`
- Modify: `cs2-hub/analysis.js` (add a `getDemoMeta` hook so the rail can look up demo info)

- [ ] **Step 1: Add `getDemoMeta` hook in `analysis.js`**

At the top of `analysis.js`, in the `playlistRail.mount(...)` call from Task 5, expand `hooks` so the rail can read demo metadata:

```javascript
    playlistRail.mount(railEl, {
      getDemoMeta: async (demoId) => {
        // Try the corpus first (zero round-trips for the common case where
        // the playlist references a demo for the same team).
        const fromCorpus = state.corpus.find(d => d.id === demoId)
        if (fromCorpus) return fromCorpus
        // Fallback: pull just the metadata columns we need.
        const { data, error } = await supabase
          .from('demos')
          .select('id, map, played_at, ct_team_name, t_team_name, score_ct, score_t, team_a_first_side, team_a_score, team_b_score')
          .eq('id', demoId).maybeSingle()
        if (error) { console.warn('[analysis] getDemoMeta failed:', error); return null }
        return data
      },
    })
```

- [ ] **Step 2: Replace stub `renderDetail()` in `playlist-rail.js`**

Replace the stub `renderDetail()` and `currentPlaylist()` block with:

```javascript
function renderDetail() {
  const pl = currentPlaylist()
  const skel = state.loadingDetail
    ? `<div class="pr-skel"></div><div class="pr-skel"></div>`
    : ''
  const empty = !state.loadingDetail && !state.openRows.length
    ? `<div class="pr-empty">Empty playlist · click ★ on a round to add one.</div>`
    : ''

  host.innerHTML = `
    <div class="pr-detail-header">
      <button class="pr-back" id="pr-back" title="Back">←</button>
      <span class="pr-detail-name">${esc(pl?.name ?? '')}</span>
      ${state.openRows.length ? `<button class="pr-play-all" id="pr-play-all">▶ Play all</button>` : ''}
    </div>
    <div class="pr-list" id="pr-rounds">${skel}${empty}</div>
  `

  host.querySelector('#pr-back').addEventListener('click', () => {
    state.openId = null; state.openRows = []; render()
  })
  host.querySelector('#pr-play-all')?.addEventListener('click', onPlayAllClick)

  if (!state.loadingDetail && state.openRows.length) hydrateRoundRows()
}

async function hydrateRoundRows() {
  const listEl = host.querySelector('#pr-rounds')
  const metas = await Promise.all(state.openRows.map(r => hooks.getDemoMeta(r.demo_id)))

  listEl.innerHTML = state.openRows.map((r, i) => {
    const meta = metas[i]
    const info = describeRound(r, meta)
    const key  = `${r.demo_id}|${r.round_idx}`
    const active = state.activeRoundKey === key ? ' active' : ''
    const thumb = info.mapFile ? `images/maps/${info.mapFile}.png` : ''
    return `
      <div class="pr-round-row${active}" data-row-id="${esc(r.id)}" data-key="${esc(key)}">
        <div class="pr-round-thumb" style="background-image:url('${esc(thumb)}')"></div>
        <div class="pr-round-meta">
          <div class="pr-round-title">
            <span class="pr-round-side-dot ${info.side}"></span>R${r.round_idx + 1} · ${esc(info.score)}
          </div>
          <div class="pr-round-note" title="${esc(r.note ?? '')}">${esc(r.note ?? '')}</div>
        </div>
        <button class="pr-round-x" data-row-id="${esc(r.id)}" title="Remove">✕</button>
      </div>
    `
  }).join('')

  for (const row of listEl.querySelectorAll('.pr-round-row')) {
    row.addEventListener('click', e => {
      if (e.target.closest('.pr-round-x')) return  // remove button handled below
      const id = row.dataset.rowId
      const playlistRow = state.openRows.find(x => x.id === id)
      if (playlistRow) hooks.onLoadRound?.(playlistRow)
    })
  }
  for (const x of listEl.querySelectorAll('.pr-round-x')) {
    x.addEventListener('click', e => {
      e.stopPropagation()
      onRemoveRoundClick(x.dataset.rowId)
    })
  }
}

/** Build display fields (side, score, mapFile) from a playlist_rounds row
    and the demo metadata. Mirrors the score-derivation rules already used
    in analysis.js / demos.js. */
function describeRound(row, meta) {
  if (!meta) return { side: 'ct', score: '?–?', mapFile: '' }
  // Side: rough heuristic — pre-halftime (round_idx < 12) the row's
  // ct_team_name is the CT side; after halftime sides flip.
  // We don't know which team owns the playlist viewer, so we just show
  // the round's CT/T mapping by index. The dot reads "what side did the
  // first-named team play this round" which is a reasonable display.
  const half  = Math.floor(row.round_idx / 12)
  const side  = (half % 2 === 0) ? 'ct' : 't'
  const score = (meta.score_ct != null && meta.score_t != null)
    ? `${meta.score_ct}–${meta.score_t}`
    : '—'
  const mapFile = (meta.map ?? '').replace(/^de_/, '').toLowerCase() || ''
  return { side, score, mapFile }
}

async function onRemoveRoundClick(rowId) {
  if (!confirm('Remove round from playlist?')) return
  const row = state.openRows.find(x => x.id === rowId)
  if (!row) return
  try {
    await removeRoundFromPlaylist(row.id, state.openId)
    state.openRows = state.openRows.filter(x => x.id !== rowId)
    toast('Removed')
    render()
  } catch (e) { console.error(e); toast('Failed to remove', 'error') }
}

function onPlayAllClick() {
  if (!state.openRows.length) return
  hooks.onPlayAll?.(state.openRows.slice())
}

function currentPlaylist() {
  return state.playlists.find(p => p.id === state.openId)
}
```

- [ ] **Step 3: Smoke-test**

Reload analysis page, pick a team, create a playlist (no rounds yet). Click into the playlist. Expected: detail view with the playlist name, back arrow, empty-state message ("Empty playlist · click ★ on a round to add one."), no "Play all" button.

After Task 7 is done, real rows will render here.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/playlist-rail.js cs2-hub/analysis.js
git commit -m "feat(analysis): render playlist detail rows with thumbs and notes"
```

---

## Task 7: ★ Save flow — popover and add-to-playlist

The ★ button is already in the DOM (Task 4). Now wire it: clicking it opens an inline popover showing existing playlists and a note input. The popover state is local to `playlist-rail.js`; it surfaces through the global `#save-popover` container so it can float above the canvas.

**Files:**
- Modify: `cs2-hub/playlist-rail.js`
- Modify: `cs2-hub/analysis.js`
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Add popover styles**

Append to `cs2-hub/style.css`:

```css
/* ── Save popover ─────────────────────────────────────────────── */
.save-popover {
  position: fixed; z-index: 1000;
  width: 260px;
  background: var(--glass-bg);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
  box-shadow: 0 8px 28px rgba(0,0,0,0.45);
  padding: 10px;
  font-size: 12px;
  color: var(--text);
}
.save-popover[hidden] { display: none; }
.save-popover h4 {
  margin: 0 0 8px;
  font-family: var(--display-font);
  font-size: 10px; font-weight: 700;
  color: var(--accent);
  text-transform: uppercase; letter-spacing: 0.18em;
}
.save-popover-list { max-height: 180px; overflow-y: auto; margin-bottom: 8px; }
.save-popover-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 6px;
  cursor: pointer; border-radius: var(--r-sm);
}
.save-popover-row:hover { background: rgba(0,255,156,0.06); }
.save-popover-row input[type="radio"] { accent-color: var(--accent); }
.save-popover-row .name  { flex: 1; min-width: 0; }
.save-popover-row .count { font-size: 10px; color: var(--muted); }
.save-popover-row .x {
  background: transparent; border: none; cursor: pointer;
  color: var(--muted); font-size: 13px; padding: 0 4px;
}
.save-popover-row .x:hover { color: var(--danger); }
.save-popover input[type="text"] {
  width: 100%; box-sizing: border-box;
  background: var(--input-bg);
  border: 1px solid var(--border-solid);
  border-radius: var(--r-sm);
  padding: 5px 7px; font-size: 12px;
  color: var(--text);
}
.save-popover-actions {
  display: flex; gap: 6px; margin-top: 8px;
}
.save-popover-actions button {
  flex: 1; padding: 5px 0;
  font-family: var(--display-font);
  font-size: 11px; font-weight: 700;
  border-radius: var(--r-sm); cursor: pointer;
  letter-spacing: 0.06em;
}
.save-popover .btn-primary {
  background: var(--accent); color: var(--accent-on); border: none;
}
.save-popover .btn-secondary {
  background: transparent; color: var(--muted);
  border: 1px solid var(--border-solid);
}
.save-popover .btn-secondary:hover { color: var(--accent); border-color: var(--accent); }
.save-popover .new-link {
  display: block; margin-top: 4px; padding: 5px 6px;
  color: var(--accent); cursor: pointer; font-size: 11px;
}
.save-popover .new-link:hover { background: rgba(0,255,156,0.06); border-radius: var(--r-sm); }
```

- [ ] **Step 2: Add popover logic to `playlist-rail.js`**

Append to `cs2-hub/playlist-rail.js`:

```javascript
// ── Save popover ────────────────────────────────────────────────
//
// One popover instance lives in #save-popover and is owned by this module.
// analysis.js calls openSavePopoverFor() with the current round; the popover
// queries memberships and renders save-mode (round not yet saved) or
// manage-mode (round already in 1+ playlists).

let popoverState = null

export async function openSavePopoverFor({ demoId, roundIdx, anchorRect }) {
  if (!state.teamId) return
  const popEl = document.getElementById('save-popover')
  popoverState = { demoId, roundIdx, memberships: [], showCreate: false, newName: '', note: '', selectedId: null }
  positionPopover(popEl, anchorRect)
  popEl.hidden = false
  popEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--muted)">Loading…</div>`
  try {
    popoverState.memberships = await findRoundMemberships(state.teamId, demoId, roundIdx)
  } catch (e) { console.error(e); toast('Failed to load playlists', 'error') }
  renderPopover()
}

export function closeSavePopover() {
  const popEl = document.getElementById('save-popover')
  if (popEl) popEl.hidden = true
  popoverState = null
}

export function isPopoverOpen() {
  return !!popoverState
}

function positionPopover(popEl, anchorRect) {
  if (!anchorRect) return
  const margin = 6
  // Anchor below+right of the button. Clamp to viewport.
  let top  = anchorRect.bottom + margin
  let left = anchorRect.left
  const w  = 260, h = 280
  if (left + w > window.innerWidth)  left = Math.max(8, window.innerWidth  - w - 8)
  if (top  + h > window.innerHeight) top  = Math.max(8, anchorRect.top - h - margin)
  popEl.style.top  = `${top}px`
  popEl.style.left = `${left}px`
}

function renderPopover() {
  const popEl = document.getElementById('save-popover')
  if (!popEl || !popoverState) return
  const { memberships, showCreate, selectedId, note, newName } = popoverState
  const inSaveMode = memberships.length === 0 || popoverState.addingMore

  if (inSaveMode) {
    const candidates = state.playlists.filter(p =>
      !memberships.some(m => m.playlist_id === p.id))
    popEl.innerHTML = `
      <h4>Add to playlist</h4>
      <div class="save-popover-list">
        ${candidates.length ? candidates.map(p => `
          <label class="save-popover-row">
            <input type="radio" name="pl" value="${esc(p.id)}" ${selectedId === p.id ? 'checked' : ''}>
            <span class="name">${esc(p.name)}</span>
          </label>
        `).join('') : `<div class="pr-empty" style="padding:6px">No playlists yet.</div>`}
        ${showCreate
          ? `<input type="text" id="pop-new-name" placeholder="New playlist name" value="${esc(newName)}">`
          : `<a class="new-link" id="pop-show-new">+ New playlist</a>`}
      </div>
      <input type="text" id="pop-note" placeholder="Note (optional, e.g. 'B rotation at 0:38')" value="${esc(note)}">
      <div class="save-popover-actions">
        <button class="btn-secondary" id="pop-cancel">Cancel</button>
        <button class="btn-primary"   id="pop-save">Save</button>
      </div>
    `
    for (const r of popEl.querySelectorAll('input[name="pl"]')) {
      r.addEventListener('change', () => { popoverState.selectedId = r.value })
    }
    popEl.querySelector('#pop-show-new')?.addEventListener('click', () => {
      popoverState.showCreate = true; renderPopover()
      popEl.querySelector('#pop-new-name')?.focus()
    })
    popEl.querySelector('#pop-new-name')?.addEventListener('input', e => {
      popoverState.newName = e.target.value
    })
    popEl.querySelector('#pop-note').addEventListener('input', e => {
      popoverState.note = e.target.value
    })
    popEl.querySelector('#pop-cancel').addEventListener('click', closeSavePopover)
    popEl.querySelector('#pop-save').addEventListener('click', onSavePopoverSubmit)
  } else {
    // Manage mode — list memberships with note + remove.
    popEl.innerHTML = `
      <h4>Saved in ${memberships.length} playlist${memberships.length === 1 ? '' : 's'}</h4>
      <div class="save-popover-list">
        ${memberships.map(m => `
          <div class="save-popover-row" data-pr-id="${esc(m.playlist_round_id)}" data-pl-id="${esc(m.playlist_id)}">
            <span class="name">${esc(m.playlist_name)}</span>
            <button class="x" data-act="remove" title="Remove">✕</button>
          </div>
          <input type="text" class="manage-note" data-pr-id="${esc(m.playlist_round_id)}"
                 data-pl-id="${esc(m.playlist_id)}"
                 placeholder="Note" value="${esc(m.note)}">
        `).join('')}
      </div>
      <a class="new-link" id="pop-add-more">+ Add to another playlist</a>
      <div class="save-popover-actions">
        <button class="btn-secondary" id="pop-close">Close</button>
      </div>
    `
    for (const x of popEl.querySelectorAll('.x[data-act="remove"]')) {
      x.addEventListener('click', e => {
        const row = e.target.closest('[data-pr-id]')
        onPopoverRemove(row.dataset.prId, row.dataset.plId)
      })
    }
    for (const inp of popEl.querySelectorAll('.manage-note')) {
      inp.addEventListener('change', e => {
        onPopoverNoteEdit(e.target.dataset.prId, e.target.dataset.plId, e.target.value)
      })
    }
    popEl.querySelector('#pop-add-more').addEventListener('click', () => {
      popoverState.addingMore = true; renderPopover()
    })
    popEl.querySelector('#pop-close').addEventListener('click', closeSavePopover)
  }
}

async function onSavePopoverSubmit() {
  if (!popoverState) return
  const { demoId, roundIdx, selectedId, showCreate, newName, note } = popoverState
  try {
    let plId = selectedId
    if (showCreate && newName.trim()) {
      const userId = (await supabase.auth.getUser()).data.user?.id
      const created = await createPlaylist(state.teamId, newName.trim(), userId)
      state.playlists.unshift(created)
      plId = created.id
    }
    if (!plId) { toast('Pick or create a playlist', 'error'); return }
    const userId = (await supabase.auth.getUser()).data.user?.id
    const currentRows = (plId === state.openId) ? state.openRows : await loadPlaylistRounds(plId)
    await addRoundToPlaylist({ playlistId: plId, demoId, roundIdx, note, currentRows, userId })
    toast('Saved to playlist')
    closeSavePopover()
    // Refresh detail view if it's open and matches.
    if (state.openId === plId) {
      state.openRows = sortByPosition(await loadPlaylistRounds(plId))
      render()
    }
    // Update star state in the round-nav.
    hooks.onMembershipChanged?.(demoId, roundIdx)
  } catch (e) {
    console.error(e); toast('Failed to save', 'error')
  }
}

async function onPopoverRemove(playlistRoundId, playlistId) {
  try {
    await removeRoundFromPlaylist(playlistRoundId, playlistId)
    popoverState.memberships = popoverState.memberships.filter(m => m.playlist_round_id !== playlistRoundId)
    if (state.openId === playlistId) {
      state.openRows = state.openRows.filter(r => r.id !== playlistRoundId)
    }
    if (!popoverState.memberships.length) closeSavePopover()
    else renderPopover()
    hooks.onMembershipChanged?.(popoverState?.demoId, popoverState?.roundIdx)
    render()
    toast('Removed')
  } catch (e) { console.error(e); toast('Failed to remove', 'error') }
}

async function onPopoverNoteEdit(playlistRoundId, playlistId, value) {
  try {
    await updateRoundNote(playlistRoundId, value, playlistId)
    if (state.openId === playlistId) {
      const r = state.openRows.find(x => x.id === playlistRoundId)
      if (r) r.note = value
      render()
    }
  } catch (e) { console.error(e); toast('Failed to save note', 'error') }
}
```

- [ ] **Step 3: Wire ★ button click in `analysis.js`**

In `cs2-hub/analysis.js`, find the click handlers near `pp-round-prev` / `pp-round-next` (around line 1371). Add:

```javascript
document.getElementById('pp-save-btn').addEventListener('click', async (e) => {
  if (state.viewRoundIdx == null) return
  const r = state.rounds[state.viewRoundIdx]
  if (!r) return
  const rect = e.currentTarget.getBoundingClientRect()
  await playlistRail.openSavePopoverFor({
    demoId:    r.demoId,
    roundIdx:  r.roundIdx,
    anchorRect: rect,
  })
})

// Close popover on outside click.
document.addEventListener('click', (e) => {
  if (!playlistRail.isPopoverOpen()) return
  const pop = document.getElementById('save-popover')
  if (pop.contains(e.target)) return
  if (e.target.closest('#pp-save-btn')) return
  playlistRail.closeSavePopover()
})
```

Then expand the `playlistRail.mount(...)` hooks block:

```javascript
    playlistRail.mount(railEl, {
      getDemoMeta: async (demoId) => { /* unchanged from Task 6 */ },
      onMembershipChanged: (demoId, roundIdx) => {
        // Recompute ★ state for the currently-displayed round.
        if (state.viewRoundIdx == null) return
        const r = state.rounds[state.viewRoundIdx]
        if (r && r.demoId === demoId && r.roundIdx === roundIdx) refreshStarState()
      },
    })
```

Add a `refreshStarState()` helper near the other UI-refresh functions in `analysis.js`:

```javascript
async function refreshStarState() {
  const btn = document.getElementById('pp-save-btn')
  if (!btn || state.viewRoundIdx == null) return
  const r = state.rounds[state.viewRoundIdx]
  if (!r) { btn.textContent = '☆'; btn.classList.remove('saved'); return }
  try {
    const teamId = getTeamId()
    if (!teamId) return
    const { findRoundMemberships } = await import('./playlists.js')
    const ms = await findRoundMemberships(teamId, r.demoId, r.roundIdx)
    if (ms.length) { btn.textContent = '★'; btn.classList.add('saved') }
    else           { btn.textContent = '☆'; btn.classList.remove('saved') }
  } catch (e) { console.warn('star state failed:', e) }
}
```

Then call `refreshStarState()` at the end of `refreshSoloRoundNav()` (around line 1325).

- [ ] **Step 4: Smoke-test the save flow**

Reload analysis. Pick a team. Click a player on the map → enters single-round playback. The round-nav row now shows ☆ between the round label and ▶. Click ☆.

Expected:
- Popover opens anchored under the ☆.
- Save mode: existing playlists list (or "No playlists yet"), `+ New playlist` link, note input, Cancel/Save.
- Click `+ New playlist`, type a name, fill note, hit Save → toast "Saved to playlist", popover closes, ☆ flips to ★.
- Click ★ again → manage mode: shows the playlist, editable note, ✕ remove, "+ Add to another playlist".
- Outside-click closes the popover.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/playlist-rail.js cs2-hub/analysis.js cs2-hub/style.css
git commit -m "feat(analysis): save-flow popover for adding rounds to playlists"
```

---

## Task 8: Click-row → load single round from rail

A playlist round may belong to a demo that is not currently in `state.rounds` (different filters, or a different team selection). We need to load the slim + full payloads on-demand and inject the round into `state.rounds` before entering single-round playback.

**Files:**
- Modify: `cs2-hub/analysis.js`
- Modify: `cs2-hub/playlist-rail.js`

- [ ] **Step 1: Expose a loader hook in `analysis.js`**

In `cs2-hub/analysis.js`, near the existing `fetchSlimPayloads` / `fetchFullMatch` helpers, add a function that ensures a (demoId, roundIdx) is loaded into `state.rounds` and returns its index:

```javascript
async function ensureRoundLoaded(demoId, roundIdx) {
  // Already in state.rounds? Just find the index.
  let idx = state.rounds.findIndex(r => r.demoId === demoId && r.roundIdx === roundIdx)
  if (idx >= 0) {
    await fetchFullMatch(demoId)
    return idx
  }

  // Otherwise: pull the slim payload, build a RenderRound entry, append.
  await fetchSlimPayloads([demoId])  // populates state.slimCache
  const slim = state.slimCache.get(demoId)
  if (!slim) return -1

  // narrowRoundsForTeam handles all the side/winner/bombSite logic. Pass a
  // single-payload list with side='both' and outcome='all' so we get every
  // round; then pick the one we want.
  const corpusRow = await (async () => {
    const fromCorpus = state.corpus.find(d => d.id === demoId)
    if (fromCorpus) return fromCorpus
    const { data } = await supabase.from('demos')
      .select('id, ct_team_name, t_team_name, team_a_first_side')
      .eq('id', demoId).maybeSingle()
    return data
  })()
  if (!corpusRow) return -1

  const isRosterA = corpusRow.team_a_first_side
    ? (corpusRow.team_a_first_side === 'ct' ? corpusRow.ct_team_name === state.team
                                             : corpusRow.t_team_name  === state.team)
    : corpusRow.ct_team_name === state.team
  const bound = Object.assign({ _is_roster_a: isRosterA, _demo_id: demoId }, slim)
  const all = narrowRoundsForTeam([bound], { side: 'both', outcome: 'all', bombSite: 'all' })
  const target = all.find(r => r.roundIdx === roundIdx)
  if (!target) return -1

  state.rounds.push(target)
  recomputePlaybackBounds()
  await fetchFullMatch(demoId)
  return state.rounds.length - 1
}
```

- [ ] **Step 2: Add a public entry-point that the rail calls**

In `cs2-hub/analysis.js`, near `exitSingleRound()`:

```javascript
async function loadPlaylistRound(playlistRow) {
  const idx = await ensureRoundLoaded(playlistRow.demo_id, playlistRow.round_idx)
  if (idx < 0) { toast?.('Could not load this round', 'error'); return }
  state.viewRoundIdx = idx
  state.gren.playlist = null  // clicking a row exits play-all mode
  state.gren.playlistPos = 0
  playback.relTick = 0
  recomputePlaybackBounds()
  updateTimelineUi()
  refreshSoloRoundNav()
  render()
  playlistRail.setActiveRoundKey(`${playlistRow.demo_id}|${playlistRow.round_idx}`)
}
```

Add `import { toast } from './toast.js'` at the top of `analysis.js` if it isn't already imported.

Then expand the `playlistRail.mount(...)` hooks:

```javascript
    playlistRail.mount(railEl, {
      getDemoMeta: async (demoId) => { /* unchanged */ },
      onMembershipChanged: (demoId, roundIdx) => { /* unchanged */ },
      onLoadRound: loadPlaylistRound,
    })
```

- [ ] **Step 3: Clear active key on exit**

In `exitSingleRound()` in `analysis.js` (around line 1349), after `state.gren.playlistPos = 0`, add:

```javascript
  playlistRail.setActiveRoundKey(null)
```

- [ ] **Step 4: Smoke-test**

Reload analysis. Pick a team. Save a round to a playlist (using the flow from Task 7). Click the playlist in the rail → detail view. Click the saved round.

Expected:
- Canvas enters single-round playback for that demo + round.
- Round-nav shows `Round N / M · CT/T`.
- The clicked row in the rail is highlighted (border-left accent).
- Clicking another playlist round switches; clicking the canvas (anywhere) exits and clears the highlight.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/analysis.js cs2-hub/playlist-rail.js
git commit -m "feat(analysis): load playlist round on click — fetch slim/full as needed"
```

---

## Task 9: Play-all — auto-walk the playlist

Reuse the existing `state.gren.playlist` / `advancePlaylist()` machinery. We translate the playlist's rows into round indices into `state.rounds` (loading each on-demand first), then enter playback.

**Files:**
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Add the play-all entry-point**

In `cs2-hub/analysis.js`, near `loadPlaylistRound`:

```javascript
async function playPlaylistAll(playlistRows) {
  if (!playlistRows.length) return
  // Pre-load every round into state.rounds and collect their indices.
  showChip('Loading playlist…', 'info')
  const indices = []
  for (const row of playlistRows) {
    const idx = await ensureRoundLoaded(row.demo_id, row.round_idx)
    if (idx >= 0) indices.push(idx)
  }
  hideChip('Loading playlist…')
  if (!indices.length) { toast('No rounds loaded', 'error'); return }

  state.gren.playlist    = indices
  state.gren.playlistPos = 0
  state.viewRoundIdx     = indices[0]
  playback.relTick       = 0
  recomputePlaybackBounds()
  // Auto-play — user explicitly asked to walk through rounds.
  playback.playing = true
  document.getElementById('play-btn').textContent = '⏸'
  updateTimelineUi()
  refreshSoloRoundNav()
  render()
  const first = playlistRows[0]
  playlistRail.setActiveRoundKey(`${first.demo_id}|${first.round_idx}`)
}
```

- [ ] **Step 2: Wire into the rail mount hooks**

```javascript
    playlistRail.mount(railEl, {
      getDemoMeta: async (demoId) => { /* unchanged */ },
      onMembershipChanged: (demoId, roundIdx) => { /* unchanged */ },
      onLoadRound: loadPlaylistRound,
      onPlayAll:   playPlaylistAll,
    })
```

- [ ] **Step 3: Update active-key during auto-advance**

In `advancePlaylist()` in `analysis.js` (around line 463), after `refreshSoloRoundNav()`, add:

```javascript
  const r = state.rounds[nextIdx]
  if (r) playlistRail.setActiveRoundKey(`${r.demoId}|${r.roundIdx}`)
```

Also: the existing `loop()` function loops the playlist (`advancePlaylist()` does `(pos + 1) % length`). The spec says "When the last round ends, playback stops (no loop in v1)." Replace the looping with a stop-at-end:

In `advancePlaylist()` (around line 463), change:

```javascript
function advancePlaylist() {
  const pl = state.gren.playlist
  if (!pl || !pl.length) return
  state.gren.playlistPos = (state.gren.playlistPos + 1) % pl.length
  const nextIdx = pl[state.gren.playlistPos]
  ...
```

to:

```javascript
function advancePlaylist() {
  const pl = state.gren.playlist
  if (!pl || !pl.length) return
  // Stop at end (v1 — no loop).
  if (state.gren.playlistPos + 1 >= pl.length) {
    playback.playing = false
    document.getElementById('play-btn').textContent = '▶'
    return
  }
  state.gren.playlistPos += 1
  const nextIdx = pl[state.gren.playlistPos]
  ...
```

(This change affects the grenade-mode playlist auto-walk too — that's intentional: stop-at-end is a reasonable default for both flows. If grenade-mode needs looping, surface it as a separate toggle later.)

- [ ] **Step 4: Smoke-test**

Save 3+ rounds to a playlist (across one or more demos). In the rail, open the playlist. Click ▶ Play all.

Expected:
- "Loading playlist…" chip flashes briefly.
- Canvas enters single-round playback for the first round, auto-playing.
- Round-nav reads `Playlist 1 / 3 · CT/T`.
- When the round ends, automatically advances to round 2.
- ◀ / ▶ in player panel walks playlist entries (not adjacent rounds).
- After the last round, playback stops (does not loop).
- Clicking anywhere on canvas exits playlist mode.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/analysis.js
git commit -m "feat(analysis): play-all auto-walks playlist with stop-at-end"
```

---

## Task 10: Reorder rounds — drag handle

**Files:**
- Modify: `cs2-hub/playlist-rail.js`
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Add a drag handle to each round row**

In `cs2-hub/playlist-rail.js`, in `hydrateRoundRows()`, change the row template to include the handle column:

```javascript
    return `
      <div class="pr-round-row${active}" data-row-id="${esc(r.id)}" data-key="${esc(key)}" draggable="true">
        <div class="pr-round-handle" title="Drag to reorder">≡</div>
        <div class="pr-round-thumb" style="background-image:url('${esc(thumb)}')"></div>
        <div class="pr-round-meta">
          <div class="pr-round-title">
            <span class="pr-round-side-dot ${info.side}"></span>R${r.round_idx + 1} · ${esc(info.score)}
          </div>
          <div class="pr-round-note" title="${esc(r.note ?? '')}">${esc(r.note ?? '')}</div>
        </div>
        <button class="pr-round-x" data-row-id="${esc(r.id)}" title="Remove">✕</button>
      </div>
    `
```

Also update the grid-template in CSS (replace existing `.pr-round-row` block):

```css
.pr-round-row {
  display: grid;
  grid-template-columns: 14px 28px 1fr 14px;
  gap: 6px; align-items: center;
  padding: 6px 8px; cursor: pointer;
  border-radius: var(--r-sm);
  border-left: 2px solid transparent;
  transition: background-color 0.12s, border-color 0.12s;
}
.pr-round-handle {
  cursor: grab; color: var(--muted); font-size: 14px;
  user-select: none;
}
.pr-round-handle:active { cursor: grabbing; }
.pr-round-row.dragging { opacity: 0.4; }
.pr-round-row.drop-above { box-shadow: inset 0 2px 0 var(--accent); }
.pr-round-row.drop-below { box-shadow: inset 0 -2px 0 var(--accent); }
```

- [ ] **Step 2: Add HTML5 drag handlers**

At the bottom of `hydrateRoundRows()` (after the existing event wiring), add:

```javascript
  let dragId = null
  for (const row of listEl.querySelectorAll('.pr-round-row')) {
    row.addEventListener('dragstart', (e) => {
      dragId = row.dataset.rowId
      row.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', dragId)
    })
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging')
      listEl.querySelectorAll('.drop-above,.drop-below').forEach(r => r.classList.remove('drop-above','drop-below'))
    })
    row.addEventListener('dragover', (e) => {
      if (!dragId || row.dataset.rowId === dragId) return
      e.preventDefault()
      const rect = row.getBoundingClientRect()
      const above = (e.clientY - rect.top) < rect.height / 2
      row.classList.toggle('drop-above', above)
      row.classList.toggle('drop-below', !above)
    })
    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-above','drop-below')
    })
    row.addEventListener('drop', async (e) => {
      e.preventDefault()
      const targetId = row.dataset.rowId
      if (!dragId || targetId === dragId) return
      const above = row.classList.contains('drop-above')
      row.classList.remove('drop-above','drop-below')
      await commitReorder(dragId, targetId, above)
      dragId = null
    })
  }
```

- [ ] **Step 3: Add the reorder commit**

Append to `playlist-rail.js`:

```javascript
import { reorderPlaylistRound } from './playlists.js'

async function commitReorder(srcId, targetId, above) {
  const rows = state.openRows.slice()
  const srcIdx = rows.findIndex(r => r.id === srcId)
  if (srcIdx < 0) return
  const [moved] = rows.splice(srcIdx, 1)
  let targetIdx = rows.findIndex(r => r.id === targetId)
  if (targetIdx < 0) return
  if (!above) targetIdx += 1
  rows.splice(targetIdx, 0, moved)

  // Reassign positions sequentially. Persist in parallel.
  const updates = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].position !== i) {
      rows[i].position = i
      updates.push(reorderPlaylistRound(rows[i].id, i, state.openId))
    }
  }
  state.openRows = rows
  render()
  try { await Promise.all(updates) } catch (e) {
    console.error(e); toast('Reorder failed', 'error')
  }
}
```

- [ ] **Step 4: Smoke-test**

Open a playlist with 3+ rounds. Drag a row by the `≡` handle and drop it above/below another row.

Expected:
- Drop indicator (top or bottom border) shows during drag.
- After drop, rows visibly reorder.
- Reload the page — the new order persists.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/playlist-rail.js cs2-hub/style.css
git commit -m "feat(analysis): drag-to-reorder rounds in a playlist"
```

---

## Task 11: Polish — collapsible filter rail

**Files:**
- Modify: `cs2-hub/analysis.html`
- Modify: `cs2-hub/style.css`
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Add a toggle button to the filter rail markup**

In `cs2-hub/analysis.html`, modify the existing `<aside class="filter-rail" id="filter-rail">` opening to include a toggle button. The actual toggle UI is rendered by `renderFilterRail` in `analysis.js`; we'll patch it to inject a chevron at the top.

In `cs2-hub/analysis.js`, find `renderFilterRail()` (around line 138). At the very top of the `rail.innerHTML = …` template, prepend the toggle:

```javascript
  rail.innerHTML = `
    <button class="filter-rail-toggle" id="f-toggle" title="Collapse">‹</button>
    <div class="label">Map</div>
    ...
```

(everything else stays the same — just add the button line.)

After `rail.querySelector('#f-reset').addEventListener…`, add:

```javascript
  rail.querySelector('#f-toggle').addEventListener('click', () => {
    const collapsed = rail.classList.toggle('collapsed')
    localStorage.setItem('cs2hub_filter_rail_collapsed', collapsed ? '1' : '0')
  })
```

Then at the very start of `renderFilterRail()` (before the `if (!state.team || …)` branch), restore the persisted state:

```javascript
  const collapsed = localStorage.getItem('cs2hub_filter_rail_collapsed') === '1'
  rail.classList.toggle('collapsed', collapsed)
```

- [ ] **Step 2: Add CSS for the collapsed state**

Append to `cs2-hub/style.css`:

```css
/* ── Filter rail: collapsible ─────────────────────────────────── */
.filter-rail-toggle {
  position: absolute; top: 6px; right: 6px;
  background: transparent;
  border: 1px solid var(--border-solid);
  color: var(--muted);
  width: 22px; height: 22px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 11px;
  display: inline-flex; align-items: center; justify-content: center;
  z-index: 5;
  transition: color 0.15s, border-color 0.15s;
}
.filter-rail-toggle:hover { color: var(--accent); border-color: var(--accent); }

.filter-rail { position: relative; }
.filter-rail.collapsed {
  flex: 0 0 32px;
  padding: 6px 4px;
  overflow: hidden;
}
.filter-rail.collapsed > *:not(.filter-rail-toggle) { display: none; }
.filter-rail.collapsed .filter-rail-toggle { transform: rotate(180deg); }
```

- [ ] **Step 3: Smoke-test**

Reload analysis with a team picked. Click the chevron at the top-right of the filter rail.

Expected:
- Rail shrinks to 32px wide (icons hidden — collapsed shows only the toggle).
- Canvas grows to fill the freed space.
- Click the chevron again to expand.
- Refresh the page — collapsed state persists.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/analysis.js cs2-hub/style.css
git commit -m "feat(analysis): collapsible filter rail with persisted state"
```

---

## Task 12: Polish — keyboard shortcuts + help overlay

**Files:**
- Modify: `cs2-hub/analysis.js`
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Install global keydown handler in `analysis.js`**

Near the bottom of `cs2-hub/analysis.js` (after the existing event wiring, before the playback `loop()` is started — around line 1700+ — anywhere that runs once at boot):

```javascript
// ── Keyboard shortcuts ───────────────────────────────────────
//
// Active when the analysis page has focus and the user is not typing in an
// input. Shortcuts:
//   Space      — play/pause
//   ← / →      — prev/next round (or playlist entry, in playlist playback)
//   B          — open save popover (single-round playback only)
//   Esc        — exit single-round / clear solo / close popover
//   ?          — toggle keyboard-help overlay
window.addEventListener('keydown', (e) => {
  // Ignore when typing in an input/textarea/contenteditable.
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

  switch (e.key) {
    case ' ': {
      e.preventDefault()
      const btn = document.getElementById('play-btn')
      btn.click()
      break
    }
    case 'ArrowLeft':
      e.preventDefault(); gotoSoloRound(-1); break
    case 'ArrowRight':
      e.preventDefault(); gotoSoloRound(+1); break
    case 'b':
    case 'B': {
      if (state.viewRoundIdx == null) return
      const btn = document.getElementById('pp-save-btn')
      if (btn) btn.click()
      break
    }
    case 'Escape':
      if (playlistRail.isPopoverOpen()) playlistRail.closeSavePopover()
      else if (document.getElementById('kb-help-overlay').hidden === false) toggleKbHelp(false)
      else if (state.viewRoundIdx != null) exitSingleRound()
      else if (state.soloSid) { state.soloSid = null; refreshPlayerPanel(); render() }
      break
    case '?':
      toggleKbHelp()
      break
  }
})

function toggleKbHelp(force) {
  const overlay = document.getElementById('kb-help-overlay')
  const open = (typeof force === 'boolean') ? force : overlay.hidden
  if (open) {
    overlay.innerHTML = `
      <div class="kb-help-card" role="dialog" aria-label="Keyboard shortcuts">
        <h3>Keyboard shortcuts</h3>
        <table>
          <tr><td><kbd>Space</kbd></td>            <td>Play / pause</td></tr>
          <tr><td><kbd>←</kbd> / <kbd>→</kbd></td> <td>Prev / next round (or playlist entry)</td></tr>
          <tr><td><kbd>B</kbd></td>                <td>Save round to playlist</td></tr>
          <tr><td><kbd>Esc</kbd></td>              <td>Exit single round / close popover</td></tr>
          <tr><td><kbd>?</kbd></td>                <td>Toggle this help</td></tr>
        </table>
        <p style="margin-top:10px;font-size:11px;color:var(--muted)">Press any key to close.</p>
      </div>
    `
    overlay.hidden = false
    const close = () => toggleKbHelp(false)
    document.addEventListener('keydown', close, { once: true })
    overlay.addEventListener('click', close, { once: true })
  } else {
    overlay.hidden = true
    overlay.innerHTML = ''
  }
}
```

- [ ] **Step 2: Add overlay styles**

Append to `cs2-hub/style.css`:

```css
/* ── Keyboard help overlay ────────────────────────────────────── */
.kb-help-overlay {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.58);
  z-index: 2000;
}
.kb-help-overlay[hidden] { display: none; }
.kb-help-card {
  background: var(--glass-bg);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
  padding: 18px 22px;
  min-width: 320px;
  color: var(--text);
}
.kb-help-card h3 {
  margin: 0 0 12px;
  font-family: var(--display-font);
  font-size: 12px; font-weight: 700;
  color: var(--accent);
  text-transform: uppercase; letter-spacing: 0.18em;
}
.kb-help-card table { font-size: 12px; line-height: 1.8; border-collapse: collapse; }
.kb-help-card td { padding: 2px 14px 2px 0; vertical-align: middle; }
.kb-help-card td:first-child { white-space: nowrap; }
.kb-help-card kbd {
  display: inline-block;
  padding: 1px 6px; min-width: 18px;
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--border-solid);
  border-radius: var(--r-sm);
  font-family: var(--display-font);
  font-size: 10px; color: var(--text);
  text-align: center;
}
```

- [ ] **Step 3: Smoke-test**

Reload analysis. Pick a team. Enter single-round playback by clicking a player.

Test each shortcut:
- `Space` → play/pause toggles.
- `←` → prev round; `→` → next round.
- `B` → save popover opens (focused on ☆ button anchor).
- `Esc` (with popover open) → popover closes.
- `Esc` (in single-round) → exits to multi-round overlay.
- `?` → help overlay appears; any key closes it.

Verify shortcuts do NOT fire while focused inside the team-pick input or the popover note input.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/analysis.js cs2-hub/style.css
git commit -m "feat(analysis): keyboard shortcuts (space, arrows, B, Esc, ?)"
```

---

## Task 13: Polish — loading & empty states

**Files:**
- Modify: `cs2-hub/analysis.js`
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Loading spinner during slim/full fetches**

In `cs2-hub/analysis.js`, find `setEmptyMessage()` (around line 86). Extend it to support a "loading" mode and replace the bare text content:

```javascript
function setEmptyMessage(text, kind = 'text') {
  const el = document.getElementById('canvas-empty')
  if (!text) { el.style.display = 'none'; el.innerHTML = ''; return }
  el.style.display = 'flex'
  if (kind === 'loading') {
    el.innerHTML = `<div class="canvas-empty-spinner"></div><div style="margin-left:10px">${text}</div>`
  } else if (kind === 'reset') {
    el.innerHTML = `<div>${text}</div>
      <button class="canvas-empty-reset" id="canvas-reset-btn">Reset filters</button>`
    el.querySelector('#canvas-reset-btn').addEventListener('click', () => {
      document.getElementById('f-reset')?.click()
    })
  } else {
    el.textContent = text
  }
}
```

Then update call sites:
- `onTeamChanged()`: replace `showChip('Loading corpus…', 'info')` with `setEmptyMessage('Loading rounds…', 'loading')`, and `hideChip('Loading corpus…')` with `setEmptyMessage('')`.
- After `reloadRoundSet()` runs, if `state.rounds.length === 0` and at least one filter is active, call `setEmptyMessage('No rounds match these filters', 'reset')`.

Find `reloadRoundSet()` (search for the function definition). At the end, add:

```javascript
  if (!state.rounds.length && state.team) {
    const hasNarrowFilters =
      state.filters.side !== 'ct' ||
      state.filters.opponent !== 'any' ||
      state.filters.buyTypes.size > 0 ||
      (state.filters.matchIds && state.filters.matchIds.size === 0)
    setEmptyMessage(
      hasNarrowFilters ? 'No rounds match these filters' : 'No rounds found.',
      hasNarrowFilters ? 'reset' : 'text'
    )
  } else if (state.rounds.length) {
    setEmptyMessage('')
  }
```

- [ ] **Step 2: Add styles**

Append to `cs2-hub/style.css`:

```css
/* ── Canvas empty/loading states ──────────────────────────────── */
.canvas-empty { flex-direction: row; gap: 10px; }
.canvas-empty-spinner {
  width: 16px; height: 16px;
  border: 2px solid rgba(255,255,255,0.15);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: ce-spin 0.9s linear infinite;
}
@keyframes ce-spin { to { transform: rotate(360deg); } }
.canvas-empty-reset {
  margin-left: 14px;
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  padding: 4px 12px;
  font-family: var(--display-font);
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em;
  border-radius: var(--r-sm);
  cursor: pointer;
  pointer-events: auto;
}
.canvas-empty-reset:hover { background: rgba(0,255,156,0.10); }
```

(Note: the `canvas-empty` rule already sets `pointer-events: none`; the reset button overrides that on the button itself.)

- [ ] **Step 3: Smoke-test**

Reload analysis. Pick a team. Expected:
- Briefly: spinner + "Loading rounds…" appears centered on the canvas.
- After load: spinner clears, map renders.
- Click "Buy type → Eco" filter, then keep applying filters until 0 rounds match. Expected: "No rounds match these filters" + a "Reset filters" button.
- Click "Reset filters" → filters reset, empty message clears.
- The skeleton rows in the playlist rail were already added in Task 5; verify they appear briefly on team change.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/analysis.js cs2-hub/style.css
git commit -m "feat(analysis): loading spinner + 'no rounds match' empty state"
```

---

## Task 14: Polish — onboarding hint

**Files:**
- Modify: `cs2-hub/analysis.js`
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Render hint on first visit**

In `cs2-hub/analysis.js`, near the top after `readUrl()` / boot block:

```javascript
function maybeShowOnboardingHint() {
  if (state.team) return
  const dismissedFor = localStorage.getItem('cs2hub_analysis_hint_dismissed_user')
  // Best-effort: tie dismissal to the auth user so a different user on the
  // same machine still sees the hint once.
  supabase.auth.getUser().then(({ data }) => {
    const uid = data.user?.id ?? 'anon'
    if (dismissedFor === uid) return
    const el = document.getElementById('onboarding-hint')
    el.innerHTML = `
      <span>Pick a team, then click a player on the map to dive into a single round.</span>
      <button class="onb-x" title="Dismiss">×</button>
    `
    el.hidden = false
    el.querySelector('.onb-x').addEventListener('click', () => {
      el.hidden = true
      localStorage.setItem('cs2hub_analysis_hint_dismissed_user', uid)
    })
  })
}
maybeShowOnboardingHint()
```

- [ ] **Step 2: Add styles**

Append to `cs2-hub/style.css`:

```css
/* ── Onboarding hint ──────────────────────────────────────────── */
.onboarding-hint {
  position: fixed; top: 64px; left: 50%;
  transform: translateX(-50%);
  z-index: 1500;
  display: flex; align-items: center; gap: 10px;
  background: rgba(0,255,156,0.10);
  border: 1px solid rgba(0,255,156,0.35);
  color: var(--text);
  padding: 8px 14px;
  border-radius: var(--r-md);
  font-size: 12px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.35);
}
.onboarding-hint[hidden] { display: none; }
.onboarding-hint .onb-x {
  background: transparent; border: none; cursor: pointer;
  color: var(--muted); font-size: 16px; padding: 0 4px;
}
.onboarding-hint .onb-x:hover { color: var(--accent); }
```

- [ ] **Step 3: Smoke-test**

Clear `localStorage.cs2hub_analysis_hint_dismissed_user` (DevTools → Application → Local Storage). Reload analysis WITHOUT a team in the URL. Expected:
- Hint banner appears centered just below the header.
- Click ×: banner disappears.
- Reload: banner does NOT reappear.
- Sign in as a different user (or clear the key): banner reappears.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/analysis.js cs2-hub/style.css
git commit -m "feat(analysis): onboarding hint dismissible per user"
```

---

## Task 15: Self-test pass + acceptance check

**Files:**
- (none modified — verification step)

- [ ] **Step 1: Re-run the unit test**

Open `cs2-hub/playlists.test.html` in the browser. Expected: `13 passed, 0 failed`.

- [ ] **Step 2: Walk through every acceptance criterion**

In a single browser session:

1. ☆ button is visible during single-round playback. Click it → popover with picker. Save → row inserted, ☆ flips to ★.
2. Playlist rail appears as the fourth column when a team is picked. Master view lists playlists with relative dates. Click → detail view with rounds (thumb + R# + score + side dot + note + ✕).
3. ▶ Play all walks the playlist auto-advancing. ◀/▶ in player panel walks playlist entries.
4. Filter rail collapses to 32px on chevron click; persists across reload.
5. `Space`, `←`, `→`, `B`, `Esc`, `?` work as documented.
6. Loading spinner shows during fetch; "no rounds match" + Reset button shows on empty filter.
7. Onboarding hint appears once for a fresh user; dismiss persists.
8. Tables `playlists` and `playlist_rounds` exist. Delete a demo (from demos page) → its playlist references vanish (verify by opening the playlist that contained it; the row should be gone).

- [ ] **Step 3: Final commit**

If any small fixes were needed during the walkthrough, commit them with a `chore` or targeted-`fix` message. Otherwise no commit needed for this verification task.

---

## Notes for the executing engineer

- This codebase has **no build step**. Modules use bare ES `import` from relative paths and load directly into the browser. Don't add bundlers or transpilers.
- Tests are HTML files opened in the browser — no Node/jest. The pattern is `import` the module, run assertions against `<pre id="out">`, count pass/fail.
- The codebase uses a single-team-per-user model: `getTeamId()` reads the team UUID from `localStorage`. RLS lets a user see playlists for any team they've uploaded a demo for.
- `state.gren.playlist` is the existing playlist machinery in `analysis.js` used by grenade-mode "Play N rounds". We reuse it for rail-driven playback. The shared field is intentional — both flows produce a list of indices into `state.rounds[]`.
- Never use `git add -A` or `git add .` — always stage specific files (commit hooks may otherwise pick up unrelated WIP).
- If a step's smoke test fails, fix in place and continue — don't rewrite earlier tasks. The task list is sequential; later tasks depend on earlier ones building correctly.
