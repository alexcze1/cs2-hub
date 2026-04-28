# Demo Viewer Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Overpass map, replace Nuke map image, add utility symbols to player cards, and add flash-blind animation on the map canvas.

**Architecture:** Parser changes add `has_smoke/flash/molotov/he` booleans and a `blinds` list to the parsed match JSON. Viewer reads these at render time — utility symbols in the HTML player cards, blind animation in the Canvas2D player draw loop. Map fixes are data-only (one line in `demo-map-data.js`) plus image assets.

**Tech Stack:** JavaScript (Canvas2D, DOM), Python (demoparser2), CSS

---

## File Map

| File | Change |
|------|--------|
| `cs2-hub/demo-map-data.js` | Add `de_overpass` entry to `MAP_DATA` |
| `cs2-hub/images/maps/de_overpass_viewer.png` | New asset — source from CS2 game files |
| `cs2-hub/images/maps/de_nuke_viewer.png` | Replace with higher-quality CS2 radar |
| `vps/demo_parser.py` | Add utility columns to `parse_ticks`; add `blinds` parsing; expose both in return dict |
| `cs2-hub/demo-viewer.html` | Add utility dot CSS |
| `cs2-hub/demo-viewer.js` | `playerCardHTML` utility dots; blind color interpolation in player draw loop |

---

## Task 1: Fix Overpass map coordinates

**Files:**
- Modify: `cs2-hub/demo-map-data.js:2-11`

- [ ] **Step 1: Add `de_overpass` to MAP_DATA**

In `cs2-hub/demo-map-data.js`, the `MAP_DATA` object currently ends at `de_train`. Add Overpass:

```js
export const MAP_DATA = {
  de_mirage:   { pos_x: -3230, pos_y:  1713, scale: 5.00 },
  de_inferno:  { pos_x: -2087, pos_y:  3870, scale: 4.90 },
  de_nuke:     { pos_x: -3453, pos_y:  2887, scale: 7.00 },
  de_ancient:  { pos_x: -2953, pos_y:  2164, scale: 5.00 },
  de_anubis:   { pos_x: -2796, pos_y:  3328, scale: 5.22 },
  de_dust2:    { pos_x: -2476, pos_y:  3239, scale: 4.40 },
  de_vertigo:  { pos_x: -3168, pos_y:  1762, scale: 4.00 },
  de_train:    { pos_x: -2477, pos_y:  2392, scale: 4.70 },
  de_overpass: { pos_x: -4831, pos_y:  1781, scale: 5.20 },
}
```

- [ ] **Step 2: Add Overpass map image**

Source `de_overpass_viewer.png` from CS2 game files (same as other viewer PNGs in `cs2-hub/images/maps/`). The game radar PNGs live at:
`Counter-Strike Global Offensive/game/csgo/panorama/images/overviews/de_overpass.png`

Copy and rename it to: `cs2-hub/images/maps/de_overpass_viewer.png`

The viewer code (`demo-viewer.js:82`) already does:
```js
mapImg.src = `images/maps/${mapName}_viewer.png`
```
So placing the file at that path is all that's needed.

- [ ] **Step 3: Verify**

Open a demo on Overpass in the viewer. Players should appear scattered across the map (not all at top-left), and the map background should load.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/demo-map-data.js cs2-hub/images/maps/de_overpass_viewer.png
git commit -m "fix: add de_overpass map data and viewer image"
```

---

## Task 2: Replace Nuke map image

**Files:**
- Replace: `cs2-hub/images/maps/de_nuke_viewer.png`

- [ ] **Step 1: Replace Nuke image**

Source the CS2 Nuke radar PNG from game files:
`Counter-Strike Global Offensive/game/csgo/panorama/images/overviews/de_nuke.png`

Overwrite `cs2-hub/images/maps/de_nuke_viewer.png` with this file.

- [ ] **Step 2: Verify**

Open a demo on Nuke. The map background should show full detail including upper/lower site areas.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/images/maps/de_nuke_viewer.png
git commit -m "fix: replace nuke viewer image with full-detail CS2 radar"
```

---

## Task 3: Parser — detect utility inventory columns

**Files:**
- Modify: `vps/demo_parser.py:406-409` (parse_ticks call)

This task discovers which column names demoparser2 exposes for grenade inventory, so Task 4 can use the right names.

- [ ] **Step 1: Add a column probe to parse_ticks**

In `vps/demo_parser.py`, find the `parse_ticks` call (around line 406). Add a one-time column probe before it:

