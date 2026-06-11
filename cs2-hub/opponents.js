// cs2-hub/opponents.js
import { requireAuth } from './auth.js'
import { renderSidebar, renderToolHeader } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { getTeamLogo, teamLogoEl } from './team-autocomplete.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

export function deriveOpponentStats(opponents, historyIndex) {
  const total = opponents.length
  if (total === 0) return { total: 0, withMaps: 0, threats: 0, favored: 0, mapsCovered: 0, topMap: null }
  let withMaps = 0, threats = 0, favored = 0
  const mapCounts = new Map()   // map -> { n, firstIdx }
  for (let i = 0; i < opponents.length; i++) {
    const o = opponents[i]
    const maps = o.favored_maps ?? []
    if (maps.length > 0) withMaps++
    for (const m of maps) {
      const e = mapCounts.get(m)
      if (e) e.n++; else mapCounts.set(m, { n: 1, firstIdx: i })
    }
    const h = historyIndex?.[(o.name ?? '').trim().toLowerCase()]
    if (h && h.matches >= 2) {
      const wp = (h.mw / h.matches) * 100
      if (wp <= 33) threats++
      else if (wp >= 67) favored++
    }
  }
  let topMap = null, top = 0, topIdx = Infinity
  for (const [k, { n, firstIdx }] of mapCounts) {
    if (n > top || (n === top && firstIdx < topIdx)) { topMap = k; top = n; topIdx = firstIdx }
  }
  return { total, withMaps, threats, favored, mapsCovered: mapCounts.size, topMap }
}

// Returns 'strong' | 'even' | 'weak' | 'new' for an opponent given its history row.
export function opponentThreatClass(history) {
  if (!history || history.matches === 0) return 'new'
  if (history.matches < 2) return 'new'
  const wp = (history.mw / history.matches) * 100
  if (wp <= 33) return 'strong'
  if (wp >= 67) return 'weak'
  return 'even'
}

export function filterOpponents(opponents, filter, historyIndex) {
  const q = (filter.q ?? '').toLowerCase().trim()
  return opponents.filter(o => {
    if (filter.map !== 'all') {
      if (!(o.favored_maps ?? []).includes(filter.map)) return false
    }
    if (filter.threat !== 'all') {
      const h = historyIndex?.[(o.name ?? '').trim().toLowerCase()]
      if (opponentThreatClass(h) !== filter.threat) return false
    }
    if (!q) return true
    return (o.name ?? '').toLowerCase().includes(q)
  })
}

const MAP_IMG = { dust2: 'dust' }
function mapChip(map) {
  const src = `images/maps/${MAP_IMG[map] ?? map}.png`
  return `<div class="intel-map-chip">
    <img src="${esc(src)}" aria-hidden="true">
    <span>${esc(map.slice(0,3).toUpperCase())}</span>
  </div>`
}

function buildHistoryIndex(vods) {
  const idx = {}
  for (const v of vods ?? []) {
    const key = (v.opponent ?? v.title ?? '').trim().toLowerCase()
    if (!key) continue
    const r = idx[key] ??= { matches: 0, mw: 0, ml: 0 }
    let mw = 0, ml = 0
    for (const m of v.maps ?? []) {
      if ((m.score_us ?? 0) > (m.score_them ?? 0)) mw++
      else if ((m.score_them ?? 0) > (m.score_us ?? 0)) ml++
    }
    r.matches++
    if (mw > ml) r.mw++
    else if (ml > mw) r.ml++
  }
  return idx
}

function threatTag(history) {
  if (!history || history.matches === 0) return { cls: 'new',    label: 'No History' }
  const wp = history.matches ? Math.round((history.mw / history.matches) * 100) : 0
  if (history.matches < 2)         return { cls: 'new',    label: `${history.mw}W — ${history.ml}L` }
  if (wp <= 33)                    return { cls: 'strong', label: `Threat · ${wp}%` }
  if (wp >= 67)                    return { cls: 'weak',   label: `Favored · ${wp}%` }
  return                                  { cls: 'even',   label: `Even · ${wp}%` }
}

const MAPS = ['ancient', 'mirage', 'nuke', 'anubis', 'inferno', 'overpass', 'dust2']
const MAP_LABELS = { ancient:'Ancient', mirage:'Mirage', nuke:'Nuke', anubis:'Anubis', inferno:'Inferno', overpass:'Overpass', dust2:'Dust2' }
function mapFile(map) { return MAP_IMG[map] ?? map }
function mapBg(map)   { return map ? `images/maps/${mapFile(map)}.png` : '' }

await requireAuth()
renderSidebar('opponents')

const FILTER_LS_KEY = 'opponents:filter:v1'
const DEFAULT_FILTER = { map: 'all', threat: 'all', q: '' }
function loadSavedFilter() {
  try { return { ...DEFAULT_FILTER, ...JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '{}') } }
  catch { return { ...DEFAULT_FILTER } }
}
function saveFilter(f) { try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify(f)) } catch {} }

const state = {
  filter: loadSavedFilter(),
  opponents: [],
  history: {},
  logos: [],          // index-aligned with opponents
}

