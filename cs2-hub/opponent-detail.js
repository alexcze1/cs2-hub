import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('opponents')

const MAPS = ['ancient','mirage','nuke','anubis','inferno','overpass','dust2']
const MAP_LABELS = { ancient:'Ancient', mirage:'Mirage', nuke:'Nuke', anubis:'Anubis', inferno:'Inferno', overpass:'Overpass', dust2:'Dust2' }

const MAP_POSITIONS = {
  ancient:  { t: ['A','MID','AWP','CAVE','B'],                    ct: ['A','MID','AWP','CAVE','B'] },
  mirage:   { t: ['A','MID','FLOAT','AWP','B'],                   ct: ['A','CON','AWP','SHORT','B'] },
  nuke:     { t: ['OUTSIDE','FLOAT','AWP','2ND LBY','LOBBY'],     ct: ['OUTSIDE','AWP','DOOR','A','RAMP'] },
  anubis:   { t: ['A','FLOAT','AWP','MID','B'],                   ct: ['B','CON','AWP','MID','A'] },
  inferno:  { t: ['BANANA','B SUP','AWP','MID','APPS'],           ct: ['B','B SUP','AWP','SHORT','APPS'] },
  overpass: { t: ['A','FLOAT','AWP','CON','B'],                   ct: ['A','AWP','ROT','SHORT','B'] },
  dust2:    { t: ['B','MID','FLOAT','AWP','LONG'],                ct: ['B','MID','AWP','LONG','ROT'] },
}

const GP_FIELDS = ['pistols','style','antiecos','forces','tendencies','exploits','solutions']
const GP_LABELS = { pistols:'PISTOLS', style:'STYLE', antiecos:'ANTIECOS', forces:'FORCES', tendencies:'TENDENCIES AND TELLS', exploits:'EXPLOITS', solutions:'SOLUTIONS' }
const GP_CLASSES = { pistols:'pistols-label', style:'style-label', antiecos:'antiecos-label', forces:'forces-label', tendencies:'tendencies-label', exploits:'exploits-label', solutions:'solutions-label' }
const GP_PLACEHOLDERS = {
  pistols: 'Pistol round tendencies…', style: 'AWP roles, special player habits…',
  antiecos: 'Anti-eco approach…', forces: 'Force buy patterns…',
  tendencies: 'Recurring patterns, giveaways…', exploits: 'Weaknesses we can abuse…',
  solutions: 'Our adjustments and counters…',
}

const id = new URLSearchParams(location.search).get('id')
const isEdit = !!id

let selectedMaps = []
let antistrat = {}
let activeMapIdx = 0

function ensureMapData(map) {
  if (antistrat[map]) return
  const tPos = {}; MAP_POSITIONS[map].t.forEach(p => { tPos[p] = '' })
  const ctPos = {}; MAP_POSITIONS[map].ct.forEach(p => { ctPos[p] = '' })
  antistrat[map] = {
    t_positions:  tPos,
    ct_positions: ctPos,
    ct_plan: Object.fromEntries(GP_FIELDS.map(f => [f, ''])),
    t_plan:  Object.fromEntries(GP_FIELDS.map(f => [f, ''])),
  }
}

// ── Map Selector ────────────────────────────────────────────
function renderMapSelector() {
  const el = document.getElementById('map-selector')
  el.innerHTML = MAPS.map(m => `
    <button class="map-toggle ${selectedMaps.includes(m) ? 'active' : ''}" data-map="${m}">
      ${esc(MAP_LABELS[m])}
    </button>
  `).join('')

  el.querySelectorAll('.map-toggle').forEach(btn => btn.addEventListener('click', () => {
    saveActivePlan()
    const map = btn.dataset.map
    if (selectedMaps.includes(map)) {
      selectedMaps = selectedMaps.filter(m => m !== map)
      activeMapIdx = Math.min(activeMapIdx, Math.max(0, selectedMaps.length - 1))
    } else {
      selectedMaps.push(map)
      ensureMapData(map)
      activeMapIdx = selectedMaps.length - 1
    }
    renderMapSelector()
    renderAntistratSection()
  }))
}

// ── Antistrat Section ───────────────────────────────────────
function renderAntistratSection() {
  const section = document.getElementById('antistrat-section')
  if (!selectedMaps.length) { section.style.display = 'none'; return }
  section.style.display = 'block'
  renderMapTabs()
  renderGameplans()
}

