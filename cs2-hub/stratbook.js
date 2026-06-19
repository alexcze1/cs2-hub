import { requireAuth } from './auth.js'
import { renderSidebar, renderToolHeader } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'
import { STRAT_SEEDS } from './strat-seed.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function relTime(iso) {
  if (!iso) return ''
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (d < 1) return 'today'
  if (d < 30) return `${d}d ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

const MAP_IMG = { dust2: 'dust' }
function mapFile(map) { return MAP_IMG[map] ?? map }
function mapIcon(map) {
  const file = mapFile(map)
  const url = `images/maps/${file}.png`
  const abbr = String(map ?? '').slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return `<div class="map-badge"><img src="${url}" alt="${esc(map)}" onerror="this.parentElement.innerHTML='<span>${abbr}</span>'"/></div>`
}
function mapBg(map) { return map ? `images/maps/${mapFile(map)}.png` : '' }

await requireAuth()
renderSidebar('stratbook')

const TYPE_META = {
  default:  { label: 'Default',  color: '#94a3b8' },
  opening:  { label: 'Opening',  color: '#f97316' },
  script:   { label: 'Script',   color: '#60a5fa' },
  ender:    { label: 'Ender',    color: '#4ade80' },
  force:    { label: 'Force',    color: '#f87171' },
  anti_eco: { label: 'Anti-Eco', color: '#c084fc' },
  pistol:   { label: 'Pistol',   color: '#facc15' },
  setup:    { label: 'Setup',    color: '#22d3ee' },
  other:    { label: 'Other',    color: '#64748b' },
}

const MAPS = ['ancient', 'mirage', 'nuke', 'anubis', 'inferno', 'overpass', 'dust2']

const FILTER_LS_KEY = 'stratbook:filter:v1'
const DEFAULT_FILTER = { map: 'all', side: 'all', type: 'all', q: '' }
function loadSavedFilter() {
  try { return { ...DEFAULT_FILTER, ...JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '{}') } }
  catch { return { ...DEFAULT_FILTER } }
}
function saveFilter(f) { try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify(f)) } catch {} }

const state = {
  filter: loadSavedFilter(),
  strats: [],
}

const heroEl    = document.getElementById('sb-hero')
const filtersEl = document.getElementById('sb-filters')
const listEl    = document.getElementById('strats-list')

async function loadStrats() {
  const { data, error } = await supabase
    .from('strats').select('*')
    .eq('team_id', getTeamId())
    .order('map').order('side').order('created_at', { ascending: false })
  if (error) {
    listEl.innerHTML = `<div class="empty-state"><h3>Failed to load strats</h3><p>${esc(error.message)}</p></div>`
    return
  }
  state.strats = data ?? []
  renderAll()
}

function getFiltered() {
  const f = state.filter
  const q = f.q.toLowerCase().trim()
  return state.strats.filter(s =>
    (f.map  === 'all' || s.map  === f.map)  &&
    (f.side === 'all' || s.side === f.side) &&
    (f.type === 'all' || s.type === f.type) &&
    (!q || s.name?.toLowerCase().includes(q))
  )
}

// ── Hero ──────────────────────────────────────────────────────
function renderHero() {
  const all = state.strats
  const total = all.length
  const tCount  = all.filter(s => s.side === 't').length
  const ctCount = all.filter(s => s.side === 'ct').length
  const mapCounts = {}
  for (const s of all) mapCounts[s.map] = (mapCounts[s.map] || 0) + 1
  let topMap = null, topMapN = 0
  for (const [m, n] of Object.entries(mapCounts)) if (n > topMapN) { topMap = m; topMapN = n }
  const openings = all.filter(s => s.type === 'opening').length

  renderToolHeader(heroEl, {
    section: 'Preparation',
    title: 'Stratbook',
    sub: 'Your team’s playbook — executes, defaults and set pieces by map and side.',
    kpis: [
      { v: total, k: total === 1 ? 'strat' : 'strats' },
      { v: tCount, k: 'T-side', tone: 't' },
      { v: ctCount, k: 'CT-side', tone: 'ct' },
      { v: openings, k: 'openings' },
      { v: topMap ? capitalize(topMap) : '—', k: 'top map' },
    ],
    actions: `
      <a class="dx-upload-cta" href="stratbook-detail.html">+ New Strat</a>
      <a class="dx-ghost-cta" id="sb-match-view" href="stratbook-fullscreen.html" target="_blank">Match View</a>
      ${total === 0 ? '<button type="button" class="dx-ghost-cta" id="sb-seed-btn">Import starter pack</button>' : ''}`,
  })
  syncMatchViewHref()

  // #33 — Import starter pack. Only present when the stratbook is
  // empty; pulls STRAT_SEEDS, stamps team_id, inserts.
  const seedBtn = document.getElementById('sb-seed-btn')
  if (seedBtn) {
    seedBtn.addEventListener('click', async () => {
      if (!confirm(`Add ${STRAT_SEEDS.length} starter strats to your stratbook?`)) return
      seedBtn.disabled = true
      seedBtn.textContent = 'Importing…'
      const tid = getTeamId()
      const rows = STRAT_SEEDS.map(s => ({ ...s, team_id: tid }))
      const { error } = await supabase.from('strats').insert(rows)
      if (error) {
        toast(`Import failed: ${error.message}`, 'error')
        seedBtn.disabled = false
        seedBtn.textContent = 'Import starter pack'
        return
      }
      toast(`${STRAT_SEEDS.length} strats imported.`)
      location.reload()
    })
  }
}

function syncMatchViewHref() {
  const btn = document.getElementById('sb-match-view')
  if (btn) btn.href = `stratbook-fullscreen.html?map=${state.filter.map}`
}

// ── Filters ───────────────────────────────────────────────────
function renderFilters() {
  const f = state.filter
  const mapPill = (val, label) =>
    `<button type="button" class="dx-pill ${f.map === val ? 'is-active' : ''}" data-group="map" data-val="${esc(val)}">${esc(label)}</button>`
  const sidePill = (val, label, extraCls = '') =>
    `<button type="button" class="dx-pill ${extraCls} ${f.side === val ? 'is-active' : ''}" data-group="side" data-val="${esc(val)}">${esc(label)}</button>`
  const typePill = (val, label) =>
    `<button type="button" class="dx-pill ${f.type === val ? 'is-active' : ''}" data-group="type" data-val="${esc(val)}">${esc(label)}</button>`

  filtersEl.innerHTML = `
    <div class="dx-filter-row">
      <div class="dx-filter-group">
        ${mapPill('all', 'All Maps')}
        ${MAPS.map(m => mapPill(m, capitalize(m))).join('')}
      </div>
    </div>
    <div class="dx-filter-row" style="margin-top:8px">
      <div class="dx-filter-group">
        ${sidePill('all', 'Both Sides')}
        ${sidePill('t',  'T-Side',  'dx-pill-t')}
        ${sidePill('ct', 'CT-Side', 'dx-pill-ct')}
      </div>
      <div class="dx-filter-divider"></div>
      <div class="dx-filter-group">
        ${typePill('all', 'All Types')}
        ${Object.entries(TYPE_META).map(([k, v]) => typePill(k, v.label)).join('')}
      </div>
      <div class="dx-filter-spacer"></div>
      <input type="search" class="dx-search-input" id="sb-search" placeholder="Search strats…" value="${esc(f.q)}"/>
    </div>`

  for (const btn of filtersEl.querySelectorAll('.dx-pill')) {
    btn.addEventListener('click', () => {
      const g = btn.dataset.group, v = btn.dataset.val
      if (state.filter[g] === v) return
      state.filter = { ...state.filter, [g]: v }
      saveFilter(state.filter)
      renderFilters()
      renderList()
      syncMatchViewHref()
    })
  }
  const searchEl = document.getElementById('sb-search')
  searchEl.addEventListener('input', e => {
    state.filter = { ...state.filter, q: e.target.value }
    saveFilter(state.filter)
    renderList()
  })
}

// ── List ──────────────────────────────────────────────────────
function renderList() {
  const filtered = getFiltered()
  if (state.strats.length === 0) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">No strats yet</h3>Build your playbook by creating your first strat.</div>`
    return
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="dx-empty">No strats match the current filters.</div>`
    return
  }

  listEl.innerHTML = `<div class="sb-grid">${filtered.map(stratCard).join('')}</div>`
}

function stratCard(s) {
  const roles = (s.player_roles ?? []).filter(r => r.role?.trim())
  const firstNote = s.notes?.split('\n')[0]?.trim() ?? ''
  const t = TYPE_META[s.type] ?? { label: s.type, color: '#64748b' }
  const sideCls = s.side === 't' ? 'sb-card-t' : s.side === 'ct' ? 'sb-card-ct' : ''
  const updated = relTime(s.updated_at || s.created_at)
  return `
    <a class="sb-card ${sideCls}" href="stratbook-detail.html?id=${esc(s.id)}">
      <div class="sb-card-mapwash" style="${mapBg(s.map) ? `background-image:url('${esc(mapBg(s.map))}')` : ''}"></div>
      <div class="sb-card-mapwash-overlay"></div>
      <div class="sb-card-head">
        <span class="sb-card-type" style="color:${t.color};background:${t.color}22">${esc(t.label)}</span>
        <span class="sb-card-map">${esc(capitalize(s.map))}</span>
        <span class="sb-card-side sb-card-side-${s.side}">${s.side === 't' ? 'T' : s.side === 'ct' ? 'CT' : ''}</span>
      </div>
      <div class="sb-card-name">${esc(s.name)}</div>
      ${firstNote ? `<div class="sb-card-note">${esc(firstNote)}</div>` : ''}
      ${roles.length ? `
        <div class="sb-card-roles">
          ${roles.map(r => `
            <div class="sb-card-role">
              <span class="sb-card-role-player">${esc(r.player)}</span>
              <span class="sb-card-role-arrow">›</span>
              <span class="sb-card-role-name">${esc(r.role)}</span>
            </div>`).join('')}
        </div>` : ''}
      <div class="sb-card-foot">
        ${(s.tags ?? []).length
          ? `<div class="sb-card-tags">${s.tags.slice(0, 3).map(tag => `<span class="sb-card-tag">#${esc(tag)}</span>`).join('')}</div>`
          : '<span></span>'}
        ${updated ? `<span class="sb-card-updated">Updated ${esc(updated)}</span>` : ''}
      </div>
    </a>`
}

function renderAll() {
  renderHero()
  renderFilters()
  renderList()
}

loadStrats()
