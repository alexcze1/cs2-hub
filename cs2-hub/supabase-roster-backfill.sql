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
