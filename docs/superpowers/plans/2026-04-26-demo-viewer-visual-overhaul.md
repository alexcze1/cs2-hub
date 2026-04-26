# Demo Viewer Visual Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add styled dark map backgrounds, weapon/grenade icons, utility countdown timers, and a score display to the CS2 demo viewer.

**Architecture:** A one-time Node.js build script (`make_maps.mjs`) converts radar PNGs to dark-themed viewer images; weapon SVG icons are sourced from `nicklvsa/csgo-weapon-icons` and served as static assets; all rendering changes are confined to `cs2-hub/demo-viewer.js`.

**Tech Stack:** Node.js + sharp (already installed), HTML canvas, CS2 demo viewer JS module

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `make_maps.mjs` | Create | Build script: `de_*_radar.png` → `de_*_viewer.png` |
| `cs2-hub/images/maps/de_*_viewer.png` | Generate | Dark-styled map backgrounds (8 maps) |
| `cs2-hub/images/weapons/*.svg` | Copy | Weapon + grenade icons from nicklvsa repo |
| `cs2-hub/demo-viewer.js` | Modify | Map fallback, grenade icons, timers, score display |

---

## Task 1: Map Background Build Script

**Files:**
- Create: `make_maps.mjs`

- [ ] **Step 1: Create `make_maps.mjs`**

```js
import { readdir }   from 'node:fs/promises'
import { join }      from 'node:path'
import sharp         from 'sharp'

const MAPS_DIR = 'cs2-hub/images/maps'

const WALL_THRESHOLD      = 80
const HIGHLIGHT_THRESHOLD = 200

// Target palette: near-black walls, dark floor, slightly lighter ledges
const WALL_COLOR      = [20,  20,  23 ]
const FLOOR_COLOR     = [30,  30,  34 ]
const HIGHLIGHT_COLOR = [46,  46,  52 ]

const files  = await readdir(MAPS_DIR)
const radars = files.filter(f => f.startsWith('de_') && f.endsWith('_radar.png'))

if (!radars.length) {
  console.error('No de_*_radar.png files found in', MAPS_DIR)
  process.exit(1)
}

for (const file of radars) {
  const src = join(MAPS_DIR, file)
  const dst = join(MAPS_DIR, file.replace('_radar.png', '_viewer.png'))

  const image = sharp(src)
  const meta  = await image.metadata()
  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  const out = Buffer.alloc(data.length)

  for (let i = 0; i < data.length; i += channels) {
    const r   = data[i]
    const g   = data[i + 1]
    const b   = data[i + 2]
    const lum = 0.299 * r + 0.587 * g + 0.114 * b

    let color
    if (lum < WALL_THRESHOLD)           color = WALL_COLOR
    else if (lum > HIGHLIGHT_THRESHOLD) color = HIGHLIGHT_COLOR
    else                                color = FLOOR_COLOR

    out[i]     = color[0]
    out[i + 1] = color[1]
    out[i + 2] = color[2]
    if (channels === 4) out[i + 3] = data[i + 3]  // preserve alpha
  }

  await sharp(out, { raw: { width, height, channels } }).png().toFile(dst)
  console.log(`✓  ${file}  →  ${dst.split('/').pop()}`)
}

console.log(`\nDone. Generated ${radars.length} viewer map(s).`)
```

- [ ] **Step 2: Run the build script**

```bash
node make_maps.mjs
```

Expected output:
```
✓  de_ancient_radar.png  →  de_ancient_viewer.png
✓  de_anubis_radar.png   →  de_anubis_viewer.png
✓  de_dust2_radar.png    →  de_dust2_viewer.png
✓  de_inferno_radar.png  →  de_inferno_viewer.png
✓  de_mirage_radar.png   →  de_mirage_viewer.png
✓  de_nuke_radar.png     →  de_nuke_viewer.png
✓  de_train_radar.png    →  de_train_viewer.png
✓  de_vertigo_radar.png  →  de_vertigo_viewer.png

Done. Generated 8 viewer map(s).
```

- [ ] **Step 3: Verify output files exist**

```bash
ls cs2-hub/images/maps/de_*_viewer.png
```

Expected: 8 files listed.

- [ ] **Step 4: Commit**

```bash
git add make_maps.mjs cs2-hub/images/maps/de_*_viewer.png
git commit -m "feat: add map background build script and dark viewer PNGs"
```

---

## Task 2: Viewer Loads Styled Map

**Files:**
- Modify: `cs2-hub/demo-viewer.js:66-69`

