import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { getPlayerImage } from './player-autocomplete.js'
import { aggregateTeamStats } from './team-stats-aggregate.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

// ── Density preference ───────────────────────────────────────────────
// Persisted across pages via localStorage so the chrome stays consistent
// regardless of where the user toggles it. Applied to <body> so every CSS
// rule that opts in (`body[data-density="compact"] …`) takes effect.
const DENSITY_KEY = 'dash:density'
function getDensity() {
  try { return localStorage.getItem(DENSITY_KEY) || 'comfortable' } catch { return 'comfortable' }
}
function applyDensity(value) {
  document.body.setAttribute('data-density', value)
  const el = document.getElementById('density-toggle-value')
  if (el) el.textContent = value === 'compact' ? 'Compact' : 'Comfy'
}
applyDensity(getDensity())
document.getElementById('density-toggle')?.addEventListener('click', () => {
  const next = getDensity() === 'compact' ? 'comfortable' : 'compact'
  try { localStorage.setItem(DENSITY_KEY, next) } catch {}
  applyDensity(next)
})

// Theme toggle — same persistence pattern as density. Default to dark
// since that's how the app shipped; light is opt-in.
const THEME_KEY = 'dash:theme'
function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'dark' } catch { return 'dark' }
}
function applyTheme(value) {
  document.body.setAttribute('data-theme', value)
  const el = document.getElementById('theme-toggle-value')
  if (el) el.textContent = value === 'light' ? 'Light' : 'Dark'
}
applyTheme(getTheme())
document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const next = getTheme() === 'light' ? 'dark' : 'light'
  try { localStorage.setItem(THEME_KEY, next) } catch {}
  applyTheme(next)
})

// Public team profile share — builds the canonical /public-team.html
// URL for the active team and either invokes the native share sheet
// (mobile, Safari) or copies to clipboard with a short success
// confirmation.
document.getElementById('share-public-btn')?.addEventListener('click', async () => {
  const tid = getTeamId()
  if (!tid) return
  const url = `${location.origin}/public-team.html?id=${tid}`
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Team Profile · MIDROUND', url })
    } else {
      await navigator.clipboard.writeText(url)
      const btn = document.getElementById('share-public-btn')
      const valEl = btn?.querySelector('.density-toggle-value')
      if (valEl) {
        const original = valEl.textContent
        valEl.textContent = 'Copied!'
        setTimeout(() => { valEl.textContent = original }, 1500)
      }
    }
  } catch {}
})

await requireAuth()
renderSidebar('dashboard')

const TYPE_LABELS = { scrim: 'SCRIM', tournament: 'TOURNAMENT', meeting: 'MEETING', vod_review: 'VOD REVIEW' }
const MAPS = ['mirage', 'inferno', 'nuke', 'ancient', 'anubis', 'overpass', 'dust2']
const MAP_LABELS = { mirage: 'Mirage', inferno: 'Inferno', nuke: 'Nuke', ancient: 'Ancient', anubis: 'Anubis', overpass: 'Overpass', dust2: 'Dust2' }

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function mapFile(map) { return map === 'dust2' ? 'dust' : map }

const teamId = getTeamId()
const now = new Date()
const hour = now.getHours()
const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
document.getElementById('date-sub').textContent = now.toLocaleDateString('en-GB', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
})
const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
const ago30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

// ── "What changed since you last looked" ─────────────────────────────
// localStorage holds the previous visit's timestamp; we render a diff for
// the current visit then write `now` so the next visit gets a fresh diff.
const LAST_SEEN_KEY = 'dash:last_seen'
let lastSeenISO = null
try {
  lastSeenISO = localStorage.getItem(LAST_SEEN_KEY) || null
} catch {}
const lastSeenDate = lastSeenISO ? new Date(lastSeenISO) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
const sinceISO = lastSeenDate.toISOString()
const sinceLabel = lastSeenISO
  ? `since ${lastSeenDate.toLocaleDateString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}`
  : 'first visit'
const sinceEl = document.getElementById('attention-since')
if (sinceEl) sinceEl.textContent = sinceLabel

const { data: teamRow } = await supabase.from('teams').select('name, pracc_url').eq('id', teamId).single()
if (teamRow?.name) document.getElementById('page-greeting').textContent = `${greeting}, ${teamRow.name}`

