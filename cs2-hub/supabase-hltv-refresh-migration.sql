-- cs2-hub/supabase-hltv-refresh-migration.sql
-- Daily-refreshed HLTV team + player tables. Replaces the static
-- hltv-teams.json / hltv-players.json files for the autocomplete + logo
-- lookups, so a roster change on HLTV is reflected the day after.
--
-- Writes happen from the VPS scraper with the service-role key (bypasses RLS).
-- Reads are open to anon + authenticated so the Pro tab + autocomplete work
-- without login.
--
-- Idempotent: safe to re-run.

create table if not exists hltv_teams (
  id         int  primary key,                   -- HLTV team id (stable across renames)
  name       text not null,
  logo_url   text,
  rank       int,                                -- nullable; only the top ~30 are ranked
  updated_at timestamptz not null default now()
);

create table if not exists hltv_players (
  id         int  primary key,                   -- HLTV player id (stable across team moves)
  ign        text not null,
  full_name  text,
  team_name  text,                               -- denormalized — matches hltv-players.json shape
  team_id    int,                                -- nullable FK-ish (no constraint, team can be unranked/missing)
  country    text,                               -- ISO-2 code, e.g. "FR"
  photo_url  text,
  updated_at timestamptz not null default now()
);

create index if not exists hltv_teams_name_lower_idx   on hltv_teams   (lower(name));
create index if not exists hltv_teams_rank_idx         on hltv_teams   (rank) where rank is not null;
create index if not exists hltv_players_ign_lower_idx  on hltv_players (lower(ign));
create index if not exists hltv_players_team_id_idx    on hltv_players (team_id);

alter table hltv_teams   enable row level security;
alter table hltv_players enable row level security;

-- Drop & recreate so re-runs always have current policies.
drop policy if exists "hltv_teams_read"   on hltv_teams;
drop policy if exists "hltv_players_read" on hltv_players;

create policy "hltv_teams_read"   on hltv_teams   for select to anon, authenticated using (true);
create policy "hltv_players_read" on hltv_players for select to anon, authenticated using (true);

-- Inserts/updates happen via the VPS using the service-role key, which
-- bypasses RLS. We deliberately do NOT add insert/update policies for
-- authenticated users — they should never write here.