The current map loading code (lines 66–69):
```js
mapImg     = new Image()
mapImg.src = `images/maps/${mapName}_radar.png`
mapImg.onload  = () => { console.log('[viewer] radar loaded:', mapImg.src); mapLoaded = true }
mapImg.onerror = () => { console.warn('[viewer] radar 404:', mapImg.src); mapLoaded = true }
```

- [ ] **Step 1: Replace map loading with viewer-first + radar fallback**

Replace lines 66–69 with:

```js
mapImg     = new Image()
mapImg.src = `images/maps/${mapName}_viewer.png`
mapImg.onload  = () => { console.log('[viewer] viewer map loaded'); mapLoaded = true }
mapImg.onerror = () => {
  console.warn('[viewer] _viewer.png not found, falling back to _radar.png')
  mapImg.src     = `images/maps/${mapName}_radar.png`
  mapImg.onload  = () => { mapLoaded = true }
  mapImg.onerror = () => { mapLoaded = true }
}
```

- [ ] **Step 2: Visual check**

Open a demo in the viewer. The map background should now be dark (near-black walls, dark grey floor, slightly lighter ledges). Player icons and grenades should still render on top. If the map still looks like the original bright radar, check the browser console for the log line — if it says "falling back to _radar.png", the `_viewer.png` files weren't generated correctly.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: load dark-styled _viewer.png map background with radar fallback"
```

---

## Task 3: Weapon Icon Assets

**Files:**
- Create: `cs2-hub/images/weapons/` (directory + SVG files)

The `nicklvsa/csgo-weapon-icons` GitHub repo contains SVG weapon icons named `weapon_*.svg`. We strip the `weapon_` prefix when serving, matching the weapon names already used by the parser (`active_weapon_name` field, e.g. `ak47`, `m4a1_silencer`, `smokegrenade`).

- [ ] **Step 1: Clone the weapon icons repo**

```bash
git clone https://github.com/nicklvsa/csgo-weapon-icons /tmp/csgo-weapon-icons
ls /tmp/csgo-weapon-icons/
```

Note the directory structure. SVG files are likely at root level or in a `weapon_icons/` subdirectory. Adapt the copy command in Step 2 accordingly.

- [ ] **Step 2: Create weapons directory and copy SVGs**

```bash
mkdir -p cs2-hub/images/weapons
```

If SVGs are at root of the cloned repo:
```bash
for f in /tmp/csgo-weapon-icons/weapon_*.svg; do
  name=$(basename "$f" | sed 's/^weapon_//')
  cp "$f" "cs2-hub/images/weapons/$name"
done
```

If SVGs are in a subdirectory (e.g. `weapon_icons/`), adjust the path:
```bash
for f in /tmp/csgo-weapon-icons/weapon_icons/weapon_*.svg; do
  name=$(basename "$f" | sed 's/^weapon_//')
  cp "$f" "cs2-hub/images/weapons/$name"
done
```

- [ ] **Step 3: Verify key files exist**

```bash
ls cs2-hub/images/weapons/ | grep -E "ak47|m4a1|smokegrenade|flashbang|hegrenade|molotov"
```

Expected output includes: `ak47.svg`, `m4a1_silencer.svg` (or `m4a1.svg`), `smokegrenade.svg`, `flashbang.svg`, `hegrenade.svg`, `molotov.svg`

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/images/weapons/
git commit -m "feat: add weapon and grenade SVG icons from nicklvsa/csgo-weapon-icons"
```

---

## Task 4: Weapon Icons in Player Panel

**Files:**
- Modify: `cs2-hub/demo-viewer.js:491-507` (`playerCardHTML` function)

The current `playerCardHTML` function at line 491:

```js
function playerCardHTML(p) {
  const hpPct = p.is_alive ? Math.max(0, Math.min(100, p.hp)) : 0
  const weapon = (p.weapon || '').replace('weapon_', '')
  return `<div class="player-card${p.is_alive ? '' : ' dead'}">
    <div class="player-card-top">
      <span class="player-card-name">${esc(p.name.slice(0, 13))}</span>
      <span class="player-card-money">$${p.money ?? 0}</span>
    </div>
    <div class="player-hp-bar">
      <div class="player-hp-fill" style="width:${hpPct}%"></div>
    </div>
    <div class="player-card-bottom">
      <span>${p.is_alive ? p.hp + ' HP' : 'Dead'}</span>
      <span>${esc(weapon)}</span>
    </div>
  </div>`
}
```

- [ ] **Step 1: Replace the bottom row to include a weapon icon**

Replace the entire `playerCardHTML` function with:

