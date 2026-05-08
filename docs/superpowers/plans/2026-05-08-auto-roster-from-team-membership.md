# Auto-Roster from Team Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual "Add Player" flow on the cs2-hub roster page with a system where `team_members` (Steam-authenticated users who have joined a team) is the source of truth for roster membership; role selection alone decides whether a person is tracked as an active player or hidden as staff/bench/unassigned.

**Architecture:** A Postgres trigger keeps `roster` in sync with `team_members` on insert/delete, copying `steam_id` from `auth.user_metadata`. The owner-only RLS replaces broad team-scoped write access. A `is_ghost` flag on `roster` allows pre-creating rows for un-joined players; ghosts auto-merge into real rows when a matching `steam_id` joins. The `roster.html` UI loses its Add Player modal; only the team owner can edit roles/nicknames or add/remove ghost rows.

**Tech Stack:** Supabase (Postgres triggers, RLS, plpgsql), vanilla JS ES modules, browser-loaded `*.test.html` test pages with `console.log('PASS:'/FAIL:')` pattern (existing convention).

**Spec:** `docs/superpowers/specs/2026-05-08-auto-roster-from-team-membership-design.md`

---

## File Map

| File | Action |
|---|---|
| `cs2-hub/supabase-roster-auto-membership.sql` | Create — schema + triggers + owner RLS |
| `cs2-hub/supabase-roster-auto-membership-rollback.sql` | Create — paired rollback |
| `cs2-hub/supabase-roster-backfill.sql` | Create — one-shot data migration |
| `cs2-hub/supabase-roster-backfill-rollback.sql` | Create — paired rollback |
| `cs2-hub/supabase-roster-trigger.test.sql` | Create — database trigger tests |
| `cs2-hub/auth.js` | Modify — add `isTeamOwner(teamId)` helper |
| `cs2-hub/auth.test.html` | Create — browser test for `isTeamOwner` |
| `cs2-hub/team-select.js` | Modify — auto-upsert writes `steam_id`, `role`, `is_ghost` |
| `cs2-hub/roster-stats.js` | Modify — `STAFF_ROLES` expansion; drop add-steam variant |
| `cs2-hub/roster.html` | Modify — strip Add/Edit modal, add ghost form scaffold |
| `cs2-hub/roster.js` | Rewrite — read-only baseline + owner-gated editing/add-ghost/remove |

---

### Task 1: SQL pre-flight verification

**Files:**
- Run in: Supabase SQL Editor

This task confirms the multi-hub Task 1 SQL has already been applied, the `roster.steam_id` column already exists (from prior migration), and the live database is in the expected state. **Stop and resolve any failures before continuing.**

- [ ] **Step 1: Run verification query**

Paste into Supabase SQL Editor and run:

```sql
-- Confirm tables exist
select table_name
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('teams','team_members','roster')
 order by table_name;
-- Expected: 3 rows

-- Confirm required columns on roster
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'roster'
   and column_name in ('id','team_id','user_id','username','nickname','steam_id','role')
 order by column_name;
-- Expected: 7 rows. team_id and steam_id MUST be present.

-- Confirm RLS is enabled on roster
select relname, relrowsecurity
  from pg_class
 where relname = 'roster';
-- Expected: relrowsecurity = true
```

- [ ] **Step 2: Capture current row counts (used by rollback if needed)**

```sql
select count(*) as roster_count from roster;
select count(*) as team_members_count from team_members;
select count(*) as teams_count from teams;
```

Record these numbers. They are the rollback baseline.

- [ ] **Step 3: Stop if anything is missing**

If any expected table or column is missing, **stop and run the multi-hub setup SQL first** (`docs/superpowers/plans/2026-04-20-cs2-hub-multi-hub.md` Task 1) plus `cs2-hub/supabase-roster-steamid-migration.sql`. Do not proceed to Task 2 until all checks pass.

---

### Task 2: SQL — `is_ghost` column and expanded role check

**Files:**
- Create: `cs2-hub/supabase-roster-auto-membership.sql` (initial content; Tasks 3 and 4 append to it)

- [ ] **Step 1: Create the migration file with column + constraint changes**

Create `cs2-hub/supabase-roster-auto-membership.sql` with this exact content:

```sql
-- cs2-hub/supabase-roster-auto-membership.sql
-- Purpose: roster ↔ team_members auto-sync, owner-only writes, ghost players.
-- Idempotent: safe to re-run.

-- ── 1. Expand role check ────────────────────────────────────────
alter table roster drop constraint if exists roster_role_check;
alter table roster add constraint roster_role_check
  check (role in ('IGL','AWPer','Entry','Support','Lurker',
                  'Coach','Manager','Bench','Unassigned'));

-- ── 2. Ghost flag column ───────────────────────────────────────
alter table roster add column if not exists is_ghost boolean not null default false;
```

- [ ] **Step 2: Run it in Supabase SQL Editor**

Paste the file contents into Supabase SQL Editor and run.

Expected: success, no errors. If any existing rows have a `role` value outside the new allowed set (none should — but if so), the constraint add will fail with `check constraint violated`. Inspect with:

```sql
select id, username, role from roster
 where role is not null
   and role not in ('IGL','AWPer','Entry','Support','Lurker','Coach','Manager','Bench','Unassigned');
```

- [ ] **Step 3: Verify**

