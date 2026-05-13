-- cs2-hub/supabase-team-members-owner-select.sql
-- Lets the team owner SELECT all members of their team, not just
-- themselves. Required so .delete().select() (and any "list members"
-- UI) returns the right rows. The existing "Users see own memberships"
-- ALL policy stays in place — both are permissive, so an owner sees
-- everyone on their team and a non-owner sees only themselves.
--
-- Idempotent: safe to re-run.

drop policy if exists "team_members_select_owner" on team_members;

create policy "team_members_select_owner" on team_members for select to authenticated
  using (
    team_id in (
      select team_id from team_members
       where user_id = auth.uid() and role = 'owner'
    )
  );
