import { requireAuth } from './auth.js'
import { renderSidebar, renderToolHeader } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('goals')

const HORIZONS = [
  { key: 'long_term', label: 'Long Term' },
  { key: 'monthly',   label: 'Monthly' },
  { key: 'weekly',    label: 'Weekly' },
]

const STATUS_META = {
  active:    { label: 'Active',    color: 'var(--accent)' },
  completed: { label: 'Completed', color: 'var(--success)' },
  dropped:   { label: 'Dropped',   color: 'var(--muted)' },
}

const CATEGORIES = {
  competition:   { label: 'Competition',   color: '#4ade80' },
  strategy:      { label: 'Strategy',      color: '#60a5fa' },
  aim:           { label: 'Aim & Mech',    color: '#f87171' },
  communication: { label: 'Communication', color: '#c084fc' },
  mental:        { label: 'Mental',        color: '#facc15' },
  other:         { label: 'Other',         color: '#64748b' },
}

// Honest, derived goal state: completed/dropped from status; for active goals
// a "deadline" progress = elapsed fraction of the created→due window (NOT a
// fabricated completion %), and on-track / overdue from the due date.
function deriveGoalState(g, now = Date.now()) {
  if (g.status === 'completed') return { label: 'Completed', color: 'var(--success)', progress: 100, note: 'Done' }
  if (g.status === 'dropped')   return { label: 'Dropped', color: 'var(--muted)', progress: null, note: '' }
  const due   = g.due_date   ? new Date(g.due_date).getTime()   : null
  const start = g.created_at ? new Date(g.created_at).getTime() : null
  let progress = null, daysLeft = null
  if (due != null) {
    daysLeft = Math.ceil((due - now) / 86_400_000)
    if (start != null && due > start) progress = Math.max(0, Math.min(100, Math.round(((now - start) / (due - start)) * 100)))
  }
  if (daysLeft != null && daysLeft < 0)
    return { label: 'Overdue', color: 'var(--danger)', progress: 100, note: `${Math.abs(daysLeft)}d overdue`, atRisk: true }
  return { label: 'On track', color: 'var(--success)', progress, daysLeft, note: daysLeft != null ? `${daysLeft}d left` : 'No deadline' }
}

const FILTER_LS_KEY = 'goals:filter:v1'
const DEFAULT_FILTER = { horizon: 'all', status: 'active', category: 'all', q: '' }
function loadSavedFilter() {
  try { return { ...DEFAULT_FILTER, ...JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '{}') } }
  catch { return { ...DEFAULT_FILTER } }
}
function saveFilter(f) { try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify(f)) } catch {} }

const state = {
  filter: loadSavedFilter(),
  goals: [],
}
let editingId = null

const heroEl    = document.getElementById('gl-hero')
const filtersEl = document.getElementById('gl-filters')
const listEl    = document.getElementById('goals-container')

