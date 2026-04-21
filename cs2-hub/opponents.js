// cs2-hub/opponents.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

const MAP_IMG = { dust2: 'dust' }
function mapChip(map) {
  const src = `images/maps/${MAP_IMG[map] ?? map}.png`
  return `<div style="position:relative;overflow:hidden;border-radius:5px;width:54px;height:38px;flex-shrink:0;border:1px solid var(--border)">
    <img src="${src}" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.5;pointer-events:none">
    <div style="position:relative;height:100%;display:flex;align-items:flex-end;padding:3px 4px">
      <span style="font-size:9px;font-weight:700;letter-spacing:0.5px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.8)">${map.slice(0,3).toUpperCase()}</span>
    </div>
  </div>`
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
        ${o.favored_maps?.length
          ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${o.favored_maps.map(mapChip).join('')}</div>`
          : `<div class="row-meta">No maps noted</div>`}
      </div>
    </a>
  `).join('')
}
