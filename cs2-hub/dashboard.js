import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { aggregateTeamStats } from './team-stats-aggregate.js'
import { radarSVG } from './charts.js'

function esc(text) { const d = document.createElement('div'); d.textContent = text ?? ''; return d.innerHTML }

// ── Inline icon set (Lucide-style) ───────────────────────────────────
const ICON = {
  winrate:`<path d="M3 3v18h18"/><path d="M19 9l-5 5-3-3-4 4"/>`,
  trophy:`<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>`,
  round:`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  adr:`<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
  kd:`<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/>`,
  arrow:`<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>`,
  chev:`<polyline points="9 18 15 12 9 6"/>`,
  play:`<polygon points="5 3 19 12 5 21 5 3"/>`,
  up:`<polyline points="6 15 12 9 18 15"/>`,
  down:`<polyline points="6 9 12 15 18 9"/>`,
}
const svg = (p, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`
function paintStaticIcons() { for (const el of document.querySelectorAll('[data-ic]')) el.innerHTML = svg(ICON[el.dataset.ic] || '') }

// Public team profile share (unchanged behaviour).
document.getElementById('share-public-btn')?.addEventListener('click', async () => {
  const tid = getTeamId(); if (!tid) return
  const url = `${location.origin}/public-team.html?id=${tid}`
  try {
    if (navigator.share) { await navigator.share({ title: 'Team Profile · MIDROUND', url }) }
    else {
      await navigator.clipboard.writeText(url)
      const label = document.getElementById('share-public-label')
      if (label) { const o = label.textContent; label.textContent = 'Copied!'; setTimeout(() => { label.textContent = o }, 1500) }
    }
  } catch {}
})

await requireAuth()
renderSidebar('dashboard')
paintStaticIcons()

const TYPE_LABELS = { scrim: 'SCRIM', tournament: 'TOURNAMENT', meeting: 'MEETING', vod_review: 'VOD REVIEW' }
const MAPS = ['mirage', 'inferno', 'nuke', 'ancient', 'anubis', 'overpass', 'dust2']
const MAP_LABELS = { mirage: 'Mirage', inferno: 'Inferno', nuke: 'Nuke', ancient: 'Ancient', anubis: 'Anubis', overpass: 'Overpass', dust2: 'Dust2' }
const cap = s => (s ?? '').charAt(0).toUpperCase() + (s ?? '').slice(1)
const mapFile = m => (m === 'dust2' ? 'dust' : m)
const localDateStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
const initials = (s, n = 2) => (s || '?').replace(/[^a-zA-Z0-9 ]/g, '').trim().split(/\s+/).map(w => w[0]).join('').slice(0, n).toUpperCase() || '?'

const teamId = getTeamId()
const now = new Date()
const hour = now.getHours()
const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
document.getElementById('date-sub').textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
const ago30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

// "Since last visit" diff window for the Coach's Brief.
const LAST_SEEN_KEY = 'dash:last_seen'
let lastSeenISO = null
try { lastSeenISO = localStorage.getItem(LAST_SEEN_KEY) || null } catch {}
const lastSeenDate = lastSeenISO ? new Date(lastSeenISO) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
const sinceISO = lastSeenDate.toISOString()
const sinceLabel = lastSeenISO ? `since ${lastSeenDate.toLocaleDateString('en-GB', { day:'numeric', month:'short' })}` : 'first visit'

const { data: teamRow } = await supabase.from('teams').select('name, pracc_url').eq('id', teamId).single()
const teamName = teamRow?.name || 'your team'
document.getElementById('page-greeting').innerHTML = `${esc(greeting)}, <span class="accent">${esc(teamName)}</span>`

{
  const tier = teamRow?.tier || 'free'
  const badge = document.getElementById('tier-badge')
  if (badge) {
    badge.textContent = tier === 'pro' ? 'PRO' : tier === 'pro-plus' ? 'PRO+' : 'FREE'
    badge.className = `tier-badge tier-badge-${tier}`; badge.style.display = 'inline-flex'
  }
}

// ── One parallel fetch for everything the page needs ─────────────────
const [
  { data: dbEvents }, pracc, { data: vodData }, { count: stratCount },
  { data: stratMaps }, { data: issuesData }, { data: goalsData },
  { data: roster }, { data: recentDemos },
] = await Promise.all([
  supabase.from('events').select('*').eq('team_id', teamId).gte('date', now.toISOString()).lte('date', horizon.toISOString()).order('date', { ascending: true }),
  teamRow?.pracc_url ? fetch(`/api/calendar?url=${encodeURIComponent(teamRow.pracc_url)}`).then(r => r.json()).catch(() => []) : Promise.resolve([]),
  supabase.from('vods').select('id, created_at, maps, match_date, opponent_name').eq('team_id', teamId).order('created_at', { ascending: false }).limit(200),
  supabase.from('strats').select('*', { count: 'exact', head: true }).eq('team_id', teamId),
  supabase.from('strats').select('map, created_at').eq('team_id', teamId),
  supabase.from('issues').select('id, status, title, created_at').eq('team_id', teamId),
  supabase.from('goals').select('id, title, status, horizon, due_date, category').eq('team_id', teamId).eq('status', 'active'),
  supabase.from('roster').select('id, nickname, role, steam_id, is_ghost').eq('team_id', teamId),
  supabase.from('demos').select('id, status, map, played_at, created_at, opponent_name').eq('team_id', teamId).gte('created_at', ago30.toISOString()).order('created_at', { ascending: false }).limit(200),
])

const praccEvents = (Array.isArray(pracc) ? pracc : []).filter(e => e.date >= now.toISOString() && e.date <= horizon.toISOString())
const events = [...(dbEvents ?? []), ...praccEvents].sort((a, b) => new Date(a.date) - new Date(b.date))

// ── Per-match series (chronological) ─────────────────────────────────
// Each logged match → round win %, match verdict, opponent, date. This
// drives the performance chart, recent-matches table and KPIs.
const matchSeries = (vodData ?? [])
  .filter(v => (v.maps ?? []).length)
  .map(v => {
    let rw = 0, rl = 0, mw = 0, ml = 0
    for (const m of v.maps) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      rw += us; rl += them
      if (us > them) mw++; else if (them > us) ml++
    }
    const total = rw + rl
    return {
      id: v.id, opponent: v.opponent_name || 'Unknown',
      date: v.match_date || v.created_at,
      maps: v.maps, rw, rl, mw, ml,
      roundPct: total ? Math.round((rw / total) * 100) : 0,
      verdict: mw > ml ? 'W' : ml > mw ? 'L' : 'D',
    }
  })
  .sort((a, b) => new Date(a.date) - new Date(b.date))   // oldest → newest

// Map aggregation (win %, W/L, round W/L) across all logged maps.
const mapAgg = {}
for (const v of vodData ?? []) {
  for (const m of v.maps ?? []) {
    const us = m.score_us ?? 0, them = m.score_them ?? 0
    const a = mapAgg[m.map] ??= { w: 0, l: 0, rw: 0, rl: 0, lastDate: null }
    a.rw += us; a.rl += them
    if (us > them) a.w++; else if (them > us) a.l++
    const md = v.match_date || v.created_at
    if (md && (!a.lastDate || new Date(md) > new Date(a.lastDate))) a.lastDate = md
  }
}

// ── Trend helper: compare a metric's recent half vs prior half ───────
// values are chronological numbers; returns { delta, dir } or null when
// there isn't enough history to be honest about a direction.
function splitTrend(values, { minEach = 2 } = {}) {
  if (!values || values.length < minEach * 2) return null
  const half = Math.floor(values.length / 2)
  const prior = values.slice(0, half), recent = values.slice(half)
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length
  const delta = avg(recent) - avg(prior)
  return { delta, dir: delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : 'flat' }
}
function trendPill(trend, fmt) {
  if (!trend || trend.dir === 'flat') return `<span class="trend flat">—<span class="since">stable</span></span>`
  const sign = trend.delta > 0 ? '+' : '−'
  return `<span class="trend ${trend.dir}">${svg(ICON[trend.dir], 'width="12" height="12"')}${sign}${fmt(Math.abs(trend.delta))}<span class="since">vs prior</span></span>`
}

// ── KPI band ─────────────────────────────────────────────────────────
// Win Rate, Map Win Rate, Avg Round Win %, ADR (team), K/D (team).
async function renderKpis() {
  // Match record + win rate
  const decisive = matchSeries.filter(m => m.verdict !== 'D')
  const wins = decisive.filter(m => m.verdict === 'W').length
  const winRate = decisive.length ? Math.round((wins / decisive.length) * 100) : null
  const winRateTrend = splitTrend(decisive.map(m => m.verdict === 'W' ? 100 : 0))

  // Map win rate
  let mw = 0, mTotal = 0
  for (const a of Object.values(mapAgg)) { mw += a.w; mTotal += a.w + a.l }
  const mapWr = mTotal ? Math.round((mw / mTotal) * 100) : null
  const mapWrTrend = splitTrend(matchSeries.flatMap(m =>
    (m.maps ?? []).map(x => ((x.score_us ?? 0) > (x.score_them ?? 0)) ? 100 : ((x.score_them ?? 0) > (x.score_us ?? 0) ? 0 : 50))))

  // Avg round win %
  let totRW = 0, totRL = 0
  for (const a of Object.values(mapAgg)) { totRW += a.rw; totRL += a.rl }
  const roundWr = (totRW + totRL) ? Math.round((totRW / (totRW + totRL)) * 100) : null
  const roundWrTrend = splitTrend(matchSeries.map(m => m.roundPct))

  // ADR + K/D from demo_players (our roster, last 30d ready demos)
  let adr = null, kd = null, adrTrend = null, kdTrend = null
  try {
    const readyIds = (recentDemos ?? []).filter(d => d.status === 'ready').map(d => d.id)
    if (readyIds.length) {
      const { data: dp } = await supabase.from('demo_players')
        .select('demo_id, steam_id, kills, deaths, adr').in('demo_id', readyIds.slice(0, 200)).eq('side', 'all')
      const rosterSids = new Set((roster ?? []).map(r => r.steam_id).filter(Boolean))
      const dateById = {}; for (const d of recentDemos ?? []) dateById[d.id] = d.played_at || d.created_at
      const rows = (dp ?? [])
        .filter(r => !rosterSids.size || rosterSids.has(r.steam_id))
        .map(r => ({ t: new Date(dateById[r.demo_id] || 0).getTime(), k: r.kills || 0, d: r.deaths || 0, adr: r.adr }))
        .sort((a, b) => a.t - b.t)
      if (rows.length) {
        const sumK = rows.reduce((s, r) => s + r.k, 0), sumD = rows.reduce((s, r) => s + r.d, 0)
        kd = sumD ? sumK / sumD : sumK
        const adrs = rows.map(r => r.adr).filter(x => x != null)
        adr = adrs.length ? adrs.reduce((s, x) => s + x, 0) / adrs.length : null
        kdTrend = splitTrend(rows.map(r => (r.d ? r.k / r.d : r.k)), { minEach: 3 })
        if (adrs.length >= 6) adrTrend = splitTrend(rows.filter(r => r.adr != null).map(r => r.adr), { minEach: 3 })
      }
    }
  } catch (e) { console.warn('[dashboard] team adr/kd failed', e) }

  const cards = [
    { ic: 'winrate', label: 'Win Rate',         val: winRate == null ? '—' : `${winRate}%`, trend: winRateTrend, fmt: v => `${Math.round(v)}%` },
    { ic: 'trophy',  label: 'Map Win Rate',     val: mapWr == null ? '—' : `${mapWr}%`,     trend: mapWrTrend,   fmt: v => `${Math.round(v)}%` },
    { ic: 'round',   label: 'Avg. Round Win %', val: roundWr == null ? '—' : `${roundWr}%`, trend: roundWrTrend, fmt: v => `${Math.round(v)}%` },
    { ic: 'adr',     label: 'ADR · Team',       val: adr == null ? '—' : adr.toFixed(1),    trend: adrTrend,     fmt: v => v.toFixed(1) },
    { ic: 'kd',      label: 'K/D · Team',       val: kd == null ? '—' : kd.toFixed(2),      trend: kdTrend,      fmt: v => v.toFixed(2) },
  ]
  document.getElementById('kpi-row').innerHTML = cards.map(c => `
    <div class="kpi">
      <div style="display:flex"><span class="kpi-ic">${svg(ICON[c.ic])}</span></div>
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-val">${c.val}</div>
      ${c.val === '—' ? '' : trendPill(c.trend, c.fmt)}
    </div>`).join('')
}

// ── Performance chart (dual line: win rate + round win %) ────────────
const PERF_W = 740, PERF_H = 300, PAD_L = 40, PAD_R = 16, PAD_T = 16, PAD_B = 34
let perfRange = 'recent'
function buildPerfPoints() {
  const all = matchSeries.map((m, i) => {
    // trailing-5 win rate ending at this match
    const window = matchSeries.slice(Math.max(0, i - 4), i + 1).filter(x => x.verdict !== 'D')
    const w = window.filter(x => x.verdict === 'W').length
    const wr = window.length ? Math.round((w / window.length) * 100) : 50
    return { label: `${m.opponent} · ${new Date(m.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`, wr, rw: m.roundPct }
  })
  return perfRange === 'recent' ? all.slice(-10) : all.slice(-24)
}
function renderPerf() {
  const wrap = document.getElementById('perf-wrap')
  const pts = buildPerfPoints()
  if (pts.length < 2) {
    wrap.innerHTML = `<div class="card-empty">Log at least two matches with map scores and your win-rate / round-win trend will draw itself here.</div>`
    return
  }
  const vals = pts.flatMap(p => [p.wr, p.rw])
  let lo = Math.min(...vals), hi = Math.max(...vals)
  lo = Math.max(0, Math.floor((lo - 8) / 10) * 10); hi = Math.min(100, Math.ceil((hi + 8) / 10) * 10)
  if (hi - lo < 20) { hi = Math.min(100, lo + 20) }
  const px = i => PAD_L + (i * (PERF_W - PAD_L - PAD_R) / (pts.length - 1))
  const py = v => PAD_T + (PERF_H - PAD_T - PAD_B) * (1 - (v - lo) / (hi - lo))
  const smooth = key => {
    const c = pts.map((p, i) => [px(i), py(p[key])])
    let d = `M ${c[0][0].toFixed(1)} ${c[0][1].toFixed(1)}`
    for (let i = 0; i < c.length - 1; i++) {
      const p0 = c[i-1]||c[i], p1 = c[i], p2 = c[i+1], p3 = c[i+2]||p2
      d += ` C ${(p1[0]+(p2[0]-p0[0])/6).toFixed(1)} ${(p1[1]+(p2[1]-p0[1])/6).toFixed(1)}, ${(p2[0]-(p3[0]-p1[0])/6).toFixed(1)} ${(p2[1]-(p3[1]-p1[1])/6).toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
    }
    return d
  }
  const grids = [], step = (hi - lo) / 4
  for (let v = lo; v <= hi + 0.1; v += step) {
    grids.push(`<line class="perf-grid-line ${Math.abs(v-50)<step/2?'base':''}" x1="${PAD_L}" y1="${py(v).toFixed(1)}" x2="${PERF_W-PAD_R}" y2="${py(v).toFixed(1)}"/>`)
    grids.push(`<text class="perf-axis" x="${PAD_L-8}" y="${(py(v)+3).toFixed(1)}" text-anchor="end">${Math.round(v)}%</text>`)
  }
  const step2 = Math.ceil(pts.length / 8)
  const xlabels = pts.map((p, i) => (i % step2 === 0 || i === pts.length-1)
    ? `<text class="perf-axis" x="${px(i).toFixed(1)}" y="${PERF_H-12}" text-anchor="middle">${esc(p.label.split(' · ')[1] || '')}</text>` : '').join('')
  const wrLine = smooth('wr'), rwLine = smooth('rw')
  const area = `${wrLine} L ${px(pts.length-1).toFixed(1)} ${(PERF_H-PAD_B).toFixed(1)} L ${PAD_L} ${(PERF_H-PAD_B).toFixed(1)} Z`
  const dots = pts.map((p, i) => `<circle class="perf-dot" cx="${px(i).toFixed(1)}" cy="${py(p.wr).toFixed(1)}" r="${i===pts.length-1?4.5:3.2}"/>`).join('')
  const band = (PERF_W - PAD_L - PAD_R) / (pts.length - 1)
  const hots = pts.map((_, i) => `<rect class="perf-hot" data-i="${i}" x="${(px(i)-band/2).toFixed(1)}" y="0" width="${band.toFixed(1)}" height="${PERF_H-PAD_B}"/>`).join('')

  wrap.innerHTML = `
    <svg class="perf" viewBox="0 0 ${PERF_W} ${PERF_H}" role="img" aria-label="Performance trend">
      <defs><linearGradient id="perfFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--lavender-2)" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="var(--lavender-3)" stop-opacity="0"/>
      </linearGradient></defs>
      ${grids.join('')}${xlabels}
      <path class="perf-fill" d="${area}"/>
      <path class="perf-line-rw" d="${rwLine}"/>
      <path class="perf-line-wr" d="${wrLine}"/>
      ${dots}
      <line class="perf-cursor" id="perf-cursor" x1="0" y1="${PAD_T}" x2="0" y2="${PERF_H-PAD_B}"/>
      <circle class="perf-dot" id="perf-mk-wr" r="4.5" opacity="0"/>
      <circle id="perf-mk-rw" r="4" fill="var(--bg-card)" stroke="var(--muted)" stroke-width="2" opacity="0"/>
      ${hots}
    </svg>
    <div class="perf-tip" id="perf-tip"></div>`

  const svgEl = wrap.querySelector('svg.perf'), tip = document.getElementById('perf-tip')
  const cursor = document.getElementById('perf-cursor'), mkWr = document.getElementById('perf-mk-wr'), mkRw = document.getElementById('perf-mk-rw')
  function show(i) {
    const p = pts[i], x = px(i)
    cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.style.opacity = 1
    mkWr.setAttribute('cx', x); mkWr.setAttribute('cy', py(p.wr)); mkWr.setAttribute('opacity', 1)
    mkRw.setAttribute('cx', x); mkRw.setAttribute('cy', py(p.rw)); mkRw.setAttribute('opacity', 1)
    tip.innerHTML = `<div class="tdate">${esc(p.label)}</div>
      <div class="trow"><span class="tk"><i style="background:var(--accent)"></i>Win Rate</span><span class="tv">${p.wr}%</span></div>
      <div class="trow"><span class="tk"><i style="background:var(--muted)"></i>Round Win %</span><span class="tv">${p.rw}%</span></div>`
    const rect = svgEl.getBoundingClientRect(), scale = rect.width / PERF_W
    tip.style.left = Math.max(80, Math.min(rect.width - 80, x * scale)) + 'px'
    tip.style.top = (py(Math.max(p.wr, p.rw)) * scale - 8) + 'px'
    tip.style.opacity = 1
  }
  function hide() { tip.style.opacity = 0; cursor.style.opacity = 0; mkWr.setAttribute('opacity', 0); mkRw.setAttribute('opacity', 0) }
  svgEl.querySelectorAll('.perf-hot').forEach(r => r.addEventListener('mouseenter', () => show(+r.dataset.i)))
  svgEl.addEventListener('mouseleave', hide)
}
document.getElementById('perf-seg')?.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return
  perfRange = b.dataset.range
  document.querySelectorAll('#perf-seg button').forEach(x => x.classList.toggle('on', x === b))
  renderPerf()
})

