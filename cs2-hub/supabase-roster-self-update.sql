-- cs2-hub/supabase-roster-self-update.sql
-- Lets a member update their own roster row (username, nickname, etc.)
-- without needing to be team owner. The owner policy stays in place
-- for editing other members.
--
-- Required so team-select.js can persist the displayName/nickname the
-- joining user types, without hitting RLS.
--
-- Idempotent: safe to re-run.

drop policy if exists "roster_update_self" on roster;

create policy "roster_update_self" on roster for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
