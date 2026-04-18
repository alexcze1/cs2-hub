// cs2-hub/roster.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

await requireAuth()
renderSidebar('roster')

const el = document.getElementById('roster-grid')
const { data: players, error } = await supabase.from('roster').select('*').order('username', { ascending: true })

if (error) {
  el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Failed to load roster</h3><p>${esc(error.message)}</p></div>`
} else if (!players?.length) {
  el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>No players in roster</h3><p>Add players via the Supabase dashboard → roster table.</p></div>`
} else {
  el.innerHTML = players.map(p => `
    <div class="player-card">
      <div class="player-avatar">${esc(p.username.slice(0,2).toUpperCase())}</div>
      <div class="player-ign">${esc(p.username)}</div>
      ${p.real_name ? `<div class="player-name">${esc(p.real_name)}</div>` : ''}
      <span class="role-badge">${esc(p.role ?? 'Player')}</span>
    </div>
  `).join('')
}