```sql
-- Column added?
select column_name, data_type, column_default
  from information_schema.columns
 where table_schema='public' and table_name='roster' and column_name='is_ghost';
-- Expected: 1 row, data_type='boolean', column_default='false'

-- Constraint updated?
select pg_get_constraintdef(oid) from pg_constraint
 where conname = 'roster_role_check';
-- Expected output should contain 'Bench' and 'Unassigned'.
```

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/supabase-roster-auto-membership.sql
git commit -m "feat(sql): add is_ghost column and expand roster role check"
```

---

### Task 3: SQL — trigger functions for auto-sync and auto-cleanup

**Files:**
- Modify: `cs2-hub/supabase-roster-auto-membership.sql` (append)
- Create: `cs2-hub/supabase-roster-trigger.test.sql`

The two triggers fire `after insert` and `after delete` on `team_members`. The sync trigger reads `steam_id` from `auth.users.user_metadata`, checks for an existing real row first (idempotency for backfill), then checks for a ghost row to merge, otherwise inserts a fresh roster row with `role = 'Unassigned'`.

- [ ] **Step 1: Write the database test file (TDD — tests first)**

Create `cs2-hub/supabase-roster-trigger.test.sql` with this exact content:

```sql
-- cs2-hub/supabase-roster-trigger.test.sql
-- Run in Supabase SQL Editor against a non-production environment.
-- Wraps everything in a transaction that rolls back at the end so it leaves no trace.

begin;

-- ── Setup: create two synthetic auth users with steam_ids in user_metadata ──
do $$
declare
  v_user_a uuid := gen_random_uuid();
  v_user_b uuid := gen_random_uuid();
  v_team   uuid;
  v_ghost  uuid;
  v_count  int;
  v_steam_id text;
  v_is_ghost boolean;
  v_user_id_after uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values
    (v_user_a, 'test_a@example.com', jsonb_build_object('steam_id', '76561198000000001')),
    (v_user_b, 'test_b@example.com', jsonb_build_object('steam_id', '76561198000000002'));

  insert into teams (name, owner_id) values ('Trigger Test Team', v_user_a) returning id into v_team;

  -- ── Test 1: inserting team_members creates roster row with steam_id ──
  insert into team_members (team_id, user_id, role) values (v_team, v_user_a, 'owner');

  select count(*) into v_count from roster where team_id = v_team and user_id = v_user_a;
  assert v_count = 1, 'Test 1 FAIL: expected 1 roster row for user_a';
  select steam_id into v_steam_id from roster where team_id = v_team and user_id = v_user_a;
  assert v_steam_id = '76561198000000001', 'Test 1 FAIL: expected steam_id 76561198000000001';
  raise notice 'Test 1 PASS: team_members insert created roster row with correct steam_id';

  -- ── Test 2: re-inserting team_members for an existing real row is a no-op (backfill safety) ──
  -- Simulate by deleting from team_members WITHOUT cascading (use a different path),
  -- then asserting that re-running the trigger logic via direct insert doesn't duplicate.
  -- Easier: temporarily drop the unique constraint, insert duplicate, observe roster count.
  alter table team_members drop constraint if exists team_members_team_id_user_id_key;
  insert into team_members (team_id, user_id, role) values (v_team, v_user_a, 'owner');
  select count(*) into v_count from roster where team_id = v_team and user_id = v_user_a;
  assert v_count = 1, 'Test 2 FAIL: expected still 1 roster row, got ' || v_count;
  alter table team_members add constraint team_members_team_id_user_id_key unique (team_id, user_id);
  -- Clean up the duplicate team_members row to keep state consistent.
  delete from team_members where team_id = v_team and user_id = v_user_a
    and ctid not in (select min(ctid) from team_members where team_id = v_team and user_id = v_user_a);
  raise notice 'Test 2 PASS: duplicate team_members insert did not duplicate roster row';

  -- ── Test 3: pre-existing ghost merges on team_members insert ──
  insert into roster (team_id, username, steam_id, role, is_ghost)
  values (v_team, 'GhostBob', '76561198000000002', 'AWPer', true)
  returning id into v_ghost;

  insert into team_members (team_id, user_id, role) values (v_team, v_user_b, 'member');

  select count(*) into v_count from roster where team_id = v_team and steam_id = '76561198000000002';
  assert v_count = 1, 'Test 3 FAIL: expected 1 row (merged ghost), got ' || v_count;

  select is_ghost, user_id into v_is_ghost, v_user_id_after from roster where id = v_ghost;
  assert v_is_ghost = false, 'Test 3 FAIL: expected ghost flag cleared';
  assert v_user_id_after = v_user_b, 'Test 3 FAIL: expected user_id set to user_b';
  raise notice 'Test 3 PASS: ghost merged into real row on team_members insert';

  -- ── Test 4: deleting team_members drops the matching real roster row ──
  delete from team_members where team_id = v_team and user_id = v_user_b;
  select count(*) into v_count from roster where team_id = v_team and user_id = v_user_b;
  assert v_count = 0, 'Test 4 FAIL: expected real roster row deleted';
  raise notice 'Test 4 PASS: team_members delete dropped real roster row';

  -- ── Test 5: deleting team_members does NOT drop a ghost row ──
  insert into roster (team_id, username, steam_id, role, is_ghost)
  values (v_team, 'StillGhost', '76561198000000003', 'Lurker', true);

  delete from team_members where team_id = v_team and user_id = v_user_a;
  select count(*) into v_count from roster where team_id = v_team and is_ghost = true;
  assert v_count = 1, 'Test 5 FAIL: expected ghost row preserved';
  raise notice 'Test 5 PASS: team_members delete did not affect ghost rows';

  raise notice 'ALL TRIGGER TESTS PASSED';
end $$;

rollback;
```

- [ ] **Step 2: Run the test file BEFORE implementing the triggers — verify it fails**

Paste the test file into Supabase SQL Editor and run. Expected output: an error or `Test 1 FAIL` because the triggers don't exist yet — the `team_members` insert won't create a roster row.

If you get `ALL TRIGGER TESTS PASSED` here, that's a problem — it means the triggers already exist. Investigate before continuing.

- [ ] **Step 3: Append trigger functions to the migration file**

Open `cs2-hub/supabase-roster-auto-membership.sql` and append:

```sql
-- ── 3. Trigger: on team_members insert, create-or-merge roster row ──
create or replace function fn_team_member_roster_sync()
returns trigger as $$
declare
  v_steam_id text;
  v_username text;
  v_ghost_id uuid;
