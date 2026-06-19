import { requireAuth } from './auth.js'
import { renderSidebar, renderToolHeader } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function relTime(iso) {
  if (!iso) return ''
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (d < 1) return 'today'
  if (d < 30) return `${d}d ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

await requireAuth()
renderSidebar('issues')

const PRIORITY_META = {
  high:   { label: 'High',   color: 'var(--danger)' },
  medium: { label: 'Medium', color: 'var(--warning)' },
  low:    { label: 'Low',    color: 'var(--muted)' },
}
const STATUS_META = {
  active:    { label: 'Active',    color: 'var(--danger)' },
  improving: { label: 'Improving', color: 'var(--warning)' },
  resolved:  { label: 'Resolved',  color: 'var(--success)' },
}
const CAT_META = {
  tactical:      { label: 'Tactical',      color: 'var(--accent)' },
  communication: { label: 'Communication', color: 'var(--special)' },
  mental:        { label: 'Mental',        color: 'var(--warning)' },
  individual:    { label: 'Individual',    color: 'var(--success)' },
  teamplay:      { label: 'Teamplay',      color: '#06b6d4' },
  other:         { label: 'Other',         color: 'var(--muted)' },
}

const FILTER_LS_KEY = 'issues:filter:v1'
const DEFAULT_FILTER = { status: 'all', priority: 'all', category: 'all', q: '' }
function loadSavedFilter() {
  try { return { ...DEFAULT_FILTER, ...JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '{}') } }
  catch { return { ...DEFAULT_FILTER } }
}
function saveFilter(f) { try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify(f)) } catch {} }

const state = {
  filter: loadSavedFilter(),
  issues: [],
}

let editingId = null

const heroEl    = document.getElementById('iss-hero')
const filtersEl = document.getElementById('iss-filters')
const listEl    = document.getElementById('issues-list')

async function loadIssues() {
  const { data, error } = await supabase
    .from('issues').select('*')
    .eq('team_id', getTeamId())
    .order('priority').order('created_at', { ascending: false })
  if (error) {
    listEl.innerHTML = `<div class="empty-state"><h3>Failed to load issues</h3><p>${esc(error.message)}</p></div>`
    return
  }
  state.issues = data ?? []
  renderAll()
}

function getFiltered() {
  const f = state.filter
  const q = f.q.toLowerCase().trim()
  return state.issues.filter(i =>
    (f.status   === 'all' || i.status   === f.status)   &&
    (f.priority === 'all' || i.priority === f.priority) &&
    (f.category === 'all' || i.category === f.category) &&
    (!q || i.title?.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q))
  )
}

// ── Hero ──────────────────────────────────────────────────────
function renderHero() {
  const all = state.issues
  const total     = all.length
  const high      = all.filter(i => i.priority === 'high' && i.status !== 'resolved').length
  const medium    = all.filter(i => i.priority === 'medium' && i.status !== 'resolved').length
  const low       = all.filter(i => i.priority === 'low' && i.status !== 'resolved').length
  const active    = all.filter(i => i.status === 'active').length
  const improving = all.filter(i => i.status === 'improving').length
  const resolved  = all.filter(i => i.status === 'resolved').length
  const open      = active + improving

  renderToolHeader(heroEl, {
    section: 'Team',
    title: 'Issues',
    sub: 'Problems the team is working on — tracked from spotted to resolved.',
    kpis: [
      { v: open, k: 'open' },
      { v: high, k: 'high', tone: high ? 'bad' : '' },
      { v: medium, k: 'medium', tone: medium ? 'warn' : '' },
      { v: low, k: 'low' },
      { v: improving, k: 'improving', tone: improving ? 'warn' : '' },
      { v: resolved, k: 'resolved', tone: resolved ? 'good' : '' },
    ],
    actions: `<button type="button" class="dx-upload-cta" id="iss-add-btn">+ New Issue</button>`,
  })

  document.getElementById('iss-add-btn').addEventListener('click', () => openModal())
}

// ── Filters ───────────────────────────────────────────────────
function renderFilters() {
  const f = state.filter
  const pill = (group, val, label, extraCls = '') =>
    `<button type="button" class="dx-pill ${extraCls} ${f[group] === val ? 'is-active' : ''}" data-group="${group}" data-val="${esc(val)}">${esc(label)}</button>`

  filtersEl.innerHTML = `
    <div class="dx-filter-row">
      <div class="dx-filter-group">
        ${pill('status', 'all', 'All')}
        ${pill('status', 'active',    'Active')}
        ${pill('status', 'improving', 'Improving')}
        ${pill('status', 'resolved',  'Resolved')}
      </div>
      <div class="dx-filter-divider"></div>
      <div class="dx-filter-group">
        ${pill('priority', 'all',    'Any Priority')}
        ${pill('priority', 'high',   'High')}
        ${pill('priority', 'medium', 'Medium')}
        ${pill('priority', 'low',    'Low')}
      </div>
    </div>
    <div class="dx-filter-row" style="margin-top:8px">
      <div class="dx-filter-group">
        ${pill('category', 'all', 'All Categories')}
        ${Object.entries(CAT_META).map(([k, v]) => pill('category', k, v.label)).join('')}
      </div>
      <div class="dx-filter-spacer"></div>
      <input type="search" class="dx-search-input" id="iss-search" placeholder="Search issues…" value="${esc(f.q)}"/>
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
  document.getElementById('iss-search').addEventListener('input', e => {
    state.filter = { ...state.filter, q: e.target.value }
    saveFilter(state.filter)
    renderList()
  })
}

