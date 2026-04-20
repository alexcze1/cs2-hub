// cs2-hub/opponents.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

await requireAuth()
renderSidebar('opponents')

const el = document.getElementById('opponents-list')
const { data: opponents, error } = await supabase.from('opponents').select('*').eq('team_id', getTeamId()).order('name', { ascending: true })

if (error) {
  el.innerHTML = `<div class="empty-state"><h3>Failed to load opponents</h3><p>${esc(error.message)}</p></div>`
} else if (!opponents?.length) {
  el.innerHTML = `<div class="empty-state"><h3>No opponents yet</h3><p>Add a team before your next match.</p></div>`
} else {
  el.innerHTML = opponents.map(o => `
    <a class="list-row" href="opponent-detail.html?id=${o.id}">
      <div style="width:40px;height:40px;background:var(--border);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--accent);font-size:11px;font-weight:700;flex-shrink:0">
        ${esc(o.name.slice(0,3).toUpperCase())}
      </div>
      <div class="flex-1">
        <div class="row-name">${esc(o.name)}</div>
        <div class="row-meta">${o.favored_maps?.length ? 'Maps: ' + o.favored_maps.map(m => esc(m.charAt(0).toUpperCase()+m.slice(1))).join(', ') : 'No maps noted'}</div>
      </div>
    </a>
  `).join('')
}
