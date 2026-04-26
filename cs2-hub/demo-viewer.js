import { requireAuth }   from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase }      from './supabase.js'
import { worldToCanvas } from './demo-map-data.js'

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

// ── Load ──────────────────────────────────────────────────────
const loadingEl = document.getElementById('viewer-loading')

const { data: demo, error } = await supabase
  .from('demos')
  .select('match_data,map,status')
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

let mapProcessed = null
mapImg     = new Image()
mapImg.src = `images/maps/${mapName}_radar.png`
mapImg.onload = () => {
  console.log('[viewer] radar loaded:', mapImg.src)
  const mc = document.createElement('canvas')
  mc.width = mc.height = 1024
  const mctx = mc.getContext('2d')
  mctx.filter = 'brightness(0.32) saturate(0.08) contrast(1.3)'
  mctx.drawImage(mapImg, 0, 0, 1024, 1024)
  mapProcessed = mc
  mapLoaded = true
}
mapImg.onerror = () => { console.warn('[viewer] radar 404:', mapImg.src); mapLoaded = true }

loadingEl.style.display = 'none'
document.getElementById('viewer-shell').style.display = 'flex'

// ── Canvas ────────────────────────────────────────────────────
const canvas = document.getElementById('map-canvas')
const ctx    = canvas.getContext('2d')
const wrap   = document.getElementById('map-canvas-wrap')

