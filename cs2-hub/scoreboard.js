// cs2-hub/scoreboard.js
//
// Loads per-demo player + team stats from Supabase and renders the
// Scoreboard tab inside the demo viewer.

import { supabase } from './supabase.js'

const SIDE_KEY = 'scoreboard:side'

export async function mountScoreboard(root, demoId) {
  if (!root || !demoId) return
  const side = localStorage.getItem(SIDE_KEY) || 'all'

  root.innerHTML = `<div class="sb-loading">Loading stats…</div>`

  try {
    const [{ data: players, error: pe }, { data: teams, error: te }] = await Promise.all([
      supabase.from('demo_players')
        .select('*').eq('demo_id', demoId),
      supabase.from('demo_team_stats')
        .select('*').eq('demo_id', demoId),
    ])
    if (pe) throw pe
    if (te) throw te

    if (!players?.length) {
      root.innerHTML = `<div class="sb-empty">No stats parsed for this demo yet.</div>`
      return
    }

    render(root, { players, teams: teams || [], side, demoId })
  } catch (e) {
    console.error('[scoreboard]', e)
    root.innerHTML = `<div class="sb-empty">Failed to load stats: ${esc(e.message || String(e))}</div>`
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function render(root, state) {
  const { players, teams, side } = state
  root.innerHTML = `
    <div class="sb-toolbar">
      <span class="sb-label">View</span>
      <button class="sb-side-btn ${side==='all'?'is-active':''}" data-side="all">All</button>
      <button class="sb-side-btn ${side==='ct'?'is-active':''}"  data-side="ct">CT</button>
      <button class="sb-side-btn ${side==='t'?'is-active':''}"   data-side="t">T</button>
    </div>
    <div id="sb-tables"></div>
    <div id="sb-team-stats"></div>
  `
  for (const btn of root.querySelectorAll('.sb-side-btn')) {
    btn.addEventListener('click', () => {
      const newSide = btn.dataset.side
      localStorage.setItem(SIDE_KEY, newSide)
      render(root, { ...state, side: newSide })
    })
  }
  renderPlayerTables(root.querySelector('#sb-tables'), players, side)
  renderTeamStats(root.querySelector('#sb-team-stats'), teams)
}

function renderPlayerTables(container, players, side) {
  const filtered = players.filter(p => p.side === side)
  const teamA = filtered.filter(p => p.team === 'a').sort((a, b) => (b.rating || 0) - (a.rating || 0))
  const teamB = filtered.filter(p => p.team === 'b').sort((a, b) => (b.rating || 0) - (a.rating || 0))
  const orphans = filtered.filter(p => p.team !== 'a' && p.team !== 'b')
  const tail = orphans.length ? orphans.sort((a, b) => (b.rating || 0) - (a.rating || 0)) : []

  container.innerHTML = `
    ${teamTable('Your team', 'sb-team-a', teamA)}
    ${teamTable('Opponent',  'sb-team-b', teamB)}
    ${tail.length ? teamTable('Other', 'sb-team-other', tail) : ''}
  `
}

function teamTable(label, cls, rows) {
  if (!rows.length) return ''
  return `
    <div class="sb-team-block ${cls}">
      <div class="sb-team-header">${esc(label)}</div>
      <table class="sb-table">
        <thead>
          <tr>
            <th class="sb-col-name">Player</th>
            <th>K</th><th>D</th><th>A</th><th>+/–</th>
            <th>ADR</th><th>HS%</th><th>KAST</th>
            <th>Multi</th><th>Open</th><th>Clutch</th>
            <th class="sb-col-rating">Rating</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(p => row(p)).join('')}
        </tbody>
      </table>
    </div>
  `
}

function row(p) {
  const plusMinus = (p.kills || 0) - (p.deaths || 0)
  const pmClass = plusMinus > 0 ? 'sb-pos' : plusMinus < 0 ? 'sb-neg' : ''
  return `
    <tr>
      <td class="sb-col-name">${esc(p.name || p.steam_id)}</td>
      <td>${p.kills ?? 0}</td>
      <td>${p.deaths ?? 0}</td>
      <td>${p.assists ?? 0}</td>
      <td class="${pmClass}">${plusMinus > 0 ? '+' : ''}${plusMinus}</td>
      <td>${(p.adr ?? 0).toFixed(1)}</td>
      <td>${pct(p.hs_pct)}</td>
      <td>${pct(p.kast_pct)}</td>
      <td>${p.multi_2k ?? 0}/${p.multi_3k ?? 0}/${p.multi_4k ?? 0}/${p.multi_5k ?? 0}</td>
      <td>${p.opening_kills ?? 0}–${p.opening_deaths ?? 0}</td>
      <td>${p.clutches_won ?? 0}–${p.clutches_lost ?? 0}</td>
      <td class="sb-col-rating">${(p.rating ?? 0).toFixed(2)}</td>
    </tr>
  `
}

function pct(v) {
  if (v == null) return '—'
  return `${Math.round(v * 100)}%`
}

function renderTeamStats(container, teams) {
  container.innerHTML = `<div class="sb-empty">Team stats — Task 16</div>`
}
