import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'
import { attachTeamAutocomplete, getTeamLogo, teamLogoEl } from './team-autocomplete.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

export function deriveVetoStats(vetos) {
  const total = vetos.length
  let bo1 = 0, bo3 = 0
  const oppCounts = new Map()   // opponent -> { n, firstIdx }
  const banCounts = new Map()   // map -> { n, firstIdx }
  for (let i = 0; i < vetos.length; i++) {
    const v = vetos[i]
    if (v.format === 'bo1') bo1++
    else if (v.format === 'bo3') bo3++
    const opp = v.opponent
    if (opp != null && opp !== '') {
      const e = oppCounts.get(opp)
      if (e) e.n++; else oppCounts.set(opp, { n: 1, firstIdx: i })
    }
    for (const step of v.steps ?? []) {
      if (step.type !== 'ban' || !step.map) continue
      const e = banCounts.get(step.map)
      if (e) e.n++; else banCounts.set(step.map, { n: 1, firstIdx: i })
    }
  }
  function pickTop(counts) {
    let key = null, top = 0, topIdx = Infinity
    for (const [k, { n, firstIdx }] of counts) {
      if (n > top || (n === top && firstIdx < topIdx)) { key = k; top = n; topIdx = firstIdx }
    }
    return key
  }
  return {
    total, bo1, bo3,
    topOpponent: pickTop(oppCounts),
    mostBanned:  pickTop(banCounts),
  }
}

export function filterVetos(vetos, filter) {
  const q = (filter.q ?? '').toLowerCase().trim()
  return vetos.filter(v => {
    if (filter.format   !== 'all' && v.format   !== filter.format)   return false
    if (filter.opponent !== 'all' && (v.opponent ?? '') !== filter.opponent) return false
    if (!q) return true
    if ((v.title    ?? '').toLowerCase().includes(q)) return true
    if ((v.opponent ?? '').toLowerCase().includes(q)) return true
    if ((v.notes    ?? '').toLowerCase().includes(q)) return true
    for (const step of v.steps ?? []) {
      if ((step.map ?? '').toLowerCase().includes(q)) return true
    }
    return false
  })
}

const MAPS = ['ancient','mirage','nuke','anubis','inferno','overpass','dust2']
const MAP_LABELS = { ancient:'Ancient', mirage:'Mirage', nuke:'Nuke', anubis:'Anubis', inferno:'Inferno', overpass:'Overpass', dust2:'Dust2' }
const MAP_IMAGES = { ancient:'images/maps/ancient.png', mirage:'images/maps/mirage.png', nuke:'images/maps/nuke.png', anubis:'images/maps/anubis.png', inferno:'images/maps/inferno.png', overpass:'images/maps/overpass.png', dust2:'images/maps/dust.png' }

const BO1_SEQUENCE = [
  { type:'ban',     team:'away' },
  { type:'ban',     team:'home' },
  { type:'ban',     team:'home' },
  { type:'ban',     team:'away' },
  { type:'ban',     team:'away' },
  { type:'ban',     team:'home' },
  { type:'decider', team:'left' },
]
const BO3_SEQUENCE = [
  { type:'ban',     team:'away' },
  { type:'ban',     team:'home' },
  { type:'pick',    team:'away' },
  { type:'pick',    team:'home' },
  { type:'ban',     team:'away' },
  { type:'ban',     team:'home' },
  { type:'decider', team:'left' },
]

const MAP_IMG = { dust2: 'dust' }
function mapFile(map) { return MAP_IMG[map] ?? map }
function mapBg(map)   { return map ? `images/maps/${mapFile(map)}.png` : '' }

await requireAuth()
renderSidebar('veto')

const FILTER_LS_KEY = 'veto:filter:v1'
const DEFAULT_FILTER = { format: 'all', opponent: 'all', q: '' }
function loadSavedFilter() {
  try { return { ...DEFAULT_FILTER, ...JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '{}') } }
  catch { return { ...DEFAULT_FILTER } }
}
function saveFilter(f) { try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify(f)) } catch {} }

const state = {
  filter: loadSavedFilter(),
  vetos: [],
  logos: [],          // index-aligned with vetos
}
let editingId = null
let vetoSteps = []

const heroEl    = document.getElementById('veto-hero')
const filtersEl = document.getElementById('veto-filters')
const listEl    = document.getElementById('veto-list')

