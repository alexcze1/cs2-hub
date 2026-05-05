import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { getTeamLogo, teamLogoEl } from './team-autocomplete.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('vods')

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function pct(n, d) { return d === 0 ? 0 : Math.round((n / d) * 100) }

const MAP_IMG = { dust2: 'dust' }
function mapImgUrl(map) { return `images/maps/${MAP_IMG[map] ?? map}.png` }

const el = document.getElementById('vods-list')
const { data: vods, error } = await supabase.from('vods').select('*').eq('team_id', getTeamId()).eq('dismissed', false).order('match_date', { ascending: false })

if (error) {
  el.innerHTML = `<div class="empty-state"><h3>Failed to load matches</h3><p>${esc(error.message)}</p></div>`
} else if (!vods?.length) {
  el.innerHTML = `<div class="empty-state"><h3>No matches yet</h3><p>Add your first result above.</p></div>`
} else {
  // ── Compute stats ────────────────────────────────────────
  const record = { w: 0, l: 0, d: 0 }
  let totalRW = 0, totalRL = 0
  const mapStats = {} // { map: { w, l, rw, rl } }

  for (const v of vods) {
    const maps = v.maps ?? []
    let mw = 0, ml = 0
    for (const m of maps) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      totalRW += us; totalRL += them
      if (!mapStats[m.map]) mapStats[m.map] = { w: 0, l: 0, rw: 0, rl: 0 }
      mapStats[m.map].rw += us
      mapStats[m.map].rl += them
      if (us > them) { mw++; mapStats[m.map].w++ }
      else if (them > us) { ml++; mapStats[m.map].l++ }
    }
    if (mw > ml) record.w++
    else if (ml > mw) record.l++
    else if (maps.length) record.d++
  }

  const totalMatches = record.w + record.l + record.d
  const roundWinPct  = pct(totalRW, totalRW + totalRL)

  // Best map: highest win % with at least 2 games
  const bestMapEntry = Object.entries(mapStats)
    .filter(([, s]) => s.w + s.l >= 2)
    .sort(([, a], [, b]) => pct(b.w, b.w + b.l) - pct(a.w, a.w + a.l))[0]

  // Recent form: last 5 matches
  const recentForm = vods.slice(0, 5).map(v => {
    const maps = v.maps ?? []
    let mw = 0, ml = 0
    for (const m of maps) {
      if ((m.score_us ?? 0) > (m.score_them ?? 0)) mw++
      else if ((m.score_them ?? 0) > (m.score_us ?? 0)) ml++
    }
    if (mw > ml) return 'W'
    if (ml > mw) return 'L'
    return 'D'
  })

  // ── Render stats bar ─────────────────────────────────────
  document.getElementById('stats-section').style.display = 'block'

  document.getElementById('top-stats').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Match Record</div>
      <div class="stat-value" style="font-size:20px">${record.w}W — ${record.l}L${record.d ? ' — ' + record.d + 'D' : ''}</div>
      <div class="stat-sub">${totalMatches} match${totalMatches !== 1 ? 'es' : ''} · ${pct(record.w, totalMatches)}% win rate</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Round Win Rate</div>
      <div class="stat-value">${roundWinPct}%</div>
      <div class="stat-sub">${totalRW}W — ${totalRL}L rounds</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Best Map</div>
      <div class="stat-value" style="font-size:18px">${bestMapEntry ? bestMapEntry[0].charAt(0).toUpperCase() + bestMapEntry[0].slice(1) : '—'}</div>
      <div class="stat-sub">${bestMapEntry ? pct(bestMapEntry[1].w, bestMapEntry[1].w + bestMapEntry[1].l) + '% win rate' : 'Need 2+ games per map'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Recent Form</div>
      <div class="form-dots">${recentForm.map(r => `<span class="form-dot form-dot-${r === 'W' ? 'win' : r === 'L' ? 'loss' : 'draw'}">${r}</span>`).join('')}</div>
      <div class="stat-sub">Last ${recentForm.length} matches</div>
    </div>
  `

  // ── Map breakdown ─────────────────────────────────────────
  const sortedMaps = Object.entries(mapStats).sort(([, a], [, b]) => (b.w + b.l) - (a.w + a.l))
  document.getElementById('map-breakdown').innerHTML = `
    <div class="map-breakdown-grid">
      ${sortedMaps.map(([map, s]) => {
        const games = s.w + s.l
        const wp  = pct(s.w, games)
        const rp  = pct(s.rw, s.rw + s.rl)
        const img = mapImgUrl(map)
        const barColor = wp >= 60 ? 'var(--success)' : wp >= 45 ? 'var(--accent)' : 'var(--danger)'
        const labelColor = wp >= 60 ? 'var(--success)' : wp >= 45 ? 'var(--muted)' : 'var(--danger)'
        const label = wp >= 60 ? 'STRONG' : wp >= 45 ? 'EVEN' : 'WEAK'
        return `
          <div class="map-stat-card">
            <img src="${img}" class="map-stat-bg" aria-hidden="true">
            <div class="map-stat-body">
              <div class="map-stat-top">
                <span class="map-stat-name">${map.charAt(0).toUpperCase() + map.slice(1)}</span>
                <span class="map-stat-label" style="color:${labelColor}">${label}</span>
              </div>
              <div class="map-stat-record">${s.w}W — ${s.l}L <span style="color:var(--muted);font-weight:400">(${games} game${games !== 1 ? 's' : ''})</span></div>
              <div class="map-stat-bar-wrap">
                <div class="map-stat-bar" style="width:${wp}%;background:${barColor}"></div>
              </div>
              <div class="map-stat-footer">
                <span class="map-stat-pct" style="color:${barColor}">${wp}% win rate</span>
                <span class="map-stat-rounds">${rp}% rounds</span>
              </div>
            </div>
          </div>
        `
      }).join('')}
    </div>
  `

  // ── Match list ────────────────────────────────────────────
  const logos = await Promise.all(vods.map(v => getTeamLogo(v.opponent ?? v.title)))

  function deriveInsights(maps) {
    if (!maps?.length) return []
    const out = []
    let totalUs = 0, totalThem = 0
    let bestMap = null, worstMap = null
    let closest = null
    for (const m of maps) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      totalUs += us; totalThem += them
      const diff = us - them
      if (!bestMap  || diff > bestMap.diff)         bestMap  = { ...m, diff, us, them }
      if (!worstMap || diff < worstMap.diff)        worstMap = { ...m, diff, us, them }
      const margin = Math.abs(diff)
      if (us + them > 0 && (!closest || margin < Math.abs(closest.diff))) closest = { ...m, diff, us, them }
    }
    const overallDiff = totalUs - totalThem
    if (Math.abs(overallDiff) >= 6) {
      out.push({
        text: `Round diff ${overallDiff > 0 ? '+' : ''}${overallDiff}`,
        cls: overallDiff > 0 ? 'positive' : 'negative',
      })
    }
    if (bestMap && bestMap.diff > 4) {
      out.push({ text: `Strong on ${capitalize(bestMap.map)} ${bestMap.us}–${bestMap.them}`, cls: 'positive' })
    }
    if (worstMap && worstMap.diff < -4 && worstMap.map !== bestMap?.map) {
      out.push({ text: `Lost ${capitalize(worstMap.map)} ${worstMap.us}–${worstMap.them}`, cls: 'negative' })
    }
    if (maps.length >= 2 && closest && Math.abs(closest.diff) <= 2 && closest.map !== bestMap?.map && closest.map !== worstMap?.map) {
      out.push({ text: `Close fight on ${capitalize(closest.map)} ${closest.us}–${closest.them}`, cls: '' })
    }
    return out.slice(0, 3)
  }

  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }

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
