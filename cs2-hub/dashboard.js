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

const TYPE_LABELS = { scrim: 'SCRIM', tournament: 'TOURNAMENT', meeting: 'MEETING', vod_review: 'VOD REVIEW' }

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const teamId = getTeamId()
const now = new Date()
const hour = now.getHours()
const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
document.getElementById('date-sub').textContent = now.toLocaleDateString('en-GB', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
})
const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)

const { data: teamRow } = await supabase.from('teams').select('name, pracc_url').eq('id', teamId).single()
if (teamRow?.name) document.getElementById('page-greeting').textContent = `${greeting}, ${teamRow.name}`

const [{ data: dbEvents }, pracc, { data: vodMatchHist }] = await Promise.all([
  supabase.from('events').select('*').eq('team_id', teamId).gte('date', now.toISOString()).lte('date', horizon.toISOString()).order('date', { ascending: true }),
  teamRow?.pracc_url
    ? fetch(`/api/calendar?url=${encodeURIComponent(teamRow.pracc_url)}`).then(r => r.json()).catch(() => [])
    : Promise.resolve([]),
  supabase.from('vods').select('maps').eq('team_id', teamId).order('created_at', { ascending: false }).limit(5)
])

const praccEvents = (Array.isArray(pracc) ? pracc : []).filter(e => e.date >= now.toISOString() && e.date <= horizon.toISOString())
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

const matchTypes = ['tournament', 'scrim']
const nextMatch = events.find(e => matchTypes.includes(e.type)) ?? events[0] ?? null

function formatCountdown(ms) {
  if (ms < 60_000)         return { value: 'NOW',                 unit: '' }
  const mins  = Math.floor(ms / 60_000)
  if (mins < 60)           return { value: String(mins),          unit: 'min' }
  const hours = Math.floor(mins / 60)
  if (hours < 24)          return { value: String(hours),         unit: hours === 1 ? 'hour' : 'hours' }
  const days  = Math.floor(hours / 24)
  return                          { value: String(days),          unit: days === 1 ? 'day' : 'days' }
}

const recentForm = (vodMatchHist ?? []).map(v => {
  let w = 0, l = 0
  for (const m of v.maps ?? []) {
    if ((m.score_us ?? 0) > (m.score_them ?? 0)) w++
    else if ((m.score_them ?? 0) > (m.score_us ?? 0)) l++
  }
  return w > l ? 'W' : l > w ? 'L' : 'D'
})

const heroSlot = document.getElementById('hero-slot')
if (!nextMatch) {
  heroSlot.innerHTML = `
    <div class="hero-empty">
      <div class="hero-empty-title">No matches scheduled</div>
      <div class="hero-empty-sub">Add a scrim or tournament in the Schedule section.</div>
    </div>`
} else {
  const ms = new Date(nextMatch.date) - now
  const cd = formatCountdown(Math.max(0, ms))
  const isMatch = matchTypes.includes(nextMatch.type)
  const tagLabel = isMatch
    ? (nextMatch.type === 'tournament' ? 'OFFICIAL · NEXT MATCH' : 'SCRIM · NEXT MATCH')
    : `${TYPE_LABELS[nextMatch.type] ?? 'EVENT'} · NEXT UP`
  const opponent = isMatch ? esc(nextMatch.title.replace(/^vs\s+/i, '')) : esc(nextMatch.title)
  const vsLine = isMatch ? `<div class="hero-vs">vs</div>` : ''
  const formDotsHtml = recentForm.length
    ? `<div class="hero-form">
         <span class="hero-form-label">Recent form · last ${recentForm.length}</span>
         <div class="hero-form-dots">${recentForm.map(r =>
           `<span class="form-dot form-dot-${r === 'W' ? 'win' : r === 'L' ? 'loss' : 'draw'}">${r}</span>`
         ).join('')}</div>
       </div>`
    : ''

  heroSlot.innerHTML = `
    <div class="hero-card">
      <div>
        <div class="hero-tag">${tagLabel}</div>
        ${vsLine}
        <div class="hero-opponent">${opponent}</div>
        <div class="hero-meta">
          <span>${formatDate(nextMatch.date)}</span>
          ${nextMatch.location ? `<span class="hero-meta-divider"></span><span>${esc(nextMatch.location)}</span>` : ''}
        </div>
      </div>
      <div class="hero-right">
        <div>
          <div class="hero-countdown-label">Starts in</div>
          <div class="hero-countdown">${cd.value}<span class="hero-countdown-unit">${cd.unit}</span></div>
        </div>
        ${formDotsHtml}
      </div>
    </div>`
}

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