function renderMapTabs() {
  const el = document.getElementById('antistrat-map-tabs')
  el.innerHTML = selectedMaps.map((m, i) => `
    <button class="review-map-tab ${i === activeMapIdx ? 'active' : ''}" data-i="${i}">
      ${esc(MAP_LABELS[m])}
    </button>
  `).join('')

  el.querySelectorAll('.review-map-tab').forEach(btn => btn.addEventListener('click', e => {
    saveActivePlan()
    activeMapIdx = +e.currentTarget.dataset.i
    renderMapTabs()
    renderGameplans()
  }))
}

function posGridHTML(map, side) {
  const positions = MAP_POSITIONS[map][side]
  const data = antistrat[map]?.[`${side}_positions`] ?? {}
  return `<div class="pos-grid">
    ${positions.map(pos => `
      <div class="pos-cell">
        <div class="pos-label">${esc(pos)}</div>
        <input class="form-input pos-input" style="padding:6px 8px;font-size:13px"
          data-map="${esc(map)}" data-side="${side}" data-pos="${esc(pos)}"
          placeholder="player" value="${esc(data[pos] ?? '')}"/>
      </div>
    `).join('')}
  </div>`
}

function gpSheetHTML(map, prefix, title, subtitle, titleClass) {
  const d = antistrat[map]?.[`${prefix}_plan`] ?? {}
  const pairs = [['pistols','style'], ['antiecos','forces']]
  const singles = ['tendencies','exploits','solutions']

  const posSide = prefix === 'ct' ? 't' : 'ct'
  const posLabelClass = prefix === 'ct' ? 't-positions-label' : 'ct-positions-label'
  const posHeading = prefix === 'ct' ? 'THEIR T-SIDE LINEUP' : 'THEIR CT-SIDE LINEUP'

  return `<div class="gameplan-sheet" style="margin-top:16px">
    <div class="gameplan-title ${titleClass}">${esc(title)} <span style="font-weight:400;opacity:0.7">— ${esc(subtitle)}</span></div>
    <div class="gameplan-section-label ${posLabelClass}">${posHeading}</div>
    <div style="padding:10px 14px 14px">${posGridHTML(map, posSide)}</div>
    ${pairs.map(([a, b]) => `
      <div class="gameplan-split">
        <div class="gameplan-block">
          <div class="gameplan-section-label ${GP_CLASSES[a]}">${GP_LABELS[a]}</div>
          <textarea class="form-textarea gameplan-textarea gp-field" data-map="${esc(map)}" data-prefix="${prefix}" data-field="${a}" placeholder="${esc(GP_PLACEHOLDERS[a])}">${esc(d[a] ?? '')}</textarea>
        </div>
        <div class="gameplan-block">
          <div class="gameplan-section-label ${GP_CLASSES[b]}">${GP_LABELS[b]}</div>
          <textarea class="form-textarea gameplan-textarea gp-field" data-map="${esc(map)}" data-prefix="${prefix}" data-field="${b}" placeholder="${esc(GP_PLACEHOLDERS[b])}">${esc(d[b] ?? '')}</textarea>
        </div>
      </div>
    `).join('')}
    ${singles.map(f => `
      <div class="gameplan-section-label ${GP_CLASSES[f]}">${GP_LABELS[f]}</div>
      <textarea class="form-textarea gameplan-textarea gp-field" style="min-height:70px" data-map="${esc(map)}" data-prefix="${prefix}" data-field="${f}" placeholder="${esc(GP_PLACEHOLDERS[f])}">${esc(d[f] ?? '')}</textarea>
    `).join('')}
  </div>`
}

function renderGameplans() {
  const el = document.getElementById('gameplan-panels')
  const map = selectedMaps[activeMapIdx]
  if (!map) { el.innerHTML = ''; return }
  ensureMapData(map)
  el.innerHTML = gpSheetHTML(map, 'ct', 'CT GAMEPLAN', 'vs their T side', 'ct-title')
               + gpSheetHTML(map, 't',  'T GAMEPLAN',  'vs their CT side', 't-title')

  el.querySelectorAll('.pos-input').forEach(inp => inp.addEventListener('input', e => {
    const { map: m, side, pos } = e.target.dataset
    if (antistrat[m]) antistrat[m][`${side}_positions`][pos] = e.target.value
  }))
}

function saveActivePlan() {
  const map = selectedMaps[activeMapIdx]
  if (!map || !antistrat[map]) return
  document.querySelectorAll('.gp-field').forEach(ta => {
    const { map: m, prefix, field } = ta.dataset
    if (antistrat[m]) antistrat[m][`${prefix}_plan`][field] = ta.value
  })
}

