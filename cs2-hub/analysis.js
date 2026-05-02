import { requireAuth }           from './auth.js'
import { renderSidebar }         from './layout.js'
import { supabase }              from './supabase.js'
import { attachTeamAutocomplete } from './team-autocomplete.js'
import { narrowRoundsForTeam, framesForRound, grenadesForRound } from './analysis-rounds.js'
import { worldToCanvas } from './demo-map-data.js'

await requireAuth()
renderSidebar('analysis')

// ── State ────────────────────────────────────────────────────
const state = {
  team:        null,         // selected team name (string)
  mode:        'overlay',    // 'overlay' | 'grenade'
  soloSid:     null,         // when set, overlay shows only this player
  filters: {
    map:        null,        // string
    side:       'ct',        // 'ct' | 't' | 'both'
    opponent:   'any',       // 'any' | string
    dateRange:  '30d',       // 'all' | '30d' | 'last10' | 'custom'
    outcome:    'all',       // 'all' | 'won' | 'lost'
    bombSite:   'all',       // 'all' | 'a' | 'b' | 'none'
  },
  corpus:      [],           // [{id, map, played_at, ct_team_name, t_team_name, ...}]
  slimCache:   new Map(),    // demoId → slim payload
  rounds:      [],           // computed RenderRound[] (built in Task 9)
}

// ── URL helpers ──────────────────────────────────────────────
function readUrl() {
  const p = new URLSearchParams(location.search)
  state.team        = p.get('team')                 || null
  state.mode        = p.get('mode')                 || 'overlay'
  state.filters.map      = p.get('map')             || null
  state.filters.side     = p.get('side')            || 'ct'
  state.filters.opponent = p.get('opponent')        || 'any'
  state.filters.dateRange = p.get('date')           || '30d'
  state.filters.outcome  = p.get('outcome')         || 'all'
  state.filters.bombSite = p.get('bomb')            || 'all'
}

function writeUrl() {
  const p = new URLSearchParams()
  if (state.team)              p.set('team',     state.team)
  if (state.mode !== 'overlay') p.set('mode',    state.mode)
  if (state.filters.map)        p.set('map',     state.filters.map)
  if (state.filters.side !== 'ct') p.set('side', state.filters.side)
  if (state.filters.opponent !== 'any') p.set('opponent', state.filters.opponent)
  if (state.filters.dateRange !== '30d') p.set('date',     state.filters.dateRange)
  if (state.filters.outcome !== 'all') p.set('outcome',   state.filters.outcome)
  if (state.filters.bombSite !== 'all') p.set('bomb',     state.filters.bombSite)
  const qs = p.toString()
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname)
}

// ── Chip/message helpers ─────────────────────────────────────
const _chips = new Map()  // key → element

function showChip(text, kind = 'info') {
  const container = document.getElementById('canvas-chips')
  if (_chips.has(text)) return
  const el = document.createElement('div')
  el.className = `chip ${kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : ''}`
  el.textContent = text
  container.appendChild(el)
  _chips.set(text, el)
}

function hideChip(text) {
  const el = _chips.get(text)
  if (el) { el.remove(); _chips.delete(text) }
}

function setEmptyMessage(text) {
  const el = document.getElementById('canvas-empty')
  el.textContent = text
  el.style.display = text ? 'flex' : 'none'
}

// ── Team picker ──────────────────────────────────────────────
const teamInput = document.getElementById('team-pick')
attachTeamAutocomplete(teamInput, async team => {
  state.team = team.name
  teamInput.value = team.name
  // Reset map filter on team change — Task 11 will handle stale-filter cleanup
  state.filters.map = null
  writeUrl()
  await onTeamChanged()
})

// ── Boot ─────────────────────────────────────────────────────
readUrl()
if (state.team) {
  teamInput.value = state.team
  await onTeamChanged()
}

