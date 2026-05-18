// cs2-hub/vods-team-stats-advanced.js
//
// Collapsible "Advanced Team Analytics" section. Five tabs: Economy, Entry,
// Sides, Clutch, Utility. Collapsed by default. Open state + active tab
// persisted to localStorage.
//
// Pulls from two sources:
//   • demo_team_stats rows  → Economy, Entry (FK/FD/Opening), Sides
//   • demo_players rows     → Entry (Trade %), Clutch, Utility

import { aggregateTeamStats } from './team-stats-aggregate.js'

const LS_KEY = 'rr:advanced:v1'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function fmtPct(p) { return p == null ? '—' : `${Math.round(p * 100)}%` }
function fmtNum(n, dec = 1) { return n == null || !isFinite(n) ? '—' : Number(n).toFixed(dec) }
function fmtCount(n) { return n == null ? '—' : String(n) }
function fmtWL(wins, played) {
  if (played == null || played === 0) return '—'
  return `${wins}–${played - wins}`
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { open: false, tab: 'economy' }
    const p = JSON.parse(raw)
    return {
      open: !!p.open,
      tab: ['economy', 'entry', 'sides', 'clutch', 'utility'].includes(p.tab) ? p.tab : 'economy',
    }
  } catch {
    return { open: false, tab: 'economy' }
  }
}

function saveState(state) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)) } catch {}
}

// Sum rows across "our team" filter for demo_team_stats.
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

// Per-side opening duel %: first_kills_X / (first_kills_X + first_deaths_X).
function sideOpeningPct(rows, side) {
  const fk = sumField(rows, side === 't' ? 'first_kills_t'  : 'first_kills_ct')
  const fd = sumField(rows, side === 't' ? 'first_deaths_t' : 'first_deaths_ct')
  const total = fk + fd
  return total > 0 ? fk / total : null
}

// Team-aggregate stats from demo_players (side='all') rows.
// Caller passes already-filtered "our roster" rows (single side rollup).
function aggregateTeamPlayers(rows) {
  let kills = 0, deaths = 0, rounds = 0
  let trades = 0, clutchesWon = 0, clutchesLost = 0
  let utilDmg = 0, flashes = 0
  for (const r of rows || []) {
    kills        += r.kills          || 0
    deaths       += r.deaths         || 0
    rounds       += r.rounds_played  || 0
    trades       += r.traded_deaths  || 0
    clutchesWon  += r.clutches_won   || 0
    clutchesLost += r.clutches_lost  || 0
    utilDmg      += r.utility_dmg    || 0
    flashes      += r.flash_assists  || 0
  }
  return {
    kills, deaths, rounds, trades,
    clutchesWon, clutchesLost,
    utilDmg, flashes,
    tradePct: deaths > 0 ? trades / deaths : null,
    clutchPct: (clutchesWon + clutchesLost) > 0
      ? clutchesWon / (clutchesWon + clutchesLost) : null,
    utilDmgPerRound: rounds > 0 ? utilDmg / rounds : null,
    flashesPerRound: rounds > 0 ? flashes / rounds : null,
  }
}

// Tile shape: { label, value (string), sub (string|null) }
function economyTiles(view) {
  return [
    { label: 'Eco wins',     value: fmtPct(view.eco.pct),       sub: fmtWL(view.eco.wins, view.eco.played) },
    { label: 'Force buy',    value: fmtWL(view.force.wins, view.force.played), sub: null },
    { label: 'Anti-eco',     value: fmtPct(view.anti_ecos.pct), sub: fmtWL(view.anti_ecos.wins, view.anti_ecos.played) },
    { label: 'Full buy',     value: fmtPct(view.full_buy.pct),  sub: fmtWL(view.full_buy.wins, view.full_buy.played) },
  ]
}

function entryTiles(view, playerAgg) {
  return [
    { label: 'First kills',  value: fmtCount(view.first_kills),  sub: null },
    { label: 'First deaths', value: fmtCount(view.first_deaths), sub: null },
    { label: 'Opening duel', value: fmtPct(view.opening_duel.pct), sub: null },
    { label: 'Trade %',      value: fmtPct(playerAgg.tradePct),
      sub: playerAgg.deaths > 0 ? `${playerAgg.trades}/${playerAgg.deaths}` : null },
  ]
}

function sidesTiles(view, ourRows) {
  return [
    { label: 'CT win rate',     value: fmtPct(view.ct.pct), sub: fmtWL(view.ct.wins, view.ct.played) },
    { label: 'T win rate',      value: fmtPct(view.t.pct),  sub: fmtWL(view.t.wins, view.t.played) },
    { label: 'CT opening duel', value: fmtPct(sideOpeningPct(ourRows, 'ct')), sub: null },
    { label: 'T opening duel',  value: fmtPct(sideOpeningPct(ourRows, 't')),  sub: null },
  ]
}

