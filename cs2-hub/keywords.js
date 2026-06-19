import { requireAuth } from './auth.js'
import { renderSidebar, renderToolHeader } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

export function deriveKeywordStats(keywords) {
  const total = keywords.length
  if (total === 0) {
    return { total: 0, categoryCount: 0, uncategorized: 0, topCategory: null, latest: null }
  }
  const counts = new Map()       // category -> { n, firstIdx }
  let uncategorized = 0
  for (let i = 0; i < keywords.length; i++) {
    const c = keywords[i].category
    if (c == null || c === '') { uncategorized++; continue }
    const entry = counts.get(c)
    if (entry) entry.n++
    else counts.set(c, { n: 1, firstIdx: i })
  }
  let topCategory = null, topN = 0, topIdx = Infinity
  for (const [cat, { n, firstIdx }] of counts) {
    if (n > topN || (n === topN && firstIdx < topIdx)) {
      topCategory = cat; topN = n; topIdx = firstIdx
    }
  }
  // Latest = name of the keyword with greatest created_at
  let latestRow = keywords[0]
  for (const k of keywords) {
    if ((k.created_at ?? '') > (latestRow.created_at ?? '')) latestRow = k
  }
  return {
    total,
    categoryCount: counts.size,
    uncategorized,
    topCategory,
    latest: latestRow?.name ?? null,
  }
}

export function filterKeywords(keywords, filter) {
  const q = (filter.q ?? '').toLowerCase().trim()
  return keywords.filter(k => {
    if (filter.category !== 'all' && (k.category ?? '') !== filter.category) return false
    if (!q) return true
    return (
      (k.name ?? '').toLowerCase().includes(q) ||
      (k.description ?? '').toLowerCase().includes(q) ||
      (k.category ?? '').toLowerCase().includes(q)
    )
  })
}

await requireAuth()
renderSidebar('keywords')

const FILTER_LS_KEY = 'keywords:filter:v1'
const DEFAULT_FILTER = { category: 'all', q: '' }
function loadSavedFilter() {
  try { return { ...DEFAULT_FILTER, ...JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '{}') } }
  catch { return { ...DEFAULT_FILTER } }
}
function saveFilter(f) { try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify(f)) } catch {} }

const state = {
  filter: loadSavedFilter(),
  keywords: [],
  usage: new Map(),   // keyword id -> { total, strats, issues, where: [labels] }
}
let editingId = null

const heroEl    = document.getElementById('kw-hero')
const filtersEl = document.getElementById('kw-filters')
const listEl    = document.getElementById('keywords-list')

// Count real references to each keyword across the team's strats and issues.
// A keyword is "used" wherever its name appears (case-insensitive) in a strat's
// name/notes/tags or an issue's title/description/actions. No fabricated data —
// 0 references reads as 0.
export function computeUsage(keywords, strats, issues) {
  const stratText = (strats || []).map(s => ({
    label: s.name || 'Strat',
    text: [s.name, s.notes, ...(Array.isArray(s.tags) ? s.tags : [])].join(' \n ').toLowerCase(),
  }))
  const issueText = (issues || []).map(i => ({
    label: i.title || 'Issue',
    text: [i.title, i.description, i.actions].join(' \n ').toLowerCase(),
  }))
  const map = new Map()
  for (const k of keywords) {
    const n = (k.name || '').toLowerCase().trim()
    if (!n) { map.set(k.id, { total: 0, strats: 0, issues: 0, where: [] }); continue }
    const sHits = stratText.filter(s => s.text.includes(n))
    const iHits = issueText.filter(i => i.text.includes(n))
    map.set(k.id, {
      total: sHits.length + iHits.length,
      strats: sHits.length,
      issues: iHits.length,
      where: [...sHits, ...iHits].slice(0, 3).map(x => x.label),
    })
  }
  return map
}

async function loadKeywords() {
  const teamId = getTeamId()
  const [{ data, error }, { data: strats }, { data: issues }] = await Promise.all([
    supabase.from('keywords').select('*').eq('team_id', teamId).order('name', { ascending: true }),
    supabase.from('strats').select('name, notes, tags').eq('team_id', teamId),
    supabase.from('issues').select('title, description, actions').eq('team_id', teamId),
  ])
  if (error) {
    heroEl.innerHTML = ''
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">Failed to load</h3>${esc(error.message)}</div>`
    return
  }
  state.keywords = data ?? []
  state.usage = computeUsage(state.keywords, strats ?? [], issues ?? [])
  renderAll()
}

// ── Hero ──────────────────────────────────────────────────────
function renderHero() {
  const s = deriveKeywordStats(state.keywords)
  let refs = 0, unused = 0
  for (const k of state.keywords) {
    const u = state.usage.get(k.id)?.total || 0
    refs += u
    if (u === 0) unused++
  }
  renderToolHeader(heroEl, {
    section: 'Team',
    title: 'Keywords',
    sub: 'Shared comms vocabulary — strat calls, economy terms and callouts everyone knows.',
    kpis: [
      { v: s.total, k: s.total === 1 ? 'term' : 'terms' },
      { v: s.categoryCount, k: 'categories' },
      { v: refs, k: 'references' },
      { v: unused, k: 'unused', tone: unused ? 'warn' : '' },
      { v: s.topCategory || '—', k: 'top category' },
    ],
    actions: `<button type="button" class="dx-upload-cta" id="add-btn">+ Add Keyword</button>`,
  })
  document.getElementById('add-btn').addEventListener('click', () => openModal())
}

