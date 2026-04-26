# CS2 Demo Viewer Rewrite — Design Spec
_2026-04-26_

## Problem

The existing demo viewer never worked reliably. The Python parser had structural bugs (bad round pairing, fragile winner detection, polars compatibility wrappers) and the frontend accumulated debug scaffolding on top of untested data. Both sides need a clean slate.

## Scope

Essentials only — get players moving on the map correctly first:
- Players rendered as dots on the radar map
- Round navigation (clickable round squares)
- Play / pause + timeline scrub
- No player cards, kill feed, or grenade overlays in this iteration

## Architecture

Unchanged: Python parser on VPS → JSON stored in Supabase `demos.match_data` → frontend fetches and renders on canvas.

Output JSON shape is preserved (same as current):
```json
{
  "meta":    { "map", "tick_rate", "total_ticks", "ct_score", "t_score" },
  "rounds":  [{ "round_num", "start_tick", "end_tick", "winner_side", "win_reason" }],
  "frames":  [{ "tick", "players": [{ "steam_id", "name", "team", "x", "y", "hp", "is_alive" }] }],
  "kills":   [{ "tick", "killer_id", "killer_name", "victim_id", "victim_name", "weapon", "headshot", "victim_x", "victim_y" }]
}
```
`grenades` and `economy` fields are dropped from this iteration.

---

## Parser Rewrite (`vps/demo_parser.py`)

### Round pairing
Current bug: every `round_end` greedily picks "last `round_start` ≤ end_tick", causing multiple rounds to share the same start tick.

Fix: zip `round_start` events with `round_end` events in order — each start is consumed exactly once. If counts differ, trim to the shorter list.

### Warmup filtering
- Skip any round where `round_end.winner` is `0` or missing
- Skip any round with duration < 500 ticks (~4 s at 128 Hz)
- Skip rounds before index where both sides first have ≥ 5 players alive at start_tick

### Winner detection
Use `round_end.winner` directly: `2` → `"t"`, `3` → `"ct"`. No fallbacks — if the value is anything else, log a warning and skip the round rather than guess.

### Polars-native
Remove all `_to_records` / `_col_to_list` pandas-fallback wrappers. Use `df.to_dicts()` and `col.to_list()` directly. demoparser2 always returns polars DataFrames.

### Tick sampling
Keep `SAMPLE_RATE = 8`. Request these columns from `parse_ticks`:
```
X, Y, health, is_alive, team_num, active_weapon_name, cash
```
`name` and `steamid` are always included by demoparser2 automatically.

### Test script (`vps/test_parse.py`)
Standalone script: takes a `.dem` path as argv[1], runs `parse_demo()`, and prints:
- Number of rounds, first and last round tick ranges
- Frame 0 player count and their (x, y) coordinates
- Whether coordinates are plausible for the detected map (inside expected world-space bounds)

Run locally without the server to verify parse output before deploying.

---

## Viewer Rewrite (`cs2-hub/demo-viewer.js` + `demo-viewer.html`)

### Stripped features
Remove entirely: debug panel, player cards, kill feed, grenade blasts, economy data. These can be re-added in a follow-up.

### Canvas rendering
- Map radar image drawn full-canvas
- CT players: filled circle, `#4FC3F7`
- T players: filled circle, `#EF5350`
- Dead players: filled circle, `#888`, 30% opacity
- Dot radius: `canvas.width * 0.012`
- Player name label below dot (small, truncated at 10 chars)
- `worldToCanvas` formula and `MAP_DATA` values unchanged — they are correct

### Round tracker
- Row of small squares, CT=blue, T=red, unplayed=dim, current=outlined
- Click to jump to round

### Controls
- Play / pause button
- Timeline scrub bar (click or drag)
- Speed buttons: 1×, 2×, 4×

### Error states
- `demo.status !== 'ready'` → show status message
- `frames.length === 0` → "No frame data — try re-uploading"
- `frame[0].players.length === 0` → "Parser returned no players — check server logs"

### Frame lookup
Binary search on `frames` array by tick — unchanged, already correct.

---

## What is NOT in this spec

- Player cards (HP bar, weapon, money)
- Kill feed
- Grenade overlays
- Economy panel
- Bomb tracking
- Player name tooltips on hover

These are follow-up features, buildable once the core viewer is confirmed working.