async function loadCorpus(teamName) {
  try {
    const { data, error } = await supabase
      .from('demos')
      .select('id, map, played_at, ct_team_name, t_team_name, score_ct, score_t, team_a_first_side, team_a_score, team_b_score')
      .eq('status', 'ready')
      .or(`ct_team_name.eq.${teamName},t_team_name.eq.${teamName}`)
      .order('played_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } catch (e) {
    console.error('[analysis] corpus load failed:', e)
    showChip('Failed to load corpus — check network', 'error')
    return []
  }
}

async function onTeamChanged() {
  if (!state.team) return
  showChip('Loading corpus…', 'info')
  state.corpus = await loadCorpus(state.team)
  hideChip('Loading corpus…')
  renderFilterRail()
  if (state.filters.map) loadMapImage(state.filters.map)
  // Round set built once filters apply — Task 9
  await reloadRoundSet()
}

function renderFilterRail() {
  const rail = document.getElementById('filter-rail')
  if (!state.team || !state.corpus.length) {
    rail.innerHTML = `<div class="label">Filters</div><div style="font-size:11px;color:#555">No demos for this team yet.</div>`
    setEmptyMessage(state.team ? 'No demos found for this team.' : 'Pick a team to begin.')
    return
  }
  setEmptyMessage('')

  // Derive filter options from the corpus
  const maps = [...new Set(state.corpus.map(d => d.map).filter(Boolean))].sort()
  const opps = [...new Set(state.corpus.flatMap(d => [d.ct_team_name, d.t_team_name])
                                       .filter(n => n && n !== state.team))].sort()

  // Default the map filter if nothing chosen yet
  if (!state.filters.map || !maps.includes(state.filters.map)) {
    state.filters.map = maps[0] ?? null
    writeUrl()
  }
  // Defensive: opponent fallback
  if (state.filters.opponent !== 'any' && !opps.includes(state.filters.opponent)) {
    state.filters.opponent = 'any'
    writeUrl()
  }

  rail.innerHTML = `
    <div class="label">Map</div>
    <select id="f-map">
      ${maps.map(m => `<option value="${m}" ${m === state.filters.map ? 'selected' : ''}>${mapShort(m)}</option>`).join('')}
    </select>

    <div class="label">Side</div>
    <div class="seg-row" id="f-side">
      <button class="seg-btn ${state.filters.side === 'ct' ? 'active' : ''}"   data-v="ct">CT</button>
      <button class="seg-btn ${state.filters.side === 't'  ? 'active' : ''}"   data-v="t">T</button>
      <button class="seg-btn ${state.filters.side === 'both' ? 'active' : ''}" data-v="both">Both</button>
    </div>

    <div class="label">Opponent</div>
    <select id="f-opp">
      <option value="any" ${state.filters.opponent === 'any' ? 'selected' : ''}>Any opponent</option>
      ${opps.map(o => `<option value="${o}" ${o === state.filters.opponent ? 'selected' : ''}>${o}</option>`).join('')}
    </select>

    <div class="label">Date</div>
    <select id="f-date">
      <option value="all"    ${state.filters.dateRange === 'all'    ? 'selected' : ''}>All time</option>
      <option value="30d"    ${state.filters.dateRange === '30d'    ? 'selected' : ''}>Last 30 days</option>
      <option value="last10" ${state.filters.dateRange === 'last10' ? 'selected' : ''}>Last 10 matches</option>
    </select>

    <div class="label">Outcome</div>
    <div class="seg-row" id="f-outcome">
      <button class="seg-btn ${state.filters.outcome === 'won'  ? 'active' : ''}" data-v="won">Won</button>
      <button class="seg-btn ${state.filters.outcome === 'lost' ? 'active' : ''}" data-v="lost">Lost</button>
      <button class="seg-btn ${state.filters.outcome === 'all'  ? 'active' : ''}" data-v="all">All</button>
    </div>

    <div class="label">Bomb plant</div>
    <div class="seg-row" id="f-bomb">
      <button class="seg-btn ${state.filters.bombSite === 'a'    ? 'active' : ''}" data-v="a">A</button>
      <button class="seg-btn ${state.filters.bombSite === 'b'    ? 'active' : ''}" data-v="b">B</button>
      <button class="seg-btn ${state.filters.bombSite === 'none' ? 'active' : ''}" data-v="none">None</button>
      <button class="seg-btn ${state.filters.bombSite === 'all'  ? 'active' : ''}" data-v="all">All</button>
    </div>

    <div class="filter-readout">
      <span class="num" id="f-rounds">0</span> rounds<br>
      from <span class="num" id="f-demos">0</span> demos
    </div>
    <button class="reset-filters-btn" id="f-reset">Reset filters</button>
  `

  // Wire change handlers
  rail.querySelector('#f-map').addEventListener('change', e => onFilter('map', e.target.value))
  rail.querySelector('#f-opp').addEventListener('change', e => onFilter('opponent', e.target.value))
  rail.querySelector('#f-date').addEventListener('change', e => onFilter('dateRange', e.target.value))
  for (const [groupId, key] of [['f-side','side'], ['f-outcome','outcome'], ['f-bomb','bombSite']]) {
    rail.querySelector('#' + groupId).addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn'); if (!btn) return
      onFilter(key, btn.dataset.v)
    })
  }
  rail.querySelector('#f-reset').addEventListener('click', () => {
    state.filters.side = 'ct'
    state.filters.opponent = 'any'
    state.filters.dateRange = '30d'
    state.filters.outcome = 'all'
    state.filters.bombSite = 'all'
    writeUrl()
    renderFilterRail()
    reloadRoundSet()
  })
}