begin
  select raw_user_meta_data->>'steam_id',
         coalesce(raw_user_meta_data->>'name',
                  raw_user_meta_data->>'username',
                  email)
    into v_steam_id, v_username
    from auth.users where id = NEW.user_id;

  -- 3a. Existing real row → no-op (backfill / re-insert safety).
  if exists (
    select 1 from roster
     where team_id = NEW.team_id and user_id = NEW.user_id and is_ghost = false
  ) then
    return NEW;
  end if;

  -- 3b. Ghost row matching this steam_id in this team → merge.
  select id into v_ghost_id from roster
   where team_id = NEW.team_id and steam_id = v_steam_id and is_ghost = true
   limit 1;

  if v_ghost_id is not null then
    update roster
       set user_id = NEW.user_id,
           is_ghost = false,
           username = coalesce(username, v_username)
     where id = v_ghost_id;
    return NEW;
  end if;

  -- 3c. Otherwise insert a fresh roster row.
  insert into roster (team_id, user_id, username, steam_id, role, is_ghost)
  values (NEW.team_id, NEW.user_id, v_username, v_steam_id, 'Unassigned', false);

  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_team_member_roster_sync on team_members;
create trigger trg_team_member_roster_sync
  after insert on team_members
  for each row execute function fn_team_member_roster_sync();

-- ── 4. Trigger: on team_members delete, drop the matching real roster row ──
create or replace function fn_team_member_roster_cleanup()
returns trigger as $$
begin
  delete from roster
   where team_id = OLD.team_id
     and user_id = OLD.user_id
     and is_ghost = false;
  return OLD;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_team_member_roster_cleanup on team_members;
create trigger trg_team_member_roster_cleanup
  after delete on team_members
  for each row execute function fn_team_member_roster_cleanup();
```

- [ ] **Step 4: Run the appended SQL in Supabase Editor**

Paste only the new block (the two functions + triggers) and run. Expected: success.

- [ ] **Step 5: Run the test file again — verify all 5 tests pass**

Paste `supabase-roster-trigger.test.sql` and run. Expected output (notices):

```
NOTICE:  Test 1 PASS: team_members insert created roster row with correct steam_id
NOTICE:  Test 2 PASS: duplicate team_members insert did not duplicate roster row
NOTICE:  Test 3 PASS: ghost merged into real row on team_members insert
NOTICE:  Test 4 PASS: team_members delete dropped real roster row
NOTICE:  Test 5 PASS: team_members delete did not affect ghost rows
NOTICE:  ALL TRIGGER TESTS PASSED
```

The transaction rolls back at the end, so the test data is gone.

- [ ] **Step 6: Commit**

```bash
git add cs2-hub/supabase-roster-auto-membership.sql cs2-hub/supabase-roster-trigger.test.sql
git commit -m "feat(sql): triggers for roster ↔ team_members sync, with tests"
```

---

### Task 4: SQL — owner-only RLS for roster

**Files:**
- Modify: `cs2-hub/supabase-roster-auto-membership.sql` (append)

This task replaces the broad `team_roster` policy (any team member can write) with explicit `select` for any member, but `insert`/`update`/`delete` only for the team owner. The trigger functions are `security definer`, so they bypass RLS — they keep working unchanged.

- [ ] **Step 1: Append RLS policy changes to the migration file**

Open `cs2-hub/supabase-roster-auto-membership.sql` and append:

```sql
-- ── 5. Owner-only writes on roster; any member can read ──
drop policy if exists "team_roster" on roster;
drop policy if exists "roster_select_member" on roster;
drop policy if exists "roster_update_owner" on roster;
drop policy if exists "roster_insert_owner" on roster;
drop policy if exists "roster_delete_owner" on roster;

create policy "roster_select_member" on roster for select to authenticated
  using (team_id in (
    select team_id from team_members where user_id = auth.uid()
  ));

create policy "roster_update_owner" on roster for update to authenticated
  using (team_id in (
    select team_id from team_members where user_id = auth.uid() and role = 'owner'
  ))
  with check (team_id in (
    select team_id from team_members where user_id = auth.uid() and role = 'owner'
  ));

create policy "roster_insert_owner" on roster for insert to authenticated
  with check (team_id in (
    select team_id from team_members where user_id = auth.uid() and role = 'owner'
  ));

create policy "roster_delete_owner" on roster for delete to authenticated
  using (team_id in (
    select team_id from team_members where user_id = auth.uid() and role = 'owner'
  ));
```

- [ ] **Step 2: Run the appended block in Supabase SQL Editor**

Paste the new block only. Expected: success.

- [ ] **Step 3: Verify policies**

```sql
select polname, polcmd from pg_policy
 where polrelid = 'roster'::regclass
 order by polname;
```

Expected: 4 rows — `roster_delete_owner` (d), `roster_insert_owner` (a), `roster_select_member` (r), `roster_update_owner` (w).

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/supabase-roster-auto-membership.sql
git commit -m "feat(sql): owner-only writes, member reads on roster"
```

---

### Task 5: SQL — backfill migration

**Files:**
- Create: `cs2-hub/supabase-roster-backfill.sql`

One-shot data migration. Creates a default team for the lone existing user, attaches all existing roster rows to it, marks user_id-less rows as ghosts. Run this exactly once.

- [ ] **Step 1: Create the backfill file**

Create `cs2-hub/supabase-roster-backfill.sql` with:

