// cs2-hub/stratbook.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

await requireAuth()
renderSidebar('stratbook')

let allStrats = []
let activeMap  = 'all'
let activeSide = 'all'

async function loadStrats() {
  const { data } = await supabase.from('strats').select('*').order('created_at', { ascending: false })
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
      <div class="map-badge">${s.map.slice(0,3)}</div>
      <div class="flex-1">
        <div class="row-name">${s.name}</div>
        <div class="row-meta">${s.map} · ${s.side === 't' ? 'T-Side' : 'CT-Side'} · ${s.type}</div>
      </div>
      <div>${(s.tags ?? []).map(t => `<span class="tag">${t}</span>`).join('')}</div>
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
