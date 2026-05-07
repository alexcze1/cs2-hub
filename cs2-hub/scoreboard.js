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
  container.innerHTML = `<div class="sb-empty">Player tables — Task 15</div>`
}

function renderTeamStats(container, teams) {
  container.innerHTML = `<div class="sb-empty">Team stats — Task 16</div>`
}
