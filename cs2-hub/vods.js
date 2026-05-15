// cs2-hub/vods.js
//
// Results & Review orchestrator. Loads data once, re-renders each section
// on filter change. Sections are pure render modules; this file owns the
// data layer + the drawer.

import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { mountFilter } from './vods-filter.js'
import { renderHero } from './vods-hero.js'
import { renderPlayerImpact } from './vods-player-impact.js'
import { renderMapPool } from './vods-map-pool.js'
import { renderMatchReports } from './vods-match-reports.js'
import { splitVodsByWindow } from './vods-trend.js'
import { mountDrawer } from './player-drawer.js'
import { buildPlayerDrawerBody, buildSubtitle } from './roster-stats-render.js'
import { linkDemosToVods } from './auto-fill-vod.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('vods')

const teamId = getTeamId()
const drawer = mountDrawer()

// ── Boot: load everything we need once ──────────────────────────
const [vodsRes, rosterRes, teamRes] = await Promise.all([
  supabase.from('vods').select('*').eq('team_id', teamId).eq('dismissed', false).order('match_date', { ascending: false }),
  supabase.from('roster').select('*').eq('team_id', teamId),
  supabase.from('teams').select('name').eq('id', teamId).maybeSingle(),
])
if (vodsRes.error) {
  document.getElementById('rr-hero').innerHTML =
    `<div class="empty-state"><h3>Failed to load matches</h3><p>${esc(vodsRes.error.message)}</p></div>`
  throw vodsRes.error
}
const allVods = vodsRes.data ?? []
const roster  = rosterRes.data ?? []
const ourTeamName = teamRes.data?.name ?? ''
const teamSteamIds = new Set(roster.map(p => p.steam_id).filter(Boolean))

// Mount the hero shell once so its filter slot exists.
const HERO_FILTER_SLOT = 'rr-filter-slot'
renderHero(document.getElementById('rr-hero'), { vods: allVods, filterSlotId: HERO_FILTER_SLOT })

if (allVods.length === 0) {
  document.getElementById('rr-player-impact').innerHTML = ''
  document.getElementById('rr-map-pool').innerHTML = ''
  document.getElementById('rr-match-reports').innerHTML = ''
}

// ── State ────────────────────────────────────────────────────────
let state = { filter: null, mapFilter: null, dataset: null }

function applyMatchTypeFilter(vods, matchType) {
  if (!matchType || matchType === 'all') return vods
  return vods.filter(v => v.match_type === matchType)
}