```sql
-- cs2-hub/supabase-roster-backfill.sql
-- One-shot data migration. Run AFTER supabase-roster-auto-membership.sql.
-- DO NOT run twice — the first run is the only run.
-- Wrap in transaction; rollback by hand if anything looks wrong before commit.

begin;

-- ── 1. Create default team owned by the lone existing roster user ──
insert into teams (name, owner_id)
select 'My Team', user_id
  from roster
 where user_id is not null
   and team_id is null
 limit 1
on conflict do nothing;

-- ── 2. Attach all existing roster rows without team_id to that team ──
update roster set team_id = (
  select id from teams order by created_at asc limit 1
)
 where team_id is null;

-- ── 3. Backfill team_members for the team owner (trigger will see existing
--      real roster row and no-op via the "existing real row" check). ──
insert into team_members (team_id, user_id, role)
select t.id, t.owner_id, 'owner'
  from teams t
on conflict (team_id, user_id) do nothing;

-- ── 4. Mark rows without user_id as ghosts ──
update roster set is_ghost = true
 where user_id is null;

-- ── 5. Sanity check before commit: no nulls, no orphan team_members ──
do $$
declare
  v_orphans int;
  v_null_team int;
begin
  select count(*) into v_null_team from roster where team_id is null;
  assert v_null_team = 0, 'BACKFILL FAIL: roster rows still have null team_id';

  select count(*) into v_orphans from roster
    where user_id is null and is_ghost = false;
  assert v_orphans = 0, 'BACKFILL FAIL: rows with no user_id are not flagged as ghost';

  raise notice 'BACKFILL OK: no null team_ids, no unflagged ghost rows';
end $$;

-- ── 6. Now safe to enforce team_id NOT NULL ──
alter table roster alter column team_id set not null;

commit;
```

- [ ] **Step 2: Run in Supabase SQL Editor**

Paste and run. Expected output: `NOTICE: BACKFILL OK: ...` and the `commit` succeeds.

If the assertion fails, the entire transaction rolls back. Investigate the failing condition before re-running.

- [ ] **Step 3: Verify post-backfill state**

```sql
-- Every roster row has a team_id
select count(*) as null_team from roster where team_id is null;
-- Expected: 0

-- Every team has its owner in team_members
select t.name, count(tm.id) as members
  from teams t left join team_members tm on tm.team_id = t.id
 group by t.id, t.name;
-- Expected: every team has at least 1 member (the owner)

-- Ghosts are flagged correctly
select count(*) as unflagged_orphans from roster where user_id is null and is_ghost = false;
-- Expected: 0
```

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/supabase-roster-backfill.sql
git commit -m "feat(sql): one-shot roster backfill — assign team, flag ghosts, enforce team_id"
```

---

### Task 6: SQL — rollback files

**Files:**
- Create: `cs2-hub/supabase-roster-auto-membership-rollback.sql`
- Create: `cs2-hub/supabase-roster-backfill-rollback.sql`

These are not run automatically. They exist so a future operator can revert this migration cleanly.

- [ ] **Step 1: Create auto-membership rollback**

Create `cs2-hub/supabase-roster-auto-membership-rollback.sql`:

```sql
-- cs2-hub/supabase-roster-auto-membership-rollback.sql
-- Reverts cs2-hub/supabase-roster-auto-membership.sql.

-- Drop owner-scoped policies
drop policy if exists "roster_select_member" on roster;
drop policy if exists "roster_update_owner" on roster;
drop policy if exists "roster_insert_owner" on roster;
drop policy if exists "roster_delete_owner" on roster;

-- Restore the broad team_roster policy from multi-hub Task 1
create policy "team_roster" on roster for all to authenticated
  using (team_id in (select team_id from team_members where user_id = auth.uid()))
  with check (team_id in (select team_id from team_members where user_id = auth.uid()));

-- Drop triggers and functions
drop trigger if exists trg_team_member_roster_sync on team_members;
drop trigger if exists trg_team_member_roster_cleanup on team_members;
drop function if exists fn_team_member_roster_sync();
drop function if exists fn_team_member_roster_cleanup();

-- Drop is_ghost column (data loss — preserved for inspection if rolled back manually)
alter table roster drop column if exists is_ghost;

-- Restore original role check
alter table roster drop constraint if exists roster_role_check;
alter table roster add constraint roster_role_check
  check (role in ('IGL','AWPer','Entry','Support','Lurker'));
```

- [ ] **Step 2: Create backfill rollback**

Create `cs2-hub/supabase-roster-backfill-rollback.sql`:

```sql
-- cs2-hub/supabase-roster-backfill-rollback.sql
-- Reverts cs2-hub/supabase-roster-backfill.sql.
-- WARNING: This drops the auto-created 'My Team' and all rows attached to it.
-- Only run if the backfill was a mistake AND no real data has been added since.

begin;

-- Allow nullable team_id again
alter table roster alter column team_id drop not null;

-- Unflag ghosts that came from null user_id rows
update roster set is_ghost = false where user_id is null and is_ghost = true;

-- Detach roster rows from the auto-created team
update roster set team_id = null
 where team_id = (select id from teams where name = 'My Team' order by created_at asc limit 1);

-- Drop the team_members owner row(s) for that team
delete from team_members
 where team_id = (select id from teams where name = 'My Team' order by created_at asc limit 1);

-- Drop the auto-created team
delete from teams where name = 'My Team';

commit;
```

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/supabase-roster-auto-membership-rollback.sql cs2-hub/supabase-roster-backfill-rollback.sql
git commit -m "chore(sql): rollback files for auto-membership and backfill migrations"
```

---

### Task 7: JS — `isTeamOwner` helper in auth.js

**Files:**
- Modify: `cs2-hub/auth.js` (append after line 43)
- Create: `cs2-hub/auth.test.html`

A small async helper used by `roster.js` to decide whether to show edit controls.

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/auth.test.html`:

```html
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>auth.js tests</title></head>
<body>
<pre id="out"></pre>
<script type="module">
import { isTeamOwner } from './auth.js'

const log = (msg) => { document.getElementById('out').textContent += msg + '\n' }

// We don't want to hit the real DB. Stub the supabase client by intercepting
// the import. Instead, we test the function shape: it must be an async function
// that takes a teamId and returns a boolean.

async function test_signature() {
  if (typeof isTeamOwner !== 'function') {
    log('FAIL: isTeamOwner is not a function')
    return
  }
  const result = isTeamOwner('00000000-0000-0000-0000-000000000000')
  if (!(result instanceof Promise)) {
    log('FAIL: isTeamOwner did not return a Promise')
    return
  }
  try {
    const v = await result
    if (typeof v !== 'boolean') {
      log('FAIL: isTeamOwner did not resolve to boolean, got ' + typeof v)
      return
    }
    log('PASS: isTeamOwner is async, returns boolean')
  } catch (e) {
    log('FAIL: isTeamOwner threw: ' + e.message)
  }
}

