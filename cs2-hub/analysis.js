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
  const { data, error } = await supabase
    .from('demos')
    .select('id, map, played_at, ct_team_name, t_team_name, score_ct, score_t, team_a_first_side, team_a_score, team_b_score')
    .eq('status', 'ready')
    .or(`ct_team_name.eq.${teamName},t_team_name.eq.${teamName}`)
    .order('played_at', { ascending: false })

  if (error) {
    console.error('[analysis] corpus query failed:', error)
    return []
  }
  return data ?? []
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

function renderOverlay(tc, mapSize) {
  if (!state.rounds.length) return

  const dotR = Math.max(2, Math.round(mapSize * 0.0035))

  for (const r of state.rounds) {
    const targetTick = r.freezeEndTick + Math.floor(playback.relTick)
    if (targetTick > r.endTick) continue   // round ended already
    const frames = framesForRound(r._payload, r.roundIdx)
    if (!frames.length) continue

    // Find the nearest frame at-or-before targetTick (binary search)
    let lo = 0, hi = frames.length - 1, idx = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (frames[mid].tick <= targetTick) { idx = mid; lo = mid + 1 } else hi = mid - 1
    }
    const frame = frames[idx]

    const color = `hsl(${r.hue}, 75%, 60%)`

    // Trails (off by default)
    if (playback.showTrails) {
      const trailFrames = 30
      const trailStart  = Math.max(0, idx - trailFrames)
      ctx.lineWidth = 1.2
      for (const player of frame.players) {
        if (!player.alive) continue
        ctx.beginPath()
        let started = false
        for (let i = trailStart; i <= idx; i++) {
          const pf = frames[i]
          const pp = pf.players.find(p => p.steam_id === player.steam_id)
          if (!pp || !pp.alive) { started = false; continue }
          const { x, y } = tc(pp.x, pp.y)
          if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
        }
        const fade = Math.max(0.05, 0.25)
        ctx.strokeStyle = `hsla(${r.hue}, 75%, 60%, ${fade})`
        ctx.stroke()
      }
    }

    // Player dots
    ctx.fillStyle = color
    ctx.globalAlpha = 0.35
    for (const player of frame.players) {
      if (!player.alive) continue
      const { x, y } = tc(player.x, player.y)
      ctx.beginPath()
      ctx.arc(x, y, dotR, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1.0
  }
}

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