```python
    # Probe available tick columns for grenade inventory
    try:
        _probe_df = p.parse_ticks(["smoke_grenade_count", "flash_grenade_count", "molotov_count", "he_grenade_count"], ticks=sampled[:1])
        _UTIL_MODE = "counts"
        print(f"[parser] utility mode: counts columns available")
    except Exception:
        try:
            _probe_df = p.parse_ticks(["inventory"], ticks=sampled[:1])
            _UTIL_MODE = "inventory"
            print(f"[parser] utility mode: inventory column available")
        except Exception:
            _UTIL_MODE = "none"
            print(f"[parser] utility mode: none — utility symbols disabled")
```

- [ ] **Step 2: Update parse_ticks to include utility columns**

Modify the existing `parse_ticks` call to conditionally include utility columns:

```python
    _util_cols = {
        "counts":    ["smoke_grenade_count", "flash_grenade_count", "molotov_count", "he_grenade_count"],
        "inventory": ["inventory"],
        "none":      [],
    }[_UTIL_MODE]

    tick_df = p.parse_ticks(
        ["X", "Y", "health", "is_alive", "team_num", "active_weapon_name", "balance", "armor_value", "yaw"] + _util_cols,
        ticks=sampled,
    )
```

- [ ] **Step 3: Add utility fields to per-player frame dict**

Find the frame-building loop (around line 419) where each player dict is constructed. Add utility fields after the existing fields:

```python
            # Utility inventory
            if _UTIL_MODE == "counts":
                player_dict = {
                    ...existing fields...,
                    "has_smoke":   _safe_int(r.get("smoke_grenade_count") or 0) > 0,
                    "has_flash":   _safe_int(r.get("flash_grenade_count") or 0) > 0,
                    "has_molotov": _safe_int(r.get("molotov_count") or 0) > 0,
                    "has_he":      _safe_int(r.get("he_grenade_count") or 0) > 0,
                }
            elif _UTIL_MODE == "inventory":
                import json as _json
                _inv = r.get("inventory") or []
                if isinstance(_inv, str):
                    try: _inv = _json.loads(_inv)
                    except Exception: _inv = []
                player_dict = {
                    ...existing fields...,
                    "has_smoke":   "weapon_smokegrenade" in _inv,
                    "has_flash":   "weapon_flashbang"    in _inv,
                    "has_molotov": any(w in _inv for w in ("weapon_molotov", "weapon_incgrenade")),
                    "has_he":      "weapon_hegrenade"    in _inv,
                }
            else:
                player_dict = {
                    ...existing fields...,
                    "has_smoke": False, "has_flash": False,
                    "has_molotov": False, "has_he": False,
                }
```

In practice, replace the existing `players.append({...})` block so it includes these fields. The full replacement of that block (lines ~420-433):

```python
            inv_raw = r.get("inventory") or []
            if isinstance(inv_raw, str):
                try:
                    import json as _json2; inv_raw = _json2.loads(inv_raw)
                except Exception: inv_raw = []

            if _UTIL_MODE == "counts":
                has_smoke   = _safe_int(r.get("smoke_grenade_count") or 0) > 0
                has_flash   = _safe_int(r.get("flash_grenade_count") or 0) > 0
                has_molotov = _safe_int(r.get("molotov_count") or 0) > 0
                has_he      = _safe_int(r.get("he_grenade_count") or 0) > 0
            elif _UTIL_MODE == "inventory":
                has_smoke   = "weapon_smokegrenade" in inv_raw
                has_flash   = "weapon_flashbang"    in inv_raw
                has_molotov = any(w in inv_raw for w in ("weapon_molotov", "weapon_incgrenade"))
                has_he      = "weapon_hegrenade"    in inv_raw
            else:
                has_smoke = has_flash = has_molotov = has_he = False

            players.append({
                "steam_id":   str(r.get("steamid") or ""),
                "name":       str(r.get("name") or ""),
                "team":       "ct" if team_num == 3 else "t",
                "x":          _safe_float(r.get("X")),
                "y":          _safe_float(r.get("Y")),
                "hp":         _safe_int(r.get("health")),
                "armor":      _safe_int(r.get("armor_value")),
                "weapon":     str(r.get("active_weapon_name") or ""),
                "money":      _safe_int(r.get("balance")),
                "is_alive":   bool(r.get("is_alive") or False),
                "yaw":        _safe_float(r.get("yaw")),
                "has_smoke":   has_smoke,
                "has_flash":   has_flash,
                "has_molotov": has_molotov,
                "has_he":      has_he,
            })
```

- [ ] **Step 4: Deploy and check logs**

```bash
# from PowerShell
scp C:\Users\A\Documents\claude\vps\demo_parser.py root@165.22.207.161:/opt/midround/vps/demo_parser.py
```