async function test_returns_false_when_not_owner() {
  // No active session in test → query returns no rows → false
  const v = await isTeamOwner('00000000-0000-0000-0000-000000000000')
  if (v === false) log('PASS: returns false when not owner / no session')
  else log('FAIL: expected false, got ' + v)
}

await test_signature()
await test_returns_false_when_not_owner()
</script>
</body>
</html>
```

- [ ] **Step 2: Open the test page in the browser — verify it fails**

Open `cs2-hub/auth.test.html` in a browser. Expected output:

```
FAIL: isTeamOwner is not a function
```

(Or a module-loading error; either way, the test does not pass.)

- [ ] **Step 3: Implement `isTeamOwner` in auth.js**

Open `cs2-hub/auth.js` and append after line 43:

```js
export async function isTeamOwner(teamId) {
  if (!teamId) return false
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return false
  const { data, error } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', session.user.id)
    .maybeSingle()
  if (error) return false
  return data?.role === 'owner'
}
```

- [ ] **Step 4: Open the test page again — verify it passes**

Reload `cs2-hub/auth.test.html`. Expected output:

```
PASS: isTeamOwner is async, returns boolean
PASS: returns false when not owner / no session
```

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/auth.js cs2-hub/auth.test.html
git commit -m "feat(auth): add isTeamOwner helper with browser test"
```

---

### Task 8: JS — `team-select.js` auto-upsert writes steam_id, role, is_ghost

**Files:**
- Modify: `cs2-hub/team-select.js` lines 84–88 and 119–125

The DB trigger handles this automatically when team_members is inserted, but the existing client code has its own `roster.upsert` / `roster.insert` calls that don't write `steam_id`, `role`, or `is_ghost`. Make those calls explicit and idempotent (they'll be no-ops because the trigger ran first, but guard against any race or trigger bypass).

- [ ] **Step 1: Update the join-with-code roster upsert (line 84)**

Open `cs2-hub/team-select.js`. Replace lines 84–88:

```js
  const { error: rosterErr } = await supabase.from('roster').upsert(
    { team_id: team.id, user_id: userId, username: displayName, nickname: nickname || null },
    { onConflict: 'team_id,user_id', ignoreDuplicates: false }
  )
```

with:

```js
  const steamId = session.user.user_metadata?.steam_id ?? null
  const { error: rosterErr } = await supabase.from('roster').upsert(
    {
      team_id: team.id,
      user_id: userId,
      username: displayName,
      nickname: nickname || null,
      steam_id: steamId,
      role: 'Unassigned',
      is_ghost: false,
    },
    { onConflict: 'team_id,user_id', ignoreDuplicates: false }
  )
```

- [ ] **Step 2: Update the create-team roster insert (line 119)**

Replace lines 119–125:

```js
  const { error: rosterErr } = await supabase.from('roster').insert({
    team_id: team.id,
    user_id: userId,
    username: displayName,
    nickname: nickname || null,
  })
```

with:

```js
  const steamId = session.user.user_metadata?.steam_id ?? null
  // The trigger likely already created this row. Use upsert so a duplicate is a no-op.
  const { error: rosterErr } = await supabase.from('roster').upsert(
    {
      team_id: team.id,
      user_id: userId,
      username: displayName,
      nickname: nickname || null,
      steam_id: steamId,
      role: 'Unassigned',
      is_ghost: false,
    },
    { onConflict: 'team_id,user_id', ignoreDuplicates: false }
  )
```

- [ ] **Step 3: Verify the file parses**

Run: `node --check cs2-hub/team-select.js`
Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/team-select.js
git commit -m "feat(team-select): write steam_id and Unassigned role on roster auto-upsert"
```

> **Note for the engineer:** Smoke-testing this end-to-end (a fresh Steam-login user joining a team) is part of Task 14 (final E2E checklist). Don't try to run a live join here — the page requires an active Supabase session and a valid join code.

---

### Task 9: JS — `roster-stats.js` STAFF_ROLES + drop add-steam variant

**Files:**
- Modify: `cs2-hub/roster-stats.js` line 9 and lines 43–50

Two changes: expand the staff-role exclusion set, and remove the no-Steam-ID card variant (now unreachable because every roster row has a `steam_id` — real from auth metadata or ghost from manual entry with regex validation).

- [ ] **Step 1: Update STAFF_ROLES set**

Open `cs2-hub/roster-stats.js`. Replace line 9:

```js
const STAFF_ROLES = new Set(['Coach', 'Manager'])
```

with:

```js
const STAFF_ROLES = new Set(['Coach', 'Manager', 'Bench', 'Unassigned'])
```

- [ ] **Step 2: Drop the no-Steam-ID card variant**

In the same file, find and delete lines 43–50 (the `if (!hasSteam) { return ... 'Add Steam ID →' ... }` block). The current block looks like:

```js
    if (!hasSteam) {
      return `
        <button type="button" class="rb-card rb-card-disabled" data-action="add-steam" data-id="${esc(p.id)}">
          <div class="rb-name">${esc(p.username)}</div>
          <div class="rb-role">${esc(p.role || 'Player')}</div>
          <div class="rb-cta">Add Steam ID →</div>
        </button>`
    }
```

Delete that block entirely. The function falls through to the existing `return` block that renders the normal card.

- [ ] **Step 3: Drop the matching event handler**

Further down in the same file, find the listener block:

```js
  for (const btn of root.querySelectorAll('[data-action="add-steam"]')) {
    btn.addEventListener('click', () => {
      window.location.href = `roster.html?edit=${encodeURIComponent(btn.dataset.id)}`
    })
  }
