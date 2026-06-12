// cs2-hub/vods-team-stats.js
//
// Renders the Key Tactical Stats section — a 2x3 grid of the six highest-
// priority team metrics. Secondary metrics live in the collapsible Advanced
// Team Analytics section (see vods-team-stats-advanced.js).
//
// Each tile: small label, large value, mini trend chip, progress bar.
// Force-buy is a special-case (wins–losses only, no pct/bar/trend) because
// sample sizes are too small for a meaningful rate.

import { aggregateTeamStats, computeDeltas } from './team-stats-aggregate.js'
import { radarSVG } from './charts.js'

const TREND_ARROW = { up: '↑', down: '↓', flat: '▬' }
const DELTA_THRESHOLD = 0.005

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function fmtPct(p) { return p == null ? '—' : `${Math.round(p * 100)}%` }
function fmtWL(wins, played) {
  if (played == null || played === 0) return '—'
  return `${wins}–${played - wins}`
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
  return `<span class="rr-kt-trend rr-trend-${cls}">${TREND_ARROW[cls]} ${sign}${Math.round(delta * 100)}%</span>`
}

function ourRows(rows, ourTeamByDemoId) {
  if (!rows) return []
  return rows.filter(r => {
    const ours = ourTeamByDemoId?.get(r.demo_id)
    return ours && ours === r.team
  })
}

// 2x3 grid of priority tiles. Order = reading order.
function keyTiles(view) {
  return [
    { label: 'Pistol Success', kind: 'pct',   value: view.pistols.value,     delta: view.pistols.delta },
    { label: 'Opening Duels',  kind: 'pct',   value: view.opening_duel.value, delta: view.opening_duel.delta },
    { label: '5v4 Conversion', kind: 'pct',   value: view.five_v_four.value, delta: view.five_v_four.delta },
    { label: 'CT Win Rate',    kind: 'pct',   value: view.ct.value,          delta: view.ct.delta },
    { label: 'T Win Rate',     kind: 'pct',   value: view.t.value,           delta: view.t.delta },
    { label: 'Force-Buy Wins', kind: 'wl',    value: view.force.value },
  ]
}

function renderTile(t) {
  if (t.kind === 'wl') {
    return `
      <div class="rr-kt-tile rr-kt-tile-wl">
        <div class="rr-kt-label">${esc(t.label)}</div>
        <div class="rr-kt-value">${fmtWL(t.value.wins, t.value.played)}</div>
        <div class="rr-kt-bar rr-kt-bar-muted"><span style="width:0%"></span></div>
      </div>`
  }
  const pct = t.value.pct
  const pctNum = pct == null ? 0 : Math.round(pct * 100)
  const valueText = t.value.played != null
    ? (pct == null ? '—' : `${pctNum}%`)
    : fmtPct(pct)
  const sublabel = t.value.played != null
    ? `<span class="rr-kt-sub">${esc(fmtWL(t.value.wins, t.value.played))}</span>`
    : ''
  return `
    <div class="rr-kt-tile">
      <div class="rr-kt-label">${esc(t.label)}${trendChip(t.delta)}</div>
      <div class="rr-kt-value">${valueText} ${sublabel}</div>
      <div class="rr-kt-bar"><span style="width:${pctNum}%"></span></div>
    </div>`
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
  const tiles   = keyTiles(view).map(renderTile).join('')

  const pc = wd => (wd?.value?.played ? Math.round((wd.value.pct ?? 0) * 100) : null)
  const radar = radarSVG([
    { label: 'Pistol',   pct: pc(view.pistols) },
    { label: 'Opening',  pct: view.opening_duel?.value?.pct != null ? Math.round(view.opening_duel.value.pct * 100) : null },
    { label: '5v4',      pct: pc(view.five_v_four) },
    { label: 'Full buy', pct: pc(view.full_buy) },
    { label: 'CT side',  pct: pc(view.ct) },
    { label: 'T side',   pct: pc(view.t) },
  ], { size: 290 })

  container.innerHTML = `
    <div class="rr-key-tactical">
      <div class="rr-section-label">KEY TACTICAL STATS</div>
      <div class="rr-kt-layout">
        <div class="chart-card chart-card-radar">
          <div class="chart-card-title">Team DNA<span class="chart-card-hint">win rate per round type</span></div>
          ${radar}
        </div>
        <div class="rr-key-tactical-grid">${tiles}</div>
      </div>
    </div>
  `
}
