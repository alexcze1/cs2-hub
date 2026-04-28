# Demo Viewer Improvements — Design Spec

## Goal

Five targeted improvements to the CS2 demo viewer: fix Overpass map coordinates, replace the Nuke map image, add utility inventory symbols to player cards, and add a flash-blind animation on the map canvas.

---

## 1. Overpass Map Fix

**Problem:** `de_overpass` is missing from `MAP_DATA` in `demo-map-data.js`. `worldToCanvas()` returns `{x:0, y:0}` for every player/grenade position, placing them all at the top-left corner. No viewer image exists, so the canvas shows no background.

**Fix:**
- Add to `MAP_DATA`: `de_overpass: { pos_x: -4831, pos_y: 1781, scale: 5.2 }`
- Add `cs2-hub/images/maps/de_overpass_viewer.png` — source from CS2 radar assets (same process used for other maps)

**Files:** `cs2-hub/demo-map-data.js`, `cs2-hub/images/maps/de_overpass_viewer.png`

---

## 2. Nuke Map Image

**Problem:** `de_nuke_viewer.png` is low-res or missing details the user expects.

**Fix:** Replace `cs2-hub/images/maps/de_nuke_viewer.png` with the correct high-quality CS2 radar image. No code changes required.

**Files:** `cs2-hub/images/maps/de_nuke_viewer.png`

---

## 3. Utility Symbols on Player Cards

### Parser changes (`vps/demo_parser.py`)

Add four boolean fields per player per frame indicating current grenade inventory. Two-stage approach:

**Stage 1 — try demoparser2 tick columns:** Request `["smoke_grenade_count", "flash_grenade_count", "molotov_count", "he_grenade_count"]` (or equivalent names) alongside existing columns. Print available columns on first parse to confirm names. If available, map directly:

```python
"has_smoke":   _safe_int(r.get("smoke_grenade_count") or 0) > 0,
"has_flash":   _safe_int(r.get("flash_grenade_count") or 0) > 0,
"has_molotov": _safe_int(r.get("molotov_count") or 0) > 0,
"has_he":      _safe_int(r.get("he_grenade_count") or 0) > 0,
```

**Stage 2 — fallback via `inventory` column:** If count columns are unavailable, request `"inventory"` (demoparser2 emits a JSON list of weapon names per player). Parse it:

```python
inv = r.get("inventory") or []
if isinstance(inv, str): inv = json.loads(inv)
"has_smoke":   "weapon_smokegrenade" in inv,
"has_flash":   "weapon_flashbang"    in inv,
"has_molotov": any(w in inv for w in ("weapon_molotov","weapon_incgrenade")),
"has_he":      "weapon_hegrenade"    in inv,
```

The implementation task should print available tick columns on first run and pick the right approach.

### Viewer changes (`cs2-hub/demo-viewer.js` + `demo-viewer.html`)

In `playerCardHTML`, append utility dots to `card-bottom`, right-aligned:

```html
<div class="card-bottom">
  <span class="weapon-name">…</span>
  <div class="util-spacer"></div>
  <div class="util-dots">
    <!-- one per grenade type the player holds -->
    <div class="util-dot smoke">S</div>
    <div class="util-dot flash">F</div>
    <div class="util-dot molotov">M</div>
    <div class="util-dot he">H</div>
  </div>
</div>
```

Only render a dot if the player holds that grenade type. Dead players show no utility row.

**CSS** (in `demo-viewer.html` `<style>`):
```css
.util-spacer { flex: 1; }
.util-dots   { display: flex; gap: 3px; flex-shrink: 0; }
.util-dot {
  width: 13px; height: 13px; border-radius: 3px;
  display: flex; align-items: center; justify-content: center;
  font-size: 7.5px; font-weight: 800;
}
.util-dot.smoke   { background: rgba(180,180,180,0.15); color: #bbb; border: 1px solid rgba(180,180,180,0.2); }
.util-dot.flash   { background: rgba(255,255,180,0.12); color: #eed; border: 1px solid rgba(255,255,150,0.2); }
.util-dot.molotov { background: rgba(255,100,0,0.15);   color: #f94; border: 1px solid rgba(255,100,0,0.25); }
.util-dot.he      { background: rgba(100,210,100,0.13); color: #8d8; border: 1px solid rgba(100,210,100,0.22); }
```

**Files:** `vps/demo_parser.py`, `cs2-hub/demo-viewer.js`, `cs2-hub/demo-viewer.html`

---

## 4. Flash-Blind Animation

### Parser changes (`vps/demo_parser.py`)

Parse the `player_blind` event and store it as a separate list (alongside `kills`, `grenades`):

```python
blinds = []
for r in _to_records(p.parse_event("player_blind")):
    tick     = _safe_int(r.get("tick"))
    duration = float(r.get("blind_duration") or 0)
    sid      = str(r.get("user_steamid") or "")
    if tick == 0 or duration < 0.05:
        continue
    blinds.append({
        "tick":     tick,
        "steam_id": sid,
        "duration": round(duration, 3),  # seconds
    })
```

Include `blinds` in the returned match dict. In the viewer, compute `blind_until_tick = event.tick + event.duration * tick_rate` at runtime.

### Viewer changes (`cs2-hub/demo-viewer.js`)

Build a per-player blind lookup before drawing players each frame:

```js
// Build active blinds map: steam_id → blind_until_tick
const blinds = state.match.blinds ?? []
const blindUntil = {}
for (const b of blinds) {
  const until = b.tick + Math.round(b.duration * tickRate)
  if (tick >= b.tick && tick < until) {
    // take the longest active blind if multiple
    if ((blindUntil[b.steam_id] ?? 0) < until) {
      blindUntil[b.steam_id] = until
    }
  }
}
```

When drawing each player dot on the canvas, check `blindUntil[p.steam_id]`:
- If active: fill the dot white instead of team color, draw team-color ring around it
- Fade: `blindProgress = (blindUntil[id] - tick) / totalBlindTicks` — interpolate fill from white → team color as blindness wears off

```js
// blindUntil[steam_id] = { until: tick, totalTicks: duration * tickRate }
const blindInfo = blindUntil[p.steam_id]
if (blindInfo && tick < blindInfo.until) {
  const remaining = (blindInfo.until - tick) / blindInfo.totalTicks  // 0→1
  // interpolate fill: white (blinded) → team color (recovered)
  const [tr, tg, tb] = p.team === 'ct' ? [79,195,247] : [255,149,0]
  const fr = Math.round(255 * remaining + tr * (1 - remaining))
  const fg = Math.round(255 * remaining + tg * (1 - remaining))
  const fb = Math.round(255 * remaining + tb * (1 - remaining))
  dotColor = `rgb(${fr},${fg},${fb})`
  // draw team-color ring outside the dot when blinded
}
```

Store blind events with `totalTicks` at parse time: `totalTicks = Math.round(b.duration * tickRate)`. Build `blindUntil` by iterating `state.match.blinds` before the player draw loop each frame.

**Files:** `vps/demo_parser.py`, `cs2-hub/demo-viewer.js`

---

## Deployment Notes

- Items 1, 3, 4 require VPS redeploy of `demo_parser.py` and re-parsing demos
- Item 2 is a static asset only — no redeploy needed
- Overpass map image must be sourced and added to the repo
- After parser changes, existing cached demos won't have `has_smoke/flash/molotov/he` or `blinds` — re-upload to get updated data
