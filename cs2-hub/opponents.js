// cs2-hub/opponents.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { getTeamLogo, teamLogoEl } from './team-autocomplete.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

export function deriveOpponentStats(opponents, historyIndex) {
  const total = opponents.length
  if (total === 0) return { total: 0, withMaps: 0, threats: 0, favored: 0, mapsCovered: 0, topMap: null }
  let withMaps = 0, threats = 0, favored = 0
  const mapCounts = new Map()   // map -> { n, firstIdx }
  for (let i = 0; i < opponents.length; i++) {
    const o = opponents[i]
    const maps = o.favored_maps ?? []
    if (maps.length > 0) withMaps++
    for (const m of maps) {
      const e = mapCounts.get(m)
      if (e) e.n++; else mapCounts.set(m, { n: 1, firstIdx: i })
    }
    const h = historyIndex?.[(o.name ?? '').trim().toLowerCase()]
    if (h && h.matches >= 2) {
      const wp = (h.mw / h.matches) * 100
      if (wp <= 33) threats++
      else if (wp >= 67) favored++
    }
  }
  let topMap = null, top = 0, topIdx = Infinity
  for (const [k, { n, firstIdx }] of mapCounts) {
    if (n > top || (n === top && firstIdx < topIdx)) { topMap = k; top = n; topIdx = firstIdx }
  }
  return { total, withMaps, threats, favored, mapsCovered: mapCounts.size, topMap }
}

const MAP_IMG = { dust2: 'dust' }
function mapChip(map) {
  const src = `images/maps/${MAP_IMG[map] ?? map}.png`
  return `<div class="intel-map-chip">
    <img src="${src}" aria-hidden="true">
    <span>${map.slice(0,3).toUpperCase()}</span>
  </div>`
}

await requireAuth()
renderSidebar('opponents')

const el = document.getElementById('opponents-list')
const teamId = getTeamId()
const [{ data: opponents, error }, { data: vods }] = await Promise.all([
  supabase.from('opponents').select('*').eq('team_id', teamId).order('name', { ascending: true }),
  supabase.from('vods').select('opponent, title, maps').eq('team_id', teamId).eq('dismissed', false)
])

function buildHistoryIndex(vods) {
  const idx = {}
  for (const v of vods ?? []) {
    const key = (v.opponent ?? v.title ?? '').trim().toLowerCase()
    if (!key) continue
    const r = idx[key] ??= { matches: 0, mw: 0, ml: 0 }
    let mw = 0, ml = 0
    for (const m of v.maps ?? []) {
      if ((m.score_us ?? 0) > (m.score_them ?? 0)) mw++
      else if ((m.score_them ?? 0) > (m.score_us ?? 0)) ml++
    }
    r.matches++
    if (mw > ml) r.mw++
    else if (ml > mw) r.ml++
  }
  return idx
}

function threatTag(history) {
  if (!history || history.matches === 0) return { cls: 'new',    label: 'No History' }
  const wp = history.matches ? Math.round((history.mw / history.matches) * 100) : 0
  if (history.matches < 2)         return { cls: 'new',    label: `${history.mw}W — ${history.ml}L` }
  if (wp <= 33)                    return { cls: 'strong', label: `Threat · ${wp}%` }
  if (wp >= 67)                    return { cls: 'weak',   label: `Favored · ${wp}%` }
  return                                  { cls: 'even',   label: `Even · ${wp}%` }
}

if (error) {
  el.innerHTML = `<div class="empty-state"><h3>Failed to load opponents</h3><p>${esc(error.message)}</p></div>`
} else if (!opponents?.length) {
  el.innerHTML = `<div class="empty-state"><h3>No opponents yet</h3><p>Add a team before your next match.</p></div>`
} else {
  const history = buildHistoryIndex(vods)
  const logos = await Promise.all(opponents.map(o => getTeamLogo(o.name)))
  el.innerHTML = `<div class="intel-grid">${opponents.map((o, i) => {
    const h = history[(o.name ?? '').trim().toLowerCase()]
    const tag = threatTag(h)
    return `
      <a class="intel-card" href="opponent-detail.html?id=${o.id}">
        <div class="intel-head">
          ${teamLogoEl(logos[i], o.name, 36)}
          <div class="intel-name">${esc(o.name)}</div>
          <span class="intel-tag intel-tag-${tag.cls}">${tag.label}</span>
        </div>
        <div class="intel-section-label">Favored maps</div>
        ${o.favored_maps?.length
          ? `<div class="intel-maps">${o.favored_maps.map(mapChip).join('')}</div>`
          : `<div class="intel-empty">No maps noted</div>`}
      </a>
    `
  }).join('')}</div>`
}
