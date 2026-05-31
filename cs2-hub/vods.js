// cs2-hub/vods.js
//
// Results & Review orchestrator. Loads data once, re-renders each section
// on filter change. Sections are pure render modules; this file owns the
// data layer + the inline player panel.

import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { mountFilter } from './vods-filter.js'
import { renderHero } from './vods-hero.js'
import { renderPlayerImpact } from './vods-player-impact.js'
import { renderMapPool } from './vods-map-pool.js'
import { renderTeamStats } from './vods-team-stats.js'
import { renderAdvancedTeamStats } from './vods-team-stats-advanced.js'
import { renderMatchReports } from './vods-match-reports.js'
import { splitVodsByWindow } from './vods-trend.js'
import { mountPlayerPanel } from './vods-player-panel.js'
import { buildPlayerDrawerBody, buildSubtitle } from './roster-stats-render.js'
import { linkDemosToVods } from './auto-fill-vod.js'
import { attachTeamAutocomplete } from './team-autocomplete.js'
import { fetchOpponentOverview, renderOpponentOverview } from './opponent-overview.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('vods')

const teamId = getTeamId()
const panel = mountPlayerPanel(document.getElementById('rr-player-panel-slot'))

function clearActivePlayerCard() {
  for (const el of document.querySelectorAll('.rr-player-card.is-active')) {
    el.classList.remove('is-active')
  }
}

function markActivePlayerCard(playerId) {
  clearActivePlayerCard()
  const el = document.querySelector(`.rr-player-card[data-id="${CSS.escape(playerId)}"]`)
  if (el) el.classList.add('is-active')
}

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

// ── Scope toggle (own team ↔ scout another team) ────────────────
const ownBlocks    = document.getElementById('rr-own-blocks')
const scoutBlocks  = document.getElementById('rr-scout-blocks')
const scoutSlot    = document.getElementById('rr-scout-slot')
const scoutWrap    = document.getElementById('rr-scope-team-wrap')
const scoutInput   = document.getElementById('rr-scope-team-input')
const scoutStatus  = document.getElementById('rr-scope-status')
const scopeSeg     = document.getElementById('rr-scope-seg')

let scopeMode = 'own'   // 'own' | 'other'
let scoutToken = 0      // request-id to discard stale fetches

function setScopeMode(mode) {
  scopeMode = mode
  for (const btn of scopeSeg.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.mode === mode)
  }
  ownBlocks.style.display   = (mode === 'own')   ? '' : 'none'
  scoutBlocks.style.display = (mode === 'other') ? '' : 'none'
  scoutWrap.style.display   = (mode === 'other') ? '' : 'none'
  if (mode === 'other' && !scoutSlot.innerHTML) {
    scoutSlot.innerHTML = `<div class="opp-card-empty" style="padding:32px;text-align:center">Pick a team above to load their HLTV matches.</div>`
  }
}

async function refreshScout(teamName) {
  const myToken = ++scoutToken
  const name = (teamName || '').trim()
  if (!name) {
    scoutSlot.innerHTML = `<div class="opp-card-empty" style="padding:32px;text-align:center">Pick a team above to load their HLTV matches.</div>`
    scoutStatus.textContent = ''
    return
  }
  scoutStatus.textContent = 'Loading…'
  try {
    const data = await fetchOpponentOverview(name)
    if (myToken !== scoutToken) return
    renderOpponentOverview(scoutSlot, data)
    scoutStatus.textContent = data && data.demos.length
      ? `${data.demos.length} match${data.demos.length === 1 ? '' : 'es'}`
      : ''
  } catch (e) {
    if (myToken !== scoutToken) return
    console.error('[scout] fetch failed', e)
    scoutSlot.innerHTML = `<div class="opp-card-empty">Couldn't load HLTV matches: ${esc(e.message || e)}</div>`
    scoutStatus.textContent = ''
  }
}

for (const btn of scopeSeg.querySelectorAll('button')) {
  btn.addEventListener('click', () => setScopeMode(btn.dataset.mode))
}

let scoutTypingTimer = null
attachTeamAutocomplete(scoutInput, team => {
  clearTimeout(scoutTypingTimer)
  refreshScout(team.name)
})
scoutInput.addEventListener('input', () => {
  clearTimeout(scoutTypingTimer)
  scoutTypingTimer = setTimeout(() => refreshScout(scoutInput.value), 400)
})

// ── State ────────────────────────────────────────────────────────
let state = { filter: null, mapFilter: null, dataset: null, openPlayerId: null }

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

