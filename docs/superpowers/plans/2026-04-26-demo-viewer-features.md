# Demo Viewer Feature Additions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add player cards, kill feed, death markers, grenade overlays, and bomb tracking to the CS2 2D demo viewer.

**Architecture:** Parser additions output `grenades` and `bomb` arrays into the existing `match_data` JSON (backwards-compatible — old demos simply get empty arrays on the frontend). Frontend adds side-panel player cards (CT left, T right), a floating kill feed, and canvas-drawn overlays for deaths/grenades/bomb.

**Tech Stack:** Python / demoparser2 (VPS parser), vanilla JS / Canvas2D (frontend), Supabase (JSON storage), Vercel (frontend hosting).

---

## File Structure

| File | What changes |
|---|---|
| `vps/demo_parser.py` | Add `_event_pos()`, `_parse_grenades()`, `_parse_bomb()` helpers; add `grenades` and `bomb` keys to `parse_demo()` return value |
| `cs2-hub/demo-viewer.html` | Add `.player-panel` divs, `.killfeed` div, all new CSS |
| `cs2-hub/demo-viewer.js` | Add `updatePlayerCards()`, `updateKillFeed()`, `renderDeathMarkers()`, `renderGrenades()`, `renderBomb()`; wire into loop and render |

---

### Task 1: Parser — grenade and bomb events

**Files:**
- Modify: `vps/demo_parser.py`

- [ ] **Step 1: Add `_event_pos` helper after `_safe_int`**

```python
def _event_pos(r) -> tuple:
    """Extract (x, y) from an event row, trying multiple column name variants."""
    x = _safe_float(r.get("x") or r.get("user_X") or r.get("X"))
    y = _safe_float(r.get("y") or r.get("user_Y") or r.get("Y"))
    return x, y
```

- [ ] **Step 2: Add `_parse_grenades` after `_event_pos`**

```python
def _parse_grenades(p) -> list:
    grenades = []

    # Smokes
    try:
        for r in _to_records(p.parse_event("smokegrenade_detonate")):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = int(r["tick"])
            grenades.append({"tick": tick, "type": "smoke", "x": x, "y": y, "end_tick": tick + 2304})
    except Exception:
        pass

    # Molotov / incendiary — match start→end by entityid
    try:
        end_by_id = {
            int(r.get("entityid", 0)): int(r["tick"])
            for r in _to_records(p.parse_event("inferno_expire"))
        }
        for r in _to_records(p.parse_event("inferno_startburn")):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = int(r["tick"])
            eid  = int(r.get("entityid", 0))
            grenades.append({
                "tick": tick, "type": "molotov", "x": x, "y": y,
                "end_tick": end_by_id.get(eid, tick + 896),
            })
    except Exception:
        pass

    # Flash
    try:
        for r in _to_records(p.parse_event("flashbang_detonate")):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = int(r["tick"])
            grenades.append({"tick": tick, "type": "flash", "x": x, "y": y, "end_tick": tick + 64})
    except Exception:
        pass

    # HE
    try:
        for r in _to_records(p.parse_event("hegrenade_detonate")):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = int(r["tick"])
            grenades.append({"tick": tick, "type": "he", "x": x, "y": y, "end_tick": tick + 32})
    except Exception:
        pass

    return grenades
```

- [ ] **Step 3: Add `_parse_bomb` after `_parse_grenades`**

```python
def _parse_bomb(p) -> list:
    bomb_events = []
    for event_name, event_type in [
        ("bomb_planted",  "planted"),
        ("bomb_defused",  "defused"),
        ("bomb_exploded", "exploded"),
    ]:
        try:
            for r in _to_records(p.parse_event(event_name)):
                x, y = _event_pos(r)
                bomb_events.append({"tick": int(r["tick"]), "type": event_type, "x": x, "y": y})
        except Exception:
            pass
    return bomb_events
```

- [ ] **Step 4: Call both helpers inside `parse_demo` and add to return value**

