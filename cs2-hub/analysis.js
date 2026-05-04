import { requireAuth }           from './auth.js'
import { renderSidebar }         from './layout.js'
import { supabase, getTeamId }   from './supabase.js'
import { mountAntistratDrawer } from './antistrat-drawer.js'
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
  viewRoundIdx: null,        // when set, overlay drops to single-round playback for this round (everyone visible)
  utilSoloType: null,        // when set, overlay shows only this util type (smoke/molotov/flash/he)
  filters: {
    map:        null,        // string
    side:       'ct',        // 'ct' | 't' | 'both'
    opponent:   'any',       // 'any' | string
    matchIds:   null,        // Set<string> | null (null = all matches for current map)
    buyTypes:   new Set(),   // Set<'fullbuy'|'antieco'|'eco'|'pistol'> — empty = all
  },
  corpus:      [],           // [{id, map, played_at, ct_team_name, t_team_name, ...}]
  slimCache:   new Map(),    // demoId → slim payload
  fullCache:   new Map(),    // demoId → full match_data (loaded on single-round entry only)
  fullLoading: new Set(),    // demoIds currently being fetched (debounce)
  rounds:      [],           // computed RenderRound[] (built in Task 9)
  gren: {
    selectedKeys: new Set(),  // grenade keys selected via drag-rect: "demoId|roundIdx|throw_tick"
    drag:         null,       // {x0,y0,x1,y1} canvas pixels while dragging, else null
    playlist:     null,       // [round indices into state.rounds] when in playlist mode, else null
    playlistPos:  0,
    types:        new Set(),  // empty = all types; otherwise subset of {smoke,molotov,flash,he}
    timeMin:      0,          // seconds since freeze_end_tick (round goes live)
    timeMax:      30,
  },
}

// ── URL helpers ──────────────────────────────────────────────
function readUrl() {
  const p = new URLSearchParams(location.search)
  state.team        = p.get('team')                 || null
  state.mode        = p.get('mode')                 || 'overlay'
  state.filters.map      = p.get('map')             || null
  state.filters.side     = p.get('side')            || 'ct'
  state.filters.opponent = p.get('opponent')        || 'any'
  const buys = p.get('buy')
  state.filters.buyTypes = buys ? new Set(buys.split(',').filter(Boolean)) : new Set()
  // matchIds is too large for URL — left at null on load (= all matches for current map).
  state.filters.matchIds = null
}

function writeUrl() {
  const p = new URLSearchParams()
  if (state.team)              p.set('team',     state.team)
  if (state.mode !== 'overlay') p.set('mode',    state.mode)
  if (state.filters.map)        p.set('map',     state.filters.map)
  if (state.filters.side !== 'ct') p.set('side', state.filters.side)
  if (state.filters.opponent !== 'any') p.set('opponent', state.filters.opponent)
  if (state.filters.buyTypes.size) p.set('buy', [...state.filters.buyTypes].join(','))
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

  // Demos shown in the matches checklist: filtered by current map + opponent.
  const demosForMap = state.corpus.filter(d =>
    (!state.filters.map || d.map === state.filters.map) &&
    (state.filters.opponent === 'any' ||
     d.ct_team_name === state.filters.opponent ||
     d.t_team_name  === state.filters.opponent)
  )
  // matchIds null means "all" — turn into Set on first interaction.
  const selectedIds = state.filters.matchIds ?? new Set(demosForMap.map(d => d.id))
  const buyTypes    = ['fullbuy', 'antieco', 'eco', 'pistol']
  const buyLabel    = { fullbuy: 'Full', antieco: 'Anti-eco', eco: 'Eco', pistol: 'Pistol' }

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

    <div class="label">Matches</div>
    <div class="match-list" id="f-matches">
      ${demosForMap.length === 0
        ? `<div style="padding:7px;font-size:11px;color:#555">No matches.</div>`
        : demosForMap.map(d => `
          <label class="match-row">
            <input type="checkbox" data-id="${d.id}" ${selectedIds.has(d.id) ? 'checked' : ''}>
            <span class="meta">${matchLabel(d)}</span>
          </label>`).join('')
      }
    </div>
    <div class="match-list-actions">
      <button id="f-match-all">All</button>
      <button id="f-match-none">None</button>
    </div>

    <div class="label">Buy type</div>
    <div class="seg-row" id="f-buy">
      ${buyTypes.map(t => `
        <button class="seg-btn ${state.filters.buyTypes.has(t) ? 'active' : ''}" data-v="${t}">${buyLabel[t]}</button>
      `).join('')}
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
  rail.querySelector('#f-side').addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return
    onFilter('side', btn.dataset.v)
  })
  rail.querySelector('#f-buy').addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return
    const t = btn.dataset.v
    if (state.filters.buyTypes.has(t)) state.filters.buyTypes.delete(t)
    else state.filters.buyTypes.add(t)
    writeUrl()
    renderFilterRail()
    reloadRoundSet()
  })
  rail.querySelector('#f-matches').addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"]'); if (!cb) return
    if (state.filters.matchIds == null) {
      state.filters.matchIds = new Set(demosForMap.map(d => d.id))
    }
    if (cb.checked) state.filters.matchIds.add(cb.dataset.id)
    else            state.filters.matchIds.delete(cb.dataset.id)
    updateReadout(state.rounds.length, state.filters.matchIds.size)
    reloadRoundSet()
  })
  rail.querySelector('#f-match-all').addEventListener('click', () => {
    state.filters.matchIds = new Set(demosForMap.map(d => d.id))
    renderFilterRail()
    reloadRoundSet()
  })
  rail.querySelector('#f-match-none').addEventListener('click', () => {
    state.filters.matchIds = new Set()
    renderFilterRail()
    reloadRoundSet()
  })
  rail.querySelector('#f-reset').addEventListener('click', () => {
    state.filters.side = 'ct'
    state.filters.opponent = 'any'
    state.filters.matchIds = null
    state.filters.buyTypes = new Set()
    writeUrl()
    renderFilterRail()
    reloadRoundSet()
  })
}

