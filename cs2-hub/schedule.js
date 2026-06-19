import { requireAuth } from './auth.js'
import { renderSidebar, renderToolHeader } from './layout.js'
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

function formatCountdown(ms) {
  if (ms < 60_000) return { value: 'NOW', unit: '' }
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return { value: String(mins), unit: 'min' }
  const hours = Math.floor(mins / 60)
  if (hours < 24) return { value: String(hours), unit: hours === 1 ? 'hour' : 'hours' }
  const days = Math.floor(hours / 24)
  return { value: String(days), unit: days === 1 ? 'day' : 'days' }
}

const TYPE_META = {
  tournament: { label: 'Tournament', cls: 'tournament' },
  scrim:      { label: 'Scrim',      cls: 'scrim' },
  vod_review: { label: 'VOD Review', cls: 'vod_review' },
  meeting:    { label: 'Meeting',    cls: 'meeting' },
}
const MATCH_TYPES = new Set(['tournament', 'scrim'])

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '') }
function looseHas(set, name) {
  const n = norm(name); if (!n) return false
  if (set.has(n)) return true
  for (const v of set) if (v.includes(n) || n.includes(v)) return true
  return false
}
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d }
function filteredEvents() { return typeFilter === 'all' ? allEvents : allEvents.filter(e => e.type === typeFilter) }

// Real prep signals from team data: opponent profile + veto plan + notes.
function prepFor(ev) {
  const hasProfile = looseHas(prep.profiles, ev.opponent)
  const hasVeto = looseHas(prep.vetos, ev.opponent)
  const hasNotes = !!(ev.notes && String(ev.notes).trim())
  const done = (hasProfile ? 1 : 0) + (hasVeto ? 1 : 0) + (hasNotes ? 1 : 0)
  const status = done >= 3 ? 'ready' : done >= 1 ? 'partial' : 'todo'
  return { hasProfile, hasVeto, hasNotes, done, status }
}

function cardHead(title, sub) {
  return `<div class="sched-card-head"><div class="sched-card-title">${esc(title)}</div>${sub ? `<div class="sched-card-sub">${esc(sub)}</div>` : ''}</div>`
}

// ── Header (unified tool header + KPIs) ─────────────────────────────────
function renderHeader() {
  const now = Date.now()
  const weekEnd = now + 7 * DAY_MS
  const upcoming = allEvents.filter(e => new Date(e.date).getTime() > now)
  const thisWeek = upcoming.filter(e => new Date(e.date).getTime() <= weekEnd)
  const scrims = thisWeek.filter(e => e.type === 'scrim').length
  const matches = upcoming.filter(e => MATCH_TYPES.has(e.type))
  const next = matches[0]
  const prepTodo = matches.filter(e => prepFor(e).status !== 'ready').length

  let nextChip = { v: '—', k: 'next match' }
  if (next) {
    const cd = formatCountdown(new Date(next.date).getTime() - now)
    nextChip = { v: cd.unit ? `${cd.value} ${cd.unit}` : cd.value, k: `vs ${next.opponent || next.title}` }
  }
  renderToolHeader(document.getElementById('schedule-hero'), {
    section: 'Overview',
    title: 'Schedule',
    sub: 'Matches, scrims, reviews and meetings — with prep status for what comes next.',
    kpis: [
      nextChip,
      { v: thisWeek.length, k: 'next 7 days' },
      { v: scrims, k: 'scrims booked' },
      { v: prepTodo, k: 'need prep', tone: prepTodo ? 'bad' : 'good' },
    ],
  })
}

function renderInsights() { renderUpNext(); renderToday(); renderWeek() }

// ── Up Next — compact next-match card with prep checklist ───────────────
function renderUpNext() {
  const el = document.getElementById('sched-upnext')
  if (!el) return
  const now = Date.now()
  const next = allEvents
    .filter(e => new Date(e.date).getTime() > now && MATCH_TYPES.has(e.type))
    .sort((a, b) => new Date(a.date) - new Date(b.date))[0]
  if (!next) {
    el.innerHTML = cardHead('Up Next', '') +
      `<div class="sched-empty">No upcoming matches. <a href="#" data-add>Schedule one →</a></div>`
    el.querySelector('[data-add]')?.addEventListener('click', e => { e.preventDefault(); openModal() })
    return
  }
  const start = new Date(next.date)
  const cd = formatCountdown(start.getTime() - now)
  const p = prepFor(next)
  const meta = TYPE_META[next.type] || { label: 'Match' }
  const dateLabel = start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })
  const statusLabel = p.status === 'ready' ? 'Ready' : p.status === 'partial' ? 'In progress' : 'Not started'
  el.innerHTML = `
    ${cardHead('Up Next', meta.label)}
    <div class="upnext">
      <div class="upnext-top">
        <div class="upnext-vs-wrap">
          <div class="upnext-vs">vs ${esc(next.opponent || next.title)}</div>
          <div class="upnext-when">${dateLabel} · ${formatTime(next.date)}</div>
        </div>
        <div class="upnext-cd">
          <div class="upnext-cd-v">${cd.value}</div>
          <div class="upnext-cd-u">${esc(cd.unit || 'now')}</div>
        </div>
      </div>
      <div class="upnext-prep">
        <div class="upnext-prep-head">
          <span>Prep status</span>
          <span class="prep-badge prep-${p.status}">${statusLabel}</span>
        </div>
        <div class="prep-checks">
          ${prepCheck('Opponent profile', p.hasProfile, 'opponents.html')}
          ${prepCheck('Veto plan', p.hasVeto, 'veto.html')}
          ${prepCheck('Match notes', p.hasNotes, null, next.id)}
        </div>
      </div>
    </div>`
  el.querySelector('[data-edit-notes]')?.addEventListener('click', e => { e.preventDefault(); openModal(next.id) })
}

