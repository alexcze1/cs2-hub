// cs2-hub/vods-map-pool.js
//
// Map Pool Intelligence — per-map cards with WR, sample, trend, confidence.
// Card click emits CustomEvent('rr:filter-map', { detail: { map: <name|null> }}).
// Clicking the currently-active card emits null (clear filter).

import { computeTrend } from './vods-trend.js'
import { normMap, normName, scoresFromDemo } from './auto-fill-vod.js'

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

// Pick the opponent name from a demo by elimination — whichever of ct/t isn't us.
// Returns null when we can't disambiguate (ourTeamName missing, or neither side
// matches). The demo is then skipped by the caller.
function opponentNameFromDemo(demo, ourTeamName) {
  const us = normName(ourTeamName)
  if (!us) return null
  const ct = (demo.ct_team_name || '').trim()
  const t  = (demo.t_team_name  || '').trim()
  const ctIsUs = !!ct && normName(ct) === us
  const tIsUs  = !!t  && normName(t)  === us
  if (ctIsUs && !tIsUs) return t || null
  if (tIsUs  && !ctIsUs) return ct || null
  return null
}

// Returns rows sorted by plays desc (then WR desc).
//
// unlinkedDemos are demos with no matching vod (and therefore no double-count
// risk). For each, we derive score_us/score_them via scoresFromDemo and key
// on the normalized map name so 'de_ancient' from demos merges with 'ancient'
// from vods.
export function computeMapPool(vods, { unlinkedDemos = [], ourTeamName = '' } = {}) {
  const by = {}

  function add(mapKey, us, them) {
    if (!mapKey) return
    if (!by[mapKey]) by[mapKey] = { map: mapKey, w: 0, l: 0, plays: 0 }
    by[mapKey].plays++
    if (us > them) by[mapKey].w++
    else if (them > us) by[mapKey].l++
  }

  for (const v of vods || []) {
    for (const m of v.maps ?? []) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      add(normMap(m.map) || m.map, us, them)
    }
  }

  for (const d of unlinkedDemos || []) {
    const opp = opponentNameFromDemo(d, ourTeamName)
    if (!opp) continue
    const s = scoresFromDemo(d, opp)
    if (!s) continue
    add(normMap(d.map), s.score_us, s.score_them)
  }

  return Object.values(by)
    .map(r => ({ ...r, wr: pct(r.w, r.w + r.l), confidence: confidenceLabel(r.plays) }))
    .sort((a, b) => b.plays - a.plays || (b.wr ?? -1) - (a.wr ?? -1))
}

export function renderMapPool(root, {
  vodsCurrent,
  vodsPrior,
  activeMap,
  unlinkedDemosCurrent = [],
  unlinkedDemosPrior = [],
  ourTeamName = '',
}) {
  const rows  = computeMapPool(vodsCurrent || [], { unlinkedDemos: unlinkedDemosCurrent, ourTeamName })
  const prior = computeMapPool(vodsPrior   || [], { unlinkedDemos: unlinkedDemosPrior,   ourTeamName })
  const priorByMap = new Map(prior.map(r => [r.map, r]))

  if (rows.length === 0) {
    root.innerHTML = `<div class="rr-section-label">MAP POOL INTELLIGENCE</div>
      <div class="rr-empty">No map data yet.</div>`
    return
  }

  const cards = rows.map(r => {
    const trend = computeTrend(r.wr, priorByMap.get(r.map)?.wr ?? null, TREND_THRESHOLD_PCT)
    const isActive = r.map === activeMap
    const confClass = r.confidence === 'HIGH' ? 'rr-conf-high' :
                      r.confidence === 'MEDIUM' ? 'rr-conf-med' : 'rr-conf-low'
    const wr = r.wr == null ? 0 : r.wr
    const wrLabel = r.wr == null ? '—' : `${r.wr}%`
    const barClass = r.wr == null ? 'rr-map-bar-empty'
                    : r.wr >= 60 ? 'rr-map-bar-good'
                    : r.wr >= 40 ? 'rr-map-bar-mid'
                    : 'rr-map-bar-bad'
    return `
      <button type="button"
              class="rr-map-card ${isActive ? 'is-active' : ''}"
              data-map="${esc(r.map)}"
              data-trend="${trend}">
        <div class="rr-map-card-head">
          <span class="rr-map-card-name">${esc(capitalize(r.map))}</span>
          <span class="rr-map-card-trend rr-trend-${trend}">${TREND_ARROW[trend] || ''}</span>
        </div>
        <div class="rr-map-card-wr">${wrLabel}</div>
        <div class="rr-map-card-meta">
          <span>${r.plays} match${r.plays === 1 ? '' : 'es'}</span>
          <span class="rr-map-dot">·</span>
          <span class="rr-map-card-conf ${confClass}">${r.confidence}</span>
        </div>
        <div class="rr-map-card-bar"><span class="${barClass}" style="width:${wr}%"></span></div>
      </button>`
  }).join('')

  root.innerHTML = `
    <div class="rr-section-label">MAP POOL INTELLIGENCE</div>
    <div class="rr-map-cards">${cards}</div>`

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