// Partition demos that didn't auto-link to any vod, so Map Pool Intelligence
// can count them without double-counting the vod-driven scores.
// '10' window is vod-anchored — unlinked demos have nowhere to live; skip them.
// '30d'/'90d' use the demo's own date. 'all' puts everything in current.
function partitionUnlinkedDemos({ demos, demoToVod, filter, now = new Date() }) {
  const unlinked = (demos || []).filter(d => !demoToVod.has(d.id))
  if (!unlinked.length) return { current: [], prior: [] }

  if (filter.window === '10') return { current: [], prior: [] }
  if (filter.window === 'all') return { current: unlinked.slice(), prior: [] }

  const days = filter.window === '30d' ? 30 : filter.window === '90d' ? 90 : null
  if (days == null) return { current: unlinked.slice(), prior: [] }

  const cur = new Date(now); cur.setDate(cur.getDate() - days)
  const pri = new Date(now); pri.setDate(pri.getDate() - 2 * days)
  const curCutoff = ymdLocal(cur)
  const priCutoff = ymdLocal(pri)

  const current = [], prior = []
  for (const d of unlinked) {
    const ts = d.played_at || d.created_at
    if (!ts) continue
    const dStr = String(ts).slice(0, 10)
    if (dStr >= curCutoff) current.push(d)
    else if (dStr >= priCutoff) prior.push(d)
  }
  return { current, prior }
}