At the end of `parse_demo`, just before the `return` statement, add:

```python
    grenades = _parse_grenades(p)
    bomb     = _parse_bomb(p)
    print(f"[parser] grenades: {len(grenades)}  bomb events: {len(bomb)}")
```

Then update the return dict:

```python
    return {
        "meta": {
            "map":         header.get("map_name", ""),
            "tick_rate":   tick_rate,
            "total_ticks": _safe_int(header.get("playback_ticks")),
            "ct_score":    ct_score,
            "t_score":     t_score,
        },
        "rounds":   rounds,
        "frames":   frames,
        "kills":    kills,
        "grenades": grenades,
        "bomb":     bomb,
    }
```

- [ ] **Step 5: Verify locally with test_parse.py (if a .dem file is available)**

```bash
cd vps
python test_parse.py path/to/demo.dem
```

Expected: lines like `[parser] grenades: 42  bomb events: 3` and no Python exceptions.

- [ ] **Step 6: Commit**

```bash
git add vps/demo_parser.py
git commit -m "feat: parse grenade and bomb events into match_data"
```

---

### Task 2: HTML — side panel layout and CSS

**Files:**
- Modify: `cs2-hub/demo-viewer.html`

- [ ] **Step 1: Replace the `.viewer-mid` block**

Find this in `demo-viewer.html`:
```html
      <div class="viewer-mid">
        <div class="map-canvas-wrap" id="map-canvas-wrap">
          <canvas id="map-canvas"></canvas>
        </div>
      </div>
```

Replace with:
```html
      <div class="viewer-mid">
        <div class="player-panel ct-panel" id="ct-panel"></div>
        <div class="map-canvas-wrap" id="map-canvas-wrap">
          <canvas id="map-canvas"></canvas>
          <div class="killfeed" id="killfeed"></div>
        </div>
        <div class="player-panel t-panel" id="t-panel"></div>
      </div>
```

- [ ] **Step 2: Add new CSS inside the `<style>` block (append before `</style>`)**

```css
    /* Side panels */
    .viewer-mid {
      display: flex;
      gap: 8px;
    }
    .player-panel {
      width: 160px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
      overflow-y: auto;
      padding: 4px 0;
    }
    .player-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 9px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      transition: opacity 0.15s;
    }
    .player-card.dead { opacity: 0.3; }
    .player-card-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
    }
    .player-card-name {
      font-weight: 600;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 90px;
    }
    .player-card-money { color: #4CAF50; font-size: 10px; }
    .player-hp-bar { height: 4px; background: var(--border); border-radius: 2px; }
    .player-hp-fill { height: 100%; border-radius: 2px; }
    .ct-panel .player-hp-fill { background: #4FC3F7; }
    .t-panel  .player-hp-fill { background: #EF5350; }
    .player-card-bottom {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: var(--text-secondary);
    }
    /* Kill feed */
    .killfeed {
      position: absolute;
      bottom: 12px;
      right: 12px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      pointer-events: none;
      z-index: 10;
      min-width: 200px;
      max-width: 260px;
    }
    .kf-row {
      background: rgba(0,0,0,0.72);
      border-radius: 4px;
      padding: 4px 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      border-left: 2px solid transparent;
    }
    .kf-row.ct-kill { border-left-color: #4FC3F7; }
    .kf-row.t-kill  { border-left-color: #EF5350; }
    .kf-row.faded   { opacity: 0.4; }
    .kf-names { display: flex; align-items: center; gap: 5px; }
    .kf-killer.ct, .kf-victim.ct { color: #4FC3F7; }
    .kf-killer.t,  .kf-victim.t  { color: #EF5350; }
    .kf-meta { display: flex; align-items: center; gap: 4px; color: #888; font-size: 9px; }
    .kf-hs   { color: #FFD700; font-weight: 700; }
```

- [ ] **Step 3: Verify the HTML opens without JS errors by loading in browser**

