import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { getTeamLogo, teamLogoEl } from './team-autocomplete.js'
import { mountFilter } from './vods-filter.js'
import { renderTeamStats } from './vods-team-stats.js'
import { renderRosterBand } from './roster-stats.js'
import { mountDrawer } from './player-drawer.js'
import { buildPlayerDrawerBody, buildSubtitle, windowLabel } from './roster-stats-render.js'
import { applyTimeWindow } from './roster-stats-aggregate.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function formatDate(d) { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }

await requireAuth()
renderSidebar('vods')

const teamId = getTeamId()
const drawer = mountDrawer()

// ── Load all data once ──────────────────────────────────────────
const [vodsRes, rosterRes] = await Promise.all([
  supabase.from('vods').select('*').eq('team_id', teamId).eq('dismissed', false).order('match_date', { ascending: false }),
  supabase.from('roster').select('*').eq('team_id', teamId),
])
if (vodsRes.error) {
  document.getElementById('vods-list').innerHTML = `<div class="empty-state"><h3>Failed to load matches</h3><p>${esc(vodsRes.error.message)}</p></div>`
  throw vodsRes.error
}
const allVods   = vodsRes.data ?? []
const roster    = rosterRes.data ?? []
const teamSteamIds = new Set(roster.map(p => p.steam_id).filter(Boolean))

if (!allVods.length) {
  document.getElementById('vods-list').innerHTML = `<div class="empty-state"><h3>No matches yet</h3><p>Add your first result above.</p></div>`
} else {
  document.getElementById('stats-section').style.display = 'block'
}

// ── Resolve demo set + demo_players for the filtered vod set ────
async function fetchPlayerRowsForVods(filteredVods) {
  // Step 1: extract seed demo IDs from vod.demo_link strings.
  const seedDemoIds = filteredVods
    .map(v => {
      const m = /id=([0-9a-fA-F-]{36})/.exec(v.demo_link || '')
      return m ? m[1] : null
    })
    .filter(Boolean)
  if (!seedDemoIds.length) return { rowsAll: [], rowsCT: [], rowsT: [], demosById: new Map() }

  // Step 2: load seed demo rows (for series_id + map + played_at).
  const { data: seedDemos, error: e1 } = await supabase
    .from('demos')
    .select('id,series_id,map,played_at,opponent_name')
    .in('id', seedDemoIds)
  if (e1) throw e1

  // Step 3: expand series → sibling demos.
  const seriesIds = [...new Set((seedDemos || []).map(d => d.series_id).filter(Boolean))]
  let allDemos = seedDemos || []
  if (seriesIds.length) {
    const { data: siblings, error: e2 } = await supabase
      .from('demos')
      .select('id,series_id,map,played_at,opponent_name')
      .in('series_id', seriesIds)
    if (e2) throw e2
    const known = new Set(allDemos.map(d => d.id))
    for (const d of siblings || []) if (!known.has(d.id)) allDemos.push(d)
  }
  const demoIds = allDemos.map(d => d.id)
  const demosById = new Map(allDemos.map(d => [d.id, d]))

  if (!teamSteamIds.size || !demoIds.length) return { rowsAll: [], rowsCT: [], rowsT: [], demosById }

  // Step 4: load demo_players for our roster's steam_ids only.
  const teamSteamIdList = [...teamSteamIds]
  const { data: rows, error: e3 } = await supabase
    .from('demo_players')
    .select('*')
    .in('demo_id', demoIds)
    .in('steam_id', teamSteamIdList)
  if (e3) throw e3

  // Attach demos.map to each row for per-map aggregation.
  for (const r of rows || []) {
    const d = demosById.get(r.demo_id)
    r.map = d?.map ?? null
  }
  const rowsAll = (rows || []).filter(r => r.side === 'all')
  const rowsCT  = (rows || []).filter(r => r.side === 'ct')
  const rowsT   = (rows || []).filter(r => r.side === 't')
  return { rowsAll, rowsCT, rowsT, demosById }
}

function filterVods(filter) {
  let pool = allVods
  if (filter.tournamentsOnly) pool = pool.filter(v => v.match_type === 'tournament')
  return applyTimeWindow(pool, filter.window)
}

