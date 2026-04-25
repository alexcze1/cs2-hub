import { requireAuth, isAdmin } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const session = await requireAuth()

if (!isAdmin(session.user)) {
  alert('Access denied.')
  window.location.href = 'dashboard.html'
  throw 0
}

renderSidebar('admin')

async function adminFetch(method, body) {
  const { data: { session: s } } = await supabase.auth.getSession()
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${s.access_token}`, 'Content-Type': 'application/json' },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch('/api/admin', opts)
  return res.json()
}

async function loadTeams() {
  const el = document.getElementById('teams-list')
  const teams = await adminFetch('GET')
  if (!Array.isArray(teams) || teams.error) {
    el.innerHTML = `<div class="empty-state"><h3>Failed to load</h3></div>`
    return
  }
  if (!teams.length) {
    el.innerHTML = `<div class="empty-state"><h3>No teams yet</h3></div>`
    return
  }

  el.innerHTML = teams.map(t => `
    <div class="admin-team-card" data-team-id="${esc(t.id)}">
      <div class="admin-team-header">
        <div>
          <div class="admin-team-name">${esc(t.name)}</div>
          <div class="admin-team-meta">${t.members.length} member${t.members.length !== 1 ? 's' : ''} · <span class="admin-team-code">${esc(t.join_code ?? '—')}</span></div>
        </div>
        <button class="btn btn-sm btn-ghost admin-danger" data-delete="${esc(t.id)}" data-name="${esc(t.name)}">Delete</button>
        <span style="color:var(--muted);font-size:12px">▾</span>
      </div>
      <div class="admin-members" id="members-${esc(t.id)}">
        ${t.members.length ? t.members.map(m => `
          <div class="admin-member-row">
            <div>
              <div class="admin-member-name">${esc(m.email?.split('@')[0] ?? m.user_id)}</div>
              <div class="admin-member-meta">${esc(m.role)} · Steam: ${esc(m.steam_id ?? '—')}</div>
            </div>
            <button class="btn btn-sm btn-ghost admin-danger" data-remove-member="${esc(m.user_id)}" data-remove-team="${esc(t.id)}">Remove</button>
          </div>
        `).join('') : `<div style="color:var(--muted);font-size:13px">No members</div>`}
      </div>
    </div>
  `).join('')

  el.querySelectorAll('.admin-team-header').forEach(h => {
    h.addEventListener('click', e => {
      if (e.target.closest('button')) return
      const teamId = h.closest('[data-team-id]').dataset.teamId
      const members = document.getElementById(`members-${teamId}`)
      members.classList.toggle('open')
    })
  })

  el.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete team "${btn.dataset.name}"? This removes all members. Other team data (events, strats etc.) remains in the DB.`)) return
      btn.disabled = true
      await adminFetch('POST', { action: 'delete_team', team_id: btn.dataset.delete })
      toast('Team deleted')
      loadTeams()
    })
  })

  el.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this member from the team?')) return
      btn.disabled = true
      await adminFetch('POST', { action: 'remove_member', team_id: btn.dataset.removeTeam, user_id: btn.dataset.removeMember })
      toast('Member removed')
      loadTeams()
    })
  })
}

// ── Create team modal ──────────────────────────────────────
document.getElementById('create-team-btn').addEventListener('click', () => {
  document.getElementById('f-team-name').value = ''
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display = 'flex'
})
document.getElementById('modal-close').addEventListener('click', () => document.getElementById('modal').style.display = 'none')
document.getElementById('cancel-btn').addEventListener('click', () => document.getElementById('modal').style.display = 'none')

document.getElementById('save-btn').addEventListener('click', async () => {
  const name = document.getElementById('f-team-name').value.trim()
  const errEl = document.getElementById('modal-error')
  if (!name) { errEl.textContent = 'Name is required.'; errEl.style.display = 'block'; return }
  errEl.style.display = 'none'
  document.getElementById('save-btn').disabled = true
  await adminFetch('POST', { action: 'create_team', name })
  document.getElementById('modal').style.display = 'none'
  document.getElementById('save-btn').disabled = false
  toast('Team created')
  loadTeams()
})

loadTeams()
