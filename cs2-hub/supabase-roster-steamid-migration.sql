-- cs2-hub/supabase-roster-steamid-migration.sql
-- Idempotent: safe to re-run.

alter table roster add column if not exists steam_id text;
create index if not exists roster_steam_id_idx on roster (team_id, steam_id);