```

Delete that block.

- [ ] **Step 4: Verify the file parses**

Run: `node --check cs2-hub/roster-stats.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/roster-stats.js
git commit -m "refactor(roster-stats): expand STAFF_ROLES; drop unreachable add-steam variant"
```

---

### Task 10: HTML — strip Add/Edit modal, add ghost form scaffold in roster.html

**Files:**
- Rewrite: `cs2-hub/roster.html`

The full Add/Edit modal disappears. A new "+ Add ghost player" button (owner-only) and an inline form scaffold (hidden by default) take its place. The roster grid stays.

- [ ] **Step 1: Replace `cs2-hub/roster.html` with new content**

Overwrite `cs2-hub/roster.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <link rel="icon" type="image/png" href="images/favicon.png">
  <link rel="apple-touch-icon" href="images/favicon.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Roster — MIDROUND</title>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>
<div class="app-shell">
  <nav class="sidebar" id="sidebar"></nav>
  <main class="main-content">
    <div class="page-header">
      <div>
        <div class="page-title">ROSTER</div>
        <div class="page-subtitle" id="roster-sub">Team players and staff</div>
      </div>
      <button class="btn btn-primary" id="add-ghost-btn" style="display:none">+ Add ghost player</button>
    </div>

    <!-- Inline ghost form (owner-only, hidden by default) -->
    <div id="ghost-form" style="display:none;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:20px;max-width:520px">
      <div style="font-weight:700;letter-spacing:1px;font-size:13px;margin-bottom:12px">ADD GHOST PLAYER</div>
      <div class="form-group">
        <label class="form-label">Display name</label>
        <input class="form-input" id="g-username" placeholder="e.g. Alex"/>
      </div>
      <div class="form-group">
        <label class="form-label">Steam ID (Steam64)</label>
        <input class="form-input" id="g-steam-id" placeholder="76561198…" autocomplete="off"/>
      </div>
      <div class="form-group">
        <label class="form-label">Role</label>
        <select class="form-select" id="g-role">
          <option value="Unassigned">Unassigned</option>
          <option value="IGL">IGL</option>
          <option value="AWPer">AWPer</option>
          <option value="Entry">Entry</option>
          <option value="Support">Support</option>
          <option value="Lurker">Lurker</option>
          <option value="Coach">Coach</option>
          <option value="Manager">Manager</option>
          <option value="Bench">Bench</option>
        </select>
      </div>
      <div class="error-msg" id="ghost-error" style="display:none"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" id="ghost-cancel-btn">Cancel</button>
        <button class="btn btn-primary" id="ghost-save-btn">Add</button>
      </div>
    </div>

    <div class="roster-grid" id="roster-grid"></div>
  </main>
</div>
<script type="module" src="roster.js"></script>
</body>
</html>
```

- [ ] **Step 2: Sanity-check structure**

Open `cs2-hub/roster.html` in the browser. Expected: page renders, sidebar present, "+ Add ghost player" button hidden (the JS hasn't enabled it yet — that's Task 11). No console errors.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/roster.html
git commit -m "feat(roster): replace Add/Edit modal with ghost form scaffold"
```

---

### Task 11: JS — `roster.js` rewrite: read-only baseline + owner detection

**Files:**
- Rewrite: `cs2-hub/roster.js`

Full replacement. This task delivers the baseline: load roster, render rows with member/ghost badges, detect ownership, expose a re-render hook. Tasks 12–13 add inline editing, ghost insert, and remove.

- [ ] **Step 1: Replace `cs2-hub/roster.js` with new content**

Overwrite `cs2-hub/roster.js`:

