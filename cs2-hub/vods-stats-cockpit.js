// cs2-hub/vods-stats-cockpit.js
//
// One-screen "Team Statistics" cockpit. Consolidates what used to be four
// stacked sections (Key Tactical Stats, Player Impact, Map Pool, Advanced
// Team Analytics) into a single no-scroll bento:
//
//   ┌ Team DNA radar ─┬ Tactical matrix (tabbed) ─┬ Map pool + Form ┐
//   │ round-WR donut  │  Overview / Economy /     │  per-map bars   │
//   │ CT·T side bars  │  Entry / Sides / Clutch /  │  form area      │
//   │                 │  Utility   + player strip  │                 │
//   └─────────────────┴───────────────────────────┴─────────────────┘
//
// Pure render module. The orchestrator (vods.js) owns data + events; this
// file emits the same `rr:filter-map` custom event the old map cards did,
// and calls onPick(player) for the inline drawer.

import { aggregateTeamStats, computeDeltas } from './team-stats-aggregate.js'
import { computeMapPool } from './vods-map-pool.js'
import { aggregatePlayer } from './roster-stats-aggregate.js'
import { computeTrend } from './vods-trend.js'
import { radarSVG, areaSVG, donutSVG } from './charts.js'

const LS_TAB_KEY = 'rr:cockpit-tab:v1'
const DELTA_THRESHOLD = 0.005
const TREND_THRESHOLD = 0.03
const MAP_TREND_THRESHOLD_PCT = 5
const TREND_ARROW = { up: '↑', down: '↓', flat: '▬' }
const PLAYER_ARROW = { up: '↗', down: '↘', flat: '▬', unknown: '' }

const STAFF_ROLES = new Set(['Coach', 'Manager', 'Bench', 'Unassigned'])
const ROLE_ORDER  = { IGL: 0, Entry: 1, AWPer: 2, Lurker: 3, Support: 4 }
const ROLE_COLOR = {
  IGL: 'var(--warning)', Entry: 'var(--danger)', AWPer: 'var(--special)',
  Support: 'var(--accent)', Lurker: 'var(--role-lurker)',
}

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function fmtPct(p) { return p == null ? '—' : `${Math.round(p * 100)}%` }
function fmtNum(n, dec = 1) { return n == null || !isFinite(n) ? '—' : Number(n).toFixed(dec) }
function fmtCount(n) { return n == null ? '—' : String(n) }
function fmtKD(kd) { return kd == null ? '—' : !isFinite(kd) ? '∞' : kd.toFixed(2) }
function fmtWL(wins, played) {
  if (played == null || played === 0) return '—'
  return `${wins}–${played - wins}`
}
function pctNum(p) { return p == null ? 0 : Math.round(p * 100) }

function trendChip(delta) {
  if (delta == null) return ''
  const cls = delta > DELTA_THRESHOLD ? 'up' : delta < -DELTA_THRESHOLD ? 'down' : 'flat'
  const sign = delta > 0 ? '+' : ''
  return `<span class="sc-trend sc-trend-${cls}">${TREND_ARROW[cls]} ${sign}${Math.round(delta * 100)}%</span>`
}

function ourTeamRows(rows, ourTeamByDemoId) {
  if (!rows) return []
  return rows.filter(r => {
    const ours = ourTeamByDemoId?.get(r.demo_id)
    return ours && ours === r.team
  })
}

function sumField(rows, key) {
  let n = 0
  for (const r of rows || []) n += r[key] || 0
  return n
}

function sideOpeningPct(rows, side) {
  const fk = sumField(rows, side === 't' ? 'first_kills_t'  : 'first_kills_ct')
  const fd = sumField(rows, side === 't' ? 'first_deaths_t' : 'first_deaths_ct')
  const total = fk + fd
  return total > 0 ? fk / total : null
}

