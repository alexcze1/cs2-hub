import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'
import { attachPlayerAutocomplete, getPlayerImage, playerAvatarEl } from './player-autocomplete.js'
import { rankCandidates } from './roster-steam-backfill.js'

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

  // Resolve player photos in parallel
  const images = await Promise.all(allPlayers.map(p => getPlayerImage(p.nickname || p.username)))

  el.innerHTML = allPlayers.map((p, i) => {
    const roleColor = ROLE_COLORS[p.role] ?? 'var(--border)'
    const avatarHtml = images[i]
      ? `<img src="${images[i]}" alt="${esc(p.nickname || p.username)}" style="width:72px;height:72px;object-fit:cover;border-radius:50%;border:2px solid ${roleColor};margin-bottom:10px">`
      : `<div class="player-avatar" style="background:${roleColor}22;border:2px solid ${roleColor};color:${roleColor}">${esc((p.nickname || p.username || '?').slice(0,2).toUpperCase())}</div>`
    return `
    <div class="player-card" style="cursor:pointer;border-top:3px solid ${roleColor}" data-edit="${p.id}">
      ${avatarHtml}
      <div class="player-ign">${esc(p.nickname || p.username)}</div>
      ${p.username && p.nickname ? `<div class="player-name">${esc(p.username)}</div>` : ''}
      <span class="role-badge" style="background:${roleColor};color:#fff;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700">${esc(p.role ?? 'Player')}</span>
    </div>
  `}).join('')
  document.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => openModal(el.dataset.edit)))
}

function openModal(id = null) {
  editingId = id
  const p = id ? allPlayers.find(x => x.id === id) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Player' : 'Add Player'
  document.getElementById('f-username').value = p?.username ?? ''
  document.getElementById('f-nickname').value = p?.nickname ?? ''
  document.getElementById('f-role').value     = p?.role     ?? ''
  document.getElementById('f-steam-id').value = p?.steam_id ?? ''
  document.getElementById('suggest-results').style.display = 'none'
  document.getElementById('steam-warning').style.display = 'none'
  document.getElementById('delete-player-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  // Update avatar preview when editing
  updateAvatarPreview(p?.nickname || p?.username || '')
  document.getElementById('modal').style.display = 'flex'
}

function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

// Live avatar preview in modal
async function updateAvatarPreview(ign) {
  const wrap = document.getElementById('modal-avatar-preview')
  if (!wrap) return
  const img = await getPlayerImage(ign)
  wrap.innerHTML = playerAvatarEl(img, ign, 52)
}

// Attach autocomplete to nickname field
attachPlayerAutocomplete(document.getElementById('f-nickname'), player => {
  updateAvatarPreview(player.ign)
})

document.getElementById('f-nickname').addEventListener('input', e => {
  updateAvatarPreview(e.target.value.trim())
})

document.getElementById('add-player-btn').addEventListener('click', () => openModal())
document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click', closeModal)
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal() })

document.getElementById('save-player-btn').addEventListener('click', async () => {
  const username = document.getElementById('f-username').value.trim()
  const nickname = document.getElementById('f-nickname').value.trim() || null
  const role     = document.getElementById('f-role').value || null
  const steamRaw = document.getElementById('f-steam-id').value.trim()
  const steam_id = steamRaw === '' ? null : steamRaw
  const errEl    = document.getElementById('modal-error')
  if (!username) { errEl.textContent = 'Display name is required.'; errEl.style.display = 'block'; return }
  if (steam_id && !/^7656119\d{10}$/.test(steam_id)) {
    errEl.textContent = 'Steam ID must be a 17-digit Steam64 starting with 7656119.'
    errEl.style.display = 'block'; return
  }

  // Soft warning: same Steam ID assigned to another roster row?
  const dup = steam_id ? allPlayers.find(p => p.steam_id === steam_id && p.id !== editingId) : null
  const warnEl = document.getElementById('steam-warning')
  if (dup && !warnEl.dataset.confirmed) {
    warnEl.style.display = 'block'
    warnEl.textContent = `This Steam ID is already assigned to ${dup.username}. Click Save again to confirm.`
    warnEl.dataset.confirmed = '1'
    return
  }
  warnEl.style.display = 'none'
  delete warnEl.dataset.confirmed

  const payload = { username, nickname, role, steam_id, team_id: getTeamId() }
  let error
  if (editingId) {
    ;({ error } = await supabase.from('roster').update(payload).eq('id', editingId))
  } else {
    ;({ error } = await supabase.from('roster').insert(payload))
  }
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  const wasEditing = !!editingId
  closeModal(); toast(wasEditing ? 'Player updated' : 'Player added'); loadRoster()
})

document.getElementById('delete-player-btn').addEventListener('click', async () => {
  if (!confirm('Remove this player from the roster?')) return
  const { error } = await supabase.from('roster').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); toast('Player removed'); loadRoster()
})


document.getElementById('suggest-steam-btn').addEventListener('click', async () => {
  const nickname = document.getElementById('f-nickname').value.trim()
  const resultsEl = document.getElementById('suggest-results')
  if (!nickname) {
    resultsEl.style.display = 'block'
    resultsEl.innerHTML = `<div style="font-size:12px;color:var(--muted)">Enter a nickname above first.</div>`
    return
  }

  // Fetch recent demos for this team and their players
  const teamId = getTeamId()
  const { data: demos, error: derr } = await supabase
    .from('demos')
    .select('id')
    .eq('team_id', teamId)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(30)
  if (derr) {
    resultsEl.style.display = 'block'
    resultsEl.innerHTML = `<div style="font-size:12px;color:var(--danger)">Failed to load demos: ${esc(derr.message)}</div>`
    return
  }
  const demoIds = (demos ?? []).map(d => d.id)
  if (!demoIds.length) {
    resultsEl.style.display = 'block'
    resultsEl.innerHTML = `<div style="font-size:12px;color:var(--muted)">No demos uploaded yet.</div>`
    return
  }

  const { data: rows, error: perr } = await supabase
    .from('demo_players')
    .select('steam_id,name')
    .in('demo_id', demoIds)
    .eq('side', 'all')
  if (perr) {
    resultsEl.style.display = 'block'
    resultsEl.innerHTML = `<div style="font-size:12px;color:var(--danger)">Failed to load players: ${esc(perr.message)}</div>`
    return
  }

  // Exclude steam_ids already assigned to other roster rows (not this one)
  const assigned = new Set(
    allPlayers
      .filter(p => p.steam_id && p.id !== editingId)
      .map(p => p.steam_id)
  )
  const candidates = rankCandidates(rows ?? [], nickname, assigned).slice(0, 5)

  if (!candidates.length) {
    resultsEl.style.display = 'block'
    resultsEl.innerHTML = `<div style="font-size:12px;color:var(--muted)">No matches in last 30 demos.</div>`
    return
  }

  resultsEl.style.display = 'block'
  resultsEl.innerHTML = candidates.map(c => `
    <button type="button" class="btn btn-ghost btn-sm" data-pick="${esc(c.steam_id)}"
            style="display:flex;justify-content:space-between;width:100%;margin-bottom:4px;text-align:left">
      <span>${esc(c.name)} <span style="color:var(--muted)">·</span> <code style="font-family:monospace;font-size:11px">${esc(c.steam_id)}</code></span>
      <span style="color:var(--muted);font-size:11px">${c.count} demo${c.count === 1 ? '' : 's'}</span>
    </button>
  `).join('')

  resultsEl.querySelectorAll('[data-pick]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('f-steam-id').value = btn.dataset.pick
      resultsEl.style.display = 'none'
    })
  })
})

loadRoster()
