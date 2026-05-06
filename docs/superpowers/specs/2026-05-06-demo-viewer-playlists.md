# Demo Viewer — Round Playlists (Move from Analysis)

**Date:** 2026-05-06
**Scope:** cs2-hub `demo-viewer.html` / `demo-viewer.js` (new save flow), `demos.html` / `demos.js` (new view flow), `analysis.html` / `analysis.js` / `style.css` (revert)

## Goal

Move the round-playlists feature from the analysis page to the demo viewer. Users save interesting rounds while watching a demo; users browse/replay saved rounds from the demos list page.

## Out of scope

- Drag-to-reorder rounds within a playlist (v2 if missed).
- "Play all" auto-walking through a playlist (v2 if missed).
- Per-user / private playlists.
- Filter-preset saving on either page.
- Onboarding hint for the new playlist UI.

## Data model

Unchanged from the analysis-page version. The existing `playlists` and `playlist_rounds` tables in Supabase, with their RLS policies, stay as-is. `cs2-hub/supabase-playlists.sql` is already deployed and is not modified.

## What gets kept, moved, deleted

| File | Action |
|---|---|
| `cs2-hub/supabase-playlists.sql` | Kept |
| `cs2-hub/playlists.js` | Kept (data layer is surface-agnostic) |
| `cs2-hub/playlists.test.html` | Kept (still passes) |
| `cs2-hub/playlist-rail.js` | **Deleted.** Popover code extracted; rail UI not used in new design. |
| `cs2-hub/save-popover.js` | **Created.** Owns the save popover (save mode + manage mode). |
| `cs2-hub/demo-viewer.html`, `demo-viewer.js` | Modified — add ★ button, popover container, URL param parsing |
| `cs2-hub/demos.html`, `demos.js` | Modified — add Playlists section |
| `cs2-hub/analysis.html`, `analysis.js`, `style.css` | Reverted — playlist-related changes stripped |

## Save flow (demo viewer)

The ★ button lives in the demo viewer's round-nav header. It's always visible (the demo viewer is always inside a round). Position: next to the round number/score display.

States:
- **Empty** (round not in any playlist): outlined ☆.
- **Saved** (round is in 1+ playlists): filled ★.

On click, the same popover from the analysis-page version opens, anchored below the button.

### Popover modes

Identical behavior to the analysis-page version:

- **Save mode** (round not yet saved): header "Add to playlist", radio list of existing team playlists (most-recent first), `+ New playlist` link with inline name input, optional note input, Cancel/Save buttons.
- **Manage mode** (round already in 1+ playlists): header "Saved in N playlist(s)", per-playlist row with editable note + ✕ remove, `+ Add to another playlist` link, Close button.

Outside-click closes the popover. Save shows a toast and flips ☆ → ★. Removing the last membership flips ★ → ☆.

### Module structure

`cs2-hub/save-popover.js` exports:
- `openSavePopoverFor({ demoId, roundIdx, anchorRect, teamId, onChanged })` — opens the popover, queries memberships, renders save or manage mode.
- `closeSavePopover()` — hides the popover.
- `isPopoverOpen()` — boolean for outside-click filtering.

The `onChanged(demoId, roundIdx)` callback fires after save/remove so the host page can refresh the ★ state.

This module is decoupled from any specific page's state — it owns its own `popoverState`, the `#save-popover` DOM container, and the team's playlist list (loaded on first open per session, refreshed when stale).

## View flow (demos.html)

A new section on the demos list page, titled **Playlists**, sits above the existing demos table. Two-state master/detail rendered in-place (no modal):

### Master

- Header row: `PLAYLISTS` label + `+` icon button (creates new playlist via inline name input).
- Scrollable list of playlists for the current team, sorted by `updated_at desc`. Each row: name, round count, relative-date string (today / yesterday / Nd ago / Mar 5).
- Empty state: "No playlists yet · save a round from the demo viewer to create one."

### Detail

- Back arrow + playlist name + ⋯ menu (rename, delete).
- List of rounds in `position` order. Each row:
  - Small map thumbnail (`images/maps/<map>.png`).
  - Round number + score (e.g. `R5 · 13–7`) + side dot (CT/T color).
  - Note preview (1 line, ellipsis).
  - ✕ button to remove.
- Click a round row → navigate to `demo-viewer.html?demo=<demo_id>&round=<round_idx>`.

The section reuses the data-layer functions in `playlists.js` (`loadPlaylists`, `loadPlaylistRounds`, `createPlaylist`, `removeRoundFromPlaylist`, `renamePlaylist`, `deletePlaylist`).

