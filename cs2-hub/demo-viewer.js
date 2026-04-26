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
console.log('[viewer] map:', mapName, '| rounds:', state.match.rounds.length, '| frames:', state.match.frames.length)

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

function jumpToRound(idx) {
  state.roundIdx  = Math.max(0, Math.min(idx, state.match.rounds.length - 1))
  state.tick      = currentRound().start_tick
  state.playing   = false
  _lastFrameTick  = -1
  _lastRoundIdx   = -1
  _lastKillTick   = -1
  updatePlayBtn()
  updateRoundTracker()
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


// ── Grenade overlays ──────────────────────────────────────────
function renderGrenades(round, tick, cw, ch) {
  ctx.save()
  for (const g of state.match.grenades) {
    if (g.tick < round.start_tick) continue
    if (g.tick > tick || g.end_tick < tick) continue
    if (g.x === 0 && g.y === 0) continue
    if (g.end_tick == null) continue
    const { x, y } = worldToCanvas(g.x, g.y, mapName, cw, ch)
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
    const seconds = Math.max(0, (latest.tick + 5120 - tick) / tickRate)
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

  const frame = getFrame(state.tick)
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

    if (p.is_alive) {
      ctx.fillStyle    = '#fff'
      ctx.font         = `${fontSize}px sans-serif`
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(p.name.slice(0, 10), x, y + dotR + 2)
    }
  }
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
function updateRoundTracker() {
  const rounds = state.match.rounds
  document.getElementById('round-num').textContent   = state.roundIdx + 1
  document.getElementById('round-total').textContent = rounds.length
  if (state.roundIdx === _lastRoundIdx) return
  _lastRoundIdx = state.roundIdx
  document.getElementById('round-squares').innerHTML = rounds.map((r, i) => {
    const cls = i < state.roundIdx
      ? r.winner_side
      : i === state.roundIdx
        ? `${r.winner_side} current`
        : 'unplayed'
    return `<div class="round-sq ${cls}" title="Round ${i + 1}" onclick="jumpToRound(${i})"></div>`
  }).join('')
}

function updateTimeline() {
  const round    = currentRound()
  const span     = round.end_tick - round.start_tick
  const pct      = span > 0 ? ((state.tick - round.start_tick) / span) * 100 : 0
  const clamped  = Math.max(0, Math.min(100, pct))
  document.getElementById('timeline-fill').style.width = clamped + '%'
  document.getElementById('timeline-thumb').style.left = clamped + '%'

  const tickRate = state.match.meta.tick_rate
  const elapsed  = Math.floor(Math.max(0, state.tick - round.start_tick) / tickRate)
  const total    = Math.floor(span / tickRate)
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
          state.tick     = currentRound().start_tick
        } else {
          state.tick    = round.end_tick
          state.playing = false
          updatePlayBtn()
        }
      }
    }
    state.lastTs = ts
    render()
    updateRoundTracker()
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
  if (state.tick >= round.end_tick) state.tick = round.start_tick
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
  state.tick  = round.start_tick + pct * (round.end_tick - round.start_tick)
}
track.addEventListener('mousedown', e => { dragging = true; seekFromEvent(e) })
window.addEventListener('mousemove', e => { if (dragging) seekFromEvent(e) })
window.addEventListener('mouseup',   ()  => { dragging = false })

window.jumpToRound = jumpToRound

// ── Kick off ──────────────────────────────────────────────────
jumpToRound(0)
requestAnimationFrame(ts => { state.lastTs = ts; loop(ts) })