async function fetchDemosForVodWindow(vods, filter) {
  const empty = {
    demos: [], rowsAll: [], rowsCT: [], rowsT: [],
    demoToVod: new Map(), demosById: new Map(),
    teamStatsRows: [], ourTeamByDemoId: new Map(),
  }
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

  // Team-owned demos plus any public (HLTV) demos whose team_a_name or
  // team_b_name matches this team's name. A team page named "Vitality" thus
  // includes the user's own uploads AND every Vitality match HLTV has scraped.
  // We do this as two queries + merge — embedding ILIKE values inside a PostgREST
  // .or() string is fiddly with quoting/escaping, and a second .from('demos')
  // call costs us a few ms at most.
  const COLS = 'id,series_id,map,played_at,opponent_name,ct_team_name,t_team_name,team_a_name,team_b_name,team_a_score,team_b_score,team_a_first_side,created_at,status,team_id,is_public'

  const teamDemosP = supabase
    .from('demos')
    .select(COLS)
    .eq('team_id', teamId)
    .eq('status', 'ready')
    .gte('created_at', `${minDate}T00:00:00`)
    .lte('created_at', `${maxDate}T23:59:59`)

  // PostgREST .or() splits on commas, and an ilike value containing one of
  // [(),] would break the parser. Strip those before building the filter —
  // they're not part of any real team name, so the match still works.
  const safeName = (ourTeamName || '').replace(/[(),]/g, '').trim()
  const publicDemosP = safeName
    ? supabase
        .from('demos')
        .select(COLS)
        .eq('is_public', true)
        .eq('status', 'ready')
        .or(`team_a_name.ilike.${safeName},team_b_name.ilike.${safeName}`)
        .gte('created_at', `${minDate}T00:00:00`)
        .lte('created_at', `${maxDate}T23:59:59`)
    : Promise.resolve({ data: [], error: null })

  const [teamRes, publicRes] = await Promise.all([teamDemosP, publicDemosP])
  if (teamRes.error)   throw teamRes.error
  if (publicRes.error) throw publicRes.error
  // Dedup defensively in case a future schema change ever lets a row qualify
  // for both lists (e.g. is_public true on a team-uploaded row).
  const seen = new Set()
  const demos = [...(teamRes.data ?? []), ...(publicRes.data ?? [])]
    .filter(d => (seen.has(d.id) ? false : (seen.add(d.id), true)))

  const demoToVod = linkDemosToVods(demos || [], vods)

  if (!(demos || []).length) return {
    demos: [], rowsAll: [], rowsCT: [], rowsT: [],
    demoToVod, demosById: new Map(),
    teamStatsRows: [], ourTeamByDemoId: new Map(),
  }

  const demoIds = demos.map(d => d.id)
  const [{ data: rows, error: e3 }, { data: teamStatsRows, error: e4 }] = await Promise.all([
    supabase.from('demo_players')
      .select('*')
      .in('demo_id', demoIds)
      .in('steam_id', [...teamSteamIds]),
    supabase.from('demo_team_stats')
      .select('*')
      .in('demo_id', demoIds),
  ])
  if (e3) throw e3
  if (e4) throw e4

  const demosById = new Map((demos || []).map(d => [d.id, d]))
  for (const r of rows || []) {
    const d = demosById.get(r.demo_id)
    r.map = d?.map ?? null
  }
  const rowsAll = (rows || []).filter(r => r.side === 'all')
  const rowsCT  = (rows || []).filter(r => r.side === 'ct')
  const rowsT   = (rows || []).filter(r => r.side === 't')

  // Build ourTeamByDemoId: any of our roster's demo_players rows tells us
  // which team ('a' or 'b') we are for that demo. side='all' is enough.
  const ourTeamByDemoId = new Map()
  for (const r of rowsAll) {
    if (!ourTeamByDemoId.has(r.demo_id) && (r.team === 'a' || r.team === 'b')) {
      ourTeamByDemoId.set(r.demo_id, r.team)
    }
  }

  return {
    demos: demos || [], rowsAll, rowsCT, rowsT,
    demoToVod, demosById,
    teamStatsRows: teamStatsRows || [],
    ourTeamByDemoId,
  }
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

  // First render of hero (before team-stats fetch) so the filter slot exists.
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
  const { current: teamStatsCurrent, prior: teamStatsPrior } = partitionRows({
    rows: data.teamStatsRows,
    demosById: data.demosById,
    demoToVod: data.demoToVod,
    currentVodIds, priorVodIds, filter,
  })

  // Re-render hero now that team-stats data is available (adds weakness callout).
  const teamStatsForHero = teamStatsCurrent.filter(r => {
    const ours = data.ourTeamByDemoId?.get(r.demo_id)
    return ours && ours === r.team
  })
  renderHero(document.getElementById('rr-hero'), {
    vods: currentFiltered,
    filterSlotId: HERO_FILTER_SLOT,
    teamStatsRows: teamStatsForHero,
  })
  mountFilter(document.getElementById(HERO_FILTER_SLOT), (f) => {
    if (JSON.stringify(f) === JSON.stringify(state.filter)) return
    rebuild(f)
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

  renderTeamStats(document.getElementById('rr-team-stats'), {
    rowsCurrent: teamStatsCurrent,
    rowsPrior:   teamStatsPrior,
    ourTeamByDemoId: data.ourTeamByDemoId,
  })
  renderPlayerImpact(document.getElementById('rr-player-impact'), {
    roster, rowsCurrent, rowsPrior, onPick: openPlayerPanel,
  })
  const { current: unlinkedDemosCurrent, prior: unlinkedDemosPrior } = partitionUnlinkedDemos({
    demos: data.demos,
    demoToVod: data.demoToVod,
    filter,
  })
  renderMapPool(document.getElementById('rr-map-pool'), {
    vodsCurrent: currentFiltered,
    vodsPrior: priorFiltered,
    activeMap: state.mapFilter,
    unlinkedDemosCurrent,
    unlinkedDemosPrior,
    ourTeamName,
  })
  renderAdvancedTeamStats(document.getElementById('rr-team-stats-advanced'), {
    teamStatsRows: teamStatsCurrent,
    playerRowsAll: rowsCurrent,
    ourTeamByDemoId: data.ourTeamByDemoId,
  })
  // our-team-filtered team_stats keyed by demo_id (for "dominant side" highlight)
  const teamStatsByDemoId = new Map()
  for (const r of teamStatsCurrent) {
    const ours = data.ourTeamByDemoId?.get(r.demo_id)
    if (ours && ours === r.team) teamStatsByDemoId.set(r.demo_id, r)
  }
  renderMatchReports(document.getElementById('rr-match-reports'), {
    vods: currentFiltered,
    demoToVod: data.demoToVod,
    demoPlayersByDemoId: groupByDemoId(data.rowsAll),
    teamStatsByDemoId,
    mapFilter: state.mapFilter,
  })

  // Refresh inline panel if open
  if (panel.isOpen() && state.openPlayerId) {
    const player = roster.find(p => p.id === state.openPlayerId)
    if (player && player.steam_id) {
      renderPlayerPanel(player)
      markActivePlayerCard(player.id)
    } else {
      panel.close()
      state.openPlayerId = null
    }
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

function renderPlayerPanel(player) {
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

  panel.open({
    title: player.nickname,
    subtitle: buildSubtitle(player, filter.window, matches, rounds),
    body: buildPlayerDrawerBody({ rowsAll: myAll, rowsCT: myCT, rowsT: myT, recent }),
    onClose: () => {
      state.openPlayerId = null
      clearActivePlayerCard()
    },
  })
}

function openPlayerPanel(player) {
  if (panel.isOpen() && state.openPlayerId === player.id) {
    panel.close()
    state.openPlayerId = null
    clearActivePlayerCard()
    return
  }
  state.openPlayerId = player.id
  renderPlayerPanel(player)
  markActivePlayerCard(player.id)
  const slot = document.getElementById('rr-player-panel-slot')
  if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

// ── Wire map filter event (delegated at document level) ───────────
document.addEventListener('rr:filter-map', (e) => {
  state.mapFilter = e.detail?.map ?? null
  if (state.filter) rebuild(state.filter)
})

// ── Mount filter into the hero's filter slot ──────────────────────
mountFilter(document.getElementById(HERO_FILTER_SLOT), (f) => { rebuild(f) })