// ── Filters ───────────────────────────────────────────────────
function distinctCategoriesInOrder(keywords) {
  const seen = new Set(), out = []
  for (const k of keywords) {
    const c = k.category
    if (c == null || c === '') continue
    if (!seen.has(c)) { seen.add(c); out.push(c) }
  }
  return out
}

function renderFilters() {
  const f = state.filter
  const cats = distinctCategoriesInOrder(state.keywords)
  const pill = (val, label) =>
    `<button type="button" class="dx-pill ${f.category === val ? 'is-active' : ''}" data-val="${esc(val)}">${esc(label)}</button>`

  filtersEl.innerHTML = `
    <div class="dx-filter-row">
      <div class="dx-filter-group">
        ${pill('all', 'All Categories')}
        ${cats.map(c => pill(c, c)).join('')}
      </div>
      <div class="dx-filter-spacer"></div>
      <input type="search" class="dx-search-input" id="kw-search" placeholder="Search keywords…" value="${esc(f.q)}"/>
    </div>`

  for (const btn of filtersEl.querySelectorAll('.dx-pill')) {
    btn.addEventListener('click', () => {
      const v = btn.dataset.val
      if (state.filter.category === v) return
      state.filter = { ...state.filter, category: v }
      saveFilter(state.filter)
      renderFilters(); renderList()
    })
  }
  document.getElementById('kw-search').addEventListener('input', e => {
    state.filter = { ...state.filter, q: e.target.value }
    saveFilter(state.filter)
    renderList()
  })
}

// ── List ──────────────────────────────────────────────────────
function renderList() {
  const filtered = filterKeywords(state.keywords, state.filter)
  if (state.keywords.length === 0) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">No keywords yet</h3>Define your first term to seed the team glossary.</div>`
    return
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="dx-empty">No keywords match the current filters.</div>`
    return
  }
  // Sort by usage (most-referenced first), then name — surfaces the live
  // vocabulary and pushes orphaned terms to the bottom.
  const sorted = [...filtered].sort((a, b) => {
    const ua = state.usage.get(a.id)?.total || 0
    const ub = state.usage.get(b.id)?.total || 0
    if (ub !== ua) return ub - ua
    return String(a.name).localeCompare(String(b.name))
  })
  listEl.innerHTML = `<div class="kw-grid">${sorted.map(keywordCard).join('')}</div>`
  for (const btn of listEl.querySelectorAll('[data-edit]')) {
    btn.addEventListener('click', e => { e.stopPropagation(); openModal(btn.dataset.edit) })
  }
}

function keywordCard(k) {
  const u = state.usage.get(k.id) || { total: 0, strats: 0, issues: 0, where: [] }
  const parts = []
  if (u.strats) parts.push(`${u.strats} strat${u.strats === 1 ? '' : 's'}`)
  if (u.issues) parts.push(`${u.issues} issue${u.issues === 1 ? '' : 's'}`)
  const usageChip = u.total
    ? `<span class="kw-usage" title="${esc(u.where.join(', '))}"><b>${u.total}×</b> used</span>`
    : `<span class="kw-usage kw-usage-0">Unused</span>`
  return `
    <div class="kw-card${u.total ? '' : ' kw-card-unused'}">
      <div class="kw-card-head">
        <div class="kw-card-name">${esc(k.name)}</div>
        <button type="button" class="btn btn-ghost btn-sm" data-edit="${esc(k.id)}">Edit</button>
      </div>
      <div class="kw-card-tags">
        ${k.category ? `<span class="kw-card-cat">${esc(k.category)}</span>` : ''}
        ${usageChip}
      </div>
      <div class="kw-card-desc">${esc(k.description)}</div>
      ${parts.length ? `<div class="kw-card-where">Referenced in ${parts.join(' · ')}${u.where.length ? ` — ${esc(u.where.join(', '))}` : ''}</div>` : ''}
    </div>`
}

// ── Modal ─────────────────────────────────────────────────────
function openModal(id = null) {
  editingId = id
  const k = id ? state.keywords.find(x => String(x.id) === String(id)) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Keyword' : 'Add Keyword'
  document.getElementById('f-name').value        = k?.name        ?? ''
  document.getElementById('f-category').value    = k?.category    ?? ''
  document.getElementById('f-description').value = k?.description ?? ''
  document.getElementById('delete-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display = 'flex'
}
function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click', closeModal)
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal() })

document.getElementById('save-btn').addEventListener('click', async () => {
  const name        = document.getElementById('f-name').value.trim()
  const category    = document.getElementById('f-category').value.trim() || null
  const description = document.getElementById('f-description').value.trim()
  const errEl       = document.getElementById('modal-error')
  if (!name)        { errEl.textContent = 'Keyword name is required.'; errEl.style.display = 'block'; return }
  if (!description) { errEl.textContent = 'Description is required.';  errEl.style.display = 'block'; return }
  const payload = { name, category, description, team_id: getTeamId() }
  let error
  if (editingId) ({ error } = await supabase.from('keywords').update(payload).eq('id', editingId))
  else           ({ error } = await supabase.from('keywords').insert(payload))
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  const wasEditing = !!editingId
  closeModal(); toast(wasEditing ? 'Keyword updated' : 'Keyword added'); loadKeywords()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this keyword?')) return
  const { error } = await supabase.from('keywords').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); toast('Keyword deleted'); loadKeywords()
})

function renderAll() { renderHero(); renderFilters(); renderList() }

loadKeywords()