// Map a demo back to its vod by extracting the demo_id from vod.demo_link
// AND scanning for siblings via series_id. Used to produce W/L for the
// drawer's recent-matches section.
function buildDemoToVodMap(filteredVods, demosById) {
  const seedToVod = new Map() // demo_id → vod
  for (const v of filteredVods) {
    const m = /id=([0-9a-fA-F-]{36})/.exec(v.demo_link || '')
    if (m) seedToVod.set(m[1], v)
  }
  const seriesToVod = new Map() // series_id → vod
  for (const [demoId, v] of seedToVod) {
    const d = demosById.get(demoId)
    if (d?.series_id) seriesToVod.set(d.series_id, v)
  }
  // Now build demo_id → vod for every demo
  const demoToVod = new Map()
  for (const [demoId, d] of demosById) {
    if (seedToVod.has(demoId)) demoToVod.set(demoId, seedToVod.get(demoId))
    else if (d.series_id && seriesToVod.has(d.series_id)) demoToVod.set(demoId, seriesToVod.get(d.series_id))
  }
  return demoToVod
}

// W/L for a single demo: derived from per-map vod.maps[].score_us/score_them
// matched on map name. Falls back to 'd' (draw/unknown).
function demoResult(demo, vod) {
  if (!vod || !demo) return 'd'
  const slot = (vod.maps || []).find(m => String(m.map).toLowerCase() === String(demo.map).toLowerCase())
  if (!slot || slot.score_us == null || slot.score_them == null) return 'd'
  if (slot.score_us > slot.score_them) return 'w'
  if (slot.score_us < slot.score_them) return 'l'
  return 'd'
}

// ── Match history list (existing, unchanged behavior) ─────────
async function renderMatchList(vods) {
  const el = document.getElementById('vods-list')
  if (!vods.length) {
    el.innerHTML = `<div class="empty-state"><h3>No matches in window</h3><p>Try a wider time window.</p></div>`
    return
  }
  const logos = await Promise.all(vods.map(v => getTeamLogo(v.opponent ?? v.title)))

  function deriveInsights(maps) {
    if (!maps?.length) return []
    const out = []
    let totalUs = 0, totalThem = 0
    let bestMap = null, worstMap = null, closest = null
    for (const m of maps) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      totalUs += us; totalThem += them
      const diff = us - them
      if (!bestMap  || diff > bestMap.diff)  bestMap  = { ...m, diff, us, them }
      if (!worstMap || diff < worstMap.diff) worstMap = { ...m, diff, us, them }
      const margin = Math.abs(diff)
      if (us + them > 0 && (!closest || margin < Math.abs(closest.diff))) closest = { ...m, diff, us, them }
    }
    const overallDiff = totalUs - totalThem
    if (Math.abs(overallDiff) >= 6) out.push({ text: `Round diff ${overallDiff > 0 ? '+' : ''}${overallDiff}`, cls: overallDiff > 0 ? 'positive' : 'negative' })
    if (bestMap && bestMap.diff > 4) out.push({ text: `Strong on ${capitalize(bestMap.map)} ${bestMap.us}–${bestMap.them}`, cls: 'positive' })
    if (worstMap && worstMap.diff < -4 && worstMap.map !== bestMap?.map) out.push({ text: `Lost ${capitalize(worstMap.map)} ${worstMap.us}–${worstMap.them}`, cls: 'negative' })
    if (maps.length >= 2 && closest && Math.abs(closest.diff) <= 2 && closest.map !== bestMap?.map && closest.map !== worstMap?.map) out.push({ text: `Close fight on ${capitalize(closest.map)} ${closest.us}–${closest.them}`, cls: '' })
    return out.slice(0, 3)
  }
  function aggregateScore(maps) {
    let mw = 0, ml = 0
    for (const m of maps ?? []) {
      if ((m.score_us ?? 0) > (m.score_them ?? 0)) mw++
      else if ((m.score_them ?? 0) > (m.score_us ?? 0)) ml++
    }
    return { mw, ml }
  }

  el.innerHTML = vods.map((v, vi) => {
    const maps = v.maps ?? []
    const { mw, ml } = aggregateScore(maps)
    const result = mw > ml ? 'win' : ml > mw ? 'loss' : maps.length ? 'draw' : 'draw'
    const oppName = v.opponent ?? v.title
    const mapsLabel = maps.length === 1
      ? `${capitalize(maps[0].map)} · ${maps[0].score_us ?? '?'}–${maps[0].score_them ?? '?'}`
      : maps.length > 1
        ? `BO${maps.length} · ${maps.map(m => capitalize(m.map)).join(' / ')}`
        : 'No maps'
    const insights = deriveInsights(maps)
    return `
      <a class="match-card match-card-${result}" href="vod-detail.html?id=${v.id}">
        <div class="match-result">
          <span class="match-result-tag match-result-${result}">${result === 'draw' ? 'DRAW' : result.toUpperCase()}</span>
          <span class="match-result-score match-result-score-${result}">${mw}–${ml}</span>
        </div>
        <div class="match-body">
          <div class="match-opponent">
            ${teamLogoEl(logos[vi], oppName, 28)}
            <span>vs ${esc(oppName)}</span>
            ${v.external_uid ? '<span class="pracc-badge">PRACC</span>' : ''}
          </div>
          <div class="match-opponent-meta">${esc(mapsLabel)}</div>
          ${insights.length ? `<div class="match-bullets">${insights.map(i =>
            `<span class="match-bullet ${i.cls ? 'match-bullet-' + i.cls : ''}">${esc(i.text)}</span>`
          ).join('')}</div>` : ''}
        </div>
        <div class="match-meta">
          <div>${esc(v.match_type ?? '')}</div>
          <div class="match-meta-date">${v.match_date ? formatDate(v.match_date) : '—'}</div>
        </div>
      </a>
    `
  }).join('')
}

