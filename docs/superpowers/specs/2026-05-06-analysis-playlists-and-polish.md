# Analysis Page — Round Playlists & UX Polish

**Date:** 2026-05-06
**Scope:** cs2-hub `analysis.html` / `analysis.js`

## Goal

Make the analysis page a more complete tool by adding two features:

1. **Round playlists.** Team-shared, named playlists that store interesting rounds with optional notes. Users can save a round mid-analysis and revisit it later, individually or via auto-walking playback.
2. **UX polish.** Targeted improvements to fill gaps in the current page: collapsible filter rail, keyboard shortcuts, better loading/empty states, an onboarding hint.

## Out of scope

- Image/CSV/clip export.
- Heatmaps, position aggregation, opponent overlay, multi-player comparison.
- Per-user (private) playlists or per-playlist visibility toggles.
- Capturing viewer state on save (tick position, solo'd player, active utility filters). Saved rounds are bare references.
- Round bookmarks at sub-round granularity (specific moments / ticks).
- Mobile / responsive layout.
- Filter-preset saving / sharing.

## Data model

Two new Supabase tables, both team-keyed.

```sql
create table playlists (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references teams(id) on delete cascade,
  name        text not null,
  description text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create index on playlists (team_id, updated_at desc);

create table playlist_rounds (
  id          uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references playlists(id) on delete cascade,
  demo_id     uuid not null references demos(id) on delete cascade,
  round_idx   int  not null,
  note        text,
  position    int  not null,
  added_by    uuid references auth.users(id),
  added_at    timestamptz default now(),
  unique (playlist_id, demo_id, round_idx)
);

create index on playlist_rounds (playlist_id, position);
```

RLS policies follow the same pattern as `strats`/`events` (existing team-keyed tables in cs2-hub):

- `team_playlists_select` — members of `team_id` can read.
- `team_playlists_insert` — members of `team_id` can insert (auth.uid() must be in team).
- `team_playlists_update` — members of `team_id` can update.
- `team_playlists_delete` — members of `team_id` can delete.
- Same four policies on `playlist_rounds`, gated through `playlists.team_id`.

The `unique (playlist_id, demo_id, round_idx)` constraint prevents duplicates within a single playlist; the same round can still appear in multiple playlists. `on delete cascade` from `demos(id)` means a deleted demo automatically removes any playlist references to it. `position` is maintained client-side; reordering is a simple UPDATE.

## Layout

Adds a fourth column to the analysis body. New flex shape (left → right):

```
filter-rail (200px) | canvas (flex) | player-panel (220px) | playlist-rail (220px)
```

The playlist rail is **always visible** when a team is picked. In grenade mode, the player panel is replaced by the grenade panel (existing behavior); the playlist rail stays.

### Playlist rail contents

Two-state master/detail:

**Default (no playlist open):**

- Header row: `PLAYLISTS` label + `+` icon button (creates a new playlist via inline name input).
- Scrollable list of playlists, sorted by `updated_at desc`. Each row: name, count of rounds, most-recent activity date.

**Playlist open:**

- Back arrow + playlist name + ▶ "Play all" button + ⋯ menu (rename, delete).
- List of rounds in `position` order. Each row:
  - Small map thumbnail (use `images/maps/<map>.png`, same fallback pattern as dashboard/demos pages).
  - Round number + score (e.g. `R5 · 13–7`) + side indicator (CT/T color dot).
  - Note preview (1 line, ellipsis if longer).
  - Drag handle for reorder.
  - ✕ button to remove.
- Click a round row → loads single-round playback in canvas (same code path as clicking a player today).

### Visual style

Reuse existing tokens: `--glass-bg`, `--glass-border`, `--accent`, `--display-font`. Match the filter-rail and player-panel chrome. Active/selected rows get the accent left-border treatment used elsewhere in the page.

## Save flow

The ★ button is added to the player panel's round-nav header, next to `◀ Round N / M ▶`. It only appears during single-round playback (i.e. after the user clicks a player to dive into a round).

States:

- **Empty (round not in any playlist):** outlined ★.
- **Saved (round is in 1+ playlists):** filled ★.
- **Hover/click:** opens a popover anchored below.

### Popover (save mode)

When the round is not yet saved:

- Header: `Add to playlist`.
- Radio list of existing team playlists (most-recently-updated first). Each row shows name + round count.
- `+ New playlist` row at the bottom — clicking it inlines a text input. Enter creates the playlist and selects it.
- Optional note input below the picker (placeholder: "e.g. 'B-site rotation at 0:38'").
- `Save` button → inserts `playlist_rounds` row with `position = max(position) + 1` for that playlist. Closes popover, ★ becomes filled, toast confirmation.

### Popover (manage mode)

When the round is already in 1+ playlists:

- Header: `Saved in N playlist(s)`.
- List of those playlists. Each row has the saved note (editable inline) and a ✕ button to remove.
- `+ Add to another playlist` link → switches to save mode for additional playlists.

## Playback

Two flows from the playlist rail:

1. **Single round.** Click a round row → loads `match_data` for that demo if not cached, then enters the existing single-round playback path with `round_idx`. The canvas renders viewer-style frames; the timeline scrubber operates on that round.

2. **Play all.** ▶ button on the playlist header → enters playlist-playback mode. Reuses the existing grenade-playlist machinery in `analysis.js` (the code that auto-advances rounds when one ends). The player panel's round-nav becomes `◀ Playlist 2 / 7 ▶`. When the last round ends, playback stops (no loop in v1).

While in playlist-playback mode:

- The current round is highlighted in the rail.
- ◀ / ▶ buttons walk between playlist entries (not adjacent rounds).
- Clicking another playlist row mid-playback switches to that round and stays in playlist mode.
- Exiting (Esc, or returning to overlay/grenade pure mode) clears playlist-playback state.

## UX polish (scope of "F")

Four targeted improvements:

### 1. Collapsible filter rail

- Small chevron toggle at the top of the left rail.
- Collapsed state: 32px icon strip; each filter section becomes an icon (map, side, opponent, matches, buy). Click an icon → temporarily expands the rail until the user clicks away.
- State persists in `localStorage` per user.

### 2. Keyboard shortcuts

| Key | Action |
|-----|--------|
| Space | Play / pause |
| ← / → | Previous / next round (or playlist entry, if in playlist playback) |
| B | Save bookmark (opens save popover; only during single-round playback) |
| Esc | Exit single-round playback / clear solo'd player / close popover |
| ? | Toggle keyboard-shortcut help overlay |

Help overlay is a centered modal listing all shortcuts. Closes on any key.

### 3. Loading & empty states

- **Canvas:** while fetching `match_data_slim`, show a centered spinner and "Loading rounds…" caption (replaces or overlays the current `canvas-empty` "Pick a team to begin").
- **Filter result empty:** when filters yield 0 rounds, the canvas-empty message becomes "No rounds match these filters" with a `Reset` button.
- **Playlist rail:** while fetching playlists, show 3 skeleton rows. When empty, show "No playlists yet · click + to create one."

### 4. Onboarding hint

When a user opens analysis with no team selected for the first time, show a one-line hint near the team picker:

> "Pick a team, then click a player on the map to dive into a single round."

Dismissible via × button. Dismissal stored in `localStorage` keyed by user id.

## Implementation notes (non-binding)

- Schema: new SQL file `cs2-hub/supabase-playlists.sql` with the two tables + indexes + RLS. Mirror the structure of `supabase-demos.sql`.
- Client code: a new `playlists.js` module exporting:
  - `loadPlaylists(teamId)` → list of playlists.
  - `loadPlaylistRounds(playlistId)` → list with derived demo data joined client-side.
  - `addRoundToPlaylist(playlistId, demoId, roundIdx, note)`.
  - `removeRoundFromPlaylist(playlistRoundId)`.
  - `createPlaylist(teamId, name)`.
  - `renamePlaylist(playlistId, name)`.
  - `deletePlaylist(playlistId)`.
  - `reorderPlaylistRound(playlistRoundId, newPosition)`.
- UI changes split between `analysis.html` (markup for the new rail + popover container) and `analysis.js` (rendering, save flow, playback hooks).
- Polish items: keyboard handler installed once at page load. Filter-rail collapse uses a CSS class toggle + `localStorage`. Empty/loading states are template branches in existing render functions.
- Reuse `toast` for save confirmations.
- Save popover is a small inline element anchored to the ★ button — no new modal infrastructure needed.

## Risks & open considerations

- **Round identity drift.** A demo can be re-parsed (re-uploaded, retried). If `round_idx` semantics change between parses, saved rounds could point at the wrong round. Currently `round_idx` is stable per `match_data` payload, so this is mostly a non-issue, but re-parses should be considered when rolling out.
- **Demo deletion cascades** silently remove playlist entries. UI should surface "X rounds removed because demo was deleted" the next time the user opens that playlist (via a small toast on load if count dropped). Optional polish — flagged here, can punt to v2.
- **Concurrent edits.** Two team members editing the same playlist simultaneously is a low-risk scenario; last-write-wins on `note` and `position` is acceptable for v1.
- **No demo permission separation.** All team members have equal access. If permission tiers ever land, playlists inherit the demo's access scope automatically (RLS via team_id).

## Acceptance criteria

- ★ button visible on round-nav during single-round playback. Clicking it opens a popover with playlist picker. Saving inserts a row and visibly toggles ★ to filled.
- Playlist rail appears as a fourth column when a team is picked. Lists team playlists with round counts. Click a playlist → see its rounds. Click a round → canvas enters that round's single-round playback.
- "Play all" walks the playlist auto-advancing through rounds. ◀/▶ in player panel walks playlist entries.
- Filter rail can be collapsed to icons; state persists.
- Space/←/→/B/Esc/? shortcuts work as specified.
- Loading spinner during fetches; "no rounds match" message on empty filter results.
- Onboarding hint appears once for new users.
- Two SQL tables created with RLS. Cascade deletion verified — deleting a demo removes its playlist entries.
