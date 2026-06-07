// cs2-hub/stratbook-detail.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('stratbook')

const id = new URLSearchParams(location.search).get('id')
const isEdit = !!id

// 5 fixed role slots — label shows assigned player name, falls back to role name
const ROLE_SLOTS = ['IGL', 'AWPer', 'Entry', 'Support', 'Lurker']
const { data: rosterData } = await supabase.from('roster').select('nickname, role').eq('team_id', getTeamId())
const PLAYERS = ROLE_SLOTS.map(slot => {
  const match = rosterData?.find(p => p.role === slot)
  return { slot, label: match?.nickname || slot }
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
  toast(isEdit ? 'Strat updated' : 'Strat saved')
  setTimeout(() => { location.href = 'stratbook.html' }, 700)
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
  toast('Strat deleted')
  setTimeout(() => { location.href = 'stratbook.html' }, 700)
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

// ── #52 — Strat comments ─────────────────────────────────────
// Only visible on the edit path (a saved strat); new strats hide the
// section since there's nothing to attach the comment to yet.
if (isEdit) {
  const section = document.getElementById('strat-comments-section')
  const listEl  = document.getElementById('comment-list')
  const formEl  = document.getElementById('comment-form')
  const inputEl = document.getElementById('comment-input')
  const countEl = document.getElementById('comment-count')

  section.style.display = 'block'

  function fmtAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(ms / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return new Date(iso).toLocaleDateString('en-GB', { day:'numeric', month:'short' })
  }

  async function loadComments() {
    const { data, error } = await supabase
      .from('strat_comments')
      .select('id, content, user_name, created_at, resolved, user_id')
      .eq('strat_id', id)
      .order('created_at', { ascending: true })
    if (error) {
      // Migration not yet applied — silent. Section keeps the empty
      // shell, post button stays disabled.
      listEl.innerHTML = `<div class="comment-empty">Run supabase-collab-migration.sql to enable comments.</div>`
      formEl.style.display = 'none'
      return
    }
    countEl.textContent = data?.length ? `${data.length} comment${data.length === 1 ? '' : 's'}` : ''
    if (!data?.length) {
      listEl.innerHTML = `<div class="comment-empty">No comments yet.</div>`
      return
    }
    const { data: { user } } = await supabase.auth.getUser()
    const myId = user?.id
    listEl.innerHTML = data.map(c => `
      <div class="comment-row ${c.resolved ? 'comment-resolved' : ''}">
        <div class="comment-head">
          <span class="comment-author">${esc(c.user_name || 'Player')}</span>
          <span class="comment-when">${esc(fmtAgo(c.created_at))}</span>
          ${c.user_id === myId ? `<button class="comment-delete" data-id="${c.id}" title="Delete">×</button>` : ''}
        </div>
        <div class="comment-body">${esc(c.content)}</div>
      </div>`).join('')
    listEl.querySelectorAll('.comment-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this comment?')) return
        await supabase.from('strat_comments').delete().eq('id', btn.dataset.id)
        loadComments()
      })
    })
  }

  formEl.addEventListener('submit', async e => {
    e.preventDefault()
    const content = inputEl.value.trim()
    if (!content) return
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    // Resolve a display name from roster.nickname before posting.
    const { data: me } = await supabase
      .from('roster')
      .select('nickname')
      .eq('team_id', getTeamId())
      .eq('user_id', user.id)
      .maybeSingle()
    const userName = me?.nickname || user.email?.split('@')[0] || 'Player'
    const { error } = await supabase.from('strat_comments').insert({
      strat_id: id,
      team_id:  getTeamId(),
      user_id:  user.id,
      user_name: userName,
      content,
    })
    if (error) { toast('Could not post comment', 'error'); return }
    inputEl.value = ''
    loadComments()
  })

  loadComments()
}