// ── Drawer open: fetch player-specific data + render body ─────
let lastDataset = null  // { filter, vods, rowsAll, rowsCT, rowsT, demosById, demoToVod }

async function openPlayerDrawer(player) {
  if (!lastDataset) return
  const { rowsAll, rowsCT, rowsT, demosById, demoToVod, filter } = lastDataset
  const sid = player.steam_id

  const myAll = rowsAll.filter(r => r.steam_id === sid)
  const myCT  = rowsCT.filter(r  => r.steam_id === sid)
  const myT   = rowsT.filter(r   => r.steam_id === sid)

  const matches = myAll.length
  const rounds  = myAll.reduce((s, r) => s + (r.rounds_played || 0), 0)

  const recent = myAll
    .map(r => {
      const demo = demosById.get(r.demo_id)
      const vod = demo ? demoToVod.get(r.demo_id) : null
      return {
        vod_id: vod?.id,
        opponent: vod?.opponent ?? demo?.opponent_name ?? '—',
        map: demo?.map ?? '—',
        rating: r.rating,
        result: demoResult(demo, vod),
        played_at: demo?.played_at ?? null,
      }
    })
    .sort((a, b) => String(b.played_at || '').localeCompare(String(a.played_at || '')))
    .slice(0, 10)

  drawer.open({
    title: player.username,
    subtitle: buildSubtitle(player, filter.window, matches, rounds),
    body: buildPlayerDrawerBody({ rowsAll: myAll, rowsCT: myCT, rowsT: myT, recent }),
  })

  // Wire "View all-time" CTA inside empty-state body
  const cta = document.getElementById('pd-view-alltime')
  if (cta) {
    cta.addEventListener('click', () => {
      const f = JSON.parse(localStorage.getItem('vods:filter:v1') || '{}')
      f.window = 'all'; f.tournamentsOnly = !!f.tournamentsOnly
      localStorage.setItem('vods:filter:v1', JSON.stringify(f))
      window.location.reload()
    })
  }
}

// ── Top-level: rebuild whole view on filter change ────────────
async function rebuild(filter) {
  const filteredVods = filterVods(filter)

  await renderMatchList(filteredVods)
  renderTeamStats(document.getElementById('top-stats'), document.getElementById('map-breakdown'), filteredVods)

  const { rowsAll, rowsCT, rowsT, demosById } = await fetchPlayerRowsForVods(filteredVods)
  const demoToVod = buildDemoToVodMap(filteredVods, demosById)

  lastDataset = { filter, vods: filteredVods, rowsAll, rowsCT, rowsT, demosById, demoToVod }

  renderRosterBand(document.getElementById('roster-band'), {
    roster, rows: rowsAll, onPick: openPlayerDrawer,
  })

  // If the drawer is open, refresh its content with the new dataset
  if (drawer.isOpen()) {
    // Find the currently-open player by their displayed name (best effort).
    const openName = document.querySelector('.player-drawer .pd-title')?.textContent
    const player = roster.find(p => p.username === openName)
    if (player && player.steam_id) openPlayerDrawer(player)
    else drawer.close()
  }
}

// Mount filter; mountFilter calls back synchronously on mount + on each change.
mountFilter(document.getElementById('filter-slot'), (filter) => { rebuild(filter) })
