import { requireAuth }   from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase }      from './supabase.js'
import { worldToCanvas } from './demo-map-data.js'
import { getTeamLogo }   from './team-autocomplete.js'

await requireAuth()
renderSidebar('demos')

const params = new URLSearchParams(location.search)
const demoId = params.get('id')
if (!demoId) { location.href = 'demos.html'; throw new Error('no id') }

// ── State ─────────────────────────────────────────────────────
const state = { match: null, playing: false, tick: 0, speed: 1, lastTs: 0, roundIdx: 0 }
let mapImg    = null
let mapLoaded = false
let _lastFrameTick = -1
let _lastRoundIdx  = -1
let _lastKillTick  = -1
const _prevHp     = {}  // steam_id → last rendered hp
const _flashUntil = {}  // steam_id → Date.now() ms when flash expires
let mapZoom = 1
let mapPanX = 0
let mapPanY = 0
const ZOOM_MIN = 1
const ZOOM_MAX = 6

// ── Drawing tool ──────────────────────────────────────────────
let drawingMode  = false
let drawPaths    = []
let currentPath  = null
const DRAW_COLORS = ['#ffffff', '#FF1744', '#4FC3F7', '#FF9500', '#69F0AE', '#FFEA00', '#CE93D8']
let drawColorIdx = 0

// ── Load ──────────────────────────────────────────────────────
const loadingEl = document.getElementById('viewer-loading')

const { data: demo, error } = await supabase
  .from('demos')
  .select('match_data,map,status,ct_team_name,t_team_name,series_id')
  .eq('id', demoId)
  .single()

if (error || !demo || demo.status !== 'ready') {
  loadingEl.textContent =
    demo?.status === 'processing' ? 'Demo is still processing…' :
    demo?.status === 'error'      ? 'Demo processing failed.'   :
    'Demo not found.'
  throw new Error('not ready')
}

state.match         = demo.match_data
state.match.rounds  = state.match.rounds ?? []
state.match.frames  = state.match.frames ?? []
state.match.kills    = state.match.kills     ?? []
state.match.grenades = state.match.grenades ?? []
state.match.bomb     = state.match.bomb     ?? []
state.match.shots    = state.match.shots    ?? []
if (!state.match.meta) state.match.meta = {}
state.match.meta.tick_rate = state.match.meta.tick_rate || 64


if (!state.match.frames.length) {
  loadingEl.textContent = 'No frame data — try re-uploading.'
  throw new Error('no frames')
}
if (!state.match.frames[0]?.players?.length) {
  loadingEl.textContent = 'Parser returned no players — check server logs.'
  throw new Error('no players in frame 0')
}
if (!state.match.rounds.length) {
  loadingEl.textContent = 'No round data — try re-uploading.'
  throw new Error('no rounds')
}

// Use meta.map from parsed data as source of truth; fall back to DB column
const mapName = state.match.meta?.map || demo.map || ''
document.title = `${mapName} — MIDROUND`
console.log('[viewer] map:', mapName, '| rounds:', state.match.rounds.length, '| frames:', state.match.frames.length, '| tick_rate:', state.match.meta.tick_rate)

mapImg     = new Image()
mapImg.src = `images/maps/${mapName}_viewer.png`
mapImg.onload  = () => { console.log('[viewer] viewer map loaded'); mapLoaded = true }
mapImg.onerror = () => {
  console.warn('[viewer] _viewer.png not found, falling back to _radar.png')
  mapImg.src     = `images/maps/${mapName}_radar.png`
  mapImg.onload  = () => { mapLoaded = true }
  mapImg.onerror = () => { mapLoaded = true }
}

loadingEl.style.display = 'none'
document.getElementById('viewer-shell').style.display = 'flex'

// ── Team names in header ──────────────────────────────────────
async function applyTeamNames() {
  const ctName = demo.ct_team_name
  const tName  = demo.t_team_name
  if (!ctName && !tName) return

  const ctNameEl = document.getElementById('vh-ct-name')
  const tNameEl  = document.getElementById('vh-t-name')
  const ctLogoEl = document.getElementById('vh-ct-logo')
  const tLogoEl  = document.getElementById('vh-t-logo')

  if (ctName) {
    ctNameEl.textContent = ctName
    const logo = await getTeamLogo(ctName)
    if (logo) { ctLogoEl.src = logo; ctLogoEl.style.display = 'block' }
  }
  if (tName) {
    tNameEl.textContent = tName
    const logo = await getTeamLogo(tName)
    if (logo) { tLogoEl.src = logo; tLogoEl.style.display = 'block' }
  }
}
applyTeamNames()

// ── Series map switcher ───────────────────────────────────────
async function loadSeries() {
  if (!demo.series_id) return
  const { data: siblings } = await supabase
    .from('demos')
    .select('id,map,score_ct,score_t,status')
    .eq('series_id', demo.series_id)
    .order('created_at', { ascending: true })

  if (!siblings || siblings.length < 2) return

  const swEl = document.getElementById('map-switcher')
  swEl.style.display = 'flex'
  swEl.innerHTML = siblings.map((s, i) => {
    const mapShort = (s.map || 'de_?').replace('de_', '').toUpperCase().slice(0, 6)
    const score    = s.score_ct != null ? `${s.score_ct}–${s.score_t}` : s.status === 'ready' ? '?–?' : '…'
    const active   = s.id === demoId ? ' active' : ''
    return `<a class="map-sw-pill${active}" href="demo-viewer.html?id=${s.id}">
      <span class="map-sw-num">M${i + 1}</span>
      <span class="map-sw-name">${mapShort}</span>
      <span class="map-sw-score">${score}</span>
    </a>`
  }).join('')
}
loadSeries()

// ── Canvas ────────────────────────────────────────────────────
const canvas = document.getElementById('map-canvas')
const ctx    = canvas.getContext('2d')
const wrap   = document.getElementById('map-canvas-wrap')

function resizeCanvas() {
  const { width, height } = wrap.getBoundingClientRect()
  if (width < 10 || height < 10) return
  canvas.width  = Math.round(width)
  canvas.height = Math.round(height)
}
requestAnimationFrame(resizeCanvas)
new ResizeObserver(resizeCanvas).observe(wrap)

