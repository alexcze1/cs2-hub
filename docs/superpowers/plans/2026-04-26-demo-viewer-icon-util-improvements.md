# Demo Viewer Icon & Utility Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HP arc, damage flash, weapon icons, and HE animation to the map canvas; fix trajectory origin matching and money field in the parser.

**Architecture:** All canvas changes are confined to `cs2-hub/demo-viewer.js`. Parser changes are in `vps/demo_parser.py`. Viewer changes are live on Vercel deploy; parser changes require re-uploading demos to take effect.

**Tech Stack:** Vanilla JS / Canvas2D (viewer), Python / demoparser2 (parser), Supabase, Vercel

---

## File Structure

| File | What changes |
|---|---|
| `cs2-hub/demo-viewer.js` | HP arc, damage flash state + render, weapon icon preload + render, HE animation, smaller name pill |
| `vps/demo_parser.py` | `account_balance` money field, steam_id on grenade events, consume-and-match trajectory origin |

---

### Task 1: Parser — money field + steam_id on grenade events

**Files:**
- Modify: `vps/demo_parser.py`

- [ ] **Step 1: Fix money field name in `parse_ticks`**

In `parse_demo`, find the `parse_ticks` call at line ~319. Change `"cash"` → `"account_balance"`:

```python
tick_df = p.parse_ticks(
    ["X", "Y", "health", "is_alive", "team_num", "active_weapon_name", "account_balance", "armor_value", "yaw"],
    ticks=sampled,
)
```

And in the player dict construction (~line 342):
```python
"money":    _safe_int(r.get("account_balance")),
```

- [ ] **Step 2: Add `steam_id` to smoke grenade events**

In `_parse_grenades`, inside the smoke try-block, change the `grenades.append(...)` call:

```python
grenades.append({
    "tick":     tick,
    "type":     "smoke",
    "x":        x,
    "y":        y,
    "end_tick": tick + 2816,
    "steam_id": str(r.get("user_steamid") or ""),
})
```

- [ ] **Step 3: Add `steam_id` to molotov events**

Inside the molotov try-block, change `grenades.append(...)`:

```python
grenades.append({
    "tick":     tick,
    "type":     "molotov",
    "x":        x,
    "y":        y,
    "end_tick": tick + 896,
    "steam_id": str(r.get("user_steamid") or ""),
})
```

- [ ] **Step 4: Add `steam_id` to flash events**

Inside the flash try-block:

```python
grenades.append({
    "tick":     tick,
    "type":     "flash",
    "x":        x,
    "y":        y,
    "end_tick": tick + 64,
    "steam_id": str(r.get("user_steamid") or ""),
})
```

- [ ] **Step 5: Add `steam_id` to HE events**

Inside the HE try-block:

```python
grenades.append({
    "tick":     tick,
    "type":     "he",
    "x":        x,
    "y":        y,
    "end_tick": tick + 32,
    "steam_id": str(r.get("user_steamid") or ""),
})
```

- [ ] **Step 6: Commit**

```bash
git add vps/demo_parser.py
git commit -m "fix: account_balance money field + steam_id on grenade events"
```

---

### Task 2: Parser — trajectory consume-and-match

**Files:**
- Modify: `vps/demo_parser.py` — `_add_throw_origins` function

Current code (lines ~116–144) takes `candidates[-1]` for every grenade, so multiple grenades of the same type all get the same origin. The fix: store `steam_id` in throw records, then match by steam_id and consume each throw once.

- [ ] **Step 1: Store `steam_id` in throw records**

Inside `_add_throw_origins`, replace:

```python
throws_by_type.setdefault(gtype, []).append({"tick": tick, "x": x, "y": y})
```

with:

```python
throws_by_type.setdefault(gtype, []).append({
    "tick": tick, "x": x, "y": y, "steam_id": steam_id
})
```

- [ ] **Step 2: Replace the matching loop with consume-and-match**

Replace the entire block starting at `for g in grenades:` (lines ~138–144) with:

```python
sorted_grenades = sorted(grenades, key=lambda g: g["tick"])
consumed: set = set()

for g in sorted_grenades:
    candidates = throws_by_type.get(g["type"], [])
    g_sid = g.get("steam_id", "")

    # Prefer same-player throw (most recent unconsumed before detonation)
    best = None
    best_idx = None
    for i, t in enumerate(candidates):
        if i in consumed or t["tick"] >= g["tick"]:
            continue
        if g_sid and t.get("steam_id") != g_sid:
            continue
        if best is None or t["tick"] > best["tick"]:
            best = t
            best_idx = i

    # Fallback: any most-recent unconsumed throw of same type
    if best is None:
        for i, t in enumerate(candidates):
            if i in consumed or t["tick"] >= g["tick"]:
                continue
            if best is None or t["tick"] > best["tick"]:
                best = t
                best_idx = i

    if best is not None:
        consumed.add(best_idx)
        g["origin_x"]    = best["x"]
        g["origin_y"]    = best["y"]
        g["origin_tick"] = best["tick"]
```