Then SSH in and re-upload a demo. Check service logs for the `[parser] utility mode:` line to confirm which mode was selected:

```bash
journalctl -u midround-demo-parser -f
```

- [ ] **Step 5: Commit**

```bash
git add vps/demo_parser.py
git commit -m "feat: add utility inventory columns to parsed player frames"
```

---

## Task 4: Parser — parse player_blind events

**Files:**
- Modify: `vps/demo_parser.py` (add blind parsing, add `blinds` to return dict)

- [ ] **Step 1: Parse player_blind events**

In `vps/demo_parser.py`, after the existing grenade parsing (around line 481, after `_build_grenade_paths`), add:

```python
    blinds = []
    try:
        blind_df = p.parse_event("player_blind")
        if blind_df is not None and len(blind_df) > 0:
            print(f"[parser] player_blind cols: {list(blind_df.columns)}")
        for r in _to_records(blind_df):
            tick     = _safe_int(r.get("tick"))
            duration = float(r.get("blind_duration") or r.get("blindDuration") or 0)
            sid      = str(r.get("user_steamid") or r.get("userid_steamid") or "")
            if tick == 0 or duration < 0.05 or not sid:
                continue
            blinds.append({
                "tick":     tick,
                "steam_id": sid,
                "duration": round(duration, 3),
            })
        print(f"[parser] blinds: {len(blinds)}")
    except Exception as e:
        print(f"[parser] player_blind error: {e}")
```

- [ ] **Step 2: Add `blinds` to return dict**

In the `return` dict at the end of `parse_demo` (line ~487), add `blinds`:

```python
    return {
        "meta":     { ... },  # unchanged
        "rounds":   rounds,
        "frames":   frames,
        "kills":    kills,
        "grenades": grenades,
        "bomb":     bomb,
        "shots":    shots,
        "blinds":   blinds,
    }
```

- [ ] **Step 3: Deploy and verify**

```bash
scp C:\Users\A\Documents\claude\vps\demo_parser.py root@165.22.207.161:/opt/midround/vps/demo_parser.py
```

SSH and re-upload a demo. Check logs for `[parser] blinds: N` — should be > 0 for any match with flashbangs. Check the parsed JSON in Supabase to confirm the `blinds` array is present on the match record.

- [ ] **Step 4: Commit**

```bash
git add vps/demo_parser.py
git commit -m "feat: parse player_blind events for flash animation"
```

---

## Task 5: Viewer — utility symbols on player cards

**Files:**
- Modify: `cs2-hub/demo-viewer.html` (add CSS)
- Modify: `cs2-hub/demo-viewer.js:858-880` (`playerCardHTML` function)

- [ ] **Step 1: Add utility CSS to demo-viewer.html**

In `cs2-hub/demo-viewer.html`, inside the `<style>` block, after the `.weapon-name` rule (around line 196), add:

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

- [ ] **Step 2: Update playerCardHTML to render utility dots**

In `cs2-hub/demo-viewer.js`, find `playerCardHTML` (line ~847). Replace the function with:

```js
function playerCardHTML(p) {
  if (!p.is_alive) {
    return `<div class="player-card dead">
      <div class="card-accent-bar"></div>
      <div class="card-body">
        <div class="card-top">
          <span class="player-name">${esc(p.name.slice(0, 13))}</span>
          <span class="dead-label">dead</span>
        </div>
      </div>
    </div>`
  }
  const hpPct    = Math.max(0, Math.min(100, p.hp))
  const weapon   = (p.weapon || '').replace('weapon_', '')
  const iconName = WEAPON_ICON_MAP[weapon] ?? weapon
  const wIconEl  = weapon
    ? `<img src="images/weapons/${esc(iconName)}.svg" class="weapon-icon" onerror="this.style.display='none'">`
    : ''
  const utilDots = [
    p.has_smoke   ? `<div class="util-dot smoke">S</div>`   : '',
    p.has_flash   ? `<div class="util-dot flash">F</div>`   : '',
    p.has_molotov ? `<div class="util-dot molotov">M</div>` : '',
    p.has_he      ? `<div class="util-dot he">H</div>`      : '',
  ].join('')
  return `<div class="player-card">
    <div class="card-accent-bar"></div>
    <div class="card-body">
      <div class="card-top">
        <span class="player-name">${esc(p.name.slice(0, 13))}</span>
        <span class="player-money">$${(p.money ?? 0).toLocaleString()}</span>
      </div>
      <div class="hp-row">
        <div class="hp-bar-wrap"><div class="hp-fill" style="width:${hpPct}%"></div></div>
        <span class="hp-val">${p.hp}</span>
      </div>
      <div class="card-bottom">
        ${wIconEl}<span class="weapon-name">${esc(weapon)}</span>
        <div class="util-spacer"></div>
        <div class="util-dots">${utilDots}</div>
      </div>
    </div>
  </div>`
}
```

