-- cs2-hub/supabase-roster-trigger-nickname-only.sql
-- Updates fn_team_member_roster_sync to populate roster.nickname from
-- auth metadata instead of roster.username. We dropped the "display name"
-- field from the UI; only nickname remains, so the trigger should seed
-- nickname (the client can overwrite it right after joining/creating).
--
-- Existing roster rows are left alone — only future inserts/merges
-- change behaviour.
--
-- Idempotent: safe to re-run.

-- 1. roster.username is no longer required. Make it nullable so new
-- inserts (trigger + ghost form) don't have to set it.
alter table roster alter column username drop not null;

-- 2. Trigger now writes nickname, not username.
create or replace function fn_team_member_roster_sync()
returns trigger as $$
declare
  v_steam_id text;
  v_nickname text;
  v_ghost_id uuid;
begin
  -- Bypass RLS for the duration of this trigger.
  perform set_config('row_security', 'off', true);

  select raw_user_meta_data->>'steam_id',
         coalesce(raw_user_meta_data->>'name',
                  raw_user_meta_data->>'username',
                  email)
    into v_steam_id, v_nickname
    from auth.users where id = NEW.user_id;

  -- Existing real row → no-op (backfill / re-insert safety).
  if exists (
    select 1 from roster
     where team_id = NEW.team_id and user_id = NEW.user_id and is_ghost = false
  ) then
    return NEW;
  end if;

  -- Ghost row matching this steam_id in this team → merge.
  select id into v_ghost_id from roster
   where team_id = NEW.team_id and steam_id = v_steam_id and is_ghost = true
   limit 1;

  if v_ghost_id is not null then
    update roster
       set user_id = NEW.user_id,
           is_ghost = false,
           nickname = coalesce(nickname, v_nickname)
     where id = v_ghost_id;
    return NEW;
  end if;

  -- Otherwise insert a fresh roster row.
  insert into roster (team_id, user_id, nickname, steam_id, role, is_ghost)
  values (NEW.team_id, NEW.user_id, v_nickname, v_steam_id, 'Unassigned', false);

  return NEW;
end;
$$ language plpgsql security definer;
