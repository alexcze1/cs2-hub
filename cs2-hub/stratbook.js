import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const MAP_IMG = { dust2: 'dust' }
function mapIcon(map) {
  const file = MAP_IMG[map] ?? map
  const url = `images/maps/${file}.png`
  return `<div class="map-badge"><img src="${url}" alt="${esc(map)}" onerror="this.parentElement.innerHTML='<span>${map.slice(0,3).toUpperCase()}</span>'"/></div>`
}

await requireAuth()
renderSidebar('stratbook')

let allStrats  = []
let activeMap  = 'all'
let activeSide = 'all'
let activeType = 'all'
let searchQ    = ''

const TYPE_COLORS = {
  execute: 'badge-scrim',
  default: 'badge-draw',
  setup:   'badge-vod_review',
  fake:    'badge-tournament',
  eco:     'badge-draw',
  other:   'badge-draw',
}

async function loadStrats() {
  const { data, error } = await supabase.from('strats').select('*').eq('team_id', getTeamId()).order('map').order('side').order('created_at', { ascending: false })
  if (error) {
    document.getElementById('strats-list').innerHTML = `<div class="empty-state"><h3>Failed to load strats</h3><p>${esc(error.message)}</p></div>`
    return
  }
  allStrats = data ?? []
  renderList()
}

function getFiltered() {
  return allStrats.filter(s =>
    (activeMap  === 'all' || s.map  === activeMap) &&
    (activeSide === 'all' || s.side === activeSide) &&
    (activeType === 'all' || s.type === activeType) &&
    (!searchQ || s.name.toLowerCase().includes(searchQ))
  )
}

function renderList() {
  const filtered = getFiltered()
  const count = filtered.length
  document.getElementById('strat-count-sub').textContent =
    `${count} strat${count !== 1 ? 's' : ''}${activeMap !== 'all' ? ` · ${activeMap}` : ''}${activeSide !== 'all' ? ` · ${activeSide === 't' ? 'T-Side' : 'CT-Side'}` : ''}${activeType !== 'all' ? ` · ${activeType}` : ''}`

  const el = document.getElementById('strats-list')
  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state"><h3>No strats match</h3><p>Try adjusting the filters.</p></div>`
    return
  }

  el.innerHTML = filtered.map(s => {
    const roles   = s.player_roles ?? []
    const hasRoles = roles.some(r => r.role?.trim())
    const sideLabel = s.side === 't' ? 'T-Side' : 'CT-Side'
    const sideClass = s.side === 't' ? 'strat-side-t' : 'strat-side-ct'
    const firstNote = s.notes?.split('\n')[0]?.trim() ?? ''

    return `
      <a class="strat-card" href="stratbook-detail.html?id=${esc(s.id)}">
        <div class="strat-card-header">
          ${mapIcon(s.map)}
          <div class="strat-card-title">
            <div class="strat-name">${esc(s.name)}</div>
            <div class="strat-meta">${esc(s.map.charAt(0).toUpperCase()+s.map.slice(1))}</div>
          </div>
          <div class="strat-card-badges">
            <span class="badge ${TYPE_COLORS[s.type] ?? 'badge-draw'}">${esc(s.type.toUpperCase())}</span>
            <span class="strat-side-badge ${sideClass}">${sideLabel}</span>
          </div>
        </div>

        ${hasRoles ? `
        <div class="strat-roles">
          ${roles.filter(r => r.role?.trim()).map(r => `
            <div class="strat-role-row">
              <span class="strat-role-player">${esc(r.player)}</span>
              <span class="strat-role-name">${esc(r.role)}</span>
            </div>
          `).join('')}
        </div>` : ''}

        ${firstNote ? `<div class="strat-note-preview">${esc(firstNote)}</div>` : ''}

        ${(s.tags ?? []).length ? `
        <div class="strat-tags">
          ${s.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>` : ''}
      </a>
    `
  }).join('')
}

// ── Filter bindings ────────────────────────────────────────
function bindTabs(id, key, setter) {
  document.getElementById(id).addEventListener('click', e => {
    const tab = e.target.closest('.tab')
    if (!tab) return
    document.querySelectorAll(`#${id} .tab`).forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    setter(tab.dataset[key])
    renderList()
  })
}

bindTabs('map-tabs',  'map',  v => { activeMap = v; document.getElementById('match-view-btn').href = `stratbook-fullscreen.html?map=${v}` })
bindTabs('side-tabs', 'side', v => activeSide = v)
bindTabs('type-tabs', 'type', v => activeType = v)

document.getElementById('strat-search').addEventListener('input', e => {
  searchQ = e.target.value.toLowerCase().trim()
  renderList()
})

loadStrats()
