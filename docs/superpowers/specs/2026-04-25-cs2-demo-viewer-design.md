# CS2 2D Demo Viewer — Design Spec

**Date:** 2026-04-25  
**Project:** MIDROUND cs2-hub  
**Status:** Approved

---

## Overview

A 2D CS2 demo viewer integrated into MIDROUND. Teams upload `.dem` files, a VPS parses them in the background, and a Canvas-based viewer renders player positions, kills, grenades, and economy — styled as a broadcast overlay (stats-first layout).

---

## Architecture

Five components, each with one job:

| Component | Role |
|---|---|
| MIDROUND frontend | Upload UI, demo library, Canvas viewer |
| Supabase Storage | Raw `.dem` files, private per team |
| Supabase DB | Match metadata + parsed match JSON |
| VPS Parser (FastAPI + demoparser2) | Poll for pending demos, parse, write JSON back |
| Supabase Realtime | Push status updates to frontend (pending → ready) |

**Data flow:**
1. User uploads `.dem` → stored in Supabase Storage at `demos/{team_id}/{demo_id}.dem`
2. DB record created with `status = 'pending'`
3. VPS polls every 10s for pending demos → downloads `.dem` → parses → writes `match_data` JSONB → sets `status = 'ready'`
4. Frontend subscribes to Realtime; "Processing…" spinner flips to "▶ Watch" button
5. Viewer fetches `match_data` JSON and renders on Canvas

---

## VPS Parser Service

**Stack:** Python 3.11, FastAPI, demoparser2 (Rust-backed)

**Polling loop:** Every 10 seconds, queries Supabase for `status = 'pending'` demos. For each:
1. Set `status = 'processing'` immediately (prevents double-processing; crashed jobs reset to `pending` via a separate cleanup query for records stuck in `processing` for >10 minutes)
2. Download `.dem` from Supabase Storage
3. Parse with demoparser2 — extract:
   - Match metadata: map, played_at, tick_rate, final score, team names
   - Rounds: `[{ round_num, start_tick, end_tick, winner_side, win_reason }]`
   - Player frames (sampled every 8 ticks): `[{ tick, players: [{ steam_id, name, x, y, hp, armor, weapon, money, is_alive }] }]`
   - Kill events: `[{ tick, killer_id, victim_id, weapon, headshot, killer_x, killer_y, victim_x, victim_y }]`
   - Grenade events: `[{ tick, type, thrower_id, trajectory: [{x,y}] }]`
   - Economy per round-start: `[{ round_num, players: [{ steam_id, money, equipment_value }] }]`
4. Write JSON blob to `demos.match_data` (JSONB); populate `map`, `played_at`, `score_ct`, `score_t`, `duration_ticks`, `tick_rate`, `opponent_name` from parsed metadata
5. Set `status = 'ready'`

**Error handling:** Failed parses set `status = 'error'` with `error_message`. Frontend shows "Processing failed" with a retry button that resets status to `pending`.

**Tick sampling:** Every 8 ticks (~8–16 fps depending on tick rate). Keeps JSON under 5MB per match while maintaining fluid playback. Kill and grenade events stored at full tick resolution.

---

## Database Schema

### `demos`
```sql
-- set at upload time
id            uuid primary key
team_id       uuid references teams(id)
uploaded_by   uuid references members(id)
created_at    timestamptz
status        text  -- 'pending' | 'processing' | 'ready' | 'error'
error_message text  -- nullable
storage_path  text  -- '{team_id}/{demo_id}.dem'

-- populated by VPS after parsing
map           text  -- 'de_mirage', 'de_inferno', etc.
played_at     timestamptz
score_ct      int
score_t       int
opponent_name text
duration_ticks int
tick_rate     int   -- 64 or 128
match_data    jsonb -- full parsed blob
```

### `demo_players`
```sql
id         uuid primary key
demo_id    uuid references demos(id)
steam_id   text
name       text
side       text  -- 'ct' | 't'
kills      int
deaths     int
assists    int
adr        float
rating     float
```

**Row-level security:** All demo tables gated to `team_id` matching the authenticated user's team — same RLS pattern as the rest of MIDROUND.

---

## Frontend Pages

### `demos.html` — Demo Library
- Page header: "Demos" title + "X matches uploaded" subtitle + **+ Upload Demo** button
- Upload flow: file picker (`.dem` only), uploads to Supabase Storage, creates DB record, shows progress
- Demo list: one row per demo — map thumbnail, opponent name, date, score, duration, status badge, Watch button
- Status badges: `Processing` (amber), `Ready` (green), `Error` (red + retry)
- Realtime subscription updates status badges live without page refresh

### `demo-viewer.html` — 2D Viewer
**Layout C — stats-first broadcast style:**

```
[ Player1 card ] [ Player2 card ] [ 16 vs 13 ] [ Enemy1 card ] [ Enemy2 card ]
[                   2D Map Canvas                    ] [ Round tracker ]
[                                                    ] [ Kill feed     ]
[ ◀  ────────────●──────────────────  ▶   1×  2×   ]
```

**Player cards (top row):** Name, K/D, rating, current weapon, money, HP bar (color-coded CT blue / T red)

**2D Map Canvas:**
- Map radar PNG as background, scaled to known coordinate bounds
- Player dots: numbered circles (CT blue / T red), direction indicator
- Kill markers: ✕ at victim position, fades after 3 seconds
- Grenade trajectories: dotted path line + burst circle on detonation (smoke = grey, flash = white, molotov = orange)
- Dead players: greyed out dot

**Right panel:**
- Round tracker: colored squares (CT blue / T red) for each round result
- Kill feed: last 5 kills with killer → victim + weapon

**Timeline scrubber:**
- Seek bar spanning full match (or current round)
- Playback speed: 1×, 2×, 4×
- Round selector: click any round square to jump to that round

---

## Map Assets

The 8 active map radar images (de_mirage, de_inferno, de_nuke, de_ancient, de_anubis, de_dust2, de_vertigo, de_train) stored as static PNGs in `cs2-hub/images/maps/`. Coordinate bounds (world-to-canvas mapping) hardcoded per map using published community values.

---

## Future: Pro Demo Scraping

When implemented, pro demos will populate the same `demos` table with `team_id = null` and a `is_pro = true` flag. The demo library will gain a "Pro Demos" tab. The VPS parser pipeline is unchanged — pro demos go through the same flow. No schema changes required.

---

## Out of Scope (v1)

- Spectator camera / free-look 3D view
- Voice chat sync
- Drawing tools / annotation on the map
- Sharing demos with other teams
- Demo comparison (two demos side by side)
