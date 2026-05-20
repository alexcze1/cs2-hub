// cs2-hub/vods-hero.js
//
// Renders the Results & Review hero: record, round WR, best map, weakest
// area (dynamic — lowest-WR macro stat with enough sample, falls back to
// weakest map), sparkline (last 10 round-WR), filter pill slot, +Add Match.
// computeHeroStats + pickWeakestArea are exported for unit testing.

import { aggregateTeamStats } from './team-stats-aggregate.js'

function pct(n, d) { return d === 0 ? null : Math.round((n / d) * 100) }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const MIN_BEST_WORST_SAMPLES = 3
const MIN_AREA_SAMPLE = 5     // rounds played for a stat-tile area to be weakness-eligible
const MIN_SIDE_SAMPLE = 24    // rounds played for a side (CT/T) to be eligible

// Candidates: array of { key, label, wins, played, kind }
function weaknessCandidates(agg) {
  return [
    { key: 'pistols',    label: 'Pistol rounds', ...agg.pistols,    min: MIN_AREA_SAMPLE },
    { key: 'hard_eco',   label: 'Hard eco',      ...agg.hard_eco,   min: MIN_AREA_SAMPLE },
    { key: 'eco',        label: 'Eco rounds',    ...agg.eco,        min: MIN_AREA_SAMPLE },
    { key: 'force',      label: 'Force buy',     ...agg.force,      min: MIN_AREA_SAMPLE },
    { key: 'half_buy',   label: 'Half buy',      ...agg.half_buy,   min: MIN_AREA_SAMPLE },
    { key: 'full_buy',   label: 'Full-buy',      ...agg.full_buy,   min: MIN_AREA_SAMPLE },
    { key: 'anti_ecos',  label: 'Anti-eco',      ...agg.anti_ecos,  min: MIN_AREA_SAMPLE },
    { key: 'anti_force', label: 'Anti-force',    ...agg.anti_force, min: MIN_AREA_SAMPLE },
    { key: 'ct',         label: 'CT side',       ...agg.ct,         min: MIN_SIDE_SAMPLE },
    { key: 't',          label: 'T side',        ...agg.t,          min: MIN_SIDE_SAMPLE },
  ]
}

// Lowest-WR area among candidates that meet their min-sample bar.
// Returns { label, wr } or null.
export function pickWeakestArea(teamStatsAgg) {
  if (!teamStatsAgg) return null
  const eligible = weaknessCandidates(teamStatsAgg)
    .filter(c => c.played >= c.min && c.played > 0)
    .map(c => ({ label: c.label, wr: pct(c.wins, c.played) }))
    .filter(c => c.wr != null)
  if (eligible.length === 0) return null
  eligible.sort((a, b) => a.wr - b.wr)
  return eligible[0]
}

export function computeHeroStats(vods) {
  const record = { w: 0, l: 0, d: 0 }
  let totalRW = 0, totalRL = 0
  const byMap = {}

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

export function renderHero(root, { vods, filterSlotId, teamStatsRows }) {
  if (!vods || vods.length === 0) {
    root.innerHTML = `
      <div class="rr-hero-empty">
        <div class="rr-hero-title">RESULTS &amp; REVIEW</div>
        <h2 class="rr-hero-empty-msg">No matches in this window</h2>
        <a class="rr-add-match" href="vod-detail.html">+ Add Match</a>
        <div id="${esc(filterSlotId)}" class="rr-filter-slot"></div>
      </div>`
    return
  }

  const s = computeHeroStats(vods)
  const teamAgg = teamStatsRows && teamStatsRows.length ? aggregateTeamStats(teamStatsRows) : null
  const weak = pickWeakestArea(teamAgg)
  const weakHtml = weak
    ? `<div class="rr-kv rr-kv-weak"><div class="rr-kv-k">Weak</div><div class="rr-kv-v">${esc(weak.label)} ${weak.wr}%</div></div>`
    : (s.worstMap
        ? `<div class="rr-kv"><div class="rr-kv-k">Weakest</div><div class="rr-kv-v">${esc(capitalize(s.worstMap.map))} ${s.worstMap.wr}%</div></div>`
        : '')

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
          ${weakHtml}
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