### Visual style

Reuses existing tokens (`--glass-bg`, `--glass-border`, `--accent`, `--display-font`). The Playlists section blends with the existing demos page chrome.

## Demo viewer: open-at-round

The demo viewer currently parses `?demo=<id>` from the URL on boot. Extend to also parse `?round=<idx>`. After the match data loads, if `round` is present and valid, set `state.roundIdx` to it and seek playback to that round's freeze-end tick (the existing single-round entry path already does this — just call it with the parsed index).

If the URL has `?round=` but the match has no such round (out of range), fall back to round 0 and log a warning. No toast — invalid links silently land at round 0.

## Revert from analysis page

Strip every playlist-related addition:

- **`analysis.html`:** remove `<aside class="playlist-rail">`, the `<button id="pp-save-btn">`, and the `<div id="save-popover">` container. (Keep `#kb-help-overlay` and `#onboarding-hint` — those are general-purpose polish, not playlist-specific.)
- **`analysis.js`:** remove `import * as playlistRail`, the `playlistRail.mount(...)` call in `onTeamChanged`, the helper functions `refreshStarState` / `loadPlaylistRound` / `playPlaylistAll` / `ensureRoundLoaded`, the `pp-save-btn` click handler, the outside-click closer for the popover, the `setActiveRoundKey(null)` call in `exitSingleRound`, and the active-key update in `advancePlaylist`. Remove the `B` case from the keyboard switch (Space/←/→/Esc/? stay).
- **`analysis.js`:** revert `advancePlaylist()` to looping behavior — `state.gren.playlistPos = (state.gren.playlistPos + 1) % pl.length`. The stop-at-end was added solely for play-all; with that gone, grenade-mode playback returns to its original behavior.
- **`style.css`:** delete the `.playlist-rail`, `.pr-*`, `.save-popover*`, `.pp-save-btn` rule blocks. Keep `.canvas-empty-spinner`, `.canvas-empty-reset`, `.kb-help-*`, `.onboarding-hint`, and `.filter-rail-toggle` / `.filter-rail.collapsed` — those are general polish.

The keyboard shortcuts and collapsible filter rail land in the "kept" pile because they're useful independent of playlists. The onboarding hint copy ("Pick a team, then click a player on the map to dive into a single round") is unrelated to playlists and stays.

## Implementation notes (non-binding)

- The `save-popover.js` module needs the team id to query memberships and to filter the playlist list for the picker. The demo viewer reads team via `getTeamId()` from `./supabase.js` (same as analysis); pass it in via the `openSavePopoverFor` arguments rather than having the popover module fetch it itself.
- The popover's playlist list is owned by the popover module — load it lazily on first open and refresh after creating a new playlist. This avoids requiring a long-lived `setTeam` lifecycle.
- Map thumbnail path pattern: `images/maps/<map_lowercase_no_de_prefix>.png`. Mirror the helper from the analysis-page version.
- Score derivation in the round-row template uses the same `score_ct`/`score_t` columns.
- The demos page's existing structure has a header, a team picker (or assumed-current-team), and a demos table. The Playlists section slots between the team-picker area and the demos table — confirm placement during implementation.

## Risks & open considerations

- **Demo deletion cascades** silently remove playlist entries (RLS is unchanged). The view-side does not currently warn on missing-demo references; behavior is the same as in the analysis-page version.
- **Round identity drift on re-parse.** Same risk as before — `round_idx` is stable per `match_data` payload.
- **Concurrent edits.** Last-write-wins on note/position. Acceptable for v1.

## Acceptance criteria

- ★ button visible in the demo viewer round-nav whenever a round is loaded. Clicking it opens the popover. Saving inserts a row and visibly toggles ☆ → ★.
- A new "Playlists" section appears on `demos.html`, listing team playlists with round counts and last-activity dates.
- Clicking a playlist on `demos.html` shows its rounds with map thumb, R# + score, side dot, note, and ✕ remove.
- Clicking a round row navigates to the demo viewer at that exact round (URL: `demo-viewer.html?demo=…&round=…`).
- The analysis page no longer shows the playlist rail, the ★ button, or the save popover. Keyboard shortcuts (Space/←/→/Esc/?) still work; B does not. The collapsible filter rail and onboarding hint still work.
- `cs2-hub/playlists.test.html` still passes (13/13).
- `cs2-hub/playlist-rail.js` no longer exists in the repo.