function getSequence() {
  return document.getElementById('f-format').value === 'bo3' ? BO3_SEQUENCE : BO1_SEQUENCE
}

function renderVetoBuilder() {
  const seq = getSequence()
  const home = document.getElementById('f-home').value.trim() || 'Home'
  const away = document.getElementById('f-away').value.trim() || 'Away'
  while (vetoSteps.length < seq.length) vetoSteps.push({ ...seq[vetoSteps.length], map: '' })
  if (vetoSteps.length > seq.length) vetoSteps.length = seq.length
  const usedMaps = vetoSteps.map(s => s.map).filter(Boolean)
  const el = document.getElementById('veto-builder')
  el.innerHTML = `<div style="font-size:11px;font-weight:700;letter-spacing:1px;color:var(--muted);margin-bottom:10px">VETO SEQUENCE</div>
  ${seq.map((step, i) => {
    const teamLabel  = step.team === 'away' ? away : step.team === 'home' ? home : '—'
    const actionLabel = step.type === 'ban' ? 'BAN' : step.type === 'pick' ? 'PICK' : 'PLAYS'
    const actionColor = step.type === 'ban' ? 'var(--danger)' : step.type === 'pick' ? 'var(--success)' : 'var(--accent)'
    if (step.type === 'decider') {
      const leftMap = MAPS.find(m => !usedMaps.slice(0, usedMaps.length - (vetoSteps[i].map ? 1 : 0)).includes(m)) ?? '?'
      return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--border)">
        <span style="width:20px;text-align:center;color:var(--muted);font-size:12px">${i+1}</span>
        <span style="min-width:60px;color:var(--muted);font-size:11px">${esc(teamLabel)}</span>
        <span style="min-width:44px;color:${actionColor};font-size:11px;font-weight:700">${actionLabel}</span>
        <span style="font-size:13px;font-weight:700;color:var(--accent)">${esc(MAP_LABELS[leftMap] ?? leftMap)}</span>
      </div>`
    }
    const availableMaps = MAPS.filter(m => !usedMaps.includes(m) || m === vetoSteps[i]?.map)
    return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--border)">
      <span style="width:20px;text-align:center;color:var(--muted);font-size:12px">${i+1}</span>
      <span style="min-width:60px;color:var(--muted);font-size:11px">${esc(teamLabel)}</span>
      <span style="min-width:44px;color:${actionColor};font-size:11px;font-weight:700">${actionLabel}</span>
      <select class="form-select" style="width:130px;padding:4px 8px;font-size:12px" data-i="${i}">
        <option value="">Pick map…</option>
        ${availableMaps.map(m => `<option value="${m}" ${vetoSteps[i]?.map === m ? 'selected' : ''}>${MAP_LABELS[m]}</option>`).join('')}
      </select>
    </div>`
  }).join('')}`
  el.querySelectorAll('select[data-i]').forEach(sel => sel.addEventListener('change', e => {
    vetoSteps[+e.target.dataset.i].map = e.target.value
    renderVetoBuilder()
  }))
}

async function loadVetos() {
  const { data, error } = await supabase
    .from('veto_predictions').select('*')
    .eq('team_id', getTeamId())
    .order('created_at', { ascending: false })
  if (error) {
    heroEl.innerHTML = ''
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">Failed to load</h3>${esc(error.message)}</div>`
    return
  }
  state.vetos = data ?? []
  state.logos = await Promise.all(state.vetos.map(v => getTeamLogo(v.opponent ?? v.title)))
  renderAll()
}

// ── Hero ──────────────────────────────────────────────────────
function renderHero() {
  const s = deriveVetoStats(state.vetos)
  const wash = s.mostBanned ? mapBg(s.mostBanned) : ''
  heroEl.innerHTML = `
    <div class="dx-hero-grid">
      <div class="dx-hero-left">
        <div class="dx-hero-title">MAP VETO</div>
        <div class="dx-hero-count">${s.total}<span class="dx-hero-count-unit">${s.total === 1 ? ' veto' : ' vetos'}</span></div>
        <div class="dx-hero-substats">
          <div class="dx-kv"><div class="dx-kv-k">BO1</div><div class="dx-kv-v">${s.bo1}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">BO3</div><div class="dx-kv-v">${s.bo3}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Top opponent</div><div class="dx-kv-v">${s.topOpponent ? esc(s.topOpponent) : '—'}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Most banned</div><div class="dx-kv-v">${s.mostBanned ? esc(MAP_LABELS[s.mostBanned] ?? s.mostBanned) : '—'}</div></div>
        </div>
        <div class="dx-hero-actions">
          <button type="button" class="dx-upload-cta" id="new-veto-btn">+ New Veto</button>
        </div>
      </div>
      <div class="dx-hero-right">
        ${wash ? `<div class="dx-hero-mapwash" style="background-image:url('${esc(wash)}')"></div>` : ''}
      </div>
    </div>`
  document.getElementById('new-veto-btn').addEventListener('click', () => openModal())
}

