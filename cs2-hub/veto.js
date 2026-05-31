import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'
import { attachTeamAutocomplete, getTeamLogo, teamLogoEl } from './team-autocomplete.js'
import { fetchTeamVetoHistory, renderVetoSimulator, computeStats, savedVetoToHltvShape } from './veto-simulator.js'

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

// MAPS / sequence constants now live in veto-simulator.js (used by the
// editable sequence renderer). Only constants the saved-veto card display
// still needs are kept below.
const MAP_LABELS = { ancient:'Ancient', mirage:'Mirage', nuke:'Nuke', anubis:'Anubis', inferno:'Inferno', overpass:'Overpass', dust2:'Dust2' }
const MAP_IMAGES = { ancient:'images/maps/ancient.png', mirage:'images/maps/mirage.png', nuke:'images/maps/nuke.png', anubis:'images/maps/anubis.png', inferno:'images/maps/inferno.png', overpass:'images/maps/overpass.png', dust2:'images/maps/dust.png' }

const MAP_IMG = { dust2: 'dust' }
function mapFile(map) { return MAP_IMG[map] ?? map }
function mapBg(map)   { return map ? `images/maps/${mapFile(map)}.png` : '' }

await requireAuth()
renderSidebar('veto')

// Our team's name — used to (a) display "Us" rows with the real name and
// (b) pull our own HLTV veto history so the simulator can predict OUR
// bans/picks too. Falls back to "Us" when the user isn't on a team or the
// teams row is missing.
let ourTeamName = 'Us'
let ourHltvVetos = []
let ourStats     = null  // computeStats output for our team (HLTV + saved)

try {
  const tid = getTeamId()
  if (tid) {
    const { data: t } = await supabase.from('teams').select('name').eq('id', tid).maybeSingle()
    if (t?.name) ourTeamName = t.name
  }
} catch (e) { console.warn('[veto] team-name load failed', e) }

async function loadOurHltvVetos() {
  if (!ourTeamName || ourTeamName === 'Us') { ourHltvVetos = []; return }
  try {
    const safe = ourTeamName.replace(/[(),]/g, '').trim()
    if (!safe) { ourHltvVetos = []; return }
    const { data, error } = await supabase
      .from('hltv_team_vetos')
      .select('match_id, played_at, team_a_name, team_b_name, format, sequence')
      .or(`team_a_name.ilike.${safe},team_b_name.ilike.${safe}`)
      .order('played_at', { ascending: false })
      .limit(200)
    if (error) throw error
    ourHltvVetos = data ?? []
  } catch (e) { console.warn('[veto] our hltv vetos load failed', e); ourHltvVetos = [] }
}

function recomputeOurStats() {
  // Combine HLTV history (when present) with our existing saved veto rows.
  // savedVetoToHltvShape converts a saved row into the same {sequence} shape
  // so computeStats can ingest both feeds in one pass.
  const combined = [
    ...ourHltvVetos,
    ...state.vetos.map(v => savedVetoToHltvShape(v, ourTeamName)),
  ]
  if (!combined.length) { ourStats = null; return }
  ourStats = computeStats(combined, ourTeamName)
  if (ourStats && !ourStats.totalMatches) ourStats = null
}

await loadOurHltvVetos()

// ── Veto simulator wiring ──────────────────────────────────────
// The Simulate-veto-for panel doubles as the create/edit form. Loading an
// existing card → re-runs the simulator for that team and pre-populates the
// editable sequence with the saved steps; Save updates instead of inserts.
const vsInput  = document.getElementById('vs-team-input')
const vsStatus = document.getElementById('vs-status')
const vsResult = document.getElementById('vs-result')
let vsToken = 0
let vsTypingTimer = null
let vsEditingVeto = null   // veto row when re-opening for edit

