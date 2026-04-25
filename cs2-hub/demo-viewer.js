import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'
import { worldToCanvas } from './demo-map-data.js'

await requireAuth()
renderSidebar('demos')

const params  = new URLSearchParams(location.search)
const demoId  = params.get('id')
if (!demoId) { location.href = 'demos.html'; throw new Error('no id') }

// ── State ────────────────────────────────────────────────
const state = {
  match:    null,
  playing:  false,
  tick:     0,
  speed:    1,
  lastTs:   0,
  roundIdx: 0,
}
let mapImg    = null
let mapLoaded = false

// ── Load data ────────────────────────────────────────────
const { data: demo, error } = await supabase
  .from('demos')
  .select('match_data,map,opponent_name,played_at,score_ct,score_t,status')
  .eq('id', demoId)
  .single()

if (error || !demo || demo.status !== 'ready') {
  document.getElementById('viewer-loading').textContent =
    demo?.status === 'processing' ? 'Demo is still processing…' :
    demo?.status === 'error'      ? 'Demo processing failed.' :
    'Demo not found.'
  throw new Error('not ready')
}

state.match = demo.match_data
document.title = `${demo.opponent_name ?? 'Demo'} — ${demo.map ?? ''} — MIDROUND`

// Load map image
mapImg = new Image()
mapImg.src = `images/maps/${demo.map}_radar.png`
mapImg.onload  = () => { mapLoaded = true }
mapImg.onerror = () => { mapLoaded = true }

// Show UI
document.getElementById('viewer-loading').style.display = 'none'
document.getElementById('viewer-shell').style.display = 'flex'

// ── Canvas setup ──────────────────────────────────────────
const canvas = document.getElementById('map-canvas')
const ctx     = canvas.getContext('2d')
const wrap    = document.getElementById('map-canvas-wrap')

function resizeCanvas() {
  const { width, height } = wrap.getBoundingClientRect()
  const size = Math.min(width, height) - 16
  canvas.width  = size
  canvas.height = size
}
resizeCanvas()
new ResizeObserver(resizeCanvas).observe(wrap)

// ── Round helpers ─────────────────────────────────────────
function currentRound() { return state.match.rounds[state.roundIdx] }

function jumpToRound(idx) {
  state.roundIdx = Math.max(0, Math.min(idx, state.match.rounds.length - 1))
  state.tick     = currentRound().start_tick
  state.playing  = false
  updatePlayBtn()
  updateRoundTracker()
}

// ── Frame lookup (binary search) ─────────────────────────
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