// Team-level rollup of demo_players (side='all') rows for clutch/utility/trades.
function aggregateTeamPlayers(rows) {
  let deaths = 0, rounds = 0, trades = 0
  let clutchesWon = 0, clutchesLost = 0, utilDmg = 0, flashes = 0
  for (const r of rows || []) {
    deaths       += r.deaths        || 0
    rounds       += r.rounds_played || 0
    trades       += r.traded_deaths || 0
    clutchesWon  += r.clutches_won  || 0
    clutchesLost += r.clutches_lost || 0
    utilDmg      += r.utility_dmg   || 0
    flashes      += r.flash_assists || 0
  }
  const clutchTotal = clutchesWon + clutchesLost
  return {
    deaths, rounds, trades, clutchesWon, clutchesLost, utilDmg, flashes, clutchTotal,
    tradePct: deaths > 0 ? trades / deaths : null,
    clutchPct: clutchTotal > 0 ? clutchesWon / clutchTotal : null,
    utilDmgPerRound: rounds > 0 ? utilDmg / rounds : null,
    flashesPerRound: rounds > 0 ? flashes / rounds : null,
  }
}

// ── Tile builders per tab ───────────────────────────────────────────
// Tile shape: { label, value, sub?, pct?, delta?, tone? }
function overviewTiles(view) {
  const p = (wd, label) => ({
    label,
    value: wd.value.pct == null ? '—' : `${pctNum(wd.value.pct)}%`,
    sub: wd.value.played != null ? fmtWL(wd.value.wins, wd.value.played) : null,
    pct: pctNum(wd.value.pct),
    delta: wd.delta,
  })
  return [
    p(view.pistols, 'Pistols'),
    p(view.opening_duel, 'Opening'),
    p(view.five_v_four, '5v4 Conv'),
    p(view.full_buy, 'Full buy'),
    p(view.ct, 'CT side'),
    p(view.t, 'T side'),
  ]
}

function economyTiles(agg) {
  const p = (a, label) => ({ label, value: fmtPct(a.pct), sub: fmtWL(a.wins, a.played), pct: pctNum(a.pct) })
  return [
    p(agg.hard_eco, 'Hard eco'),
    p(agg.eco, 'Eco'),
    p(agg.force, 'Force buy'),
    p(agg.half_buy, 'Half buy'),
    p(agg.full_buy, 'Full buy'),
    p(agg.anti_ecos, 'Anti-eco'),
    p(agg.anti_force, 'Anti-force'),
  ]
}

function entryTiles(agg, playerAgg) {
  return [
    { label: 'First kills',  value: fmtCount(agg.first_kills) },
    { label: 'First deaths', value: fmtCount(agg.first_deaths) },
    { label: 'Opening duel', value: fmtPct(agg.opening_duel.pct), pct: pctNum(agg.opening_duel.pct) },
    { label: 'Trade %',      value: fmtPct(playerAgg.tradePct),
      sub: playerAgg.deaths > 0 ? `${playerAgg.trades}/${playerAgg.deaths}` : null,
      pct: pctNum(playerAgg.tradePct) },
  ]
}

function sidesTiles(agg, ourTSRows) {
  return [
    { label: 'CT win rate',  value: fmtPct(agg.ct.pct), sub: fmtWL(agg.ct.wins, agg.ct.played), pct: pctNum(agg.ct.pct), tone: 'ct' },
    { label: 'T win rate',   value: fmtPct(agg.t.pct),  sub: fmtWL(agg.t.wins, agg.t.played),   pct: pctNum(agg.t.pct),  tone: 't' },
    { label: 'CT opening',   value: fmtPct(sideOpeningPct(ourTSRows, 'ct')), pct: pctNum(sideOpeningPct(ourTSRows, 'ct')), tone: 'ct' },
    { label: 'T opening',    value: fmtPct(sideOpeningPct(ourTSRows, 't')),  pct: pctNum(sideOpeningPct(ourTSRows, 't')),  tone: 't' },
  ]
}

function clutchTiles(playerAgg) {
  return [
    { label: 'Clutch win %', value: fmtPct(playerAgg.clutchPct),
      sub: playerAgg.clutchTotal > 0 ? `${playerAgg.clutchesWon}/${playerAgg.clutchTotal}` : null,
      pct: pctNum(playerAgg.clutchPct) },
    { label: 'Clutches won',  value: fmtCount(playerAgg.clutchesWon) },
    { label: 'Clutches lost', value: fmtCount(playerAgg.clutchesLost) },
  ]
}

