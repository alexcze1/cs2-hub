import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('goals')

const HORIZONS = [
  { key: 'long_term', label: 'LONG TERM' },
  { key: 'monthly',   label: 'MONTHLY' },
  { key: 'weekly',    label: 'WEEKLY' },
]
const STATUS_COLORS = { active: 'var(--accent)', completed: 'var(--success)', dropped: 'var(--muted)' }

let allGoals = []
let editingId = null

document.getElementById('f-progress').addEventListener('input', e => {
  document.getElementById('progress-val').textContent = e.target.value
})

async function loadGoals() {
  const { data, error } = await supabase.from('goals').select('*').order('created_at', { ascending: false })
  if (error) { document.getElementById('goals-container').innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${esc(error.message)}</p></div>`; return }
  allGoals = data ?? []
  renderGoals()
}

function renderGoals() {
  const el = document.getElementById('goals-container')
  const byHorizon = Object.fromEntries(HORIZONS.map(h => [h.key, allGoals.filter(g => g.horizon === h.key)]))

  if (!allGoals.length) {
    el.innerHTML = `<div class="empty-state"><h3>No goals set</h3><p>Add your first team goal above.</p></div>`
    return
  }

  el.innerHTML = HORIZONS.map(h => {
    const goals = byHorizon[h.key]
    if (!goals.length) return `
      <div class="section-header" style="margin-bottom:12px"><div class="section-title">${h.label}</div></div>
      <div style="color:var(--muted);font-size:13px;margin-bottom:24px">No ${h.label.toLowerCase()} goals yet.</div>
    `
    return `
      <div class="section-header" style="margin-bottom:12px">
        <div class="section-title">${h.label} <span style="color:var(--muted);font-weight:400;font-size:12px">${goals.length} goal${goals.length !== 1 ? 's' : ''}</span></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-bottom:28px">
        ${goals.map(g => `
          <div class="list-row" style="flex-direction:column;align-items:flex-start;gap:8px;opacity:${g.status === 'dropped' ? 0.5 : 1}">
            <div style="display:flex;justify-content:space-between;width:100%;align-items:flex-start">
              <div style="font-weight:700;font-size:14px;flex:1">${esc(g.title)}</div>
              <button class="btn btn-ghost" style="font-size:11px;padding:2px 8px;flex-shrink:0" data-edit="${g.id}">Edit</button>
            </div>
            <div style="display:flex;align-items:center;gap:8px;width:100%">
              <div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden">
                <div style="height:100%;width:${g.progress}%;background:${STATUS_COLORS[g.status] ?? 'var(--accent)'};border-radius:3px"></div>
              </div>
              <span style="font-size:11px;color:var(--muted);min-width:30px">${g.progress}%</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <span style="font-size:11px;color:${STATUS_COLORS[g.status] ?? 'var(--accent)'};font-weight:600;text-transform:uppercase">${g.status}</span>
              ${g.due_date ? `<span style="font-size:11px;color:var(--muted)">Due ${new Date(g.due_date).toLocaleDateString('en-GB', {day:'numeric',month:'short'})}</span>` : ''}
            </div>
            ${g.description ? `<div style="color:var(--muted);font-size:12px">${esc(g.description)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `
  }).join('')

  document.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); openModal(e.target.dataset.edit) }))
}

function openModal(id = null) {
  editingId = id
  const g = id ? allGoals.find(x => x.id === id) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Goal' : 'Add Goal'
  document.getElementById('f-title').value       = g?.title       ?? ''
  document.getElementById('f-horizon').value     = g?.horizon     ?? 'long_term'
  document.getElementById('f-status').value      = g?.status      ?? 'active'
  document.getElementById('f-progress').value    = g?.progress    ?? 0
  document.getElementById('progress-val').textContent = g?.progress ?? 0
  document.getElementById('f-due').value         = g?.due_date    ?? ''
  document.getElementById('f-description').value = g?.description ?? ''
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
  const horizon     = document.getElementById('f-horizon').value
  const status      = document.getElementById('f-status').value
  const progress    = +document.getElementById('f-progress').value
  const due_date    = document.getElementById('f-due').value || null
  const description = document.getElementById('f-description').value.trim() || null
  const errEl       = document.getElementById('modal-error')
  if (!title) { errEl.textContent = 'Goal title is required.'; errEl.style.display = 'block'; return }

  const payload = { title, horizon, status, progress, due_date, description, updated_at: new Date().toISOString() }
  let error
  if (editingId) {
    ;({ error } = await supabase.from('goals').update(payload).eq('id', editingId))
  } else {
    ;({ error } = await supabase.from('goals').insert(payload))
  }
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  closeModal(); loadGoals()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this goal?')) return
  const { error } = await supabase.from('goals').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); loadGoals()
})

loadGoals()