```js
function playerCardHTML(p) {
  const hpPct  = p.is_alive ? Math.max(0, Math.min(100, p.hp)) : 0
  const weapon = (p.weapon || '').replace('weapon_', '')
  const iconEl = weapon
    ? `<img src="images/weapons/${esc(weapon)}.svg" width="16" height="16"
            style="object-fit:contain;vertical-align:middle;opacity:0.85"
            onerror="this.style.display='none'">`
    : ''
  return `<div class="player-card${p.is_alive ? '' : ' dead'}">
    <div class="player-card-top">
      <span class="player-card-name">${esc(p.name.slice(0, 13))}</span>
      <span class="player-card-money">$${p.money ?? 0}</span>
    </div>
    <div class="player-hp-bar">
      <div class="player-hp-fill" style="width:${hpPct}%"></div>
    </div>
    <div class="player-card-bottom">
      <span>${p.is_alive ? p.hp + ' HP' : 'Dead'}</span>
      <span style="display:flex;align-items:center;gap:3px">${iconEl}</span>
    </div>
  </div>`
}
```

- [ ] **Step 2: Visual check**

Open a demo. In the CT and T side panels, each player card's bottom row should show a small weapon icon (16×16) next to the HP. Dead players still show "Dead". Cards with unknown weapons (knife, c4, etc.) silently hide the icon via `onerror`.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: add weapon icon to player panel cards"
```

---

## Task 5: Grenade Icon Preload + Trajectory Rendering

**Files:**
- Modify: `cs2-hub/demo-viewer.js` — add preload block after line 305 (after `CT_COLOR`/`T_COLOR`), update `renderGrenades` around lines 170-183

- [ ] **Step 1: Add grenade icon preload block**

After line 306 (`function playerColor(team) { ... }`), add:

```js
// Grenade icons — preloaded at init, drawn on trajectory during flight
const GRENADE_ICONS = {}
;['smoke:smokegrenade', 'flash:flashbang', 'he:hegrenade', 'molotov:molotov'].forEach(entry => {
  const [type, filename] = entry.split(':')
  const img = new Image()
  img.src = `images/weapons/${filename}.svg`
  GRENADE_ICONS[type] = img
})
```

- [ ] **Step 2: Update the `inFlight` block inside `renderGrenades` to draw the grenade icon**

Current `inFlight` block (lines 171–183):

```js
      if (inFlight) {
        const duration = g.tick - g.origin_tick
        const progress = duration > 0 ? (tick - g.origin_tick) / duration : 1
        const cx = ox + (x - ox) * progress
        const cy = oy + (y - oy) * progress
        ctx.strokeStyle = typeColor
        ctx.globalAlpha = 0.75
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(cx, cy); ctx.stroke()
        ctx.setLineDash([])
        ctx.beginPath(); ctx.arc(cx, cy, cw * 0.008, 0, Math.PI * 2)
        ctx.fillStyle = typeColor; ctx.fill()
        ctx.restore()
        continue
      }
```

Replace with:

```js
      if (inFlight) {
        const duration = g.tick - g.origin_tick
        const progress = duration > 0 ? (tick - g.origin_tick) / duration : 1
        const cx = ox + (x - ox) * progress
        const cy = oy + (y - oy) * progress
        ctx.strokeStyle = typeColor
        ctx.globalAlpha = 0.75
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(cx, cy); ctx.stroke()
        ctx.setLineDash([])
        const icon = GRENADE_ICONS[g.type]
        if (icon && icon.complete && icon.naturalWidth) {
          const iconSz = cw * 0.022
          ctx.globalAlpha = 0.9
          ctx.drawImage(icon, cx - iconSz / 2, cy - iconSz / 2, iconSz, iconSz)
        } else {
          ctx.beginPath(); ctx.arc(cx, cy, cw * 0.008, 0, Math.PI * 2)
          ctx.fillStyle = typeColor; ctx.fill()
        }
        ctx.restore()
        continue
      }
```

- [ ] **Step 3: Visual check**

Scrub to a moment during a smoke throw. The grenade icon (smoke grenade SVG) should be visible on the trajectory line at the current flight position. If the SVG hasn't loaded yet on first view, it falls back to the coloured dot — reload and it should show the icon.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: draw grenade icon on trajectory during flight"
```

---

## Task 6: Grenade Countdown Timers

**Files:**
- Modify: `cs2-hub/demo-viewer.js` — inside `renderGrenades`, smoke block (~line 196) and molotov block (~line 205)

`tickRate` is already defined at line 149 inside `renderGrenades` as `const tickRate = state.match.meta.tick_rate`.

- [ ] **Step 1: Add countdown to smoke block**

Current smoke rendering (lines 196–204):

