import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('issues')

const PRIORITY_COLORS = { high: 'var(--danger)', medium: 'var(--warning)', low: 'var(--muted)' }
const STATUS_COLORS   = { active: 'var(--danger)', improving: 'var(--warning)', resolved: 'var(--success)' }
const CAT_COLORS      = { tactical:'var(--accent)', communication:'var(--special)', mental:'var(--warning)', individual:'var(--success)', teamplay:'#06b6d4', other:'var(--muted)' }

let allIssues = []
let editingId = null
let activeStatus = 'all'

async function loadIssues() {
  const { data, error } = await supabase.from('issues').select('*').eq('team_id', getTeamId()).order('priority').order('created_at', { ascending: false })
  const el = document.getElementById('issues-list')
  if (error) { el.innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${esc(error.message)}</p></div>`; return }
  allIssues = data ?? []
  document.getElementById('issues-sub').textContent = `${allIssues.filter(i => i.status !== 'resolved').length} open · ${allIssues.filter(i => i.status === 'resolved').length} resolved`
  renderIssues()
}

function renderIssues() {
  const filtered = activeStatus === 'all' ? allIssues : allIssues.filter(i => i.status === activeStatus)
  const el = document.getElementById('issues-list')
  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state"><h3>No issues</h3><p>${activeStatus !== 'all' ? 'No ' + activeStatus + ' issues.' : 'Add your first issue.'}</p></div>`
    return
  }

  el.innerHTML = filtered.map(i => `
    <div class="list-row" style="flex-direction:column;align-items:flex-start;gap:10px">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:flex-start;gap:12px">
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
            <div style="font-weight:700;font-size:14px">${esc(i.title)}</div>
            <span style="font-size:10px;font-weight:700;color:${PRIORITY_COLORS[i.priority]};text-transform:uppercase">${i.priority}</span>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <span style="font-size:11px;padding:1px 7px;border-radius:3px;background:var(--border);color:${CAT_COLORS[i.category] ?? 'var(--muted)'};font-weight:600;text-transform:uppercase">${esc(i.category)}</span>
            <span style="font-size:11px;color:${STATUS_COLORS[i.status]};font-weight:600;text-transform:uppercase">${i.status}</span>
          </div>
        </div>
        <button class="btn btn-ghost" style="font-size:11px;padding:2px 8px;flex-shrink:0" data-edit="${i.id}">Edit</button>
      </div>
      ${i.description ? `<div style="color:var(--muted);font-size:13px">${esc(i.description)}</div>` : ''}
      ${i.actions ? `
        <div style="background:var(--bg);border-left:3px solid var(--accent);padding:8px 12px;border-radius:0 4px 4px 0;font-size:12px;width:100%">
          <div style="font-size:10px;font-weight:700;letter-spacing:1px;color:var(--accent);margin-bottom:3px">CURRENT ACTIONS</div>
          <div style="color:var(--text)">${esc(i.actions)}</div>
        </div>
      ` : ''}
    </div>
  `).join('')

  document.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); openModal(e.target.dataset.edit) }))
}

document.getElementById('status-filters').addEventListener('click', e => {
  const tab = e.target.closest('.tab')
  if (!tab) return
  document.querySelectorAll('#status-filters .tab').forEach(t => t.classList.remove('active'))
  tab.classList.add('active')
  activeStatus = tab.dataset.status
  renderIssues()
})

function openModal(id = null) {
  editingId = id
  const i = id ? allIssues.find(x => x.id === id) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Issue' : 'Add Issue'
  document.getElementById('f-title').value       = i?.title       ?? ''
  document.getElementById('f-category').value    = i?.category    ?? 'tactical'
  document.getElementById('f-priority').value    = i?.priority    ?? 'medium'
  document.getElementById('f-status').value      = i?.status      ?? 'active'
  document.getElementById('f-description').value = i?.description ?? ''
  document.getElementById('f-actions').value     = i?.actions     ?? ''
  document.getElementById('delete-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display = 'flex'
}

function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

document.getElementById('add-btn').addEventListener('click', () => openModal())
document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click', closeModal)
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal() })

document.getElementById('save-btn').addEventListener('click', async () => {
  const title       = document.getElementById('f-title').value.trim()
  const category    = document.getElementById('f-category').value
  const priority    = document.getElementById('f-priority').value
  const status      = document.getElementById('f-status').value
  const description = document.getElementById('f-description').value.trim() || null
  const actions     = document.getElementById('f-actions').value.trim()     || null
  const errEl       = document.getElementById('modal-error')
  if (!title) { errEl.textContent = 'Issue title is required.'; errEl.style.display = 'block'; return }

  const payload = { title, category, priority, status, description, actions, team_id: getTeamId(), updated_at: new Date().toISOString() }
  let error
  if (editingId) {
    ;({ error } = await supabase.from('issues').update(payload).eq('id', editingId))
  } else {
    ;({ error } = await supabase.from('issues').insert(payload))
  }
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  closeModal(); loadIssues()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this issue?')) return
  const { error } = await supabase.from('issues').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); loadIssues()
})

loadIssues()
