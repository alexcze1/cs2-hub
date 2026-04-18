// cs2-hub/dashboard.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

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

const { data: events } = await supabase
  .from('events')
  .select('*')
  .gte('date', now.toISOString())
  .lte('date', weekLater.toISOString())
  .order('date', { ascending: true })

const upcomingEl = document.getElementById('upcoming-events')
if (!events?.length) {
  upcomingEl.innerHTML = `<div class="empty-state"><h3>No events this week</h3><p>Add one in the Schedule section.</p></div>`
} else {
  upcomingEl.innerHTML = events.map(e => `
    <a class="list-row" href="schedule.html">
      ${eventBadge(e.type)}
      <div class="flex-1">
        <div class="row-name">${e.title}</div>
        ${e.opponent ? `<div class="row-meta">vs ${e.opponent}</div>` : ''}
      </div>
      <div class="row-meta">${formatDate(e.date)}</div>
    </a>
  `).join('')

  // Populate next-event stat card
  const next = events[0]
  document.getElementById('stat-next-event').textContent = next.title
  document.getElementById('stat-next-date').textContent = formatDate(next.date)
}

// Strat count
const { count: stratCount } = await supabase.from('strats').select('*', { count: 'exact', head: true })
document.getElementById('stat-strats').textContent = stratCount ?? 0

const { data: stratMaps } = await supabase.from('strats').select('map')
const uniqueMaps = new Set(stratMaps?.map(s => s.map) ?? [])
document.getElementById('stat-strats-sub').textContent = `Across ${uniqueMaps.size} map${uniqueMaps.size !== 1 ? 's' : ''}`

// VOD count
const { count: vodCount } = await supabase.from('vods').select('*', { count: 'exact', head: true })
document.getElementById('stat-vods').textContent = vodCount ?? 0

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
      <div class="map-badge">${s.map.slice(0,3)}</div>
      <div class="flex-1">
        <div class="row-name">${s.name}</div>
        <div class="row-meta">${s.map} · ${s.side === 't' ? 'T-Side' : 'CT-Side'} · ${s.type}</div>
      </div>
      ${(s.tags ?? []).slice(0,2).map(t => `<span class="tag">${t}</span>`).join('')}
    </a>
  `).join('')
}