Open `demo-viewer.html?id=<any-valid-id>` — panels and kill feed div should exist in DOM (empty but present).

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/demo-viewer.html
git commit -m "feat: add side panel and killfeed layout to demo viewer"
```

---

### Task 3: JS — player cards

**Files:**
- Modify: `cs2-hub/demo-viewer.js`

- [ ] **Step 1: Add `_lastFrameTick` state variable and `playerCardHTML` helper**

Add after the `let mapLoaded = false` line:

```javascript
let _lastFrameTick = -1
```

Add after the `render()` function:

```javascript
function playerCardHTML(p) {
  const hpPct = p.is_alive ? Math.max(0, Math.min(100, p.hp)) : 0
  const weapon = (p.weapon || '').replace('weapon_', '')
  return `<div class="player-card${p.is_alive ? '' : ' dead'}">
    <div class="player-card-top">
      <span class="player-card-name">${p.name.slice(0, 13)}</span>
      <span class="player-card-money">$${p.money ?? 0}</span>
    </div>
    <div class="player-hp-bar">
      <div class="player-hp-fill" style="width:${hpPct}%"></div>
    </div>
    <div class="player-card-bottom">
      <span>${p.is_alive ? p.hp + ' HP' : 'Dead'}</span>
      <span>${weapon}</span>
    </div>
  </div>`
}

function updatePlayerCards() {
  const frame = getFrame(state.tick)
  if (!frame || frame.tick === _lastFrameTick) return
  _lastFrameTick = frame.tick

  const sort = arr => arr.slice().sort((a, b) =>
    (b.is_alive - a.is_alive) || (b.hp - a.hp)
  )
  document.getElementById('ct-panel').innerHTML =
    sort(frame.players.filter(p => p.team === 'ct')).map(playerCardHTML).join('')
  document.getElementById('t-panel').innerHTML =
    sort(frame.players.filter(p => p.team === 't')).map(playerCardHTML).join('')
}
```

- [ ] **Step 2: Call `updatePlayerCards()` from the loop**

Find in `loop()`:
```javascript
    render()
    updateRoundTracker()
    updateTimeline()
```

Replace with:
```javascript
    render()
    updateRoundTracker()
    updateTimeline()
    updatePlayerCards()
```

- [ ] **Step 3: Reset `_lastFrameTick` when jumping rounds so cards refresh immediately**

Find in `jumpToRound`:
```javascript
function jumpToRound(idx) {
  state.roundIdx = Math.max(0, Math.min(idx, state.match.rounds.length - 1))
  state.tick     = currentRound().start_tick
  state.playing  = false
  updatePlayBtn()
  updateRoundTracker()
}
```

Replace with:
```javascript
function jumpToRound(idx) {
  state.roundIdx  = Math.max(0, Math.min(idx, state.match.rounds.length - 1))
  state.tick      = currentRound().start_tick
  state.playing   = false
  _lastFrameTick  = -1
  _lastRoundIdx   = -1
  updatePlayBtn()
  updateRoundTracker()
}
```

- [ ] **Step 4: Open viewer in browser, play a round — confirm player cards appear on both sides with names, HP bars, weapons, money**

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: add player cards to demo viewer side panels"
```

---

### Task 4: JS — kill feed and death markers

**Files:**
- Modify: `cs2-hub/demo-viewer.js`

- [ ] **Step 1: Add `_killerTeamCache` and `updateKillFeed` function after `updatePlayerCards`**

