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

// Markup matches layout.js renderToolHeader output (tool-head classes) but is
// built inline so this module stays import-light for the unit-test page.
function headShell({ kpis = '', filterSlotId }) {
  return `
    <div class="tool-head">
      <div class="tool-head-top">
        <div class="tool-head-text">
          <div class="tool-head-kicker">Review</div>
          <h1 class="tool-head-title">Matches</h1>
          <div class="tool-head-sub">Results, reviews and team form across scrims, tournaments and pugs.</div>
        </div>
        <div class="tool-head-actions">
          <a class="dx-upload-cta" href="vod-detail.html">+ Add Match</a>
        </div>
      </div>
      ${kpis ? `<div class="tool-head-kpis">${kpis}</div>` : ''}
    </div>
    <div id="${esc(filterSlotId)}" class="rr-filter-slot"></div>`
}

function chip(v, k, tone = '') {
  return `<div class="kpi-chip ${tone ? `kpi-${tone}` : ''}"><span class="kpi-chip-v">${v}</span><span class="kpi-chip-k">${esc(k)}</span></div>`
}

export function renderHero(root, { vods, filterSlotId, teamStatsRows }) {
  if (!vods || vods.length === 0) {
    root.innerHTML = headShell({
      kpis: chip('0', 'matches in this window'),
      filterSlotId,
    })
    return
  }

  const s = computeHeroStats(vods)
  const teamAgg = teamStatsRows && teamStatsRows.length ? aggregateTeamStats(teamStatsRows) : null
  const weak = pickWeakestArea(teamAgg)
  const weakChip = weak
    ? chip(`${esc(weak.label)} ${weak.wr}%`, 'weakest area', 'bad')
    : (s.worstMap ? chip(`${esc(capitalize(s.worstMap.map))} ${s.worstMap.wr}%`, 'weakest map', 'bad') : '')

  const bars = s.sparkline.map(p =>
    `<span class="rr-spark-bar" style="height:${Math.max(p.pct, 4)}%"></span>`
  ).join('')
  const trendChip = bars
    ? `<div class="kpi-chip kpi-chip-spark"><span class="rr-spark">${bars}</span><span class="kpi-chip-k">last 10</span></div>`
    : ''

  const record = `${s.record.w}W–${s.record.l}L${s.record.d ? `–${s.record.d}D` : ''}`
  root.innerHTML = headShell({
    kpis: [
      chip(record, 'record', s.record.w >= s.record.l ? 'good' : 'bad'),
      chip(s.roundWR == null ? '—' : `${s.roundWR}%`, 'round WR'),
      s.bestMap ? chip(`${esc(capitalize(s.bestMap.map))} ${s.bestMap.wr}%`, 'best map', 'good') : '',
      weakChip,
      trendChip,
    ].join(''),
    filterSlotId,
  })
}