function clutchTiles(playerAgg) {
  const total = playerAgg.clutchesWon + playerAgg.clutchesLost
  return [
    { label: 'Clutch win rate', value: fmtPct(playerAgg.clutchPct),
      sub: total > 0 ? `${playerAgg.clutchesWon}/${total}` : null },
    { label: 'Clutches won',    value: fmtCount(playerAgg.clutchesWon), sub: null },
    { label: 'Clutches lost',   value: fmtCount(playerAgg.clutchesLost), sub: null },
  ]
}

function utilityTiles(playerAgg) {
  return [
    { label: 'Util dmg / round',    value: fmtNum(playerAgg.utilDmgPerRound, 1),
      sub: playerAgg.rounds > 0 ? `${playerAgg.utilDmg} dmg` : null },
    { label: 'Flash assists / round', value: fmtNum(playerAgg.flashesPerRound, 2),
      sub: playerAgg.flashes > 0 ? `${playerAgg.flashes} total` : null },
    { label: 'Trade rate',          value: fmtPct(playerAgg.tradePct),
      sub: playerAgg.deaths > 0 ? `${playerAgg.trades}/${playerAgg.deaths}` : null },
  ]
}

function renderTile(t) {
  return `
    <div class="rr-adv-tile">
      <div class="rr-adv-tile-label">${esc(t.label)}</div>
      <div class="rr-adv-tile-value">${esc(t.value)}</div>
      ${t.sub ? `<div class="rr-adv-tile-sub">${esc(t.sub)}</div>` : ''}
    </div>`
}

function tilesForTab(tab, view, playerAgg, ourTSRows) {
  switch (tab) {
    case 'economy': return economyTiles(view)
    case 'entry':   return entryTiles(view, playerAgg)
    case 'sides':   return sidesTiles(view, ourTSRows)
    case 'clutch':  return clutchTiles(playerAgg)
    case 'utility': return utilityTiles(playerAgg)
    default:        return []
  }
}

const TABS = [
  { key: 'economy', label: 'Economy' },
  { key: 'entry',   label: 'Entry' },
  { key: 'sides',   label: 'Sides' },
  { key: 'clutch',  label: 'Clutch' },
  { key: 'utility', label: 'Utility' },
]

export function renderAdvancedTeamStats(container, { teamStatsRows, playerRowsAll, ourTeamByDemoId }) {
  if (!container) return
  const ourTSRows = ourTeamRows(teamStatsRows, ourTeamByDemoId)
  // demo_players rowsAll are already roster-filtered upstream; keep as-is.
  if (ourTSRows.length === 0 && (!playerRowsAll || playerRowsAll.length === 0)) {
    container.innerHTML = ''
    return
  }

  let state = loadState()
  const view = aggregateTeamStats(ourTSRows)
  // computeDeltas adds wrappers — we only need raw value shapes here, so use
  // the aggregate directly (wrapped to match tile readers).
  const flatView = {
    pistols:     view.pistols,
    eco:         view.eco,
    force:       view.force,
    anti_ecos:   view.anti_ecos,
    full_buy:    view.full_buy,
    five_v_four: view.five_v_four,
    first_kills: view.first_kills,
    first_deaths: view.first_deaths,
    opening_duel: view.opening_duel,
    ct:          view.ct,
    t:           view.t,
  }
  const playerAgg = aggregateTeamPlayers(playerRowsAll)

  function render() {
    const tiles = tilesForTab(state.tab, flatView, playerAgg, ourTSRows).map(renderTile).join('')
    const tabHtml = TABS.map(tab => `
      <button type="button"
              class="rr-adv-tab ${state.tab === tab.key ? 'is-active' : ''}"
              data-tab="${tab.key}">${tab.label}</button>
    `).join('')

    container.innerHTML = `
      <div class="rr-adv ${state.open ? 'is-open' : ''}">
        <button type="button" class="rr-adv-header" aria-expanded="${state.open}">
          <span class="rr-adv-chevron">▾</span>
          <span class="rr-adv-title">Advanced Team Analytics</span>
        </button>
        <div class="rr-adv-body">
          <div class="rr-adv-tabs">${tabHtml}</div>
          <div class="rr-adv-grid">${tiles}</div>
        </div>
      </div>
    `

    container.querySelector('.rr-adv-header').addEventListener('click', () => {
      state = { ...state, open: !state.open }
      saveState(state)
      render()
    })
    for (const btn of container.querySelectorAll('.rr-adv-tab')) {
      btn.addEventListener('click', () => {
        if (state.tab === btn.dataset.tab) return
        state = { ...state, tab: btn.dataset.tab }
        saveState(state)
        render()
      })
    }
  }
  render()
}
