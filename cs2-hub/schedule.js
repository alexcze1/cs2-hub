import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

await requireAuth()
renderSidebar('schedule')

const TYPE_LABELS = { scrim: 'SCRIM', tournament: 'TOURNAMENT', meeting: 'MEETING', vod_review: 'VOD REVIEW' }

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

let allEvents = []
let editingId = null
let currentMonth = new Date()
currentMonth.setDate(1)
currentMonth.setHours(0,0,0,0)

// ── Load ───────────────────────────────────────────────────
async function loadEvents() {
  const teamId = getTeamId()
  const { data: teamRow } = await supabase.from('teams').select('pracc_url').eq('id', teamId).single()

  const [{ data, error }, pracc] = await Promise.all([
    supabase.from('events').select('*').eq('team_id', teamId).order('date', { ascending: true }),
    teamRow?.pracc_url
      ? fetch(`/api/calendar?url=${encodeURIComponent(teamRow.pracc_url)}`).then(r => r.json()).catch(() => [])
      : Promise.resolve([])
  ])

  if (error) {
    document.getElementById('cal-grid').innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Failed to load events</h3><p>${esc(error.message)}</p></div>`
    return
  }
  const praccEvents = Array.isArray(pracc) ? pracc : []
  const filtered = data.filter(se => {
    const seStart = new Date(se.date).getTime()
    const seEnd   = se.end_date ? new Date(se.end_date).getTime() : seStart + 3600000
    return !praccEvents.some(pe => {
      const peStart = new Date(pe.date).getTime()
      const peEnd   = pe.end_date ? new Date(pe.end_date).getTime() : peStart + 3600000
      return seStart < peEnd && peStart < seEnd
    })
  })
  allEvents = [...filtered, ...praccEvents].sort((a, b) => new Date(a.date) - new Date(b.date))
  renderCalendar()
}

// ── Calendar ───────────────────────────────────────────────
function renderCalendar() {
  const year  = currentMonth.getFullYear()
  const month = currentMonth.getMonth()

  document.getElementById('cal-header').textContent =
    new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }).toUpperCase()

  const firstDay = new Date(year, month, 1)
  const startOffset = (firstDay.getDay() + 6) % 7
  const gridStart = new Date(firstDay)
  gridStart.setDate(gridStart.getDate() - startOffset)

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const cells = []
  const cur = new Date(gridStart)
  while (cells.length < 35 || cur.getMonth() === month) {
    cells.push(new Date(cur))
    cur.setDate(cur.getDate() + 1)
    if (cells.length >= 42) break
  }

  const grid = document.getElementById('cal-grid')
  grid.innerHTML = cells.map(d => {
    const isCurrentMonth = d.getMonth() === month
    const isToday = d.getTime() === today.getTime()
    const dateStr = d.toISOString().slice(0, 10)
    const dayEvents = allEvents.filter(e => e.date.slice(0, 10) === dateStr)

    return `
      <div class="cal-cell ${!isCurrentMonth ? 'cal-other' : ''} ${isToday ? 'cal-today' : ''}" data-date="${dateStr}">
        <div class="cal-day-num">${d.getDate()}</div>
        ${dayEvents.map(e => `
          <div class="cal-event cal-event-${e.type}${e.source === 'pracc' ? ' cal-event-pracc' : ''}" data-id="${esc(e.id)}"><span class="cal-event-time">${formatTime(e.date)}${e.end_date ? ' – ' + formatTime(e.end_date) : ''}</span> ${esc(e.title)}${e.source === 'pracc' ? ' <span class="pracc-badge">PRACC</span>' : ''}</div>
        `).join('')}
      </div>
    `
  }).join('')

  grid.querySelectorAll('.cal-event').forEach(el => {
    el.addEventListener('click', ev => {
      ev.stopPropagation()
      const event = allEvents.find(e => e.id === el.dataset.id)
      if (event?.source === 'pracc') openPraccModal(event)
      else openModal(el.dataset.id)
    })
  })

  grid.querySelectorAll('.cal-cell').forEach(el => {
    el.addEventListener('click', () => openModalOnDate(el.dataset.date))
  })
}

document.getElementById('cal-prev').addEventListener('click', () => { currentMonth.setMonth(currentMonth.getMonth() - 1); renderCalendar() })
document.getElementById('cal-next').addEventListener('click', () => { currentMonth.setMonth(currentMonth.getMonth() + 1); renderCalendar() })

// ── Add/Edit Modal ─────────────────────────────────────────
function openModal(id = null) {
  editingId = id
  const event = id ? allEvents.find(e => e.id === id) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Event' : 'Add Event'
  document.getElementById('f-title').value    = event?.title    ?? ''
  document.getElementById('f-type').value     = event?.type     ?? 'scrim'
  document.getElementById('f-date').value     = event?.date?.slice(0, 16)     ?? ''
  document.getElementById('f-end-date').value = event?.end_date?.slice(0, 16) ?? ''
  document.getElementById('f-opponent').value = event?.opponent ?? ''
  document.getElementById('f-notes').value    = event?.notes    ?? ''
  document.getElementById('delete-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display = 'flex'
}

function openModalOnDate(dateStr) {
  openModal()
  document.getElementById('f-date').value     = dateStr + 'T12:00'
  document.getElementById('f-end-date').value = dateStr + 'T13:00'
}

function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

document.getElementById('add-btn').addEventListener('click', () => openModal())
document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click', closeModal)
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal() })

document.getElementById('save-btn').addEventListener('click', async () => {
  const title    = document.getElementById('f-title').value.trim()
  const type     = document.getElementById('f-type').value
  const date     = document.getElementById('f-date').value
  const end_date = document.getElementById('f-end-date').value || null
  const opponent = document.getElementById('f-opponent').value.trim() || null
  const notes    = document.getElementById('f-notes').value.trim()    || null
  const errEl    = document.getElementById('modal-error')

  if (!title || !date) { errEl.textContent = 'Title and date are required.'; errEl.style.display = 'block'; return }

  const payload = { title, type, date: new Date(date).toISOString(), end_date: end_date ? new Date(end_date).toISOString() : null, opponent, notes, team_id: getTeamId() }

  let error
  if (editingId) {
    ;({ error } = await supabase.from('events').update(payload).eq('id', editingId))
  } else {
    ;({ error } = await supabase.from('events').insert(payload))
  }
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  closeModal(); loadEvents()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this event?')) return
  const { error } = await supabase.from('events').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = `Delete failed: ${error.message}`; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); loadEvents()
})

// ── Pracc read-only modal ──────────────────────────────────
function openPraccModal(event) {
  const formatDT = iso => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  document.getElementById('pracc-modal-body').innerHTML = `
    <div class="form-group"><label class="form-label">Match</label><div class="form-static">${esc(event.title)}</div></div>
    ${event.opponent ? `<div class="form-group"><label class="form-label">Opponent</label><div class="form-static">${esc(event.opponent)}</div></div>` : ''}
    <div class="form-group"><label class="form-label">Start</label><div class="form-static">${formatDT(event.date)}</div></div>
    ${event.end_date ? `<div class="form-group"><label class="form-label">End</label><div class="form-static">${formatDT(event.end_date)}</div></div>` : ''}
    ${event.notes ? `<div class="form-group"><label class="form-label">Notes</label><div class="form-static">${esc(event.notes)}</div></div>` : ''}
  `
  document.getElementById('pracc-modal').style.display = 'flex'
}

document.getElementById('pracc-modal-close').addEventListener('click', () => { document.getElementById('pracc-modal').style.display = 'none' })
document.getElementById('pracc-cancel-btn').addEventListener('click', () => { document.getElementById('pracc-modal').style.display = 'none' })
document.getElementById('pracc-modal').addEventListener('click', e => { if (e.target === document.getElementById('pracc-modal')) document.getElementById('pracc-modal').style.display = 'none' })

// ── Google Calendar ────────────────────────────────────────
document.getElementById('gcal-btn').addEventListener('click', async () => {
  const { data: team } = await supabase.from('teams').select('join_code').eq('id', getTeamId()).single()
  const base = window.location.origin
  const url = `${base}/api/export-calendar?team_id=${getTeamId()}&token=${team?.join_code ?? ''}`
  document.getElementById('gcal-url').value = url
  document.getElementById('gcal-modal').style.display = 'flex'
})
document.getElementById('gcal-close').addEventListener('click', () => { document.getElementById('gcal-modal').style.display = 'none' })
document.getElementById('gcal-cancel').addEventListener('click', () => { document.getElementById('gcal-modal').style.display = 'none' })
document.getElementById('gcal-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('gcal-url').value)
  document.getElementById('gcal-copy').textContent = 'Copied!'
  setTimeout(() => { document.getElementById('gcal-copy').textContent = 'Copy' }, 2000)
})

// ── Pracc Settings ─────────────────────────────────────────
document.getElementById('pracc-settings-btn').addEventListener('click', async () => {
  const { data: team } = await supabase.from('teams').select('pracc_url').eq('id', getTeamId()).single()
  document.getElementById('f-pracc-url').value = team?.pracc_url ?? ''
  document.getElementById('pracc-settings-error').style.display = 'none'
  document.getElementById('pracc-settings-modal').style.display = 'flex'
})

document.getElementById('pracc-settings-close').addEventListener('click', () => { document.getElementById('pracc-settings-modal').style.display = 'none' })
document.getElementById('pracc-settings-cancel').addEventListener('click', () => { document.getElementById('pracc-settings-modal').style.display = 'none' })

document.getElementById('pracc-settings-save').addEventListener('click', async () => {
  const pracc_url = document.getElementById('f-pracc-url').value.trim() || null
  const errEl = document.getElementById('pracc-settings-error')
  const { error } = await supabase.from('teams').update({ pracc_url }).eq('id', getTeamId())
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  document.getElementById('pracc-settings-modal').style.display = 'none'
  loadEvents()
})

document.getElementById('pracc-settings-clear').addEventListener('click', async () => {
  await supabase.from('teams').update({ pracc_url: null }).eq('id', getTeamId())
  document.getElementById('pracc-settings-modal').style.display = 'none'
  loadEvents()
})

loadEvents()
