// cs2-hub/scoreboard-team-stats.js
//
// Renders the side-by-side Team Stats panel beneath the player tables in
// the demo viewer's Scoreboard tab. Pure render — no fetching, no state.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function pct(wins, played) {
  if (played == null || played === 0) return null
  return wins / played
}

function fmtPct(p) {
  if (p == null) return '—'
  return `${Math.round(p * 100)}%`
}

function fmtWL(wins, played) {
  if (played == null || played === 0) return '—'
  return `${wins}–${played - wins}`
}

// "4–3 (57%)" / "—" if no rounds played
function fmtWLPct(wins, played) {
  const wl = fmtWL(wins, played)
  if (wl === '—') return '—'
  return `${wl} (${fmtPct(pct(wins, played))})`
}

function fmtCount(n) { return n == null ? '—' : String(n) }

// 11 tile definitions. Each one knows how to extract its value from a team row.
// `format` returns the display string for the given side; null rows → '—'.
const TILES = [
  { label: 'Pistols',         format: r => r ? fmtWLPct(r.pistol_wins,      r.pistol_played)     : '—' },
  { label: 'Anti-ecos',       format: r => r ? fmtWLPct(r.anti_eco_wins,    r.anti_eco_played)   : '—' },
  { label: 'Eco wins',        format: r => r ? fmtWLPct(r.eco_wins,         r.eco_played)        : '—' },
  { label: 'Force-buy wins',  format: r => r ? fmtWL(r.force_wins,          r.force_played)      : '—' },
  { label: 'Full-buy wins',   format: r => r ? fmtWLPct(r.full_buy_wins,    r.full_buy_played)   : '—' },
  { label: 'First kills',     format: r => r ? fmtCount(r.first_kills)  : '—' },
  { label: 'First deaths',    format: r => r ? fmtCount(r.first_deaths) : '—' },
  { label: 'Opening duel W%', format: r => {
      if (!r) return '—'
      const total = (r.first_kills || 0) + (r.first_deaths || 0)
      return fmtPct(total > 0 ? r.first_kills / total : null)
    } },
  { label: '5v4 conversion',  format: r => r ? fmtWLPct(r.five_v_four_wins, r.five_v_four_played) : '—' },
  { label: 'CT win rate',     format: r => r ? fmtWLPct(r.ct_round_wins,    r.ct_rounds_played)   : '—' },
  { label: 'T win rate',      format: r => r ? fmtWLPct(r.t_round_wins,     r.t_rounds_played)    : '—' },
]

export function renderTeamStats(container, { teamA, teamB, teamAName, teamBName }) {
  if (!container) return
  if (!teamA && !teamB) {
    container.innerHTML = ''
    return
  }
  const rows = TILES.map(t => `
    <tr>
      <td class="sb-ts-a">${esc(t.format(teamA))}</td>
      <td class="sb-ts-label">${esc(t.label)}</td>
      <td class="sb-ts-b">${esc(t.format(teamB))}</td>
    </tr>
  `).join('')

  container.innerHTML = `
    <div class="sb-team-stats-panel">
      <div class="sb-ts-header">
        <span class="sb-ts-name sb-ts-name-a">${esc(teamAName || 'Team A')}</span>
        <span class="sb-ts-title">Team Stats</span>
        <span class="sb-ts-name sb-ts-name-b">${esc(teamBName || 'Team B')}</span>
      </div>
      <table class="sb-ts-table">
        <tbody>${rows}</tbody>
      </table>
    </div>
  `
}
