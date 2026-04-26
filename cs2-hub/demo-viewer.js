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

mapImg     = new Image()
mapImg.src = `images/maps/${mapName}_radar.png`
mapImg.onload  = () => { console.log('[viewer] radar loaded:', mapImg.src); mapLoaded = true }
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
function renderGrenades(round, tick, cw, ch) {
  ctx.save()
  for (const g of state.match.grenades) {
    if (g.tick < round.start_tick) continue
    if (g.end_tick == null) continue

    const tickRate   = state.match.meta.tick_rate
    const TRAJ_TICKS = { smoke: tickRate * 7, molotov: tickRate * 6, he: tickRate * 2, flash: tickRate * 1 }
    const trajTicks  = TRAJ_TICKS[g.type] ?? tickRate * 3

    const inFlight  = g.origin_tick != null && g.origin_tick <= tick && tick < g.tick
    const active    = g.tick <= tick && g.end_tick >= tick
    const showTraj  = g.tick <= tick && (tick - g.tick) < trajTicks
    if (!inFlight && !active && !showTraj) continue

    const { x, y } = worldToCanvas(g.x, g.y, mapName, cw, ch)
    const typeColor = g.type === 'smoke'   ? 'rgba(200,200,200,0.6)'
                    : g.type === 'molotov' ? 'rgba(255,140,0,0.6)'
                    : g.type === 'flash'   ? 'rgba(255,255,255,0.5)'
                    :                        'rgba(255,220,0,0.6)'

    // Trajectory: animated during flight, fading static line after landing
    if (g.origin_x != null && !(g.origin_x === 0 && g.origin_y === 0)) {
      const { x: ox, y: oy } = worldToCanvas(g.origin_x, g.origin_y, mapName, cw, ch)
      ctx.save()
      ctx.setLineDash([3, 5])
      ctx.lineWidth = 1.5

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
      } else if (showTraj) {
        const alpha = 1 - (tick - g.tick) / trajTicks
        ctx.strokeStyle = typeColor
        ctx.globalAlpha = alpha * 0.65
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(x, y); ctx.stroke()
      }
      ctx.restore()
    }

    if (!active) continue

    if (g.x === 0 && g.y === 0) continue
    if (g.type === 'smoke') {
      ctx.beginPath()
      const r = cw * 0.055
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle   = 'rgba(180,180,180,0.35)'
      ctx.strokeStyle = 'rgba(200,200,200,0.5)'
      ctx.lineWidth   = 1.5
      ctx.fill()
      ctx.stroke()
    } else if (g.type === 'molotov') {
      ctx.beginPath()
      const r = cw * 0.04
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle   = 'rgba(255,100,0,0.3)'
      ctx.strokeStyle = 'rgba(255,140,0,0.6)'
      ctx.lineWidth   = 1.5
      ctx.fill()
      ctx.stroke()
    } else if (g.type === 'flash') {
      const duration = g.end_tick - g.tick
      const progress = duration > 0 ? (tick - g.tick) / duration : 1
      const r = cw * 0.03 * (1 - progress)
      if (r > 0) {
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.fill()
      }
    } else if (g.type === 'he') {
      ctx.beginPath()
      const r = cw * 0.025
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,220,0,0.7)'
      ctx.lineWidth   = 2
      ctx.stroke()
    }
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

// ── Render ────────────────────────────────────────────────────
function render() {
  const { width: cw, height: ch } = canvas
  ctx.clearRect(0, 0, cw, ch)

  if (mapLoaded && mapImg.complete && mapImg.naturalWidth) {
    ctx.drawImage(mapImg, 0, 0, cw, ch)
  } else {
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, cw, ch)
  }

  const frame = getInterpolatedFrame(state.tick)
  if (!frame) return

  const dotR     = Math.round(cw * 0.012)
  const fontSize = Math.round(cw * 0.018)

  const round = currentRound()
  renderGrenades(round, state.tick, cw, ch)
  renderBomb(round, state.tick, cw, ch)

  for (const p of frame.players) {
    const { x, y } = worldToCanvas(p.x, p.y, mapName, cw, ch)

    ctx.beginPath()
    ctx.arc(x, y, dotR, 0, Math.PI * 2)
    if (!p.is_alive) {
      ctx.globalAlpha = 0.3
      ctx.fillStyle   = '#888'
    } else {
      ctx.fillStyle = p.team === 'ct' ? '#4FC3F7' : '#EF5350'
    }
    ctx.strokeStyle = '#fff'
    ctx.lineWidth   = 1.5
    ctx.fill()
    ctx.stroke()
    ctx.globalAlpha = 1

    if (p.is_alive && p.yaw != null) {
      const yawRad = p.yaw * Math.PI / 180
      const dist = 120  // world units
      const { x: tx, y: ty } = worldToCanvas(
        p.x + Math.cos(yawRad) * dist,
        p.y + Math.sin(yawRad) * dist,
        mapName, cw, ch
      )
      ctx.save()
      ctx.strokeStyle = p.team === 'ct' ? '#4FC3F7' : '#EF5350'
      ctx.lineWidth = 1.5
      ctx.globalAlpha = 0.8
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(tx, ty)
      ctx.stroke()
      ctx.restore()
    }

    if (p.is_alive) {
      ctx.fillStyle    = '#fff'
      ctx.font         = `${fontSize}px sans-serif`
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(p.name.slice(0, 10), x, y + dotR + 2)
    }
  }

  renderShots(round, state.tick, frame, cw, ch)

  // Round timer overlay — top center
  const tickRate = state.match.meta.tick_rate
  const fe       = freezeEnd(round)
  const elapsed  = Math.max(0, (state.tick - fe) / tickRate)

  // Check for active bomb plant (no subsequent defuse/explode yet)
  let plantEvent = null
  let bombEnded  = false
  for (const ev of state.match.bomb) {
    if (ev.tick < round.start_tick || ev.tick > state.tick) continue
    if (ev.type === 'planted')  plantEvent = ev
    if (ev.type === 'defused' || ev.type === 'exploded') bombEnded = true
  }

  let timeStr, timerColor
  if (plantEvent && !bombEnded) {
    const bombElapsed  = Math.max(0, (state.tick - plantEvent.tick) / tickRate)
    const bombRemain   = Math.max(0, 40 - bombElapsed)
    const remSec       = Math.ceil(bombRemain)
    timeStr   = `0:${String(remSec).padStart(2, '0')}`
    timerColor = bombRemain < 10 ? '#FF5252' : '#FFB74D'
  } else {
    const remain = Math.max(0, 115 - elapsed)
    const remSec = Math.floor(remain)
    timeStr   = `${Math.floor(remSec / 60)}:${String(remSec % 60).padStart(2, '0')}`
    timerColor = '#ffffff'
  }

  const tFontSz = Math.round(cw * 0.042)
  ctx.save()
  ctx.font         = `700 ${tFontSz}px "SF Mono", "Consolas", monospace`
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle    = 'rgba(0,0,0,0.55)'
  ctx.fillText(timeStr, cw / 2 + 1, 11)
  ctx.fillStyle = timerColor
  ctx.fillText(timeStr, cw / 2, 10)
  ctx.restore()
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

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
