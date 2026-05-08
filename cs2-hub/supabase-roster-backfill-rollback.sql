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