function utilityTiles(playerAgg) {
  return [
    { label: 'Util dmg / rd',   value: fmtNum(playerAgg.utilDmgPerRound, 1),
      sub: playerAgg.rounds > 0 ? `${playerAgg.utilDmg} dmg` : null },
    { label: 'Flash / rd',      value: fmtNum(playerAgg.flashesPerRound, 2),
      sub: playerAgg.flashes > 0 ? `${playerAgg.flashes} total` : null },
    { label: 'Trade rate',      value: fmtPct(playerAgg.tradePct),
      sub: playerAgg.deaths > 0 ? `${playerAgg.trades}/${playerAgg.deaths}` : null,
      pct: pctNum(playerAgg.tradePct) },
  ]
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'economy',  label: 'Economy' },
  { key: 'entry',    label: 'Entry' },
  { key: 'sides',    label: 'Sides' },
  { key: 'clutch',   label: 'Clutch' },
  { key: 'utility',  label: 'Utility' },
]

function tilesFor(tab, { view, agg, playerAgg, ourTSRows }) {
  switch (tab) {
    case 'overview': return overviewTiles(view)
    case 'economy':  return economyTiles(agg)
    case 'entry':    return entryTiles(agg, playerAgg)
    case 'sides':    return sidesTiles(agg, ourTSRows)
    case 'clutch':   return clutchTiles(playerAgg)
    case 'utility':  return utilityTiles(playerAgg)
    default:         return []
  }
}

function renderTile(t) {
  const barCls = t.tone === 'ct' ? 'sc-bar-ct' : t.tone === 't' ? 'sc-bar-t' : ''
  const bar = t.pct != null
    ? `<div class="sc-tile-bar"><span class="${barCls}" style="width:${t.pct}%"></span></div>`
    : `<div class="sc-tile-bar sc-tile-bar-ghost"></div>`
  return `
    <div class="sc-tile">
      <div class="sc-tile-label">${esc(t.label)}${t.delta != null ? trendChip(t.delta) : ''}</div>
      <div class="sc-tile-value">${esc(t.value)}${t.sub ? `<span class="sc-tile-sub">${esc(t.sub)}</span>` : ''}</div>
      ${bar}
    </div>`
}

// ── Map thumbnail (graceful fallback to a text badge) ────────────────
const MAP_IMG = { dust2: 'dust' }
function mapThumb(map) {
  const file = MAP_IMG[map] || map
  return `<span class="sc-map-thumb">
    <img src="images/maps/${esc(file)}.png" alt="" loading="lazy"
         onerror="this.style.display='none';this.parentNode.classList.add('sc-map-thumb-fallback');this.parentNode.textContent='${esc(capitalize(map).slice(0,3))}'"/>
  </span>`
}

// ── Player chips ─────────────────────────────────────────────────────
function rowsBySid(rows) {
  const m = new Map()
  for (const r of rows || []) {
    if (!r.steam_id) continue
    if (!m.has(r.steam_id)) m.set(r.steam_id, [])
    m.get(r.steam_id).push(r)
  }
  return m
}

