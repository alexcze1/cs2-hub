import { requireAuth }           from './auth.js'
import { renderSidebar }         from './layout.js'
import { supabase }              from './supabase.js'
import { attachTeamAutocomplete } from './team-autocomplete.js'

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
  state.filters[key] = value
  writeUrl()
  renderFilterRail()  // re-render so segmented active state updates
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
  // Stub — Task 9 fills this in. For now just update the readout to a placeholder.
  const rEl = document.getElementById('f-rounds')
  const dEl = document.getElementById('f-demos')
  if (rEl) rEl.textContent = '…'
  if (dEl) dEl.textContent = String(state.corpus.length)
}

// Export for tests (no-op in browser)
export { state, readUrl, writeUrl }
