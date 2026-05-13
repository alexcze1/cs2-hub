-- cs2-hub/supabase-team-members-owner-kick.sql
-- Lets the team owner remove (kick) any member from team_members.
-- Without this, only the member themselves can delete their own row,
-- so the × button on the roster page fails silently for everyone else.
--
-- Idempotent: safe to re-run.

drop policy if exists "team_members_delete_owner" on team_members;

create policy "team_members_delete_owner" on team_members for delete to authenticated
  using (
    team_id in (
      select team_id from team_members
       where user_id = auth.uid() and role = 'owner'
    )
  );
