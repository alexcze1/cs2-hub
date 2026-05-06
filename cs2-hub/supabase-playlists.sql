-- cs2-hub/supabase-playlists.sql
-- Run in Supabase SQL Editor after supabase-demos.sql
--
-- Adds team-shared round playlists for the analysis page. RLS mirrors the
-- demos pattern: a user can read all playlists for any team they have
-- uploaded a demo for; writes are scoped to the row's creator.

create table playlists (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null,
  name        text not null,
  description text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table playlist_rounds (
  id          uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references playlists(id) on delete cascade,
  demo_id     uuid not null references demos(id)     on delete cascade,
  round_idx   int  not null,
  note        text,
  position    int  not null,
  added_by    uuid references auth.users(id),
  added_at    timestamptz default now(),
  unique (playlist_id, demo_id, round_idx)
);

create index playlists_team_updated_idx
  on playlists (team_id, updated_at desc);

create index playlist_rounds_playlist_position_idx
  on playlist_rounds (playlist_id, position);

alter table playlists        enable row level security;
alter table playlist_rounds  enable row level security;

-- playlists: any authenticated user who has uploaded a demo for the same team
-- can read; writes are scoped to created_by = auth.uid().
create policy "team_playlists_select" on playlists
  for select to authenticated
  using (team_id IN (
    select distinct team_id from demos d where d.uploaded_by = auth.uid()
  ));

create policy "team_playlists_insert" on playlists
  for insert to authenticated
  with check (
    created_by = auth.uid()
    AND team_id IN (
      select distinct team_id from demos d where d.uploaded_by = auth.uid()
    )
  );

create policy "team_playlists_update" on playlists
  for update to authenticated
  using (team_id IN (
    select distinct team_id from demos d where d.uploaded_by = auth.uid()
  ))
  with check (team_id IN (
    select distinct team_id from demos d where d.uploaded_by = auth.uid()
  ));

create policy "team_playlists_delete" on playlists
  for delete to authenticated
  using (team_id IN (
    select distinct team_id from demos d where d.uploaded_by = auth.uid()
  ));

-- playlist_rounds: gated through the parent playlist's team_id.
create policy "team_playlist_rounds_select" on playlist_rounds
  for select to authenticated
  using (playlist_id IN (
    select id from playlists p where p.team_id IN (
      select distinct team_id from demos d where d.uploaded_by = auth.uid()
    )
  ));

create policy "team_playlist_rounds_insert" on playlist_rounds
  for insert to authenticated
  with check (
    added_by = auth.uid()
    AND playlist_id IN (
      select id from playlists p where p.team_id IN (
        select distinct team_id from demos d where d.uploaded_by = auth.uid()
      )
    )
  );

create policy "team_playlist_rounds_update" on playlist_rounds
  for update to authenticated
  using (playlist_id IN (
    select id from playlists p where p.team_id IN (
      select distinct team_id from demos d where d.uploaded_by = auth.uid()
    )
  ));

create policy "team_playlist_rounds_delete" on playlist_rounds
  for delete to authenticated
  using (playlist_id IN (
    select id from playlists p where p.team_id IN (
      select distinct team_id from demos d where d.uploaded_by = auth.uid()
    )
  ));
