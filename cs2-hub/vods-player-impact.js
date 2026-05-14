// cs2-hub/vods-player-impact.js
//
// Renders the role-coded player grid for Results & Review. One card per
// non-staff roster member. Click → onPick(player) (caller opens drawer).

import { aggregatePlayer } from './roster-stats-aggregate.js'
import { computeTrend } from './vods-trend.js'

const STAFF_ROLES = new Set(['Coach', 'Manager', 'Bench', 'Unassigned'])
const ROLE_ORDER  = { IGL: 0, Entry: 1, AWPer: 2, Lurker: 3, Support: 4 }
const TREND_THRESHOLD = 0.03

const ROLE_COLOR_MAP = {
  IGL:     'var(--warning)',
  Entry:   'var(--danger)',
  AWPer:   'var(--special)',
  Support: 'var(--accent)',
  Lurker:  'var(--role-lurker)',
}
export function roleColorVar(role) {
  return ROLE_COLOR_MAP[role] ?? 'var(--muted)'
}

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function fmt(n, dec = 2) { return n == null ? '—' : Number(n).toFixed(dec) }
function fmtPct(p) { return p == null ? '—' : `${Math.round(p * 100)}%` }
function fmtKD(kd) { return kd == null ? '—' : !isFinite(kd) ? '∞' : kd.toFixed(2) }
const TREND_ARROW = { up: '↗', down: '↘', flat: '▬', unknown: '' }

function rowsBySteamId(rows) {
  const m = new Map()
  for (const r of rows || []) {
    if (!r.steam_id) continue
    if (!m.has(r.steam_id)) m.set(r.steam_id, [])
    m.get(r.steam_id).push(r)
  }
  return m
}

// Two supporting metrics per role.
function supportingMetrics(role, agg) {
  const openTotal = (agg.opening_kills || 0) + (agg.opening_deaths || 0)
  const openPct = openTotal > 0 ? agg.opening_kills / openTotal : null
  const clutchTotal = (agg.clutches_won || 0) + (agg.clutches_lost || 0)
  const clutchPct = clutchTotal > 0 ? agg.clutches_won / clutchTotal : null

  switch (role) {
    case 'IGL':     return [['KAST', fmtPct(agg.kast_pct)], ['Util/r', fmt(agg.utility_dmg_per_round, 1)]]
    case 'Entry':   return [['Open %', fmtPct(openPct)], ['K/D', fmtKD(agg.kd)]]
    case 'AWPer':   return [['Open %', fmtPct(openPct)], ['KAST', fmtPct(agg.kast_pct)]]
    case 'Support': return [['Util/r', fmt(agg.utility_dmg_per_round, 1)], ['KAST', fmtPct(agg.kast_pct)]]
    case 'Lurker':  return [['Clutch %', fmtPct(clutchPct)], ['K/D', fmtKD(agg.kd)]]
    default:        return [['K/D', fmtKD(agg.kd)], ['KAST', fmtPct(agg.kast_pct)]]
  }
}

export function renderPlayerImpact(root, { roster, rowsCurrent, rowsPrior, onPick }) {
  const sorted = (roster || [])
    .filter(p => !STAFF_ROLES.has(p.role))
    .sort((a, b) => {
      const ra = ROLE_ORDER[a.role] ?? 99
      const rb = ROLE_ORDER[b.role] ?? 99
      if (ra !== rb) return ra - rb
      return String(a.nickname || '').localeCompare(String(b.nickname || ''))
    })

  if (sorted.length === 0) {
    root.innerHTML = `<div class="rr-section-label">PLAYER IMPACT</div>
      <div class="rr-empty">No players on roster.</div>`
    return
  }

  const curBySid   = rowsBySteamId(rowsCurrent)
  const priorBySid = rowsBySteamId(rowsPrior)

  // Per-player aggregates (current window only).
  const aggCurrent = new Map()
  // Player IDs whose raw rows ALL have impact_rating == null. The shared
  // aggregator coerces null→0, so we track this here and treat impact as
  // null for bar-render purposes downstream.
  const nullImpactIds = new Set()
  for (const p of sorted) {
    if (!p.steam_id) { aggCurrent.set(p.id, null); continue }
    const rows = curBySid.get(p.steam_id) ?? []
    aggCurrent.set(p.id, rows.length ? aggregatePlayer(rows) : null)
    if (rows.length && rows.every(r => r.impact_rating == null)) {
      nullImpactIds.add(p.id)
    }
  }

  // Team min/max impact_rating across players with data — used to normalize bars.
  // Skip players flagged as all-null (their agg.impact_rating is 0 from coercion,
  // not a real value, and would skew normalization).
  let minImp = +Infinity, maxImp = -Infinity
  for (const [pid, agg] of aggCurrent) {
    if (!agg || agg.impact_rating == null) continue
    if (nullImpactIds.has(pid)) continue
    if (agg.impact_rating < minImp) minImp = agg.impact_rating
    if (agg.impact_rating > maxImp) maxImp = agg.impact_rating
  }
  const impSpan = maxImp - minImp

  function impactPct(impact) {
    if (impact == null) return null
    if (impSpan === 0) return 50
    return Math.round(((impact - minImp) / impSpan) * 100)
  }

  const cards = sorted.map(p => {
    const agg = aggCurrent.get(p.id)
    const hasData = !!(agg && agg.matches > 0)

    let trend = 'unknown'
    if (hasData && p.steam_id) {
      const priorRows = priorBySid.get(p.steam_id) ?? []
      const priorAgg = priorRows.length ? aggregatePlayer(priorRows) : null
      trend = computeTrend(agg.rating, priorAgg?.rating ?? null, TREND_THRESHOLD)
    }

    const supports = hasData ? supportingMetrics(p.role, agg) : []
    const effectiveImpact = nullImpactIds.has(p.id) ? null : agg?.impact_rating
    const impPct = hasData ? impactPct(effectiveImpact) : null

    return `
      <button type="button"
              class="rr-player-card ${hasData ? '' : 'rr-player-card-empty'}"
              data-id="${esc(p.id)}"
              data-role="${esc(p.role)}"
              data-trend="${trend}"
              style="--rr-role-color:${roleColorVar(p.role)}">
        <div class="rr-player-name">${esc(p.nickname || '—')}</div>
        <div class="rr-player-role">${esc(p.role || 'Player')}</div>
        <div class="rr-player-rating">
          ${hasData ? fmt(agg.rating) : '—'}
          ${trend !== 'unknown' && hasData ? `<span class="rr-trend rr-trend-${trend}">${TREND_ARROW[trend]}</span>` : ''}
        </div>
        ${hasData ? `
          <div class="rr-player-supports">
            ${supports.map(([k, v]) => `<span class="rr-support"><span class="rr-support-k">${esc(k)}</span> <span class="rr-support-v">${esc(v)}</span></span>`).join('')}
          </div>
        ` : ''}
        ${hasData && impPct != null ? `
          <div class="rr-impact-bar"><div class="rr-impact-fill" style="width:${impPct}%"></div></div>
        ` : ''}
        ${hasData ? '' : '<div class="rr-player-empty-msg">No matches in window</div>'}
      </button>`
  }).join('')

  root.innerHTML = `
    <div class="rr-section-label">PLAYER IMPACT</div>
    <div class="rr-player-grid">${cards}</div>`

  for (const btn of root.querySelectorAll('.rr-player-card')) {
    btn.addEventListener('click', () => {
      const player = sorted.find(p => p.id === btn.dataset.id)
      if (player && typeof onPick === 'function') onPick(player)
    })
  }
}
