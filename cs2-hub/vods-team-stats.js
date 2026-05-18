// cs2-hub/vods-team-stats.js
//
// Renders the aggregated Team Stats section on Results & Review.
// Reads demo_team_stats rows filtered to "our team" via ourTeamByDemoId,
// runs them through team-stats-aggregate, and emits an 11-tile grid.
// Percentage tiles get a trend chip when prior window has enough sample.

import { aggregateTeamStats, computeDeltas } from './team-stats-aggregate.js'

const TREND_ARROW = { up: '↗', down: '↘', flat: '▬' }
const DELTA_THRESHOLD = 0.005  // ignore deltas under 0.5% as flat

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

function fmtPct(p) { return p == null ? '—' : `${Math.round(p * 100)}%` }
function fmtWL(wins, played) {
  if (played == null || played === 0) return '—'
  return `${wins}–${played - wins}`
}
function fmtCount(n) { return n == null ? '—' : String(n) }

// "14–7 67%" or "—"
function fmtWLPct(wins, played, pct) {
  const wl = fmtWL(wins, played)
  if (wl === '—') return '—'
  return `${wl}  ${fmtPct(pct)}`
}

function trendClass(delta) {
  if (delta == null) return null
  if (delta >  DELTA_THRESHOLD) return 'up'
  if (delta < -DELTA_THRESHOLD) return 'down'
  return 'flat'
}

function trendChip(delta) {
  const cls = trendClass(delta)
  if (cls == null) return ''
  const sign = delta > 0 ? '+' : ''
  return `<span class="rr-trend rr-trend-${cls}">${TREND_ARROW[cls]} ${sign}${Math.round(delta * 100)}%</span>`
}

// Filter input rows to "our team" rows (using ourTeamByDemoId Map).
function ourRows(rows, ourTeamByDemoId) {
  if (!rows) return []
  return rows.filter(r => {
    const ours = ourTeamByDemoId?.get(r.demo_id)
    return ours && ours === r.team
  })
}

// Tile descriptors. Each one knows how to render itself from the `view` object
// returned by computeDeltas (or directly from `current` for the count tiles).
// `kind`: 'pct'   → { wins, played, pct } + optional delta
//         'count' → number, no delta
//         'wl'    → { wins, played } no pct, no delta (force-buy)
function tileDescriptors(view) {
  return [
    { label: 'Pistols',        kind: 'pct',   value: view.pistols.value,     delta: view.pistols.delta },
    { label: 'Anti-ecos',      kind: 'pct',   value: view.anti_ecos.value,   delta: view.anti_ecos.delta },
    { label: 'Eco wins',       kind: 'pct',   value: view.eco.value,         delta: view.eco.delta },
    { label: 'Force-buy wins', kind: 'wl',    value: view.force.value },
    { label: 'Full-buy wins',  kind: 'pct',   value: view.full_buy.value,    delta: view.full_buy.delta },
    { label: 'First kills',    kind: 'count', value: view.first_kills },
    { label: 'First deaths',   kind: 'count', value: view.first_deaths },
    { label: 'Opening duel W%', kind: 'pct-only', value: view.opening_duel.value, delta: view.opening_duel.delta },
    { label: '5v4 conversion', kind: 'pct',   value: view.five_v_four.value, delta: view.five_v_four.delta },
    { label: 'CT win rate',    kind: 'pct',   value: view.ct.value,          delta: view.ct.delta },
    { label: 'T win rate',     kind: 'pct',   value: view.t.value,           delta: view.t.delta },
  ]
}

function renderTile(t) {
  let valueHtml
  if (t.kind === 'pct') {
    valueHtml = `<div class="stat-value">${fmtWLPct(t.value.wins, t.value.played, t.value.pct)}</div>`
  } else if (t.kind === 'wl') {
    valueHtml = `<div class="stat-value">${fmtWL(t.value.wins, t.value.played)}</div>`
  } else if (t.kind === 'count') {
    valueHtml = `<div class="stat-value">${fmtCount(t.value)}</div>`
  } else if (t.kind === 'pct-only') {
    valueHtml = `<div class="stat-value">${fmtPct(t.value.pct)}</div>`
  }
  const chip = (t.kind === 'pct' || t.kind === 'pct-only') ? trendChip(t.delta) : ''
  return `
    <div class="stat-card rr-team-stat">
      <div class="stat-label">${esc(t.label)}${chip}</div>
      ${valueHtml}
    </div>
  `
}

export function renderTeamStats(container, { rowsCurrent, rowsPrior, ourTeamByDemoId }) {
  if (!container) return
  const ourCur = ourRows(rowsCurrent, ourTeamByDemoId)
  if (ourCur.length === 0) {
    container.innerHTML = ''
    return
  }
  const ourPrior = ourRows(rowsPrior, ourTeamByDemoId)
  const current = aggregateTeamStats(ourCur)
  const prior   = aggregateTeamStats(ourPrior)
  const view    = computeDeltas(current, prior)
  const tiles   = tileDescriptors(view).map(renderTile).join('')

  container.innerHTML = `
    <div class="rr-team-stats">
      <div class="rr-section-label">TEAM STATS</div>
      <div class="rr-team-stats-grid">${tiles}</div>
    </div>
  `
}
