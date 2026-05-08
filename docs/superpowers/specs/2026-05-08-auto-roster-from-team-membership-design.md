# Auto-Roster from Team Membership — Design Spec

**Date:** 2026-05-08
**Project:** cs2-hub
**Status:** Approved, ready for implementation plan

## Goal

Eliminate manual roster entry. Make `team_members` (Supabase auth users who have joined a team) the source of truth for "who is on a roster," with `role` deciding whether each person counts as a tracked active player or staff/bench.

## Motivation

Today's flow forces every user to (a) Steam-log-in (their `steam_id` already lives in `auth.user_metadata`), (b) get added to a `roster` row by a separate manual modal, (c) have their Steam ID pasted in by hand. Three sources of truth for one fact. The Steam-login system already knows who the user is and what their Steam ID is; the roster should consume that, not duplicate it.

## Non-Goals

- Multi-team management UI improvements (covered by the multi-hub plan).
- Self-service "leave team" UI for members (mentioned only; out of scope).
- Migrating data from a multi-user environment — this assumes a single existing user with a single roster (verified by exploration).
- Changes to the per-player career-stats feature shipped on 2026-05-08 (Tasks 1–16). The contract with `roster-stats.js` is preserved.

## Architecture

`team_members` is the single source of truth for membership. `roster` is a per-membership profile record (nickname, role, optional ghost flag), one-to-one with `team_members` for real users, plus owner-curated "ghost" rows for un-joined people.

A Postgres trigger keeps `roster` in sync with `team_members` on insert and delete. Steam ID is read from `auth.user_metadata.steam_id` and copied into the roster row at trigger time. Ghost rows can pre-exist for a known Steam ID; when the matching user eventually joins the team, the trigger merges in place rather than creating a duplicate.

UI: `roster.html` becomes read-only for members; only the team owner can edit roles, nicknames, and add/remove ghost rows. Role selection alone determines whether a person is tracked in stats.

## Data Model

### Tables (after migration)

| Table | Status | Key columns |
|---|---|---|
| `auth.users` | exists | `id`, `email`, `user_metadata.steam_id` (set during Steam login) |
| `teams` | new (multi-hub Task 1) | `id`, `name`, `owner_id`, `join_code` |
| `team_members` | new (multi-hub Task 1) | `id`, `team_id`, `user_id`, `role` ('owner'\|'member'), `joined_at`. Unique `(team_id, user_id)`. |
| `roster` | modified | + `team_id NOT NULL`, + `is_ghost boolean default false`, expanded role check |

### `roster.role` check constraint (expanded)

Allowed values:
- **Tracked (active player):** `IGL`, `Entry`, `AWPer`, `Lurker`, `Support`
- **Hidden from stats:** `Coach`, `Manager`, `Bench`, `Unassigned`

### Row taxonomy

| Type | `user_id` | `is_ghost` | `steam_id` | Created by |
|---|---|---|---|---|
| Real | set | `false` | from `auth.user_metadata.steam_id` | trigger on `team_members` insert |
| Ghost | `null` | `true` | manually entered | owner via "Add ghost" UI |

### Ghost → Real conversion

When a Steam-logged-in user joins a team via `team_members` insert, the trigger first checks for an existing ghost row with matching `team_id` + `steam_id`. If found, the trigger updates that row in place (sets `user_id`, sets `is_ghost = false`, preserves nickname and role). If not found, a fresh roster row is inserted with `role = 'Unassigned'`.

## UI Flows

### Flow 1 — User joins a team

1. User Steam-logs-in → lands on `team-select.html`.
2. Picks "Create team" or "Join with code."
3. `team-select.js` inserts into `team_members`. Trigger fires, creating (or merging into a ghost) a roster row with `role = 'Unassigned'` and the user's `steam_id` from auth metadata.
4. `team-select.js` also performs a defensive `upsert` against `roster` with the same data (`on conflict do nothing`) — redundant with the trigger but safe.
5. Redirect to dashboard.