function prepCheck(label, done, href, editId) {
  const ic = `<span class="prep-check-ic prep-check-${done ? 'on' : 'off'}">${done ? '✓' : '○'}</span><span>${esc(label)}</span>`
  if (done) return `<div class="prep-check is-done">${ic}</div>`
  if (editId) return `<a class="prep-check" href="#" data-edit-notes>${ic}<span class="prep-go">Add →</span></a>`
  return `<a class="prep-check" href="${href}">${ic}<span class="prep-go">Open →</span></a>`
}

// ── Today's agenda ──────────────────────────────────────────────────────
function renderToday() {
  const el = document.getElementById('sched-today')
  if (!el) return
  const today = startOfToday().getTime()
  const tmrw = today + DAY_MS
  const items = allEvents
    .filter(e => { const t = new Date(e.date).getTime(); return t >= today && t < tmrw })
    .sort((a, b) => new Date(a.date) - new Date(b.date))
  const sub = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })
  const body = items.length
    ? `<div class="agenda">${items.map(agendaRow).join('')}</div>`
    : `<div class="sched-empty">Nothing scheduled today — a good day to review demos.</div>`
  el.innerHTML = cardHead('Today', sub) + body
  wireAgenda(el)
}

function agendaRow(e) {
  const meta = TYPE_META[e.type] || { label: e.type, cls: '' }
  return `<a class="agenda-row" data-id="${esc(e.id)}">
    <span class="agenda-time">${formatTime(e.date)}</span>
    <span class="agenda-rail agenda-rail-${meta.cls}"></span>
    <span class="agenda-mid">
      <span class="agenda-title">${esc(e.title)}</span>
      <span class="agenda-type">${esc(meta.label)}${e.opponent ? ' · ' + esc(e.opponent) : ''}</span>
    </span>
  </a>`
}

// ── Next 7 days ─────────────────────────────────────────────────────────
function renderWeek() {
  const el = document.getElementById('sched-week')
  if (!el) return
  const now = Date.now()
  const end = now + 7 * DAY_MS
  const items = allEvents
    .filter(e => { const t = new Date(e.date).getTime(); return t > now && t <= end })
    .sort((a, b) => new Date(a.date) - new Date(b.date))
  const counts = {}
  for (const e of items) counts[e.type] = (counts[e.type] || 0) + 1
  const chips = Object.entries(TYPE_META).map(([k, m]) =>
    `<div class="week-chip"><span class="week-chip-v">${counts[k] || 0}</span><span class="week-chip-k">${esc(m.label)}s</span></div>`
  ).join('')
  const rows = items.slice(0, 6).map(weekRow).join('')
  el.innerHTML = cardHead('Next 7 Days', `${items.length} event${items.length === 1 ? '' : 's'}`)
    + `<div class="week-chips">${chips}</div>`
    + (rows ? `<div class="week-list">${rows}</div>` : `<div class="sched-empty">No events in the next week.</div>`)
  wireAgenda(el)
}

function weekRow(e) {
  const meta = TYPE_META[e.type] || { label: e.type, cls: '' }
  const day = new Date(e.date).toLocaleDateString('en-GB', { weekday: 'short' })
  const prepDot = MATCH_TYPES.has(e.type)
    ? `<span class="prep-dot prep-${prepFor(e).status}" title="Prep ${prepFor(e).status}"></span>` : ''
  return `<a class="week-row" data-id="${esc(e.id)}">
    <span class="week-day"><b>${esc(day)}</b><span>${formatTime(e.date)}</span></span>
    <span class="agenda-rail agenda-rail-${meta.cls}"></span>
    <span class="week-mid"><span class="agenda-title">${esc(e.title)}</span><span class="agenda-type">${esc(meta.label)}</span></span>
    ${prepDot}
  </a>`
}