// ── Round helpers ─────────────────────────────────────────────
function currentRound() { return state.match.rounds[state.roundIdx] }
function freezeEnd(round) { return round.freeze_end_tick ?? round.start_tick }

function jumpToRound(idx) {
  state.roundIdx  = Math.max(0, Math.min(idx, state.match.rounds.length - 1))
  state.tick      = freezeEnd(currentRound())
  state.playing   = false
  _lastFrameTick  = -1
  _lastRoundIdx   = -1
  _lastKillTick   = -1
  Object.keys(_prevHp).forEach(k => delete _prevHp[k])
  Object.keys(_flashUntil).forEach(k => delete _flashUntil[k])
  updatePlayBtn()
  updateRoundRow()
  updateTimelineKills()
}

// ── Frame lookup (binary search) ──────────────────────────────
function getFrame(tick) {
  const frames = state.match.frames
  if (!frames.length) return null
  let lo = 0, hi = frames.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (frames[mid].tick <= tick) lo = mid
    else hi = mid - 1
  }
  return frames[lo]
}

function getInterpolatedFrame(tick) {
  const frames = state.match.frames
  if (!frames.length) return null
  let lo = 0, hi = frames.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (frames[mid].tick <= tick) lo = mid
    else hi = mid - 1
  }
  const prev = frames[lo]
  const next = frames[lo + 1]
  if (!next || next.tick <= prev.tick || next.tick - prev.tick > 48) return prev
  const t = Math.min(1, (tick - prev.tick) / (next.tick - prev.tick))
  if (t <= 0) return prev
  const players = prev.players.map(prevP => {
    const nextP = next.players.find(n => n.steam_id === prevP.steam_id)
    if (!nextP || !prevP.is_alive || !nextP.is_alive) return prevP
    const dyaw = (nextP.yaw - prevP.yaw + 540) % 360 - 180
    return { ...prevP, x: prevP.x + (nextP.x - prevP.x) * t, y: prevP.y + (nextP.y - prevP.y) * t, yaw: prevP.yaw + dyaw * t }
  })
  return { tick, players }
}