```js
    if (g.type === 'smoke') {
      ctx.beginPath()
      const r = cw * 0.055
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle   = 'rgba(180,180,180,0.35)'
      ctx.strokeStyle = 'rgba(200,200,200,0.5)'
      ctx.lineWidth   = 1.5
      ctx.fill()
      ctx.stroke()
    }
```

Replace with:

```js
    if (g.type === 'smoke') {
      ctx.beginPath()
      const r = cw * 0.055
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle   = 'rgba(180,180,180,0.35)'
      ctx.strokeStyle = 'rgba(200,200,200,0.5)'
      ctx.lineWidth   = 1.5
      ctx.fill()
      ctx.stroke()
      const remaining = Math.ceil((g.end_tick - tick) / tickRate)
      if (remaining > 0) {
        ctx.save()
        ctx.fillStyle    = 'rgba(255,255,255,0.9)'
        ctx.font         = `700 ${Math.round(r * 0.55)}px sans-serif`
        ctx.textAlign    = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(remaining, x, y)
        ctx.restore()
      }
    }
```

- [ ] **Step 2: Add countdown to molotov block**

Current molotov rendering (lines 205–213):

```js
    } else if (g.type === 'molotov') {
      ctx.beginPath()
      const r = cw * 0.04
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle   = 'rgba(255,100,0,0.3)'
      ctx.strokeStyle = 'rgba(255,140,0,0.6)'
      ctx.lineWidth   = 1.5
      ctx.fill()
      ctx.stroke()
    }
```

Replace with:

```js
    } else if (g.type === 'molotov') {
      ctx.beginPath()
      const r = cw * 0.04
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle   = 'rgba(255,100,0,0.3)'
      ctx.strokeStyle = 'rgba(255,140,0,0.6)'
      ctx.lineWidth   = 1.5
      ctx.fill()
      ctx.stroke()
      const remaining = Math.ceil((g.end_tick - tick) / tickRate)
      if (remaining > 0) {
        ctx.save()
        ctx.fillStyle    = '#FF9500'
        ctx.font         = `700 ${Math.round(r * 0.55)}px sans-serif`
        ctx.textAlign    = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(remaining, x, y)
        ctx.restore()
      }
    }
```

- [ ] **Step 3: Visual check**

Scrub to a round with a smoke or molotov. While the grenade is active:
- Smoke: a white number inside the grey circle showing seconds remaining (e.g. `18`, `15`, `3`...)
- Molotov: an orange number inside the fire circle

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: add countdown timer inside active smoke and molotov"
```

---

## Task 7: Score Display Below Timer

**Files:**
- Modify: `cs2-hub/demo-viewer.js:484` (end of round timer drawing block inside `render()`)

The timer pill is drawn from ~line 463 to line 483 (`ctx.restore()` closing the timer save). `CT_COLOR` and `T_COLOR` are module-level constants. `pillY` and `pillH` are local vars in `render()`, still in scope.

- [ ] **Step 1: Add score display after the timer pill `ctx.restore()`**

After the `ctx.restore()` at line 483 (the one that follows `ctx.fillText(timeStr, ...)`), before the closing `}` of `render()`, add:

```js
  // Score display — CT score | — | T score below timer pill
  const ctScore = state.match.rounds.slice(0, state.roundIdx).filter(r => r.winner_side === 'ct').length
  const tScore  = state.match.rounds.slice(0, state.roundIdx).filter(r => r.winner_side === 't').length
  const scoreFontSz = Math.round(cw * 0.022)
  const scoreY      = pillY + pillH + 4
  const scoreParts  = [
    { text: String(ctScore), color: CT_COLOR },
    { text: ' — ',           color: 'rgba(255,255,255,0.4)' },
    { text: String(tScore),  color: T_COLOR },
  ]
  ctx.save()
  ctx.font         = `700 ${scoreFontSz}px "SF Mono", "Consolas", monospace`
  ctx.textBaseline = 'top'
  ctx.textAlign    = 'left'
  const scoreW = scoreParts.reduce((s, { text }) => s + ctx.measureText(text).width, 0)
  let sx = cw / 2 - scoreW / 2
  for (const { text, color } of scoreParts) {
    ctx.fillStyle = color
    ctx.fillText(text, sx, scoreY)
    sx += ctx.measureText(text).width
  }
  ctx.restore()
```

- [ ] **Step 2: Visual check**

Open a demo partway through. Directly below the round-timer pill you should see something like:

```
   5 — 8
```

CT score in blue (`#4FC3F7`), separator in dim white, T score in orange (`#FF9500`). Score increments after each round ends (reflects rounds completed up to current `state.roundIdx`).

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat: add CT/T score display below round timer"
```