// ── List ──────────────────────────────────────────────────────
function renderList() {
  const filtered = getFiltered()
  if (state.issues.length === 0) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">No issues yet</h3>Track what your team needs to fix.</div>`
    return
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="dx-empty">No issues match the current filters.</div>`
    return
  }
  listEl.innerHTML = `<div class="iss-grid">${filtered.map(issueCard).join('')}</div>`
  for (const btn of listEl.querySelectorAll('[data-edit]')) {
    btn.addEventListener('click', e => { e.stopPropagation(); openModal(e.currentTarget.dataset.edit) })
  }
}

function issueCard(i) {
  const prio   = PRIORITY_META[i.priority] ?? { label: i.priority, color: 'var(--muted)' }
  const status = STATUS_META[i.status]     ?? { label: i.status,   color: 'var(--muted)' }
  const cat    = CAT_META[i.category]      ?? { label: i.category, color: 'var(--muted)' }
  const resolved = i.status === 'resolved'
  const age = relTime(i.created_at)
  return `
    <div class="iss-card iss-card-${i.priority}${resolved ? ' iss-card-resolved' : ''}" data-edit="${esc(i.id)}">
      <div class="iss-card-head">
        <span class="iss-badge" style="color:${prio.color};background:${prio.color}1f">${esc(prio.label)}</span>
        <span class="iss-badge" style="color:${status.color};background:${status.color}1f">${esc(status.label)}</span>
        <span class="iss-badge" style="color:${cat.color};background:${cat.color}1f">${esc(cat.label)}</span>
        ${age ? `<span class="iss-age">Spotted ${esc(age)}</span>` : ''}
        <span class="iss-edit-hint">Edit ›</span>
      </div>
      <div class="iss-card-title">${esc(i.title)}</div>
      ${i.description ? `
        <div class="iss-block">
          <span class="iss-block-label">Why it matters</span>
          <div class="iss-block-body">${esc(i.description)}</div>
        </div>` : ''}
      ${i.actions ? `
        <div class="iss-card-actions">
          <div class="iss-card-actions-label">Suggested fix</div>
          <div class="iss-card-actions-body">${esc(i.actions)}</div>
        </div>` : ''}
    </div>`
}

function renderAll() {
  renderHero()
  renderFilters()
  renderList()
}

// ── Modal (preserved) ─────────────────────────────────────────
function openModal(id = null) {
  editingId = id
  const i = id ? state.issues.find(x => x.id === id) : null
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
  const wasEditing = !!editingId
  closeModal(); toast(wasEditing ? 'Issue updated' : 'Issue added'); loadIssues()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this issue?')) return
  const { error } = await supabase.from('issues').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); toast('Issue deleted'); loadIssues()
})

loadIssues()