// ── Canvas render ─────────────────────────────────────────
function render() {
  const { width: cw, height: ch } = canvas
  const map = state.match.meta.map
  ctx.clearRect(0, 0, cw, ch)

  if (mapLoaded && mapImg.complete && mapImg.naturalWidth) {
    ctx.drawImage(mapImg, 0, 0, cw, ch)
  } else {
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, cw, ch)
  }

  const tick     = state.tick
  const tickRate = state.match.meta.tick_rate

  // Grenade blasts (show for 2 seconds around detonation tick)
  const NADE_DURATION = tickRate * 2
  for (const g of state.match.grenades) {
    if (tick < g.tick || tick > g.tick + NADE_DURATION) continue
    const { x, y } = worldToCanvas(g.x, g.y, map, cw, ch)
    const alpha = 1 - (tick - g.tick) / NADE_DURATION
    ctx.globalAlpha = alpha * 0.7
    ctx.beginPath()
    ctx.arc(x, y, 14, 0, Math.PI * 2)
    ctx.fillStyle = { smoke: '#aaa', flash: '#ffe', molotov: '#f60', he: '#fc0' }[g.type] ?? '#fff'
    ctx.fill()
    ctx.globalAlpha = 1
  }

  // Kill markers (show for 3 seconds, fade out)
  const KILL_DURATION = tickRate * 3
  for (const k of state.match.kills) {
    if (tick < k.tick || tick > k.tick + KILL_DURATION) continue
    const { x, y } = worldToCanvas(k.victim_x, k.victim_y, map, cw, ch)
    const age = (tick - k.tick) / KILL_DURATION
    ctx.globalAlpha = 1 - age
    ctx.fillStyle = '#ff4444'
    ctx.font = `bold ${Math.round(cw * 0.025)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('✕', x, y)
    ctx.globalAlpha = 1
  }

  // Players
  const frame = getFrame(tick)
  if (!frame) return
  const dotR = Math.round(cw * 0.012)
  for (const p of frame.players) {
    const { x, y } = worldToCanvas(p.x, p.y, map, cw, ch)
    ctx.beginPath()
    ctx.arc(x, y, dotR, 0, Math.PI * 2)
    if (!p.is_alive) {
      ctx.globalAlpha = 0.3
      ctx.fillStyle = '#888'
    } else {
      ctx.fillStyle = p.team === 'ct' ? '#4FC3F7' : '#EF5350'
    }
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.fill()
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

// ── UI updates ────────────────────────────────────────────
function buildPlayerCards() {
  const frame = getFrame(state.tick)
  if (!frame) return

  const ct = frame.players.filter(p => p.team === 'ct')
  const t  = frame.players.filter(p => p.team === 't')

  const killMap  = {}
  const deathMap = {}
  for (const k of state.match.kills) {
    if (k.tick > state.tick) continue
    killMap[k.killer_id]  = (killMap[k.killer_id]  ?? 0) + 1
    deathMap[k.victim_id] = (deathMap[k.victim_id] ?? 0) + 1
  }

  function cardHtml(p) {
    const k = killMap[p.steam_id]  ?? 0
    const d = deathMap[p.steam_id] ?? 0
    const hpPct  = Math.max(0, Math.min(100, p.hp))
    const hpColor = hpPct > 50 ? '#4CAF50' : hpPct > 25 ? '#FFC107' : '#EF5350'
    return `
      <div class="player-card ${p.team}${p.is_alive ? '' : ' dead'}">
        <div class="player-card-name">${esc(p.name)}</div>
        <div class="player-card-kd">${k}/${d}</div>
        <div class="player-card-weapon">${esc(p.weapon.replace('weapon_', ''))}</div>
        <div class="player-card-money">$${p.money.toLocaleString()}</div>
        <div class="player-card-hp" style="width:${hpPct}%;background:${hpColor}"></div>
      </div>`
  }

  const meta = state.match.meta
  document.getElementById('player-cards').innerHTML =
    ct.map(cardHtml).join('') +
    `<div class="score-card">
       <div class="score-ct">${meta.ct_score}</div>
       <div class="score-vs">vs</div>
       <div class="score-t">${meta.t_score}</div>
     </div>` +
    t.map(cardHtml).join('')
}

function updateRoundTracker() {
  const rounds = state.match.rounds
  document.getElementById('round-num').textContent   = state.roundIdx + 1
  document.getElementById('round-total').textContent = rounds.length

  document.getElementById('round-squares').innerHTML = rounds.map((r, i) => {
    const cls = i < state.roundIdx ? r.winner_side : i === state.roundIdx ? `${r.winner_side} current` : 'unplayed'
    return `<div class="round-sq ${cls}" title="Round ${i+1}" onclick="jumpToRound(${i})"></div>`
  }).join('')
}

function updateKillFeed() {
  const tick     = state.tick
  const tickRate = state.match.meta.tick_rate
  const recent = state.match.kills
    .filter(k => tick - k.tick >= 0 && tick - k.tick < tickRate * 8)
    .slice(-5)
    .reverse()

  document.getElementById('kill-feed-rows').innerHTML = recent.map(k =>
    `<div class="kill-row">
       <span class="kname">${esc(k.killer_name)}</span>
       <span>→</span>
       <span class="vname">${esc(k.victim_name)}</span>
       <span class="kweapon">${esc(k.weapon.replace('weapon_',''))}${k.headshot ? ' hs' : ''}</span>
     </div>`
  ).join('')
}

function updateTimeline() {
  const round = currentRound()
  const span  = round.end_tick - round.start_tick
  const pct   = span > 0 ? ((state.tick - round.start_tick) / span) * 100 : 0
  const clamped = Math.max(0, Math.min(100, pct))
  document.getElementById('timeline-fill').style.width = clamped + '%'
  document.getElementById('timeline-thumb').style.left = clamped + '%'

  const tickRate = state.match.meta.tick_rate
  const elapsed  = Math.floor((state.tick - round.start_tick) / tickRate)
  const total    = Math.floor(span / tickRate)
  const fmt = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`
  document.getElementById('timeline-current').textContent = fmt(elapsed)
  document.getElementById('timeline-end').textContent     = fmt(total)
}

function updatePlayBtn() {
  document.getElementById('play-btn').textContent = state.playing ? '⏸' : '▶'
}

// ── Animation loop ────────────────────────────────────────
function loop(ts) {
  if (state.playing) {
    const dt         = ts - state.lastTs
    const ticksPerMs = (state.match.meta.tick_rate * state.speed) / 1000
    state.tick       = state.tick + dt * ticksPerMs

    const round = currentRound()
    if (state.tick >= round.end_tick) {
      state.tick    = round.end_tick
      state.playing = false
      updatePlayBtn()
    }
  }
  state.lastTs = ts

  render()
  buildPlayerCards()
  updateRoundTracker()
  updateKillFeed()
  updateTimeline()

  requestAnimationFrame(loop)
}

// ── Controls ──────────────────────────────────────────────
document.getElementById('play-btn').addEventListener('click', () => {
  const round = currentRound()
  if (state.tick >= round.end_tick) state.tick = round.start_tick
  state.playing = !state.playing
  updatePlayBtn()
})

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.speed = Number(btn.dataset.speed)
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', b === btn))
  })
})

const track = document.getElementById('timeline-track')
function seekFromEvent(e) {
  const { left, width } = track.getBoundingClientRect()
  const pct   = Math.max(0, Math.min(1, (e.clientX - left) / width))
  const round = currentRound()
  state.tick  = round.start_tick + pct * (round.end_tick - round.start_tick)
}
let dragging = false
track.addEventListener('mousedown', e => { dragging = true; seekFromEvent(e) })
window.addEventListener('mousemove', e => { if (dragging) seekFromEvent(e) })
window.addEventListener('mouseup',   () => { dragging = false })

window.jumpToRound = jumpToRound

// ── XSS helper ───────────────────────────────────────────
function esc(s) {
  const d = document.createElement('div')
  d.textContent = s ?? ''
  return d.innerHTML
}

// ── Kick off ──────────────────────────────────────────────
jumpToRound(0)
requestAnimationFrame(ts => { state.lastTs = ts; loop(ts) })
