// cs2-hub/roster-stats.js
//
// Renders the "Roster · Career Stats" band on Results & Review.
// Cards show name + role + Rating; click opens the player drawer.

import { aggregateByPlayer } from './roster-stats-aggregate.js'

const ROLE_ORDER = { IGL: 0, Entry: 1, AWPer: 2, Lurker: 3, Support: 4 }
const STAFF_ROLES = new Set(['Coach', 'Manager', 'Bench', 'Unassigned'])

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function fmtRating(r) { return r == null ? '—' : r.toFixed(2) }

// Sort roster: role priority first, then nickname.
function sortRoster(roster) {
  return [...roster]
    .filter(p => !STAFF_ROLES.has(p.role))
    .sort((a, b) => {
      const ra = ROLE_ORDER[a.role] ?? 99
      const rb = ROLE_ORDER[b.role] ?? 99
      if (ra !== rb) return ra - rb
      return String(a.nickname || '').localeCompare(String(b.nickname || ''))
    })
}

// roster   : [{ id, nickname, role, steam_id }]
// rows     : array of demo_players rows for the team (already filtered to side='all')
// onPick   : called with the roster row when its card is clicked
export function renderRosterBand(root, { roster, rows, onPick }) {
  const sorted = sortRoster(roster)
  if (!sorted.length) {
    root.innerHTML = `<div class="rb-empty">No players on roster.</div>`
    return
  }

  const aggMap = aggregateByPlayer(rows ?? [])

  root.innerHTML = `<div class="roster-band-grid">${sorted.map(p => {
    const hasSteam = !!p.steam_id
    const agg = hasSteam ? aggMap.get(p.steam_id) : null
    const hasData = !!(agg && agg.matches > 0)

    return `
      <button type="button" class="rb-card ${hasData ? '' : 'rb-card-empty'}" data-action="open" data-id="${esc(p.id)}">
        <div class="rb-name">${esc(p.nickname || '—')}</div>
        <div class="rb-role">${esc(p.role || 'Player')}</div>
        <div class="rb-rating-block">
          <div class="rb-rating-label">Rating</div>
          <div class="rb-rating-value">${hasData ? fmtRating(agg.rating) : '—'}</div>
        </div>
        ${hasData ? '' : `<div class="rb-sub">No matches in window</div>`}
      </button>`
  }).join('')}</div>`

  for (const btn of root.querySelectorAll('[data-action="open"]')) {
    btn.addEventListener('click', () => {
      const player = sorted.find(p => p.id === btn.dataset.id)
      if (player) onPick(player)
    })
  }
}
