import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('goals')

const HORIZONS = [
  { key: 'long_term', label: 'LONG TERM' },
  { key: 'monthly',   label: 'MONTHLY' },
  { key: 'weekly',    label: 'WEEKLY' },
]

const STATUS_COLORS = { active: 'var(--accent)', completed: 'var(--success)', dropped: 'var(--muted)' }

const CATEGORIES = {
  competition:   { label: 'Competition',    color: '#4ade80' },
  strategy:      { label: 'Strategy',       color: '#60a5fa' },
  aim:           { label: 'Aim & Mech',     color: '#f87171' },
  communication: { label: 'Communication',  color: '#a78bfa' },
  mental:        { label: 'Mental',         color: '#facc15' },
  other:         { label: 'Other',          color: '#64748b' },
}

let allGoals  = []
let editingId = null

// ── Weekly Focus ───────────────────────────────────────────
let focusItems = []

async function loadFocus() {
  const { data } = await supabase.from('focus_items').select('*').eq('team_id', getTeamId()).order('created_at', { ascending: true })
  focusItems = data ?? []
  renderFocus()
}

function renderFocus() {
  const el = document.getElementById('focus-list')
  const empty = document.getElementById('focus-empty')
  if (!focusItems.length) {
    empty.style.display = 'block'
    el.innerHTML = ''
    el.appendChild(empty)
    return
  }
  empty.style.display = 'none'
  el.innerHTML = focusItems.map(f => `
    <div style="display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 12px;max-width:360px">
      <span style="font-size:13px;flex:1;color:var(--text)">${esc(f.text)}</span>
      <button style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:0;line-height:1" data-focus-id="${f.id}">×</button>
    </div>
  `).join('')
  el.querySelectorAll('[data-focus-id]').forEach(btn => btn.addEventListener('click', async () => {
    await supabase.from('focus_items').delete().eq('id', btn.dataset.focusId)
    loadFocus()
  }))
}

document.getElementById('add-focus-btn').addEventListener('click', () => {
  document.getElementById('focus-input-row').style.display = 'block'
  document.getElementById('focus-input').focus()
})

document.getElementById('focus-cancel-btn').addEventListener('click', () => {
  document.getElementById('focus-input-row').style.display = 'none'
  document.getElementById('focus-input').value = ''
})

async function saveFocusItem() {
  const text = document.getElementById('focus-input').value.trim()
  if (!text) return
  await supabase.from('focus_items').insert({ team_id: getTeamId(), text })
  document.getElementById('focus-input').value = ''
  document.getElementById('focus-input-row').style.display = 'none'
  loadFocus()
}

document.getElementById('focus-save-btn').addEventListener('click', saveFocusItem)
document.getElementById('focus-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveFocusItem() })

// ── Goals ──────────────────────────────────────────────────
document.getElementById('f-progress').addEventListener('input', e => {
  document.getElementById('progress-val').textContent = e.target.value
})

async function loadGoals() {
  const { data, error } = await supabase.from('goals').select('*').eq('team_id', getTeamId()).order('created_at', { ascending: false })
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
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;margin-bottom:28px">
        ${goals.map(g => {
          const statusColor = STATUS_COLORS[g.status] ?? 'var(--accent)'
          const cat = CATEGORIES[g.category] ?? CATEGORIES.other
          const actionLines = (g.action_steps ?? '').split('\n').map(l => l.trim()).filter(Boolean)
          return `
          <div class="list-row" style="flex-direction:column;align-items:flex-start;gap:10px;opacity:${g.status === 'dropped' ? 0.5 : 1};border-left:3px solid ${statusColor};cursor:pointer" data-edit="${g.id}">
            <div style="display:flex;justify-content:space-between;width:100%;align-items:flex-start;gap:8px">
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                <span style="font-size:10px;font-weight:700;letter-spacing:0.5px;color:${cat.color};background:${cat.color}18;padding:2px 8px;border-radius:4px">${cat.label}</span>
                ${g.owner ? `<span style="font-size:10px;color:var(--muted);font-weight:600">· ${esc(g.owner)}</span>` : ''}
              </div>
              <button class="btn btn-ghost" style="font-size:11px;padding:2px 8px;flex-shrink:0" data-edit="${g.id}">Edit</button>
            </div>
            <div style="font-weight:700;font-size:14px;width:100%">${g.status === 'completed' ? '✓ ' : ''}${esc(g.title)}</div>
            <div style="display:flex;align-items:center;gap:8px;width:100%">
              <div style="flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden">
                <div style="height:100%;width:${g.progress ?? 0}%;background:${statusColor};border-radius:3px"></div>
              </div>
              <span style="font-size:11px;color:var(--muted);min-width:30px">${g.progress ?? 0}%</span>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <span style="font-size:10px;font-weight:700;letter-spacing:0.8px;color:${statusColor};background:${statusColor}18;padding:2px 8px;border-radius:4px;text-transform:uppercase">${g.status}</span>
              ${g.due_date ? `<span style="font-size:11px;color:var(--muted)">Due ${new Date(g.due_date).toLocaleDateString('en-GB', {day:'numeric',month:'short'})}</span>` : ''}
            </div>
            ${g.description ? `<div style="color:var(--muted);font-size:12px;width:100%">${esc(g.description)}</div>` : ''}
            ${actionLines.length ? `
              <div style="width:100%;background:var(--bg);border-left:2px solid ${cat.color};border-radius:0 4px 4px 0;padding:8px 10px">
                <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:${cat.color};margin-bottom:5px">ACTIONS</div>
                ${actionLines.map(l => `<div style="font-size:12px;color:var(--text);margin-bottom:2px">· ${esc(l.replace(/^[•·-]\s*/, ''))}</div>`).join('')}
              </div>
            ` : ''}
          </div>`
        }).join('')}
      </div>
    `
  }).join('')

  document.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); openModal(e.currentTarget.dataset.edit) }))
}

function openModal(id = null) {
  editingId = id
  const g = id ? allGoals.find(x => x.id === id) : null
  document.getElementById('modal-title').textContent     = id ? 'Edit Goal' : 'Add Goal'
  document.getElementById('f-title').value               = g?.title        ?? ''
  document.getElementById('f-category').value            = g?.category     ?? 'competition'
  document.getElementById('f-owner').value               = g?.owner        ?? ''
  document.getElementById('f-horizon').value             = g?.horizon      ?? 'long_term'
  document.getElementById('f-status').value              = g?.status       ?? 'active'
  document.getElementById('f-progress').value            = g?.progress     ?? 0
  document.getElementById('progress-val').textContent    = g?.progress     ?? 0
  document.getElementById('f-due').value                 = g?.due_date     ?? ''
  document.getElementById('f-description').value         = g?.description  ?? ''
  document.getElementById('f-actions').value             = g?.action_steps ?? ''
  document.getElementById('delete-btn').style.display    = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display   = 'none'
  document.getElementById('modal').style.display         = 'flex'
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
  const progress     = +document.getElementById('f-progress').value
  const due_date     = document.getElementById('f-due').value || null
  const description  = document.getElementById('f-description').value.trim() || null
  const action_steps = document.getElementById('f-actions').value.trim() || null
  const errEl        = document.getElementById('modal-error')
  if (!title) { errEl.textContent = 'Goal title is required.'; errEl.style.display = 'block'; return }

  const payload = { title, category, owner, horizon, status, progress, due_date, description, action_steps, team_id: getTeamId(), updated_at: new Date().toISOString() }
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
loadFocus()