function resizeCanvas() {
  const { width, height } = wrap.getBoundingClientRect()
  const size = Math.min(width, height) - 16
  if (size < 10) return
  canvas.width  = size
  canvas.height = size
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
const NADE_COLOR = {
  smoke:   { stroke: 'rgba(210,215,220,0.55)', solid: '#C8CDD2' },
  molotov: { stroke: 'rgba(255,140,30,0.65)',  solid: '#FF8C1E' },
  flash:   { stroke: 'rgba(200,220,255,0.6)',  solid: '#C8DCFF' },
  he:      { stroke: 'rgba(255,210,40,0.7)',   solid: '#FFD228' },
}

function drawNadeIcon(gx, gy, type, alpha) {
  const nc = NADE_COLOR[type] ?? NADE_COLOR.he
  const r  = Math.max(3, Math.round(gx > 0 ? 4 : 4))  // fixed small icon
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.arc(gx, gy, r, 0, Math.PI * 2)
  ctx.fillStyle   = nc.solid
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth   = 1
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function renderGrenades(round, tick, cw, ch) {
  const tickRate   = state.match.meta.tick_rate
  const TRAJ_TICKS = { smoke: tickRate * 6, molotov: tickRate * 5, he: tickRate * 2, flash: tickRate * 1 }

  ctx.save()
  for (const g of state.match.grenades) {
    if (g.tick < round.start_tick || g.end_tick == null) continue

    const trajTicks = TRAJ_TICKS[g.type] ?? tickRate * 2
    const inFlight  = g.origin_tick != null && g.origin_tick <= tick && tick < g.tick
    const active    = g.tick <= tick && g.end_tick >= tick
    const showTraj  = g.tick <= tick && (tick - g.tick) < trajTicks
    if (!inFlight && !active && !showTraj) continue

    const { x, y } = worldToCanvas(g.x, g.y, mapName, cw, ch)
    const nc = NADE_COLOR[g.type] ?? NADE_COLOR.he

    // ── Trajectory line ─────────────────────────────────────
    if (g.origin_x != null && !(g.origin_x === 0 && g.origin_y === 0)) {
      const { x: ox, y: oy } = worldToCanvas(g.origin_x, g.origin_y, mapName, cw, ch)

      if (inFlight) {
        const duration = g.tick - g.origin_tick
        const progress = duration > 0 ? (tick - g.origin_tick) / duration : 1
        const fx = ox + (x - ox) * progress
        const fy = oy + (y - oy) * progress
        ctx.save()
        ctx.setLineDash([2, 4])
        ctx.strokeStyle = nc.stroke
        ctx.lineWidth   = 1.2
        ctx.globalAlpha = 0.7
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(fx, fy); ctx.stroke()
        ctx.restore()
        drawNadeIcon(fx, fy, g.type, 0.92)
        continue
      }

      if (showTraj) {
        const alpha = (1 - (tick - g.tick) / trajTicks) * 0.55
        ctx.save()
        ctx.setLineDash([2, 4])
        ctx.strokeStyle = nc.stroke
        ctx.lineWidth   = 1
        ctx.globalAlpha = alpha
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(x, y); ctx.stroke()
        ctx.restore()
      }
    }

    if (!active || (g.x === 0 && g.y === 0)) continue

    // ── Active effect ────────────────────────────────────────
    ctx.save()
    if (g.type === 'smoke') {
      const r   = cw * 0.026
      const rem = Math.ceil(Math.max(0, (g.end_tick - tick) / tickRate))
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r)
      grad.addColorStop(0,   'rgba(195,200,208,0.52)')
      grad.addColorStop(0.65,'rgba(175,180,188,0.38)')
      grad.addColorStop(1,   'rgba(155,160,168,0.04)')
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle   = grad
      ctx.strokeStyle = 'rgba(210,215,220,0.35)'
      ctx.lineWidth   = 1
      ctx.fill(); ctx.stroke()
      // Timer inside
      const fs = Math.max(9, Math.round(r * 0.52))
      ctx.font         = `700 ${fs}px monospace`
      ctx.fillStyle    = 'rgba(255,255,255,0.82)'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(rem, x, y)

    } else if (g.type === 'molotov') {
      const r     = cw * 0.020
      const pulse = 1 + Math.sin(tick / 4) * 0.05
      const rp    = r * pulse
      const rem   = Math.ceil(Math.max(0, (g.end_tick - tick) / tickRate))
      const grad  = ctx.createRadialGradient(x, y, 0, x, y, rp)
      grad.addColorStop(0,   'rgba(255,200,50,0.68)')
      grad.addColorStop(0.45,'rgba(255,110,20,0.50)')
      grad.addColorStop(1,   'rgba(200,40,0,0.06)')
      ctx.beginPath(); ctx.arc(x, y, rp, 0, Math.PI * 2)
      ctx.fillStyle   = grad
      ctx.strokeStyle = 'rgba(255,150,30,0.45)'
      ctx.lineWidth   = 1
      ctx.fill(); ctx.stroke()
      // Timer inside
      const fs = Math.max(9, Math.round(rp * 0.62))
      ctx.font         = `700 ${fs}px monospace`
      ctx.fillStyle    = 'rgba(255,255,255,0.9)'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(rem, x, y)

    } else if (g.type === 'flash') {
      const duration = g.end_tick - g.tick
      const progress = duration > 0 ? (tick - g.tick) / duration : 1
      const r        = cw * 0.018 * (1 - progress)
      if (r > 1) {
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r)
        grad.addColorStop(0,   `rgba(255,255,255,${0.85 * (1 - progress)})`)
        grad.addColorStop(0.55,`rgba(220,235,255,${0.4 * (1 - progress)})`)
        grad.addColorStop(1,   'rgba(200,220,255,0)')
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fillStyle = grad
        ctx.fill()
      }

    } else if (g.type === 'he') {
      const duration = g.end_tick - g.tick
      const progress = Math.min(1, duration > 0 ? (tick - g.tick) / duration : 1)
      const r        = cw * 0.012 * (1 + progress * 1.2)
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255,210,50,${0.85 * (1 - progress)})`
      ctx.lineWidth   = 2
      ctx.stroke()
      if (progress < 0.35) {
        ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,240,120,${0.55 * (1 - progress / 0.35)})`
        ctx.fill()
      }
    }
    ctx.restore()
  }
  ctx.restore()
}