// ── Grenade overlays ──────────────────────────────────────────
function renderGrenades(round, tick, frame, cw, ch, tc, mapSize) {
  const teamBySid = {}
  for (const p of (frame?.players ?? [])) teamBySid[p.steam_id] = p.team

  const tickRate = state.match.meta.tick_rate
  const GAME_HZ  = 128
  const TRAJ_TICKS       = { smoke: tickRate * 7, molotov: tickRate * 6, he: tickRate * 5, flash: tickRate * 2 }
  const GRENADE_DURATION_S = { smoke: 22, molotov: 7 }

  // Deduplicate grenades by (type, tick, steam_id) — parser can emit duplicate rows
  const seen = new Set()
  const grenades = state.match.grenades.filter(g => {
    const key = `${g.type}:${g.tick}:${g.steam_id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  ctx.save()
  for (const g of grenades) {
    if (g.tick < round.start_tick) continue
    if (g.end_tick == null) continue

    const trajTicks = TRAJ_TICKS[g.type] ?? tickRate * 3
    const totalS    = GRENADE_DURATION_S[g.type] ?? ((g.end_tick - g.tick) / GAME_HZ)
    const elapsedS  = (tick - g.tick) / tickRate

    const inFlight = g.origin_tick != null && g.origin_tick <= tick && tick < g.tick
    const active   = g.tick <= tick && elapsedS < totalS
    // Flash: hide trajectory while white circle is still visible (avoids "thrown twice" look)
    const showTraj = g.tick <= tick && (tick - g.tick) < trajTicks && !(g.type === 'flash' && active)
    if (!inFlight && !active && !showTraj) continue

    const { x, y } = tc(g.x, g.y)
    const typeColor = g.type === 'smoke'   ? 'rgba(200,200,200,0.6)'
                    : g.type === 'molotov' ? 'rgba(255,140,0,0.6)'
                    : g.type === 'flash'   ? 'rgba(255,255,255,0.5)'
                    :                        'rgba(255,220,0,0.6)'

    // ── Trajectory (real path) ────────────────────────────────
    const pathPts = g.path  // [[wx,wy], ...] from parser bounce events
    if (pathPts && pathPts.length >= 2) {
      const canvasPts = pathPts.map(([wx, wy]) => tc(wx, wy))
      ctx.save()
      ctx.setLineDash([3, 5])
      ctx.lineWidth = 1.5

      if (inFlight) {
        // Animate icon along the real path using per-point ticks when available
        const throwT   = g.path_throw_tick ?? g.origin_tick
        const detT     = g.path_det_tick   ?? g.tick
        const duration = detT - throwT
        const progress = duration > 0 ? Math.min(1, (tick - throwT) / duration) : 1

        let seg, t
        const ptTicks = g.path_ticks
        if (ptTicks && ptTicks.length === canvasPts.length) {
          // Tick-accurate: find which segment the current tick falls in
          let lo = 0
          for (let i = 0; i < ptTicks.length - 1; i++) {
            if (tick >= ptTicks[i]) lo = i
            else break
          }
          seg = Math.min(lo, canvasPts.length - 2)
          const segDur = ptTicks[seg + 1] - ptTicks[seg]
          t = segDur > 0 ? Math.min(1, (tick - ptTicks[seg]) / segDur) : 1
        } else {
          // Fallback: distribute evenly across segments
          const totalSegs = canvasPts.length - 1
          const rawT = progress * totalSegs
          seg = Math.min(Math.floor(rawT), totalSegs - 1)
          t   = rawT - seg
        }

        const p0    = canvasPts[seg]
        const p1    = canvasPts[seg + 1]
        const iconX = p0.x + (p1.x - p0.x) * t
        const iconY = p0.y + (p1.y - p0.y) * t
        // Scale icon up at peak to hint at height
        const arcScale = 1 + 0.5 * 4 * progress * (1 - progress)

        // Draw travelled path so far
        ctx.strokeStyle = typeColor
        ctx.globalAlpha = 0.75
        ctx.beginPath()
        ctx.moveTo(canvasPts[0].x, canvasPts[0].y)
        for (let i = 1; i <= seg; i++) ctx.lineTo(canvasPts[i].x, canvasPts[i].y)
        ctx.lineTo(iconX, iconY)
        ctx.stroke()
        ctx.setLineDash([])
        const icon = GRENADE_ICONS[g.type]
        if (icon && icon.complete && icon.naturalWidth) {
          const iconSz = mapSize * 0.022 * arcScale
          ctx.globalAlpha = 0.9
          ctx.drawImage(icon, iconX - iconSz / 2, iconY - iconSz / 2, iconSz, iconSz)
        } else {
          ctx.beginPath(); ctx.arc(iconX, iconY, mapSize * 0.008 * arcScale, 0, Math.PI * 2)
          ctx.fillStyle = typeColor; ctx.fill()
        }
        ctx.restore()
        continue
      } else if (showTraj) {
        const alpha = 1 - (tick - g.tick) / trajTicks
        ctx.strokeStyle = typeColor
        ctx.globalAlpha = alpha * 0.65
        ctx.beginPath()
        ctx.moveTo(canvasPts[0].x, canvasPts[0].y)
        for (let i = 1; i < canvasPts.length; i++) ctx.lineTo(canvasPts[i].x, canvasPts[i].y)
        ctx.stroke()
        // Dot at throw origin
        ctx.setLineDash([])
        ctx.globalAlpha = alpha * 0.5
        ctx.beginPath(); ctx.arc(canvasPts[0].x, canvasPts[0].y, mapSize * 0.005, 0, Math.PI * 2)
        ctx.fillStyle = typeColor; ctx.fill()
      }
      ctx.restore()
    } else if (g.origin_x != null && !(g.origin_x === 0 && g.origin_y === 0)) {
      // Fallback: no path data — straight line
      const { x: ox, y: oy } = tc(g.origin_x, g.origin_y)
      ctx.save()
      ctx.setLineDash([3, 5])
      ctx.lineWidth = 1.5
      if (inFlight) {
        const duration = g.tick - g.origin_tick
        const progress = duration > 0 ? (tick - g.origin_tick) / duration : 1
        const arcScale = 1 + 0.5 * 4 * progress * (1 - progress)
        const iconX = ox + (x - ox) * progress
        const iconY = oy + (y - oy) * progress
        ctx.strokeStyle = typeColor; ctx.globalAlpha = 0.75
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(iconX, iconY); ctx.stroke()
        ctx.setLineDash([])
        const icon = GRENADE_ICONS[g.type]
        if (icon && icon.complete && icon.naturalWidth) {
          const iconSz = mapSize * 0.022 * arcScale; ctx.globalAlpha = 0.9
          ctx.drawImage(icon, iconX - iconSz / 2, iconY - iconSz / 2, iconSz, iconSz)
        } else {
          ctx.beginPath(); ctx.arc(iconX, iconY, mapSize * 0.008 * arcScale, 0, Math.PI * 2)
          ctx.fillStyle = typeColor; ctx.fill()
        }
        ctx.restore(); continue
      } else if (showTraj) {
        const alpha = 1 - (tick - g.tick) / trajTicks
        ctx.strokeStyle = typeColor; ctx.globalAlpha = alpha * 0.65
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(x, y); ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = alpha * 0.5
        ctx.beginPath(); ctx.arc(ox, oy, mapSize * 0.005, 0, Math.PI * 2)
        ctx.fillStyle = typeColor; ctx.fill()
      }
      ctx.restore()
    }

    if (!active) continue
    if (g.x === 0 && g.y === 0) continue

    const throwerTeam = teamBySid[g.steam_id] ?? null
    const teamOutline = throwerTeam === 'ct' ? CT_COLOR : throwerTeam === 't' ? T_COLOR : null

    if (g.type === 'smoke') {
      const r = mapSize * 0.032
      // Check for nearby HE reveals
      const heReveals = grenades.filter(h =>
        h.type === 'he' && h.tick >= round.start_tick &&
        tick >= h.tick && tick < h.tick + tickRate * 4 &&
        (h.x - g.x) ** 2 + (h.y - g.y) ** 2 < 200 * 200
      )
      ctx.save()
      if (heReveals.length > 0) {
        // Clip: smoke circle minus HE holes (evenodd rule)
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        for (const he of heReveals) {
          const { x: hx, y: hy } = tc(he.x, he.y)
          const heAge  = (tick - he.tick) / tickRate
          const holeR  = mapSize * 0.008 + mapSize * 0.02 * Math.min(1, heAge / 0.4)
          ctx.arc(hx, hy, holeR, 0, Math.PI * 2)
        }
        ctx.clip('evenodd')
      }
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle   = 'rgba(180,180,180,0.35)'
      ctx.strokeStyle = teamOutline ?? 'rgba(200,200,200,0.5)'
      ctx.lineWidth   = 1.2
      ctx.fill(); ctx.stroke()
      drawCountdownText(x, y, r, Math.ceil(totalS - elapsedS), 'rgba(255,255,255,0.9)')
      ctx.restore()

    } else if (g.type === 'molotov') {
      // Extinguished by overlapping active smoke
      const smoked = grenades.some(s => {
        if (s.type !== 'smoke' || s.tick > tick) return false
        const sElapsed = (tick - s.tick) / tickRate
        if (sElapsed > 22) return false
        return (s.x - g.x) ** 2 + (s.y - g.y) ** 2 < 180 * 180
      })
      if (smoked) continue

      const r = mapSize * 0.028
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle   = 'rgba(255,100,0,0.3)'
      ctx.strokeStyle = teamOutline ?? 'rgba(255,140,0,0.6)'
      ctx.lineWidth   = 1.2
      ctx.fill(); ctx.stroke()
      drawCountdownText(x, y, r, Math.ceil(totalS - elapsedS), '#FF9500')

    } else if (g.type === 'flash') {
      const durationSec = (g.end_tick - g.tick) / GAME_HZ
      const elapsedSec  = (tick - g.tick) / tickRate
      const progress    = durationSec > 0 ? Math.min(1, elapsedSec / durationSec) : 1
      const r = mapSize * 0.03 * (1 - progress)
      if (r > 0) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fill()
      }

    } else if (g.type === 'he') {
      const progress = totalS > 0 ? Math.min(1, elapsedS / totalS) : 1
      const r = mapSize * 0.03 * (1 - progress)
      if (r > 0) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(220,50,50,0.6)'; ctx.fill()
      }
    }
  }
  ctx.restore()
}

// ── Bomb tracking ─────────────────────────────────────────────
function renderBomb(round, tick, cw, ch, tc, mapSize) {
  ctx.save()
  const tickRate = state.match.meta.tick_rate
  const fontSize = Math.round(mapSize * 0.018)
  let latest = null
  for (const event of state.match.bomb) {
    if (event.tick < round.start_tick || event.tick > tick) continue
    if (latest === null || event.tick > latest.tick) latest = event
  }
  if (!latest) { ctx.restore(); return }
  if (latest.x == null || latest.y == null) { ctx.restore(); return }
  const { x, y } = tc(latest.x, latest.y)
  if (latest.type === 'planted') {
    const r = mapSize * 0.018 + Math.sin(tick / 8) * mapSize * 0.006
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,50,50,0.7)'
    ctx.fill()
    const seconds = Math.max(0, 40 - (tick - latest.tick) / tickRate)
    ctx.fillStyle    = '#fff'
    ctx.font         = `700 ${fontSize}px Inter, system-ui, sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(Math.ceil(seconds), x, y - r - 2)
  } else if (latest.type === 'defused') {
    ctx.beginPath()
    ctx.arc(x, y, mapSize * 0.018, 0, Math.PI * 2)
    ctx.fillStyle = '#4CAF50'
    ctx.fill()
  } else if (latest.type === 'exploded') {
    ctx.beginPath()
    ctx.arc(x, y, mapSize * 0.025, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,140,0,0.8)'
    ctx.fill()
  }
  ctx.restore()
}

// ── Shot beam ─────────────────────────────────────────────────
function renderShots(round, tick, frame, cw, ch, tc, mapSize) {
  const BEAM_DURATION = 9
  ctx.save()
  ctx.lineCap = 'round'

  for (const shot of state.match.shots) {
    if (shot.tick < round.start_tick || shot.tick > tick) continue
    const age = tick - shot.tick
    if (age > BEAM_DURATION) continue

    const player = frame.players.find(p => p.steam_id === shot.steam_id)
    if (!player || !player.is_alive || player.yaw == null) continue

    const { x, y }   = tc(player.x, player.y)
    const fade        = 1 - age / BEAM_DURATION
    const yawRad      = player.yaw * Math.PI / 180
    const { x: bx, y: by } = tc(
      player.x + Math.cos(yawRad) * 520,
      player.y + Math.sin(yawRad) * 520
    )
    const isct   = player.team === 'ct'
    const teamRgb = isct ? '79,195,247' : '255,149,0'
    const teamHex = isct ? CT_COLOR : T_COLOR

    // Outer glow — team-colored, soft
    const glowGrad = ctx.createLinearGradient(x, y, bx, by)
    glowGrad.addColorStop(0,    `rgba(${teamRgb},${(fade * 0.35).toFixed(2)})`)
    glowGrad.addColorStop(0.55, `rgba(${teamRgb},${(fade * 0.15).toFixed(2)})`)
    glowGrad.addColorStop(1,    `rgba(${teamRgb},0)`)
    ctx.globalAlpha = 1
    ctx.strokeStyle = glowGrad
    ctx.lineWidth   = 5.5
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(bx, by); ctx.stroke()

    // Core beam — white, fades along length then over time
    const coreGrad = ctx.createLinearGradient(x, y, bx, by)
    coreGrad.addColorStop(0,    `rgba(255,255,255,${(fade * 0.95).toFixed(2)})`)
    coreGrad.addColorStop(0.45, `rgba(255,255,255,${(fade * 0.55).toFixed(2)})`)
    coreGrad.addColorStop(1,    'rgba(255,255,255,0)')
    ctx.strokeStyle = coreGrad
    ctx.lineWidth   = 1.3
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(bx, by); ctx.stroke()

    // Muzzle flash — expanding ring + shrinking white dot for first 3 ticks
    if (age <= 3) {
      const ft = age / 3
      ctx.globalAlpha = (1 - ft) * 0.85
      ctx.beginPath()
      ctx.arc(x, y, mapSize * 0.005 + mapSize * 0.015 * ft, 0, Math.PI * 2)
      ctx.strokeStyle = teamHex
      ctx.lineWidth   = 1.5
      ctx.stroke()
      ctx.globalAlpha = (1 - ft) * 0.75
      ctx.beginPath()
      ctx.arc(x, y, mapSize * 0.0045 * (1 - ft * 0.6), 0, Math.PI * 2)
      ctx.fillStyle = '#fff'
      ctx.fill()
    }
  }

  ctx.restore()
}

// ── Player rendering helpers ──────────────────────────────────
const CT_COLOR = '#4FC3F7'
const T_COLOR  = '#FF9500'

function playerColor(team) { return team === 'ct' ? CT_COLOR : T_COLOR }

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

// Grenade icons — preloaded at init, drawn on trajectory during flight
const GRENADE_ICONS = {}
;['smoke:smokegrenade', 'flash:flashbang', 'he:hegrenade', 'molotov:molotov'].forEach(entry => {
  const [type, filename] = entry.split(':')
  const img = new Image()
  img.src = `images/weapons/${filename}.svg`
  GRENADE_ICONS[type] = img
})

function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function drawPlayerPill(x, dotTopY, label, color, pillFont, pillFontSz) {
  ctx.save()
  ctx.font = pillFont
  const tw  = ctx.measureText(label).width
  const ph  = pillFontSz + 5
  const pw  = tw + 12
  const px  = x - pw / 2
  const py  = dotTopY - ph - 2
  // Dark glass background
  drawRoundRect(ctx, px, py, pw, ph, ph / 2)
  ctx.fillStyle   = 'rgba(3,7,18,0.82)'
  ctx.fill()
  // Team-color outline
  drawRoundRect(ctx, px, py, pw, ph, ph / 2)
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.75
  ctx.lineWidth   = 1
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.fillStyle    = '#fff'
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x, py + ph / 2)
  ctx.restore()
}