// ── List view ───────────────────────────────────────────────────────────
function renderList() {
  const el = document.getElementById('sched-list')
  if (!el) return
  const evs = [...filteredEvents()].sort((a, b) => new Date(a.date) - new Date(b.date))
  const upcoming = evs.filter(e => new Date(e.date).getTime() >= startOfToday().getTime())
  if (!upcoming.length) {
    el.innerHTML = `<div class="sched-empty sched-empty-lg">No upcoming ${typeFilter === 'all' ? '' : typeFilter + ' '}events. <a href="#" data-add>Add one →</a></div>`
    el.querySelector('[data-add]')?.addEventListener('click', e => { e.preventDefault(); openModal() })
    return
  }
  const groups = new Map()
  for (const e of upcoming) {
    const key = localDateStr(new Date(e.date))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }
  const todayKey = localDateStr(new Date())
  el.innerHTML = [...groups.entries()].map(([key, items]) => {
    const d = new Date(key + 'T00:00:00')
    const isToday = key === todayKey
    const dLabel = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    return `<div class="list-group">
      <div class="list-date ${isToday ? 'is-today' : ''}">${dLabel}${isToday ? ' · Today' : ''}</div>
      <div class="list-rows">${items.map(listRow).join('')}</div>
    </div>`
  }).join('')
  wireAgenda(el)
}

function listRow(e) {
  const meta = TYPE_META[e.type] || { label: e.type, cls: '' }
  const src = e.source === 'pracc' ? `<span class="pracc-badge">PRACC</span>` : e.source === 'gcal' ? `<span class="gcal-badge">GCAL</span>` : ''
  let prepBadge = ''
  if (MATCH_TYPES.has(e.type)) {
    const p = prepFor(e)
    prepBadge = `<span class="prep-badge prep-${p.status}">${p.status === 'ready' ? 'Prep ready' : p.status === 'partial' ? `Prep ${p.done}/3` : 'Prep needed'}</span>`
  }
  return `<a class="list-row" data-id="${esc(e.id)}">
    <span class="list-time">${formatTime(e.date)}${e.end_date ? `<span>${formatTime(e.end_date)}</span>` : ''}</span>
    <span class="agenda-rail agenda-rail-${meta.cls}"></span>
    <span class="list-mid">
      <span class="list-title">${esc(e.title)} ${src}</span>
      <span class="list-sub"><span class="list-type list-type-${meta.cls}">${esc(meta.label)}</span>${e.opponent ? ' · ' + esc(e.opponent) : ''}</span>
    </span>
    ${prepBadge}
  </a>`
}

// Shared click wiring for agenda / week / list rows.
function wireAgenda(scope) {
  scope.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', ev => {
      ev.preventDefault()
      const event = allEvents.find(e => e.id === el.dataset.id)
      if (!event) return
      if (event.source === 'pracc') openPraccModal(event)
      else if (event.source === 'gcal') openGcalEventModal(event)
      else openModal(event.id)
    })
  })
}

// ── Filters + view toggle ───────────────────────────────────────────────
function renderFilters() {
  const el = document.getElementById('sched-filters')
  if (!el) return
  const pills = [['all', 'All'], ['tournament', 'Tournaments'], ['scrim', 'Scrims'], ['vod_review', 'Reviews'], ['meeting', 'Meetings']]
  el.innerHTML = pills.map(([v, l]) =>
    `<button type="button" class="dx-pill ${typeFilter === v ? 'is-active' : ''}" data-type="${v}">${l}</button>`
  ).join('')
  el.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
    typeFilter = b.dataset.type
    renderFilters(); renderView()
  }))
}

function renderView() {
  const cal = document.getElementById('sched-calendar')
  const list = document.getElementById('sched-list')
  const calNav = document.getElementById('cal-nav-wrap')
  if (viewMode === 'calendar') {
    cal.style.display = ''; list.style.display = 'none'; if (calNav) calNav.style.display = ''
    renderCalendar()
  } else {
    cal.style.display = 'none'; list.style.display = ''; if (calNav) calNav.style.display = 'none'
    renderList()
  }
}

async function loadPrep() {
  const teamId = getTeamId()
  const [{ data: opps }, { data: vetos }] = await Promise.all([
    supabase.from('opponents').select('name').eq('team_id', teamId),
    supabase.from('veto_predictions').select('opponent').eq('team_id', teamId),
  ])
  prep.profiles = new Set((opps || []).map(o => norm(o.name)).filter(Boolean))
  prep.vetos = new Set((vetos || []).map(v => norm(v.opponent)).filter(Boolean))
}

let allEvents = []
let editingId = null
let currentMonth = new Date()
currentMonth.setDate(1)
currentMonth.setHours(0,0,0,0)
let viewMode = 'calendar'
let typeFilter = 'all'
const prep = { profiles: new Set(), vetos: new Set() }

// View toggle (Calendar / List) — static buttons, bound once at load.
document.getElementById('sched-views').addEventListener('click', e => {
  const btn = e.target.closest('[data-view]')
  if (!btn) return
  viewMode = btn.dataset.view
  for (const b of document.querySelectorAll('#sched-views button')) b.classList.toggle('on', b === btn)
  renderView()
})

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
  await loadPrep()
  renderHeader()
  renderFilters()
  renderInsights()
  renderView()

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

  const evs = filteredEvents()
  const grid = document.getElementById('cal-grid')
  grid.innerHTML = cells.map(d => {
    const isCurrentMonth = d.getMonth() === month
    const isToday = d.getTime() === today.getTime()
    const dateStr = localDateStr(d)
    const dayEvents = evs.filter(e => localDateStr(new Date(e.date)) === dateStr)

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
