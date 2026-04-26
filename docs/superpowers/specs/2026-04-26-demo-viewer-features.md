# Demo Viewer Feature Additions — Design Spec
_2026-04-26_

## Goal

Add player cards, kill feed, death markers, grenade overlays, and bomb tracking to the CS2 demo viewer.

## Layout

Side-panel layout: CT player cards (160px) left of map canvas, T player cards (160px) right of map canvas. Kill feed floats over the bottom-right corner of the map canvas. The existing bottom bar (round tracker + timeline) is unchanged.

HTML structure change in `demo-viewer.html`:
```
.viewer-mid
  .player-panel.ct-panel       ← new, 160px wide
  .map-canvas-wrap              ← existing, flex:1
    #map-canvas
    .killfeed                   ← new, absolute bottom-right
  .player-panel.t-panel        ← new, 160px wide
```

---

## Player Cards

**Location:** `demo-viewer.js` — new `updatePlayerCards()` function, called from the render loop when the frame changes.

**Data source:** `frame.players` — already contains `name`, `hp`, `is_alive`, `team`, `weapon`, `money`.

**One card per player (5 per side):**
- Row 1: player name (left) + money in green (right)
- Row 2: HP bar, full width, colour `#4FC3F7` (CT) or `#EF5350` (T), bar width = `hp / 100 * 100%`
- Row 3: HP number (left) + weapon name (right)
- Dead players: card opacity 0.3, HP bar empty, show "Dead" instead of HP number

**Ordering:** Players sorted by `is_alive` desc (alive first), then by `hp` desc within alive group. Stable sort — doesn't jump around mid-round.

**Implementation note:** `updatePlayerCards()` compares current frame tick to previous tick; skips DOM update if same tick to avoid unnecessary reflows.

---

## Kill Feed

**Location:** Absolutely positioned div `.killfeed` inside `.map-canvas-wrap`, bottom-right corner.

```css
.killfeed {
  position: absolute;
  bottom: 12px;
  right: 12px;
  display: flex;
  flex-direction: column-reverse;
  gap: 3px;
  pointer-events: none;
  z-index: 10;
}
```

**Data source:** `state.match.kills` filtered to current round tick range.

**Each row:**
- Left border colour: `#4FC3F7` if killer is CT, `#EF5350` if killer is T
- Content: `killerName → victimName  weapon  [HS]`
- HS label: gold `#FFD700`, only shown if `headshot === true`
- Shows last 5 kills in current round, newest on top
- Kills older than 3rd entry fade to 40% opacity

**`updateKillFeed()`** called whenever `state.tick` crosses into a new round or on each frame tick change. Filters `state.match.kills` to `kill.tick >= round.start_tick && kill.tick <= state.tick`.

---

## Death Markers

**Location:** Drawn on the map canvas in `render()`, before player dots.

**Data source:** `state.match.kills` filtered to current round tick range (same as kill feed).

**Each marker:**
- Position: `worldToCanvas(kill.victim_x, kill.victim_y, mapName, cw, ch)`
- Draw an ✕ (two diagonal lines), size `dotR * 1.4`
- Colour: `#4FC3F7` if victim was CT, `#EF5350` if victim was T
- Only shown for kills where `kill.tick <= state.tick`

Victim team is determined by checking `frame.players` for the victim's `steam_id` at round start tick, falling back to checking killer team (opposite side).

---

## Grenade Overlays

### Parser additions (`demo_parser.py`)

Parse four grenade events and return them as a top-level `"grenades"` array:

| Event name | type value | end_tick source |
|---|---|---|
| `smokegrenade_detonate` | `"smoke"` | start_tick + 2304 (18s × 128) |
| `inferno_startburn` | `"molotov"` | matched `inferno_expire` by `entityid` |
| `flashbang_detonate` | `"flash"` | start_tick + 64 (0.5s × 128) |
| `hegrenade_detonate` | `"he"` | start_tick + 32 (0.25s × 128) |

Output shape per grenade:
```json
{ "tick": 1234, "type": "smoke", "x": 512.0, "y": -800.0, "end_tick": 3538 }
```

Position fields from events: `x` → `user_X` (or `x`), `y` → `user_Y` (or `y`) — check actual demoparser2 column names at parse time with a fallback.

Grenades with `x == 0 && y == 0` are skipped (parser artifact).

### Frontend rendering (`demo-viewer.js`)

New `renderGrenades(round, tick)` function called inside `render()` before player dots.

Render only grenades where `grenade.tick <= tick && grenade.end_tick >= tick` and `grenade.tick >= round.start_tick`.

| Type | Visual |
|---|---|
| `smoke` | Semi-transparent grey circle, radius = `cw * 0.055`, fill `rgba(180,180,180,0.35)`, stroke `rgba(200,200,200,0.5)` |
| `molotov` | Semi-transparent orange circle, radius = `cw * 0.04`, fill `rgba(255,100,0,0.3)`, stroke `rgba(255,140,0,0.6)` |
| `flash` | White circle that shrinks from `cw * 0.03` to 0 over duration, fill `rgba(255,255,255,0.5)` |
| `he` | Yellow ring (stroke only), radius = `cw * 0.025`, stroke `rgba(255,220,0,0.7)`, strokeWidth 2 |

---

## Bomb Tracking

### Parser additions (`demo_parser.py`)

Parse three bomb events and return them as a top-level `"bomb"` array:

| Event name | type value |
|---|---|
| `bomb_planted` | `"planted"` |
| `bomb_defused` | `"defused"` |
| `bomb_exploded` | `"exploded"` |

Output shape per event:
```json
{ "tick": 5000, "type": "planted", "x": 512.0, "y": -800.0 }
```

Position from event columns `x`/`y` or `user_X`/`user_Y` with fallback to 0.

### Frontend rendering

New `renderBomb(round, tick)` called in `render()` after grenades, before player dots.

Find the latest bomb event in `state.match.bomb` where `event.tick <= tick && event.tick >= round.start_tick`.

| State | Visual |
|---|---|
| `planted` | Pulsing red circle at bomb position. Radius oscillates `cw*0.018 ± cw*0.006` using `Math.sin(tick/8)`. Fill `rgba(255,50,50,0.7)`. Plus a countdown label: seconds remaining = `(plant_tick + 5120 - tick) / tickRate`, drawn above the dot in white. |
| `defused` | Solid green circle, radius `cw * 0.018`, fill `#4CAF50`. |
| `exploded` | Orange circle, radius `cw * 0.025`, fill `rgba(255,140,0,0.8)`. |

Bomb countdown uses 40 seconds (5120 ticks at 128Hz). If the round ends before 40s, the counter just disappears with the round.

---

## Files Changed

| File | Change |
|---|---|
| `vps/demo_parser.py` | Add grenade + bomb event parsing; new `grenades` and `bomb` keys in output |
| `cs2-hub/demo-viewer.html` | Add `.player-panel` divs, `.killfeed` div, panel CSS |
| `cs2-hub/demo-viewer.js` | Add `updatePlayerCards()`, `updateKillFeed()`, `renderGrenades()`, `renderBomb()`, death markers in `render()` |

No changes to `demo-map-data.js`, `demos.js`, `main.py`, or Supabase schema (new keys in `match_data` JSON are backwards-compatible).

---

## What Is NOT in This Spec

- Drawing tools (arrows, circles)
- Voice/audio sync
- Reaction time measurement
- Tactical board
- Dropped item visualization
- Pan/zoom on the map canvas
