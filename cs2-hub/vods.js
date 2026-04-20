import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('vods')

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function pct(n, d) { return d === 0 ? 0 : Math.round((n / d) * 100) }

const el = document.getElementById('vods-list')
const { data: vods, error } = await supabase.from('vods').select('*').eq('team_id', getTeamId()).order('match_date', { ascending: false })

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
        const wp = pct(s.w, games)
        const rp = pct(s.rw, s.rw + s.rl)
        return `
          <div class="map-stat-row">
            <div class="map-stat-name">${map.charAt(0).toUpperCase() + map.slice(1)}</div>
            <div class="map-stat-record">${s.w}W — ${s.l}L</div>
            <div class="map-stat-bar-wrap">
              <div class="map-stat-bar" style="width:${wp}%" title="${wp}% map win rate"></div>
            </div>
            <div class="map-stat-pct">${wp}%</div>
            <div class="map-stat-rounds" title="Round win rate">${rp}% rds</div>
          </div>
        `
      }).join('')}
    </div>
  `

  // ── Match list ────────────────────────────────────────────
  el.innerHTML = vods.map(v => {
    const maps = v.maps ?? []
    const mapsStr = maps.map(m => {
      const r = (m.score_us ?? 0) > (m.score_them ?? 0) ? 'win' : (m.score_them ?? 0) > (m.score_us ?? 0) ? 'loss' : 'draw'
      return `<span class="map-chip map-chip-${r}">${m.map.slice(0,3).toUpperCase()} ${m.score_us ?? '?'}–${m.score_them ?? '?'}</span>`
    }).join('')
    return `
      <a class="list-row" href="vod-detail.html?id=${v.id}">
        <span class="badge badge-${v.result ?? 'draw'}">${(v.result ?? '—').toUpperCase()}</span>
        <div class="flex-1">
          <div class="row-name">vs ${esc(v.opponent ?? v.title)}</div>
          <div class="row-meta" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${mapsStr}</div>
        </div>
        <div class="row-meta" style="text-align:right">
          <div>${esc(v.match_type ?? '')}</div>
          <div>${v.match_date ? formatDate(v.match_date) : '—'}</div>
        </div>
      </a>
    `
  }).join('')
}
