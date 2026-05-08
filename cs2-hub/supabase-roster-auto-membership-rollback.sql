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