// ── Bomb tracking ─────────────────────────────────────────────
function renderBomb(round, tick, cw, ch) {
  ctx.save()
  const tickRate = state.match.meta.tick_rate
  const fontSize = Math.round(cw * 0.018)
  let latest = null
  for (const event of state.match.bomb) {
    if (event.tick < round.start_tick || event.tick > tick) continue
    if (latest === null || event.tick > latest.tick) latest = event
  }
  if (!latest) { ctx.restore(); return }
  if (latest.x == null || latest.y == null) { ctx.restore(); return }
  const { x, y } = worldToCanvas(latest.x, latest.y, mapName, cw, ch)
  if (latest.type === 'planted') {
    const r = cw * 0.018 + Math.sin(tick / 8) * cw * 0.006
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,50,50,0.7)'
    ctx.fill()
    const seconds = Math.max(0, 40 - (tick - latest.tick) / tickRate)
    ctx.fillStyle    = '#fff'
    ctx.font         = `${fontSize}px sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(Math.ceil(seconds), x, y - r - 2)
  } else if (latest.type === 'defused') {
    ctx.beginPath()
    ctx.arc(x, y, cw * 0.018, 0, Math.PI * 2)
    ctx.fillStyle = '#4CAF50'
    ctx.fill()
  } else if (latest.type === 'exploded') {
    ctx.beginPath()
    ctx.arc(x, y, cw * 0.025, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,140,0,0.8)'
    ctx.fill()
  }
  ctx.restore()
}

// ── Shot beam ─────────────────────────────────────────────────
function renderShots(round, tick, frame, cw, ch) {
  const BEAM_DURATION = 5
  ctx.save()
  for (const shot of state.match.shots) {
    if (shot.tick < round.start_tick || shot.tick > tick || tick - shot.tick > BEAM_DURATION) continue
    const player = frame.players.find(p => p.steam_id === shot.steam_id)
    if (!player || !player.is_alive || player.yaw == null) continue
    const { x, y } = worldToCanvas(player.x, player.y, mapName, cw, ch)
    const age      = tick - shot.tick
    const alpha    = 1 - age / BEAM_DURATION
    const yawRad   = player.yaw * Math.PI / 180
    const { x: bx, y: by } = worldToCanvas(
      player.x + Math.cos(yawRad) * 400,
      player.y + Math.sin(yawRad) * 400,
      mapName, cw, ch
    )
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(bx, by)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth   = Math.max(0.5, 2 - age * 0.35)
    ctx.globalAlpha = alpha * 0.85
    ctx.stroke()
  }
  ctx.restore()
}

// ── Player rendering helpers ──────────────────────────────────
const CT_COLOR = '#4FC3F7'
const T_COLOR  = '#FF9500'

function playerColor(team) { return team === 'ct' ? CT_COLOR : T_COLOR }

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
  drawRoundRect(ctx, px, py, pw, ph, ph / 2)
  ctx.fillStyle   = color
  ctx.globalAlpha = 0.88
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.fillStyle    = '#fff'
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x, py + ph / 2)
  ctx.restore()
}

// ── Render ────────────────────────────────────────────────────
function render() {
  const { width: cw, height: ch } = canvas
  ctx.clearRect(0, 0, cw, ch)

  ctx.fillStyle = '#080a12'
  ctx.fillRect(0, 0, cw, ch)
  if (mapLoaded) {
    if (mapProcessed) {
      ctx.drawImage(mapProcessed, 0, 0, cw, ch)
      ctx.fillStyle = 'rgba(6,8,18,0.38)'
      ctx.fillRect(0, 0, cw, ch)
    }
  }

  const frame = getInterpolatedFrame(state.tick)
  if (!frame) return

  const dotR     = Math.round(cw * 0.0095)
  const pillFontSz = Math.round(cw * 0.016)
  const pillFont   = `600 ${pillFontSz}px sans-serif`

  const round = currentRound()
  renderGrenades(round, state.tick, cw, ch)
  renderBomb(round, state.tick, cw, ch)

  // Player icons: unified circle + integrated direction pointer
  for (const p of frame.players) {
    const { x, y } = worldToCanvas(p.x, p.y, mapName, cw, ch)

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

    const color = playerColor(p.team)

    if (p.yaw != null) {
      const yawRad = p.yaw * Math.PI / 180
      const { x: dirX, y: dirY } = worldToCanvas(
        p.x + Math.cos(yawRad) * 300,
        p.y + Math.sin(yawRad) * 300,
        mapName, cw, ch
      )
      const angle      = Math.atan2(dirY - y, dirX - x)
      const notchAngle = 22 * Math.PI / 180   // half-angle of the gap in the circle
      const tipDist    = dotR * 0.45          // how far the tip extends past the circle edge

      // Single path: arc the long way round + converge to tip
      ctx.save()
      ctx.beginPath()
      ctx.arc(x, y, dotR, angle + notchAngle, angle - notchAngle)  // clockwise long arc
      ctx.lineTo(x + Math.cos(angle) * (dotR + tipDist), y + Math.sin(angle) * (dotR + tipDist))
      ctx.closePath()
      ctx.fillStyle   = color
      ctx.strokeStyle = 'rgba(255,255,255,0.88)'
      ctx.lineWidth   = 1.5
      ctx.fill()
      ctx.stroke()
      // Inner white center
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

  // Pass 3: name pills (topmost)
  for (const p of frame.players) {
    if (!p.is_alive) continue
    const { x, y } = worldToCanvas(p.x, p.y, mapName, cw, ch)
    drawPlayerPill(x, y - dotR, p.name.slice(0, 13), playerColor(p.team), pillFont, pillFontSz)
  }

  renderShots(round, state.tick, frame, cw, ch)

  // ── Round timer pill — top center ──────────────────────────
  const tickRate = state.match.meta.tick_rate
  const fe       = freezeEnd(round)
  const elapsed  = Math.max(0, (state.tick - fe) / tickRate)

  let plantEvent = null, bombEnded = false
  for (const ev of state.match.bomb) {
    if (ev.tick < round.start_tick || ev.tick > state.tick) continue
    if (ev.type === 'planted')  plantEvent = ev
    if (ev.type === 'defused' || ev.type === 'exploded') bombEnded = true
  }

  let timeStr, timerColor
  if (plantEvent && !bombEnded) {
    const bombRemain = Math.max(0, 40 - (state.tick - plantEvent.tick) / tickRate)
    const remSec     = Math.ceil(bombRemain)
    timeStr    = `0:${String(remSec).padStart(2, '0')}`
    timerColor = bombRemain < 10 ? '#FF5252' : '#FFB74D'
  } else {
    const remSec = Math.floor(Math.max(0, 115 - elapsed))
    timeStr    = `${Math.floor(remSec / 60)}:${String(remSec % 60).padStart(2, '0')}`
    timerColor = '#ffffff'
  }

  const tFontSz = Math.round(cw * 0.036)
  ctx.save()
  ctx.font      = `700 ${tFontSz}px "SF Mono", "Consolas", monospace`
  ctx.textAlign = 'center'
  const tw      = ctx.measureText(timeStr).width
  const pillW   = tw + 28
  const pillH   = tFontSz + 14
  const pillX   = cw / 2 - pillW / 2
  const pillY   = 10
  // Pill background
  drawRoundRect(ctx, pillX, pillY, pillW, pillH, pillH / 2)
  ctx.fillStyle   = 'rgba(8,8,12,0.78)'
  ctx.fill()
  drawRoundRect(ctx, pillX, pillY, pillW, pillH, pillH / 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth   = 1
  ctx.stroke()
  // Timer text
  ctx.fillStyle    = timerColor
  ctx.textBaseline = 'middle'
  ctx.fillText(timeStr, cw / 2, pillY + pillH / 2)

  // Score below timer
  const ctScore    = state.match.rounds.slice(0, state.roundIdx).filter(r => r.winner_side === 'ct').length
  const tScore     = state.match.rounds.slice(0, state.roundIdx).filter(r => r.winner_side === 't').length
  const scoreFontSz = Math.round(cw * 0.020)
  ctx.font         = `700 ${scoreFontSz}px sans-serif`
  ctx.textBaseline = 'top'
  const scoreY     = pillY + pillH + 4
  const gap        = scoreFontSz * 1.1
  ctx.textAlign    = 'right'
  ctx.fillStyle    = CT_COLOR
  ctx.fillText(String(ctScore), cw / 2 - 5, scoreY)
  ctx.textAlign    = 'center'
  ctx.fillStyle    = 'rgba(255,255,255,0.3)'
  ctx.fillText('–', cw / 2, scoreY)
  ctx.textAlign    = 'left'
  ctx.fillStyle    = T_COLOR
  ctx.fillText(String(tScore), cw / 2 + 5, scoreY)
  ctx.restore()
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

const WEAPON_ICON_BASE = 'https://raw.githubusercontent.com/nicklvsa/csgo-weapon-icons/main/renders/'
const WEAPON_ABBREV = {
  ak47:'AK-47', m4a1_silencer:'M4A1-S', m4a4:'M4A4', awp:'AWP', deagle:'Deagle',
  glock:'Glock', usp_silencer:'USP-S', p250:'P250', fiveseven:'Five-SeveN',
  tec9:'Tec-9', cz75a:'CZ75', mp9:'MP9', mac10:'MAC-10', mp5sd:'MP5-SD',
  ump45:'UMP-45', p90:'P90', bizon:'PP-Bizon', famas:'FAMAS', galil:'Galil',
  sg556:'SG 556', aug:'AUG', ssg08:'Scout', g3sg1:'G3SG1', scar20:'SCAR-20',
  m249:'M249', negev:'Negev', nova:'Nova', xm1014:'XM1014', mag7:'MAG-7',
  sawedoff:'Sawed-Off', mp7:'MP7', smokegrenade:'Smoke', flashbang:'Flash',
  hegrenade:'HE', molotov:'Molotov', incgrenade:'Molotov', decoy:'Decoy',
  knife:'Knife', knife_t:'Knife',
}

function weaponImgHTML(raw) {
  const key  = (raw || '').replace('weapon_', '')
  const abbr = WEAPON_ABBREV[key] || key.replace(/_/g, ' ').toUpperCase().slice(0, 10)
  const url  = `${WEAPON_ICON_BASE}${key}.png`
  return `<img src="${url}" alt="${esc(abbr)}" title="${esc(abbr)}"
    style="height:14px;object-fit:contain;max-width:60px;opacity:0.85;filter:brightness(1.1)"
    onerror="this.style.display='none';this.nextSibling.style.display='inline'"
  /><span style="display:none;font-size:9px;color:var(--text-secondary)">${esc(abbr)}</span>`
}

function playerCardHTML(p) {
  const hpPct = p.is_alive ? Math.max(0, Math.min(100, p.hp)) : 0
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
      <span style="display:flex;align-items:center">${weaponImgHTML(p.weapon)}</span>
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
    const killerTeam = k.killer_team ?? 't'
    const borderCls = killerTeam === 'ct' ? 'ct-kill' : 't-kill'
    const fadeCls   = i >= 2 ? ' faded' : ''
    const hs        = k.headshot === true ? `<span class="kf-hs">HS</span>` : ''
    const weapon    = esc(k.weapon || '')
    return `<div class="kf-row ${borderCls}${fadeCls}">
  <div class="kf-names">
    <span class="kf-killer ${killerTeam}">${esc(killerName)}</span>
    →
    <span class="kf-victim ${k.victim_team}">${esc(k.victim_name)}</span>
  </div>
  <div class="kf-meta">
    <span>${weapon}</span>${hs}
  </div>
</div>`
  }).join('')
}

// ── UI updates ────────────────────────────────────────────────
function updateRoundRow() {
  if (state.roundIdx === _lastRoundIdx) return
  _lastRoundIdx = state.roundIdx
  const rounds   = state.match.rounds
  const halfAt   = rounds.length >= 16 ? Math.ceil(rounds.length / 2) : -1
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
  const round    = currentRound()
  const fe       = freezeEnd(round)
  const span     = round.end_tick - fe
  const track    = document.getElementById('timeline-track')
  // Remove old markers
  track.querySelectorAll('.tl-kill-mark').forEach(el => el.remove())
  if (span <= 0) return
  for (const k of state.match.kills) {
    if (k.tick < round.start_tick || k.tick > round.end_tick) continue
    const pct = ((k.tick - fe) / span) * 100
    if (pct < 0 || pct > 100) continue
    const el = document.createElement('div')
    el.className = `tl-kill-mark ${k.killer_team === 'ct' ? 'ct' : 't'}`
    el.style.left = pct + '%'
    track.appendChild(el)
  }
}

function updateTimeline() {
  const round    = currentRound()
  const fe       = freezeEnd(round)
  const span     = round.end_tick - fe
  const pct      = span > 0 ? ((state.tick - fe) / span) * 100 : 0
  const clamped  = Math.max(0, Math.min(100, pct))
  document.getElementById('timeline-fill').style.width = clamped + '%'
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