- [ ] **Step 3: Commit**

```bash
git add vps/demo_parser.py
git commit -m "fix: trajectory origin consume-and-match by steam_id"
```

---

### Task 3: Viewer — HP arc

**Files:**
- Modify: `cs2-hub/demo-viewer.js`

- [ ] **Step 1: Add `hpToColor` helper after `playerColor`**

Find the line `function playerColor(team) { ... }` (~line 330). Add immediately after:

```javascript
function hpToColor(hp) {
  if (hp > 50) {
    const t = (hp - 50) / 50
    return `rgb(${Math.round(76 + (255 - 76) * (1 - t))},${Math.round(175 + (215 - 175) * (1 - t))},${Math.round(80 * t)})`
  }
  if (hp > 25) {
    const t = (hp - 25) / 25
    return `rgb(255,${Math.round(215 * t)},0)`
  }
  return '#F44336'
}
```

- [ ] **Step 2: Shrink name pill font**

In `render()`, change:

```javascript
const pillFontSz = Math.round(cw * 0.016)
```

to:

```javascript
const pillFontSz = Math.round(cw * 0.011)
```

- [ ] **Step 3: Draw HP arc before each player circle**

In the player icon loop in `render()`, find the dead-player block and the `const color = playerColor(p.team)` line. Insert the HP arc draw between the dead-player `continue` and the `const color` line:

```javascript
    // HP arc — drawn before the circle so it sits behind
    if (p.hp != null && p.hp > 0) {
      const arcR = dotR + 3
      ctx.save()
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(x, y, arcR, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(x, y, arcR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, p.hp / 100)))
      ctx.strokeStyle = hpToColor(p.hp)
      ctx.stroke()
      ctx.restore()
    }

    const color = playerColor(p.team)
```

- [ ] **Step 4: Open viewer in browser — confirm HP arcs visible on all alive players, green at high HP, yellow/red at low**

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: HP arc + smaller name pill on player icons"
```

---

### Task 4: Viewer — Damage flash

**Files:**
- Modify: `cs2-hub/demo-viewer.js`

- [ ] **Step 1: Add `_prevHp` and `_flashUntil` state near top**

After the line `let _lastKillTick  = -1`, add:

```javascript
const _prevHp     = {}  // steam_id → last rendered hp
const _flashUntil = {}  // steam_id → Date.now() ms when flash expires
```

- [ ] **Step 2: Detect HP drops and set flash in the player loop**

In the player icon loop, find `const color = playerColor(p.team)`. Replace it with:

```javascript
    const id = p.steam_id
    if (state.playing && _prevHp[id] != null && p.hp < _prevHp[id]) {
      _flashUntil[id] = Date.now() + 350
    }
    _prevHp[id] = p.hp
    const color = (Date.now() < (_flashUntil[id] ?? 0)) ? '#FF1744' : playerColor(p.team)
```

- [ ] **Step 3: Reset flash maps in `jumpToRound`**

Find `jumpToRound`. After `_lastKillTick = -1`, add:

```javascript
  Object.keys(_prevHp).forEach(k => delete _prevHp[k])
  Object.keys(_flashUntil).forEach(k => delete _flashUntil[k])
```

- [ ] **Step 4: Open viewer — play a round and watch a player get shot. Their icon should briefly flash red.**

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: damage flash on player icon when HP drops"
```

---

### Task 5: Viewer — Weapon canvas icons

**Files:**
- Modify: `cs2-hub/demo-viewer.js`

- [ ] **Step 1: Preload weapon SVGs as canvas Image objects**

Find the GRENADE_ICONS block (~line 332):

```javascript
const GRENADE_ICONS = {}
;['smoke:smokegrenade', ...].forEach(...)
```

Immediately after it, add:

```javascript
const WEAPON_CANVAS_ICONS = {}
new Set(Object.values(WEAPON_ICON_MAP)).forEach(name => {
  const img = new Image()
  img.src = `images/weapons/${name}.svg`
  WEAPON_CANVAS_ICONS[name] = img
})
```

- [ ] **Step 2: Draw weapon icon above name pill in the pill pass**