const heroEl    = document.getElementById('opp-hero')
const filtersEl = document.getElementById('opp-filters')
const listEl    = document.getElementById('opponents-list')

const teamId = getTeamId()

async function loadAll() {
  const [{ data: opponents, error }, { data: vods }] = await Promise.all([
    supabase.from('opponents').select('*').eq('team_id', teamId).order('name', { ascending: true }),
    supabase.from('vods').select('opponent, title, maps').eq('team_id', teamId).eq('dismissed', false),
  ])
  if (error) {
    heroEl.innerHTML = ''
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">Failed to load opponents</h3>${esc(error.message)}</div>`
    return
  }
  state.opponents = opponents ?? []
  state.history   = buildHistoryIndex(vods)
  state.logos     = await Promise.all(state.opponents.map(o => getTeamLogo(o.name)))
  renderAll()
}

// ── Hero ──────────────────────────────────────────────────────
function renderHero() {
  const s = deriveOpponentStats(state.opponents, state.history)
  renderToolHeader(heroEl, {
    section: 'Preparation',
    title: 'Opponents',
    sub: 'Anti-strat book — tendencies, favored maps and threat level per team you face.',
    kpis: [
      { v: s.total, k: s.total === 1 ? 'team' : 'teams' },
      { v: s.withMaps, k: 'with maps' },
      { v: s.threats, k: 'threats', tone: s.threats ? 'bad' : '' },
      { v: s.favored, k: 'favored', tone: s.favored ? 'good' : '' },
      { v: s.mapsCovered, k: 'maps covered' },
    ],
    actions: `<a class="dx-upload-cta" href="opponent-detail.html">+ Add Team</a>`,
  })
}

// ── Filters ───────────────────────────────────────────────────
function renderFilters() {
  const f = state.filter
  const mapPill = (val, label) =>
    `<button type="button" class="dx-pill ${f.map === val ? 'is-active' : ''}" data-group="map" data-val="${esc(val)}">${esc(label)}</button>`
  const threatPill = (val, label) =>
    `<button type="button" class="dx-pill ${f.threat === val ? 'is-active' : ''}" data-group="threat" data-val="${esc(val)}">${esc(label)}</button>`

  filtersEl.innerHTML = `
    <div class="dx-filter-row">
      <div class="dx-filter-group">
        ${mapPill('all', 'All Maps')}
        ${MAPS.map(m => mapPill(m, MAP_LABELS[m])).join('')}
      </div>
    </div>
    <div class="dx-filter-row" style="margin-top:8px">
      <div class="dx-filter-group">
        ${threatPill('all',    'All Threats')}
        ${threatPill('strong', 'Threats')}
        ${threatPill('even',   'Even')}
        ${threatPill('weak',   'Favored')}
        ${threatPill('new',    'No History')}
      </div>
      <div class="dx-filter-spacer"></div>
      <input type="search" class="dx-search-input" id="opp-search" placeholder="Search opponents…" value="${esc(f.q)}"/>
    </div>`

  for (const btn of filtersEl.querySelectorAll('.dx-pill')) {
    btn.addEventListener('click', () => {
      const g = btn.dataset.group, v = btn.dataset.val
      if (state.filter[g] === v) return
      state.filter = { ...state.filter, [g]: v }
      saveFilter(state.filter)
      renderFilters(); renderList()
    })
  }
  document.getElementById('opp-search').addEventListener('input', e => {
    state.filter = { ...state.filter, q: e.target.value }
    saveFilter(state.filter)
    renderList()
  })
}

// ── List ──────────────────────────────────────────────────────
function renderList() {
  const filtered = filterOpponents(state.opponents, state.filter, state.history)
  if (state.opponents.length === 0) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">No opponents yet</h3>Add a team before your next match.</div>`
    return
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="dx-empty">No opponents match the current filters.</div>`
    return
  }
  const oppIndex = new Map(state.opponents.map((o, i) => [o.id, i]))
  listEl.innerHTML = `<div class="intel-grid">${filtered.map(o => opponentCard(o, state.logos[oppIndex.get(o.id)])).join('')}</div>`
}

function opponentCard(o, logo) {
  const h = state.history[(o.name ?? '').trim().toLowerCase()]
  const tag = threatTag(h)
  const topMap = (o.favored_maps ?? [])[0]
  const wash = topMap ? mapBg(topMap) : ''
  return `
    <a class="intel-card ${wash ? 'intel-card-has-wash' : ''}" href="opponent-detail.html?id=${esc(o.id)}">
      ${wash ? `<div class="intel-card-wash" style="background-image:url('${esc(wash)}')"></div>` : ''}
      <div class="intel-head">
        ${teamLogoEl(logo, o.name, 36)}
        <div class="intel-name">${esc(o.name)}</div>
        <span class="intel-tag intel-tag-${tag.cls}">${tag.label}</span>
      </div>
      <div class="intel-section-label">Favored maps</div>
      ${o.favored_maps?.length
        ? `<div class="intel-maps">${o.favored_maps.map(mapChip).join('')}</div>`
        : `<div class="intel-empty">No maps noted</div>`}
    </a>
  `
}

function renderAll() { renderHero(); renderFilters(); renderList() }

loadAll()