function mapShort(m) {
  return (m || '').replace('de_', '').replace(/^./, c => c.toUpperCase())
}

function onFilter(key, value) {
  const prevMap = state.filters.map
  state.filters[key] = value
  writeUrl()
  renderFilterRail()  // re-render so segmented active state updates
  if (key === 'map' && value !== prevMap) loadMapImage(value)
  reloadRoundSet()
}

const SLIM_CACHE_MAX = 50

async function fetchSlimPayloads(demoIds) {
  // Split into already-cached vs needs-fetch
  const need = demoIds.filter(id => !state.slimCache.has(id))
  if (need.length) {
    showChip(`Loading ${need.length} demo${need.length === 1 ? '' : 's'}…`, 'info')
    const { data, error } = await supabase
      .from('demos')
      .select('id, match_data_slim, team_a_first_side')
      .in('id', need)
    hideChip(`Loading ${need.length} demo${need.length === 1 ? '' : 's'}…`)

    if (error) {
      showChip('Some demos failed to load', 'error')
      console.error('[analysis] slim fetch error:', error)
    } else {
      let skipped = 0
      for (const row of data ?? []) {
        if (!row.match_data_slim) { skipped++; continue }
        // Inject team_a_first_side into the slim payload so downstream code
        // doesn't need to keep a parallel lookup
        row.match_data_slim._team_a_first_side = row.team_a_first_side
        state.slimCache.set(row.id, row.match_data_slim)
      }
      if (skipped > 0) showChip(`${skipped} demo(s) skipped — pending re-parse`, 'warn')
    }
    // LRU eviction
    while (state.slimCache.size > SLIM_CACHE_MAX) {
      const oldestKey = state.slimCache.keys().next().value
      state.slimCache.delete(oldestKey)
    }
  }
  return demoIds.map(id => state.slimCache.get(id)).filter(Boolean)
}

async function reloadRoundSet() {
  // 1. Apply demo-level filters in client (cheap, no fetch).
  let demos = state.corpus
  if (state.filters.map)  demos = demos.filter(d => d.map === state.filters.map)
  if (state.filters.opponent !== 'any') {
    demos = demos.filter(d =>
      (d.ct_team_name === state.filters.opponent && d.t_team_name === state.team) ||
      (d.t_team_name === state.filters.opponent && d.ct_team_name === state.team)
    )
  }
  if (state.filters.dateRange === '30d') {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000
    demos = demos.filter(d => d.played_at && new Date(d.played_at).getTime() >= cutoff)
  } else if (state.filters.dateRange === 'last10') {
    demos = demos.slice(0, 10)
  }

  if (demos.length > 15) showChip(`Loading ${demos.length} demos — this may take a moment…`, 'warn')
  else                    hideChip(`Loading ${demos.length} demos — this may take a moment…`)

  if (!demos.length) {
    state.rounds = []
    updateReadout(0, 0)
    setEmptyMessage('0 rounds match — try widening filters.')
    requestRender()
    return
  }

  // 2. Fetch slim payloads — populates state.slimCache. Awaiting only ensures
  //    the cache is filled; we look up by demo.id below to keep id↔payload
  //    pairing unambiguous (avoids index-drift if any payload was skipped).
  await fetchSlimPayloads(demos.map(d => d.id))

  // 3. Bind team identity to each payload (roster A vs B for the selected team).
  const teamName = state.team
  const enriched = []
  for (const demo of demos) {
    const slim = state.slimCache.get(demo.id)
    if (!slim) continue   // skipped (null match_data_slim) — already chip-warned
    // Roster A = team that started on the side recorded in team_a_first_side.
    // Match the selected team's name to either ct_team_name or t_team_name to
    // determine whether it was roster A in this demo.
    const aFirstSide = slim._team_a_first_side
    let isRosterA = false
    if (aFirstSide === 'ct')      isRosterA = (demo.ct_team_name === teamName)
    else if (aFirstSide === 't')  isRosterA = (demo.t_team_name === teamName)
    else                          isRosterA = (demo.ct_team_name === teamName)  // legacy fallback

    enriched.push(Object.assign({ _is_roster_a: isRosterA, _demo_id: demo.id }, slim))
  }

  // 4. Narrow rounds.
  state.rounds = narrowRoundsForTeam(enriched, state.filters)

  buildPlayerColorMap()
  recomputePlaybackBounds()
  updateTimelineUi()
  updateReadout(state.rounds.length, demos.length)
  setEmptyMessage(state.rounds.length === 0 ? '0 rounds match — try widening filters.' : '')
  requestRender()
  if (state.mode === 'grenade') refreshGrenadePanel()
}

