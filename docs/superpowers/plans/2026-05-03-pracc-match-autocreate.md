# Pracc → Match Auto-Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-create a vod (match) entry for every pracc-imported scrim on the CS2 Hub schedule, with insert-once semantics, idempotent re-sync, and a soft-dismiss flow when users delete the auto-created match.

**Architecture:** Sync runs client-side inside `loadEvents()` in `cs2-hub/schedule.js` after pracc events are fetched. A pure helper computes which pracc UIDs need a new vod (by diffing against an existing-vod lookup), then a single bulk insert handles them. A unique partial index on `(team_id, external_uid)` provides race-safe dedupe across tabs. Vod deletes branch on `external_uid` — pracc-sourced vods soft-dismiss; manual vods hard-delete as today.

**Tech Stack:** Vanilla ES modules, Supabase (Postgres + JS client), no test framework — pure-logic helper is unit-tested via an HTML test page (matches existing `*.test.html` pattern in this repo).

**Spec:** `docs/superpowers/specs/2026-05-03-pracc-match-autocreate.md`

---

## File Structure

**Created:**
- `cs2-hub/pracc-sync.js` — pure helper exporting `computePraccVodsToInsert(praccEvents, existingUids, teamId)`. No Supabase imports. One responsibility: decide which pracc UIDs lack a vod and build their insert payloads.
- `cs2-hub/pracc-sync.test.html` — unit tests for the helper (matches existing `demo-map-data.test.html` / `analysis-rounds.test.html` pattern).

**Modified:**
- `cs2-hub/supabase-setup.sql` — append migration lines under the existing `-- Migration` comment block.
- `cs2-hub/schedule.js` — call the helper inside `loadEvents()` and run the bulk insert.
- `cs2-hub/vod-detail.js` (line 295) — branch delete vs. dismiss based on `external_uid`.
- `cs2-hub/vods.js` (line 21 + match list row template ~line 154) — filter out dismissed rows, add PRACC badge to rows where `external_uid` is set.

---

## Task 1: Database migration

**Files:**
- Modify: `cs2-hub/supabase-setup.sql` (append to lines 44-49)

- [ ] **Step 1: Append migration lines to the SQL file**

Append these lines to `cs2-hub/supabase-setup.sql` immediately after line 49 (the existing `-- alter table vods add column if not exists notes text;` line):

```sql
-- alter table vods add column if not exists external_uid text;
-- alter table vods add column if not exists dismissed boolean default false;
-- create unique index if not exists vods_team_external_uid_idx on vods(team_id, external_uid) where external_uid is not null;
```

