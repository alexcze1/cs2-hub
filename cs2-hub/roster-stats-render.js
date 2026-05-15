// cs2-hub/roster-stats-render.js
//
// Builds the HTML body for a single player's panel. Pure functions —
// caller fetches data and passes pre-filtered rows. Uses the R&R
// tactical design language (rr-pd-* classes).

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
    return `<div class="rr-pd-empty">
      <div class="rr-pd-empty-msg">No matches in selected window.</div>
      <button type="button" id="pd-view-alltime" class="rr-pd-empty-cta">View all-time</button>
    </div>`
  }

  // Side splits: CT (blue) / T (orange) / K/D (neutral)
  const splits = `
    <div class="rr-pd-splits">
      <div class="rr-pd-split rr-pd-split-ct">
        <div class="rr-pd-split-k">CT Rating</div>
        <div class="rr-pd-split-v">${fmt(ct.rating)}</div>
      </div>
      <div class="rr-pd-split rr-pd-split-t">
        <div class="rr-pd-split-k">T Rating</div>
        <div class="rr-pd-split-v">${fmt(t.rating)}</div>
      </div>
      <div class="rr-pd-split rr-pd-split-kd">
        <div class="rr-pd-split-k">K/D</div>
        <div class="rr-pd-split-v">${fmtKD(all.kd)}</div>
      </div>
    </div>`

  // Headline (5 tiles)
  const headline = `
    <div class="rr-pd-label">Headline</div>
    <div class="rr-pd-tiles rr-pd-tiles-5">
      ${tile('Rating',  fmt(all.rating),  { highlight: true })}
      ${tile('ADR',     fmt(all.adr, 1))}
      ${tile('KAST',    fmtPct(all.kast_pct))}
      ${tile('HS%',     fmtPct(all.hs_pct))}
      ${tile('Impact',  fmt(all.impact_rating))}
    </div>`

  // Opening Duels: bar + raw counts
  const openTotal = (all.opening_kills || 0) + (all.opening_deaths || 0)
  const openPct   = openTotal > 0 ? all.opening_kills / openTotal : null
  const openBarW  = openPct == null ? 0 : Math.round(openPct * 100)
  const opening = `
    <div class="rr-pd-label">Opening Duels</div>
    <div class="rr-pd-opening">
      <div class="rr-pd-opening-head">
        <span class="rr-pd-opening-label">Win rate</span>
        <span class="rr-pd-opening-pct">${fmtPct(openPct)}</span>
      </div>
      <div class="rr-pd-bar"><div class="rr-pd-bar-fill" style="width:${openBarW}%"></div></div>
      <div class="rr-pd-opening-counts">
        <span><b>${fmtInt(all.opening_kills)}</b> first kills</span>
        <span class="rr-pd-muted">·</span>
        <span><b>${fmtInt(all.opening_deaths)}</b> first deaths</span>
      </div>
    </div>`

  // Clutches & Multi-kills
  const clutches = `
    <div class="rr-pd-label">Clutches &amp; Multi-kills</div>
    <div class="rr-pd-tiles rr-pd-tiles-4">
      ${tile('1vX Won',    fmtInt(all.clutches_won))}
      ${tile('3K',         fmtInt(all.multi_3k))}
      ${tile('4K+',        fmtInt((all.multi_4k || 0) + (all.multi_5k || 0)))}
      ${tile('Util/round', fmt(all.utility_dmg_per_round, 1))}
    </div>`

  // Per map — relative rating bars
  let perMap = ''
  if (maps.length === 0) {
    perMap = `
      <div class="rr-pd-label">Per Map</div>
      <div class="rr-pd-empty-row">No map data.</div>`
  } else {
    const ratings = maps.map(m => m.agg.rating).filter(r => r != null)
    const minR = Math.min(...ratings, 0.6)
    const maxR = Math.max(...ratings, 1.4)
    const span = Math.max(maxR - minR, 0.01)
    const mapRows = maps.map(({ map, agg }) => {
      const r = agg.rating ?? 0
      const w = Math.round(((r - minR) / span) * 100)
      const tone = r >= 1.1 ? 'good' : r >= 0.95 ? 'mid' : 'bad'
      return `
        <div class="rr-pd-map-row">
          <span class="rr-pd-map-name">${esc(capitalize(map))}</span>
          <span class="rr-pd-map-bar"><span class="rr-pd-map-bar-fill rr-pd-map-bar-${tone}" style="width:${Math.max(w, 4)}%"></span></span>
          <span class="rr-pd-map-rating">${fmt(agg.rating)}</span>
          <span class="rr-pd-map-matches">${agg.matches}m</span>
        </div>`
    }).join('')
    perMap = `
      <div class="rr-pd-label">Per Map</div>
      <div class="rr-pd-map-rows">${mapRows}</div>`
  }

  // Recent matches — compact role-coded rows
  let recentSection = ''
  if (!recent || recent.length === 0) {
    recentSection = `
      <div class="rr-pd-label">Recent Matches</div>
      <div class="rr-pd-empty-row">No recent matches.</div>`
  } else {
    const rows = recent.map(r => `
      <a class="rr-pd-recent-row rr-pd-recent-${r.result}" href="vod-detail.html?id=${esc(r.vod_id)}">
        <span class="rr-pd-recent-tag rr-pd-recent-tag-${r.result}">${r.result.toUpperCase()}</span>
        <span class="rr-pd-recent-opp">vs ${esc(r.opponent)}</span>
        <span class="rr-pd-recent-map">${esc(capitalize(r.map))}</span>
        <span class="rr-pd-recent-rating">${fmt(r.rating)}</span>
      </a>`).join('')
    recentSection = `
      <div class="rr-pd-label">Recent Matches</div>
      <div class="rr-pd-recent-rows">${rows}</div>`
  }

  return splits + headline + opening + clutches + perMap + recentSection
}

function tile(label, value, opts = {}) {
  const cls = opts.highlight ? 'rr-pd-tile rr-pd-tile-hl' : 'rr-pd-tile'
  return `<div class="${cls}"><div class="rr-pd-tile-v">${esc(value)}</div><div class="rr-pd-tile-k">${esc(label)}</div></div>`
}

export function buildSubtitle(player, windowKey, matches, rounds) {
  const role = player.role || 'Player'
  return `${role} · ${matches} match${matches === 1 ? '' : 'es'} · ${rounds} round${rounds === 1 ? '' : 's'} · ${windowLabel(windowKey)}`
}
