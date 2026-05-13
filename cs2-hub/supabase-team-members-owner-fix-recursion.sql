-- cs2-hub/supabase-team-members-owner-fix-recursion.sql
-- Rewrites the owner policies on team_members to look up ownership
-- via teams.owner_id instead of team_members. Referencing team_members
-- from within a team_members policy triggers
-- "infinite recursion detected in policy for relation team_members".
--
-- Idempotent: safe to re-run.

drop policy if exists "team_members_select_owner" on team_members;
drop policy if exists "team_members_delete_owner" on team_members;

create policy "team_members_select_owner" on team_members for select to authenticated
  using (
    team_id in (select id from teams where owner_id = auth.uid())
  );

create policy "team_members_delete_owner" on team_members for delete to authenticated
  using (
    team_id in (select id from teams where owner_id = auth.uid())
  );