function drawCountdownText(x, y, r, remaining, textColor) {
  if (remaining <= 0) return
  ctx.save()

  ctx.fillStyle    = textColor
  ctx.font         = `700 ${Math.round(r * 0.44)}px Inter, system-ui, sans-serif`
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(remaining, x, y)
  ctx.restore()
}

// ── Render ────────────────────────────────────────────────────
function render() {
  const cw = canvas.width
  const ch = canvas.height
  ctx.clearRect(0, 0, cw, ch)

  // Dark fill — letterbox areas match body bg
  ctx.fillStyle = '#030712'
  ctx.fillRect(0, 0, cw, ch)

  // Map region: object-fit:contain centered square
  const mapSize = Math.min(cw, ch)
  const mapX    = Math.round((cw - mapSize) / 2)
  const mapY    = Math.round((ch - mapSize) / 2)

  // Helper: world coords → canvas coords (accounts for map offset)
  function tc(wx, wy) {
    const { x, y } = worldToCanvas(wx, wy, mapName, mapSize, mapSize)
    return { x: x + mapX, y: y + mapY }
  }

  // ── Zoomed map layer ──────────────────────────────────────
  ctx.save()
  ctx.translate(cw / 2 + mapPanX, ch / 2 + mapPanY)
  ctx.scale(mapZoom, mapZoom)
  ctx.translate(-cw / 2, -ch / 2)

  if (mapLoaded && mapImg.complete && mapImg.naturalWidth) {
    ctx.drawImage(mapImg, mapX, mapY, mapSize, mapSize)
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.fillRect(mapX, mapY, mapSize, mapSize)
    // Edge vignette — blends map into letterbox bg, removes visible box border
    const vign = mapSize * 0.07
    const bg   = '#030712'
    const makeGrad = (x0, y0, x1, y1) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1)
      g.addColorStop(0, bg); g.addColorStop(1, 'rgba(3,7,18,0)')
      return g
    }
    ctx.fillStyle = makeGrad(mapX,                    0, mapX + vign,              0); ctx.fillRect(mapX,                    mapY, vign,    mapSize)
    ctx.fillStyle = makeGrad(mapX + mapSize,          0, mapX + mapSize - vign,    0); ctx.fillRect(mapX + mapSize - vign,   mapY, vign,    mapSize)
    ctx.fillStyle = makeGrad(0, mapY,                    0, mapY + vign              ); ctx.fillRect(mapX, mapY,                    mapSize, vign)
    ctx.fillStyle = makeGrad(0, mapY + mapSize,          0, mapY + mapSize - vign    ); ctx.fillRect(mapX, mapY + mapSize - vign,   mapSize, vign)
  } else {
    ctx.fillStyle = '#030712'
    ctx.fillRect(mapX, mapY, mapSize, mapSize)
  }
  const frame = getInterpolatedFrame(state.tick)
  if (frame) {
    const dotR       = Math.round(mapSize * 0.009)
    const pillFontSz = Math.round(mapSize * 0.0092)
    const pillFont   = `600 ${pillFontSz}px Inter, system-ui, sans-serif`
    const round      = currentRound()

    renderGrenades(round, state.tick, frame, cw, ch, tc, mapSize)
    renderBomb(round, state.tick, cw, ch, tc, mapSize)

    // Build active blind map: steam_id → { until, totalTicks }
    const tickRate   = state.match.meta.tick_rate
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

    for (const p of frame.players) {
      const { x, y } = tc(p.x, p.y)

      if (!p.is_alive) {
        ctx.save()
        ctx.globalAlpha = 0.28
        ctx.beginPath()
        ctx.arc(x, y, dotR * 0.75, 0, Math.PI * 2)
        ctx.fillStyle   = '#777'
        ctx.strokeStyle = 'rgba(255,255,255,0.25)'
        ctx.lineWidth   = 1
        ctx.fill()
        ctx.stroke()
        ctx.restore()
        continue
      }

      const id       = p.steam_id
      const blindInfo = blindUntil[id]

      if (p.hp != null && p.hp > 0) {
        const arcR = dotR + 3
        ctx.save()
        ctx.lineWidth = 1.5
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

      if (state.playing && _prevHp[id] != null && p.hp < _prevHp[id]) {
        _flashUntil[id] = Date.now() + 350
      }
      _prevHp[id] = p.hp
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

      if (p.yaw != null) {
        const yawRad = p.yaw * Math.PI / 180
        const { x: dirX, y: dirY } = tc(
          p.x + Math.cos(yawRad) * 300,
          p.y + Math.sin(yawRad) * 300
        )
        const angle      = Math.atan2(dirY - y, dirX - x)
        const notchAngle = 22 * Math.PI / 180
        const tipDist    = dotR * 0.45
        ctx.save()
        ctx.beginPath()
        ctx.arc(x, y, dotR, angle + notchAngle, angle - notchAngle)
        ctx.lineTo(x + Math.cos(angle) * (dotR + tipDist), y + Math.sin(angle) * (dotR + tipDist))
        ctx.closePath()
        ctx.fillStyle   = color
        ctx.strokeStyle = 'rgba(255,255,255,0.88)'
        ctx.lineWidth   = 1.5
        ctx.fill()
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(x, y, dotR * 0.28, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255,255,255,0.82)'
        ctx.fill()
        ctx.restore()
      } else {
        ctx.save()
        ctx.beginPath()
        ctx.arc(x, y, dotR, 0, Math.PI * 2)
        ctx.fillStyle   = color
        ctx.strokeStyle = 'rgba(255,255,255,0.88)'
        ctx.lineWidth   = 1.5
        ctx.fill()
        ctx.stroke()
        ctx.restore()
      }
    }

    for (const p of frame.players) {
      if (!p.is_alive) continue
      const { x, y } = tc(p.x, p.y)
      drawPlayerPill(x, y - dotR, p.name.slice(0, 13), playerColor(p.team), pillFont, pillFontSz)

      const rawWeapon = (p.weapon || '').replace('weapon_', '')
      const iconName  = WEAPON_ICON_MAP[rawWeapon] ?? rawWeapon
      const wIcon     = WEAPON_CANVAS_ICONS[iconName]
      if (wIcon && wIcon.complete && wIcon.naturalWidth) {
        const sz = Math.round(mapSize * 0.018)
        const ph = pillFontSz + 5
        const py = (y - dotR) - ph - 2
        ctx.save()
        ctx.drawImage(wIcon, x - sz / 2, py - sz - 2, sz, sz)
        ctx.restore()
      }
    }

    renderShots(round, state.tick, frame, cw, ch, tc, mapSize)
  }

  ctx.restore() // end zoom transform

  // ── Drawing overlay (zoomed, anchored to map) ─────────────
  if (drawPaths.length > 0 || currentPath) {
    ctx.save()
    ctx.translate(cw / 2 + mapPanX, ch / 2 + mapPanY)
    ctx.scale(mapZoom, mapZoom)
    ctx.translate(-cw / 2, -ch / 2)
    ctx.lineCap  = 'round'
    ctx.lineJoin = 'round'
    for (const path of [...drawPaths, ...(currentPath ? [currentPath] : [])]) {
      if (path.points.length < 2) continue
      ctx.beginPath()
      ctx.strokeStyle = path.color
      ctx.lineWidth   = 3 / mapZoom
      ctx.moveTo(path.points[0].x, path.points[0].y)
      for (let i = 1; i < path.points.length; i++) ctx.lineTo(path.points[i].x, path.points[i].y)
      ctx.stroke()
    }
    ctx.restore()
  }

  // ── Draw mode indicator (top-left) ───────────────────────
  if (drawingMode) {
    const indColor = DRAW_COLORS[drawColorIdx]
    ctx.save()
    ctx.font         = `600 11px Inter, system-ui, sans-serif`
    ctx.textBaseline = 'top'
    ctx.textAlign    = 'left'
    const label      = '✏  DRAW  [D] exit  [C] color  [R] clear'
    const lw         = ctx.measureText(label).width
    drawRoundRect(ctx, 10, 10, lw + 20, 26, 6)
    ctx.fillStyle = 'rgba(3,7,18,0.82)'
    ctx.fill()
    drawRoundRect(ctx, 10, 10, lw + 20, 26, 6)
    ctx.strokeStyle = indColor
    ctx.lineWidth   = 1.5
    ctx.stroke()
    ctx.fillStyle = indColor
    ctx.fillText(label, 20, 17)
    ctx.restore()
  }
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// demoparser2 returns display names ("Butterfly Knife") not internal names ("knife_butterfly")
const WEAPON_ICON_MAP = {
  // Pistols
  'Glock-18': 'glock', 'P2000': 'p2000', 'USP-S': 'usp_silencer',
  'Dual Berettas': 'elite', 'P250': 'p250', 'Five-SeveN': 'fiveseven',
  'Tec-9': 'tec9', 'CZ75-Auto': 'cz75a', 'Desert Eagle': 'deagle',
  'R8 Revolver': 'revolver',
  // Rifles
  'AK-47': 'ak47', 'Galil AR': 'galilar', 'FAMAS': 'famas',
  'M4A4': 'm4a1', 'M4A1-S': 'm4a1_silencer', 'AUG': 'aug',
  'SG 553': 'sg556', 'SSG 08': 'ssg08', 'AWP': 'awp',
  'G3SG1': 'g3sg1', 'SCAR-20': 'scar20',
  // SMGs
  'MAC-10': 'mac10', 'MP9': 'mp9', 'MP7': 'mp7', 'MP5-SD': 'mp5sd',
  'UMP-45': 'ump45', 'PP-Bizon': 'bizon', 'P90': 'p90',
  // Heavy
  'Nova': 'nova', 'XM1014': 'xm1014', 'Sawed-Off': 'sawedoff',
  'MAG-7': 'mag7', 'M249': 'm249', 'Negev': 'negev',
  // Grenades — display names (parser may send either form)
  'Smoke Grenade': 'smokegrenade', 'HE Grenade': 'hegrenade',
  'High Explosive Grenade': 'hegrenade',
  'Flashbang': 'flashbang', 'Flash Grenade': 'flashbang',
  'Molotov': 'molotov', 'Molotov Cocktail': 'molotov',
  'Incendiary Grenade': 'incgrenade', 'Decoy Grenade': 'decoy', 'Decoy': 'decoy',
  // Internal names (weapon_ prefix stripped)
  'smokegrenade': 'smokegrenade', 'hegrenade': 'hegrenade',
  'flashbang': 'flashbang', 'molotov': 'molotov',
  'incgrenade': 'incgrenade', 'decoy': 'decoy',
  // Equipment
  'Zeus x27': 'taser', 'C4': 'c4', 'C4 Explosive': 'c4',
  // Knives
  'Knife': 'knife', 'Bayonet': 'bayonet',
  'Butterfly Knife': 'knife_butterfly', 'Karambit': 'knife_karambit',
  'M9 Bayonet': 'knife_m9_bayonet', 'Flip Knife': 'knife_flip',
  'Gut Knife': 'knife_gut', 'Falchion Knife': 'knife_falchion',
  'Bowie Knife': 'knife_bowie', 'Shadow Daggers': 'knife_push',
  'Huntsman Knife': 'knife_tactical', 'Stiletto Knife': 'knife_stiletto',
  'Skeleton Knife': 'knife_skeleton', 'Ursus Knife': 'knife_ursus',
  'Talon Knife': 'knife_tactical', 'Paracord Knife': 'knife_cord',
  'Navaja Knife': 'knife_gypsy_jackknife', 'Classic Knife': 'knife_css',
  'Nomad Knife': 'knife_outdoor', 'Survival Knife': 'knife_outdoor',
  'Kukri Knife': 'knife',
  // Internal names (weapon_ stripped) — fallback for any old parsed demos
  'm4a4': 'm4a1', 'knifegg': 'knife', 'hkp2000': 'hkp2000',
}

const WEAPON_CANVAS_ICONS = {}
new Set(Object.values(WEAPON_ICON_MAP)).forEach(name => {
  const img = new Image()
  img.src = `images/weapons/${name}.svg`
  WEAPON_CANVAS_ICONS[name] = img
})

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
      </div>
      <div class="util-row">
        <div class="util-pill smoke${p.has_smoke   ? '' : ' empty'}"><img src="images/weapons/smokegrenade.svg" alt="smoke"></div>
        <div class="util-pill flash${p.has_flash   ? '' : ' empty'}"><img src="images/weapons/flashbang.svg" alt="flash"></div>
        <div class="util-pill molotov${p.has_molotov ? '' : ' empty'}"><img src="images/weapons/molotov.svg" alt="molotov"></div>
        <div class="util-pill he${p.has_he         ? '' : ' empty'}"><img src="images/weapons/hegrenade.svg" alt="he"></div>
      </div>
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

function updateKillFeed() {
  const frame = getFrame(state.tick)
  if (!frame || frame.tick === _lastKillTick) return
  _lastKillTick = frame.tick

  const round = currentRound()
  const kills = state.match.kills.filter(k =>
    k.tick >= round.start_tick && k.tick <= state.tick
  )
  const recent = kills.slice(-5).reverse()

  const el = document.getElementById('killfeed')
  if (!el) return

  el.innerHTML = recent.map((k, i) => {
    const killerName = k.killer_name ?? 'World'
    const killerTeam = (k.killer_team ?? 't').toLowerCase()
    const victimTeam = (k.victim_team ?? 'ct').toLowerCase()
    const borderCls  = killerTeam === 'ct' ? 'ct-kill' : 't-kill'
    const fadeCls    = i >= 2 ? ' faded' : ''
    const hs         = k.headshot === true ? `<span class="kf-hs">HS</span>` : ''
    const wRaw       = (k.weapon || '').replace('weapon_', '')
    const wIcon      = WEAPON_ICON_MAP[wRaw] ?? wRaw
    const wIconEl    = wRaw
      ? `<img src="images/weapons/${esc(wIcon)}.svg" class="kf-weapon-icon" onerror="this.style.display='none'">`
      : ''
    return `<div class="kf-row ${borderCls}${fadeCls}">
  <div class="kf-names">
    <span class="kf-killer ${killerTeam}">${esc(killerName)}</span>
    <span class="kf-arrow">›</span>
    <span class="kf-victim ${victimTeam}">${esc(k.victim_name)}</span>
  </div>
  <div class="kf-meta">${wIconEl}${hs}</div>
</div>`
  }).join('')
}

function updateMatchHeader() {
  const ctScore = state.match.rounds.slice(0, state.roundIdx).filter(r => r.winner_side === 'ct').length
  const tScore  = state.match.rounds.slice(0, state.roundIdx).filter(r => r.winner_side === 't').length
  const totalR  = state.match.rounds.length
  const mapEl   = document.getElementById('vh-map')
  const ctEl    = document.getElementById('vh-ct-score')
  const tEl     = document.getElementById('vh-t-score')
  const rndEl   = document.getElementById('vh-round')
  if (!mapEl) return
  mapEl.textContent = mapName.replace(/^de_/, '').toUpperCase()
  ctEl.textContent  = ctScore
  tEl.textContent   = tScore
  rndEl.textContent = `R${state.roundIdx + 1}/${totalR}`
}

function updateTimer() {
  const el = document.getElementById('vh-timer')
  if (!el) return
  const round    = currentRound()
  const tickRate = state.match.meta.tick_rate
  const fe       = freezeEnd(round)
  const elapsed  = Math.max(0, (state.tick - fe) / tickRate)

  let plantEvent = null, bombEnded = false
  for (const ev of state.match.bomb) {
    if (ev.tick < round.start_tick || ev.tick > state.tick) continue
    if (ev.type === 'planted')  plantEvent = ev
    if (ev.type === 'defused' || ev.type === 'exploded') bombEnded = true
  }

  let timeStr, cls
  if (plantEvent && !bombEnded) {
    const bombRemain = Math.max(0, 40 - (state.tick - plantEvent.tick) / tickRate)
    const remSec     = Math.ceil(bombRemain)
    timeStr = `0:${String(remSec).padStart(2, '0')}`
    cls     = bombRemain < 10 ? 'bomb-low' : 'bomb'
  } else {
    const remSec = Math.floor(Math.max(0, 115 - elapsed))
    timeStr = `${Math.floor(remSec / 60)}:${String(remSec % 60).padStart(2, '0')}`
    cls     = ''
  }
  el.textContent = timeStr
  el.className   = 'vh-timer' + (cls ? ' ' + cls : '')
}

// ── UI updates ────────────────────────────────────────────────
function updateRoundRow() {
  if (state.roundIdx === _lastRoundIdx) return
  _lastRoundIdx = state.roundIdx
  const rounds   = state.match.rounds
  const halfAt   = rounds.length > 12 ? 12 : -1
  const rowEl    = document.getElementById('round-row')
  let html = '<span class="round-row-label">Rounds</span>'
  for (let i = 0; i < rounds.length; i++) {
    if (i === halfAt) html += '<div class="round-halftime"></div>'
    const r   = rounds[i]
    const cls = i === state.roundIdx ? `${r.winner_side} current` : r.winner_side
    html += `<div class="round-sq ${cls}" title="Round ${i + 1}" data-ridx="${i}">${i + 1}</div>`
  }
  rowEl.innerHTML = html
  rowEl.querySelectorAll('.round-sq').forEach(el => {
    el.addEventListener('click', () => jumpToRound(Number(el.dataset.ridx)))
  })
  // Scroll current round into view
  const cur = rowEl.querySelector('.current')
  if (cur) cur.scrollIntoView({ inline: 'nearest', block: 'nearest' })
}

function updateTimelineKills() {
  const round  = currentRound()
  const fe     = freezeEnd(round)
  const span   = round.end_tick - fe
  const track  = document.getElementById('timeline-track')

  track.querySelectorAll('.tl-kill-mark').forEach(el => el.remove())
  if (span <= 0) return

  // Kill marks: CT in top half, T in bottom half
  for (const k of state.match.kills) {
    if (k.tick < round.start_tick || k.tick > round.end_tick) continue
    const pct = ((k.tick - fe) / span) * 100
    if (pct < 0 || pct > 100) continue
    const el = document.createElement('div')
    el.className = `tl-kill-mark ${k.killer_team?.toLowerCase() === 'ct' ? 'ct' : 't'}`
    el.style.left = pct + '%'
    track.appendChild(el)
  }

  // Bomb plant marks: full height, red
  for (const ev of state.match.bomb) {
    if (ev.type !== 'planted') continue
    if (ev.tick < round.start_tick || ev.tick > round.end_tick) continue
    const pct = ((ev.tick - fe) / span) * 100
    if (pct < 0 || pct > 100) continue
    const el = document.createElement('div')
    el.className = 'tl-kill-mark bomb'
    el.style.left = pct + '%'
    track.appendChild(el)
  }
}

function updateTimeline() {
  const round   = currentRound()
  const fe      = freezeEnd(round)
  const span    = round.end_tick - fe
  const pct     = span > 0 ? ((state.tick - fe) / span) * 100 : 0
  const clamped = Math.max(0, Math.min(100, pct))

  document.getElementById('timeline-fill').style.width = clamped + '%'
  document.getElementById('timeline-scrub').style.left = clamped + '%'
  document.getElementById('timeline-thumb').style.left = clamped + '%'

  const tickRate = state.match.meta.tick_rate
  const elapsed  = Math.floor(Math.max(0, state.tick - fe) / tickRate)
  const total    = Math.floor(Math.max(0, span) / tickRate)
  const fmt = s  => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  document.getElementById('timeline-current').textContent = fmt(elapsed)
  document.getElementById('timeline-end').textContent     = fmt(total)
}

function updatePlayBtn() {
  document.getElementById('play-btn').textContent = state.playing ? '⏸' : '▶'
}

// ── Loop ──────────────────────────────────────────────────────
function loop(ts) {
  try {
    if (state.playing) {
      const dt        = ts - state.lastTs
      const ticksPerMs = (state.match.meta.tick_rate * state.speed) / 1000
      state.tick      += dt * ticksPerMs

      const round = currentRound()
      if (state.tick >= round.end_tick) {
        const nextIdx = state.roundIdx + 1
        if (nextIdx < state.match.rounds.length) {
          state.roundIdx = nextIdx
          state.tick     = freezeEnd(currentRound())
          updateRoundRow()
          updateTimelineKills()
        } else {
          state.tick    = round.end_tick
          state.playing = false
          updatePlayBtn()
        }
      }
    }
    state.lastTs = ts
    render()
    updateMatchHeader()
    updateTimer()
    updateRoundRow()
    updateTimeline()
    updatePlayerCards()
    updateKillFeed()
  } catch (e) {
    console.error('Viewer loop error:', e)
  }
  requestAnimationFrame(loop)
}

// ── Controls ──────────────────────────────────────────────────
document.getElementById('play-btn').addEventListener('click', () => {
  const round = currentRound()
  if (state.tick >= round.end_tick) state.tick = freezeEnd(round)
  state.playing = !state.playing
  updatePlayBtn()
})

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.speed = Number(btn.dataset.speed)
    document.querySelectorAll('.speed-btn').forEach(b =>
      b.classList.toggle('active', b === btn)
    )
  })
})