Find the name pill pass in `render()`:

```javascript
  for (const p of frame.players) {
    if (!p.is_alive) continue
    const { x, y } = worldToCanvas(p.x, p.y, mapName, cw, ch)
    drawPlayerPill(x, y - dotR, p.name.slice(0, 13), playerColor(p.team), pillFont, pillFontSz)
  }
```

Replace with:

```javascript
  for (const p of frame.players) {
    if (!p.is_alive) continue
    const { x, y } = worldToCanvas(p.x, p.y, mapName, cw, ch)
    drawPlayerPill(x, y - dotR, p.name.slice(0, 13), playerColor(p.team), pillFont, pillFontSz)

    // Weapon icon above the pill
    const rawWeapon = (p.weapon || '').replace('weapon_', '')
    const iconName  = WEAPON_ICON_MAP[rawWeapon] ?? rawWeapon
    const wIcon     = WEAPON_CANVAS_ICONS[iconName]
    if (wIcon && wIcon.complete && wIcon.naturalWidth) {
      const sz  = Math.round(cw * 0.018)
      const ph  = pillFontSz + 5
      const py  = (y - dotR) - ph - 2   // top-left y of the pill (matches drawPlayerPill)
      ctx.save()
      ctx.drawImage(wIcon, x - sz / 2, py - sz - 2, sz, sz)
      ctx.restore()
    }
  }
```

- [ ] **Step 3: Open viewer — confirm weapon icons appear above name pills for all alive players. Knives, rifles, grenades should all show icons.**

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: weapon SVG icon drawn on map above player name pill"
```

---

### Task 6: Viewer — HE animation

**Files:**
- Modify: `cs2-hub/demo-viewer.js` — inside `renderGrenades`, the `g.type === 'he'` block

- [ ] **Step 1: Replace static HE ring with expanding shockwave**

Find the current HE block inside `renderGrenades`:

```javascript
    } else if (g.type === 'he') {
      ctx.beginPath()
      const r = cw * 0.025
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,220,0,0.7)'
      ctx.lineWidth   = 2
      ctx.stroke()
    }
```

Replace with:

```javascript
    } else if (g.type === 'he') {
      const progress = totalS > 0 ? Math.min(1, elapsedS / totalS) : 1
      ctx.save()
      // Outer ring — expands and fades
      ctx.beginPath()
      ctx.arc(x, y, cw * 0.01 + cw * 0.035 * progress, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,220,0,1)'
      ctx.lineWidth   = 2
      ctx.globalAlpha = 0.8 * (1 - progress)
      ctx.stroke()
      // Inner ring — faster fade, white
      ctx.beginPath()
      ctx.arc(x, y, cw * 0.01 + cw * 0.018 * progress, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,1)'
      ctx.lineWidth   = 1.5
      ctx.globalAlpha = 0.9 * (1 - progress)
      ctx.stroke()
      // Center flash — first 20% only
      if (progress < 0.2) {
        ctx.globalAlpha = 1 - progress / 0.2
        ctx.beginPath()
        ctx.arc(x, y, cw * 0.008 * (1 - progress / 0.2), 0, Math.PI * 2)
        ctx.fillStyle = '#fff'
        ctx.fill()
      }
      ctx.restore()
    }
```

- [ ] **Step 2: Open viewer — scrub to a round with an HE grenade. The explosion should show as two expanding rings and a brief white center flash that fade out over ~0.25s.**

- [ ] **Step 3: Commit and push**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: HE grenade expanding shockwave animation"
git push origin master
```

---

### Task 7: Deploy parser to VPS

- [ ] **Step 1: Push parser changes if not already pushed**

```bash
git push origin master
```

- [ ] **Step 2: Deploy to VPS**

Run on the VPS:

```bash
wget -O /opt/midround/vps/demo_parser.py https://raw.githubusercontent.com/alexcze1/cs2-hub/master/vps/demo_parser.py && systemctl restart midround-demo-parser
```

- [ ] **Step 3: Watch logs and re-upload a test demo**

```bash
journalctl -u midround-demo-parser -f
```

Expected: `[parser] grenades: <N>  bomb events: <M>` and `Done: <id> — <map> <score>`

- [ ] **Step 4: Verify in viewer on the newly processed demo**

Checklist:
- Money shows non-zero values on player cards
- Trajectory lines go to the correct thrower positions (not shared between players)
- HP arc visible on all alive players
- Damage flash fires when a player takes a hit
- Weapon icons visible above name pills
- HE grenades show expanding shockwave animation