- [ ] **Step 3: Verify**

Open a re-parsed demo. Player cards should show S/F/M/H dots in the bottom-right of each card for whatever grenades they currently hold. Dots disappear as grenades are thrown.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/demo-viewer.html cs2-hub/demo-viewer.js
git commit -m "feat: utility symbols (S/F/M/H) on player cards"
```

---

## Task 6: Viewer — flash-blind animation

**Files:**
- Modify: `cs2-hub/demo-viewer.js:604-678` (player draw loop in `render()`)

- [ ] **Step 1: Build blindUntil map before the player draw loop**

In `cs2-hub/demo-viewer.js`, in the `render()` function, find the line `for (const p of frame.players) {` (line ~604). Just before it, add:

```js
    // Build active blind map: steam_id → { until, totalTicks }
    const tickRate  = state.match.meta.tick_rate
    const blindUntil = {}
    for (const b of (state.match.blinds ?? [])) {
      const totalTicks = Math.round(b.duration * tickRate)
      const until      = b.tick + totalTicks
      if (state.tick >= b.tick && state.tick < until) {
        const existing = blindUntil[b.steam_id]
        if (!existing || existing.until < until) {
          blindUntil[b.steam_id] = { until, totalTicks }
        }
      }
    }
```

- [ ] **Step 2: Replace the player dot color with blind-aware interpolation**

Find this line in the player draw loop (line ~641):
```js
      const color = (Date.now() < (_flashUntil[id] ?? 0)) ? '#FF1744' : playerColor(p.team)
```

Replace it with:

```js
      const blindInfo = blindUntil[id]
      let color
      if (blindInfo && state.tick < blindInfo.until) {
        const remaining = (blindInfo.until - state.tick) / blindInfo.totalTicks
        const [tr, tg, tb] = p.team === 'ct' ? [79, 195, 247] : [255, 149, 0]
        const fr = Math.round(255 * remaining + tr * (1 - remaining))
        const fg = Math.round(255 * remaining + tg * (1 - remaining))
        const fb = Math.round(255 * remaining + tb * (1 - remaining))
        color = `rgb(${fr},${fg},${fb})`
      } else {
        color = (Date.now() < (_flashUntil[id] ?? 0)) ? '#FF1744' : playerColor(p.team)
      }
```

- [ ] **Step 3: Add team-color ring when blinded**

When a player is blinded, draw a thin team-color ring just outside the dot so it's still identifiable. Find the HP arc drawing block (line ~621) and add a blind ring after it:

```js
      // Blind ring — shows team colour when dot is white
      if (blindInfo && state.tick < blindInfo.until) {
        const ringR = dotR + 5
        ctx.save()
        ctx.beginPath()
        ctx.arc(x, y, ringR, 0, Math.PI * 2)
        ctx.strokeStyle = playerColor(p.team)
        ctx.lineWidth   = 1.5
        ctx.globalAlpha = 0.7
        ctx.stroke()
        ctx.restore()
      }
```

- [ ] **Step 4: Verify**

Open a re-parsed demo and scrub to a moment after a flashbang detonates. The blinded player's dot should turn white with a team-color ring, then fade back to team color over the blind duration. Other players should be unaffected.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: flash-blind animation — player dot fades white during blindness"
```

---

## Task 7: Deploy and final test

- [ ] **Step 1: Push all commits**

```bash
git push origin master
```

- [ ] **Step 2: Deploy demo_parser.py to VPS**

```powershell
# From local PowerShell
scp C:\Users\A\Documents\claude\vps\demo_parser.py root@165.22.207.161:/opt/midround/vps/demo_parser.py
```

- [ ] **Step 3: Restart parser service**

```bash
# SSH into VPS
systemctl restart midround-demo-parser
journalctl -u midround-demo-parser -n 30
```

- [ ] **Step 4: Re-upload a demo**

Re-upload a demo through the web UI to re-parse it with the new parser. Check logs confirm `utility mode:` and `blinds: N` lines appear.

- [ ] **Step 5: Smoke-test each feature**

- Overpass: open an Overpass demo — players should be in correct positions, map background visible
- Nuke: open a Nuke demo — map background should show full detail
- Utility: watch player cards during buy phase — S/F/M/H dots appear and disappear as grenades are thrown
- Blind: scrub to just after a flashbang — at least one player should show white dot + team ring fading back
