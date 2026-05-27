# Public-demo team linking, HLTV data refresh, demo-card layout — design

Date: 2026-05-27
Status: approved (executing inline per user spec)

## Goals (verbatim from user)

1. Public demos whose `team_a_name` / `team_b_name` matches a team page's name should auto-flow into that team's results page and aggregate stats. A new team page must pick up matching historical public demos with no manual sync step.
2. Public demo cards should display team logos using the same source as Team-tab cards.
3. An auto-updater (daily) keeps the HLTV team list (names + logos) and player profiles (names + pictures) current. Source of truth: HLTV ranking + team rosters.
4. Both Team and Pro demo cards have inconsistent name / score spacing — the score is not centred when team names differ in length. Fix the layout so the score column is always centred and the two team chips have equal-width slots.

## Non-goals

- Cross-team merging when team names differ in spelling (e.g. "Astralis" vs "ASTRALIS CS"). Exact, case-insensitive match only for v1.
- Granting team-page write access to public demos. Linked demos are read-only context — no edit buttons on cards that came from HLTV.
- Migrating existing static `hltv-teams.json` / `hltv-players.json` to the new DB tables. Tables seed from the daily scraper; static files remain as fallback for offline / unauthenticated edge cases.

## Feature 1 — auto-link public demos to team pages

### Data model

No schema change. Linking is purely a query-time concern.

A demo is "owned" by a team page when either:
- `demos.team_id = <team's uuid>` (the existing team-upload case), OR
- `demos.is_public = true` AND (`team_a_name` ILIKE `<team name>` OR `team_b_name` ILIKE `<team name>`)

### Query change

`vods.js::fetchDemosForVodWindow` currently filters `.eq('team_id', teamId)`. Replace with `.or(...)` covering both cases:

```js
.or(
  `team_id.eq.${teamId},` +
  `and(is_public.eq.true,or(team_a_name.ilike.${ourTeamName},team_b_name.ilike.${ourTeamName}))`
)
```

PostgREST `ilike` is case-insensitive. The `ourTeamName` is sanitized via `encodeURIComponent` and quoted to avoid breaking on apostrophes (e.g. team named `M'80` — unlikely but cheap to harden).

The downstream `demo_players` filter is `.in('steam_id', [...teamSteamIds])` — so public demos only contribute to player stats if the user's roster contains those exact steam_ids. For a scouting page that mirrors a real pro team's roster, this works naturally; for the user's own team it adds no noise because pros' steam_ids won't be in their roster.

### Realtime + new-team backfill

Because the query runs on every page load and includes all matching public demos by name, no explicit sync is needed when a new team page is created. The first vods.js load after team creation will include all historical public demos that match.

### RLS

Already permits this: authenticated users have read on demo_players / demo_team_stats both for their own team's demos AND for `demo_id IN (select id from demos where is_public=true)`. No policy change required.

## Feature 2 — team logos on public demo cards

`renderPublicSeriesCard` / `renderPublicSingleCard` currently render raw `<div class="dx-team-chip"><span class="dx-team-name">${name}</span></div>` without a logo.

Replace with the shared `teamChip(name, size)` helper that all Team cards already use. To do this:

1. Move `teamChip()` and the `state.logoMap` warm-up loop out of `runTeamScope` into module scope so `runPublicScope` can use them.
2. Before rendering Pro cards, do the same logoMap warm-up:
   ```js
   const names = new Set()
   for (const d of rows) { names.add(d.team_a_name); names.add(d.team_b_name) }
   await Promise.all([...names].filter(Boolean).map(async n => {
     state.logoMap[n] = await getTeamLogo(n)
   }))
   ```
3. Pro cards now call `teamChip(teamA)` / `teamChip(teamB)` like the Team cards.

Net effect: Pro cards show the same Vitality/NaVi/etc. logos that team-autocomplete uses.

## Feature 3 — daily HLTV team + player refresh

### Schema

Two new tables (idempotent migration in `cs2-hub/supabase-hltv-refresh-migration.sql`):