function matchLabel(d) {
  const opp = (d.ct_team_name === state.team ? d.t_team_name : d.ct_team_name) || 'Unknown'
  const date = d.played_at ? new Date(d.played_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
  return `${date ? date + ' · ' : ''}vs ${opp}`
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
  if (state.filters.matchIds != null) {
    demos = demos.filter(d => state.filters.matchIds.has(d.id))
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

  // Stale grenade selection refers to rounds that may no longer exist after a
  // filter change. Drop it (and any active playlist) to avoid orphan keys.
  state.gren.selectedKeys.clear()
  state.gren.playlist    = null
  state.gren.playlistPos = 0
  refreshGrenSelection?.()

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
  if (state.viewRoundIdx != null && state.rounds[state.viewRoundIdx]) {
    const r = state.rounds[state.viewRoundIdx]
    max = r.endTick - r.freezeEndTick
  } else {
    for (const r of state.rounds) {
      const span = r.endTick - r.freezeEndTick
      if (span > max) max = span
    }
  }
  playback.maxTick = max
  if (playback.relTick > max) playback.relTick = 0
}

function advancePlaylist() {
  const pl = state.gren.playlist
  if (!pl || !pl.length) return
  state.gren.playlistPos = (state.gren.playlistPos + 1) % pl.length
  const nextIdx = pl[state.gren.playlistPos]
  state.viewRoundIdx = nextIdx
  playback.relTick = 0
  recomputePlaybackBounds()
  // Fire-and-forget — slim payload covers positions; full data populates HP
  // / weapons / shots once it arrives.
  fetchFullMatch(state.rounds[nextIdx].demoId)
  refreshSoloRoundNav()
}

function loop(ts) {
  if (playback.playing) {
    if (!playback.lastTs) playback.lastTs = ts
    const dt = (ts - playback.lastTs) / 1000
    playback.lastTs = ts
    const tickRate = state.rounds[0]?._payload?.meta?.tick_rate ?? 64
    playback.relTick += dt * tickRate * playback.speed
    if (playback.relTick > playback.maxTick) {
      // Playlist mode: advance to next round in the playlist (loops at end).
      if (state.gren.playlist && state.viewRoundIdx != null) {
        advancePlaylist()
      } else {
        playback.relTick = 0  // loop within current view
      }
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
  ctx.fillStyle = '#000000'
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

// Single source of truth for the grenade-mode visibility filter. Used by
// rendering, the drag-rect hit-test, and the count readout — keeping them
// consistent prevents "you can select what you can't see" bugs.
function grenadePassesFilters(g, r) {
  if (g.thrower_team !== r.teamSide) return false
  if (state.gren.types.size > 0 && !state.gren.types.has(g.type)) return false
  const tickRate = r._payload?.meta?.tick_rate ?? 64
  const sec = (g.throw_tick - r.freezeEndTick) / tickRate
  if (sec < state.gren.timeMin || sec > state.gren.timeMax) return false
  return true
}

// Renders selected team's grenade trajectories (no opponents).
// Each grenade is drawn as a polyline from throw → land using the slim
// payload's `trajectory` waypoints, with a small dot at the start and a
// larger marker at the landing point. A drag-selection rectangle is drawn
// on top while the user is dragging.
function renderGrenadeMode(tc, mapSize) {
  if (!state.rounds.length) return

  const anySelected = state.gren.selectedKeys.size > 0
  const startR = Math.max(2, mapSize * 0.004)
  const endR   = Math.max(3, mapSize * 0.007)

  for (const r of state.rounds) {
    const grenades = grenadesForRound(r._payload, r.roundIdx)
    for (const g of grenades) {
      if (!grenadePassesFilters(g, r)) continue

      const colors = GREN_COLORS[g.type] || GREN_COLORS.smoke
      const key = `${r.demoId}|${r.roundIdx}|${g.throw_tick}`
      const isSelected = state.gren.selectedKeys.has(key)
      const dimmed = anySelected && !isSelected

      ctx.globalAlpha = dimmed ? 0.18 : 1.0

      // Trajectory polyline (throw → land). Falls back to landing dot only
      // if the slim payload has no path waypoints.
      const traj = g.trajectory || []
      if (traj.length >= 2) {
        ctx.strokeStyle = colors.stroke
        ctx.lineWidth   = isSelected ? 2.5 : 1.5
        ctx.beginPath()
        let first = true
        for (const [wx, wy] of traj) {
          const { x, y } = tc(wx, wy)
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue
          if (first) { ctx.moveTo(x, y); first = false } else { ctx.lineTo(x, y) }
        }
        ctx.stroke()

        // Start dot
        const start = tc(traj[0][0], traj[0][1])
        if (Number.isFinite(start.x)) {
          ctx.fillStyle = colors.stroke
          ctx.beginPath(); ctx.arc(start.x, start.y, startR, 0, Math.PI * 2); ctx.fill()
        }
      }

      // Landing marker (always drawn even if trajectory is empty)
      const end = tc(g.land_x, g.land_y)
      if (Number.isFinite(end.x) && Number.isFinite(end.y)) {
        ctx.fillStyle   = colors.fill
        ctx.strokeStyle = colors.stroke
        ctx.lineWidth   = isSelected ? 2 : 1
        ctx.beginPath(); ctx.arc(end.x, end.y, endR, 0, Math.PI * 2)
        ctx.fill(); ctx.stroke()

        if (isSelected) {
          ctx.beginPath()
          ctx.arc(end.x, end.y, endR + 3, 0, Math.PI * 2)
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
          ctx.stroke()
        }
      }
    }
  }
  ctx.globalAlpha = 1.0

  // Drag-selection rectangle
  const d = state.gren.drag
  if (d) {
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1)
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0)
    ctx.fillStyle   = 'rgba(120,160,255,0.10)'
    ctx.strokeStyle = 'rgba(150,180,255,0.85)'
    ctx.lineWidth   = 1
    ctx.fillRect(x, y, w, h)
    ctx.strokeRect(x + 0.5, y + 0.5, w, h)
  }
}

// ── Viewer-style helpers (used in single-round playback with full match_data) ──
const CT_COLOR = '#4FC3F7'
const T_COLOR  = '#FF9500'
const FULL_CACHE_MAX = 4
const _prevHp = {}
const _flashUntil = {}

function viewerPlayerColor(team) { return team === 'ct' ? CT_COLOR : T_COLOR }

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

function flashIntensity(p) {
  if (p.flash_duration != null && p.flash_duration > 0) {
    return Math.max(0, Math.min(1, p.flash_duration / 2.5))
  }
  return 0
}

function drawRoundRect(c, x, y, w, h, r) {
  c.beginPath()
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + h, r)
  c.lineTo(x + w, y + h - r); c.arcTo(x + w, y + h, x, y + h, r)
  c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y, r)
  c.lineTo(x, y + r); c.arcTo(x, y, x + w, y, r); c.closePath()
}

function drawPlayerPill(x, dotTopY, label, color, pillFont, pillFontSz) {
  ctx.save()
  ctx.font = pillFont
  const tw = ctx.measureText(label).width
  const ph = pillFontSz + 5
  const pw = tw + 12
  const px = x - pw / 2
  const py = dotTopY - ph - 2
  drawRoundRect(ctx, px, py, pw, ph, ph / 2)
  ctx.fillStyle = 'rgba(0,0,0,0.82)'; ctx.fill()
  drawRoundRect(ctx, px, py, pw, ph, ph / 2)
  ctx.strokeStyle = color; ctx.globalAlpha = 0.75; ctx.lineWidth = 1; ctx.stroke()
  ctx.globalAlpha = 1
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(label, x, py + ph / 2)
  ctx.restore()
}

const WEAPON_ICON_MAP = {
  'Glock-18': 'glock', 'P2000': 'p2000', 'USP-S': 'usp_silencer',
  'Dual Berettas': 'elite', 'P250': 'p250', 'Five-SeveN': 'fiveseven',
  'Tec-9': 'tec9', 'CZ75-Auto': 'cz75a', 'Desert Eagle': 'deagle',
  'R8 Revolver': 'revolver',
  'AK-47': 'ak47', 'Galil AR': 'galilar', 'FAMAS': 'famas',
  'M4A4': 'm4a1', 'M4A1-S': 'm4a1_silencer', 'AUG': 'aug',
  'SG 553': 'sg556', 'SSG 08': 'ssg08', 'AWP': 'awp',
  'G3SG1': 'g3sg1', 'SCAR-20': 'scar20',
  'MAC-10': 'mac10', 'MP9': 'mp9', 'MP7': 'mp7', 'MP5-SD': 'mp5sd',
  'UMP-45': 'ump45', 'PP-Bizon': 'bizon', 'P90': 'p90',
  'Nova': 'nova', 'XM1014': 'xm1014', 'Sawed-Off': 'sawedoff',
  'MAG-7': 'mag7', 'M249': 'm249', 'Negev': 'negev',
  'Smoke Grenade': 'smokegrenade', 'HE Grenade': 'hegrenade',
  'High Explosive Grenade': 'hegrenade',
  'Flashbang': 'flashbang', 'Flash Grenade': 'flashbang',
  'Molotov': 'molotov', 'Molotov Cocktail': 'molotov',
  'Incendiary Grenade': 'incgrenade', 'Decoy Grenade': 'decoy', 'Decoy': 'decoy',
  'smokegrenade': 'smokegrenade', 'hegrenade': 'hegrenade',
  'flashbang': 'flashbang', 'molotov': 'molotov',
  'inferno': 'molotov', 'incgrenade': 'incgrenade', 'decoy': 'decoy',
  'knife': 'knife_default', 'knife_t': 'knife_t', 'knife_ct': 'knife_default',
  'taser': 'taser', 'c4': 'c4',
}
const WEAPON_CANVAS_ICONS = {}
new Set(Object.values(WEAPON_ICON_MAP)).forEach(name => {
  const img = new Image()
  img.src = `images/weapons/${name}.svg`
  WEAPON_CANVAS_ICONS[name] = img
})

// Lazy-fetch the full match_data for one demo. Slim is used for multi-round
// overlay; full is fetched only when the user enters single-round playback so
// we can render HP/names/weapons/flashes/shots that the slim payload drops.
async function fetchFullMatch(demoId) {
  if (state.fullCache.has(demoId)) return state.fullCache.get(demoId)
  if (state.fullLoading.has(demoId)) return null
  state.fullLoading.add(demoId)
  showChip('Loading round details…', 'info')
  try {
    const { data, error } = await supabase
      .from('demos').select('match_data').eq('id', demoId).single()
    if (error) throw error
    const full = data?.match_data
    if (!full) { showChip('No full data available for this demo', 'warn'); return null }
    state.fullCache.set(demoId, full)
    while (state.fullCache.size > FULL_CACHE_MAX) {
      const oldestKey = state.fullCache.keys().next().value
      state.fullCache.delete(oldestKey)
    }
    return full
  } catch (e) {
    console.error('[analysis] full fetch failed:', e)
    showChip('Failed to load round details', 'error')
    return null
  } finally {
    state.fullLoading.delete(demoId)
    hideChip('Loading round details…')
  }
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
  // Single-round view is tied to a specific round index — invalidate when the set changes
  if (state.viewRoundIdx != null && !state.rounds[state.viewRoundIdx]) state.viewRoundIdx = null
  refreshPlayerPanel()
  refreshUtilPanel()
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
  const TEAM_BASE = { ct: '#4FC3F7', t: '#FF9500' }

  // Single-round playback: triggered by clicking a player icon on the map.
  // Uses full match_data (lazy-fetched) so we can render the same visuals as
  // the demo viewer — HP rings, names, weapons, shots, flashes.
  if (state.viewRoundIdx != null) {
    renderSingleRoundViewerStyle(tc, mapSize)
    return
  }

  // Normal multi-round overlay (team-only). Legend click sets soloSid to filter
  // to a single player across all rounds.
  for (const r of state.rounds) {
    const targetTick = r.freezeEndTick + playback.relTick
    if (targetTick > r.endTick) continue
    const grenades = grenadesForRound(r._payload, r.roundIdx)
    for (const g of grenades) {
      if (g.thrower_team !== r.teamSide) continue
      if (state.utilSoloType && g.type !== state.utilSoloType) continue
      if (state.soloSid && g.thrower_sid !== state.soloSid) continue
      drawGrenade(tc, g, targetTick, tickRate, mapSize, TEAM_BASE[r.teamSide])
    }
  }

  for (const r of state.rounds) {
    const targetTick = r.freezeEndTick + playback.relTick
    if (targetTick > r.endTick) continue
    const frames = framesForRound(r._payload, r.roundIdx)
    if (!frames.length) continue
    const frame = interpolatedPlayers(frames, targetTick)
    if (!frame) continue

    if (playback.showTrails) {
      // Trails still snap to discrete sampled frames (segment count is small).
      let lo = 0, hi = frames.length - 1, idx = 0
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (frames[mid].tick <= targetTick) { idx = mid; lo = mid + 1 } else hi = mid - 1
      }
      const trailFrames = 30
      const trailStart  = Math.max(0, idx - trailFrames)
      ctx.lineWidth = 1.2
      for (const player of frame.players) {
        if (player.team !== r.teamSide) continue
        if (!player.alive) continue
        if (state.soloSid && player.steam_id !== state.soloSid) continue
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

// Lerp between the two frames straddling targetTick so motion is smooth at
// 60fps despite the parser only sampling positions ~4Hz. Works on both slim
// frames (alive) and full frames (is_alive). Skips interpolation across
// alive/dead transitions and gaps larger than MAX_GAP ticks (round resets).
function interpolatedPlayers(frames, targetTick, MAX_GAP = 48) {
  if (!frames.length) return null
  let lo = 0, hi = frames.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (frames[mid].tick <= targetTick) lo = mid
    else hi = mid - 1
  }
  const prev = frames[lo]
  const next = frames[lo + 1]
  if (!next || next.tick <= prev.tick || next.tick - prev.tick > MAX_GAP) return prev
  const t = Math.min(1, Math.max(0, (targetTick - prev.tick) / (next.tick - prev.tick)))
  if (t <= 0) return prev
  const players = prev.players.map(pp => {
    const np = next.players.find(n => n.steam_id === pp.steam_id)
    const aliveP = pp.is_alive ?? pp.alive
    const aliveN = np ? (np.is_alive ?? np.alive) : false
    if (!np || !aliveP || !aliveN) return pp
    const dyaw = (np.yaw - pp.yaw + 540) % 360 - 180
    return {
      ...pp,
      x: pp.x + (np.x - pp.x) * t,
      y: pp.y + (np.y - pp.y) * t,
      yaw: pp.yaw + dyaw * t,
    }
  })
  return { tick: targetTick, players, round_idx: prev.round_idx }
}

// Viewer-style single-round render. Falls back to slim render if full data
// hasn't loaded yet (rare — fetch is awaited before viewRoundIdx is set).
function renderSingleRoundViewerStyle(tc, mapSize) {
  const r = state.rounds[Math.min(state.viewRoundIdx, state.rounds.length - 1)]
  if (!r) return

  const full = state.fullCache.get(r.demoId)
  if (!full) {
    renderSingleRoundSlimFallback(tc, mapSize, r)
    return
  }

  const fullRound = (full.rounds || [])[r.roundIdx]
  if (!fullRound) return
  const tickRate = full.meta?.tick_rate ?? 64
  const startTick = fullRound.freeze_end_tick ?? fullRound.start_tick ?? 0
  const endTick   = fullRound.end_tick ?? startTick
  const targetTick = startTick + playback.relTick   // float — lerp handles sub-tick
  if (targetTick > endTick) return

  // Interpolated frame at targetTick (smooths positions/yaw at 60fps).
  const frame = interpolatedPlayers(full.frames || [], targetTick)
  if (!frame || frame.tick < startTick - 1) return

  // ── Grenades (use slim grenades since they already carry det/throw/trajectory) ──
  const grenades = grenadesForRound(r._payload, r.roundIdx)
  for (const g of grenades) {
    if (state.utilSoloType && g.type !== state.utilSoloType) continue
    drawGrenade(tc, g, targetTick, tickRate, mapSize, viewerPlayerColor(g.thrower_team))
  }

  const dotR       = Math.round(mapSize * 0.009)
  const pillFontSz = Math.round(mapSize * 0.0092)
  const pillFont   = `600 ${pillFontSz}px Inter, system-ui, sans-serif`

  // ── Players (HP rings, blind, damage flash, yaw arrow) ──
  for (const p of frame.players) {
    const { x, y } = tc(p.x, p.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue

    if (!p.is_alive) {
      ctx.save()
      ctx.globalAlpha = 0.28
      ctx.beginPath(); ctx.arc(x, y, dotR * 0.75, 0, Math.PI * 2)
      ctx.fillStyle = '#777'; ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1
      ctx.fill(); ctx.stroke()
      ctx.restore()
      continue
    }

    const id = p.steam_id
    const flashI  = flashIntensity(p)
    const blinded = flashI > 0.06

    if (p.hp != null && p.hp > 0) {
      const arcR = dotR + 3
      ctx.save()
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(x, y, arcR, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.stroke()
      ctx.beginPath()
      ctx.arc(x, y, arcR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, p.hp / 100)))
      ctx.strokeStyle = hpToColor(p.hp); ctx.stroke()
      ctx.restore()
    }

    if (blinded) {
      const ringR = dotR + 5
      ctx.save()
      ctx.beginPath(); ctx.arc(x, y, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = viewerPlayerColor(p.team); ctx.lineWidth = 1.5; ctx.globalAlpha = 0.7
      ctx.stroke()
      ctx.restore()
    }

    if (playback.playing && _prevHp[id] != null && p.hp < _prevHp[id]) {
      _flashUntil[id] = Date.now() + 350
    }
    _prevHp[id] = p.hp

    let color
    if (blinded) {
      const [tr, tg, tb] = p.team === 'ct' ? [79, 195, 247] : [255, 149, 0]
      const fr = Math.round(255 * flashI + tr * (1 - flashI))
      const fg = Math.round(255 * flashI + tg * (1 - flashI))
      const fb = Math.round(255 * flashI + tb * (1 - flashI))
      color = `rgb(${fr},${fg},${fb})`
    } else {
      color = (Date.now() < (_flashUntil[id] ?? 0)) ? '#FF1744' : viewerPlayerColor(p.team)
    }

    if (p.yaw != null) {
      const yawRad = p.yaw * Math.PI / 180
      const dir = tc(p.x + Math.cos(yawRad) * 300, p.y + Math.sin(yawRad) * 300)
      const angle = Math.atan2(dir.y - y, dir.x - x)
      const notchAngle = 22 * Math.PI / 180
      const tipDist = dotR * 0.45
      ctx.save()
      ctx.beginPath()
      ctx.arc(x, y, dotR, angle + notchAngle, angle - notchAngle)
      ctx.lineTo(x + Math.cos(angle) * (dotR + tipDist), y + Math.sin(angle) * (dotR + tipDist))
      ctx.closePath()
      ctx.fillStyle = color; ctx.strokeStyle = 'rgba(255,255,255,0.88)'; ctx.lineWidth = 1.5
      ctx.fill(); ctx.stroke()
      ctx.beginPath(); ctx.arc(x, y, dotR * 0.28, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.82)'; ctx.fill()
      ctx.restore()
    } else {
      ctx.save()
      ctx.beginPath(); ctx.arc(x, y, dotR, 0, Math.PI * 2)
      ctx.fillStyle = color; ctx.strokeStyle = 'rgba(255,255,255,0.88)'; ctx.lineWidth = 1.5
      ctx.fill(); ctx.stroke()
      ctx.restore()
    }
  }

  // ── Name pills + weapon icons (above each living player) ──
  const playersMeta = full.players_meta || {}
  for (const p of frame.players) {
    if (!p.is_alive) continue
    const { x, y } = tc(p.x, p.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const name = (playersMeta[p.steam_id]?.name ?? p.name ?? '').slice(0, 13)
    drawPlayerPill(x, y - dotR, name, viewerPlayerColor(p.team), pillFont, pillFontSz)

    const rawWeapon = (p.weapon || '').replace('weapon_', '')
    const iconName  = WEAPON_ICON_MAP[rawWeapon] ?? rawWeapon
    const wIcon     = WEAPON_CANVAS_ICONS[iconName]
    if (wIcon && wIcon.complete && wIcon.naturalWidth) {
      const sz = Math.round(mapSize * 0.018)
      const ph = pillFontSz + 5
      const py = (y - dotR) - ph - 2
      ctx.drawImage(wIcon, x - sz / 2, py - sz - 2, sz, sz)
    }
  }

  // ── Shot beams + muzzle flashes ──
  const shots = full.shots || []
  const BEAM_DURATION = 9
  ctx.save(); ctx.lineCap = 'round'
  for (const shot of shots) {
    if (shot.tick < startTick || shot.tick > targetTick) continue
    const age = targetTick - shot.tick
    if (age > BEAM_DURATION) continue
    const player = frame.players.find(p => p.steam_id === shot.steam_id)
    if (!player || !player.is_alive || player.yaw == null) continue
    const { x, y } = tc(player.x, player.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const fade   = 1 - age / BEAM_DURATION
    const yawRad = player.yaw * Math.PI / 180
    const beam   = tc(player.x + Math.cos(yawRad) * 520, player.y + Math.sin(yawRad) * 520)
    const isct   = player.team === 'ct'
    const teamRgb = isct ? '79,195,247' : '255,149,0'
    const teamHex = isct ? CT_COLOR : T_COLOR

    const glowGrad = ctx.createLinearGradient(x, y, beam.x, beam.y)
    glowGrad.addColorStop(0,    `rgba(${teamRgb},${(fade * 0.35).toFixed(2)})`)
    glowGrad.addColorStop(0.55, `rgba(${teamRgb},${(fade * 0.15).toFixed(2)})`)
    glowGrad.addColorStop(1,    `rgba(${teamRgb},0)`)
    ctx.globalAlpha = 1; ctx.strokeStyle = glowGrad; ctx.lineWidth = 5.5
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(beam.x, beam.y); ctx.stroke()

    const coreGrad = ctx.createLinearGradient(x, y, beam.x, beam.y)
    coreGrad.addColorStop(0,    `rgba(255,255,255,${(fade * 0.95).toFixed(2)})`)
    coreGrad.addColorStop(0.45, `rgba(255,255,255,${(fade * 0.55).toFixed(2)})`)
    coreGrad.addColorStop(1,    'rgba(255,255,255,0)')
    ctx.strokeStyle = coreGrad; ctx.lineWidth = 1.3
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(beam.x, beam.y); ctx.stroke()

    if (age <= 3) {
      const ft = age / 3
      ctx.globalAlpha = (1 - ft) * 0.85
      ctx.beginPath(); ctx.arc(x, y, mapSize * 0.005 + mapSize * 0.015 * ft, 0, Math.PI * 2)
      ctx.strokeStyle = teamHex; ctx.lineWidth = 1.5; ctx.stroke()
      ctx.globalAlpha = (1 - ft) * 0.75
      ctx.beginPath(); ctx.arc(x, y, mapSize * 0.0045 * (1 - ft * 0.6), 0, Math.PI * 2)
      ctx.fillStyle = '#fff'; ctx.fill()
    }
  }
  ctx.restore()
}

// Slim-only fallback used while full match_data is still loading. Uses team
// colors and yaw arrows but no HP/names/weapons (those fields are stripped).
function renderSingleRoundSlimFallback(tc, mapSize, r) {
  const tickRate = state.rounds[0]?._payload?.meta?.tick_rate ?? 64
  const targetTick = r.freezeEndTick + playback.relTick
  if (targetTick > r.endTick) return

  const grenades = grenadesForRound(r._payload, r.roundIdx)
  for (const g of grenades) {
    if (state.utilSoloType && g.type !== state.utilSoloType) continue
    drawGrenade(tc, g, targetTick, tickRate, mapSize, viewerPlayerColor(g.thrower_team))
  }

  const frame = interpolatedPlayers(framesForRound(r._payload, r.roundIdx), targetTick)
  if (!frame) return
  for (const player of frame.players) {
    drawPlayer(tc, player, viewerPlayerColor(player.team), mapSize)
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
  refreshSoloRoundNav()
}

function refreshSoloRoundNav() {
  const nav = document.getElementById('pp-round-nav')
  if (!nav) return
  if (state.viewRoundIdx == null || !state.rounds.length) {
    nav.style.display = 'none'
    return
  }
  nav.style.display = 'flex'
  const r = state.rounds[state.viewRoundIdx]
  const sideLabel = r ? r.teamSide.toUpperCase() : '?'
  const pl = state.gren.playlist
  document.getElementById('pp-round-label').textContent =
    (pl && pl.length)
      ? `Playlist ${state.gren.playlistPos + 1} / ${pl.length} · ${sideLabel}`
      : `Round ${state.viewRoundIdx + 1} / ${state.rounds.length} · ${sideLabel}`
}

async function gotoSoloRound(delta) {
  if (state.viewRoundIdx == null || !state.rounds.length) return
  // Playlist mode: prev/next walk only the selected rounds, not the full set.
  const pl = state.gren.playlist
  let next
  if (pl && pl.length) {
    state.gren.playlistPos = (state.gren.playlistPos + delta + pl.length) % pl.length
    next = pl[state.gren.playlistPos]
  } else {
    const n = state.rounds.length
    next = (state.viewRoundIdx + delta + n) % n
  }
  const r = state.rounds[next]
  if (r) await fetchFullMatch(r.demoId)
  state.viewRoundIdx = next
  playback.relTick = 0
  recomputePlaybackBounds()
  updateTimelineUi()
  refreshSoloRoundNav()
  render()
}

function exitSingleRound() {
  if (state.viewRoundIdx == null) return
  const prev = playback.relTick
  state.viewRoundIdx = null
  // Exiting single-round always cancels the playlist — the user clicked away.
  state.gren.playlist    = null
  state.gren.playlistPos = 0
  recomputePlaybackBounds()
  // Preserve playback time across the transition (multi-round bound is the
  // longest round, so the previous tick is always within the new max).
  playback.relTick = Math.min(prev, playback.maxTick)
  updateTimelineUi()
  refreshSoloRoundNav()
  render()
}

document.getElementById('pp-clear').addEventListener('click', () => {
  state.soloSid = null
  refreshPlayerPanel()
  render()
})

document.getElementById('pp-round-prev').addEventListener('click', () => gotoSoloRound(-1))
document.getElementById('pp-round-next').addEventListener('click', () => gotoSoloRound(+1))

// Click a player icon on the map → enter single-round playback for that round
// at the current playback time (seamless transition). Click anywhere on the map
// while in single-round mode → exit back to multi-round overlay.
canvas.addEventListener('click', async e => {
  if (state.mode !== 'overlay' || !state.rounds.length) return

  // In single-round mode any click exits — no hit test needed.
  if (state.viewRoundIdx != null) {
    exitSingleRound()
    return
  }

  const rect = canvas.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top

  const cw = canvas.width
  const ch = canvas.height
  const mapSize = Math.min(cw, ch)
  const mapX    = Math.round((cw - mapSize) / 2)
  const mapY    = Math.round((ch - mapSize) / 2)
  const tc = (wx, wy) => {
    const { x, y } = worldToCanvas(wx, wy, state.filters.map, mapSize, mapSize)
    return { x: x + mapX, y: y + mapY }
  }
  const dotR = Math.max(3, Math.round(mapSize * 0.009))
  const hitR = dotR * 1.8

  let best = null
  for (const r of state.rounds) {
    const targetTick = r.freezeEndTick + playback.relTick
    if (targetTick > r.endTick) continue
    const frames = framesForRound(r._payload, r.roundIdx)
    if (!frames.length) continue
    const frame = interpolatedPlayers(frames, targetTick)
    if (!frame) continue
    for (const p of frame.players) {
      if (p.team !== r.teamSide) continue
      if (state.soloSid && p.steam_id !== state.soloSid) continue
      if (!p.alive) continue
      const { x, y } = tc(p.x, p.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy)
      if (d2 <= hitR * hitR && (!best || d2 < best.d2)) best = { d2, round: r }
    }
  }
  if (!best) return

  const idx = state.rounds.indexOf(best.round)
  if (idx < 0) return

  // Fetch full match_data BEFORE entering single-round so the viewer-style
  // render can use HP/names/weapons/shots from the very first frame.
  await fetchFullMatch(best.round.demoId)

  state.viewRoundIdx = idx
  // Preserve current playback time, clamped to this round's length, for a
  // seamless transition into single-round playback.
  recomputePlaybackBounds()
  if (playback.relTick > playback.maxTick) playback.relTick = playback.maxTick
  updateTimelineUi()
  refreshSoloRoundNav()
  render()
})

// ── Grenade mode: drag-rectangle selection ────────────────────────────
// Drag inside the canvas to select trajectories whose landing point falls
// within the rectangle. A click without drag (<4px) clears any selection.
const DRAG_CLICK_THRESHOLD = 4
let _grenDragInProgress = false

function canvasMapTransform() {
  const cw = canvas.width, ch = canvas.height
  const mapSize = Math.min(cw, ch)
  const mapX = Math.round((cw - mapSize) / 2)
  const mapY = Math.round((ch - mapSize) / 2)
  const tc = (wx, wy) => {
    const { x, y } = worldToCanvas(wx, wy, state.filters.map, mapSize, mapSize)
    return { x: x + mapX, y: y + mapY }
  }
  return { tc, mapSize }
}

canvas.addEventListener('mousedown', e => {
  if (state.mode !== 'grenade' || !state.rounds.length) return
  if (e.button !== 0) return
  const rect = canvas.getBoundingClientRect()
  const x = e.clientX - rect.left, y = e.clientY - rect.top
  state.gren.drag = { x0: x, y0: y, x1: x, y1: y }
  _grenDragInProgress = true
})

canvas.addEventListener('mousemove', e => {
  if (!_grenDragInProgress || !state.gren.drag) return
  const rect = canvas.getBoundingClientRect()
  state.gren.drag.x1 = e.clientX - rect.left
  state.gren.drag.y1 = e.clientY - rect.top
  render()
})

window.addEventListener('mouseup', e => {
  if (!_grenDragInProgress) return
  _grenDragInProgress = false
  const d = state.gren.drag
  state.gren.drag = null
  if (!d) { render(); return }

  const dx = Math.abs(d.x1 - d.x0), dy = Math.abs(d.y1 - d.y0)

  // Click without drag → clear selection
  if (dx < DRAG_CLICK_THRESHOLD && dy < DRAG_CLICK_THRESHOLD) {
    state.gren.selectedKeys.clear()
    refreshGrenSelection()
    render()
    return
  }

  const { tc } = canvasMapTransform()
  const left = Math.min(d.x0, d.x1), right  = Math.max(d.x0, d.x1)
  const top  = Math.min(d.y0, d.y1), bottom = Math.max(d.y0, d.y1)

  state.gren.selectedKeys.clear()
  for (const r of state.rounds) {
    const grenades = grenadesForRound(r._payload, r.roundIdx)
    for (const g of grenades) {
      if (!grenadePassesFilters(g, r)) continue
      const { x, y } = tc(g.land_x, g.land_y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x >= left && x <= right && y >= top && y <= bottom) {
        state.gren.selectedKeys.add(`${r.demoId}|${r.roundIdx}|${g.throw_tick}`)
      }
    }
  }
  refreshGrenSelection()
  render()
})

function opponentForDemo(demoId) {
  const demo = state.corpus.find(d => d.id === demoId)
  if (!demo) return '?'
  return demo.ct_team_name === state.team ? demo.t_team_name : demo.ct_team_name
}

const GREN_TYPE_LABEL = { smoke: 'Smoke', molotov: 'Molotov', flash: 'Flash', he: 'HE' }

function refreshGrenSelection() {
  const panel  = document.getElementById('gp-selection')
  const listEl = document.getElementById('gp-sel-list')
  const statEl = document.getElementById('gp-sel-stat')
  const btn    = document.getElementById('gp-play-selection')
  if (!panel || !listEl || !statEl || !btn) return

  const n = state.gren.selectedKeys.size
  if (n === 0) { panel.style.display = 'none'; return }
  panel.style.display = 'flex'

  // Resolve selection keys back to grenade objects (with their owning round)
  // so we can render rich rows. Build an index for O(1) lookups.
  const byKey = new Map()
  const roundsSet = new Set()
  for (const r of state.rounds) {
    for (const g of grenadesForRound(r._payload, r.roundIdx)) {
      byKey.set(`${r.demoId}|${r.roundIdx}|${g.throw_tick}`, { g, r })
    }
  }

  const rows = []
  for (const key of state.gren.selectedKeys) {
    const hit = byKey.get(key); if (!hit) continue
    const { g, r } = hit
    roundsSet.add(`${r.demoId}|${r.roundIdx}`)
    const tickRate = r._payload?.meta?.tick_rate ?? 64
    const sec = Math.max(0, Math.round((g.throw_tick - r.freezeEndTick) / tickRate))
    const playersMeta = r._payload?.meta?.players || {}
    rows.push({
      key,
      type:     g.type,
      sec,
      name:     playersMeta[g.thrower_sid]?.name || g.thrower_sid?.slice(-5) || '?',
      opponent: opponentForDemo(r.demoId),
      sortKey:  sec * 1e6 + r.roundIdx,
    })
  }
  rows.sort((a, b) => a.sortKey - b.sortKey)

  const totalRounds = state.rounds.length
  const pct = totalRounds > 0 ? Math.round((roundsSet.size / totalRounds) * 100) : 0
  statEl.textContent = `${roundsSet.size} / ${totalRounds} rounds · ${pct}%`

  const fmtTime = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  listEl.innerHTML = rows.map(it => `
    <div class="gp-sel-row" data-key="${it.key}">
      <span class="gp-sel-dot ${it.type}"></span>
      <div class="gp-sel-meta">
        <span class="gp-sel-name">${escapeHtml(it.name)}</span>
        <span class="gp-sel-sub">${GREN_TYPE_LABEL[it.type] || it.type} · vs ${escapeHtml(it.opponent)}</span>
      </div>
      <span class="gp-sel-time">${fmtTime(it.sec)}</span>
    </div>
  `).join('')

  btn.textContent = roundsSet.size <= 1 ? 'Play round' : `Play ${roundsSet.size} rounds`
}


async function playSelectionAsPlaylist() {
  if (state.gren.selectedKeys.size === 0) return
  // Build ordered playlist of unique state.rounds[] indices that contain a
  // selected grenade. Order = the order rounds appear in state.rounds[].
  const wanted = new Set()
  for (const key of state.gren.selectedKeys) {
    const [demoId, roundIdxStr] = key.split('|')
    wanted.add(`${demoId}|${roundIdxStr}`)
  }
  const playlist = []
  for (let i = 0; i < state.rounds.length; i++) {
    const r = state.rounds[i]
    if (wanted.has(`${r.demoId}|${r.roundIdx}`)) playlist.push(i)
  }
  if (!playlist.length) return

  state.gren.playlist    = playlist
  state.gren.playlistPos = 0
  state.mode = 'overlay'
  writeUrl()
  applyMode()

  const firstIdx = playlist[0]
  await fetchFullMatch(state.rounds[firstIdx].demoId)
  state.viewRoundIdx = firstIdx
  playback.relTick   = 0
  recomputePlaybackBounds()
  // Auto-play — the user picked a playlist; they want it rolling.
  playback.playing = true
  document.getElementById('play-btn').textContent = '⏸'
  updateTimelineUi()
  refreshSoloRoundNav()
  render()
}

document.getElementById('gp-play-selection')?.addEventListener('click', playSelectionAsPlaylist)

const UTIL_TYPES = [
  { type: 'smoke',   label: 'Smoke',    color: '#b3b3b3' },
  { type: 'molotov', label: 'Molotov',  color: '#ff7a30' },
  { type: 'flash',   label: 'Flash',    color: '#ffeb55' },
  { type: 'he',      label: 'HE',       color: '#dc3232' },
]

function refreshUtilPanel() {
  const listEl  = document.getElementById('pp-util-list')
  const clearEl = document.getElementById('pp-util-clear')
  if (!listEl) return

  listEl.innerHTML = UTIL_TYPES.map(u => `
    <div class="pp-item ${state.utilSoloType === u.type ? 'active' : ''}" data-util="${u.type}">
      <span class="pp-swatch" style="background:${u.color}"></span>
      <span>${u.label}</span>
    </div>
  `).join('')

  clearEl.style.display = state.utilSoloType ? 'block' : 'none'

  for (const el of listEl.querySelectorAll('.pp-item')) {
    el.addEventListener('click', () => {
      const t = el.dataset.util
      state.utilSoloType = (state.utilSoloType === t) ? null : t
      refreshUtilPanel()
      render()
    })
  }
}

document.getElementById('pp-util-clear').addEventListener('click', () => {
  state.utilSoloType = null
  refreshUtilPanel()
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
// Panel refresh = update count + sync type pills + sync time slider thumbs.
// The list of individual grenades was dropped — selection happens on the
// canvas via drag-rect.
function refreshGrenadePanel() {
  const countEl = document.getElementById('gp-count')
  if (!countEl) return

  let count = 0
  for (const r of state.rounds) {
    for (const g of grenadesForRound(r._payload, r.roundIdx)) {
      if (grenadePassesFilters(g, r)) count++
    }
  }
  countEl.textContent = `${count} grenade${count === 1 ? '' : 's'}`

  for (const btn of document.querySelectorAll('#gp-type-pills .seg-btn')) {
    btn.classList.toggle('active', state.gren.types.has(btn.dataset.v))
  }

  const minEl = document.getElementById('gp-time-min')
  const maxEl = document.getElementById('gp-time-max')
  const readout = document.getElementById('gp-time-readout')
  if (minEl) minEl.value = state.gren.timeMin
  if (maxEl) maxEl.value = state.gren.timeMax
  if (readout) readout.textContent = `${state.gren.timeMin}–${state.gren.timeMax}s`
}

function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML
}

document.getElementById('gp-type-pills')?.addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn'); if (!btn) return
  const t = btn.dataset.v
  if (state.gren.types.has(t)) state.gren.types.delete(t)
  else                         state.gren.types.add(t)
  state.gren.selectedKeys.clear()  // filter changed → previous selection may now be invisible
  refreshGrenadePanel()
  refreshGrenSelection()
  render()
})

;(function wireTimeRange() {
  const minEl = document.getElementById('gp-time-min')
  const maxEl = document.getElementById('gp-time-max')
  if (!minEl || !maxEl) return
  const onInput = e => {
    let lo = +minEl.value, hi = +maxEl.value
    // Keep the handles from crossing.
    if (lo >= hi) {
      if (e.target === minEl) lo = Math.max(0, hi - 1)
      else                    hi = Math.min(+maxEl.max, lo + 1)
      minEl.value = lo; maxEl.value = hi
    }
    state.gren.timeMin = lo
    state.gren.timeMax = hi
    state.gren.selectedKeys.clear()
    refreshGrenadePanel()
    refreshGrenSelection()
    render()
  }
  minEl.addEventListener('input', onInput)
  maxEl.addEventListener('input', onInput)
})();

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
  if (state.mode === 'grenade') {
    // Switching INTO grenade mode while a playlist is in flight would leave
    // single-round playback orphaned. Drop out of it cleanly first.
    if (state.viewRoundIdx != null) exitSingleRound()
    refreshGrenadePanel()
    refreshGrenSelection()
  }
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

// Antistrat drawer (no-op on narrow viewports).
mountAntistratDrawer({ teamId: getTeamId() })

