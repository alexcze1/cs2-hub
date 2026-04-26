# Demo Viewer Visual Overhaul — Design Spec
_2026-04-26_

## Goal

Upgrade the CS2 demo viewer with styled map backgrounds, weapon/grenade icons, improved utility visuals, smaller player icons, and a score display below the timer.

---

## Section 1: Map Background Build Script

**File:** `make_maps.mjs` (project root, Node.js ES module)

**Purpose:** Offline script — run once (or on demand) to produce dark-styled map background images from the raw CS2 radar PNGs already in `cs2-hub/images/`.

**Input:** `cs2-hub/images/de_*_radar.png` — 8 maps (ancient, anubis, dust2, inferno, mirage, nuke, overpass, vertigo).

**Processing (jimp):**
- Load each PNG.
- Pixel-classify into 3 tones based on luminance:
  - Passable floor (mid-grey): map to `#1e1e22` (dark surface)
  - Walls/out-of-bounds (dark): map to `#141417` (near-black)
  - Highlights/ledges (light): map to `#2e2e34` (raised surface)
- Luminance thresholds: `< 80` → wall, `80–200` → floor, `> 200` → highlight.
- Output to `cs2-hub/images/de_*_viewer.png` — same pixel dimensions, PNG.

**Frontend use:** In `demo-viewer.js`, `loadMap()` loads `images/${mapName}_viewer.png` instead of `_radar.png`. Falls back to `_radar.png` if `_viewer.png` fetch returns 404.

**Dependencies:** `jimp` (add to `package.json`). Script run with `node make_maps.mjs`.

---

## Section 2: Weapon & Grenade Icons

**Source:** `nicklvsa/csgo-weapon-icons` GitHub repo — SVG source files under `weapon_icons/`. Strip `weapon_` prefix to match `active_weapon_name` values from the parser (e.g. `weapon_ak47` → `ak47`).

**Build step:** Download/clone the repo; copy the PNG renders (512×512) into `cs2-hub/images/weapons/`. Name: `<weapon_name>.png` (e.g. `ak47.png`, `smokegrenade.png`).

**Player panel (HTML):** Each `.player-card` has a small weapon icon `<img>` in the bottom row. Size: `16×16px`, `object-fit: contain`. Path: `images/weapons/${player.weapon}.png`. If the weapon name is missing or the image 404s, hide the img (use `onerror="this.style.display='none'"`).

**Grenade trajectory icons (canvas):** `demo-viewer.js` preloads grenade type icons at init into a `GRENADE_ICONS` map `{ smoke, flash, he, molotov }` using `new Image()`. In `renderGrenades()`, for active grenades that have `origin_x`/`origin_y`, draw the icon (16×16, centred) at the midpoint between origin and detonation position, rotated to the throw direction. If preload fails, fall back to the existing plain-circle rendering.

Preload: attempt `images/weapons/smokegrenade.png`, `flashbang.png`, `hegrenade.png`, `molotov.png` — names match the repo PNG filenames.

---

## Section 3: Utility Visual Overhaul

All drawn in `renderGrenades(round, tick)` inside `render()`. Canvas width reference `cw` is the canvas element's width.

**Active window:** `grenade.tick <= tick && grenade.end_tick >= tick && grenade.tick >= round.start_tick`.

### Smoke
- Radius: `cw * 0.055`
- Fill: `rgba(180,180,180,0.35)` — Stroke: `rgba(200,200,200,0.5)` 1px
- Countdown timer: seconds remaining = `Math.ceil((grenade.end_tick - tick) / tickRate)`. Drawn centred in the circle, white, bold 10px, only when > 0.

### Molotov / Incendiary
- Radius: `cw * 0.04`
- Fill: `rgba(255,100,0,0.3)` — Stroke: `rgba(255,140,0,0.6)` 1.5px
- Countdown timer same as smoke, but orange `#FF9500`.

### Flash
- Radius shrinks linearly: `cw * 0.03 * (remaining / duration)` where `remaining = grenade.end_tick - tick`, `duration = grenade.end_tick - grenade.tick`.
- Fill: `rgba(255,255,255,0.5)` — no stroke.
- No countdown label.

### HE
- Stroke-only ring, radius `cw * 0.025`, stroke `rgba(255,220,0,0.7)` 2px.
- No fill, no label.

---

## Section 4: Player Icon Size

`dotR` computed as `cw * 0.013` (down from `cw * 0.018`). Teardrop tip extends `dotR * 0.45` beyond centre. Name pill font size scales: `Math.max(8, Math.round(dotR * 0.75))px`. This keeps 10 icons readable without crowding the map.

---

## Section 5: Score Display Below Timer

Drawn on canvas immediately below the round-timer pill. Same centre X. Gap: 4px below pill bottom.

Format: `5 — 8`
- CT score: `#4FC3F7`, bold 13px
- Separator ` — `: `rgba(255,255,255,0.4)`
- T score: `#FF9500`, bold 13px

Implementation: draw three `fillText` calls in sequence, measuring each segment width for tight inline layout. Score computed from `state.match.rounds.slice(0, state.roundIdx)` each frame.

---

## Files Changed

| File | Change |
|---|---|
| `make_maps.mjs` | New: jimp build script → `de_*_viewer.png` |
| `package.json` | Add `jimp` dependency |
| `cs2-hub/images/weapons/` | New dir: weapon/grenade icon PNGs |
| `cs2-hub/demo-viewer.js` | loadMap fallback, weapon icons in player cards, grenade icon preload + trajectory, utility visual overhaul, dotR resize, score display |

No changes to `demo-viewer.html`, `demo_parser.py`, `demo-map-data.js`, or Supabase schema.

---

## What Is NOT in This Spec

- Pan/zoom on map canvas
- Player health/armor audio cues
- Smoke pixel-accurate radius (uses fixed world-space approximation)
- Animated molotov spread shape
- Any drawing/annotation tools
