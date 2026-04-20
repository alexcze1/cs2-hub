// cs2-hub/stratbook-detail.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('stratbook')

const id = new URLSearchParams(location.search).get('id')
const isEdit = !!id

// 5 fixed role slots — label shows assigned player name, falls back to role name
const ROLE_SLOTS = ['IGL', 'AWPer', 'Entry', 'Support', 'Lurker']
const { data: rosterData } = await supabase.from('roster').select('username, nickname, role').eq('team_id', getTeamId())
const PLAYERS = ROLE_SLOTS.map(slot => {
  const match = rosterData?.find(p => p.role === slot)
  return { slot, label: match ? (match.nickname || match.username) : slot }
})

document.getElementById('player-roles').innerHTML = PLAYERS.map((p, i) => `
  <div class="role-row">
    <span class="role-player-label">
      ${esc(p.label)}
      ${p.label !== p.slot ? `<span style="font-size:10px;color:var(--muted);display:block;font-weight:400">${esc(p.slot)}</span>` : ''}
    </span>
    <input class="form-input" id="role-${i}" placeholder="e.g. Smoke CT, entry short"/>
  </div>
`).join('')

// Load existing strat if editing
if (isEdit) {
  document.getElementById('page-title').textContent = 'Edit Strat'
  document.getElementById('delete-btn').style.display = 'block'

  const { data: strat, error } = await supabase.from('strats').select('*').eq('id', id).single()
  if (error || !strat) { alert('Strat not found.'); location.href = 'stratbook.html'; throw 0; }

  document.getElementById('f-name').value  = strat.name
  document.getElementById('f-map').value   = strat.map
  document.getElementById('f-side').value  = strat.side
  document.getElementById('f-type').value  = strat.type
  document.getElementById('f-notes').value = strat.notes ?? ''
  document.getElementById('f-tags').value  = (strat.tags ?? []).join(', ')

  const roles = strat.player_roles ?? []
  PLAYERS.forEach((p, i) => {
    const saved = roles.find(r => r.player === p.label || r.player === p.slot)
    document.getElementById(`role-${i}`).value = saved?.role ?? roles[i]?.role ?? ''
  })
}

// Save
document.getElementById('save-btn').addEventListener('click', async () => {
  const name  = document.getElementById('f-name').value.trim()
  const map   = document.getElementById('f-map').value
  const side  = document.getElementById('f-side').value
  const type  = document.getElementById('f-type').value
  const notes = document.getElementById('f-notes').value.trim() || null
  const tags  = document.getElementById('f-tags').value.split(',').map(t => t.trim()).filter(Boolean)
  const errEl = document.getElementById('error-msg')

  if (!name) {
    errEl.textContent = 'Strat name is required.'
    errEl.style.display = 'block'
    return
  }

  const player_roles = PLAYERS.map((p, i) => ({
    player: p.label,
    role: document.getElementById(`role-${i}`).value.trim()
  }))

  const payload = { name, map, side, type, player_roles, notes, tags, team_id: getTeamId(), updated_at: new Date().toISOString() }

  let error
  if (isEdit) {
    ({ error } = await supabase.from('strats').update(payload).eq('id', id))
  } else {
    ({ error } = await supabase.from('strats').insert(payload))
  }

  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  location.href = 'stratbook.html'
})

// Delete
document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this strat?')) return
  const { error } = await supabase.from('strats').delete().eq('id', id)
  if (error) {
    const errEl = document.getElementById('error-msg')
    errEl.textContent = `Delete failed: ${error.message}`
    errEl.style.display = 'block'
    return
  }
  location.href = 'stratbook.html'
})

// ── Print ────────────────────────────────────────────────────
window.printStrat = function() {
  const name  = document.getElementById('f-name').value.trim()
  const map   = document.getElementById('f-map').value
  const side  = document.getElementById('f-side').value
  const type  = document.getElementById('f-type').value
  const notes = document.getElementById('f-notes').value.trim()
  const tags  = document.getElementById('f-tags').value
  const roles = PLAYERS.map((p, i) => ({ player: p, role: document.getElementById(`role-${i}`).value.trim() }))

  let printEl = document.getElementById('print-strat-container')
  if (!printEl) {
    printEl = document.createElement('div')
    printEl.id = 'print-strat-container'
    document.body.appendChild(printEl)
  }

  const sideLabel = side === 't' ? 'T-Side' : 'CT-Side'
  const mapLabel  = map.charAt(0).toUpperCase() + map.slice(1)

  printEl.innerHTML = `
    <div class="print-strat-header">
      <div class="print-strat-title">${esc(name)}</div>
      <div class="print-strat-meta">${esc(mapLabel)} · ${esc(sideLabel)} · ${esc(type.toUpperCase())}</div>
    </div>
    ${roles.some(r => r.role) ? `
    <div class="print-strat-section">
      <div class="print-strat-section-label">Player Roles</div>
      ${roles.filter(r => r.role).map(r => `
        <div class="role-row">
          <span class="role-player-label">${esc(r.player)}</span>
          <span>${esc(r.role)}</span>
        </div>
      `).join('')}
    </div>` : ''}
    ${notes ? `
    <div class="print-strat-section">
      <div class="print-strat-section-label">Notes</div>
      <div style="white-space:pre-wrap;font-size:10pt">${esc(notes)}</div>
    </div>` : ''}
    ${tags ? `
    <div class="print-strat-section">
      <div class="print-strat-section-label">Tags</div>
      <div>${esc(tags)}</div>
    </div>` : ''}
  `

  printEl.style.display = 'block'
  document.querySelector('.app-shell').style.display = 'none'
  window.print()
  document.querySelector('.app-shell').style.display = ''
  printEl.style.display = 'none'
}
