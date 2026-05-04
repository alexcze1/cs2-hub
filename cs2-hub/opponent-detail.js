import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'
import { attachTeamAutocomplete, getTeamLogo, teamLogoEl } from './team-autocomplete.js'
import { MAP_POSITIONS } from './map-positions.js'
import { renderPositionsGrid, renderPlanSheet, ensureMapAntistrat } from './antistrat-editor.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

function autoExpand(ta) {
  if (CSS.supports('field-sizing', 'content')) return
  ta.style.height = 'auto'
  ta.style.height = ta.scrollHeight + 'px'
}

await requireAuth()
renderSidebar('opponents')

const MAPS = ['ancient','mirage','nuke','anubis','inferno','overpass','dust2']
const MAP_LABELS = { ancient:'Ancient', mirage:'Mirage', nuke:'Nuke', anubis:'Anubis', inferno:'Inferno', overpass:'Overpass', dust2:'Dust2' }
const MAP_IMG    = { dust2: 'dust' }
function mapImgUrl(map) { return `images/maps/${MAP_IMG[map] ?? map}.png` }

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

// ── Map Selector ────────────────────────────────────────────
function renderMapSelector() {
  const el = document.getElementById('map-selector')
  el.innerHTML = MAPS.map(m => {
    const active = selectedMaps.includes(m)
    return `
    <button class="map-toggle" data-map="${m}" style="position:relative;overflow:hidden;padding:0;width:90px;height:58px;border:1.5px solid ${active ? 'var(--accent)' : 'var(--border)'};border-radius:8px;background:var(--surface);opacity:${active ? '1' : '0.5'}">
      <img src="${mapImgUrl(m)}" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:${active ? '0.35' : '0.2'};pointer-events:none">
      <div style="position:relative;height:100%;display:flex;flex-direction:column;justify-content:flex-end;padding:6px 8px">
        <span style="font-size:11px;font-weight:700;color:${active ? 'var(--accent)' : 'var(--text)'}">${esc(MAP_LABELS[m])}</span>
      </div>
    </button>`
  }).join('')

  el.querySelectorAll('.map-toggle').forEach(btn => btn.addEventListener('click', () => {
    saveActivePlan()
    const map = btn.dataset.map
    if (selectedMaps.includes(map)) {
      selectedMaps = selectedMaps.filter(m => m !== map)
      activeMapIdx = Math.min(activeMapIdx, Math.max(0, selectedMaps.length - 1))
    } else {
      selectedMaps.push(map)
      ensureMapAntistrat(antistrat, map)
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
  el.innerHTML = selectedMaps.map((m, i) => {
    const active = i === activeMapIdx
    return `
    <button class="review-map-tab" data-i="${i}" style="position:relative;overflow:hidden;padding:0;width:90px;height:54px;border:1.5px solid ${active ? 'var(--accent)' : 'var(--border)'};border-radius:7px;background:var(--surface)">
      <img src="${mapImgUrl(m)}" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:${active ? '0.3' : '0.15'};pointer-events:none">
      <div style="position:relative;height:100%;display:flex;align-items:flex-end;padding:6px 8px">
        <span style="font-size:12px;font-weight:700;color:${active ? 'var(--accent)' : 'var(--text)'}">${esc(MAP_LABELS[m])}</span>
      </div>
    </button>`
  }).join('')

  el.querySelectorAll('.review-map-tab').forEach(btn => btn.addEventListener('click', e => {
    saveActivePlan()
    activeMapIdx = +e.currentTarget.dataset.i
    renderMapTabs()
    renderGameplans()
  }))
}

function renderGameplans() {
  const el = document.getElementById('gameplan-panels')
  const map = selectedMaps[activeMapIdx]
  if (!map) { el.innerHTML = ''; return }
  ensureMapAntistrat(antistrat, map)

  const ctPositions = renderPositionsGrid(map, 't',  antistrat) // their T lineup, rendered above CT plan
  const tPositions  = renderPositionsGrid(map, 'ct', antistrat) // their CT lineup, rendered above T plan
  const ctPlan      = renderPlanSheet(map, 'ct', antistrat)
  const tPlan       = renderPlanSheet(map, 't',  antistrat)

  el.innerHTML = `
    <div class="gameplan-sheet" style="margin-top:16px">
      <div class="gameplan-title ct-title">CT GAMEPLAN <span style="font-weight:400;opacity:0.7">— vs their T side</span></div>
      <div class="gameplan-section-label t-positions-label">THEIR T-SIDE LINEUP</div>
      <div style="padding:10px 14px 14px">${ctPositions.html}</div>
      ${ctPlan.html}
    </div>
    <div class="gameplan-sheet" style="margin-top:16px">
      <div class="gameplan-title t-title">T GAMEPLAN <span style="font-weight:400;opacity:0.7">— vs their CT side</span></div>
      <div class="gameplan-section-label ct-positions-label">THEIR CT-SIDE LINEUP</div>
      <div style="padding:10px 14px 14px">${tPositions.html}</div>
      ${tPlan.html}
    </div>
  `

  ctPositions.wire(el); tPositions.wire(el)
  ctPlan.wire(el);      tPlan.wire(el)

  // Auto-grow textareas (preserve existing behavior).
  el.querySelectorAll('.gameplan-textarea').forEach(ta => {
    autoExpand(ta)
    ta.addEventListener('input', () => autoExpand(ta))
  })
}

function saveActivePlan() {
  const map = selectedMaps[activeMapIdx]
  if (!map || !antistrat[map]) return
  document.querySelectorAll('.gp-field').forEach(ta => {
    // Editor module emits data-side; legacy markup used data-prefix. Either is OK.
    const { map: m, prefix, side, field } = ta.dataset
    const p = prefix ?? side
    if (!p || !field) return
    if (antistrat[m]?.[`${p}_plan`]) antistrat[m][`${p}_plan`][field] = ta.value
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
        ensureMapAntistrat(antistrat, map)
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
  selectedMaps.forEach(m => ensureMapAntistrat(antistrat, m))
}

renderMapSelector()
renderAntistratSection()

// ── Team autocomplete + live logo preview ───────────────────
const nameInput  = document.getElementById('f-name')
const logoWrap   = document.getElementById('opp-logo-wrap')

function updateLogoPreview(logo, name) {
  logoWrap.innerHTML = teamLogoEl(logo, name || '???', 44)
}

// Preload logo for existing opponents
const initialName = nameInput.value.trim()
if (initialName) {
  const logo = await getTeamLogo(initialName)
  updateLogoPreview(logo, initialName)
} else {
  updateLogoPreview(null, '')
}

attachTeamAutocomplete(nameInput, team => {
  updateLogoPreview(team.logo, team.name)
})

nameInput.addEventListener('input', async () => {
  const n = nameInput.value.trim()
  if (!n) { updateLogoPreview(null, ''); return }
  const logo = await getTeamLogo(n)
  updateLogoPreview(logo, n)
})

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

  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  toast(isEdit ? 'Opponent saved' : 'Opponent added')
  setTimeout(() => { location.href = 'opponents.html' }, 700)
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
  toast('Opponent deleted')
  setTimeout(() => { location.href = 'opponents.html' }, 700)
})
