// cs2-hub/schedule.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

await requireAuth()
renderSidebar('schedule')

const TYPE_LABELS = { scrim: 'SCRIM', tournament: 'TOURNAMENT', meeting: 'MEETING', vod_review: 'VOD REVIEW' }

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// State
let allEvents = []
let activeFilter = 'all'
let editingId = null

// ── Load & Render ──────────────────────────────────────────
async function loadEvents() {
  const { data, error } = await supabase.from('events').select('*').order('date', { ascending: true })
  if (error) return
  allEvents = data
  renderList()
}

function renderList() {
  const filtered = activeFilter === 'all' ? allEvents : allEvents.filter(e => e.type === activeFilter)
  const listEl = document.getElementById('events-list')

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty-state"><h3>No events yet</h3><p>Click "Add Event" to get started.</p></div>`
    return
  }

  listEl.innerHTML = filtered.map(e => `
    <div class="list-row" data-id="${e.id}">
      <span class="badge badge-${e.type}">${TYPE_LABELS[e.type]}</span>
      <div class="flex-1">
        <div class="row-name">${e.title}</div>
        ${e.opponent ? `<div class="row-meta">vs ${e.opponent}</div>` : ''}
        ${e.notes ? `<div class="row-meta">${e.notes}</div>` : ''}
      </div>
      <div class="row-meta">${formatDate(e.date)}</div>
    </div>
  `).join('')

  listEl.querySelectorAll('.list-row').forEach(row => {
    row.addEventListener('click', () => openModal(row.dataset.id))
  })
}

// ── Filter tabs ────────────────────────────────────────────
document.getElementById('filter-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab')
  if (!tab) return
  document.querySelectorAll('#filter-tabs .tab').forEach(t => t.classList.remove('active'))
  tab.classList.add('active')
  activeFilter = tab.dataset.filter
  renderList()
})

// ── Modal ──────────────────────────────────────────────────
function openModal(id = null) {
  editingId = id
  const event = id ? allEvents.find(e => e.id === id) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Event' : 'Add Event'
  document.getElementById('f-title').value    = event?.title    ?? ''
  document.getElementById('f-type').value     = event?.type     ?? 'scrim'
  document.getElementById('f-date').value     = event ? event.date.slice(0,16) : ''
  document.getElementById('f-opponent').value = event?.opponent ?? ''
  document.getElementById('f-notes').value    = event?.notes    ?? ''
  document.getElementById('delete-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display = 'flex'
}

function closeModal() {
  document.getElementById('modal').style.display = 'none'
  editingId = null
}

document.getElementById('add-btn').addEventListener('click',    () => openModal())
document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click',  closeModal)
document.getElementById('modal').addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal()
})

document.getElementById('save-btn').addEventListener('click', async () => {
  const title    = document.getElementById('f-title').value.trim()
  const type     = document.getElementById('f-type').value
  const date     = document.getElementById('f-date').value
  const opponent = document.getElementById('f-opponent').value.trim() || null
  const notes    = document.getElementById('f-notes').value.trim()    || null
  const errEl    = document.getElementById('modal-error')

  if (!title || !date) {
    errEl.textContent = 'Title and date are required.'
    errEl.style.display = 'block'
    return
  }

  const payload = { title, type, date: new Date(date).toISOString(), opponent, notes }

  let error
  if (editingId) {
    ({ error } = await supabase.from('events').update(payload).eq('id', editingId))
  } else {
    ({ error } = await supabase.from('events').insert(payload))
  }

  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  closeModal()
  loadEvents()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this event?')) return
  await supabase.from('events').delete().eq('id', editingId)
  closeModal()
  loadEvents()
})

loadEvents()
