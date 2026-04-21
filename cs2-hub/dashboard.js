import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

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

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const teamId = getTeamId()
const now = new Date()
const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

const { data: teamRow } = await supabase.from('teams').select('pracc_url').eq('id', teamId).single()

const [{ data: dbEvents }, pracc] = await Promise.all([
  supabase.from('events').select('*').eq('team_id', teamId).gte('date', now.toISOString()).lte('date', weekLater.toISOString()).order('date', { ascending: true }),
  teamRow?.pracc_url
    ? fetch(`/api/calendar?url=${encodeURIComponent(teamRow.pracc_url)}`).then(r => r.json()).catch(() => [])
    : Promise.resolve([])
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
  const next = events[0]
  const msUntil = new Date(next.date) - now
  const hoursUntil = Math.floor(msUntil / 36e5)
  const timeUntil = hoursUntil < 1 ? 'Starting soon' : hoursUntil < 24 ? `In ${hoursUntil}h` : `In ${Math.floor(hoursUntil/24)}d`
  document.getElementById('stat-next-event').innerHTML = `${esc(next.title)} <span style="font-size:11px;font-weight:600;color:var(--accent);background:var(--accent)18;padding:2px 7px;border-radius:4px;margin-left:4px">${timeUntil}</span>`
  document.getElementById('stat-next-date').textContent = formatDate(next.date)

  function localDateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  }

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    d.setHours(0, 0, 0, 0)
    return d
  })

  upcomingEl.innerHTML = `<div class="week-grid">${days.map(day => {
    const dateStr = localDateStr(day)
    const dayLabel = day.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase()
    const dayNum   = day.getDate()
    const isToday  = day.getDate() === now.getDate() && day.getMonth() === now.getMonth() && day.getFullYear() === now.getFullYear()
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

const { count: stratCount } = await supabase.from('strats').select('*', { count: 'exact', head: true }).eq('team_id', teamId)
document.getElementById('stat-strats').textContent = stratCount ?? 0

const { data: stratMaps } = await supabase.from('strats').select('map').eq('team_id', teamId)
const uniqueMaps = new Set(stratMaps?.map(s => s.map) ?? [])
document.getElementById('stat-strats-sub').textContent = `Across ${uniqueMaps.size} map${uniqueMaps.size !== 1 ? 's' : ''}`

const { data: vodData } = await supabase.from('vods').select('maps').eq('team_id', teamId)
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
const totalM = mw + ml + md
const winPct = totalM ? Math.round((mw / totalM) * 100) : 0
document.getElementById('stat-vods').innerHTML = `<span style="color:var(--success)">${mw}W</span> <span style="color:var(--muted);font-size:16px">—</span> <span style="color:var(--danger)">${ml}L</span>`
document.getElementById('stat-vods').insertAdjacentHTML('afterend', `
  <div style="margin-top:8px;height:4px;border-radius:2px;background:var(--border);overflow:hidden">
    <div style="height:100%;width:${winPct}%;background:var(--success);border-radius:2px;transition:width .4s"></div>
  </div>
  <div style="font-size:11px;color:var(--muted);margin-top:4px">${winPct}% win rate · ${totalM} matches</div>
`)
document.getElementById('stat-vods-form').innerHTML = recentForm.map(r =>
  `<span class="form-dot form-dot-${r === 'W' ? 'win' : r === 'L' ? 'loss' : 'draw'}">${r}</span>`
).join('')

const { data: recentStrats } = await supabase
  .from('strats')
  .select('id, name, map, side, type, tags')
  .eq('team_id', teamId)
  .order('created_at', { ascending: false })
  .limit(3)

const recentEl = document.getElementById('recent-strats')
if (!recentStrats?.length) {
  recentEl.innerHTML = `<div class="empty-state"><h3>No strats yet</h3><p>Add one in the Stratbook.</p></div>`
} else {
  recentEl.innerHTML = recentStrats.map(s => {
    const sideColor = s.side === 't' ? 'var(--danger)' : 'var(--accent)'
    const mapFile = s.map === 'dust2' ? 'dust' : s.map
    return `
    <a class="list-row" href="stratbook-detail.html?id=${s.id}" style="border-left:3px solid ${sideColor};padding-left:12px">
      <div style="width:64px;height:44px;border-radius:6px;overflow:hidden;flex-shrink:0">
        <img src="images/maps/${mapFile}.png" alt="${esc(s.map)}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='<span style=font-size:10px;font-weight:700>${s.map.slice(0,3).toUpperCase()}</span>'">
      </div>
      <div class="flex-1">
        <div class="row-name">${esc(s.name)}</div>
        <div class="row-meta">${esc(s.map.charAt(0).toUpperCase()+s.map.slice(1))} · ${s.side === 't' ? 'T-Side' : 'CT-Side'} · ${esc(s.type)}</div>
      </div>
      ${(s.tags ?? []).slice(0,2).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
    </a>
  `}).join('')
}