// ── Filters ───────────────────────────────────────────────────
function distinctOpponentsInOrder(vetos) {
  const seen = new Set(), out = []
  for (const v of vetos) {
    const o = v.opponent
    if (o == null || o === '') continue
    if (!seen.has(o)) { seen.add(o); out.push(o) }
  }
  return out
}

function renderFilters() {
  const f = state.filter
  const opps = distinctOpponentsInOrder(state.vetos)
  const fmtPill = (val, label) =>
    `<button type="button" class="dx-pill ${f.format === val ? 'is-active' : ''}" data-group="format" data-val="${esc(val)}">${esc(label)}</button>`
  const oppPill = (val, label) =>
    `<button type="button" class="dx-pill ${f.opponent === val ? 'is-active' : ''}" data-group="opponent" data-val="${esc(val)}">${esc(label)}</button>`

  const oppRow = opps.length >= 1 ? `
    <div class="dx-filter-divider"></div>
    <div class="dx-filter-group">
      ${oppPill('all', 'All Opponents')}
      ${opps.map(o => oppPill(o, o)).join('')}
    </div>` : ''

  filtersEl.innerHTML = `
    <div class="dx-filter-row">
      <div class="dx-filter-group">
        ${fmtPill('all', 'All Formats')}
        ${fmtPill('bo1', 'BO1')}
        ${fmtPill('bo3', 'BO3')}
      </div>
      ${oppRow}
      <div class="dx-filter-spacer"></div>
      <input type="search" class="dx-search-input" id="veto-search" placeholder="Search vetos…" value="${esc(f.q)}"/>
    </div>`

  for (const btn of filtersEl.querySelectorAll('.dx-pill')) {
    btn.addEventListener('click', () => {
      const g = btn.dataset.group, v = btn.dataset.val
      if (state.filter[g] === v) return
      state.filter = { ...state.filter, [g]: v }
      saveFilter(state.filter)
      renderFilters(); renderList()
    })
  }
  document.getElementById('veto-search').addEventListener('input', e => {
    state.filter = { ...state.filter, q: e.target.value }
    saveFilter(state.filter)
    renderList()
  })
}

// ── List ──────────────────────────────────────────────────────
function renderList() {
  const filtered = filterVetos(state.vetos, state.filter)
  if (state.vetos.length === 0) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">No veto predictions yet</h3>Create one with the button above.</div>`
    return
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="dx-empty">No vetos match the current filters.</div>`
    return
  }
  // Index-align logos with the FULL vetos list. After filtering, use original index.
  const vetoIndex = new Map(state.vetos.map((v, i) => [v.id, i]))
  listEl.innerHTML = `<div class="veto-grid">${filtered.map(v => vetoCard(v, state.logos[vetoIndex.get(v.id)])).join('')}</div>`
  for (const btn of listEl.querySelectorAll('[data-edit]')) {
    btn.addEventListener('click', e => { e.stopPropagation(); openModal(btn.dataset.edit) })
  }
}

function vetoCard(v, logo) {
  const steps = (v.steps ?? []).filter(s => s.map)
  const arrowSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>`
  const stepsHtml = steps.map((s, i) => {
    const teamLabel = s.team === 'home' ? (v.home || 'Us') : s.team === 'away' ? (v.away || 'Them') : 'Decider'
    const img = MAP_IMAGES[s.map] ?? ''
    const action = s.type === 'ban' ? 'BAN' : s.type === 'pick' ? 'PICK' : 'PLAYS'
    return `${i > 0 ? `<div class="veto-arrow">${arrowSvg}</div>` : ''}
      <div class="veto-step veto-step-${s.type}">
        ${img ? `<div class="veto-step-bg" style="background-image:url('${img}')"></div>` : ''}
        <div class="veto-step-content">
          <span class="veto-step-num">#${i + 1}</span>
          <span class="veto-step-action veto-step-action-${s.type}">${action}</span>
          <div class="veto-step-map">${esc(MAP_LABELS[s.map] ?? s.map)}</div>
          <div class="veto-step-team">${esc(teamLabel)}</div>
        </div>
      </div>`
  }).join('')
  return `<div class="veto-flow-card">
    <div class="veto-flow-head">
      <div style="display:flex;align-items:center;gap:12px;min-width:0">
        ${teamLogoEl(logo, v.opponent ?? v.title, 40)}
        <div style="min-width:0">
          <div class="veto-flow-title">${esc(v.title)}</div>
          <div class="veto-flow-meta">${v.opponent ? esc(v.opponent) + ' · ' : ''}${v.format.toUpperCase()}</div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" data-edit="${esc(v.id)}">Edit</button>
    </div>
    ${steps.length
      ? `<div class="veto-flow">${stepsHtml}</div>`
      : `<div class="veto-step-empty" style="padding:8px 0">No veto steps recorded.</div>`}
    ${v.notes ? `<div style="color:var(--muted);font-size:12px;margin-top:10px">${esc(v.notes)}</div>` : ''}
  </div>`
}