function buildPlayerChips(roster, playerRowsCurrent, playerRowsPrior, activePlayerId) {
  const sorted = (roster || [])
    .filter(p => !STAFF_ROLES.has(p.role))
    .sort((a, b) => {
      const ra = ROLE_ORDER[a.role] ?? 99, rb = ROLE_ORDER[b.role] ?? 99
      if (ra !== rb) return ra - rb
      return String(a.nickname || '').localeCompare(String(b.nickname || ''))
    })
  if (!sorted.length) return '<div class="sc-mini-empty">No players on roster.</div>'

  const curBySid = rowsBySid(playerRowsCurrent)
  const priBySid = rowsBySid(playerRowsPrior)

  return sorted.map(p => {
    const rows = p.steam_id ? (curBySid.get(p.steam_id) ?? []) : []
    const agg  = rows.length ? aggregatePlayer(rows) : null
    const hasData = !!(agg && agg.matches > 0)
    let trend = 'unknown'
    if (hasData && p.steam_id) {
      const pr = priBySid.get(p.steam_id) ?? []
      const prAgg = pr.length ? aggregatePlayer(pr) : null
      trend = computeTrend(agg.rating, prAgg?.rating ?? null, TREND_THRESHOLD)
    }
    const color = ROLE_COLOR[p.role] ?? 'var(--muted)'
    const active = activePlayerId && p.id === activePlayerId ? 'is-active' : ''
    return `
      <button type="button" class="sc-player ${hasData ? '' : 'sc-player-empty'} ${active}"
              data-id="${esc(p.id)}" style="--sc-role:${color}">
        <span class="sc-player-top">
          <span class="sc-player-name">${esc(p.nickname || '—')}</span>
          <span class="sc-player-rating">${hasData ? agg.rating.toFixed(2) : '—'}${trend !== 'unknown' && hasData ? `<i class="sc-ptrend sc-ptrend-${trend}">${PLAYER_ARROW[trend]}</i>` : ''}</span>
        </span>
        <span class="sc-player-bot">
          <span class="sc-player-role">${esc(p.role || 'Player')}</span>
          <span class="sc-player-kd">${hasData ? `${fmtKD(agg.kd)} K/D` : 'no data'}</span>
        </span>
      </button>`
  }).join('')
}

// ── Form trend points (chronological, per-match round WR) ────────────
function formPoints(vods) {
  return [...(vods || [])]
    .filter(v => (v.maps ?? []).length && v.match_date)
    .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)))
    .slice(-12)
    .map(v => {
      let rw = 0, rl = 0, mw = 0, ml = 0
      for (const m of v.maps) {
        rw += m.score_us ?? 0; rl += m.score_them ?? 0
        if ((m.score_us ?? 0) > (m.score_them ?? 0)) mw++
        else if ((m.score_them ?? 0) > (m.score_us ?? 0)) ml++
      }
      const total = rw + rl
      const d = new Date(v.match_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      return {
        v: total ? Math.round((rw / total) * 100) : 0,
        label: `${v.opponent ?? 'Match'} · ${d}`,
        tone: mw > ml ? 'good' : ml > mw ? 'bad' : undefined,
      }
    })
}

// ── Map bars ─────────────────────────────────────────────────────────
function buildMapBars(rows, priorByMap, activeMap) {
  if (!rows.length) return '<div class="sc-mini-empty">No map data in window.</div>'
  return rows.map(r => {
    const trend = computeTrend(r.wr, priorByMap.get(r.map)?.wr ?? null, MAP_TREND_THRESHOLD_PCT)
    const wr = r.wr == null ? 0 : r.wr
    const wrLabel = r.wr == null ? '—' : `${r.wr}%`
    const barCls = r.wr == null ? 'sc-map-bar-empty'
      : r.wr >= 60 ? 'sc-map-bar-good' : r.wr >= 40 ? 'sc-map-bar-mid' : 'sc-map-bar-bad'
    const active = r.map === activeMap ? 'is-active' : ''
    const arrow = PLAYER_ARROW[trend] || ''
    return `
      <button type="button" class="sc-map-row ${active}" data-map="${esc(r.map)}">
        ${mapThumb(r.map)}
        <span class="sc-map-info">
          <span class="sc-map-name">${esc(capitalize(r.map))} ${arrow ? `<i class="sc-ptrend sc-ptrend-${trend}">${arrow}</i>` : ''}</span>
          <span class="sc-map-track"><span class="${barCls}" style="width:${wr}%"></span></span>
        </span>
        <span class="sc-map-stat">
          <span class="sc-map-wr">${wrLabel}</span>
          <span class="sc-map-plays">${r.plays} ${r.plays === 1 ? 'game' : 'games'}</span>
        </span>
      </button>`
  }).join('')
}

