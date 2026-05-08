// cs2-hub/roster-stats-render.js
//
// Builds the HTML body for a single player's drawer. Pure functions —
// caller fetches data and passes pre-filtered rows.

import { aggregatePlayer, aggregateByMap } from './roster-stats-aggregate.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function fmt(n, d = 2) { return n == null ? '—' : Number(n).toFixed(d) }
function fmtPct(p) { return p == null ? '—' : `${Math.round(p * 100)}%` }
function fmtInt(n) { return n == null ? '—' : String(Math.round(n)) }
function fmtKD(kd) { return kd == null ? '—' : !isFinite(kd) ? '∞' : kd.toFixed(2) }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }

const WINDOW_LABELS = { '10': 'Last 10', '30d': 'Last 30 days', '90d': 'Last 90 days', 'all': 'All time' }
export function windowLabel(w) { return WINDOW_LABELS[w] ?? '' }

// rowsAll  : demo_players rows for THIS player only, side='all', joined to demos.map
// rowsCT   : same player, side='ct'
// rowsT    : same player, side='t'
// recent   : up to 10 demos this player played, in reverse chronological order,
//            each: { vod_id, opponent, map, rating, result }   (pre-resolved by caller)
export function buildPlayerDrawerBody({ rowsAll, rowsCT, rowsT, recent }) {
  const all  = aggregatePlayer(rowsAll)
  const ct   = aggregatePlayer(rowsCT)
  const t    = aggregatePlayer(rowsT)
  const maps = aggregateByMap(rowsAll)

  if (all.matches === 0) {
    return `<div class="pd-empty">
      No matches in selected window.
      <div class="pd-empty-cta"><button type="button" id="pd-view-alltime" class="btn btn-ghost btn-sm">View all-time</button></div>
    </div>`
  }

  // Side splits strip
  const splits = `
    <div class="pd-splits">
      <div class="pd-split-pill"><span class="pd-split-label">CT Rating</span><span class="pd-split-value">${fmt(ct.rating)}</span></div>
      <div class="pd-split-pill"><span class="pd-split-label">T Rating</span><span class="pd-split-value">${fmt(t.rating)}</span></div>
      <div class="pd-split-pill"><span class="pd-split-label">K/D</span><span class="pd-split-value">${fmtKD(all.kd)}</span></div>
    </div>`

  // Headline grid (5)
  const headline = `
    <div class="pd-section-label">Headline</div>
    <div class="pd-grid pd-grid-5">
      ${miniCard('Rating', fmt(all.rating))}
      ${miniCard('ADR', fmt(all.adr, 1))}
      ${miniCard('KAST', fmtPct(all.kast_pct))}
      ${miniCard('HS%', fmtPct(all.hs_pct))}
      ${miniCard('Impact', fmt(all.impact_rating))}
    </div>`

  // Opening duels
  const openTotal = (all.opening_kills || 0) + (all.opening_deaths || 0)
  const openPct = openTotal > 0 ? all.opening_kills / openTotal : null
  const opening = `
    <div class="pd-section-label">Opening Duels</div>
    <div class="pd-grid pd-grid-3">
      ${miniCard('Win %', fmtPct(openPct))}
      ${miniCard('First Kills', fmtInt(all.opening_kills))}
      ${miniCard('First Deaths', fmtInt(all.opening_deaths))}
    </div>`

  // Clutches & multi-kills
  const clutches = `
    <div class="pd-section-label">Clutches &amp; Multi-kills</div>
    <div class="pd-grid pd-grid-4">
      ${miniCard('1vX Won', fmtInt(all.clutches_won))}
      ${miniCard('3K', fmtInt(all.multi_3k))}
      ${miniCard('4K+', fmtInt((all.multi_4k || 0) + (all.multi_5k || 0)))}
      ${miniCard('Util/round', fmt(all.utility_dmg_per_round, 1))}
    </div>`

  // Per-map
  const mapRows = maps.length === 0
    ? `<div class="pd-empty-row">No map data.</div>`
    : maps.map(({ map, agg }) => `
        <div class="pd-row">
          <span class="pd-row-left">${esc(capitalize(map))}</span>
          <span class="pd-row-right">${fmt(agg.rating)} <span class="pd-muted">· ${agg.matches} match${agg.matches === 1 ? '' : 'es'}</span></span>
        </div>`).join('')
  const perMap = `
    <div class="pd-section-label">Per Map</div>
    <div class="pd-rows">${mapRows}</div>`

  // Recent matches
  const recentRows = (recent || []).length === 0
    ? `<div class="pd-empty-row">No recent matches.</div>`
    : recent.map(r => `
        <a class="pd-row pd-row-link" href="vod-detail.html?id=${esc(r.vod_id)}">
          <span class="pd-row-left">vs ${esc(r.opponent)} <span class="pd-muted">· ${esc(capitalize(r.map))}</span></span>
          <span class="pd-row-right">${fmt(r.rating)} <span class="pd-result pd-result-${r.result}">${r.result.toUpperCase()}</span></span>
        </a>`).join('')
  const recentSection = `
    <div class="pd-section-label">Recent Matches</div>
    <div class="pd-rows">${recentRows}</div>`

  return splits + headline + opening + clutches + perMap + recentSection
}

function miniCard(label, value) {
  return `<div class="pd-card"><div class="pd-card-label">${esc(label)}</div><div class="pd-card-value">${esc(value)}</div></div>`
}

export function buildSubtitle(player, windowKey, matches, rounds) {
  const role = player.role || 'Player'
  return `${role} · ${matches} match${matches === 1 ? '' : 'es'} · ${rounds} round${rounds === 1 ? '' : 's'} · ${windowLabel(windowKey)}`
}
