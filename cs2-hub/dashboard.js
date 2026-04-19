// cs2-hub/dashboard.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

await requireAuth()
renderSidebar('dashboard')

document.getElementById('date-sub').textContent = new Date().toLocaleDateString('en-GB', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
})

const TYPE_LABELS = { scrim: 'SCRIM', tournament: 'TOURNAMENT', meeting: 'MEETING', vod_review: 'VOD REVIEW' }

function eventBadge(type) {
  return `<span class="badge badge-${type}">${TYPE_LABELS[type] ?? type}</span>`
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Upcoming events (next 7 days)
const now = new Date()
const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

const [{ data: dbEvents }, pracc] = await Promise.all([
  supabase.from('events').select('*').gte('date', now.toISOString()).lte('date', weekLater.toISOString()).order('date', { ascending: true }),
  fetch('/api/calendar').then(r => r.json()).catch(() => [])
])

const praccEvents = (Array.isArray(pracc) ? pracc : []).filter(e => e.date >= now.toISOString() && e.date <= weekLater.toISOString())
const filtered = (dbEvents ?? []).filter(se => {
  const seStart = new Date(se.date).getTime()
  const seEnd   = se.end_date ? new Date(se.end_date).getTime() : seStart + 3600000
  return !praccEvents.some(pe => {
    const peStart = new Date(pe.date).getTime()
    const peEnd   = pe.end_date ? new Date(pe.end_date).getTime() : peStart + 3600000
    return seStart < peEnd && peStart < seEnd
  })
})
const events = [...filtered, ...praccEvents].sort((a, b) => new Date(a.date) - new Date(b.date))

const upcomingEl = document.getElementById('upcoming-events')
if (!events?.length) {
  upcomingEl.innerHTML = `<div class="empty-state"><h3>No events this week</h3><p>Add one in the Schedule section.</p></div>`
} else {
  // Populate next-event stat card
  const next = events[0]
  document.getElementById('stat-next-event').textContent = next.title
  document.getElementById('stat-next-date').textContent = formatDate(next.date)

  // Build a 7-day column grid starting from today
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    d.setHours(0, 0, 0, 0)
    return d
  })

  upcomingEl.innerHTML = `<div class="week-grid">${days.map(day => {
    const dateStr = day.toISOString().slice(0, 10)
    const dayLabel = day.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase()
    const dayNum   = day.getDate()
    const isToday  = dateStr === now.toISOString().slice(0, 10)
    const dayEvents = events.filter(e => e.date.slice(0, 10) === dateStr)

    return `
      <div class="week-col ${isToday ? 'week-col-today' : ''}">
        <div class="week-day-header">
          <span class="week-day-name">${dayLabel}</span>
          <span class="week-day-num ${isToday ? 'week-day-num-today' : ''}">${dayNum}</span>
        </div>
        <div class="week-day-events">
          ${dayEvents.length ? dayEvents.map(e => `
            <a class="week-event week-event-${e.type}" href="schedule.html">
              <span class="week-event-time">${new Date(e.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
              <span class="week-event-title">${esc(e.title)}</span>
            </a>
          `).join('') : `<div class="week-empty">—</div>`}
        </div>
      </div>
    `
  }).join('')}</div>`
}

// Strat count
const { count: stratCount } = await supabase.from('strats').select('*', { count: 'exact', head: true })
document.getElementById('stat-strats').textContent = stratCount ?? 0

const { data: stratMaps } = await supabase.from('strats').select('map')
const uniqueMaps = new Set(stratMaps?.map(s => s.map) ?? [])
document.getElementById('stat-strats-sub').textContent = `Across ${uniqueMaps.size} map${uniqueMaps.size !== 1 ? 's' : ''}`

// Match record
const { data: vodData } = await supabase.from('vods').select('maps')
let mw = 0, ml = 0, md = 0
for (const v of vodData ?? []) {
  const maps = v.maps ?? []
  let w = 0, l = 0
  for (const m of maps) {
    if ((m.score_us ?? 0) > (m.score_them ?? 0)) w++
    else if ((m.score_them ?? 0) > (m.score_us ?? 0)) l++
  }
  if (w > l) mw++; else if (l > w) ml++; else if (maps.length) md++
}
const recentForm = (vodData ?? []).slice(0, 5).map(v => {
  let w = 0, l = 0
  for (const m of v.maps ?? []) {
    if ((m.score_us ?? 0) > (m.score_them ?? 0)) w++
    else if ((m.score_them ?? 0) > (m.score_us ?? 0)) l++
  }
  return w > l ? 'W' : l > w ? 'L' : 'D'
})
document.getElementById('stat-vods').innerHTML = `${mw}W — ${ml}L`
document.getElementById('stat-vods-form').innerHTML = recentForm.map(r =>
  `<span class="form-dot form-dot-${r === 'W' ? 'win' : r === 'L' ? 'loss' : 'draw'}">${r}</span>`
).join('')

// Recent strats (last 3)
const { data: recentStrats } = await supabase
  .from('strats')
  .select('id, name, map, side, type, tags')
  .order('created_at', { ascending: false })
  .limit(3)

const recentEl = document.getElementById('recent-strats')
if (!recentStrats?.length) {
  recentEl.innerHTML = `<div class="empty-state"><h3>No strats yet</h3><p>Add one in the Stratbook.</p></div>`
} else {
  recentEl.innerHTML = recentStrats.map(s => `
    <a class="list-row" href="stratbook-detail.html?id=${s.id}">
      <div class="map-badge"><img src="https://cdn.akamai.steamstatic.com/apps/csgo/maps/de_${s.map}_preview.png" alt="${esc(s.map)}" onerror="this.parentElement.innerHTML='<span>${s.map.slice(0,3).toUpperCase()}</span>'"/></div>
      <div class="flex-1">
        <div class="row-name">${esc(s.name)}</div>
        <div class="row-meta">${esc(s.map)} · ${s.side === 't' ? 'T-Side' : 'CT-Side'} · ${esc(s.type)}</div>
      </div>
      ${(s.tags ?? []).slice(0,2).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
    </a>
  `).join('')
}