// ── Map pool ─────────────────────────────────────────────────────────
function renderMapPool() {
  const ranked = MAPS
    .map(m => { const a = mapAgg[m] || { w:0, l:0 }; const g = a.w + a.l; return { m, g, w:a.w, l:a.l, pct: g ? Math.round((a.w/g)*100) : null } })
    .filter(r => r.g > 0)
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
  const list = document.getElementById('map-list')
  if (!ranked.length) {
    list.innerHTML = `<div class="card-empty">No map scores logged yet. Add matches with map results to see your pool here.</div>`
    return
  }
  const pctColor = p => p >= 60 ? 'var(--success)' : p <= 40 ? 'var(--danger)' : 'var(--text-primary)'
  list.innerHTML = ranked.map(r => `
    <a class="map-row" href="stratbook.html?map=${r.m}">
      <div class="map-thumb" style="background-image:url('images/maps/${mapFile(r.m)}.png')">${initials(MAP_LABELS[r.m], 1)}</div>
      <div class="map-mid">
        <div class="map-nm"><span>${MAP_LABELS[r.m]}</span><span class="pct" style="color:${pctColor(r.pct)}">${r.pct}%</span></div>
        <div class="map-bar"><i data-w="${r.pct}"></i></div>
      </div>
      <div class="map-wl"><b>${r.w}</b>W<br>${r.l}L</div>
    </a>`).join('')
}