```javascript
function updateKillFeed() {
  const round = currentRound()
  const kills  = state.match.kills
    .filter(k => k.tick >= round.start_tick && k.tick <= state.tick)
    .slice(-5)
    .reverse()

  // Determine killer team from current frame player list
  const frame   = getFrame(state.tick)
  const teamMap = {}
  if (frame) for (const p of frame.players) teamMap[p.steam_id] = p.team

  document.getElementById('killfeed').innerHTML = kills.map((k, i) => {
    const kt = teamMap[k.killer_id] || 'ct'
    const vt = kt === 'ct' ? 't' : 'ct'
    const faded = i >= 3 ? ' faded' : ''
    const hs    = k.headshot ? '<span class="kf-hs">HS</span>' : ''
    const weapon = (k.weapon || '').replace('weapon_', '')
    return `<div class="kf-row ${kt}-kill${faded}">
      <div class="kf-names">
        <span class="kf-killer ${kt}">${k.killer_name.slice(0, 11)}</span>
        <span style="color:#555">→</span>
        <span class="kf-victim ${vt}">${k.victim_name.slice(0, 11)}</span>
      </div>
      <div class="kf-meta"><span>${weapon}</span>${hs}</div>
    </div>`
  }).join('')
}
```

- [ ] **Step 2: Call `updateKillFeed()` from the loop**

Find:
```javascript
    render()
    updateRoundTracker()
    updateTimeline()
    updatePlayerCards()
```

Replace with:
```javascript
    render()
    updateRoundTracker()
    updateTimeline()
    updatePlayerCards()
    updateKillFeed()
```

- [ ] **Step 3: Add `renderDeathMarkers` function and call it inside `render()`**

Add this function before `render()`:

```javascript
function renderDeathMarkers(round) {
  const kills = state.match.kills.filter(
    k => k.tick >= round.start_tick && k.tick <= state.tick
  )
  const frame = getFrame(round.start_tick)
  const teamMap = {}
  if (frame) for (const p of frame.players) teamMap[p.steam_id] = p.team

  const size = Math.round(canvas.width * 0.014)
  ctx.lineWidth = 2
  for (const k of kills) {
    if (k.victim_x === 0 && k.victim_y === 0) continue
    const { x, y } = worldToCanvas(k.victim_x, k.victim_y, mapName, canvas.width, canvas.height)
    const vt = teamMap[k.victim_id]
    ctx.strokeStyle = vt === 'ct' ? '#4FC3F7' : vt === 't' ? '#EF5350' : '#aaa'
    ctx.beginPath()
    ctx.moveTo(x - size, y - size); ctx.lineTo(x + size, y + size)
    ctx.moveTo(x + size, y - size); ctx.lineTo(x - size, y + size)
    ctx.stroke()
  }
}
```

Inside `render()`, add the call right after `ctx.clearRect` / map image block and before the player dots loop. Find:

```javascript
  const frame = getFrame(state.tick)
  if (!frame) return
```

Replace with:

```javascript
  const round = currentRound()
  renderDeathMarkers(round)

  const frame = getFrame(state.tick)
  if (!frame) return
```

