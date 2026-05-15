// cs2-hub/vods-map-pool.js
//
// Map Pool Intelligence table. Per-map: WR, sample, trend, confidence.
// Row click emits CustomEvent('rr:filter-map', { detail: { map: <name|null> }}).
// Clicking the currently-active row emits null (clear filter).

import { computeTrend } from './vods-trend.js'

const TREND_THRESHOLD_PCT = 5
const CONF_HIGH = 8
const CONF_MED  = 4

const TREND_ARROW = { up: '↗', down: '↘', flat: '▬', unknown: '' }

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function pct(n, d) { return d === 0 ? null : Math.round((n / d) * 100) }

export function confidenceLabel(plays) {
  if (plays >= CONF_HIGH) return 'HIGH'
  if (plays >= CONF_MED)  return 'MEDIUM'
  return 'LOW'
}

// Returns rows sorted by plays desc (then WR desc).
export function computeMapPool(vods) {
  const by = {}
  for (const v of vods || []) {
    for (const m of v.maps ?? []) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      if (!by[m.map]) by[m.map] = { map: m.map, w: 0, l: 0, plays: 0 }
      by[m.map].plays++
      if (us > them) by[m.map].w++
      else if (them > us) by[m.map].l++
    }
  }
  return Object.values(by)
    .map(r => ({ ...r, wr: pct(r.w, r.w + r.l), confidence: confidenceLabel(r.plays) }))
    .sort((a, b) => b.plays - a.plays || (b.wr ?? -1) - (a.wr ?? -1))
}

export function renderMapPool(root, { vodsCurrent, vodsPrior, activeMap }) {
  const rows  = computeMapPool(vodsCurrent || [])
  const prior = computeMapPool(vodsPrior   || [])
  const priorByMap = new Map(prior.map(r => [r.map, r]))

  if (rows.length === 0) {
    root.innerHTML = `<div class="rr-section-label">MAP POOL INTELLIGENCE</div>
      <div class="rr-empty">No map data yet.</div>`
    return
  }

  const headerHtml = `
    <div class="rr-map-row rr-map-row-head">
      <div>Map</div><div>WR</div><div>Sample</div><div>Trend</div><div>Confidence</div>
    </div>`
  const bodyHtml = rows.map(r => {
    const trend = computeTrend(r.wr, priorByMap.get(r.map)?.wr ?? null, TREND_THRESHOLD_PCT)
    const isActive = r.map === activeMap
    const confClass = r.confidence === 'HIGH' ? 'rr-conf-high' :
                      r.confidence === 'MEDIUM' ? 'rr-conf-med' : 'rr-conf-low'
    return `
      <div class="rr-map-row ${isActive ? 'is-active' : ''}"
           data-map="${esc(r.map)}"
           data-trend="${trend}">
        <div>${esc(capitalize(r.map))}</div>
        <div>${r.wr == null ? '—' : r.wr + '%'}</div>
        <div>${r.plays} map${r.plays === 1 ? '' : 's'}</div>
        <div class="rr-trend-cell rr-trend-${trend}">${TREND_ARROW[trend] || ''}</div>
        <div class="rr-conf ${confClass}">${r.confidence}</div>
      </div>`
  }).join('')

  root.innerHTML = `
    <div class="rr-section-label">MAP POOL INTELLIGENCE</div>
    <div class="rr-map-table">${headerHtml}${bodyHtml}</div>`

  for (const el of root.querySelectorAll('[data-map]')) {
    el.addEventListener('click', () => {
      const next = el.classList.contains('is-active') ? null : el.dataset.map
      root.dispatchEvent(new CustomEvent('rr:filter-map', {
        bubbles: true,
        detail: { map: next },
      }))
    })
  }
}
