import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('roster')

const ROLE_COLORS = {
  IGL: 'var(--accent)', AWPer: 'var(--special)', Entry: 'var(--danger)',
  Support: 'var(--success)', Lurker: 'var(--warning)', Coach: 'var(--muted)', Manager: 'var(--muted)'
}

let allPlayers = []
let editingId  = null

async function loadRoster() {
  const { data, error } = await supabase
    .from('roster')
    .select('*')
    .eq('team_id', getTeamId())
    .order('username', { ascending: true })
  const el = document.getElementById('roster-grid')
  if (error) { el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Failed to load</h3><p>${esc(error.message)}</p></div>`; return }
  allPlayers = data ?? []
  document.getElementById('roster-sub').textContent = `${allPlayers.length} member${allPlayers.length !== 1 ? 's' : ''}`
  if (!allPlayers.length) {
    el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>No players yet</h3><p>Add players with the button above.</p></div>`
    return
  }
  el.innerHTML = allPlayers.map(p => `
    <div class="player-card" style="cursor:pointer" data-edit="${p.id}">
      <div class="player-avatar">${esc((p.nickname || p.username || '?').slice(0,2).toUpperCase())}</div>
      <div class="player-ign">${esc(p.nickname || p.username)}</div>
      ${p.username && p.nickname ? `<div class="player-name">${esc(p.username)}</div>` : ''}
      <span class="role-badge" style="background:${ROLE_COLORS[p.role] ?? 'var(--border)'};color:#fff;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700">${esc(p.role ?? 'Player')}</span>
    </div>
  `).join('')
  document.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => openModal(el.dataset.edit)))
}

function openModal(id = null) {
  editingId = id
  const p = id ? allPlayers.find(x => x.id === id) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Player' : 'Add Player'
  document.getElementById('f-username').value = p?.username ?? ''
  document.getElementById('f-nickname').value = p?.nickname ?? ''
  document.getElementById('f-role').value     = p?.role     ?? ''
  document.getElementById('delete-player-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display = 'flex'
}

function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

document.getElementById('add-player-btn').addEventListener('click', () => openModal())
document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click', closeModal)
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal() })

document.getElementById('save-player-btn').addEventListener('click', async () => {
  const username = document.getElementById('f-username').value.trim()
  const nickname = document.getElementById('f-nickname').value.trim() || null
  const role     = document.getElementById('f-role').value || null
  const errEl    = document.getElementById('modal-error')
  if (!username) { errEl.textContent = 'Display name is required.'; errEl.style.display = 'block'; return }

  const payload = { username, nickname, role, team_id: getTeamId() }
  let error
  if (editingId) {
    ;({ error } = await supabase.from('roster').update(payload).eq('id', editingId))
  } else {
    ;({ error } = await supabase.from('roster').insert(payload))
  }
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  closeModal(); loadRoster()
})

document.getElementById('delete-player-btn').addEventListener('click', async () => {
  if (!confirm('Remove this player from the roster?')) return
  const { error } = await supabase.from('roster').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); loadRoster()
})

loadRoster()
