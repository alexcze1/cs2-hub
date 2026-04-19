// cs2-hub/stratbook.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

function mapIcon(map) {
  const url = `https://cdn.akamai.steamstatic.com/apps/csgo/maps/de_${map}_preview.png`
  return `<div class="map-badge"><img src="${url}" alt="${esc(map)}" onerror="this.parentElement.innerHTML='<span>${esc(map.slice(0,3).toUpperCase())}</span>'"/></div>`
}

await requireAuth()
renderSidebar('stratbook')

let allStrats = []
let activeMap  = 'all'
let activeSide = 'all'

async function loadStrats() {
  const { data, error } = await supabase.from('strats').select('*').order('created_at', { ascending: false })
  if (error) {
    document.getElementById('strats-list').innerHTML = `<div class="empty-state"><h3>Failed to load strats</h3><p>${esc(error.message)}</p></div>`
    return
  }
  allStrats = data ?? []
  updateCountSub()
  renderList()
}

function updateCountSub() {
  const filtered = getFiltered()
  document.getElementById('strat-count-sub').textContent =
    `${filtered.length} strat${filtered.length !== 1 ? 's' : ''}${activeMap !== 'all' ? ` on ${activeMap}` : ''}`
}

function getFiltered() {
  return allStrats.filter(s =>
    (activeMap  === 'all' || s.map  === activeMap) &&
    (activeSide === 'all' || s.side === activeSide)
  )
}

function renderList() {
  const filtered = getFiltered()
  const el = document.getElementById('strats-list')
  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state"><h3>No strats here yet</h3><p>Add one with the button above.</p></div>`
    return
  }
  el.innerHTML = filtered.map(s => `
    <a class="list-row" href="stratbook-detail.html?id=${s.id}">
      ${mapIcon(s.map)}
      <div class="flex-1">
        <div class="row-name">${esc(s.name)}</div>
        <div class="row-meta">${esc(s.map)} · ${s.side === 't' ? 'T-Side' : 'CT-Side'} · ${esc(s.type)}</div>
      </div>
      <div>${(s.tags ?? []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    </a>
  `).join('')
}

document.getElementById('map-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab')
  if (!tab) return
  document.querySelectorAll('#map-tabs .tab').forEach(t => t.classList.remove('active'))
  tab.classList.add('active')
  activeMap = tab.dataset.map
  updateCountSub()
  renderList()
})

document.getElementById('side-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab')
  if (!tab) return
  document.querySelectorAll('#side-tabs .tab').forEach(t => t.classList.remove('active'))
  tab.classList.add('active')
  activeSide = tab.dataset.side
  updateCountSub()
  renderList()
})

loadStrats()
