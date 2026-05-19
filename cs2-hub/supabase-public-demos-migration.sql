-- cs2-hub/supabase-public-demos-migration.sql
-- Public Pro Demos: schema additions + RLS for anon read.
-- Spec: docs/superpowers/specs/2026-05-18-public-pro-demos-design.md
-- Idempotent: safe to re-run.

-- 1. Allow demos rows without a team (HLTV-ingested demos are not team-scoped).
alter table demos alter column team_id drop not null;

-- 2. Public flag + provenance columns.
alter table demos add column if not exists is_public        boolean not null default false;
alter table demos add column if not exists source           text    not null default 'team_upload';
alter table demos add column if not exists source_match_id  text;   -- HLTV match id (idempotency key)
alter table demos add column if not exists source_map_index int;    -- 0-based index of the .dem inside the archive
alter table demos add column if not exists source_url       text;   -- HLTV match URL (attribution / re-download)
alter table demos add column if not exists event_name       text;   -- e.g. "BLAST Premier Spring Final 2026"
alter table demos add column if not exists team_a_name      text;   -- captured at scrape time so the list renders pre-parse
alter table demos add column if not exists team_b_name      text;

-- Source check: drop & re-add so re-runs always reflect the current allowed set.
alter table demos drop constraint if exists demos_source_check;
alter table demos add  constraint demos_source_check
  check (source in ('team_upload', 'hltv'));

-- 3. Idempotency: one row per (source, match, map). Partial predicate so team uploads
--    (which have null source_match_id) aren't constrained.
create unique index if not exists demos_source_match_unique
  on demos (source, source_match_id, source_map_index)
  where source_match_id is not null;

-- 4. Index covering the Pro tab's list query.
create index if not exists demos_public_recent_idx
  on demos (created_at desc) where is_public = true;

-- 5. Public-read RLS policies (anon + authenticated). These are additive — existing
--    team-scoped policies are untouched and continue to gate non-public rows.
drop policy if exists "public_demos_read"            on demos;
drop policy if exists "public_demo_players_read"     on demo_players;
drop policy if exists "public_demo_team_stats_read"  on demo_team_stats;

create policy "public_demos_read" on demos
  for select to anon, authenticated
  using (is_public = true);

create policy "public_demo_players_read" on demo_players
  for select to anon, authenticated
  using (demo_id in (select id from demos where is_public = true));

create policy "public_demo_team_stats_read" on demo_team_stats
  for select to anon, authenticated
  using (demo_id in (select id from demos where is_public = true));
