-- cs2-hub/supabase-collab-migration.sql
--
-- Schema for catalogue items #52 (strat comments), #59 (per-player
-- goals), #60 (antistrat tasks). Idempotent — safe to re-run.

-- ─────────────────────────────────────────────────────────────
-- #52 — Comments on strats
-- ─────────────────────────────────────────────────────────────
create table if not exists strat_comments (
  id          uuid primary key default gen_random_uuid(),
  strat_id    uuid not null references strats(id) on delete cascade,
  team_id     uuid not null,
  user_id     uuid references auth.users(id),
  user_name   text,
  content     text not null,
  created_at  timestamptz default now(),
  resolved    boolean default false,
  resolved_at timestamptz
);
create index if not exists idx_strat_comments_strat
  on strat_comments(strat_id, created_at desc);

alter table strat_comments enable row level security;

drop policy if exists "team_strat_comments_select" on strat_comments;
create policy "team_strat_comments_select" on strat_comments
  for select to authenticated
  using (team_id in (
    select team_id from team_members where user_id = auth.uid()
  ));

drop policy if exists "team_strat_comments_insert" on strat_comments;
create policy "team_strat_comments_insert" on strat_comments
  for insert to authenticated
  with check (
    team_id in (select team_id from team_members where user_id = auth.uid())
    and user_id = auth.uid()
  );

drop policy if exists "team_strat_comments_update" on strat_comments;
create policy "team_strat_comments_update" on strat_comments
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "team_strat_comments_delete" on strat_comments;
create policy "team_strat_comments_delete" on strat_comments
  for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from teams t where t.id = strat_comments.team_id and t.owner_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────
-- #59 — Per-player goals
-- Nullable player_id on the existing goals table so team-level goals
-- (current default) keep working and per-player goals are opt-in.
-- ─────────────────────────────────────────────────────────────
alter table goals add column if not exists player_id uuid references roster(id) on delete set null;
create index if not exists idx_goals_player on goals(player_id) where player_id is not null;

-- ─────────────────────────────────────────────────────────────
-- #60 — Antistrat task assignment
-- ─────────────────────────────────────────────────────────────
create table if not exists antistrat_tasks (
  id           uuid primary key default gen_random_uuid(),
  opponent_id  uuid references opponents(id) on delete cascade,
  team_id      uuid not null,
  assignee_id  uuid references roster(id) on delete set null,
  title        text not null,
  description  text,
  due_date     date,
  status       text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  created_at   timestamptz default now(),
  created_by   uuid references auth.users(id)
);
create index if not exists idx_antistrat_tasks_opp
  on antistrat_tasks(opponent_id, status);
create index if not exists idx_antistrat_tasks_assignee
  on antistrat_tasks(assignee_id, status);
create index if not exists idx_antistrat_tasks_team
  on antistrat_tasks(team_id, status);

alter table antistrat_tasks enable row level security;

drop policy if exists "team_antistrat_tasks_select" on antistrat_tasks;
create policy "team_antistrat_tasks_select" on antistrat_tasks
  for select to authenticated
  using (team_id in (
    select team_id from team_members where user_id = auth.uid()
  ));

drop policy if exists "team_antistrat_tasks_modify" on antistrat_tasks;
create policy "team_antistrat_tasks_modify" on antistrat_tasks
  for all to authenticated
  using (team_id in (
    select team_id from team_members where user_id = auth.uid()
  ))
  with check (team_id in (
    select team_id from team_members where user_id = auth.uid()
  ));
