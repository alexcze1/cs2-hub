-- cs2-hub/supabase-roster-trigger-rls-fix.sql
-- Fix: "new row violates row-level security policy for table roster"
-- when a non-owner joins a team.
--
-- Cause: fn_team_member_roster_sync inserts into roster, but the
-- roster_insert_owner policy only allows owners. SECURITY DEFINER alone
-- doesn't bypass RLS unless the function owner has BYPASSRLS — so we
-- explicitly turn RLS off inside the function with `SET row_security`.
--
-- Idempotent: safe to re-run.

create or replace function fn_team_member_roster_sync()
returns trigger
language plpgsql
security definer
set row_security = off
as $$
declare
  v_steam_id text;
  v_username text;
  v_ghost_id uuid;
begin
  select raw_user_meta_data->>'steam_id',
         coalesce(raw_user_meta_data->>'name',
                  raw_user_meta_data->>'username',
                  email)
    into v_steam_id, v_username
    from auth.users where id = NEW.user_id;

  if exists (
    select 1 from roster
     where team_id = NEW.team_id and user_id = NEW.user_id and is_ghost = false
  ) then
    return NEW;
  end if;

  select id into v_ghost_id from roster
   where team_id = NEW.team_id and steam_id = v_steam_id and is_ghost = true
   limit 1;

  if v_ghost_id is not null then
    update roster
       set user_id = NEW.user_id,
           is_ghost = false,
           username = coalesce(username, v_username)
     where id = v_ghost_id;
    return NEW;
  end if;

  insert into roster (team_id, user_id, username, steam_id, role, is_ghost)
  values (NEW.team_id, NEW.user_id, v_username, v_steam_id, 'Unassigned', false);

  return NEW;
end;
$$;

create or replace function fn_team_member_roster_cleanup()
returns trigger
language plpgsql
security definer
set row_security = off
as $$
begin
  delete from roster
   where team_id = OLD.team_id
     and user_id = OLD.user_id
     and is_ghost = false;
  return OLD;
end;
$$;
