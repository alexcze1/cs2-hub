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
