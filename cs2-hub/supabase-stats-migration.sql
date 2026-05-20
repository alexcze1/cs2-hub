-- Ship 1: per-demo scoreboard schema
-- Idempotent: safe to re-run.

-- 1. Relax demo_players.side check to allow 'all'
alter table demo_players drop constraint if exists demo_players_side_check;
alter table demo_players add constraint demo_players_side_check
  check (side in ('all','ct','t'));

-- 2. Add new stat columns to demo_players (if not present)
alter table demo_players add column if not exists team            text;
alter table demo_players add constraint demo_players_team_check
  check (team is null or team in ('a','b'));
alter table demo_players add column if not exists hs_pct          float;
alter table demo_players add column if not exists kast_pct        float;
alter table demo_players add column if not exists multi_2k        int;
alter table demo_players add column if not exists multi_3k        int;
alter table demo_players add column if not exists multi_4k        int;
alter table demo_players add column if not exists multi_5k        int;
alter table demo_players add column if not exists opening_kills   int;
alter table demo_players add column if not exists opening_deaths  int;
alter table demo_players add column if not exists clutches_won    int;
alter table demo_players add column if not exists clutches_lost   int;
alter table demo_players add column if not exists utility_dmg     int;
alter table demo_players add column if not exists flash_assists   int;
alter table demo_players add column if not exists traded_deaths   int;
alter table demo_players add column if not exists impact_rating   float;
alter table demo_players add column if not exists rounds_played   int;

-- 3. Truncate any pre-existing demo_players rows (Ship 1 fully replaces stats)
truncate table demo_players;

-- 4. Unique row per (demo, player, side)
create unique index if not exists demo_players_unique_side
  on demo_players (demo_id, steam_id, side);

-- 5. Create demo_team_stats
create table if not exists demo_team_stats (
  id uuid primary key default gen_random_uuid(),
  demo_id uuid not null references demos(id) on delete cascade,
  team text not null check (team in ('a','b')),

  pistol_wins         int, pistol_played       int,
  five_v_four_wins    int, five_v_four_played  int,
  five_v_four_t_wins  int, five_v_four_t_played  int,
  five_v_four_ct_wins int, five_v_four_ct_played int,

  first_kills         int, first_deaths        int,
  first_kills_t       int, first_kills_ct      int,
  first_deaths_t      int, first_deaths_ct     int,

  eco_wins       int, eco_played       int,
  force_wins     int, force_played     int,
  full_buy_wins  int, full_buy_played  int,

  bomb_plants    int, bomb_defuses     int,

  ct_round_wins  int, ct_rounds_played int,
  t_round_wins   int, t_rounds_played  int,

  unique (demo_id, team)
);

alter table demo_team_stats enable row level security;

drop policy if exists "team stats follow demo" on demo_team_stats;
create policy "team stats follow demo"
  on demo_team_stats for select
  using (exists (
    select 1 from demos d
    where d.id = demo_id and d.uploaded_by = auth.uid()
  ));

-- 6. Ship 3: anti-eco counters (rounds where opponent was on eco)
alter table demo_team_stats add column if not exists anti_eco_wins   int;
alter table demo_team_stats add column if not exists anti_eco_played int;

-- 7. Ship 4: spec-driven economy classification — hard_eco / half_buy / anti_force
-- (eco / force_buy / full_buy / anti_eco already exist as columns above).
alter table demo_team_stats add column if not exists hard_eco_wins   int;
alter table demo_team_stats add column if not exists hard_eco_played int;
alter table demo_team_stats add column if not exists half_buy_wins   int;
alter table demo_team_stats add column if not exists half_buy_played int;
alter table demo_team_stats add column if not exists anti_force_wins   int;
alter table demo_team_stats add column if not exists anti_force_played int;
