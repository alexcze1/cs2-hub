import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'
import { attachTeamAutocomplete, getTeamLogo, teamLogoEl } from './team-autocomplete.js'
import { computePraccVodsToInsert, computePraccVodsToBackfill, localDateStr } from './pracc-sync.js'
import {
  findCandidateVods,
  pickBestVod,
  computeVodPatch,
} from './auto-fill-vod.js'

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
  const { data: teamRow } = await supabase.from('teams').select('pracc_url, gcal_url').eq('id', teamId).single()

  const [{ data, error }, pracc, gcal] = await Promise.all([
    supabase.from('events').select('*').eq('team_id', teamId).order('date', { ascending: true }),
    teamRow?.pracc_url
      ? fetch(`/api/calendar?url=${encodeURIComponent(teamRow.pracc_url)}`).then(r => r.json()).catch(() => [])
      : Promise.resolve([]),
    teamRow?.gcal_url
      ? fetch(`/api/calendar?url=${encodeURIComponent(teamRow.gcal_url)}`).then(r => r.json()).catch(() => [])
      : Promise.resolve([]),
  ])

  if (error) {
    document.getElementById('cal-grid').innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Failed to load events</h3><p>${esc(error.message)}</p></div>`
    return
  }
  const praccEvents = Array.isArray(pracc) ? pracc : []
  const gcalEvents  = Array.isArray(gcal)  ? gcal.map(e => ({ ...e, source: 'gcal' })) : []
  const externalEvents = [...praccEvents, ...gcalEvents]

  const filtered = data.filter(se => {
    const seStart = new Date(se.date).getTime()
    const seEnd   = se.end_date ? new Date(se.end_date).getTime() : seStart + 3600000
    return !externalEvents.some(pe => {
      const peStart = new Date(pe.date).getTime()
      const peEnd   = pe.end_date ? new Date(pe.end_date).getTime() : peStart + 3600000
      return seStart < peEnd && peStart < seEnd
    })
  })
  allEvents = [...filtered, ...externalEvents].sort((a, b) => new Date(a.date) - new Date(b.date))
  renderCalendar()

  // Sync: ensure each pracc event has a corresponding vod entry, and backfill
  // map info on older auto-created vods that were inserted before map parsing.
  // Fire-and-forget so calendar render is never blocked.
  if (praccEvents.length) {
    ;(async () => {
      const uids = praccEvents.map(e => e.id)
      const { data: existing } = await supabase
        .from('vods')
        .select('id, external_uid, maps, match_date, opponent')
        .eq('team_id', teamId)
        .in('external_uid', uids)
      const existingVods = existing ?? []
      const existingUids = new Set(existingVods.map(v => v.external_uid))
      const newPayloads = computePraccVodsToInsert(praccEvents, existingUids, teamId)
      let insertedVods = []
      if (newPayloads.length) {
        const { data: inserted } = await supabase
          .from('vods')
          .insert(newPayloads)
          .select('id, opponent, match_date, maps, result, demo_link, created_at')
        insertedVods = inserted ?? []
      }
      const backfills = computePraccVodsToBackfill(praccEvents, existingVods)
      if (backfills.length) {
        await Promise.all(backfills.map(({ id, ...patch }) =>
          supabase.from('vods').update(patch).eq('id', id)
        ))
      }
      // Auto-link: if any of the just-inserted vods has a matching uploaded demo
      // (same opponent, ±1 day, named), patch the vod's scores. Silent on
      // failure — this is opportunistic.
      if (insertedVods.length) {
        try {
          const dates = insertedVods.map(v => v.match_date).sort()
          const widen = (d, delta) => {
            const dt = new Date(`${d}T00:00:00`)
            dt.setDate(dt.getDate() + delta)
            return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
          }
          const { data: demos } = await supabase
            .from('demos')
            .select('id, series_id, ct_team_name, t_team_name, map, team_a_score, team_b_score, team_a_first_side, played_at, created_at')
            .eq('team_id', teamId)
            .eq('status', 'ready')
            .not('ct_team_name', 'is', null)
            .gte('played_at', `${widen(dates[0], -1)}T00:00:00`)
            .lte('played_at', `${widen(dates[dates.length - 1], 1)}T23:59:59`)

          if (demos?.length) {
            const groups = new Map()
            for (const demo of demos) {
              const cands = findCandidateVods(demo, insertedVods)
              const chosen = pickBestVod(cands, demo)
              if (!chosen) continue
              let g = groups.get(chosen.id)
              if (!g) { g = { vod: chosen, demos: [] }; groups.set(chosen.id, g) }
              g.demos.push(demo)
            }
            for (const { vod, demos: ds } of groups.values()) {
              const patch = computeVodPatch(ds, vod)
              if (!patch) continue
              const { _filledMapNames, ...dbPatch } = patch
              await supabase.from('vods').update(dbPatch).eq('id', vod.id)
              console.log('[auto-fill] linked vod', vod.id, 'maps', _filledMapNames)
            }
          }
        } catch (e) {
          console.warn('[auto-fill] pracc-sync trigger failed:', e)
        }
      }
    })()
  }
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
    const dateStr = localDateStr(d)
    const dayEvents = allEvents.filter(e => localDateStr(new Date(e.date)) === dateStr)

    return `
      <div class="cal-cell ${!isCurrentMonth ? 'cal-other' : ''} ${isToday ? 'cal-today' : ''}" data-date="${dateStr}">
        <div class="cal-day-num">${d.getDate()}</div>
        ${dayEvents.map(e => `
          <div class="cal-event cal-event-${e.type}${e.source === 'pracc' ? ' cal-event-pracc' : e.source === 'gcal' ? ' cal-event-gcal' : ''}" data-id="${esc(e.id)}"><span class="cal-event-time">${formatTime(e.date)}${e.end_date ? ' – ' + formatTime(e.end_date) : ''}</span> ${esc(e.title)}${e.source === 'pracc' ? ' <span class="pracc-badge">PRACC</span>' : e.source === 'gcal' ? ' <span class="gcal-badge">GCAL</span>' : ''}</div>
        `).join('')}
      </div>
    `
  }).join('')

  grid.querySelectorAll('.cal-event').forEach(el => {
    el.addEventListener('click', ev => {
      ev.stopPropagation()
      const event = allEvents.find(e => e.id === el.dataset.id)
      if (event?.source === 'pracc') openPraccModal(event)
      else if (event?.source === 'gcal') openGcalEventModal(event)
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
  const opp = event?.opponent ?? ''
  document.getElementById('f-opponent').value = opp
  document.getElementById('f-notes').value    = event?.notes    ?? ''
  document.getElementById('delete-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display = 'flex'
  getTeamLogo(opp).then(logo => updateSchedLogo(logo, opp))
}

function openModalOnDate(dateStr) {
  openModal()
  document.getElementById('f-date').value     = dateStr + 'T12:00'
  document.getElementById('f-end-date').value = dateStr + 'T13:00'
}

function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

const schedOppInput   = document.getElementById('f-opponent')
const schedOppLogoWrap = document.getElementById('sched-opp-logo')

function updateSchedLogo(logo, name) {
  schedOppLogoWrap.innerHTML = logo || name ? teamLogoEl(logo, name, 36) : ''
}

attachTeamAutocomplete(schedOppInput, team => updateSchedLogo(team.logo, team.name))

schedOppInput.addEventListener('input', async () => {
  const n = schedOppInput.value.trim()
  updateSchedLogo(n ? await getTeamLogo(n) : null, n)
})

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

  let error, vodId = null
  if (editingId) {
    ;({ error } = await supabase.from('events').update(payload).eq('id', editingId))
  } else {
    ;({ error } = await supabase.from('events').insert(payload))
    if (!error && type === 'tournament') {
      const { data: vod } = await supabase.from('vods').insert({
        team_id: getTeamId(),
        opponent: opponent || title,
        match_type: type,
        match_date: new Date(date).toISOString().slice(0, 10),
        maps: [],
      }).select('id').single()
      vodId = vod?.id ?? null
    }
  }
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  const wasEditing = !!editingId
  closeModal()
  if (vodId) {
    toast(`Event added — <a href="vod-detail.html?id=${vodId}" style="color:inherit;font-weight:600;text-decoration:underline">Fill in results →</a>`, 'success', 5000)
  } else {
    toast(wasEditing ? 'Event updated' : 'Event added')
  }
  loadEvents()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this event?')) return
  const { error } = await supabase.from('events').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = `Delete failed: ${error.message}`; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); toast('Event deleted'); loadEvents()
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

// ── Google Calendar read-only event modal ──────────────────
function openGcalEventModal(event) {
  const formatDT = iso => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  document.getElementById('gcal-event-body').innerHTML = `
    <div class="form-group"><label class="form-label">Event</label><div class="form-static">${esc(event.title)}</div></div>
    ${event.opponent ? `<div class="form-group"><label class="form-label">Opponent</label><div class="form-static">${esc(event.opponent)}</div></div>` : ''}
    <div class="form-group"><label class="form-label">Start</label><div class="form-static">${formatDT(event.date)}</div></div>
    ${event.end_date ? `<div class="form-group"><label class="form-label">End</label><div class="form-static">${formatDT(event.end_date)}</div></div>` : ''}
    ${event.notes ? `<div class="form-group"><label class="form-label">Notes</label><div class="form-static">${esc(event.notes)}</div></div>` : ''}
  `
  document.getElementById('gcal-event-modal').style.display = 'flex'
}

document.getElementById('gcal-event-close').addEventListener('click', () => { document.getElementById('gcal-event-modal').style.display = 'none' })
document.getElementById('gcal-event-cancel').addEventListener('click', () => { document.getElementById('gcal-event-modal').style.display = 'none' })
document.getElementById('gcal-event-modal').addEventListener('click', e => { if (e.target === document.getElementById('gcal-event-modal')) document.getElementById('gcal-event-modal').style.display = 'none' })

// ── Google Calendar ────────────────────────────────────────
document.getElementById('gcal-btn').addEventListener('click', async () => {
  const { data: team } = await supabase.from('teams').select('join_code, gcal_url').eq('id', getTeamId()).single()
  const base = window.location.origin
  const url = `${base}/api/export-calendar?team_id=${getTeamId()}&token=${team?.join_code ?? ''}`
  document.getElementById('gcal-url').value = url
  document.getElementById('f-gcal-url').value = team?.gcal_url ?? ''
  document.getElementById('gcal-import-error').style.display = 'none'
  document.getElementById('gcal-modal').style.display = 'flex'
})
document.getElementById('gcal-close').addEventListener('click', () => { document.getElementById('gcal-modal').style.display = 'none' })
document.getElementById('gcal-cancel').addEventListener('click', () => { document.getElementById('gcal-modal').style.display = 'none' })
document.getElementById('gcal-modal').addEventListener('click', e => { if (e.target === document.getElementById('gcal-modal')) document.getElementById('gcal-modal').style.display = 'none' })
document.getElementById('gcal-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('gcal-url').value)
  document.getElementById('gcal-copy').textContent = 'Copied!'
  setTimeout(() => { document.getElementById('gcal-copy').textContent = 'Copy' }, 2000)
})

document.getElementById('gcal-import-save').addEventListener('click', async () => {
  const gcal_url = document.getElementById('f-gcal-url').value.trim() || null
  const errEl = document.getElementById('gcal-import-error')
  const { error } = await supabase.from('teams').update({ gcal_url }).eq('id', getTeamId())
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  document.getElementById('gcal-modal').style.display = 'none'
  toast(gcal_url ? 'Google Calendar connected' : 'Google Calendar disconnected')
  loadEvents()
})

document.getElementById('gcal-import-clear').addEventListener('click', async () => {
  await supabase.from('teams').update({ gcal_url: null }).eq('id', getTeamId())
  document.getElementById('f-gcal-url').value = ''
  document.getElementById('gcal-modal').style.display = 'none'
  toast('Google Calendar import cleared')
  loadEvents()
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
