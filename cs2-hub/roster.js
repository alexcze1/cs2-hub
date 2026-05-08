import { requireAuth, isTeamOwner } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'
import { getPlayerImage, playerAvatarEl } from './player-autocomplete.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const ROLE_COLORS = {
  IGL: 'var(--accent)', AWPer: 'var(--special)', Entry: 'var(--danger)',
  Support: 'var(--success)', Lurker: 'var(--warning)',
  Coach: 'var(--muted)', Manager: 'var(--muted)',
  Bench: 'var(--muted)', Unassigned: 'var(--border)',
}
const ALL_ROLES = ['IGL','AWPer','Entry','Support','Lurker','Coach','Manager','Bench','Unassigned']

await requireAuth()
renderSidebar('roster')

const teamId = getTeamId()
const isOwner = await isTeamOwner(teamId)

let allPlayers = []

async function loadRoster() {
  const { data, error } = await supabase
    .from('roster')
    .select('*')
    .eq('team_id', teamId)
    .order('username', { ascending: true })

  const el = document.getElementById('roster-grid')
  if (error) {
    el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Failed to load</h3><p>${esc(error.message)}</p></div>`
    return
  }

  allPlayers = data ?? []
  document.getElementById('roster-sub').textContent =
    `${allPlayers.length} member${allPlayers.length !== 1 ? 's' : ''}`

  if (!allPlayers.length) {
    el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>No players yet</h3><p>Roster is empty. ${isOwner ? 'Use "+ Add ghost player" or invite teammates with the team join code.' : 'The owner will set this up.'}</p></div>`
    return
  }

  const images = await Promise.all(allPlayers.map(p => getPlayerImage(p.nickname || p.username)))

  el.innerHTML = allPlayers.map((p, i) => {
    const role = p.role || 'Unassigned'
    const roleColor = ROLE_COLORS[role] ?? 'var(--border)'
    const avatarHtml = images[i]
      ? `<img src="${images[i]}" alt="${esc(p.nickname || p.username)}" style="width:72px;height:72px;object-fit:cover;border-radius:50%;border:2px solid ${roleColor};margin-bottom:10px">`
      : `<div class="player-avatar" style="background:${roleColor}22;border:2px solid ${roleColor};color:${roleColor}">${esc((p.nickname || p.username || '?').slice(0,2).toUpperCase())}</div>`

    const statusBadge = p.is_ghost
      ? `<span class="status-badge status-ghost" style="display:inline-block;background:var(--warning);color:#000;border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700;letter-spacing:0.5px;margin-top:6px">PENDING</span>`
      : `<span class="status-badge status-member" style="display:inline-block;background:var(--surface-low);color:var(--muted);border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700;letter-spacing:0.5px;margin-top:6px">MEMBER</span>`

    const roleControl = isOwner
      ? `<select class="role-select" data-role-for="${p.id}" style="background:${roleColor};color:#fff;border:none;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;cursor:pointer">
           ${ALL_ROLES.map(r => `<option value="${r}" ${r === role ? 'selected' : ''}>${r}</option>`).join('')}
         </select>`
      : `<span class="role-badge" style="background:${roleColor};color:#fff;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700">${esc(role)}</span>`

    const removeBtn = isOwner
      ? `<button class="btn btn-ghost btn-sm" data-remove="${p.id}" data-is-ghost="${!!p.is_ghost}" style="position:absolute;top:8px;right:8px;color:var(--danger);font-size:11px;padding:2px 6px">×</button>`
      : ''

    return `
      <div class="player-card" style="position:relative;border-top:3px solid ${roleColor}" data-player-id="${p.id}">
        ${removeBtn}
        ${avatarHtml}
        <div class="player-ign">${esc(p.nickname || p.username)}</div>
        ${p.username && p.nickname ? `<div class="player-name">${esc(p.username)}</div>` : ''}
        ${roleControl}
        <div>${statusBadge}</div>
      </div>
    `
  }).join('')

  if (isOwner) {
    for (const sel of document.querySelectorAll('[data-role-for]')) {
      sel.addEventListener('change', () => onRoleChange(sel.dataset.roleFor, sel.value))
    }
    for (const btn of document.querySelectorAll('[data-remove]')) {
      btn.addEventListener('click', () => onRemove(btn.dataset.remove, btn.dataset.isGhost === 'true'))
    }
  }
}

async function onRoleChange(playerId, newRole) {
  const { error } = await supabase.from('roster').update({ role: newRole }).eq('id', playerId)
  if (error) { toast(`Failed: ${error.message}`); return }
  toast('Role updated')
  const p = allPlayers.find(x => x.id === playerId)
  if (p) p.role = newRole
}

async function onRemove(playerId, isGhost) {
  const p = allPlayers.find(x => x.id === playerId)
  if (!p) return
  const label = p.nickname || p.username
  if (!confirm(isGhost
    ? `Remove ghost row for ${label}?`
    : `Remove ${label} from the team? This deletes their team membership.`)) return

  let error
  if (isGhost) {
    ;({ error } = await supabase.from('roster').delete().eq('id', playerId))
  } else {
    ;({ error } = await supabase
      .from('team_members')
      .delete()
      .eq('team_id', teamId)
      .eq('user_id', p.user_id))
  }
  if (error) { toast(`Failed: ${error.message}`); return }
  toast(isGhost ? 'Ghost removed' : 'Member removed')
  loadRoster()
}

if (isOwner) {
  document.getElementById('add-ghost-btn').style.display = ''
}

document.getElementById('add-ghost-btn').addEventListener('click', () => {
  document.getElementById('ghost-form').style.display = 'block'
  document.getElementById('add-ghost-btn').style.display = 'none'
  document.getElementById('g-username').focus()
})

document.getElementById('ghost-cancel-btn').addEventListener('click', resetGhostForm)

function resetGhostForm() {
  document.getElementById('ghost-form').style.display = 'none'
  document.getElementById('add-ghost-btn').style.display = ''
  document.getElementById('g-username').value = ''
  document.getElementById('g-steam-id').value = ''
  document.getElementById('g-role').value = 'Unassigned'
  document.getElementById('ghost-error').style.display = 'none'
}

document.getElementById('ghost-save-btn').addEventListener('click', async () => {
  const username = document.getElementById('g-username').value.trim()
  const steamId  = document.getElementById('g-steam-id').value.trim()
  const role     = document.getElementById('g-role').value
  const errEl    = document.getElementById('ghost-error')

  if (!username) {
    errEl.textContent = 'Display name is required.'
    errEl.style.display = 'block'; return
  }
  if (!/^7656119\d{10}$/.test(steamId)) {
    errEl.textContent = 'Steam ID must be a 17-digit Steam64 starting with 7656119.'
    errEl.style.display = 'block'; return
  }

  const { error } = await supabase.from('roster').insert({
    team_id: teamId,
    user_id: null,
    username,
    nickname: null,
    steam_id: steamId,
    role,
    is_ghost: true,
  })

  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  resetGhostForm()
  toast('Ghost player added')
  loadRoster()
})

loadRoster()