const timelineDays = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(now)
  d.setDate(d.getDate() + i)
  d.setHours(0, 0, 0, 0)
  return d
})

document.getElementById('timeline-slot').innerHTML = `
  <div class="timeline-strip">${timelineDays.map(day => {
    const dateStr = localDateStr(day)
    const dayLabel = day.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase()
    const dayNum = day.getDate()
    const isToday = day.getDate() === now.getDate() && day.getMonth() === now.getMonth() && day.getFullYear() === now.getFullYear()
    const dayEvents = events.filter(e => e.date.slice(0, 10) === dateStr)
    const dotsHtml = dayEvents.length
      ? dayEvents.slice(0, 4).map(e => `<span class="timeline-dot timeline-dot-${e.type}" title="${esc(e.title)}"></span>`).join('')
      : `<span class="timeline-day-empty">—</span>`
    return `
      <a class="timeline-day ${isToday ? 'timeline-day-today' : ''}" href="schedule.html">
        <div class="timeline-day-head">
          <span class="timeline-day-name">${isToday ? 'TODAY' : dayLabel}</span>
          <span class="timeline-day-num">${dayNum}</span>
        </div>
        <div class="timeline-day-events">${dotsHtml}</div>
      </a>`
  }).join('')}</div>`

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

const { data: issuesData } = await supabase.from('issues').select('status').eq('team_id', teamId)
const openIssues = (issuesData ?? []).filter(i => i.status !== 'resolved').length
const issueColor = openIssues > 0 ? 'var(--danger)' : 'var(--success)'
document.getElementById('stat-issues').innerHTML = `<span style="color:${issueColor}">${openIssues}</span>`
document.getElementById('stat-issues-sub').textContent = openIssues === 0 ? 'All clear' : `${openIssues} need attention`
document.getElementById('stat-issues-card').style.borderTopColor = issueColor

const { data: recentStrats } = await supabase
  .from('strats')
  .select('id, name, map, side, type, tags')
  .eq('team_id', teamId)
  .order('created_at', { ascending: false })
  .limit(5)

const recentEl = document.getElementById('recent-strats')
if (!recentStrats?.length) {
  recentEl.innerHTML = `<div class="empty-state"><h3>No strats yet</h3><p>Add one in the Stratbook.</p></div>`
} else {
  recentEl.innerHTML = recentStrats.map(s => {
    const sideColor = s.side === 't' ? 'var(--side-t)' : 'var(--side-ct)'
    const mapFile = s.map === 'dust2' ? 'dust' : s.map
    return `
    <a class="list-row" href="stratbook-detail.html?id=${s.id}" style="border-left:3px solid ${sideColor};padding-left:12px">
      <div class="map-badge"><img src="images/maps/${mapFile}.png" alt="${esc(s.map)}" onerror="this.parentElement.innerHTML='<span>${s.map.slice(0,3).toUpperCase()}</span>'"/></div>
      <div class="flex-1">
        <div class="row-name">${esc(s.name)}</div>
        <div class="row-meta">${esc(s.map.charAt(0).toUpperCase()+s.map.slice(1))} · ${s.side === 't' ? 'T-Side' : 'CT-Side'} · ${esc(s.type)}</div>
      </div>
      ${(s.tags ?? []).slice(0,2).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
    </a>
  `}).join('')
}