async function saveFromSimulator({ format, steps, title, notes, opponent, editingId }) {
  const payload = {
    title:    title || `vs ${opponent}`,
    opponent: opponent || null,
    format,
    steps,
    notes,
    home:     'Us',
    away:     'Them',
    team_id:  getTeamId(),
    updated_at: new Date().toISOString(),
  }
  let error
  if (editingId) ({ error } = await supabase.from('veto_predictions').update(payload).eq('id', editingId))
  else           ({ error } = await supabase.from('veto_predictions').insert(payload))
  if (error) throw error
  toast(editingId ? 'Veto updated' : 'Veto saved')
  vsEditingVeto = null
  await loadVetos()
  // Re-run the simulator without the editing context so the panel reflects
  // the fresh prediction now that a row exists.
  if (opponent) await runSimulation(opponent, { editing: null })
}

async function deleteFromSimulator(id) {
  const { error } = await supabase.from('veto_predictions').delete().eq('id', id)
  if (error) throw error
  toast('Veto deleted')
  vsEditingVeto = null
  await loadVetos()
  if (vsInput?.value) await runSimulation(vsInput.value, { editing: null })
}

function cancelEditInSimulator() {
  vsEditingVeto = null
  if (vsInput?.value) runSimulation(vsInput.value, { editing: null })
}

async function runSimulation(teamName, { editing = null, format = 'bo1' } = {}) {
  const myToken = ++vsToken
  const name = (teamName || '').trim()
  if (!name) {
    vsResult.innerHTML = ''
    vsStatus.textContent = ''
    return
  }
  vsStatus.textContent = 'Loading…'
  try {
    const data = await fetchTeamVetoHistory(name, { months: 3 })
    if (myToken !== vsToken) return
    renderVetoSimulator(vsResult, {
      data,
      format: editing?.format ?? format,
      editing,
      homeStats: ourStats,
      ourName:   ourTeamName,
      onSave:   saveFromSimulator,
      onDelete: deleteFromSimulator,
      onCancel: cancelEditInSimulator,
    })
    vsStatus.textContent = data.vetos.length
      ? `${data.vetos.length} veto${data.vetos.length === 1 ? '' : 's'} found`
      : 'no vetos'
  } catch (e) {
    if (myToken !== vsToken) return
    console.error('[veto-sim] failed', e)
    vsResult.innerHTML = `<div class="vs-empty"><h3>Couldn't load veto history</h3><p>${esc(e.message || e)}</p></div>`
    vsStatus.textContent = ''
  }
}

// Public hook used by the saved-veto list's Edit button — load a row back
// into the simulator panel as an editable sequence.
function editVetoInSimulator(v) {
  if (!v) return
  vsEditingVeto = v
  if (vsInput) vsInput.value = v.opponent ?? ''
  runSimulation(v.opponent ?? '', { editing: v, format: v.format ?? 'bo1' })
  document.querySelector('.vs-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

if (vsInput) {
  attachTeamAutocomplete(vsInput, team => {
    clearTimeout(vsTypingTimer)
    vsEditingVeto = null
    runSimulation(team.name)
  })
  vsInput.addEventListener('input', () => {
    clearTimeout(vsTypingTimer)
    vsTypingTimer = setTimeout(() => {
      vsEditingVeto = null
      runSimulation(vsInput.value)
    }, 400)
  })
}

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
const heroEl    = document.getElementById('veto-hero')
const filtersEl = document.getElementById('veto-filters')
const listEl    = document.getElementById('veto-list')

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
  // Recompute our team's combined stats now that saved vetos changed —
  // savedVetos are part of the training set for our own predictions.
  recomputeOurStats()
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
      </div>
      <div class="dx-hero-right">
        ${wash ? `<div class="dx-hero-mapwash" style="background-image:url('${esc(wash)}')"></div>` : ''}
      </div>
    </div>`
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
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const v = state.vetos.find(x => String(x.id) === String(btn.dataset.edit))
      if (v) editVetoInSimulator(v)
    })
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

function renderAll() { renderHero(); renderFilters(); renderList() }

loadVetos()