```sql
create table if not exists hltv_teams (
  id          int primary key,                    -- HLTV team id
  name        text not null,
  logo_url    text,
  rank        int,                                -- nullable (only top ~30 are ranked)
  updated_at  timestamptz not null default now()
);

create table if not exists hltv_players (
  id          int primary key,                    -- HLTV player id
  ign         text not null,
  full_name   text,
  team_id     int references hltv_teams(id) on delete set null,
  photo_url   text,
  country     text,
  updated_at  timestamptz not null default now()
);

create index if not exists hltv_teams_name_idx on hltv_teams (lower(name));
create index if not exists hltv_players_ign_idx on hltv_players (lower(ign));
create index if not exists hltv_players_team_idx on hltv_players (team_id);

-- Public read; writes via service role from VPS only.
alter table hltv_teams   enable row level security;
alter table hltv_players enable row level security;

create policy "hltv_teams_read"   on hltv_teams   for select to anon, authenticated using (true);
create policy "hltv_players_read" on hltv_players for select to anon, authenticated using (true);
```

### VPS scraper

`vps/hltv_rankings.py` exposes `scrape_rankings(top_n=30) -> tuple[list[TeamInfo], list[PlayerInfo]]`. Uses the same Playwright machinery as the demo scraper (CF stealth + headless Chromium). Scrapes `https://www.hltv.org/ranking/teams`, then walks each team's roster page for player ids/photos.

`vps/hltv_refresh_subprocess.py` is the entry point: discovers top 30 teams, upserts into `hltv_teams`, walks each roster, upserts into `hltv_players`. Output streams to journal like the ingest subprocess.

`vps/main.py` gets a second background loop, `_hltv_refresh_loop`, running every `HLTV_REFRESH_INTERVAL` (default 24 h) via the same `subprocess.Popen` pattern that worked for ingest.

### Frontend

`team-autocomplete.js::loadTeams` switches from `fetch('hltv-teams.json')` to a Supabase query:

```js
const r = await supabase.from('hltv_teams').select('id, name, logo_url').order('rank', { nullsFirst: false })
_teams = (r.data ?? []).map(t => ({ id: t.id, name: t.name, logo: t.logo_url }))
```

Fallback to the static JSON only if the Supabase query errors out (offline / not configured). The shape of the in-memory `_teams` array is preserved so all consumers (`getTeamLogo`, `attachTeamAutocomplete`) work unchanged.

Player autocomplete gets a similar treatment if/where used. (Out of scope for this change if no usage exists; verify.)

## Feature 4 — equalize team-name + score spacing

Current state: `.dx-card-versus` and `.dx-series-versus` use flex but the team chip widths are content-driven, so "Vitality" (8 chars) vs "Iowa Stormboar" (14 chars) shifts the score off-centre.

Fix: switch the row to CSS grid with three columns sized `minmax(0, 1fr) auto minmax(0, 1fr)`. The score sits in the middle column, always centred. The two team chips each get equal hug-the-centre flex behaviour — the left chip right-aligns its content, the right chip left-aligns. Names truncate with ellipsis on overflow.

Specifically:

```css
.dx-card-versus,
.dx-series-versus {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}
.dx-card-versus > .dx-team-chip:first-child,
.dx-series-versus > .dx-team-chip:first-child {
  justify-self: end;
}
.dx-card-versus > .dx-team-chip:last-child,
.dx-series-versus > .dx-team-chip:last-child {
  justify-self: start;
}
.dx-team-chip {
  min-width: 0;             /* allow text-overflow inside grid track */
}
.dx-team-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Visual effect: scores anchor the middle, team chips swim symmetrically out from the centre. Tested mentally with "Vitality vs M80" (short/short), "Iowa Stormboar vs Bushido Wildcats" (long/long), and "Astralis vs M" (mixed). All centre cleanly.

## Verification

- Feature 1: query DB for a team-name match (e.g. seed a team page named `M80`), reload the team's results page, confirm the HLTV M80 demo appears in the result list and contributes to team stats.
- Feature 2: open demos page → Pro tab → confirm team logos render where the autocomplete has them.
- Feature 3: run the refresh subprocess manually on the VPS, confirm `hltv_teams` populates ~30 rows and `hltv_players` populates ~150+ rows, then reload demos page and verify autocomplete still works (now from DB).
- Feature 4: visual inspection with multiple team-name length combos.