// One big parallel fetch. Everything the dashboard needs in a single round
// of awaits so the page doesn't wait on the slowest query serially.
const [
  { data: dbEvents },
  pracc,
  { data: vodData },
  { count: stratCount },
  { data: stratMaps },
  { data: recentStrats },
  { data: issuesData },
  { data: goalsData },
  { data: roster },
  { data: recentDemos },
] = await Promise.all([
  supabase.from('events').select('*').eq('team_id', teamId).gte('date', now.toISOString()).lte('date', horizon.toISOString()).order('date', { ascending: true }),
  teamRow?.pracc_url
    ? fetch(`/api/calendar?url=${encodeURIComponent(teamRow.pracc_url)}`).then(r => r.json()).catch(() => [])
    : Promise.resolve([]),
  supabase.from('vods').select('id, created_at, maps, match_date, opponent_name').eq('team_id', teamId).order('created_at', { ascending: false }).limit(200),
  supabase.from('strats').select('*', { count: 'exact', head: true }).eq('team_id', teamId),
  supabase.from('strats').select('map, created_at').eq('team_id', teamId),
  supabase.from('strats').select('id, name, map, side, type, tags').eq('team_id', teamId).order('created_at', { ascending: false }).limit(5),
  supabase.from('issues').select('id, status, title, created_at').eq('team_id', teamId),
  supabase.from('goals').select('id, title, status, horizon, due_date, category').eq('team_id', teamId).eq('status', 'active'),
  supabase.from('roster').select('id, nickname, role, steam_id, is_ghost').eq('team_id', teamId).order('nickname', { ascending: true }),
  supabase.from('demos').select('id, status, map, played_at, created_at, opponent_name').eq('team_id', teamId).gte('created_at', ago30.toISOString()).order('created_at', { ascending: false }).limit(200),
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

// Recent form derived from the top-5 vods (per-vod W/L/D verdict).
const recentForm = (vodData ?? []).slice(0, 5).map(v => {
  let w = 0, l = 0
  for (const m of v.maps ?? []) {
    if ((m.score_us ?? 0) > (m.score_them ?? 0)) w++
    else if ((m.score_them ?? 0) > (m.score_us ?? 0)) l++
  }
  return w > l ? 'W' : l > w ? 'L' : 'D'
})

// ── Streak: consecutive days of team activity ────────────────────────
// "Activity" = a demo was uploaded, a vod was created, or a strat was
// added. Walking backwards from today; the first gap ends the streak.
const activityDays = new Set()
for (const d of recentDemos ?? []) activityDays.add(localDateStr(new Date(d.created_at)))
for (const v of vodData ?? []) {
  const t = new Date(v.created_at).getTime()
  if (t >= ago30.getTime()) activityDays.add(localDateStr(new Date(v.created_at)))
}
for (const s of stratMaps ?? []) {
  const t = new Date(s.created_at).getTime()
  if (t >= ago30.getTime()) activityDays.add(localDateStr(new Date(s.created_at)))
}
let streak = 0
{
  const cur = new Date(now); cur.setHours(0,0,0,0)
  while (activityDays.has(localDateStr(cur))) {
    streak++
    cur.setDate(cur.getDate() - 1)
  }
}

// ── Today strip ──────────────────────────────────────────────────────
function renderTodayStrip() {
  const dateLine = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
  const nextLabel = nextMatch
    ? (() => {
        const cd = formatCountdown(Math.max(0, new Date(nextMatch.date) - now))
        const what = matchTypes.includes(nextMatch.type) ? 'next match' : (TYPE_LABELS[nextMatch.type] ?? 'event').toLowerCase()
        return `${cd.value}${cd.unit ? ' ' + cd.unit : ''} until ${what}`
      })()
    : 'no upcoming matches'
  const streakHtml = streak > 0
    ? `<span class="today-streak"><span class="today-streak-flame">▲</span> <strong>${streak}</strong> day streak</span>`
    : `<span class="today-streak today-streak-zero">No activity today</span>`
  document.getElementById('today-strip').innerHTML = `
    <div class="today-strip-row">
      <span class="today-strip-date">${esc(dateLine)}</span>
      <span class="today-strip-divider"></span>
      <span class="today-strip-next">${esc(nextLabel)}</span>
      <span class="today-strip-divider"></span>
      ${streakHtml}
    </div>`
}
renderTodayStrip()

// ── Active goal card (top priority horizon: weekly → monthly → long_term) ───
function renderGoalSlot() {
  const slot = document.getElementById('goal-slot')
  if (!goalsData?.length) { slot.innerHTML = ''; return }
  const order = { weekly: 0, monthly: 1, long_term: 2 }
  const sorted = [...goalsData].sort((a, b) => (order[a.horizon] ?? 9) - (order[b.horizon] ?? 9))
  const g = sorted[0]
  const horizonLabel = g.horizon === 'long_term' ? 'Long term' : g.horizon === 'monthly' ? 'Monthly' : 'Weekly'
  let dueHtml = ''
  if (g.due_date) {
    const due = new Date(g.due_date)
    const daysLeft = Math.ceil((due - now) / (24 * 60 * 60 * 1000))
    const dueColor = daysLeft <= 1 ? 'var(--danger)' : daysLeft <= 3 ? 'var(--warning)' : 'var(--muted)'
    dueHtml = `<span class="goal-due" style="color:${dueColor}">${daysLeft < 0 ? `${-daysLeft}d overdue` : daysLeft === 0 ? 'due today' : `${daysLeft}d left`}</span>`
  }
  slot.innerHTML = `
    <a href="goals.html" class="goal-active-card">
      <div class="goal-active-row">
        <span class="goal-active-tag">${esc(horizonLabel)} goal</span>
        ${dueHtml}
      </div>
      <div class="goal-active-title">${esc(g.title)}</div>
    </a>`
}
renderGoalSlot()

// ── Hero — next match, or form sparkline if no upcoming matches ──────
const heroSlot = document.getElementById('hero-slot')
if (!nextMatch) {
  // Form sparkline empty state.
  // We render the last 14 vods chronologically as vertical bars (green=W,
  // red=L, grey=D), plus a running W-L summary and last-result tag.
  const vodsAsc = [...(vodData ?? [])]
    .map(v => {
      let w = 0, l = 0
      for (const m of v.maps ?? []) {
        if ((m.score_us ?? 0) > (m.score_them ?? 0)) w++
        else if ((m.score_them ?? 0) > (m.score_us ?? 0)) l++
      }
      return { date: v.match_date || v.created_at, verdict: w > l ? 'W' : l > w ? 'L' : 'D', opponent: v.opponent_name }
    })
    .filter(v => v.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(-14)

  let wins = 0, losses = 0, draws = 0
  for (const v of vodsAsc) {
    if (v.verdict === 'W') wins++
    else if (v.verdict === 'L') losses++
    else draws++
  }
  const totalGames = wins + losses + draws
  const winPct = wins + losses ? Math.round((wins / (wins + losses)) * 100) : 0

  const bars = vodsAsc.map(v => {
    const cls = v.verdict === 'W' ? 'sparkbar-win' : v.verdict === 'L' ? 'sparkbar-loss' : 'sparkbar-draw'
    return `<span class="sparkbar ${cls}" title="${esc(v.verdict + ' vs ' + (v.opponent ?? ''))}"></span>`
  }).join('')

  const lastV = vodsAsc[vodsAsc.length - 1]
  const lastLine = lastV
    ? `Last result · <strong class="form-${lastV.verdict === 'W' ? 'win' : lastV.verdict === 'L' ? 'loss' : 'draw'}">${lastV.verdict}</strong> vs ${esc(lastV.opponent ?? 'unknown')}`
    : 'No matches reviewed yet.'

  heroSlot.innerHTML = `
    <div class="hero-card hero-form-card">
      <div class="hero-form-card-left">
        <div class="hero-tag">FORM · LAST ${vodsAsc.length || ''}</div>
        <div class="hero-opponent">${totalGames ? `${wins}–${losses}${draws ? ` (${draws}D)` : ''}` : 'No matches'}</div>
        <div class="hero-meta">${lastLine}</div>
      </div>
      <div class="hero-form-card-right">
        <div class="hero-countdown-label">Win rate</div>
        <div class="hero-countdown">${winPct}<span class="hero-countdown-unit">%</span></div>
        <div class="hero-sparkline">${bars || '<span class="hero-sparkline-empty">Upload demos and review them in Vods to see your form here.</span>'}</div>
      </div>
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

// ── Map pool readiness ───────────────────────────────────────────────
// Per map (7 active): win % from vods, days since last activity (demo or
// vod), and strat count. Colour-coded so the coach can tell at a glance
// which map deserves the next scrim.
function renderMapPool() {
  const stratCountByMap = {}
  for (const s of stratMaps ?? []) stratCountByMap[s.map] = (stratCountByMap[s.map] ?? 0) + 1

  const mapAgg = {}
  for (const v of vodData ?? []) {
    for (const m of v.maps ?? []) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      const a = mapAgg[m.map] ??= { w: 0, l: 0, lastDate: null }
      if (us > them) a.w++
      else if (them > us) a.l++
      const md = v.match_date || v.created_at
      if (md && (!a.lastDate || new Date(md) > new Date(a.lastDate))) a.lastDate = md
    }
  }
  for (const d of recentDemos ?? []) {
    const a = mapAgg[d.map] ??= { w: 0, l: 0, lastDate: null }
    const md = d.played_at || d.created_at
    if (md && (!a.lastDate || new Date(md) > new Date(a.lastDate))) a.lastDate = md
  }

  function statusFor(a, strats) {
    const games = a.w + a.l
    const wp = games ? a.w / games : null
    const daysSince = a.lastDate
      ? Math.floor((now - new Date(a.lastDate)) / (24 * 60 * 60 * 1000))
      : 999
    if (daysSince >= 14 || strats < 3 || (wp != null && wp < 0.4)) return 'cold'
    if (daysSince >= 7 || (wp != null && wp < 0.55)) return 'warm'
    return 'hot'
  }

  const rows = MAPS.map(m => {
    const a = mapAgg[m] || { w: 0, l: 0, lastDate: null }
    const strats = stratCountByMap[m] ?? 0
    const games = a.w + a.l
    const wp = games ? Math.round((a.w / games) * 100) : null
    const daysSince = a.lastDate
      ? Math.floor((now - new Date(a.lastDate)) / (24 * 60 * 60 * 1000))
      : null
    const lastLabel = daysSince == null ? '—' : daysSince === 0 ? 'today' : `${daysSince}d ago`
    const status = statusFor(a, strats)
    return `
      <a class="map-pool-row map-pool-row-${status}" href="stratbook.html?map=${m}">
        <div class="map-pool-img" style="background-image:url('images/maps/${mapFile(m)}.png')"></div>
        <div class="map-pool-name">${MAP_LABELS[m]}</div>
        <div class="map-pool-wp" title="Win rate from VODs">
          ${wp != null ? `<strong>${wp}%</strong><span class="map-pool-wp-sub">${a.w}–${a.l}</span>` : `<span class="map-pool-na">no data</span>`}
        </div>
        <div class="map-pool-last" title="Days since last activity">${lastLabel}</div>
        <div class="map-pool-strats" title="Strats saved">${strats}</div>
        <div class="map-pool-dot map-pool-dot-${status}" title="${status === 'hot' ? 'In rhythm' : status === 'warm' ? 'Needs attention' : 'Cold — scrim this map'}"></div>
      </a>`
  }).join('')

  document.getElementById('map-pool-slot').innerHTML = `
    <div class="map-pool-grid">
      <div class="map-pool-head">
        <div></div><div>Map</div><div>Win %</div><div>Last</div><div>Strats</div><div></div>
      </div>
      ${rows}
    </div>`
}
renderMapPool()

// ── What needs attention ────────────────────────────────────────────
// Surfaces (in priority order):
//   1. Imminent events (<24 h)
//   2. Open issues
//   3. Demos that finished parsing but never got a VOD review
//   4. New artifacts since last visit (demos, vods, strats, issues)
function renderAttentionInbox() {
  const items = []

  // Imminent events
  for (const e of events) {
    const ms = new Date(e.date) - now
    if (ms <= 24 * 60 * 60 * 1000 && ms >= 0) {
      const cd = formatCountdown(ms)
      const label = matchTypes.includes(e.type)
        ? `${e.type === 'tournament' ? 'Tournament' : 'Scrim'} vs ${e.title?.replace(/^vs\s+/i, '') ?? '?'}`
        : (e.title || TYPE_LABELS[e.type] || 'Event')
      items.push({ kind: 'event', icon: '▶', text: `${label} in ${cd.value}${cd.unit ? ' ' + cd.unit : ''}`, href: 'schedule.html', priority: 1 })
      break
    }
  }

  // Open issues
  const openIssues = (issuesData ?? []).filter(i => i.status !== 'resolved')
  if (openIssues.length > 0) {
    items.push({
      kind: 'issue',
      icon: '!',
      text: `<strong>${openIssues.length}</strong> open issue${openIssues.length === 1 ? '' : 's'}`,
      href: 'issues.html',
      priority: 2,
    })
  }

  // Demos without VOD review.
  // We treat any "ready"-status uploaded team demo whose played_at falls in
  // a window not already covered by an existing VOD's match_date as
  // unreviewed. Conservative: only count team demos (not public/HLTV ones).
  const vodDateSet = new Set()
  for (const v of vodData ?? []) {
    if (v.match_date) vodDateSet.add(v.match_date.slice(0, 10))
  }
  const unreviewed = (recentDemos ?? []).filter(d => {
    if (d.status !== 'ready') return false
    const dayStr = (d.played_at || d.created_at)?.slice(0, 10)
    return dayStr && !vodDateSet.has(dayStr)
  })
  // Group by day so 3 maps from one scrim show as 1 item.
  const unreviewedDays = new Set(unreviewed.map(d => (d.played_at || d.created_at).slice(0, 10)))
  if (unreviewedDays.size > 0) {
    items.push({
      kind: 'demo',
      icon: '◍',
      text: `<strong>${unreviewedDays.size}</strong> scrim day${unreviewedDays.size === 1 ? '' : 's'} without a VOD review`,
      href: 'vods.html',
      priority: 3,
    })
  }

  // What changed since last seen
  const newDemos = (recentDemos ?? []).filter(d => d.created_at > sinceISO).length
  const newVods = (vodData ?? []).filter(v => v.created_at > sinceISO).length
  const newStrats = (stratMaps ?? []).filter(s => s.created_at > sinceISO).length
  const newIssues = (issuesData ?? []).filter(i => i.created_at > sinceISO).length

  const changedParts = []
  if (newDemos > 0)  changedParts.push(`${newDemos} demo${newDemos === 1 ? '' : 's'}`)
  if (newVods > 0)   changedParts.push(`${newVods} review${newVods === 1 ? '' : 's'}`)
  if (newStrats > 0) changedParts.push(`${newStrats} strat${newStrats === 1 ? '' : 's'}`)
  if (newIssues > 0) changedParts.push(`${newIssues} issue${newIssues === 1 ? '' : 's'}`)
  if (changedParts.length && lastSeenISO) {
    items.push({
      kind: 'changed',
      icon: '+',
      text: `New ${sinceLabel}: ${changedParts.join(', ')}`,
      href: 'demos.html',
      priority: 4,
    })
  }

  const slot = document.getElementById('attention-slot')
  if (!items.length) {
    slot.innerHTML = `
      <div class="attention-empty">
        <div class="attention-empty-tick">✓</div>
        <div>All clear. Nothing demanding action right now.</div>
      </div>`
  } else {
    items.sort((a, b) => a.priority - b.priority)
    slot.innerHTML = `
      <div class="attention-list">
        ${items.map(it => `
          <a href="${it.href}" class="attention-row attention-row-${it.kind}">
            <span class="attention-icon">${it.icon}</span>
            <span class="attention-text">${it.text}</span>
            <span class="attention-chevron">→</span>
          </a>
        `).join('')}
      </div>`
  }
}
renderAttentionInbox()

// ── Player heat strip ────────────────────────────────────────────────
// Five mini cards (or however many starters the team has). For each
// roster member we aggregate K/D and rating from demo_players in the last
// 30 days. The "trend" is a comparison of the latest half vs the prior
// half of their demos in the window, so even sparse data shows direction.
async function renderPlayerHeatStrip() {
  const slot = document.getElementById('player-heat-slot')
  const starters = (roster ?? []).filter(p => p.role !== 'Coach' && p.role !== 'Manager' && p.role !== 'Bench' && !p.is_ghost)
  if (!starters.length) {
    slot.innerHTML = `
      <div class="empty-state-art">
        <div class="empty-state-art-icon">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </div>
        <div class="empty-state-art-title">No active roster</div>
        <div class="empty-state-art-sub">Add five starters in the Roster section to see per-player K/D, ratings, and form trends here.</div>
        <a href="roster.html" class="empty-state-art-cta">Open Roster →</a>
      </div>`
    return
  }

  // Pull demo_players rows for our team's last-30d demos. The stats
  // migration added `side='all'` rows that summarise the full demo for
  // each player — we filter to those so we get one row per (player,
  // demo) instead of three (ct/t/all).
  const demoIds = (recentDemos ?? []).filter(d => d.status === 'ready').map(d => d.id)
  let perPlayer = {}
  if (demoIds.length) {
    const { data: dp } = await supabase
      .from('demo_players')
      .select('demo_id, steam_id, kills, deaths, assists, rating, side')
      .in('demo_id', demoIds.slice(0, 200))
      .eq('side', 'all')
    const demoDateById = {}
    for (const d of recentDemos ?? []) demoDateById[d.id] = d.played_at || d.created_at
    for (const r of dp ?? []) {
      if (!r.steam_id) continue
      const bucket = perPlayer[r.steam_id] ??= { rows: [] }
      bucket.rows.push({
        date: demoDateById[r.demo_id] || null,
        k: r.kills ?? 0, d: r.deaths ?? 0, a: r.assists ?? 0,
        rating: r.rating ?? null,
      })
    }
  }

  // Avatars in parallel (one fetch per starter).
  const images = await Promise.all(starters.map(p => getPlayerImage(p.nickname).catch(() => null)))

  function summarize(rows) {
    if (!rows.length) return { games: 0, kd: null, rating: null, trend: '–' }
    rows.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0))
    const games = rows.length
    let tk = 0, td = 0
    for (const r of rows) { tk += r.k; td += r.d }
    const kd = td > 0 ? tk / td : tk
    const ratings = rows.map(r => r.rating).filter(x => x != null)
    const rating = ratings.length ? ratings.reduce((s, x) => s + x, 0) / ratings.length : null

    let trend = '–'
    if (games >= 4) {
      const half = Math.floor(games / 2)
      const recent = rows.slice(-half)
      const prior  = rows.slice(0, half)
      const avg = arr => {
        const valid = arr.map(r => r.rating).filter(x => x != null)
        if (!valid.length) {
          // fall back to per-game K/D if rating missing
          let k = 0, d = 0
          for (const r of arr) { k += r.k; d += r.d }
          return d > 0 ? k / d : k
        }
        return valid.reduce((s, x) => s + x, 0) / valid.length
      }
      const r1 = avg(prior), r2 = avg(recent)
      if (r2 > r1 * 1.05) trend = '▲'
      else if (r2 < r1 * 0.95) trend = '▼'
      else trend = '–'
    }
    return { games, kd, rating, trend }
  }

  const ROLE_COLORS = {
    IGL: 'var(--accent)', AWPer: 'var(--special)', Entry: 'var(--danger)',
    Support: 'var(--success)', Lurker: 'var(--warning)',
  }

  slot.innerHTML = `
    <div class="player-heat-strip">
      ${starters.map((p, i) => {
        const stats = summarize(perPlayer[p.steam_id]?.rows ?? [])
        const role = p.role || 'Unassigned'
        const roleColor = ROLE_COLORS[role] ?? 'var(--border)'
        const trendCls = stats.trend === '▲' ? 'up' : stats.trend === '▼' ? 'down' : 'flat'
        const img = images[i]
        const avatar = img
          ? `<img src="${esc(img)}" alt="${esc(p.nickname)}" class="player-heat-avatar" style="border-color:${roleColor}">`
          : `<div class="player-heat-avatar player-heat-avatar-fallback" style="background:${roleColor}22;border-color:${roleColor};color:${roleColor}">${esc((p.nickname || '?').slice(0,2).toUpperCase())}</div>`
        return `
          <div class="player-heat-card">
            ${avatar}
            <div class="player-heat-name">${esc(p.nickname)}</div>
            <div class="player-heat-role" style="color:${roleColor}">${esc(role)}</div>
            <div class="player-heat-stats">
              <span class="player-heat-kd">${stats.kd != null ? stats.kd.toFixed(2) : '—'}</span>
              <span class="player-heat-kd-label">K/D</span>
            </div>
            <div class="player-heat-foot">
              <span class="player-heat-trend player-heat-trend-${trendCls}">${stats.trend}</span>
              <span class="player-heat-games">${stats.games} ${stats.games === 1 ? 'game' : 'games'}</span>
            </div>
          </div>`
      }).join('')}
    </div>`
}
renderPlayerHeatStrip()

// ── Next 7 days timeline (unchanged) ────────────────────────────────
const timelineDays = Array.from({ length: 7 }, (_, i) => {
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
    const visible = dayEvents.slice(0, 3)
    const overflow = dayEvents.length - visible.length
    const eventsHtml = dayEvents.length
      ? visible.map(e => {
          const t = new Date(e.date)
          const time = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`
          const label = e.title?.trim() || TYPE_LABELS[e.type] || 'Event'
          return `<div class="timeline-event timeline-event-${e.type}" title="${esc(label)}">
            <span class="timeline-event-time">${time}</span>
            <span class="timeline-event-title">${esc(label)}</span>
          </div>`
        }).join('') + (overflow > 0 ? `<div class="timeline-event-more">+${overflow} more</div>` : '')
      : `<span class="timeline-day-empty">—</span>`
    return `
      <a class="timeline-day ${isToday ? 'timeline-day-today' : ''}" href="schedule.html">
        <div class="timeline-day-head">
          <span class="timeline-day-name">${isToday ? 'TODAY' : dayLabel}</span>
          <span class="timeline-day-num">${dayNum}</span>
        </div>
        <div class="timeline-day-events">${eventsHtml}</div>
      </a>`
  }).join('')}</div>`

// ── Stat cards + auto-insights (existing) ────────────────────────────
document.getElementById('stat-strats').textContent = stratCount ?? 0
const uniqueMaps = new Set(stratMaps?.map(s => s.map) ?? [])
document.getElementById('stat-strats-sub').textContent = `Across ${uniqueMaps.size} map${uniqueMaps.size !== 1 ? 's' : ''}`

let mw = 0, ml = 0, md = 0
const mapAgg = {}
for (const v of vodData ?? []) {
  const maps = v.maps ?? []
  let w = 0, l = 0
  for (const m of maps) {
    const us = m.score_us ?? 0, them = m.score_them ?? 0
    const a = mapAgg[m.map] ??= { w: 0, l: 0, rw: 0, rl: 0 }
    a.rw += us; a.rl += them
    if (us > them) { w++; a.w++ }
    else if (them > us) { l++; a.l++ }
  }
  if (w > l) mw++; else if (l > w) ml++; else if (maps.length) md++
}
const totalM = mw + ml + md
const winPct = totalM ? Math.round((mw / totalM) * 100) : 0

function deriveDashboardInsights() {
  const out = []
  if (recentForm.length >= 3) {
    const lossStreak = recentForm.findIndex(r => r !== 'L')
    const winStreak  = recentForm.findIndex(r => r !== 'W')
    if (lossStreak === -1 || lossStreak >= 3) {
      out.push({ kind: 'warning', tag: 'Form Alert', text: `<strong>${lossStreak === -1 ? recentForm.length : lossStreak} losses</strong> in a row. Time to reset.`, sub: 'Recent match form' })
    } else if (winStreak === -1 || winStreak >= 3) {
      out.push({ kind: 'positive', tag: 'On a Roll', text: `<strong>${winStreak === -1 ? recentForm.length : winStreak} wins</strong> in a row. Keep the momentum.`, sub: 'Recent match form' })
    }
  }
  const ranked = Object.entries(mapAgg)
    .filter(([, a]) => a.w + a.l >= 2)
    .map(([map, a]) => ({ map, games: a.w + a.l, wp: Math.round((a.w / (a.w + a.l)) * 100), ...a }))
  if (ranked.length) {
    ranked.sort((a, b) => b.wp - a.wp)
    const best = ranked[0]
    const worst = ranked[ranked.length - 1]
    if (best && best.wp >= 60 && best.games >= 2) {
      out.push({ kind: 'positive', tag: 'Strong Map', text: `Pick <strong>${best.map.charAt(0).toUpperCase()+best.map.slice(1)}</strong> when possible — <strong>${best.wp}%</strong> win rate.`, sub: `${best.w}W — ${best.l}L over ${best.games} games` })
    }
    if (worst && worst !== best && worst.wp <= 40 && worst.games >= 2) {
      out.push({ kind: 'warning', tag: 'Weak Map', text: `Ban <strong>${worst.map.charAt(0).toUpperCase()+worst.map.slice(1)}</strong> first — only <strong>${worst.wp}%</strong> win rate.`, sub: `${worst.w}W — ${worst.l}L over ${worst.games} games` })
    }
  }
  let totRW = 0, totRL = 0
  for (const a of Object.values(mapAgg)) { totRW += a.rw; totRL += a.rl }
  if (totRW + totRL >= 30) {
    const roundWp = Math.round((totRW / (totRW + totRL)) * 100)
    if (roundWp >= 55) {
      out.push({ kind: 'positive', tag: 'Round Control', text: `Winning <strong>${roundWp}%</strong> of rounds across all maps.`, sub: `${totRW}W — ${totRL}L rounds` })
    } else if (roundWp <= 45) {
      out.push({ kind: 'warning', tag: 'Round Control', text: `Only <strong>${roundWp}%</strong> round win rate — economy and trades need work.`, sub: `${totRW}W — ${totRL}L rounds` })
    }
  }
  return out.slice(0, 3)
}

const insights = deriveDashboardInsights()
if (insights.length) {
  document.getElementById('insight-slot').innerHTML = `
    <div class="section-label" style="margin-top:6px">Auto-Insights</div>
    <div class="insight-grid">
      ${insights.map(i => `
        <div class="insight-card insight-card-${i.kind}">
          <div class="insight-tag">${i.tag}</div>
          <div class="insight-text">${i.text}</div>
          <div class="insight-sub">${i.sub}</div>
        </div>
      `).join('')}
    </div>`
}
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

const openIssues = (issuesData ?? []).filter(i => i.status !== 'resolved').length
const issueClass = openIssues > 0 ? 'stat-card-danger' : 'stat-card-success'
const issueColorVar = openIssues > 0 ? 'var(--danger)' : 'var(--success)'
document.getElementById('stat-issues').innerHTML = `<span style="color:${issueColorVar}">${openIssues}</span>`
document.getElementById('stat-issues-sub').textContent = openIssues === 0 ? 'All clear' : `${openIssues} need attention`
const issuesCard = document.getElementById('stat-issues-card')
issuesCard.classList.remove('stat-card-muted')
issuesCard.classList.add(issueClass)

// ── Recent strats ────────────────────────────────────────────────
const recentEl = document.getElementById('recent-strats')
if (!recentStrats?.length) {
  recentEl.innerHTML = `
    <div class="empty-state-art">
      <div class="empty-state-art-icon">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
      </div>
      <div class="empty-state-art-title">No strats saved yet</div>
      <div class="empty-state-art-sub">Strats are the team's living tactical playbook — defaults, executes, anti-strats, pistol scripts.</div>
      <a href="stratbook.html" class="empty-state-art-cta">Open Stratbook →</a>
    </div>`
} else {
  recentEl.innerHTML = recentStrats.map(s => {
    const sideColor = s.side === 't' ? 'var(--side-t)' : 'var(--side-ct)'
    const file = mapFile(s.map)
    const abbr = String(s.map ?? '').slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, '')
    return `
    <a class="list-row" href="stratbook-detail.html?id=${s.id}" style="border-left:3px solid ${sideColor};padding-left:12px">
      <div class="map-badge"><img src="images/maps/${file}.png" alt="${esc(s.map)}" onerror="this.parentElement.innerHTML='<span>${abbr}</span>'"/></div>
      <div class="flex-1">
        <div class="row-name">${esc(s.name)}</div>
        <div class="row-meta">${esc(s.map.charAt(0).toUpperCase()+s.map.slice(1))} · ${s.side === 't' ? 'T-Side' : 'CT-Side'} · ${esc(s.type)}</div>
      </div>
      ${(s.tags ?? []).slice(0,2).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
    </a>
  `}).join('')
}

// ── Activity ticker — last team actions across all artifacts ───────
// Synthesized from data we already fetched: demos, vods, strats,
// issues. No extra round-trip. Window is 14 days; we render up to 8
// rows ordered newest-first.
function renderActivity() {
  const slot = document.getElementById('activity-slot')
  if (!slot) return
  const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).getTime()
  const events = []
  for (const d of recentDemos ?? []) {
    const ts = new Date(d.created_at).getTime()
    if (ts < cutoff) continue
    events.push({
      ts, kind: 'demo', icon: '◍',
      text: `Demo uploaded${d.map ? ` · ${d.map.charAt(0).toUpperCase() + d.map.slice(1)}` : ''}${d.opponent_name ? ` vs ${d.opponent_name}` : ''}`,
      href: `demo-viewer.html?id=${d.id}`,
      previewAttr: `data-preview-demo="${d.id}"`,
    })
  }
  for (const v of vodData ?? []) {
    const ts = new Date(v.created_at).getTime()
    if (ts < cutoff) continue
    events.push({
      ts, kind: 'vod', icon: '▶',
      text: `Match review created${v.opponent_name ? ` · vs ${v.opponent_name}` : ''}`,
      href: `vod-detail.html?id=${v.id}`,
      previewAttr: `data-preview-vod="${v.id}"`,
    })
  }
  for (const s of stratMaps ?? []) {
    const ts = new Date(s.created_at).getTime()
    if (ts < cutoff) continue
    events.push({
      ts, kind: 'strat', icon: '✦',
      text: `Strat added${s.map ? ` · ${s.map.charAt(0).toUpperCase() + s.map.slice(1)}` : ''}`,
      href: 'stratbook.html',
    })
  }
  for (const i of issuesData ?? []) {
    const ts = new Date(i.created_at).getTime()
    if (ts < cutoff) continue
    events.push({
      ts, kind: 'issue', icon: '!',
      text: `Issue logged · ${i.title || 'untitled'}`,
      href: 'issues.html',
    })
  }
  events.sort((a, b) => b.ts - a.ts)
  const top = events.slice(0, 8)
  if (!top.length) {
    slot.innerHTML = `
      <div class="activity-empty">
        Nothing logged in the last 14 days. Upload a demo, add a strat, or schedule a scrim to get the team rolling.
      </div>`
    return
  }
  slot.innerHTML = `
    <div class="activity-feed">
      ${top.map(e => {
        const when = new Date(e.ts)
        const ago = Math.round((now - when) / (60 * 60 * 1000))
        const whenLabel = ago < 1 ? 'just now'
          : ago < 24 ? `${ago}h ago`
          : `${Math.round(ago / 24)}d ago`
        return `
          <a class="activity-row activity-row-${e.kind}" href="${esc(e.href)}" ${e.previewAttr ?? ''}>
            <span class="activity-icon">${e.icon}</span>
            <span class="activity-text">${esc(e.text)}</span>
            <span class="activity-when">${whenLabel}</span>
          </a>`
      }).join('')}
    </div>`
}
renderActivity()

// ── Team Economy widget ──────────────────────────────────────────────
// Promotes the eco / force / pistol / first-duel breakdown that's
// computed by team-stats-aggregate.js (but only exposed on the analysis
// page today) so it's visible on the home page.
//
// Per-demo we figure out which team letter ('a' / 'b') is "us" — either
// from the parser-set ct_team_name / t_team_name (preferred — set by
// the assign-teams modal) or by name-match against HLTV's team_a /
// team_b. Demos where we can't determine the letter are skipped.
async function renderTeamEconomy() {
  const slot = document.getElementById('team-economy-slot')
  if (!slot) return
  if (!teamRow?.name) { slot.innerHTML = ''; return }

  slot.innerHTML = `
    <div class="skeleton-strip">
      <div class="skeleton skeleton-card" style="height:78px"></div>
      <div class="skeleton skeleton-card" style="height:78px"></div>
      <div class="skeleton skeleton-card" style="height:78px"></div>
      <div class="skeleton skeleton-card" style="height:78px"></div>
      <div class="skeleton skeleton-card" style="height:78px"></div>
      <div class="skeleton skeleton-card" style="height:78px"></div>
    </div>`

  try {
    const ago30Iso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: demosForEcon } = await supabase
      .from('demos')
      .select('id, ct_team_name, t_team_name, team_a_name, team_b_name, team_a_first_side')
      .eq('team_id', teamId)
      .eq('status', 'ready')
      .gte('created_at', ago30Iso)
      .limit(80)

    const norm = s => (s ?? '').toString().toLowerCase().trim()
    const ourLc = norm(teamRow.name)
    const ourLetterByDemo = new Map()
    for (const d of demosForEcon ?? []) {
      let letter = null
      if (d.ct_team_name && d.t_team_name) {
        const ctLc = norm(d.ct_team_name)
        const tLc  = norm(d.t_team_name)
        if (ctLc === ourLc) letter = d.team_a_first_side === 't' ? 'b' : 'a'
        else if (tLc === ourLc) letter = d.team_a_first_side === 't' ? 'a' : 'b'
      } else {
        const aLc = norm(d.team_a_name)
        const bLc = norm(d.team_b_name)
        if (aLc === ourLc) letter = 'a'
        else if (bLc === ourLc) letter = 'b'
      }
      if (letter) ourLetterByDemo.set(d.id, letter)
    }

    if (!ourLetterByDemo.size) {
      slot.innerHTML = `
        <div class="empty-state-art">
          <div class="empty-state-art-icon">·</div>
          <div class="empty-state-art-title">No round stats yet</div>
          <div class="empty-state-art-sub">Upload demos and assign which side is your team — round-by-round economy and opening duels will land here automatically.</div>
          <a href="demos.html" class="empty-state-art-cta">Upload demos →</a>
        </div>`
      return
    }

    const { data: statRows } = await supabase
      .from('demo_team_stats')
      .select('*')
      .in('demo_id', [...ourLetterByDemo.keys()])
    const ourRows = (statRows ?? []).filter(r => ourLetterByDemo.get(r.demo_id) === r.team)
    if (!ourRows.length) {
      slot.innerHTML = `
        <div class="empty-state-art">
          <div class="empty-state-art-icon">·</div>
          <div class="empty-state-art-title">Stats still processing</div>
          <div class="empty-state-art-sub">demo_team_stats rows haven't been written for these demos yet — re-check in a minute.</div>
        </div>`
      return
    }

    const agg = aggregateTeamStats(ourRows)
    const tiles = [
      { key: 'pistols',    label: 'Pistol',     hint: 'pistol-round win rate' },
      { key: 'anti_ecos',  label: 'Anti-eco',   hint: 'rounds vs opponent eco' },
      { key: 'half_buy',   label: 'Half buy',   hint: 'partial-buy round win rate' },
      { key: 'full_buy',   label: 'Full buy',   hint: 'full-buy round win rate' },
      { key: 'ct',         label: 'CT side',    hint: 'rounds played on CT' },
      { key: 't',          label: 'T side',     hint: 'rounds played on T' },
    ]
    const opening = agg.opening_duel
    const openingPct = opening?.pct
    const openingLabel = openingPct != null ? `${Math.round(openingPct * 100)}` : '—'

    const tileHtml = tiles.map(t => {
      const v = agg[t.key]
      if (!v || !v.played) {
        return `
          <div class="econ-tile econ-tile-empty">
            <div class="econ-tile-label">${t.label}</div>
            <div class="econ-tile-value">—<span class="econ-tile-unit">%</span></div>
            <div class="econ-tile-sub">no rounds yet</div>
          </div>`
      }
      const pct = Math.round((v.pct ?? 0) * 100)
      const tone = pct >= 55 ? 'good' : pct <= 45 ? 'bad' : 'flat'
      return `
        <div class="econ-tile econ-tile-${tone}" title="${t.hint}">
          <div class="econ-tile-label">${t.label}</div>
          <div class="econ-tile-value">${pct}<span class="econ-tile-unit">%</span></div>
          <div class="econ-tile-sub">${v.wins}–${v.played - v.wins} of ${v.played}</div>
        </div>`
    }).join('')

    const totalFirst = agg.first_kills + agg.first_deaths
    const openingTone = openingPct == null ? 'flat'
      : openingPct >= 0.55 ? 'good'
      : openingPct <= 0.45 ? 'bad' : 'flat'
    const openingTile = `
      <div class="econ-tile econ-tile-${openingTone}" title="who wins the first kill of the round">
        <div class="econ-tile-label">Opening</div>
        <div class="econ-tile-value">${openingLabel}<span class="econ-tile-unit">%</span></div>
        <div class="econ-tile-sub">${agg.first_kills}–${agg.first_deaths} of ${totalFirst}</div>
      </div>`

    slot.innerHTML = `
      <div class="econ-grid">
        ${tileHtml}
        ${openingTile}
      </div>`
  } catch (e) {
    console.warn('[dashboard] team economy failed', e)
    slot.innerHTML = ''
  }
}
renderTeamEconomy()

// Stamp last-seen so the next visit shows a fresh diff. Done at the very
// end so it can never partial-skip the inbox computation above.
try { localStorage.setItem(LAST_SEEN_KEY, now.toISOString()) } catch {}