async function loadGoals() {
  const { data, error } = await supabase
    .from('goals').select('*')
    .eq('team_id', getTeamId())
    .order('created_at', { ascending: false })
  if (error) {
    listEl.innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${esc(error.message)}</p></div>`
    return
  }
  state.goals = data ?? []
  renderAll()
}

function getFiltered() {
  const f = state.filter
  const q = f.q.toLowerCase().trim()
  return state.goals.filter(g =>
    (f.horizon  === 'all' || g.horizon  === f.horizon)  &&
    (f.status   === 'all' || g.status   === f.status)   &&
    (f.category === 'all' || g.category === f.category) &&
    (!q || g.title?.toLowerCase().includes(q) || g.description?.toLowerCase().includes(q))
  )
}

// ── Hero ──────────────────────────────────────────────────────
function renderHero() {
  const all = state.goals
  const total     = all.length
  const active    = all.filter(g => g.status === 'active').length
  const completed = all.filter(g => g.status === 'completed').length
  const completionPct = total ? Math.round((completed / total) * 100) : 0
  const overdue = all.filter(g => g.status === 'active' && g.due_date && new Date(g.due_date).getTime() < Date.now()).length

  const upcoming = all
    .filter(g => g.status === 'active' && g.due_date)
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))[0]
  const upcomingLabel = upcoming
    ? `${upcoming.title} · ${new Date(upcoming.due_date).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}`
    : '—'

  renderToolHeader(heroEl, {
    section: 'Team',
    title: 'Goals',
    sub: 'Long-term, monthly and weekly targets the whole team can see.',
    kpis: [
      { v: active, k: 'active' },
      { v: `${completionPct}%`, k: 'completion', tone: completionPct >= 50 ? 'good' : '' },
      { v: completed, k: 'completed', tone: completed ? 'good' : '' },
      { v: overdue, k: 'overdue', tone: overdue ? 'bad' : '' },
      { v: upcomingLabel, k: 'next milestone' },
    ],
    actions: `<button type="button" class="dx-upload-cta" id="gl-add-btn">+ New Goal</button>`,
  })

  document.getElementById('gl-add-btn').addEventListener('click', () => openModal())
}

// ── Filters ───────────────────────────────────────────────────
function renderFilters() {
  const f = state.filter
  const pill = (group, val, label, extraCls = '') =>
    `<button type="button" class="dx-pill ${extraCls} ${f[group] === val ? 'is-active' : ''}" data-group="${group}" data-val="${esc(val)}">${esc(label)}</button>`

  filtersEl.innerHTML = `
    <div class="dx-filter-row">
      <div class="dx-filter-group">
        ${pill('horizon', 'all', 'All Horizons')}
        ${HORIZONS.map(h => pill('horizon', h.key, h.label)).join('')}
      </div>
      <div class="dx-filter-divider"></div>
      <div class="dx-filter-group">
        ${pill('status', 'all',       'All')}
        ${pill('status', 'active',    'Active')}
        ${pill('status', 'completed', 'Completed')}
        ${pill('status', 'dropped',   'Dropped')}
      </div>
    </div>
    <div class="dx-filter-row" style="margin-top:8px">
      <div class="dx-filter-group">
        ${pill('category', 'all', 'All Categories')}
        ${Object.entries(CATEGORIES).map(([k, v]) => pill('category', k, v.label)).join('')}
      </div>
      <div class="dx-filter-spacer"></div>
      <input type="search" class="dx-search-input" id="gl-search" placeholder="Search goals…" value="${esc(f.q)}"/>
    </div>`

  for (const btn of filtersEl.querySelectorAll('.dx-pill')) {
    btn.addEventListener('click', () => {
      const g = btn.dataset.group, v = btn.dataset.val
      if (state.filter[g] === v) return
      state.filter = { ...state.filter, [g]: v }
      saveFilter(state.filter)
      renderFilters()
      renderList()
    })
  }
  document.getElementById('gl-search').addEventListener('input', e => {
    state.filter = { ...state.filter, q: e.target.value }
    saveFilter(state.filter)
    renderList()
  })
}

// ── List ──────────────────────────────────────────────────────
function renderList() {
  const filtered = getFiltered()
  if (state.goals.length === 0) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">No goals yet</h3>Set your first team objective.</div>`
    return
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="dx-empty">No goals match the current filters.</div>`
    return
  }

  // Group by horizon (or flat if a horizon filter is applied)
  const f = state.filter
  if (f.horizon === 'all') {
    listEl.innerHTML = HORIZONS.map(h => {
      const goals = filtered.filter(g => g.horizon === h.key)
      if (!goals.length) return ''
      return `
        <div class="gl-section">
          <div class="gl-section-head">
            <span class="gl-section-title">${h.label}</span>
            <span class="gl-section-count">${goals.length}</span>
          </div>
          <div class="gl-grid">${goals.map(goalCard).join('')}</div>
        </div>`
    }).join('')
  } else {
    listEl.innerHTML = `<div class="gl-grid">${filtered.map(goalCard).join('')}</div>`
  }

  for (const card of listEl.querySelectorAll('[data-edit]')) {
    card.addEventListener('click', e => { e.stopPropagation(); openModal(e.currentTarget.dataset.edit) })
  }
}

function goalCard(g) {
  const st  = deriveGoalState(g)
  const cat = CATEGORIES[g.category] ?? CATEGORIES.other
  const actionLines = (g.action_steps ?? g.actions ?? '').split('\n')
    .map(l => l.trim().replace(/^[•·\-›]\s*/, '')).filter(Boolean)
  const nextAction = actionLines[0]
  const rest = actionLines.slice(1)
  const dropped   = g.status === 'dropped'
  const completed = g.status === 'completed'

  const bar = (st.progress != null && !dropped) ? `
    <div class="gl-deadline">
      <div class="gl-deadline-track"><div class="gl-deadline-fill" style="width:${st.progress}%;background:${st.color}"></div></div>
      <span class="gl-deadline-note" style="color:${st.color}">${esc(st.note)}</span>
    </div>` : ''

  return `
    <div class="gl-card${dropped ? ' gl-card-dropped' : ''}${completed ? ' gl-card-completed' : ''}" style="border-left-color:${cat.color}" data-edit="${esc(g.id)}">
      <div class="gl-card-head">
        <span class="gl-badge" style="color:${cat.color};background:${cat.color}1f">${esc(cat.label)}</span>
        <span class="gl-badge" style="color:${st.color};background:${st.color}1f">${esc(st.label)}</span>
        <span class="gl-edit-hint">Edit ›</span>
      </div>
      <div class="gl-card-title">${completed ? '✓ ' : ''}${esc(g.title)}</div>
      ${g.owner || g.due_date ? `
        <div class="gl-card-meta">
          ${g.owner    ? `<span class="gl-card-meta-item">${esc(g.owner)}</span>` : ''}
          ${g.due_date ? `<span class="gl-card-meta-item">Due ${new Date(g.due_date).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'})}</span>` : ''}
        </div>` : ''}
      ${bar}
      ${g.description ? `<div class="gl-card-why"><span class="gl-card-why-label">Why it matters</span>${esc(g.description)}</div>` : ''}
      ${nextAction ? `
        <div class="gl-next">
          <span class="gl-next-label" style="color:${cat.color}">Next action</span>
          <span class="gl-next-text">${esc(nextAction)}</span>
        </div>` : ''}
      ${rest.length ? `
        <div class="gl-card-actions">
          ${rest.map(l => `
            <div class="gl-card-action">
              <span class="gl-card-action-arrow" style="color:${cat.color}">›</span>
              <span>${esc(l)}</span>
            </div>`).join('')}
        </div>` : ''}
    </div>`
}

function renderAll() {
  renderHero()
  renderFilters()
  renderList()
}

// ── Modal (preserved) ─────────────────────────────────────────
// Roster fetched once for the player dropdown (#59). Failures are
// silent — the option just stays at "Team-wide goal".
let _rosterForGoals = null
async function ensureRosterForGoals() {
  if (_rosterForGoals !== null) return _rosterForGoals
  try {
    const { data } = await supabase
      .from('roster')
      .select('id, nickname, role')
      .eq('team_id', getTeamId())
      .order('nickname', { ascending: true })
    _rosterForGoals = data ?? []
  } catch { _rosterForGoals = [] }
  const sel = document.getElementById('f-player')
  if (sel) {
    sel.innerHTML = `<option value="">Team-wide goal</option>` +
      _rosterForGoals.map(p =>
        `<option value="${p.id}">${esc(p.nickname)}${p.role ? ` · ${esc(p.role)}` : ''}</option>`
      ).join('')
  }
  return _rosterForGoals
}

function openModal(id = null) {
  editingId = id
  const g = id ? state.goals.find(x => x.id === id) : null
  document.getElementById('modal-title').textContent   = id ? 'Edit Goal' : 'Add Goal'
  document.getElementById('f-title').value             = g?.title        ?? ''
  document.getElementById('f-category').value          = g?.category     ?? 'competition'
  document.getElementById('f-owner').value             = g?.owner        ?? ''
  document.getElementById('f-horizon').value           = g?.horizon      ?? 'long_term'
  document.getElementById('f-status').value            = g?.status       ?? 'active'
  document.getElementById('f-due').value               = g?.due_date     ?? ''
  document.getElementById('f-description').value       = g?.description  ?? ''
  document.getElementById('f-actions').value           = g?.action_steps ?? ''
  // Populate the roster dropdown lazily; pre-select the saved player_id
  // if this is an edit.
  ensureRosterForGoals().then(() => {
    const sel = document.getElementById('f-player')
    if (sel) sel.value = g?.player_id ?? ''
  })
  document.getElementById('delete-btn').style.display  = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display       = 'flex'
}

function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

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

  const player_id = document.getElementById('f-player')?.value || null
  const payload = { title, category, owner, horizon, status, due_date, description, action_steps, team_id: getTeamId(), updated_at: new Date().toISOString() }
  if (player_id) payload.player_id = player_id
  else payload.player_id = null
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