function updateReadout(rounds, demos) {
  const r = document.getElementById('f-rounds')
  const d = document.getElementById('f-demos')
  if (r) r.textContent = String(rounds)
  if (d) d.textContent = String(demos)
}

// ── Canvas and map rendering ──────────────────────────────────
const canvas = document.getElementById('map-canvas')
const ctx    = canvas.getContext('2d')
const wrap   = document.getElementById('canvas-wrap')

let mapImg     = null
let mapLoaded  = false
let _renderQueued = false

function loadMapImage(mapName) {
  mapImg = new Image()
  mapLoaded = false
  mapImg.src = `images/maps/${mapName}_viewer.png`
  mapImg.onload  = () => { mapLoaded = true; requestRender() }
  mapImg.onerror = () => {
    mapImg.src = `images/maps/${mapName}_radar.png`
    mapImg.onload  = () => { mapLoaded = true; requestRender() }
    mapImg.onerror = () => { mapLoaded = true; requestRender() }
  }
}

function resizeCanvas() {
  const { width, height } = wrap.getBoundingClientRect()
  if (width < 10 || height < 10) return
  canvas.width  = Math.round(width)
  canvas.height = Math.round(height)
}
new ResizeObserver(() => { resizeCanvas(); requestRender() }).observe(wrap)
resizeCanvas()

function requestRender() {
  if (_renderQueued) return
  _renderQueued = true
  requestAnimationFrame(() => {
    _renderQueued = false
    render()
  })
}

const playback = {
  playing:  false,
  speed:    1,
  relTick:  0,        // round-relative tick (0 = freeze end)
  maxTick:  0,        // longest matched round duration
  lastTs:   0,
  showTrails: false,
}

function recomputePlaybackBounds() {
  let max = 0
  for (const r of state.rounds) {
    const span = r.endTick - r.freezeEndTick
    if (span > max) max = span
  }
  playback.maxTick = max
  if (playback.relTick > max) playback.relTick = 0
}