### Flow 2 — Owner promotes a new member

1. Owner opens `roster.html`. Sees rows for every team_member, including any with role `Unassigned`.
2. Each row shows nickname + role pill + status badge.
3. Owner-only: nickname is inline-editable; role pill is a `<select>` with all 9 role values.
4. On role change, single-row update committed immediately; no save button.
5. Promoted player appears in the stats band on `vods.html` on next page load.

### Flow 3 — Owner adds a ghost player

1. `roster.html` shows a "+ Add ghost player" button (owner-only).
2. Inline form: `username` (required), `steam_id` (required, validated `/^7656119\d{10}$/`), `role` (default `Unassigned`).
3. Submit inserts a roster row with `is_ghost = true`, `user_id = null`, `team_id = current team`.
4. Row renders with a "Pending" badge.
5. When the matching user later joins the team, the trigger merges; the badge disappears.

### Flow 4 — Owner removes someone

1. Owner clicks "Remove" on a real row → deletes the `team_members` record. Trigger drops the matching `roster` row.
2. Owner clicks "Remove" on a ghost row → deletes the `roster` row directly.
3. Confirmation dialog before either path.

### Flow 5 — Stats consumption (unchanged)

`vods.js` calls the existing roster loader, feeds rows to `roster-stats.js`. The only stats-side change: `STAFF_ROLES` set expands to `{Coach, Manager, Bench, Unassigned}`. Per-player drawer keys off `steam_id`, which is now always present.

## Permissions

| Action | Owner | Member | Non-member |
|---|---|---|---|
| Read team's roster | yes | yes | no (RLS) |
| Edit own nickname | yes (via owner edit) | no (this design) | no |
| Edit any role | yes | no | no |
| Add ghost row | yes | no | no |
| Remove member or ghost | yes | no | no |

Note: members do not self-edit their nickname in this iteration. If that becomes a need, a follow-up spec can add a self-edit lane gated by `user_id = auth.uid()`. Out of scope here.

## Database Changes

Three SQL files run in order, all live under `cs2-hub/`:

### File 1 — `cs2-hub/supabase-multi-hub-setup.sql`

Already drafted in `docs/superpowers/plans/2026-04-20-cs2-hub-multi-hub.md` (Task 1). Run as-is. Creates `teams`, `team_members`, `profiles`. Adds `team_id` to `roster`, `vods`, `demos`, `demo_players`. Replaces broad `auth_all` RLS with team-scoped policies.

### File 2 — `cs2-hub/supabase-roster-auto-membership.sql` (new)

