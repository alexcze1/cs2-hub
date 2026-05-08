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