export function renderStatsCockpit(container, {
  teamStatsCurrent, teamStatsPrior, ourTeamByDemoId,
  playerRowsCurrent, playerRowsPrior,
  vodsCurrent, vodsPrior, unlinkedDemosCurrent = [], unlinkedDemosPrior = [], ourTeamName = '',
  activeMap = null,
  roster = [], onPick, activePlayerId = null,
}) {
  if (!container) return

  const ourTSCur = ourTeamRows(teamStatsCurrent, ourTeamByDemoId)
  const ourTSPri = ourTeamRows(teamStatsPrior, ourTeamByDemoId)

  const mapRows = computeMapPool(vodsCurrent || [], { unlinkedDemos: unlinkedDemosCurrent, ourTeamName })
  const priorMapRows = computeMapPool(vodsPrior || [], { unlinkedDemos: unlinkedDemosPrior, ourTeamName })
  const priorByMap = new Map(priorMapRows.map(r => [r.map, r]))

  const hasTeamStats = ourTSCur.length > 0
  const hasPlayers   = (playerRowsCurrent || []).length > 0
  const hasMaps      = mapRows.length > 0

  if (!hasTeamStats && !hasPlayers && !hasMaps) {
    container.innerHTML = `
      <div class="sc-cockpit-empty empty-state-art">
        <div class="empty-state-art-icon">·</div>
        <div class="empty-state-art-title">No statistics in this window</div>
        <div class="empty-state-art-sub">Log matches with map scores, or upload demos and assign your side, and the full team dashboard draws itself here — no scrolling required.</div>
        <a href="vod-detail.html" class="empty-state-art-cta">Add a match →</a>
      </div>`
    return
  }

  const agg = aggregateTeamStats(ourTSCur)
  const pri = aggregateTeamStats(ourTSPri)
  const view = computeDeltas(agg, pri)
  const playerAgg = aggregateTeamPlayers(playerRowsCurrent)
  const tileCtx = { view, agg, playerAgg, ourTSRows: ourTSCur }

  // Radar
  const radar = radarSVG([
    { label: 'Pistol',   pct: agg.pistols.played ? pctNum(agg.pistols.pct) : null },
    { label: 'Opening',  pct: agg.opening_duel.pct != null ? pctNum(agg.opening_duel.pct) : null },
    { label: '5v4',      pct: agg.five_v_four.played ? pctNum(agg.five_v_four.pct) : null },
    { label: 'Full buy', pct: agg.full_buy.played ? pctNum(agg.full_buy.pct) : null },
    { label: 'CT side',  pct: agg.ct.played ? pctNum(agg.ct.pct) : null },
    { label: 'T side',   pct: agg.t.played ? pctNum(agg.t.pct) : null },
  ], { size: 240 })

  // Round WR donut
  const rw = (agg.ct.wins || 0) + (agg.t.wins || 0)
  const rTotal = (agg.ct.played || 0) + (agg.t.played || 0)
  const roundWR = rTotal ? Math.round((rw / rTotal) * 100) : null
  const wrTone = roundWR == null ? '' : roundWR >= 52 ? 'good' : roundWR <= 47 ? 'bad' : 'warn'
  const donut = donutSVG(roundWR, { size: 104, sublabel: 'ROUND WR', tone: wrTone })

  // CT / T side gauges
  const ctPct = pctNum(agg.ct.pct), tPct = pctNum(agg.t.pct)
  const sideBars = `
    <div class="sc-side-bars">
      <div class="sc-side-row">
        <span class="sc-side-k sc-side-k-ct">CT</span>
        <span class="sc-side-track"><span class="sc-bar-ct" style="width:${ctPct}%"></span></span>
        <span class="sc-side-v">${agg.ct.played ? `${ctPct}%` : '—'}</span>
      </div>
      <div class="sc-side-row">
        <span class="sc-side-k sc-side-k-t">T</span>
        <span class="sc-side-track"><span class="sc-bar-t" style="width:${tPct}%"></span></span>
        <span class="sc-side-v">${agg.t.played ? `${tPct}%` : '—'}</span>
      </div>
    </div>`

  // Form
  const fpts = formPoints(vodsCurrent)
  const formChart = fpts.length >= 2
    ? areaSVG(fpts, { width: 320, height: 116 })
    : `<div class="sc-mini-empty">Log 2+ matches with scores to draw your form line.</div>`

  // Tabs state
  let activeTab = 'overview'
  try { const v = localStorage.getItem(LS_TAB_KEY); if (TABS.some(t => t.key === v)) activeTab = v } catch {}

  const radarBlock = hasTeamStats
    ? `${radar}
       <div class="sc-radar-foot">
         <div class="sc-donut-wrap">${donut}</div>
         ${sideBars}
       </div>`
    : `<div class="sc-mini-empty sc-radar-empty">Upload demos and assign your side to unlock round-type analytics.</div>`

  const tabsHtml = TABS.map(t =>
    `<button type="button" class="sc-tab ${t.key === activeTab ? 'is-active' : ''}" data-tab="${t.key}">${t.label}</button>`
  ).join('')

  const matrixHtml = hasTeamStats || hasPlayers
    ? tilesFor(activeTab, tileCtx).map(renderTile).join('')
    : ''

  container.innerHTML = `
    <div class="sc-cockpit">
      <!-- Column 1 · Identity -->
      <section class="sc-panel sc-col-identity">
        <div class="sc-panel-title">Team DNA<span class="sc-panel-hint">win rate by round type</span></div>
        <div class="sc-radar-wrap">${radarBlock}</div>
      </section>

      <!-- Column 2 · Tactical matrix + players -->
      <section class="sc-panel sc-col-matrix">
        <div class="sc-matrix-head">
          <div class="sc-panel-title">Tactical Breakdown</div>
          <div class="sc-tabs" role="tablist">${tabsHtml}</div>
        </div>
        <div class="sc-matrix-grid" id="sc-matrix-grid">${matrixHtml}</div>
        <div class="sc-players-block">
          <div class="sc-panel-title sc-players-title">Player Impact<span class="sc-panel-hint">click to expand</span></div>
          <div class="sc-player-strip" id="sc-player-strip">${buildPlayerChips(roster, playerRowsCurrent, playerRowsPrior, activePlayerId)}</div>
        </div>
      </section>

      <!-- Column 3 · Maps + form -->
      <section class="sc-panel sc-col-maps">
        <div class="sc-panel-title">Map Pool<span class="sc-panel-hint">click to filter log</span></div>
        <div class="sc-map-list" id="sc-map-list">${buildMapBars(mapRows, priorByMap, activeMap)}</div>
        <div class="sc-form-block">
          <div class="sc-panel-title">Form<span class="sc-panel-hint">round WR · last ${fpts.length || 0}</span></div>
          <div class="sc-form-chart">${formChart}</div>
        </div>
      </section>
    </div>`

  // ── Wire tabs (swap only the matrix grid) ──
  const grid = container.querySelector('#sc-matrix-grid')
  for (const btn of container.querySelectorAll('.sc-tab')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === activeTab) return
      activeTab = btn.dataset.tab
      try { localStorage.setItem(LS_TAB_KEY, activeTab) } catch {}
      for (const b of container.querySelectorAll('.sc-tab')) b.classList.toggle('is-active', b.dataset.tab === activeTab)
      grid.innerHTML = tilesFor(activeTab, tileCtx).map(renderTile).join('')
    })
  }

  // ── Wire map filter ──
  for (const el of container.querySelectorAll('[data-map]')) {
    el.addEventListener('click', () => {
      const next = el.classList.contains('is-active') ? null : el.dataset.map
      container.dispatchEvent(new CustomEvent('rr:filter-map', { bubbles: true, detail: { map: next } }))
    })
  }

  // ── Wire player chips ──
  for (const btn of container.querySelectorAll('.sc-player')) {
    btn.addEventListener('click', () => {
      const player = (roster || []).find(p => p.id === btn.dataset.id)
      if (player && typeof onPick === 'function') onPick(player)
    })
  }
}
