// cs2-hub/vods-hero.js
//
// Renders the Results & Review hero: record, round WR, best/worst map,
// sparkline (last 10 round-WR), filter pill slot, +Add Match button.
// computeHeroStats is exported for unit testing.

function pct(n, d) { return d === 0 ? null : Math.round((n / d) * 100) }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const MIN_BEST_WORST_SAMPLES = 3

export function computeHeroStats(vods) {
  const record = { w: 0, l: 0, d: 0 }
  let totalRW = 0, totalRL = 0
  const byMap = {}    // map → { rw, rl, plays }

  const sortedByDate = [...(vods || [])]
    .filter(v => v.match_date)
    .sort((a, b) => String(b.match_date).localeCompare(String(a.match_date)))

  for (const v of vods || []) {
    const maps = v.maps ?? []
    let mw = 0, ml = 0
    for (const m of maps) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      totalRW += us; totalRL += them
      if (!byMap[m.map]) byMap[m.map] = { rw: 0, rl: 0, plays: 0, w: 0, l: 0 }
      const slot = byMap[m.map]
      slot.rw += us; slot.rl += them; slot.plays++
      if (us > them) { mw++; slot.w++ }
      else if (them > us) { ml++; slot.l++ }
    }
    if (mw > ml) record.w++
    else if (ml > mw) record.l++
    else if (maps.length) record.d++
  }

  const totalRounds = totalRW + totalRL
  const roundWR = totalRounds === 0 ? null : Math.round((totalRW / totalRounds) * 100)

  const eligible = Object.entries(byMap)
    .filter(([, s]) => s.plays >= MIN_BEST_WORST_SAMPLES)
    .map(([map, s]) => ({ map, wr: pct(s.w, s.w + s.l), plays: s.plays }))
  const ranked = [...eligible].sort((a, b) => (b.wr ?? -1) - (a.wr ?? -1))
  const bestMap  = ranked[0] ?? null
  const worstMap = ranked.length >= 2 ? ranked[ranked.length - 1] : null

  const sparkline = sortedByDate.slice(0, 10).map(v => {
    let rw = 0, rl = 0
    for (const m of v.maps ?? []) { rw += m.score_us ?? 0; rl += m.score_them ?? 0 }
    const total = rw + rl
    return { id: v.id, pct: total === 0 ? 0 : Math.round((rw / total) * 100) }
  })

  return { record, totalRW, totalRL, roundWR, bestMap, worstMap, sparkline }
}

export function renderHero(root, { vods, filterSlotId }) {
  if (!vods || vods.length === 0) {
    root.innerHTML = `
      <div class="rr-hero-empty">
        <div class="rr-hero-title">RESULTS &amp; REVIEW</div>
        <h2 class="rr-hero-empty-msg">No matches yet</h2>
        <a class="rr-add-match" href="vod-detail.html">+ Add Match</a>
      </div>`
    return
  }

  const s = computeHeroStats(vods)
  const bars = s.sparkline.map(p =>
    `<span class="rr-spark-bar" style="height:${Math.max(p.pct, 4)}%"></span>`
  ).join('')

  root.innerHTML = `
    <div class="rr-hero-grid">
      <div class="rr-hero-left">
        <div class="rr-hero-title">RESULTS &amp; REVIEW</div>
        <div class="rr-hero-record">
          <span class="rr-hero-w">${s.record.w}W</span>
          <span class="rr-hero-sep">—</span>
          <span class="rr-hero-l">${s.record.l}L</span>
          ${s.record.d ? `<span class="rr-hero-sep">—</span><span class="rr-hero-d">${s.record.d}D</span>` : ''}
        </div>
        <div class="rr-hero-subgrid">
          <div class="rr-kv"><div class="rr-kv-k">Round WR</div><div class="rr-kv-v">${s.roundWR == null ? '—' : s.roundWR + '%'}</div></div>
          <div class="rr-kv"><div class="rr-kv-k">Best map</div><div class="rr-kv-v">${s.bestMap ? esc(capitalize(s.bestMap.map)) + ' ' + s.bestMap.wr + '%' : '—'}</div></div>
          <div class="rr-kv"><div class="rr-kv-k">Weakest</div><div class="rr-kv-v">${s.worstMap ? esc(capitalize(s.worstMap.map)) + ' ' + s.worstMap.wr + '%' : '—'}</div></div>
        </div>
        <a class="rr-add-match" href="vod-detail.html">+ Add Match</a>
      </div>
      <div class="rr-hero-right">
        <div class="rr-section-label">Trend · Last 10</div>
        <div class="rr-spark">${bars || '<span class="rr-muted">No matches</span>'}</div>
        <div id="${esc(filterSlotId)}" class="rr-filter-slot"></div>
      </div>
    </div>`
}