// ── Keyboard shortcuts ────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

  if (e.code === 'Space') {
    e.preventDefault()
    const round = currentRound()
    if (state.tick >= round.end_tick) state.tick = freezeEnd(round)
    state.playing = !state.playing
    updatePlayBtn()
    return
  }

  if (e.code === 'KeyD') {
    drawingMode = !drawingMode
    canvas.style.cursor = drawingMode ? 'crosshair' : ''
    return
  }
  if (e.code === 'KeyC' && drawingMode) {
    drawColorIdx = (drawColorIdx + 1) % DRAW_COLORS.length
    return
  }
  if (e.code === 'KeyR') {
    drawPaths    = []
    currentPath  = null
    return
  }
})

// ── Drawing mouse events ──────────────────────────────────────
function getMapPos(e) {
  const rect = canvas.getBoundingClientRect()
  const sx   = (e.clientX - rect.left) * (canvas.width  / rect.width)
  const sy   = (e.clientY - rect.top)  * (canvas.height / rect.height)
  return {
    x: (sx - canvas.width  / 2 - mapPanX) / mapZoom + canvas.width  / 2,
    y: (sy - canvas.height / 2 - mapPanY) / mapZoom + canvas.height / 2,
  }
}

canvas.addEventListener('mousedown', e => {
  if (!drawingMode) return
  currentPath = { color: DRAW_COLORS[drawColorIdx], points: [getMapPos(e)] }
})
canvas.addEventListener('mousemove', e => {
  if (!drawingMode || !currentPath) return
  currentPath.points.push(getMapPos(e))
})
canvas.addEventListener('mouseup', () => {
  if (!drawingMode || !currentPath) return
  if (currentPath.points.length > 1) drawPaths.push(currentPath)
  currentPath = null
})
canvas.addEventListener('mouseleave', () => {
  if (!drawingMode || !currentPath) return
  if (currentPath.points.length > 1) drawPaths.push(currentPath)
  currentPath = null
})

