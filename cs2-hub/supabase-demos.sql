-- cs2-hub/supabase-demos.sql
-- Run in Supabase SQL Editor after supabase-setup.sql

create table demos (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null,
  uploaded_by   uuid references auth.users(id),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),

  -- set at upload time
  status        text not null default 'pending'
                  check (status in ('pending','processing','ready','error')),
  error_message text,
  storage_path  text not null,

  -- populated by VPS after parsing
  map           text,
  played_at     timestamptz,
  score_ct      int,
  score_t       int,
  opponent_name text,
  duration_ticks int,
  tick_rate     int,
  match_data    jsonb
);

create table demo_players (
  id         uuid primary key default gen_random_uuid(),
  demo_id    uuid not null references demos(id) on delete cascade,
  steam_id   text,
  name       text,
  side       text check (side in ('ct','t')),
  kills      int,
  deaths     int,
  assists    int,
  adr        float,
  rating     float
);

alter table demos        enable row level security;
alter table demo_players enable row level security;

-- Note: supabase-setup.sql uses permissive `using (true)` policies for all older tables
-- (events, strats, vods, opponents, roster) because the app has a single-team model with
-- no team_members join table. The demos table introduces team_id, so we scope it properly
-- using the team_id column directly rather than `using (true)`.

-- Only allow users to access demos for their own team.
-- `uploaded_by` is used as the ownership signal since there is no team_members table.
-- Reads: any authenticated user who uploaded at least one demo for that team can read all
-- demos for that team. Writes: scoped to the uploader.
create policy "team_demos_select" on demos
  for select to authenticated
  using (team_id IN (
    select distinct team_id from demos d2 where d2.uploaded_by = auth.uid()
  ));

create policy "team_demos_insert" on demos
  for insert to authenticated
  with check (uploaded_by = auth.uid());

create policy "team_demos_update" on demos
  for update to authenticated
  using (uploaded_by = auth.uid())
  with check (uploaded_by = auth.uid());

create policy "team_demos_delete" on demos
  for delete to authenticated
  using (uploaded_by = auth.uid());

-- demo_players: accessible if the parent demo is accessible
create policy "team_demo_players_select" on demo_players
  for select to authenticated
  using (demo_id IN (
    select id from demos where team_id IN (
      select distinct team_id from demos d2 where d2.uploaded_by = auth.uid()
    )
  ));

create policy "team_demo_players_insert" on demo_players
  for insert to authenticated
  with check (demo_id IN (select id from demos where uploaded_by = auth.uid()));

create policy "team_demo_players_update" on demo_players
  for update to authenticated
  using (demo_id IN (select id from demos where uploaded_by = auth.uid()));

create policy "team_demo_players_delete" on demo_players
  for delete to authenticated
  using (demo_id IN (select id from demos where uploaded_by = auth.uid()));

-- Storage bucket (run separately if SQL editor doesn't support storage API)
insert into storage.buckets (id, name, public)
values ('demos', 'demos', false)
on conflict do nothing;

-- Storage: scope to the team's prefix (teamId/ path prefix set at upload time in demos.js)
create policy "team_demos_storage_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'demos'
    AND (storage.foldername(name))[1] IN (
      select distinct team_id::text from demos where uploaded_by = auth.uid()
    )
  );

create policy "team_demos_storage_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'demos'
    AND (storage.foldername(name))[1] IN (
      select distinct team_id::text from demos where uploaded_by = auth.uid()
    )
  );

create policy "team_demos_storage_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'demos'
    AND (storage.foldername(name))[1] IN (
      select distinct team_id::text from demos where uploaded_by = auth.uid()
    )
  );

create index on demos (team_id, created_at desc);
create index on demos (status) where status = 'pending';

-- Migration 2026-05-01: per-roster scores for halftime-aware display
alter table demos add column if not exists team_a_score      int;
alter table demos add column if not exists team_b_score      int;
alter table demos add column if not exists team_a_first_side text
  check (team_a_first_side in ('ct','t'));
