-- cs2-hub/supabase-roster-auto-membership.sql
-- Purpose: roster ↔ team_members auto-sync, owner-only writes, ghost players.
-- Idempotent: safe to re-run.

-- ── 1. Expand role check ────────────────────────────────────────
alter table roster drop constraint if exists roster_role_check;
alter table roster add constraint roster_role_check
  check (role in ('IGL','AWPer','Entry','Support','Lurker',
                  'Coach','Manager','Bench','Unassigned'));

-- ── 2. Ghost flag column ───────────────────────────────────────
alter table roster add column if not exists is_ghost boolean not null default false;

-- ── 3. Trigger: on team_members insert, create-or-merge roster row ──
create or replace function fn_team_member_roster_sync()
returns trigger as $$
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

  -- 3a. Existing real row → no-op (backfill / re-insert safety).
  if exists (
    select 1 from roster
     where team_id = NEW.team_id and user_id = NEW.user_id and is_ghost = false
  ) then
    return NEW;
  end if;

  -- 3b. Ghost row matching this steam_id in this team → merge.
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

  -- 3c. Otherwise insert a fresh roster row.
  insert into roster (team_id, user_id, username, steam_id, role, is_ghost)
  values (NEW.team_id, NEW.user_id, v_username, v_steam_id, 'Unassigned', false);

  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_team_member_roster_sync on team_members;
create trigger trg_team_member_roster_sync
  after insert on team_members
  for each row execute function fn_team_member_roster_sync();

-- ── 4. Trigger: on team_members delete, drop the matching real roster row ──
create or replace function fn_team_member_roster_cleanup()
returns trigger as $$
begin
  delete from roster
   where team_id = OLD.team_id
     and user_id = OLD.user_id
     and is_ghost = false;
  return OLD;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_team_member_roster_cleanup on team_members;
create trigger trg_team_member_roster_cleanup
  after delete on team_members
  for each row execute function fn_team_member_roster_cleanup();

-- ── 5. Owner-only writes on roster; any member can read ──
drop policy if exists "team_roster" on roster;
drop policy if exists "roster_select_member" on roster;
drop policy if exists "roster_update_owner" on roster;
drop policy if exists "roster_insert_owner" on roster;
drop policy if exists "roster_delete_owner" on roster;

create policy "roster_select_member" on roster for select to authenticated
  using (team_id in (
    select team_id from team_members where user_id = auth.uid()
  ));

create policy "roster_update_owner" on roster for update to authenticated
  using (team_id in (
    select team_id from team_members where user_id = auth.uid() and role = 'owner'
  ))
  with check (team_id in (
    select team_id from team_members where user_id = auth.uid() and role = 'owner'
  ));

create policy "roster_insert_owner" on roster for insert to authenticated
  with check (team_id in (
    select team_id from team_members where user_id = auth.uid() and role = 'owner'
  ));

create policy "roster_delete_owner" on roster for delete to authenticated
  using (team_id in (
    select team_id from team_members where user_id = auth.uid() and role = 'owner'
  ));
