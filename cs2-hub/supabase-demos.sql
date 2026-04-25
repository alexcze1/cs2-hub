-- cs2-hub/supabase-demos.sql
-- Run in Supabase SQL Editor after supabase-setup.sql

create table demos (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null,
  uploaded_by   uuid references auth.users(id),
  created_at    timestamptz default now(),

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
  demo_id    uuid references demos(id) on delete cascade,
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

create policy "auth_all" on demos        for all to authenticated using (true) with check (true);
create policy "auth_all" on demo_players for all to authenticated using (true) with check (true);

-- Storage bucket (run separately if SQL editor doesn't support storage API)
insert into storage.buckets (id, name, public)
values ('demos', 'demos', false)
on conflict do nothing;

create policy "auth_all" on storage.objects
  for all to authenticated
  using (bucket_id = 'demos')
  with check (bucket_id = 'demos');