// ── Recent matches ───────────────────────────────────────────────────
function renderMatches() {
  const table = document.getElementById('match-table')
  const recent = [...matchSeries].reverse().slice(0, 6)
  if (!recent.length) {
    table.innerHTML = `<div class="card-empty">No matches reviewed yet. Add a match in Matches to populate this table.</div>`
    return
  }
  table.innerHTML = recent.map(m => {
    const win = m.verdict === 'W', loss = m.verdict === 'L'
    const cls = win ? 'win' : loss ? 'loss' : 'draw'
    // headline map = the team's most-played / first map of the match
    const firstMap = m.maps?.[0]?.map
    const a = m.maps?.[0] ? (m.maps[0].score_us ?? 0) : m.rw
    const b = m.maps?.[0] ? (m.maps[0].score_them ?? 0) : m.rl
    const dateTxt = new Date(m.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    const mapTxt = m.maps && m.maps.length > 1 ? `${m.maps.length} maps` : (firstMap ? cap(firstMap) : '—')
    return `
      <a class="mrow" href="vod-detail.html?id=${m.id}">
        <div class="mcrest">${initials(m.opponent)}</div>
        <div class="mopp"><div class="nm">${esc(m.opponent)}</div><div class="mp">${esc(mapTxt)} · ${dateTxt}</div></div>
        <span class="mres ${cls}">${m.verdict === 'D' ? 'DRAW' : win ? 'WIN' : 'LOSS'}</span>
        <span class="mscore"><span class="${win?'w':loss?'l':''}">${a}</span><span class="sep"> – </span><span class="${win?'l':loss?'w':''}">${b}</span></span>
        <span class="mchev">${svg(ICON.chev, 'width="16" height="16"')}</span>
      </a>`
  }).join('')
}

// ── Team strengths radar (real round-type DNA) ───────────────────────
async function renderTeamStrengths() {
  const slot = document.getElementById('radar-slot')
  const empty = msg => slot.innerHTML = `<div class="card-empty">${msg}</div>`
  if (!teamRow?.name) return empty('Set your team name to compute strengths.')
  try {
    const { data: demosForEcon } = await supabase.from('demos')
      .select('id, ct_team_name, t_team_name, team_a_name, team_b_name, team_a_first_side')
      .eq('team_id', teamId).eq('status', 'ready').gte('created_at', ago30.toISOString()).limit(80)
    const norm = s => (s ?? '').toString().toLowerCase().trim(), ourLc = norm(teamRow.name)
    const ourLetterByDemo = new Map()
    for (const d of demosForEcon ?? []) {
      let letter = null
      if (d.ct_team_name && d.t_team_name) {
        if (norm(d.ct_team_name) === ourLc) letter = d.team_a_first_side === 't' ? 'b' : 'a'
        else if (norm(d.t_team_name) === ourLc) letter = d.team_a_first_side === 't' ? 'a' : 'b'
      } else {
        if (norm(d.team_a_name) === ourLc) letter = 'a'
        else if (norm(d.team_b_name) === ourLc) letter = 'b'
      }
      if (letter) ourLetterByDemo.set(d.id, letter)
    }
    if (!ourLetterByDemo.size) return empty('Upload demos and assign your side — the strengths radar draws from round-by-round stats.')
    const { data: statRows } = await supabase.from('demo_team_stats').select('*').in('demo_id', [...ourLetterByDemo.keys()])
    const ourRows = (statRows ?? []).filter(r => ourLetterByDemo.get(r.demo_id) === r.team)
    if (!ourRows.length) return empty('Round stats still processing — re-check in a minute.')
    const agg = aggregateTeamStats(ourRows)
    const pc = v => (v && v.played ? Math.round((v.pct ?? 0) * 100) : null)
    const openingPct = agg.opening_duel?.pct
    slot.innerHTML = radarSVG([
      { label: 'Pistol',   pct: pc(agg.pistols) },
      { label: 'Opening',  pct: openingPct != null ? Math.round(openingPct * 100) : null },
      { label: 'Anti-eco', pct: pc(agg.anti_ecos) },
      { label: 'Full buy', pct: pc(agg.full_buy) },
      { label: 'CT side',  pct: pc(agg.ct) },
      { label: 'T side',   pct: pc(agg.t) },
    ], { size: 280 })
  } catch (e) { console.warn('[dashboard] strengths failed', e); empty('Could not load strengths right now.') }
}

// ── Right rail: schedule ─────────────────────────────────────────────
function renderSchedule() {
  const slot = document.getElementById('schedule-list')
  const upcoming = events.filter(e => new Date(e.date) >= now).slice(0, 4)
  if (!upcoming.length) {
    slot.innerHTML = `<div class="card-empty">No upcoming matches or events. Add one from the Schedule.</div>`
    return
  }
  const typeLabel = t => t === 'tournament' ? 'Tournament' : t === 'scrim' ? 'Scrim' : t === 'vod_review' ? 'VOD Review' : t === 'meeting' ? 'Meeting' : 'Event'
  slot.innerHTML = upcoming.map(e => {
    const d = new Date(e.date)
    const title = (e.title || '').trim() || typeLabel(e.type)
    const crest = title.replace(/^vs\s+/i, '').replace(/^scrim\s+vs\s+/i, '').replace(/^vod[:\s-]+/i, '')
    const ev = e.location || typeLabel(e.type)
    return `
      <a class="sched-row" href="schedule.html">
        <div class="sched-crest">${initials(crest)}</div>
        <div class="sched-mid"><div class="nm">${esc(title)}</div><div class="ev">${esc(ev)}</div></div>
        <div class="sched-when"><div class="d">${d.toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</div><div class="t">${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}</div></div>
      </a>`
  }).join('')
}

// ── Right rail: focus areas (active goals) ───────────────────────────
function renderFocus() {
  const slot = document.getElementById('focus-list')
  if (!goalsData?.length) {
    slot.innerHTML = `<div class="card-empty">No active goals. Set focus areas in Goals to track them here.</div>`
    return
  }
  const order = { weekly: 0, monthly: 1, long_term: 2 }
  const sorted = [...goalsData].sort((a, b) => (order[a.horizon] ?? 9) - (order[b.horizon] ?? 9)).slice(0, 4)
  slot.innerHTML = sorted.map(g => {
    // Honest, time-based progress: how far through the goal's window we are.
    let pct = null
    if (g.due_date) {
      const due = new Date(g.due_date).getTime()
      const span = g.horizon === 'weekly' ? 7 : g.horizon === 'monthly' ? 30 : 90
      const start = due - span * 24 * 60 * 60 * 1000
      pct = Math.max(0, Math.min(100, Math.round(((now.getTime() - start) / (due - start)) * 100)))
    }
    const tag = g.horizon === 'long_term' ? 'LONG TERM' : g.horizon === 'monthly' ? 'MONTHLY' : 'WEEKLY'
    return `
      <a class="focus-row" href="goals.html">
        <div class="focus-top"><div class="focus-nm">${esc(g.title)}</div><div class="focus-tag">${tag}</div></div>
        ${pct != null ? `<div class="focus-bar"><i data-w="${pct}"></i></div>` : ''}
      </a>`
  }).join('')
}

// ── Right rail: recent VOD reviews ───────────────────────────────────
function renderVodReviews() {
  const slot = document.getElementById('vod-list')
  const recent = (vodData ?? []).slice(0, 4)
  if (!recent.length) {
    slot.innerHTML = `<div class="card-empty">No match reviews yet. Create one in Matches.</div>`
    return
  }
  slot.innerHTML = recent.map(v => {
    const map = v.maps?.[0]?.map
    const dateTxt = new Date(v.match_date || v.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    return `
      <a class="vod-row" href="vod-detail.html?id=${v.id}" data-preview-vod="${v.id}">
        <div class="vod-thumb"><span class="vod-play">${svg(ICON.play, 'width="11" height="11"')}</span></div>
        <div class="vod-mid"><div class="nm">vs ${esc(v.opponent_name || 'Unknown')}</div><div class="mp">${map ? cap(map) : 'Match review'}</div></div>
        <div class="vod-date">${dateTxt}</div>
      </a>`
  }).join('')
}

// ── Right rail: Coach's Brief (what needs attention) ─────────────────
function renderBrief() {
  const slot = document.getElementById('attention-slot')
  const sinceEl = document.getElementById('attention-since'); if (sinceEl) sinceEl.textContent = sinceLabel
  const items = []
  for (const e of events) {
    const ms = new Date(e.date) - now
    if (ms >= 0 && ms <= 24 * 60 * 60 * 1000) {
      const hrs = Math.max(1, Math.round(ms / 3600000))
      const label = (e.title || TYPE_LABELS[e.type] || 'Event').replace(/^vs\s+/i, 'vs ')
      items.push({ icon: '▶', text: `${esc(label)} in ${hrs}h`, href: 'schedule.html' }); break
    }
  }
  const open = (issuesData ?? []).filter(i => i.status !== 'resolved')
  if (open.length) items.push({ icon: '!', text: `<strong>${open.length}</strong> open issue${open.length === 1 ? '' : 's'}`, href: 'issues.html' })
  const vodDays = new Set((vodData ?? []).map(v => v.match_date?.slice(0, 10)).filter(Boolean))
  const unreviewed = new Set((recentDemos ?? []).filter(d => d.status === 'ready' && !vodDays.has((d.played_at || d.created_at)?.slice(0, 10))).map(d => (d.played_at || d.created_at).slice(0, 10)))
  if (unreviewed.size) items.push({ icon: '◍', text: `<strong>${unreviewed.size}</strong> scrim day${unreviewed.size === 1 ? '' : 's'} without a review`, href: 'vods.html' })
  if (lastSeenISO) {
    const nd = (recentDemos ?? []).filter(d => d.created_at > sinceISO).length
    const nv = (vodData ?? []).filter(v => v.created_at > sinceISO).length
    const ns = (stratMaps ?? []).filter(s => s.created_at > sinceISO).length
    const parts = []
    if (nd) parts.push(`${nd} demo${nd === 1 ? '' : 's'}`); if (nv) parts.push(`${nv} review${nv === 1 ? '' : 's'}`); if (ns) parts.push(`${ns} strat${ns === 1 ? '' : 's'}`)
    if (parts.length) items.push({ icon: '+', text: `New ${sinceLabel}: ${parts.join(', ')}`, href: 'demos.html' })
  }
  if (!items.length) {
    slot.innerHTML = `<div class="card-empty">✓ All clear. Nothing demanding action right now.</div>`
    return
  }
  slot.innerHTML = `<div class="attention-list">${items.map(it => `
    <a href="${it.href}" class="attention-row"><span class="attention-icon">${it.icon}</span><span class="attention-text">${it.text}</span><span class="attention-chevron">→</span></a>`).join('')}</div>`
}

// ── Today strip ──────────────────────────────────────────────────────
function renderTodayStrip() {
  const dateLine = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
  const nextMatch = events.find(e => ['tournament', 'scrim'].includes(e.type)) ?? events[0] ?? null
  let nextLabel = 'no upcoming matches'
  if (nextMatch) {
    const ms = Math.max(0, new Date(nextMatch.date) - now)
    const hrs = Math.floor(ms / 3600000), days = Math.floor(hrs / 24)
    const cd = ms < 3600000 ? 'soon' : days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${hrs} hour${hrs === 1 ? '' : 's'}`
    nextLabel = `${cd} until next match`
  }
  const activeDays = new Set()
  for (const d of recentDemos ?? []) activeDays.add(localDateStr(new Date(d.created_at)))
  for (const v of vodData ?? []) activeDays.add(localDateStr(new Date(v.created_at)))
  let streak = 0; const cur = new Date(now); cur.setHours(0,0,0,0)
  while (activeDays.has(localDateStr(cur))) { streak++; cur.setDate(cur.getDate() - 1) }
  const streakHtml = streak > 0
    ? `<span class="today-streak"><span class="today-streak-flame">▲</span> <strong>${streak}</strong> day streak</span>`
    : `<span class="today-streak today-streak-zero">No activity today</span>`
  document.getElementById('today-strip').innerHTML = `
    <div class="today-strip-row">
      <span class="today-strip-date">${esc(dateLine)}</span><span class="today-strip-divider"></span>
      <span class="today-strip-next">${esc(nextLabel)}</span><span class="today-strip-divider"></span>${streakHtml}
    </div>`
}

// ── Boot ─────────────────────────────────────────────────────────────
renderTodayStrip()
await renderKpis()
renderPerf()
renderMapPool()
renderMatches()
renderSchedule()
renderFocus()
renderVodReviews()
renderBrief()
renderTeamStrengths()

// Animate progress bars in after layout settles.
requestAnimationFrame(() => requestAnimationFrame(() => {
  for (const i of document.querySelectorAll('.map-bar i, .focus-bar i')) i.style.width = (i.dataset.w || 0) + '%'
}))

try { localStorage.setItem(LAST_SEEN_KEY, now.toISOString()) } catch {}