// ── Modal ─────────────────────────────────────────────────────
function openModal(id = null) {
  editingId = id
  const v = id ? state.vetos.find(x => String(x.id) === String(id)) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Veto' : 'New Veto'
  document.getElementById('f-title').value    = v?.title    ?? ''
  const opp = v?.opponent ?? ''
  document.getElementById('f-opponent').value = opp
  getTeamLogo(opp).then(logo => updateVetoLogo(logo, opp))
  document.getElementById('f-format').value   = v?.format   ?? 'bo1'
  document.getElementById('f-notes').value    = v?.notes    ?? ''
  document.getElementById('f-home').value     = v?.home     ?? 'Us'
  document.getElementById('f-away').value     = v?.away     ?? 'Them'
  vetoSteps = v?.steps ? JSON.parse(JSON.stringify(v.steps)) : []
  document.getElementById('delete-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  renderVetoBuilder()
  document.getElementById('modal').style.display = 'flex'
}
function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click', closeModal)
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal() })
document.getElementById('f-format').addEventListener('change', () => { vetoSteps = []; renderVetoBuilder() })
document.getElementById('f-home').addEventListener('input', renderVetoBuilder)
document.getElementById('f-away').addEventListener('input', renderVetoBuilder)

document.getElementById('save-btn').addEventListener('click', async () => {
  const title    = document.getElementById('f-title').value.trim()
  const opponent = document.getElementById('f-opponent').value.trim() || null
  const format   = document.getElementById('f-format').value
  const notes    = document.getElementById('f-notes').value.trim() || null
  const errEl    = document.getElementById('modal-error')
  if (!title) { errEl.textContent = 'Title is required.'; errEl.style.display = 'block'; return }
  const home = document.getElementById('f-home').value.trim() || 'Us'
  const away = document.getElementById('f-away').value.trim() || 'Them'
  const payload = { title, opponent, format, steps: vetoSteps, notes, home, away, team_id: getTeamId(), updated_at: new Date().toISOString() }
  let error
  if (editingId) ({ error } = await supabase.from('veto_predictions').update(payload).eq('id', editingId))
  else           ({ error } = await supabase.from('veto_predictions').insert(payload))
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  const wasEditing = !!editingId
  closeModal(); toast(wasEditing ? 'Veto updated' : 'Veto saved'); loadVetos()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this veto prediction?')) return
  const { error } = await supabase.from('veto_predictions').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); toast('Veto deleted'); loadVetos()
})

const vetoOppInput    = document.getElementById('f-opponent')
const vetoOppLogoWrap = document.getElementById('veto-opp-logo')

function updateVetoLogo(logo, name) {
  vetoOppLogoWrap.innerHTML = logo || name ? teamLogoEl(logo, name, 36) : ''
}

attachTeamAutocomplete(vetoOppInput, team => updateVetoLogo(team.logo, team.name))

vetoOppInput.addEventListener('input', async () => {
  const n = vetoOppInput.value.trim()
  updateVetoLogo(n ? await getTeamLogo(n) : null, n)
})

function renderAll() { renderHero(); renderFilters(); renderList() }

loadVetos()