// ── Print ────────────────────────────────────────────────────
function printSheetHTML(map, prefix, title) {
  const d = antistrat[map]?.[`${prefix}_plan`] ?? {}
  const pairs = [['pistols','style'], ['antiecos','forces']]
  const singles = ['tendencies','exploits','solutions']
  const posSide = prefix === 'ct' ? 't' : 'ct'
  const positions = MAP_POSITIONS[map][posSide]
  const posData = antistrat[map]?.[`${posSide}_positions`] ?? {}
  const posLabelClass = prefix === 'ct' ? 't-positions-label' : 'ct-positions-label'
  const posHeading = prefix === 'ct' ? 'THEIR T LINEUP' : 'THEIR CT LINEUP'
  const titleClass = prefix === 'ct' ? 'ct-title' : 't-title'

  const lineupHTML = positions.map(pos => {
    const val = posData[pos] ?? ''
    return `<span class="pprint-pos"><b>${esc(pos)}</b>${val ? ': '+esc(val) : ''}</span>`
  }).join('')

  return `<div class="pprint-sheet">
    <div class="pprint-sheet-title ${titleClass}">${esc(title)}</div>
    <div class="pprint-lineup-row">
      <span class="pprint-lineup-label ${posLabelClass}">${posHeading}</span>
      <span class="pprint-lineup-vals">${lineupHTML}</span>
    </div>
    ${pairs.map(([a, b]) => `
      <div class="pprint-split">
        <div class="pprint-block">
          <div class="pprint-label ${GP_CLASSES[a]}">${GP_LABELS[a]}</div>
          <div class="pprint-text">${esc(d[a] ?? '')}</div>
        </div>
        <div class="pprint-block">
          <div class="pprint-label ${GP_CLASSES[b]}">${GP_LABELS[b]}</div>
          <div class="pprint-text">${esc(d[b] ?? '')}</div>
        </div>
      </div>`).join('')}
    ${singles.map(f => `
      <div class="pprint-label ${GP_CLASSES[f]}">${GP_LABELS[f]}</div>
      <div class="pprint-text">${esc(d[f] ?? '')}</div>`).join('')}
  </div>`
}

window.printAntistrat = function() {
  saveActivePlan()
  const name = document.getElementById('f-name').value.trim() || 'Opponent'

  let printArea = document.getElementById('print-all-maps')
  if (!printArea) {
    printArea = document.createElement('div')
    printArea.id = 'print-all-maps'
    document.body.appendChild(printArea)
  }

  printArea.innerHTML = `<div class="pprint-header">${esc(name)}</div>`
    + selectedMaps.map(map => {
        ensureMapData(map)
        return `<div class="pprint-map-label">${esc(MAP_LABELS[map])}</div>`
             + printSheetHTML(map, 'ct', 'CT GAMEPLAN — vs their T side')
             + printSheetHTML(map, 't',  'T GAMEPLAN — vs their CT side')
      }).join('')

  document.body.classList.add('print-antistrat')
  window.print()
  document.body.classList.remove('print-antistrat')
  renderGameplans()
}

// ── Load existing ───────────────────────────────────────────
if (isEdit) {
  document.getElementById('page-title').textContent = 'Edit Opponent'
  document.getElementById('delete-btn').style.display = 'block'

  const { data: opp, error } = await supabase.from('opponents').select('*').eq('id', id).single()
  if (error || !opp) { alert('Opponent not found.'); location.href = 'opponents.html'; throw 0 }

  document.getElementById('f-name').value = opp.name ?? ''
  selectedMaps = opp.favored_maps ?? []
  antistrat    = opp.antistrat    ?? {}
  selectedMaps.forEach(ensureMapData)
}

renderMapSelector()
renderAntistratSection()

// ── Save ────────────────────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', async () => {
  saveActivePlan()
  const name  = document.getElementById('f-name').value.trim()
  const errEl = document.getElementById('save-error')

  if (!name) { errEl.textContent = 'Team name is required.'; errEl.style.display = 'block'; return }

  const payload = { name, favored_maps: selectedMaps, antistrat, team_id: getTeamId() }

  let error
  if (isEdit) {
    ;({ error } = await supabase.from('opponents').update(payload).eq('id', id))
  } else {
    ;({ error } = await supabase.from('opponents').insert(payload))
  }

  if (error) { alert('Save failed: ' + error.message); errEl.textContent = error.message; errEl.style.display = 'block'; return }
  location.href = 'opponents.html'
})

// ── Delete ──────────────────────────────────────────────────
document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this opponent?')) return
  const { error } = await supabase.from('opponents').delete().eq('id', id)
  if (error) {
    document.getElementById('save-error').textContent = `Delete failed: ${error.message}`
    document.getElementById('save-error').style.display = 'block'
    return
  }
  location.href = 'opponents.html'
})
