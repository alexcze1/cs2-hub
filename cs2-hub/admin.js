import { requireAuth, isAdmin } from './auth.js'
import { renderSidebar, renderToolHeader } from './layout.js'
import { supabase } from './supabase.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function initials(s) {
  return String(s || '?').replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?'
}
function relTime(iso) {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days < 1) return 'today'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

const session = await requireAuth()
if (!isAdmin(session.user)) {
  alert('Access denied.')
  window.location.href = 'dashboard.html'
  throw 0
}
renderSidebar('admin')

let allTeams = []
let searchTerm = ''

async function adminFetch(method, body) {
  const { data: { session: s } } = await supabase.auth.getSession()
  const opts = { method, headers: { 'Authorization': `Bearer ${s.access_token}`, 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch('/api/admin', opts)
  return res.json()
}

// ── Header ───────────────────────────────────────────────────────────────
function renderHeader() {
  const teams = allTeams.length
  const members = allTeams.reduce((s, t) => s + (t.members?.length || 0), 0)
  const pro = allTeams.filter(t => t.tier === 'pro' || t.tier === 'pro-plus').length
  const largest = allTeams.reduce((m, t) => Math.max(m, t.members?.length || 0), 0)
  renderToolHeader(document.getElementById('admin-hero'), {
    section: 'Platform',
    title: 'Admin Console',
    sub: 'Teams, members and access across the platform.',
    kpis: [
      { v: teams, k: teams === 1 ? 'team' : 'teams' },
      { v: members, k: 'members' },
      { v: pro, k: 'pro teams', tone: pro ? 'good' : '' },
      { v: largest, k: 'largest roster' },
    ],
  })
}

// ── Teams list ─────────────────────────────────────────────────────────────
async function loadTeams() {
  const el = document.getElementById('teams-list')
  const teams = await adminFetch('GET')
  if (!Array.isArray(teams) || teams.error) {
    renderHeader()
    el.innerHTML = `<div class="rstr-empty"><h3>Couldn't reach the admin service</h3><p>The platform API didn't respond. Check that you're signed in as an admin and try again.</p></div>`
    return
  }
  allTeams = teams
  renderHeader()
  renderList()
}

function renderList() {
  const el = document.getElementById('teams-list')
  if (!allTeams.length) {
    el.innerHTML = `<div class="rstr-empty"><h3>No teams yet</h3><p>Create the first team to get the platform started.</p><button type="button" class="dx-upload-cta" id="empty-create">+ New Team</button></div>`
    document.getElementById('empty-create')?.addEventListener('click', openCreate)
    return
  }

  const q = searchTerm.toLowerCase().trim()
  const teams = q
    ? allTeams.filter(t =>
        t.name?.toLowerCase().includes(q) ||
        t.join_code?.toLowerCase().includes(q) ||
        (t.members || []).some(m => (m.email || '').toLowerCase().includes(q)))
    : allTeams

  if (!teams.length) {
    el.innerHTML = `<div class="rstr-empty"><h3>No matches</h3><p>No teams, members or codes match "${esc(searchTerm)}".</p></div>`
    return
  }

  el.innerHTML = teams.map(teamCard).join('')
  wireCards()
}

function teamCard(t) {
  const memberCount = t.members?.length || 0
  const tier = t.tier === 'pro' || t.tier === 'pro-plus' ? 'pro' : 'free'
  const tierLabel = t.tier === 'pro-plus' ? 'Pro+' : t.tier === 'pro' ? 'Pro' : 'Free'
  const created = t.created_at ? ` · created ${relTime(t.created_at)}` : ''

  const members = memberCount
    ? t.members.map(m => {
        const name = m.email?.split('@')[0] ?? m.user_id
        const perm = m.role === 'owner' ? 'owner' : 'member'
        return `
          <div class="admin-member-row">
            <div class="admin-member-ava">${esc(initials(name))}</div>
            <div class="admin-member-id">
              <div class="admin-member-name">${esc(name)}</div>
              <div class="admin-member-meta">${esc(m.email || '—')} · Steam ${esc(m.steam_id ?? '—')}</div>
            </div>
            ${m.display_role ? `<span class="admin-role-tag">${esc(m.display_role)}</span>` : ''}
            <span class="admin-perm admin-perm-${perm}">${perm}</span>
            <button class="btn btn-sm btn-ghost admin-danger" data-remove-member="${esc(m.user_id)}" data-remove-team="${esc(t.id)}">Remove</button>
          </div>`
      }).join('')
    : `<div class="admin-empty-members">No members yet — share the join code to add players.</div>`

  return `
    <div class="admin-team-card" data-team-id="${esc(t.id)}">
      <div class="admin-team-header">
        <div class="admin-team-crest">${esc(initials(t.name))}</div>
        <div class="admin-team-id">
          <div class="admin-team-name">${esc(t.name)} <span class="admin-tier admin-tier-${tier}">${tierLabel}</span></div>
          <div class="admin-team-meta">${memberCount} member${memberCount !== 1 ? 's' : ''}${created}</div>
        </div>
        <div class="admin-code-wrap">
          <span class="admin-code-label">Join code</span>
          <button class="admin-team-code" data-copy="${esc(t.join_code ?? '')}" title="Copy join code">${esc(t.join_code ?? '—')}</button>
        </div>
        <button class="btn btn-sm btn-ghost admin-danger" data-delete="${esc(t.id)}" data-name="${esc(t.name)}">Delete</button>
        <span class="admin-chev">▾</span>
      </div>
      <div class="admin-members">${members}</div>
    </div>`
}

function wireCards() {
  const el = document.getElementById('teams-list')

  el.querySelectorAll('.admin-team-header').forEach(h => {
    h.addEventListener('click', e => {
      if (e.target.closest('button')) return
      h.closest('.admin-team-card').classList.toggle('open')
    })
  })

  el.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const code = btn.dataset.copy
      if (!code) return
      navigator.clipboard?.writeText(code)
      const prev = btn.textContent
      btn.textContent = 'Copied!'
      setTimeout(() => { btn.textContent = prev }, 1500)
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

// ── Search ──────────────────────────────────────────────────────────────
document.getElementById('admin-search').addEventListener('input', e => {
  searchTerm = e.target.value
  renderList()
})

// ── Create team modal ────────────────────────────────────────────────────
function openCreate() {
  document.getElementById('f-team-name').value = ''
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display = 'flex'
  document.getElementById('f-team-name').focus()
}
document.getElementById('create-team-btn').addEventListener('click', openCreate)
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