function loop(ts) {
  if (playback.playing) {
    if (!playback.lastTs) playback.lastTs = ts
    const dt = (ts - playback.lastTs) / 1000
    playback.lastTs = ts
    const tickRate = state.rounds[0]?._payload?.meta?.tick_rate ?? 64
    playback.relTick += dt * tickRate * playback.speed
    if (playback.relTick > playback.maxTick) {
      playback.relTick = 0  // loop
    }
    updateTimelineUi()
    render()
  } else {
    playback.lastTs = 0
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

function render() {
  const cw = canvas.width
  const ch = canvas.height
  ctx.clearRect(0, 0, cw, ch)
  ctx.fillStyle = '#030712'
  ctx.fillRect(0, 0, cw, ch)

  // Letterbox: square map region, centered
  const mapSize = Math.min(cw, ch)
  const mapX    = Math.round((cw - mapSize) / 2)
  const mapY    = Math.round((ch - mapSize) / 2)

  if (mapLoaded && mapImg.complete && mapImg.naturalWidth) {
    ctx.drawImage(mapImg, mapX, mapY, mapSize, mapSize)
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.fillRect(mapX, mapY, mapSize, mapSize)
  } else {
    ctx.fillStyle = '#0d1117'
    ctx.fillRect(mapX, mapY, mapSize, mapSize)
  }

  const tc = (wx, wy) => {
    const { x, y } = worldToCanvas(wx, wy, state.filters.map, mapSize, mapSize)
    return { x: x + mapX, y: y + mapY }
  }

  // Mode dispatch (Task 11/13 fill these in)
  if (state.mode === 'overlay') renderOverlay(tc, mapSize)
  else if (state.mode === 'grenade') renderGrenadeMode(tc, mapSize)
}

// ── Grenade mode constants ───────────────────────────────────
const GREN_COLORS = {
  smoke:   { fill: 'rgba(180,180,180,0.55)', stroke: 'rgba(220,220,220,0.85)' },
  molotov: { fill: 'rgba(255,122,48,0.65)',  stroke: 'rgba(255,170,90,0.95)'  },
  flash:   { fill: 'rgba(255,235,85,0.65)',  stroke: 'rgba(255,245,140,0.95)' },
  he:      { fill: 'rgba(108,208,112,0.55)', stroke: 'rgba(150,230,150,0.95)' },
}
const GREN_RADII = { smoke: 0.024, molotov: 0.014, flash: 0.012, he: 0.012 }

let _highlightedGrenadeKey = null  // demoId|roundIdx|throw_tick — used for click highlight

// Task 13 (grenade) fills this in
function renderGrenadeMode(tc, mapSize) {
  if (!state.rounds.length) return

  const typeFilter = document.getElementById('gp-type-filter')?.value ?? 'all'

  for (const r of state.rounds) {
    const grenades = grenadesForRound(r._payload, r.roundIdx)
    for (const g of grenades) {
      if (typeFilter !== 'all' && g.type !== typeFilter) continue

      const colors = GREN_COLORS[g.type] || GREN_COLORS.smoke
      const radius = (GREN_RADII[g.type] || 0.012) * mapSize
      const { x, y } = tc(g.land_x, g.land_y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const key = `${r.demoId}|${r.roundIdx}|${g.throw_tick}`
      const dimmed = _highlightedGrenadeKey && _highlightedGrenadeKey !== key

      ctx.globalAlpha = dimmed ? 0.20 : 1.0

      ctx.fillStyle   = colors.fill
      ctx.strokeStyle = colors.stroke
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()

      if (_highlightedGrenadeKey === key) {
        ctx.beginPath()
        ctx.arc(x, y, radius + 4, 0, Math.PI * 2)
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
  }
  ctx.globalAlpha = 1.0
}

// 5 distinct colors for the 5 players on the user's team. Stable per-sid across the session.
const TEAM_PALETTE = ['#FF6B6B', '#FFD93D', '#6BCB77', '#4D96FF', '#C56CF0']
const _playerColorBySid = new Map()
const _playerNameBySid  = new Map()

function buildPlayerColorMap() {
  _playerColorBySid.clear()
  _playerNameBySid.clear()
  const sids = new Set()
  for (const r of state.rounds) {
    const frames = framesForRound(r._payload, r.roundIdx)
    if (!frames.length) continue
    for (const p of frames[0].players) {
      if (p.team === r.teamSide) sids.add(p.steam_id)
    }
    const meta = r._payload.meta?.players || {}
    for (const sid of Object.keys(meta)) {
      if (!_playerNameBySid.has(sid) && meta[sid]?.name) {
        _playerNameBySid.set(sid, meta[sid].name)
      }
    }
  }
  const sorted = [...sids].sort()
  for (let i = 0; i < sorted.length; i++) {
    _playerColorBySid.set(sorted[i], TEAM_PALETTE[i % TEAM_PALETTE.length])
  }
  // If solo'd player is no longer in the roster, clear it
  if (state.soloSid && !_playerColorBySid.has(state.soloSid)) state.soloSid = null
  refreshPlayerPanel()
}

function getPlayerColor(sid) {
  return _playerColorBySid.get(sid) || '#888'
}

// Grenade visual durations (mirrors demo-viewer.js constants)
const GRENADE_DURATION_S = { smoke: 22, molotov: 7, flash: 0.5, he: 1.0 }
const GRENADE_ICONS = {}
;['smoke:smokegrenade', 'flash:flashbang', 'he:hegrenade', 'molotov:molotov'].forEach(entry => {
  const [type, filename] = entry.split(':')
  const img = new Image()
  img.src = `images/weapons/${filename}.svg`
  GRENADE_ICONS[type] = img
})

function drawPlayer(tc, p, color, mapSize) {
  const { x, y } = tc(p.x, p.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const dotR = Math.max(3, Math.round(mapSize * 0.009))

  if (!p.alive) {
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
    return
  }

  if (Number.isFinite(p.yaw)) {
    const yawRad = p.yaw * Math.PI / 180
    const dir = tc(p.x + Math.cos(yawRad) * 300, p.y + Math.sin(yawRad) * 300)
    const angle      = Math.atan2(dir.y - y, dir.x - x)
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

function drawCountdown(x, y, secs, color) {
  if (secs <= 0) return
  ctx.save()
  ctx.font = '600 10px Inter, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = color
  ctx.fillText(String(secs), x, y)
  ctx.restore()
}

function drawGrenade(tc, g, targetTick, tickRate, mapSize, teamColor) {
  const tickStart = g.det_tick
  const throwT    = g.throw_tick ?? g.det_tick
  const trajTicks = (g.type === 'smoke' ? 7 : g.type === 'molotov' ? 6 : g.type === 'he' ? 5 : 2) * tickRate
  const totalS    = GRENADE_DURATION_S[g.type] ?? 1
  const elapsedS  = (targetTick - tickStart) / tickRate

  const inFlight = throwT <= targetTick && targetTick < tickStart
  const active   = tickStart <= targetTick && elapsedS < totalS
  const showTraj = tickStart <= targetTick && (targetTick - tickStart) < trajTicks && !(g.type === 'flash' && active)
  if (!inFlight && !active && !showTraj) return

  const { x, y } = tc(g.land_x, g.land_y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const typeColor = g.type === 'smoke'   ? 'rgba(200,200,200,0.6)'
                  : g.type === 'molotov' ? 'rgba(255,140,0,0.6)'
                  : g.type === 'flash'   ? 'rgba(255,255,255,0.5)'
                  :                        'rgba(255,220,0,0.6)'

  // ── Trajectory ──────────────────────────────────────────────
  const pathPts = g.trajectory
  if (pathPts && pathPts.length >= 2) {
    const canvasPts = pathPts.map(([wx, wy]) => tc(wx, wy))
    ctx.save()
    ctx.setLineDash([3, 5])
    ctx.lineWidth = 1.5

    if (inFlight) {
      const duration = tickStart - throwT
      const progress = duration > 0 ? Math.min(1, (targetTick - throwT) / duration) : 1
      const totalSegs = canvasPts.length - 1
      const rawT = progress * totalSegs
      const seg  = Math.min(Math.floor(rawT), totalSegs - 1)
      const t    = rawT - seg
      const p0   = canvasPts[seg]
      const p1   = canvasPts[seg + 1]
      const iconX = p0.x + (p1.x - p0.x) * t
      const iconY = p0.y + (p1.y - p0.y) * t
      const arcScale = 1 + 0.5 * 4 * progress * (1 - progress)

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
      return
    } else if (showTraj) {
      const alpha = 1 - (targetTick - tickStart) / trajTicks
      ctx.strokeStyle = typeColor
      ctx.globalAlpha = alpha * 0.65
      ctx.beginPath()
      ctx.moveTo(canvasPts[0].x, canvasPts[0].y)
      for (let i = 1; i < canvasPts.length; i++) ctx.lineTo(canvasPts[i].x, canvasPts[i].y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = alpha * 0.5
      ctx.beginPath(); ctx.arc(canvasPts[0].x, canvasPts[0].y, mapSize * 0.005, 0, Math.PI * 2)
      ctx.fillStyle = typeColor; ctx.fill()
    }
    ctx.restore()
  }

  if (!active) return

  // ── Active overlay ──────────────────────────────────────────
  if (g.type === 'smoke') {
    const r = mapSize * 0.032
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle   = 'rgba(180,180,180,0.35)'
    ctx.strokeStyle = teamColor || 'rgba(200,200,200,0.5)'
    ctx.lineWidth   = 1.2
    ctx.fill(); ctx.stroke()
    drawCountdown(x, y, Math.ceil(totalS - elapsedS), 'rgba(255,255,255,0.9)')
  } else if (g.type === 'molotov') {
    const r = mapSize * 0.028
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle   = 'rgba(255,100,0,0.3)'
    ctx.strokeStyle = teamColor || 'rgba(255,140,0,0.6)'
    ctx.lineWidth   = 1.2
    ctx.fill(); ctx.stroke()
    drawCountdown(x, y, Math.ceil(totalS - elapsedS), '#FF9500')
  } else if (g.type === 'flash') {
    const progress = totalS > 0 ? Math.min(1, elapsedS / totalS) : 1
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

function renderOverlay(tc, mapSize) {
  if (!state.rounds.length) return

  const tickRate = state.rounds[0]?._payload?.meta?.tick_rate ?? 64
  const teamColors = { ct: '#4FC3F7', t: '#FF9500' }

  // Pass 1: grenades (under players)
  for (const r of state.rounds) {
    const targetTick = r.freezeEndTick + Math.floor(playback.relTick)
    if (targetTick > r.endTick) continue
    const grenades = grenadesForRound(r._payload, r.roundIdx)
    for (const g of grenades) {
      if (g.thrower_team !== r.teamSide) continue
      if (state.soloSid && g.thrower_sid !== state.soloSid) continue
      drawGrenade(tc, g, targetTick, tickRate, mapSize, teamColors[r.teamSide])
    }
  }

  // Pass 2: players (filtered to user's team, optionally solo'd)
  for (const r of state.rounds) {
    const targetTick = r.freezeEndTick + Math.floor(playback.relTick)
    if (targetTick > r.endTick) continue
    const frames = framesForRound(r._payload, r.roundIdx)
    if (!frames.length) continue

    let lo = 0, hi = frames.length - 1, idx = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (frames[mid].tick <= targetTick) { idx = mid; lo = mid + 1 } else hi = mid - 1
    }
    const frame = frames[idx]

    if (playback.showTrails) {
      const trailFrames = 30
      const trailStart  = Math.max(0, idx - trailFrames)
      ctx.lineWidth = 1.2
      for (const player of frame.players) {
        if (player.team !== r.teamSide) continue
        if (state.soloSid && player.steam_id !== state.soloSid) continue
        if (!player.alive) continue
        ctx.beginPath()
        let started = false
        for (let i = trailStart; i <= idx; i++) {
          const pf = frames[i]
          const pp = pf.players.find(p => p.steam_id === player.steam_id)
          if (!pp || !pp.alive) { started = false; continue }
          const { x, y } = tc(pp.x, pp.y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) { started = false; continue }
          if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = getPlayerColor(player.steam_id) + '66'
        ctx.stroke()
      }
    }

    for (const player of frame.players) {
      if (player.team !== r.teamSide) continue
      if (state.soloSid && player.steam_id !== state.soloSid) continue
      drawPlayer(tc, player, getPlayerColor(player.steam_id), mapSize)
    }
  }
}

function refreshPlayerPanel() {
  const listEl  = document.getElementById('pp-list')
  const clearEl = document.getElementById('pp-clear')
  if (!listEl) return

  const items = [..._playerColorBySid.entries()].map(([sid, color]) => ({
    sid,
    color,
    name: _playerNameBySid.get(sid) || sid.slice(-5),
  }))

  listEl.innerHTML = items.map(it => `
    <div class="pp-item ${state.soloSid === it.sid ? 'active' : ''}" data-sid="${it.sid}">
      <span class="pp-swatch" style="background:${it.color}"></span>
      <span>${escapeHtml(it.name)}</span>
    </div>
  `).join('')

  clearEl.style.display = state.soloSid ? 'block' : 'none'

  for (const el of listEl.querySelectorAll('.pp-item')) {
    el.addEventListener('click', () => {
      const sid = el.dataset.sid
      state.soloSid = (state.soloSid === sid) ? null : sid
      refreshPlayerPanel()
      render()
    })
  }
}

document.getElementById('pp-clear').addEventListener('click', () => {
  state.soloSid = null
  refreshPlayerPanel()
  render()
})

function updateTimelineUi() {
  const fillEl  = document.getElementById('tl-fill')
  const thumbEl = document.getElementById('tl-thumb')
  const curEl   = document.getElementById('tl-current')
  const endEl   = document.getElementById('tl-end')
  const tr      = state.rounds[0]?._payload?.meta?.tick_rate ?? 64

  const pct = playback.maxTick > 0 ? (playback.relTick / playback.maxTick) * 100 : 0
  fillEl.style.width  = pct + '%'
  thumbEl.style.left  = pct + '%'

  const fmt = secs => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`
  curEl.textContent = fmt(playback.relTick / tr)
  endEl.textContent = fmt(playback.maxTick / tr)
}

document.getElementById('play-btn').addEventListener('click', () => {
  playback.playing = !playback.playing
  document.getElementById('play-btn').textContent = playback.playing ? '❚❚' : '▶'
})

document.getElementById('tl-track').addEventListener('click', e => {
  const rect = e.currentTarget.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  playback.relTick = pct * playback.maxTick
  updateTimelineUi()
  render()
})

for (const btn of document.querySelectorAll('.speed-btn')) {
  btn.addEventListener('click', () => {
    playback.speed = parseFloat(btn.dataset.speed)
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.toggle('active', b === btn))
  })
}

document.getElementById('trail-toggle').addEventListener('click', e => {
  playback.showTrails = !playback.showTrails
  e.currentTarget.classList.toggle('active', playback.showTrails)
  render()
})

// ── Mode toggle (Task 12) ────────────────────────────────────
function refreshGrenadePanel() {
  const listEl  = document.getElementById('gp-list')
  const countEl = document.getElementById('gp-count')
  const typeFilter = document.getElementById('gp-type-filter').value
  const sortBy     = document.getElementById('gp-sort').value

  const items = []
  for (const r of state.rounds) {
    const grenades = grenadesForRound(r._payload, r.roundIdx)
    // slim payload carries meta.players = { sid: { name } } (Task 2 / build_slim_payload)
    const playersMeta = r._payload.meta?.players || {}
    for (const g of grenades) {
      if (typeFilter !== 'all' && g.type !== typeFilter) continue
      items.push({
        key:         `${r.demoId}|${r.roundIdx}|${g.throw_tick}`,
        type:        g.type,
        round:       r.roundIdx + 1,
        thrower:     playersMeta[g.thrower_sid]?.name || g.thrower_sid?.slice(-5) || '?',
        thrower_team: g.thrower_team,
        throw_tick:  g.throw_tick,
        round_ref:   r,
      })
    }
  }

  items.sort((a, b) => {
    if (sortBy === 'type')    return a.type.localeCompare(b.type) || a.round - b.round
    if (sortBy === 'thrower') return a.thrower.localeCompare(b.thrower)
    return a.round - b.round || a.throw_tick - b.throw_tick
  })

  countEl.textContent = `${items.length} grenade${items.length === 1 ? '' : 's'}`

  listEl.innerHTML = items.map(it => `
    <div class="gp-item ${_highlightedGrenadeKey === it.key ? 'active' : ''}" data-key="${it.key}">
      <div class="gp-item-dot ${it.type}"></div>
      <div>
        <div>${it.type.toUpperCase()} · R${it.round} · ${escapeHtml(it.thrower)}</div>
      </div>
    </div>
  `).join('')

  for (const el of listEl.querySelectorAll('.gp-item')) {
    el.addEventListener('click', () => {
      _highlightedGrenadeKey = (_highlightedGrenadeKey === el.dataset.key) ? null : el.dataset.key
      refreshGrenadePanel()
      render()
    })
  }
}

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML
}

document.getElementById('gp-type-filter').addEventListener('change', () => { refreshGrenadePanel(); render() })
document.getElementById('gp-sort').addEventListener('change', refreshGrenadePanel)

function applyMode() {
  for (const pill of document.querySelectorAll('.mode-pill')) {
    pill.classList.toggle('active', pill.dataset.mode === state.mode)
  }
  document.getElementById('analysis-bottom').classList.toggle('hidden', state.mode !== 'overlay')
  document.getElementById('grenade-panel').classList.toggle('show', state.mode === 'grenade')
  document.getElementById('player-panel').classList.toggle('show', state.mode === 'overlay')
  if (state.mode !== 'overlay') {
    playback.playing = false
    document.getElementById('play-btn').textContent = '▶'
  }
  if (state.mode === 'grenade') refreshGrenadePanel()
  render()
}

for (const pill of document.querySelectorAll('.mode-pill')) {
  pill.addEventListener('click', () => {
    state.mode = pill.dataset.mode
    writeUrl()
    applyMode()
  })
}
applyMode()  // initial sync from URL

// Export for tests (no-op in browser)
export { state, readUrl, writeUrl }