```js
import { requireAuth, isTeamOwner } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'
import { getPlayerImage, playerAvatarEl } from './player-autocomplete.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const ROLE_COLORS = {
  IGL: 'var(--accent)', AWPer: 'var(--special)', Entry: 'var(--danger)',
  Support: 'var(--success)', Lurker: 'var(--warning)',
  Coach: 'var(--muted)', Manager: 'var(--muted)',
  Bench: 'var(--muted)', Unassigned: 'var(--border)',
}
const ALL_ROLES = ['IGL','AWPer','Entry','Support','Lurker','Coach','Manager','Bench','Unassigned']

await requireAuth()
renderSidebar('roster')

const teamId = getTeamId()
const isOwner = await isTeamOwner(teamId)

let allPlayers = []

async function loadRoster() {
  const { data, error } = await supabase
    .from('roster')
    .select('*')
    .eq('team_id', teamId)
    .order('username', { ascending: true })

  const el = document.getElementById('roster-grid')
  if (error) {
    el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Failed to load</h3><p>${esc(error.message)}</p></div>`
    return
  }

  allPlayers = data ?? []
  document.getElementById('roster-sub').textContent =
    `${allPlayers.length} member${allPlayers.length !== 1 ? 's' : ''}`

  if (!allPlayers.length) {
    el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>No players yet</h3><p>Roster is empty. ${isOwner ? 'Use "+ Add ghost player" or invite teammates with the team join code.' : 'The owner will set this up.'}</p></div>`
    return
  }

  const images = await Promise.all(allPlayers.map(p => getPlayerImage(p.nickname || p.username)))

  el.innerHTML = allPlayers.map((p, i) => {
    const role = p.role || 'Unassigned'
    const roleColor = ROLE_COLORS[role] ?? 'var(--border)'
    const avatarHtml = images[i]
      ? `<img src="${images[i]}" alt="${esc(p.nickname || p.username)}" style="width:72px;height:72px;object-fit:cover;border-radius:50%;border:2px solid ${roleColor};margin-bottom:10px">`
      : `<div class="player-avatar" style="background:${roleColor}22;border:2px solid ${roleColor};color:${roleColor}">${esc((p.nickname || p.username || '?').slice(0,2).toUpperCase())}</div>`

    const statusBadge = p.is_ghost
      ? `<span class="status-badge status-ghost" style="display:inline-block;background:var(--warning);color:#000;border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700;letter-spacing:0.5px;margin-top:6px">PENDING</span>`
      : `<span class="status-badge status-member" style="display:inline-block;background:var(--surface-low);color:var(--muted);border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700;letter-spacing:0.5px;margin-top:6px">MEMBER</span>`

    const roleControl = isOwner
      ? `<select class="role-select" data-role-for="${p.id}" style="background:${roleColor};color:#fff;border:none;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;cursor:pointer">
           ${ALL_ROLES.map(r => `<option value="${r}" ${r === role ? 'selected' : ''}>${r}</option>`).join('')}
         </select>`
      : `<span class="role-badge" style="background:${roleColor};color:#fff;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700">${esc(role)}</span>`

    const removeBtn = isOwner
      ? `<button class="btn btn-ghost btn-sm" data-remove="${p.id}" data-is-ghost="${!!p.is_ghost}" style="position:absolute;top:8px;right:8px;color:var(--danger);font-size:11px;padding:2px 6px">×</button>`
      : ''

    return `
      <div class="player-card" style="position:relative;border-top:3px solid ${roleColor}" data-player-id="${p.id}">
        ${removeBtn}
        ${avatarHtml}
        <div class="player-ign">${esc(p.nickname || p.username)}</div>
        ${p.username && p.nickname ? `<div class="player-name">${esc(p.username)}</div>` : ''}
        ${roleControl}
        <div>${statusBadge}</div>
      </div>
    `
  }).join('')

  if (isOwner) {
    for (const sel of document.querySelectorAll('[data-role-for]')) {
      sel.addEventListener('change', () => onRoleChange(sel.dataset.roleFor, sel.value))
    }
    for (const btn of document.querySelectorAll('[data-remove]')) {
      btn.addEventListener('click', () => onRemove(btn.dataset.remove, btn.dataset.isGhost === 'true'))
    }
  }
}

async function onRoleChange(playerId, newRole) {
  const { error } = await supabase.from('roster').update({ role: newRole }).eq('id', playerId)
  if (error) { toast(`Failed: ${error.message}`); return }
  toast('Role updated')
  // Update local cache so the next render reflects it without a full reload
  const p = allPlayers.find(x => x.id === playerId)
  if (p) p.role = newRole
}

async function onRemove(playerId, isGhost) {
  const p = allPlayers.find(x => x.id === playerId)
  if (!p) return
  const label = p.nickname || p.username
  if (!confirm(isGhost
    ? `Remove ghost row for ${label}?`
    : `Remove ${label} from the team? This deletes their team membership.`)) return

  let error
  if (isGhost) {
    ;({ error } = await supabase.from('roster').delete().eq('id', playerId))
  } else {
    // Real: delete team_members row; trigger cascades to roster
    ;({ error } = await supabase
      .from('team_members')
      .delete()
      .eq('team_id', teamId)
      .eq('user_id', p.user_id))
  }
  if (error) { toast(`Failed: ${error.message}`); return }
  toast(isGhost ? 'Ghost removed' : 'Member removed')
  loadRoster()
}

// Owner-only: enable add-ghost UI
if (isOwner) {
  document.getElementById('add-ghost-btn').style.display = ''
}

document.getElementById('add-ghost-btn').addEventListener('click', () => {
  document.getElementById('ghost-form').style.display = 'block'
  document.getElementById('add-ghost-btn').style.display = 'none'
  document.getElementById('g-username').focus()
})

document.getElementById('ghost-cancel-btn').addEventListener('click', resetGhostForm)

function resetGhostForm() {
  document.getElementById('ghost-form').style.display = 'none'
  document.getElementById('add-ghost-btn').style.display = ''
  document.getElementById('g-username').value = ''
  document.getElementById('g-steam-id').value = ''
  document.getElementById('g-role').value = 'Unassigned'
  document.getElementById('ghost-error').style.display = 'none'
}

document.getElementById('ghost-save-btn').addEventListener('click', async () => {
  const username = document.getElementById('g-username').value.trim()
  const steamId  = document.getElementById('g-steam-id').value.trim()
  const role     = document.getElementById('g-role').value
  const errEl    = document.getElementById('ghost-error')

  if (!username) {
    errEl.textContent = 'Display name is required.'
    errEl.style.display = 'block'; return
  }
  if (!/^7656119\d{10}$/.test(steamId)) {
    errEl.textContent = 'Steam ID must be a 17-digit Steam64 starting with 7656119.'
    errEl.style.display = 'block'; return
  }

  const { error } = await supabase.from('roster').insert({
    team_id: teamId,
    user_id: null,
    username,
    nickname: null,
    steam_id: steamId,
    role,
    is_ghost: true,
  })

  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  resetGhostForm()
  toast('Ghost player added')
  loadRoster()
})

loadRoster()
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check cs2-hub/roster.js`
Expected: no output.

- [ ] **Step 3: Browser smoke test (member view)**

Open `cs2-hub/roster.html` in a browser as a non-owner team member (or sign out and sign in as a member account).

Expected:
- Roster grid renders with cards.
- Each card shows nickname, role as a static colored badge (NOT a dropdown), and "MEMBER" or "PENDING" status badge.
- "+ Add ghost player" button is NOT visible.
- No remove (×) buttons on cards.
- No console errors.

- [ ] **Step 4: Browser smoke test (owner view)**

Sign in as the team owner. Reload `roster.html`.

Expected:
- Each card shows the role as a `<select>` dropdown (clickable, all 9 options).
- "+ Add ghost player" button is visible at the top right.
- Each card has a "×" remove button in its top-right corner.

- [ ] **Step 5: Inline role change works**

As owner: change a card's role via the dropdown. Toast appears: "Role updated". Reload page — the new role persists.

- [ ] **Step 6: Add ghost flow works**

As owner: click "+ Add ghost player". Form appears. Enter `username = TestGhost`, `steam_id = 76561198000000099`, `role = AWPer`. Click Add.

Expected: toast "Ghost player added", form closes, new card appears with "PENDING" badge, AWPer role.

Try invalid Steam ID (e.g., `12345`): error message displayed, no insert.

- [ ] **Step 7: Remove flows work**

As owner:
- Click × on the ghost card → confirm → toast "Ghost removed" → card disappears.
- Click × on a real member card → confirm → toast "Member removed" → card disappears, team_members row gone.

- [ ] **Step 8: Commit**

```bash
git add cs2-hub/roster.js
git commit -m "feat(roster): rewrite with team_members source-of-truth, owner-gated edit, ghost flow"
```

---

### Task 12: E2E manual smoke checklist

**Files:**
- Create: `docs/superpowers/specs/2026-05-08-auto-roster-e2e-checklist.md`

Final integration verification across the full feature surface. Run by hand; mark each as it passes.

- [ ] **Step 1: Create the checklist file**

Create `docs/superpowers/specs/2026-05-08-auto-roster-e2e-checklist.md`:

```markdown
# Auto-Roster E2E Manual Checklist (2026-05-08)

Run all 7 scenarios end-to-end before declaring the feature shipped.

## 1. Fresh user joins via team code
- [ ] Sign out. Steam-login as a NEW user (or one not in any team).
- [ ] Lands on `team-select.html`.
- [ ] Enter the owner's team join code, fill display name, click Join.
- [ ] Redirects to `dashboard.html`.
- [ ] Open `roster.html` — your row appears with role `Unassigned`, status `MEMBER`.

## 2. Owner promotes new member
- [ ] Sign in as owner. Open `roster.html`.
- [ ] Find the `Unassigned` row from step 1; change role dropdown to `IGL`.
- [ ] Toast: "Role updated".
- [ ] Reload — role persists.
- [ ] Open `vods.html` — the player appears in the "Roster · Career Stats" band (rating may be `—` if no demos yet).

## 3. Owner adds a ghost player
- [ ] On `roster.html` as owner: click "+ Add ghost player".
- [ ] Enter username `ScoutPick`, Steam64 `76561198000000123` (or any valid Steam64), role `AWPer`. Click Add.
- [ ] Toast: "Ghost player added". Form closes.
- [ ] New card appears with `PENDING` badge.

## 4. Ghost merges on Steam-login
- [ ] Sign out. Steam-login as the user matching the Steam64 from step 3.
- [ ] On `team-select.html`, join the same team via code.
- [ ] Reload `roster.html`. Sign in as owner.
- [ ] The ghost row's `PENDING` badge has changed to `MEMBER`.
- [ ] Role is still `AWPer` (preserved through merge).
- [ ] No duplicate row exists for that Steam64.

## 5. Owner removes a real member
- [ ] As owner: click × on a real member's card. Confirm.
- [ ] Toast: "Member removed".
- [ ] Card disappears.
- [ ] Verify in Supabase: `team_members` row gone, `roster` row gone.

## 6. Owner removes a ghost
- [ ] As owner: re-add a ghost. Click × on it. Confirm.
- [ ] Toast: "Ghost removed".
- [ ] Card disappears.
- [ ] `team_members` is unchanged (no row was ever created for the ghost).

## 7. Non-owner write attempts blocked by RLS
- [ ] Sign in as a non-owner team member.
- [ ] Open `roster.html`. Confirm role is a static badge (not a dropdown), no × buttons, no Add ghost button.
- [ ] Open browser DevTools console. Run:
  ```js
  const { supabase } = await import('./supabase.js')
  await supabase.from('roster').update({ role: 'IGL' }).eq('id', '<some-roster-id>')
  ```
  Expected: error or zero rows updated. RLS blocks the write.
```

- [ ] **Step 2: Run all 7 scenarios**

Open the checklist file, run each scenario, check off each box. **Stop and fix any failure** before considering the feature shipped.

If all 7 pass, the implementation is complete.

- [ ] **Step 3: Commit the checklist**

```bash
git add docs/superpowers/specs/2026-05-08-auto-roster-e2e-checklist.md
git commit -m "docs: e2e smoke checklist for auto-roster feature"
```

---

## Self-Review

After writing the plan above, I checked it against the spec:

**Spec coverage:**
- "Identity & data model" → Tasks 1–4 (verify, schema, triggers, RLS).
- "UI flows 1–5" → Tasks 8 (flow 1), 11 (flows 2–4), and verified by Task 12 (flow 5 is read-only stats consumption with no code change beyond Task 9).
- "Permissions table" → enforced in Task 4 (RLS) and Task 11 (UI gate via `isTeamOwner`).
- "Database changes — Files 1, 2, 3" → File 1 verified by Task 1; File 2 written across Tasks 2, 3, 4; File 3 written in Task 5; rollbacks in Task 6.
- "JS code changes — files modified" → all five JS files covered (Tasks 7, 8, 9, 11; HTML in Task 10).
- "Testing — unit, db, e2e" → DB tests in Task 3; auth.js unit test in Task 7; in-page smoke in Task 11; E2E checklist in Task 12.
- "Rollout order" → matches task order (SQL first, then JS, then E2E).
- "Risks & mitigations" → addressed throughout (idempotent SQL with `if not exists`, trigger guard against duplicate inserts, `coalesce` username fallback in trigger).

**Placeholder scan:** No "TBD"/"TODO" markers. Every code step contains complete code. Every command is exact.

**Type consistency:**
- `is_ghost` (boolean), `STAFF_ROLES`, `ALL_ROLES`, `isTeamOwner` — all spelled the same in every task that uses them.
- The trigger function reads from `auth.users.raw_user_meta_data->>'steam_id'` (Supabase actually exposes `raw_user_meta_data` as the JSONB column; `user_metadata` is the JS-side name). Verified against `cs2-hub/api/steam-callback.js:50` which writes `user_metadata` (this is the admin-API JSON shape) — Postgres stores it under `raw_user_meta_data`. Spec uses `user_metadata`; plan uses `raw_user_meta_data` — this is correct because the spec describes the JS-side concept while the trigger runs in SQL.
- `team_members.role` values are `'owner'` / `'member'` (per multi-hub plan Task 1 line 78). Used consistently.

No issues found.
