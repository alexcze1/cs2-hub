import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('goals')

const HORIZONS = [
  { key: 'long_term', label: 'LONG TERM' },
  { key: 'monthly',   label: 'MONTHLY' },
  { key: 'weekly',    label: 'WEEKLY' },
]

const STATUS_COLORS = { active: 'var(--accent)', completed: 'var(--success)', dropped: 'var(--muted)' }
const STATUS_LABELS = { active: 'Active', completed: 'Completed', dropped: 'Dropped' }

const CATEGORIES = {
  competition:   { label: 'Competition',   color: '#4ade80' },
  strategy:      { label: 'Strategy',      color: '#60a5fa' },
  aim:           { label: 'Aim & Mech',    color: '#f87171' },
  communication: { label: 'Communication', color: '#c084fc' },
  mental:        { label: 'Mental',        color: '#facc15' },
  other:         { label: 'Other',         color: '#64748b' },
}

let allGoals   = []
let editingId  = null

// ── Stats summary ──────────────────────────────────────────
function renderStats() {
  const active    = allGoals.filter(g => g.status === 'active').length
  const completed = allGoals.filter(g => g.status === 'completed').length
  const dropped   = allGoals.filter(g => g.status === 'dropped').length

  document.getElementById('goals-sub').textContent = `${allGoals.length} goal${allGoals.length !== 1 ? 's' : ''} · ${active} active`

  document.getElementById('goals-stats').innerHTML = [
    { label: 'Active',    value: active,    color: 'var(--accent)' },
    { label: 'Completed', value: completed, color: 'var(--success)' },
    { label: 'Dropped',   value: dropped,   color: 'var(--muted)' },
  ].map(s => `
    <div style="background:var(--surface);border:1px solid var(--border);border-top:3px solid ${s.color};border-radius:8px;padding:14px 20px;min-width:100px">
      <div style="font-size:22px;font-weight:800;color:${s.color}">${s.value}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px;letter-spacing:0.5px">${s.label}</div>
    </div>
  `).join('')
}

