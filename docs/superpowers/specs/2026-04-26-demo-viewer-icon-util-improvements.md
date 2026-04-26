# Demo Viewer — Icon & Utility Improvements Design Spec

**Date:** 2026-04-26
**Scope:** Canvas player icon redesign, HE animation, trajectory origin fix, money field fix

---

## 1. Player Icon Redesign

### 1a. HP Arc
- Drawn behind the player circle at radius `dotR + 3`
- Full 360° background track: `rgba(0,0,0,0.4)`, line width 2.5px
- Foreground arc: starts at −90° (top), clockwise, length proportional to `hp / 100`
- Color lerp: green (`#4CAF50`) → yellow (`#FFD700`) at 50 HP → red (`#F44336`) at 25 HP
- Not drawn for dead players

### 1b. Damage Flash
- `_prevHp` map (`steam_id → number`) tracks last-rendered HP per player
- `_flashUntil` map (`steam_id → timestamp ms`) tracks active flashes
- On each render pass (only when `state.playing`): if `currentHp < _prevHp[id]`, set `_flashUntil[id] = Date.now() + 350`
- While `Date.now() < _flashUntil[id]`: replace the circle fill color with `#FF1744` (bright red)
- Reset both maps when jumping rounds (`jumpToRound`)

### 1c. Smaller Name Pill
- Reduce `pillFontSz` from `cw * 0.016` → `cw * 0.011`

### 1d. Weapon Icon Above Name Pill
- At module init, preload all weapon SVGs into `WEAPON_CANVAS_ICONS` map:
  - Keys are all values in `WEAPON_ICON_MAP` (the SVG filenames without extension)
  - Each entry is a `new Image()` with `src = images/weapons/<name>.svg`
- In the name pill render pass, after drawing the pill, draw the icon:
  - Center: player x, top of pill − 2px
  - Size: `cw * 0.018 × cw * 0.018`
  - Resolve icon filename: `WEAPON_ICON_MAP[p.weapon.replace('weapon_', '')] ?? p.weapon.replace('weapon_', '')`
  - Only draw if `img.complete && img.naturalWidth > 0`
- Render order (bottom to top per player): HP arc → circle → direction notch → name pill → weapon icon

---

## 2. HE Grenade Animation

Replace the current static ring with an expanding shockwave animation across the `~0.25s` active window.

- `progress = elapsedS / totalS` (0 → 1)
- **Outer ring:** radius `cw * 0.01 + (cw * 0.035) * progress`, alpha `0.8 * (1 - progress)`, stroke color `rgba(255,220,0,1)`, line width 2px
- **Inner ring:** radius `cw * 0.01 + (cw * 0.018) * progress`, alpha `0.9 * (1 - progress)`, stroke color `rgba(255,255,255,1)`, line width 1.5px
- **Center flash:** when `progress < 0.2`, filled white circle at radius `cw * 0.008 * (1 - progress / 0.2)`
- No fill on either ring — stroke only

---

## 3. Trajectory Origin Fix (Parser)

**File:** `vps/demo_parser.py` — `_add_throw_origins`

### Changes:
1. **Store `steam_id` in throw records:**
   ```python
   throws_by_type.setdefault(gtype, []).append({
       "tick": tick, "x": x, "y": y, "steam_id": steam_id
   })
   ```

2. **Store `steam_id` on grenade events** — when parsing `smokegrenade_detonate`, `inferno_startburn`, `flashbang_detonate`, `hegrenade_detonate`, extract `user_steamid` and store as `"steam_id"` on the grenade dict.

3. **Consume-and-match algorithm:**
   - Sort grenades by `tick` (ascending)
   - Maintain `consumed = set()` of matched throw indices
   - For each grenade: find the most recent unconsumed throw from the same `steam_id` with `tick < g["tick"]`
   - If no steam_id match, fall back to most recent unconsumed throw of same type
   - Add matched index to `consumed`

---

## 4. Money Fix (Parser)

**File:** `vps/demo_parser.py`

`demoparser2` for CS2 uses `account_balance` not `cash` as the tick field name.

- In `parse_ticks(...)` field list: `"cash"` → `"account_balance"`
- In player dict construction: `r.get("cash")` → `r.get("account_balance")`

---

## Files Changed

| File | Changes |
|------|---------|
| `cs2-hub/demo-viewer.js` | HP arc, damage flash, smaller pill, weapon icon preload + render, HE animation |
| `vps/demo_parser.py` | Trajectory origin steam_id matching, `account_balance` money field |

## Deploy Notes
- Parser change requires re-uploading demos to get correct trajectories and money
- Viewer changes (HP arc, flash, icons, HE) work for existing demos immediately on Vercel deploy