- [ ] **Step 4: Open viewer — confirm ✕ markers appear on map where players died, kill feed shows in bottom-right**

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: add kill feed and death markers to demo viewer"
```

---

### Task 5: JS — grenade overlays and bomb tracking

**Files:**
- Modify: `cs2-hub/demo-viewer.js`

- [ ] **Step 1: Add `renderGrenades` function before `render()`**

```javascript
function renderGrenades(round, tick) {
  const grenades = (state.match.grenades ?? []).filter(
    g => g.tick >= round.start_tick && g.tick <= tick && g.end_tick >= tick
  )
  const cw = canvas.width
  for (const g of grenades) {
    if (g.x === 0 && g.y === 0) continue
    const { x, y } = worldToCanvas(g.x, g.y, mapName, cw, canvas.height)
    ctx.beginPath()
    if (g.type === 'smoke') {
      ctx.arc(x, y, cw * 0.055, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(180,180,180,0.35)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(200,200,200,0.5)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else if (g.type === 'molotov') {
      ctx.arc(x, y, cw * 0.04, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,100,0,0.3)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,140,0,0.6)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else if (g.type === 'flash') {
      const dur      = g.end_tick - g.tick
      const progress = dur > 0 ? Math.min(1, (tick - g.tick) / dur) : 1
      const radius   = Math.max(1, cw * 0.03 * (1 - progress))
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - progress)})`
      ctx.fill()
    } else if (g.type === 'he') {
      ctx.arc(x, y, cw * 0.025, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,220,0,0.7)'
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }
}
```

- [ ] **Step 2: Add `renderBomb` function before `render()`**

```javascript
function renderBomb(round, tick) {
  const events = (state.match.bomb ?? []).filter(
    b => b.tick >= round.start_tick && b.tick <= tick
  )
  if (!events.length) return
  const latest = events[events.length - 1]
  if (latest.x === 0 && latest.y === 0) return
  const { x, y } = worldToCanvas(latest.x, latest.y, mapName, canvas.width, canvas.height)
  const cw     = canvas.width
  const baseR  = cw * 0.018

  if (latest.type === 'planted') {
    const planted  = events.find(b => b.type === 'planted')
    const tickRate = state.match.meta.tick_rate
    const pulse    = Math.sin(tick / 8) * cw * 0.006
    ctx.beginPath()
    ctx.arc(x, y, baseR + pulse, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,50,50,0.7)'
    ctx.fill()
    if (planted) {
      const secsLeft = Math.max(0, Math.ceil((planted.tick + 40 * tickRate - tick) / tickRate))
      ctx.fillStyle    = '#fff'
      ctx.font         = `bold ${Math.round(cw * 0.02)}px sans-serif`
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(secsLeft + 's', x, y - baseR - 4)
    }
  } else if (latest.type === 'defused') {
    ctx.beginPath()
    ctx.arc(x, y, baseR, 0, Math.PI * 2)
    ctx.fillStyle = '#4CAF50'
    ctx.fill()
  } else if (latest.type === 'exploded') {
    ctx.beginPath()
    ctx.arc(x, y, cw * 0.025, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,140,0,0.8)'
    ctx.fill()
  }
}
```

- [ ] **Step 3: Call both inside `render()` — add after `renderDeathMarkers`, before player dots**

Find in `render()`:
```javascript
  const round = currentRound()
  renderDeathMarkers(round)

  const frame = getFrame(state.tick)
  if (!frame) return
```

Replace with:
```javascript
  const round = currentRound()
  renderDeathMarkers(round)
  renderGrenades(round, state.tick)
  renderBomb(round, state.tick)

  const frame = getFrame(state.tick)
  if (!frame) return
```

- [ ] **Step 4: Open viewer on a round with a bomb plant — confirm pulsing red dot + countdown, smoke circles, molotov areas**

- [ ] **Step 5: Commit and push**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: add grenade overlays and bomb tracking to demo viewer"
git push origin master
```

---

### Task 6: Deploy parser to VPS

**Files:**
- Deploy: `vps/demo_parser.py` → VPS

- [ ] **Step 1: Push parser changes (if not already done in Task 1)**

```bash
git push origin master
```

- [ ] **Step 2: Deploy to VPS**

On the VPS terminal:
```bash
echo "nameserver 8.8.8.8" > /etc/resolv.conf && wget -O /opt/midround/vps/demo_parser.py https://raw.githubusercontent.com/alexcze1/cs2-hub/master/vps/demo_parser.py && systemctl restart midround-demo-parser
```

- [ ] **Step 3: Upload a fresh demo and watch logs**

```bash
journalctl -u midround-demo-parser -f
```

Expected log line: `[parser] grenades: <N>  bomb events: <M>`  and  `Done: <id> — <map> <score>`

- [ ] **Step 4: Open viewer on the newly processed demo — confirm all features work end-to-end**

Checklist:
- Player cards visible on both sides with names, HP bars, weapons, money
- Kill feed shows in bottom-right
- ✕ markers appear where players died
- Smoke circles visible on rounds with smokes
- Bomb plant shows pulsing dot + countdown (check a round where bomb was planted)