// ── Goals ──────────────────────────────────────────────────
async function loadGoals() {
  const { data, error } = await supabase.from('goals').select('*').eq('team_id', getTeamId()).order('created_at', { ascending: false })
  if (error) { document.getElementById('goals-container').innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${esc(error.message)}</p></div>`; return }
  allGoals = data ?? []
  renderStats()
  renderGoals()
}

function renderGoals() {
  const el = document.getElementById('goals-container')
  const byHorizon = Object.fromEntries(HORIZONS.map(h => [h.key, allGoals.filter(g => g.horizon === h.key)]))

  if (!allGoals.length) {
    el.innerHTML = `<div class="empty-state"><h3>No goals here</h3><p>Add your first team goal above.</p></div>`
    return
  }

  el.innerHTML = HORIZONS.map(h => {
    const goals = byHorizon[h.key]
    if (!goals.length) return ''
    return `
      <div style="margin-bottom:32px">
        <div style="font-size:10px;font-weight:700;letter-spacing:2px;color:var(--muted);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)">${h.label} <span style="font-weight:400;opacity:0.6">${goals.length}</span></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px">
          ${goals.map(g => {
            const statusColor = STATUS_COLORS[g.status] ?? 'var(--accent)'
            const cat         = CATEGORIES[g.category] ?? CATEGORIES.other
            const actionLines = (g.action_steps ?? '').split('\n').map(l => l.trim()).filter(Boolean)
            const isDropped   = g.status === 'dropped'
            return `
            <div class="list-row" style="flex-direction:column;align-items:flex-start;gap:12px;border-left:3px solid ${statusColor};opacity:${isDropped ? 0.5 : 1};cursor:pointer;padding:16px 16px 16px 14px" data-edit="${g.id}">

              <div style="display:flex;justify-content:space-between;align-items:center;width:100%">
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  <span style="font-size:10px;font-weight:700;letter-spacing:0.5px;color:${cat.color};background:${cat.color}18;padding:2px 8px;border-radius:4px">${cat.label}</span>
                  <span style="font-size:10px;font-weight:700;letter-spacing:0.5px;color:${statusColor};background:${statusColor}18;padding:2px 8px;border-radius:4px;text-transform:uppercase">${STATUS_LABELS[g.status] ?? g.status}</span>
                </div>
                <button class="btn btn-ghost" style="font-size:11px;padding:2px 8px;flex-shrink:0" data-edit="${g.id}">Edit</button>
              </div>

              <div style="font-weight:700;font-size:15px;line-height:1.3;color:var(--text)">${g.status === 'completed' ? '✓ ' : ''}${esc(g.title)}</div>

              ${g.owner || g.due_date ? `
              <div style="display:flex;gap:12px;align-items:center">
                ${g.owner    ? `<span style="font-size:12px;color:var(--muted)">· ${esc(g.owner)}</span>` : ''}
                ${g.due_date ? `<span style="font-size:12px;color:var(--muted)">Due ${new Date(g.due_date).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'})}</span>` : ''}
              </div>` : ''}

              ${g.description ? `<div style="font-size:13px;color:var(--muted);line-height:1.5;border-top:1px solid var(--border);padding-top:10px;width:100%">${esc(g.description)}</div>` : ''}

              ${actionLines.length ? `
              <div style="width:100%;border-top:1px solid var(--border);padding-top:10px">
                <div style="font-size:9px;font-weight:700;letter-spacing:1.5px;color:${cat.color};margin-bottom:8px">ACTION STEPS</div>
                ${actionLines.map(l => `
                  <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:5px">
                    <span style="color:${cat.color};font-size:12px;margin-top:1px;flex-shrink:0">›</span>
                    <span style="font-size:13px;color:var(--text);line-height:1.4">${esc(l.replace(/^[•·\-›]\s*/, ''))}</span>
                  </div>`).join('')}
              </div>` : ''}

            </div>`
          }).join('')}
        </div>
      </div>
    `
  }).join('')

  document.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); openModal(e.currentTarget.dataset.edit) }))
}

// ── Modal ──────────────────────────────────────────────────
function openModal(id = null) {
  editingId = id
  const g = id ? allGoals.find(x => x.id === id) : null
  document.getElementById('modal-title').textContent   = id ? 'Edit Goal' : 'Add Goal'
  document.getElementById('f-title').value             = g?.title        ?? ''
  document.getElementById('f-category').value          = g?.category     ?? 'competition'
  document.getElementById('f-owner').value             = g?.owner        ?? ''
  document.getElementById('f-horizon').value           = g?.horizon      ?? 'long_term'
  document.getElementById('f-status').value            = g?.status       ?? 'active'
  document.getElementById('f-due').value               = g?.due_date     ?? ''
  document.getElementById('f-description').value       = g?.description  ?? ''
  document.getElementById('f-actions').value           = g?.action_steps ?? ''
  document.getElementById('delete-btn').style.display  = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display       = 'flex'
}

function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

document.getElementById('add-btn').addEventListener('click', () => openModal())
document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click', closeModal)
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal() })

document.getElementById('save-btn').addEventListener('click', async () => {
  const title        = document.getElementById('f-title').value.trim()
  const category     = document.getElementById('f-category').value
  const owner        = document.getElementById('f-owner').value.trim() || null
  const horizon      = document.getElementById('f-horizon').value
  const status       = document.getElementById('f-status').value
  const due_date     = document.getElementById('f-due').value || null
  const description  = document.getElementById('f-description').value.trim() || null
  const action_steps = document.getElementById('f-actions').value.trim() || null
  const errEl        = document.getElementById('modal-error')
  if (!title) { errEl.textContent = 'Goal title is required.'; errEl.style.display = 'block'; return }

  const payload = { title, category, owner, horizon, status, due_date, description, action_steps, team_id: getTeamId(), updated_at: new Date().toISOString() }
  let error
  if (editingId) {
    ;({ error } = await supabase.from('goals').update(payload).eq('id', editingId))
  } else {
    ;({ error } = await supabase.from('goals').insert(payload))
  }
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  const wasEditing = !!editingId
  closeModal(); toast(wasEditing ? 'Goal updated' : 'Goal added'); loadGoals()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this goal?')) return
  const { error } = await supabase.from('goals').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); toast('Goal deleted'); loadGoals()
})

loadGoals()