```sql
-- Expand role check
alter table roster drop constraint if exists roster_role_check;
alter table roster add constraint roster_role_check
  check (role in ('IGL','AWPer','Entry','Support','Lurker',
                  'Coach','Manager','Bench','Unassigned'));

-- Ghost flag
alter table roster add column is_ghost boolean not null default false;

-- Trigger: on team_members insert, create-or-merge roster row
create or replace function fn_team_member_roster_sync()
returns trigger as $$
declare
  v_steam_id text;
  v_username text;
  v_ghost_id uuid;
begin
  select user_metadata->>'steam_id', coalesce(user_metadata->>'name', email)
    into v_steam_id, v_username
    from auth.users where id = NEW.user_id;

  select id into v_ghost_id from roster
   where team_id = NEW.team_id and steam_id = v_steam_id and is_ghost = true
   limit 1;

  if v_ghost_id is not null then
    update roster
       set user_id = NEW.user_id, is_ghost = false,
           username = coalesce(username, v_username)
     where id = v_ghost_id;
  elsif not exists (
    select 1 from roster
     where team_id = NEW.team_id and user_id = NEW.user_id
  ) then
    insert into roster (team_id, user_id, username, steam_id, role, is_ghost)
    values (NEW.team_id, NEW.user_id, v_username, v_steam_id, 'Unassigned', false);
  end if;
  -- If a real roster row already exists for this (team, user), do nothing.
  -- This makes the trigger idempotent and safe during backfill.

  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_team_member_roster_sync
  after insert on team_members
  for each row execute function fn_team_member_roster_sync();

-- Trigger: on team_members delete, drop the matching real roster row (ghosts unaffected)
create or replace function fn_team_member_roster_cleanup()
returns trigger as $$
begin
  delete from roster
   where team_id = OLD.team_id and user_id = OLD.user_id and is_ghost = false;
  return OLD;
end;
$$ language plpgsql security definer;

create trigger trg_team_member_roster_cleanup
  after delete on team_members
  for each row execute function fn_team_member_roster_cleanup();

-- RLS: only team owner can write roster
drop policy if exists roster_update on roster;
create policy roster_update_owner on roster for update
  using (team_id in (select team_id from team_members
                      where user_id = auth.uid() and role = 'owner'))
  with check (team_id in (select team_id from team_members
                           where user_id = auth.uid() and role = 'owner'));

create policy roster_insert_owner on roster for insert
  with check (team_id in (select team_id from team_members
                           where user_id = auth.uid() and role = 'owner'));

create policy roster_delete_owner on roster for delete
  using (team_id in (select team_id from team_members
                      where user_id = auth.uid() and role = 'owner'));
```

### File 3 — `cs2-hub/supabase-roster-backfill.sql` (one-shot migration)

```sql
-- Create default team for the lone existing user
insert into teams (name, owner_id)
select 'My Team', user_id from roster
 where user_id is not null
 limit 1;

-- Attach all existing roster rows
update roster set team_id = (select id from teams where name = 'My Team')
 where team_id is null;

-- Backfill team_members for the owner
insert into team_members (team_id, user_id, role)
select id, owner_id, 'owner' from teams
on conflict (team_id, user_id) do nothing;

-- Mark rows without user_id as ghosts (so they don't break the unique invariant)
update roster set is_ghost = true where user_id is null;

-- Now safe to enforce team_id NOT NULL
alter table roster alter column team_id set not null;
```

### Rollback files

Each of File 2 and File 3 has a paired `*-rollback.sql` (drops triggers, drops new column, reverts RLS, undoes backfill where possible). Implementation plan defines them.

## JS Code Changes

### Files modified

- **`cs2-hub/team-select.js`** — auto-upsert at line ~84 expanded: also write `steam_id` from `session.user.user_metadata.steam_id`, set `role: 'Unassigned'`, `is_ghost: false`. `on conflict do nothing` makes it idempotent against the trigger.
- **`cs2-hub/roster.js`** — substantial rewrite:
  - Remove the "Add Player" modal entirely (delete modal HTML + handlers).
  - Replace with read-only list. Each row shows nickname + role pill + status badge (Member / Ghost / Pending).
  - Owner-only branch (gated by `auth.isTeamOwner(team_id)`): role pill becomes `<select>`; nickname becomes inline-editable input; "+ Add ghost player" button at top.
  - "Add ghost" inline form: `username`, `steam_id` (regex `/^7656119\d{10}$/`), `role` (default Unassigned). Direct insert with `is_ghost = true`.
  - "Remove" button per row: deletes `team_members` row (real) or `roster` row (ghost), with confirmation.
  - Drop the `?edit=<id>` deeplink handler — no longer needed.
- **`cs2-hub/roster.html`** — strip out `<dialog id="player-modal">` and its form. Add `<button id="add-ghost-btn">` and `<form id="ghost-form" hidden>`. Trim related CSS.
- **`cs2-hub/roster-stats.js`** — line 9: `STAFF_ROLES = new Set(['Coach', 'Manager', 'Bench', 'Unassigned'])`. Delete the `add-steam` no-Steam-ID variant (lines 43–50) — that branch is unreachable now.
- **`cs2-hub/auth.js`** — add and export helper `isTeamOwner(teamId)` that queries `team_members` for the current user's role.