// ── Scroll zoom ───────────────────────────────────────────────
canvas.addEventListener('wheel', e => {
  e.preventDefault()
  const rect   = canvas.getBoundingClientRect()
  const scaleX = canvas.width  / rect.width
  const scaleY = canvas.height / rect.height
  const mouseX = (e.clientX - rect.left) * scaleX
  const mouseY = (e.clientY - rect.top)  * scaleY
  const { width: cw, height: ch } = canvas
  const factor  = e.deltaY < 0 ? 1.12 : (1 / 1.12)
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, mapZoom * factor))
  const ratio   = newZoom / mapZoom
  mapPanX = (mouseX - cw / 2) * (1 - ratio) + mapPanX * ratio
  mapPanY = (mouseY - ch / 2) * (1 - ratio) + mapPanY * ratio
  mapZoom = newZoom
  if (mapZoom <= ZOOM_MIN) { mapPanX = 0; mapPanY = 0 }
}, { passive: false })

canvas.addEventListener('dblclick', () => {
  mapZoom = 1; mapPanX = 0; mapPanY = 0
})

const track = document.getElementById('timeline-track')
let dragging = false
function seekFromEvent(e) {
  const { left, width } = track.getBoundingClientRect()
  const pct   = Math.max(0, Math.min(1, (e.clientX - left) / width))
  const round = currentRound()
  const fe    = freezeEnd(round)
  state.tick  = fe + pct * (round.end_tick - fe)
}
track.addEventListener('mousedown', e => { dragging = true; seekFromEvent(e) })
window.addEventListener('mousemove', e => { if (dragging) seekFromEvent(e) })
window.addEventListener('mouseup',   ()  => { dragging = false })

window.jumpToRound = jumpToRound

// ── Kick off ──────────────────────────────────────────────────
jumpToRound(0)
updateTimelineKills()
requestAnimationFrame(ts => { state.lastTs = ts; loop(ts) })
