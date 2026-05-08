// cs2-hub/vods-team-stats.js
//
// Renders the top 4-card stats grid + Map Pool Performance for a given
// list of vods. Pure UI — no Supabase calls. Caller passes filtered vods.

const MAP_IMG = { dust2: 'dust' }
function mapImgUrl(map) { return `images/maps/${MAP_IMG[map] ?? map}.png` }
function pct(n, d) { return d === 0 ? 0 : Math.round((n / d) * 100) }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }

export function renderTeamStats(rootStats, rootMaps, vods) {
  if (!vods?.length) {
    rootStats.innerHTML = ''
    rootMaps.innerHTML = ''
    return
  }

  const record = { w: 0, l: 0, d: 0 }
  let totalRW = 0, totalRL = 0
  const mapStats = {}

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

  const bestMapEntry = Object.entries(mapStats)
    .filter(([, s]) => s.w + s.l >= 2)
    .sort(([, a], [, b]) => pct(b.w, b.w + b.l) - pct(a.w, a.w + a.l))[0]

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

  rootStats.innerHTML = `
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
      <div class="stat-value" style="font-size:18px">${bestMapEntry ? capitalize(bestMapEntry[0]) : '—'}</div>
      <div class="stat-sub">${bestMapEntry ? pct(bestMapEntry[1].w, bestMapEntry[1].w + bestMapEntry[1].l) + '% win rate' : 'Need 2+ games per map'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Recent Form</div>
      <div class="form-dots">${recentForm.map(r => `<span class="form-dot form-dot-${r === 'W' ? 'win' : r === 'L' ? 'loss' : 'draw'}">${r}</span>`).join('')}</div>
      <div class="stat-sub">Last ${recentForm.length} matches</div>
    </div>
  `

  const sortedMaps = Object.entries(mapStats).sort(([, a], [, b]) => (b.w + b.l) - (a.w + a.l))
  rootMaps.innerHTML = `
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
                <span class="map-stat-name">${capitalize(map)}</span>
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
}