### Files NOT touched

`vods.js`, `vods-filter.js`, `vods-team-stats.js`, `roster-stats-aggregate.js`, `roster-stats-render.js`, `player-drawer.js`. These consume `roster` rows by field; as long as `username, role, steam_id` remain present they keep working. The new `is_ghost` column is ignored.

## Testing

### Unit tests

- **`cs2-hub/roster.test.html`** (new browser test page) — `console.log('PASS:'/'FAIL:')` pattern, matches existing test infrastructure:
  - Steam64 regex accepts `76561198000000000`, rejects `12345`, `7656119999999999X`.
  - Owner-vs-member UI gating: when `isTeamOwner` returns `false`, no edit controls render; when `true`, role select and add-ghost button render.
  - Role dropdown contains exactly the 9 allowed values.
  - Ghost-row insert builds the correct payload (`is_ghost: true`, `user_id: null`).

### Database tests

- **`cs2-hub/supabase-roster-trigger.test.sql`** (new) — runs against a local Supabase instance via `psql -f`. Hand-rolled assertions using `do $$ begin assert ...; end $$;`:
  - Inserting `team_members` row creates a `roster` row with the auth user's `steam_id`.
  - Inserting `team_members` when a matching ghost exists merges (no duplicate, ghost flag cleared, `user_id` set).
  - Inserting `team_members` when a matching real roster row already exists is a no-op (no duplicate created — backfill safety).
  - Deleting `team_members` drops the matching real `roster` row.
  - Deleting `team_members` does NOT drop a ghost row that happens to share the team.

### E2E manual checklist (in spec, run before declaring done)

1. Steam-login as a fresh user → join team via code → `roster.html` shows row with role `Unassigned`, status `Member`.
2. Switch to owner account → promote that row to `IGL` → reload `vods.html` → new player appears in stats band.
3. Owner clicks "+ Add ghost player" → enters username + valid Steam64 + role `AWPer` → row appears with "Pending" badge.
4. Log in as a user matching that Steam ID → join the same team → ghost row's badge disappears, `user_id` is set, role still `AWPer`.
5. Owner removes a real member → both `team_members` and `roster` rows gone.
6. Owner removes a ghost row → `roster` row gone, no `team_members` impact.
7. As non-owner team member, attempt RLS violation: try to update another row's role via console → blocked by RLS.

## Rollout Order

1. Run File 1 (`supabase-multi-hub-setup.sql`) on Supabase.
2. Run File 2 (`supabase-roster-auto-membership.sql`).
3. Run File 3 (`supabase-roster-backfill.sql`).
4. Deploy JS changes (`team-select.js`, `roster.js`, `roster.html`, `roster-stats.js`, `auth.js`).
5. Run E2E manual checklist.
6. If anything fails, run rollback SQL in reverse order.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Trigger fails silently if `auth.user_metadata.steam_id` is missing | `coalesce` username from email; spec the steam-callback to guarantee `steam_id` is always set; trigger writes `null` rather than failing, so inserts succeed and admin can fix data |
| User joins team before Steam-login flow has populated metadata | Not possible — `team-select.html` is gated behind `requireAuth` which only resolves after Steam callback completes |
| Backfill assumes a single user; multi-user environments break | Verified by codebase exploration: only one user has roster rows. If that changes before run, revisit File 3. |
| RLS recursion (policies referencing `team_members` while `team_members` itself has RLS) | `team_members` policies use `auth.uid()` directly, no cross-table reference back to `roster`. No cycle. |
| Existing 16-task stats feature regresses | `roster-stats.js` contract unchanged: same input fields, same output. The added `is_ghost` column is ignored by all stats code. Verified by listing files-not-touched. |

## Open Questions

None outstanding for this iteration. Member self-edit of nickname and self-leave-team are explicitly deferred to a follow-up spec.