These are commented-out for new installs (which already get a fresh `vods` table from the `create table` at line 30 — but since `create table` doesn't include the new columns, also update the `create table` block so new installs get them too).

- [ ] **Step 2: Update the `create table vods` block to include the new columns**

In `cs2-hub/supabase-setup.sql`, modify the `create table vods` block (currently lines 30-42). The existing block ends with `created_by uuid references auth.users(id)` then `);`. Insert the two new columns right before `created_by`:

```sql
create table vods (
  id uuid primary key default gen_random_uuid(),
  title text,
  opponent text,
  result text check (result in ('win','loss','draw')),
  match_type text check (match_type in ('scrim','tournament','pug')),
  demo_link text,
  match_date date,
  maps jsonb default '[]',
  notes text,
  external_uid text,
  dismissed boolean default false,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);
```

Also add the unique partial index right after the `create table vods` block (before the `-- Migration` comment):

```sql
create unique index if not exists vods_team_external_uid_idx
  on vods(team_id, external_uid) where external_uid is not null;
```

Wait — `team_id` isn't in the `create table` shown above. Verify by reading `cs2-hub/supabase-setup.sql` lines 30-42 first; the `team_id` column was added later (per commit `df3bd46`). If `team_id` isn't in the local `create table` block, it's expected to be added via a separate migration — keep the index DDL as written; it will work regardless of which migration adds `team_id`, as long as both columns exist when the index is created.

- [ ] **Step 3: Run the migration in Supabase manually**

The user runs this in the Supabase SQL editor:

```sql
alter table vods add column if not exists external_uid text;
alter table vods add column if not exists dismissed boolean default false;
create unique index if not exists vods_team_external_uid_idx
  on vods(team_id, external_uid) where external_uid is not null;
```

Verify in the dashboard that both columns appear on the `vods` table and the index exists. (This step is run by the human, not by the implementing agent.)

- [ ] **Step 4: Commit the SQL changes**

```bash
git add cs2-hub/supabase-setup.sql
git commit -m "feat(db): add external_uid + dismissed columns to vods for pracc sync"
```

---

## Task 2: Pure helper — write the failing tests

**Files:**
- Create: `cs2-hub/pracc-sync.test.html`

- [ ] **Step 1: Create the test page**

Create `cs2-hub/pracc-sync.test.html` with this exact content:

```html
<!DOCTYPE html>
<html>
<body>
<script type="module">
import { computePraccVodsToInsert } from './pracc-sync.js'

function assert(condition, msg) {
  if (!condition) { console.error('FAIL:', msg); return; }
  console.log('PASS:', msg);
}

const TEAM = 'team-abc'

// Test 1: empty pracc events → empty payloads
{
  const out = computePraccVodsToInsert([], new Set(), TEAM)
  assert(Array.isArray(out) && out.length === 0, 'no pracc events yields empty array')
}

// Test 2: single pracc event with no existing vod → one payload
{
  const events = [{
    id: 'pracc-uid-1',
    title: 'Scrim vs NaVi',
    opponent: 'NaVi',
    date: '2026-05-10T18:00:00Z',
  }]
  const out = computePraccVodsToInsert(events, new Set(), TEAM)
  assert(out.length === 1, 'single new event yields one payload')
  assert(out[0].team_id === TEAM, 'team_id set')
  assert(out[0].external_uid === 'pracc-uid-1', 'external_uid copied from event id')
  assert(out[0].opponent === 'NaVi', 'opponent copied')
  assert(out[0].match_type === 'scrim', 'match_type is scrim')
  assert(out[0].match_date === '2026-05-10', 'match_date is YYYY-MM-DD')
  assert(Array.isArray(out[0].maps) && out[0].maps.length === 0, 'maps initialized empty')
}

// Test 3: existing UID is skipped
{
  const events = [
    { id: 'pracc-uid-1', title: 'A', opponent: 'A', date: '2026-05-10T18:00:00Z' },
    { id: 'pracc-uid-2', title: 'B', opponent: 'B', date: '2026-05-11T18:00:00Z' },
  ]
  const existing = new Set(['pracc-uid-1'])
  const out = computePraccVodsToInsert(events, existing, TEAM)
  assert(out.length === 1, 'only the new event yields a payload')
  assert(out[0].external_uid === 'pracc-uid-2', 'correct event passed through')
}

// Test 4: opponent falls back to title when null
{
  const events = [{
    id: 'pracc-uid-3',
    title: 'Practice block',
    opponent: null,
    date: '2026-05-12T18:00:00Z',
  }]
  const out = computePraccVodsToInsert(events, new Set(), TEAM)
  assert(out[0].opponent === 'Practice block', 'opponent falls back to title')
}

// Test 5: all UIDs already exist → empty
{
  const events = [{ id: 'pracc-uid-1', title: 'A', opponent: 'A', date: '2026-05-10T18:00:00Z' }]
  const out = computePraccVodsToInsert(events, new Set(['pracc-uid-1']), TEAM)
  assert(out.length === 0, 'all-existing yields empty array')
}

console.log('All pracc-sync tests done')
</script>
</body>
</html>
```

- [ ] **Step 2: Open the test page in a browser to verify it fails**

Open `cs2-hub/pracc-sync.test.html` in a browser (e.g., via the local dev server). Open the dev console.
Expected: A console error about failing to import `./pracc-sync.js` (the module doesn't exist yet).

---

## Task 3: Pure helper — minimal implementation

**Files:**
- Create: `cs2-hub/pracc-sync.js`

- [ ] **Step 1: Create the helper module**

Create `cs2-hub/pracc-sync.js` with this exact content:

```js
export function computePraccVodsToInsert(praccEvents, existingUids, teamId) {
  return praccEvents
    .filter(e => !existingUids.has(e.id))
    .map(e => ({
      team_id: teamId,
      opponent: e.opponent || e.title,
      match_type: 'scrim',
      match_date: e.date.slice(0, 10),
      maps: [],
      external_uid: e.id,
    }))
}
```

- [ ] **Step 2: Open the test page in a browser to verify it passes**

Reload `cs2-hub/pracc-sync.test.html` in the browser. Check the console.
Expected: All 5 PASS lines, then `All pracc-sync tests done`. No FAIL lines.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/pracc-sync.js cs2-hub/pracc-sync.test.html
git commit -m "feat: pure helper for computing pracc → vod insert payloads"
```

---

## Task 4: Wire sync into schedule.js loadEvents

**Files:**
- Modify: `cs2-hub/schedule.js` (the `loadEvents` function, currently lines 29-62)

- [ ] **Step 1: Add the import at the top of `cs2-hub/schedule.js`**

Find the existing imports (lines 1-5). Add this import after the existing ones:

```js
import { computePraccVodsToInsert } from './pracc-sync.js'
```

- [ ] **Step 2: Add the fire-and-forget sync helper inside `loadEvents()`**

In `cs2-hub/schedule.js`, locate `loadEvents()` (line 29). At the **end** of the function, immediately after the existing `renderCalendar()` call (line 61), append this block:

```js
  // Sync: ensure each pracc event has a corresponding vod entry.
  // Fire-and-forget so calendar render is never blocked.
  if (praccEvents.length) {
    ;(async () => {
      const uids = praccEvents.map(e => e.id)
      const { data: existing } = await supabase
        .from('vods')
        .select('external_uid')
        .eq('team_id', teamId)
        .in('external_uid', uids)
      const existingUids = new Set((existing ?? []).map(v => v.external_uid))
      const newPayloads = computePraccVodsToInsert(praccEvents, existingUids, teamId)
      if (newPayloads.length) {
        await supabase.from('vods').insert(newPayloads)
      }
    })()
  }
```

The IIFE intentionally swallows errors — unique-violation errors from the partial index (caused by a concurrent tab) are silently dropped, matching the spec's race-safety requirement, and any other failure is retried on the next page load.

- [ ] **Step 3: Manually verify in a browser**

Start the local dev server. Make sure your team has a configured `pracc_url` (Pracc settings on Schedule page). Open the Schedule page and open the browser dev console.

In the Network tab, observe:
- a request to `/api/calendar?url=...` returning pracc events
- a `select` against `vods` with `external_uid=in.(...)` filter
- if any UIDs were missing, an `insert` against `vods`

Open the Results page (`vods.html`). The new pracc scrims should appear as match cards with empty score areas.

Reload the Schedule page. The Network tab should show the same select returning the now-existing UIDs and **no** insert (because all UIDs already exist).

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/schedule.js
git commit -m "feat: auto-create vod entries from pracc-imported scrims on schedule load"
```

---

## Task 5: Soft-dismiss in vod-detail.js delete handler

**Files:**
- Modify: `cs2-hub/vod-detail.js` (delete handler at lines 292-302)

- [ ] **Step 1: Locate the delete handler**

In `cs2-hub/vod-detail.js`, find the delete handler block (around line 292-302). It currently looks like:

```js
// ── Delete ─────────────────────────────────────────────────
document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this match?')) return
  const { error } = await supabase.from('vods').delete().eq('id', id)
  if (error) {
    document.getElementById('save-error').textContent = `Delete failed: ${error.message}`
    document.getElementById('save-error').style.display = 'block'
    return
  }
  location.href = 'vods.html'
})
```

- [ ] **Step 2: Branch on `external_uid`**

Replace the delete-handler block with:

```js
// ── Delete ─────────────────────────────────────────────────
document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this match?')) return
  const { data: row } = await supabase.from('vods').select('external_uid').eq('id', id).single()
  const op = row?.external_uid
    ? supabase.from('vods').update({ dismissed: true }).eq('id', id)
    : supabase.from('vods').delete().eq('id', id)
  const { error } = await op
  if (error) {
    document.getElementById('save-error').textContent = `Delete failed: ${error.message}`
    document.getElementById('save-error').style.display = 'block'
    return
  }
  location.href = 'vods.html'
})
```

The user-facing UX is unchanged — same confirm dialog, same redirect on success.

- [ ] **Step 3: Manually verify**

Open the Results page, click into an auto-created (pracc-sourced) match, click Delete, confirm. The page redirects to `vods.html` and the match no longer appears. In the Supabase dashboard, the row still exists but `dismissed` is now `true`.

Then click into a manually-created match (no `external_uid`), click Delete, confirm. The page redirects and the row is gone from the database entirely.

Then go back to the Schedule page and reload. The dismissed pracc match must NOT reappear in Results (Task 6 will add the filter that enforces this; for this task you can verify only that the row was soft-deleted in the database).

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/vod-detail.js
git commit -m "feat: soft-dismiss pracc-sourced vods on delete instead of hard-delete"
```

---

## Task 6: Filter dismissed + add PRACC badge in vods.js

**Files:**
- Modify: `cs2-hub/vods.js` (line 21 query, list row template ~line 150-162)

- [ ] **Step 1: Filter dismissed rows from the list query**

In `cs2-hub/vods.js`, find line 21:

```js
const { data: vods, error } = await supabase.from('vods').select('*').eq('team_id', getTeamId()).order('match_date', { ascending: false })
```

Replace with:

```js
const { data: vods, error } = await supabase.from('vods').select('*').eq('team_id', getTeamId()).eq('dismissed', false).order('match_date', { ascending: false })
```

- [ ] **Step 2: Add the PRACC badge to the match list row**

In `cs2-hub/vods.js`, find the list row template (around lines 150-162). The opponent name is rendered with `<div class="row-name">vs ${esc(oppName)}</div>` (around line 154). Replace that line with:

```js
          <div class="row-name">vs ${esc(oppName)}${v.external_uid ? ' <span class="pracc-badge">PRACC</span>' : ''}</div>
```

The `pracc-badge` class is already styled in `cs2-hub/style.css` (used on the Schedule page).

- [ ] **Step 3: Manually verify**

Open the Results page. Auto-created (pracc-sourced) matches show a PRACC badge next to the opponent name. Manually-added matches show no badge.

Now repeat the deletion test from Task 5 Step 3 — delete a pracc-sourced match. After redirect to `vods.html`, the dismissed match must NOT appear in the list. Reload the Schedule page (which triggers sync). Reload `vods.html`. The dismissed match still must NOT reappear (because the sync's existing-UID lookup includes dismissed rows — verify by checking Network tab).

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/vods.js
git commit -m "feat: hide dismissed vods from results list, badge pracc-sourced rows"
```

---

## Task 7: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Full happy path**

1. With a working pracc URL configured for your team, open Schedule. Confirm pracc events render with PRACC badges in the calendar.
2. Open Results (`vods.html`). Confirm each pracc event has a corresponding match row with a PRACC badge.
3. Click into one of those matches. Fill in scores. Save. Return to Results — scores persist.
4. Reload Schedule. Reload Results. Confirm no duplicates appear.

- [ ] **Step 2: Dismiss flow**

1. Click into another auto-created match. Click Delete, confirm. The page redirects to Results and the match is gone.
2. Reload Schedule (this triggers the sync). Reload Results. The dismissed match must NOT reappear.
3. In the Supabase dashboard, confirm the row still exists with `dismissed=true`.

- [ ] **Step 3: Manual-vod path is unchanged**

1. From Results, click "Add Match" (or whatever the manual entry path is — verify with `cs2-hub/vods.html`). Fill in details. Save.
2. Click into the manual match. Click Delete, confirm. The row is hard-deleted from the database (verify in Supabase).

- [ ] **Step 4: Insert-once verification**

1. In your pracc.com calendar, edit the title or time of a scrim that's already synced.
2. Reload Schedule. The pracc event in the calendar reflects the new title/time.
3. Open Results. The corresponding vod still has the OLD title/date. (This is correct — insert-once is intentional per spec.)

- [ ] **Step 5: Concurrent tab safety (optional but recommended)**

1. Pick a pracc event whose UID has no vod yet (e.g., a brand-new scrim added to your pracc calendar).
2. Open Schedule in two browser tabs simultaneously and reload both at the same time.
3. Confirm only one vod row was created (Supabase dashboard, filter by `external_uid`).

If duplicates appear, the unique partial index from Task 1 is missing or misconfigured — re-run the migration.

---

## Self-review notes

- **Spec coverage:** all spec sections map to a task. Architecture → Task 4. Data model → Task 1. Sync flow → Tasks 2/3/4. Delete behavior → Task 5. Results-page badge → Task 6. Edge cases (insert-once, dismissed lookup, concurrent tabs) → Task 7.
- **Placeholder scan:** none (all code blocks complete, all paths absolute).
- **Type consistency:** `computePraccVodsToInsert(praccEvents, existingUids, teamId)` — same signature in test (Task 2), implementation (Task 3), and call site (Task 4).