function widenDate(d, delta) {
  const dt = new Date(`${d}T00:00:00`)
  dt.setDate(dt.getDate() + delta)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// A demo_players row's effective date — used to slice rows by time window.
// played_at is parser-derived (true game date); falls back to created_at.
function rowDateStr(r, demosById) {
  const demo = demosById?.get(r.demo_id)
  const ts = demo?.played_at || demo?.created_at
  return ts ? String(ts).slice(0, 10) : null
}

// Partition demo_players rows into current/prior windows.
// '30d'/'90d'/'all' use the demo's own date (so demos that didn't auto-link
// to a vod still contribute — matching the page's prior behaviour).
// '10' uses the vod link (semantic = "last 10 matches", which only makes
// sense relative to logged vods).
function partitionRows({ rows, demosById, demoToVod, currentVodIds, priorVodIds, filter, now = new Date() }) {
  const current = [], prior = []

  if (filter.window === '10') {
    for (const r of rows) {
      const v = demoToVod.get(r.demo_id)
      if (v && currentVodIds.has(v.id)) current.push(r)
      else if (v && priorVodIds.has(v.id)) prior.push(r)
    }
    return { current, prior }
  }

  if (filter.window === 'all') {
    return { current: rows.slice(), prior: [] }
  }

  const days = filter.window === '30d' ? 30 : filter.window === '90d' ? 90 : null
  if (days == null) return { current: rows.slice(), prior: [] }
  const cur = new Date(now); cur.setDate(cur.getDate() - days)
  const pri = new Date(now); pri.setDate(pri.getDate() - 2 * days)
  const curCutoff = ymdLocal(cur)
  const priCutoff = ymdLocal(pri)
  for (const r of rows) {
    const d = rowDateStr(r, demosById)
    if (!d) continue
    if (d >= curCutoff) current.push(r)
    else if (d >= priCutoff) prior.push(r)
  }
  return { current, prior }
}

async function fetchDemosForVodWindow(vods, filter) {
  const empty = { demos: [], rowsAll: [], rowsCT: [], rowsT: [], demoToVod: new Map() }
  if (!teamSteamIds.size) return empty

  // Calendar bounds for date-based windows so we pick up demos from un-logged
  // matches (no vod row). Vod-bounded for '10' and 'all'.
  let minDate, maxDate
  const now = new Date()
  if (filter.window === '30d' || filter.window === '90d') {
    const days = filter.window === '30d' ? 30 : 90
    const lo = new Date(now); lo.setDate(lo.getDate() - 2 * days - 1)
    const hi = new Date(now); hi.setDate(hi.getDate() + 1)
    minDate = ymdLocal(lo); maxDate = ymdLocal(hi)
  } else {
    if (!vods.length) return empty
    const dates = vods.map(v => v.match_date).filter(Boolean).sort()
    if (!dates.length) return empty
    minDate = widenDate(dates[0], -1)
    maxDate = widenDate(dates[dates.length - 1], 1)
  }

  const { data: demos, error: e1 } = await supabase
    .from('demos')
    .select('id,series_id,map,played_at,opponent_name,ct_team_name,t_team_name,created_at,status,team_id')
    .eq('team_id', teamId)
    .eq('status', 'ready')
    .gte('created_at', `${minDate}T00:00:00`)
    .lte('created_at', `${maxDate}T23:59:59`)
  if (e1) throw e1

  const demoToVod = linkDemosToVods(demos || [], vods)

  if (!(demos || []).length) return { demos: [], rowsAll: [], rowsCT: [], rowsT: [], demoToVod }

  const { data: rows, error: e3 } = await supabase
    .from('demo_players')
    .select('*')
    .in('demo_id', demos.map(d => d.id))
    .in('steam_id', [...teamSteamIds])
  if (e3) throw e3

  const demosById = new Map((demos || []).map(d => [d.id, d]))
  for (const r of rows || []) {
    const d = demosById.get(r.demo_id)
    r.map = d?.map ?? null
  }
  const rowsAll = (rows || []).filter(r => r.side === 'all')
  const rowsCT  = (rows || []).filter(r => r.side === 'ct')
  const rowsT   = (rows || []).filter(r => r.side === 't')
  return { demos: demos || [], rowsAll, rowsCT, rowsT, demoToVod, demosById }
}

function groupByDemoId(rows) {
  const m = new Map()
  for (const r of rows || []) {
    if (!r.demo_id) continue
    if (!m.has(r.demo_id)) m.set(r.demo_id, [])
    m.get(r.demo_id).push(r)
  }
  return m
}

async function rebuild(filter) {
  state.filter = filter
  const { current, prior } = splitVodsByWindow(allVods, filter)
  const currentFiltered = applyMatchTypeFilter(current, filter.matchType)
  const priorFiltered   = applyMatchTypeFilter(prior,   filter.matchType)

  // Re-render hero whenever the filtered current set changes
  renderHero(document.getElementById('rr-hero'), { vods: currentFiltered, filterSlotId: HERO_FILTER_SLOT })
  // Re-mount filter into the new slot (renderHero blew it away)
  mountFilter(document.getElementById(HERO_FILTER_SLOT), (f) => {
    // Avoid reentry: only rebuild if state actually changed
    if (JSON.stringify(f) === JSON.stringify(state.filter)) return
    rebuild(f)
  })

  // Single fetch covering BOTH windows for demo_players (used by both
  // player-impact's trend computation and match-reports' top performers).
  const union = [...currentFiltered, ...priorFiltered]
  const data = await fetchDemosForVodWindow(union, filter)

  const currentVodIds = new Set(currentFiltered.map(v => v.id))
  const priorVodIds   = new Set(priorFiltered.map(v => v.id))
  const { current: rowsCurrent, prior: rowsPrior } = partitionRows({
    rows: data.rowsAll,
    demosById: data.demosById,
    demoToVod: data.demoToVod,
    currentVodIds, priorVodIds, filter,
  })

  state.dataset = {
    filter,
    currentVods: currentFiltered,
    priorVods:   priorFiltered,
    rowsAll: data.rowsAll, rowsCT: data.rowsCT, rowsT: data.rowsT,
    demosById: data.demosById,
    demoToVod: data.demoToVod,
    rowsCurrent, rowsPrior,
  }

  renderPlayerImpact(document.getElementById('rr-player-impact'), {
    roster, rowsCurrent, rowsPrior, onPick: openPlayerDrawer,
  })
  renderMapPool(document.getElementById('rr-map-pool'), {
    vodsCurrent: currentFiltered, vodsPrior: priorFiltered, activeMap: state.mapFilter,
  })
  renderMatchReports(document.getElementById('rr-match-reports'), {
    vods: currentFiltered,
    demoToVod: data.demoToVod,
    demoPlayersByDemoId: groupByDemoId(data.rowsAll),
    mapFilter: state.mapFilter,
  })

  // Refresh drawer if open
  if (drawer.isOpen()) {
    const openName = document.querySelector('.player-drawer .pd-title')?.textContent
    const player = roster.find(p => p.nickname === openName)
    if (player && player.steam_id) renderPlayerDrawer(player)
    else drawer.close()
  }
}

function demoOpponentName(demo) {
  const ct = (demo?.ct_team_name || '').trim()
  const t  = (demo?.t_team_name  || '').trim()
  const us = (ourTeamName || '').trim().toLowerCase()
  if (!ct && !t) return null
  const ctIsUs = !!ct && ct.toLowerCase() === us
  const tIsUs  = !!t  && t.toLowerCase()  === us
  if (ctIsUs && !tIsUs) return t || null
  if (tIsUs  && !ctIsUs) return ct || null
  if (ct && t) return `${ct} vs ${t}`
  return ct || t || null
}

function demoResult(demo, vod) {
  if (!vod || !demo) return 'd'
  const slot = (vod.maps || []).find(m => String(m.map).toLowerCase() === String(demo.map).toLowerCase())
  if (!slot || slot.score_us == null || slot.score_them == null) return 'd'
  if (slot.score_us > slot.score_them) return 'w'
  if (slot.score_us < slot.score_them) return 'l'
  return 'd'
}

function renderPlayerDrawer(player) {
  if (!state.dataset) return
  const { rowsAll, rowsCT, rowsT, demosById, demoToVod, filter } = state.dataset
  const sid = player.steam_id
  const myAll = rowsAll.filter(r => r.steam_id === sid)
  const myCT  = rowsCT.filter(r  => r.steam_id === sid)
  const myT   = rowsT.filter(r   => r.steam_id === sid)
  const matches = myAll.length
  const rounds  = myAll.reduce((s, r) => s + (r.rounds_played || 0), 0)

  const recent = myAll
    .map(r => {
      const demo = demosById?.get(r.demo_id)
      const vod  = demo ? demoToVod.get(r.demo_id) : null
      return {
        vod_id: vod?.id,
        opponent: vod?.opponent ?? demoOpponentName(demo) ?? demo?.opponent_name ?? '—',
        map: demo?.map ?? '—',
        rating: r.rating,
        result: demoResult(demo, vod),
        played_at: demo?.played_at ?? demo?.created_at ?? null,
      }
    })
    .sort((a, b) => String(b.played_at || '').localeCompare(String(a.played_at || '')))
    .slice(0, 10)

  drawer.open({
    title: player.nickname,
    subtitle: buildSubtitle(player, filter.window, matches, rounds),
    body: buildPlayerDrawerBody({ rowsAll: myAll, rowsCT: myCT, rowsT: myT, recent }),
  })
}

function openPlayerDrawer(player) {
  if (drawer.isOpen() && document.querySelector('.player-drawer .pd-title')?.textContent === player.nickname) {
    drawer.close(); return
  }
  renderPlayerDrawer(player)
}

// ── Wire map filter event (delegated at document level) ───────────
document.addEventListener('rr:filter-map', (e) => {
  state.mapFilter = e.detail?.map ?? null
  if (state.filter) rebuild(state.filter)
})

// ── Mount filter into the hero's filter slot ──────────────────────
mountFilter(document.getElementById(HERO_FILTER_SLOT), (f) => { rebuild(f) })
