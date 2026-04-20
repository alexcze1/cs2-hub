import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('vods')

const MAPS = ['ancient','mirage','nuke','anubis','inferno','overpass','dust2']
const id     = new URLSearchParams(location.search).get('id')
const isEdit = !!id
let maps = []
let activeMapTab = 0
let autosaveTimer = null

// ── Helpers ────────────────────────────────────────────────
function mapResult(m) {
  if (m.score_us == null || m.score_them == null) return null
  if (m.score_us > m.score_them) return 'win'
  if (m.score_them > m.score_us) return 'loss'
  return 'draw'
}

function computeMatchResult() {
  let w = 0, l = 0
  for (const m of maps) {
    const r = mapResult(m)
    if (r === 'win') w++; else if (r === 'loss') l++
  }
  if (w === 0 && l === 0) return null
  return w > l ? 'win' : l > w ? 'loss' : 'draw'
}

function autoResize(el) {
  el.style.height = 'auto'
  el.style.height = Math.max(el.scrollHeight, 120) + 'px'
}

// ── Notes read/write for active map ───────────────────────
function saveActiveNotes() {
  if (!maps.length) return
  const m = maps[activeMapTab]
  if (!m) return
  if (!m.notes || typeof m.notes !== 'object') m.notes = {}
  m.notes.overview = document.getElementById('n-overview').value
  m.notes.t_side   = document.getElementById('n-t-side').value
  m.notes.ct_side  = document.getElementById('n-ct-side').value
}

function loadActiveNotes() {
  const m = maps[activeMapTab]
  const n = (m?.notes && typeof m.notes === 'object') ? m.notes : {}
  document.getElementById('n-overview').value = n.overview ?? ''
  document.getElementById('n-t-side').value   = n.t_side   ?? ''
  document.getElementById('n-ct-side').value  = n.ct_side  ?? ''
  document.querySelectorAll('.review-textarea').forEach(autoResize)
}

// ── Map rows ───────────────────────────────────────────────
function renderMaps() {
  const el = document.getElementById('maps-list')
  if (!maps.length) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0">No maps added yet.</div>`
    document.getElementById('review-section').style.display = 'none'
    return
  }

  el.innerHTML = maps.map((m, i) => {
    const opts = MAPS.map(n => `<option value="${n}" ${m.map === n ? 'selected' : ''}>${n.charAt(0).toUpperCase()+n.slice(1)}</option>`).join('')
    const r    = mapResult(m)
    return `
      <div class="map-row">
        <select class="form-select map-row-map" style="width:130px" data-i="${i}">${opts}</select>
        <div class="map-score-inputs">
          <input class="form-input map-row-us"   type="number" min="0" max="30" placeholder="Us"   value="${m.score_us   ?? ''}" data-i="${i}" style="width:66px;text-align:center"/>
          <span class="map-score-sep">—</span>
          <input class="form-input map-row-them" type="number" min="0" max="30" placeholder="Them" value="${m.score_them ?? ''}" data-i="${i}" style="width:66px;text-align:center"/>
        </div>
        ${r ? `<span class="badge badge-${r}">${r.toUpperCase()}</span>` : '<span style="width:52px"></span>'}
        <button class="map-row-remove" data-i="${i}">×</button>
      </div>
    `
  }).join('')

  el.querySelectorAll('.map-row-map').forEach(s => s.addEventListener('change', e => {
    maps[+e.target.dataset.i].map = e.target.value; renderMaps()
  }))
  el.querySelectorAll('.map-row-us').forEach(inp => inp.addEventListener('input', e => {
    maps[+e.target.dataset.i].score_us = e.target.value !== '' ? +e.target.value : null; renderMaps()
  }))
  el.querySelectorAll('.map-row-them').forEach(inp => inp.addEventListener('input', e => {
    maps[+e.target.dataset.i].score_them = e.target.value !== '' ? +e.target.value : null; renderMaps()
  }))
  el.querySelectorAll('.map-row-remove').forEach(btn => btn.addEventListener('click', e => {
    saveActiveNotes()
    maps.splice(+e.target.dataset.i, 1)
    activeMapTab = Math.min(activeMapTab, Math.max(0, maps.length - 1))
    renderMaps()
  }))

  document.getElementById('review-section').style.display = 'block'
  renderMapTabs()
  loadActiveNotes()
}

// ── Map tab strip ──────────────────────────────────────────
function renderMapTabs() {
  const el = document.getElementById('review-map-tabs')
  el.innerHTML = maps.map((m, i) => {
    const r = mapResult(m)
    const score = m.score_us != null && m.score_them != null ? ` ${m.score_us}–${m.score_them}` : ''
    return `<button class="review-map-tab ${i === activeMapTab ? 'active' : ''} ${r ? 'tab-'+r : ''}" data-i="${i}">
      ${m.map.charAt(0).toUpperCase() + m.map.slice(1)}${score}
    </button>`
  }).join('')

  el.querySelectorAll('.review-map-tab').forEach(btn => btn.addEventListener('click', e => {
    saveActiveNotes()
    activeMapTab = +e.target.dataset.i
    renderMapTabs()
    loadActiveNotes()
    if (isEdit) scheduleAutosave()
  }))
}

// ── Auto-save ──────────────────────────────────────────────
function setStatus(msg, color) {
  const el = document.getElementById('notes-status')
  el.textContent = msg
  el.style.color = color ?? ''
}

async function doAutosave() {
  if (!isEdit) return
  saveActiveNotes()
  setStatus('Saving…', 'var(--muted)')
  const { error } = await supabase.from('vods').update({ maps }).eq('id', id)
  if (error) { setStatus('Save failed', 'var(--danger)'); return }
  setStatus('Saved', 'var(--success)')
  setTimeout(() => setStatus(''), 2500)
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer)
  setStatus('Unsaved changes', 'var(--muted)')
  autosaveTimer = setTimeout(doAutosave, 1000)
}

// ── Load existing ──────────────────────────────────────────
if (isEdit) {
  document.getElementById('page-title').textContent = 'Match Review'
  document.getElementById('delete-btn').style.display = 'block'
  const { data: vod, error } = await supabase.from('vods').select('*').eq('id', id).single()
  if (error || !vod) { alert('Match not found.'); location.href = 'vods.html'; throw 0; }
  document.getElementById('f-opponent').value   = vod.opponent   ?? ''
  document.getElementById('f-match-type').value = vod.match_type ?? 'scrim'
  document.getElementById('f-date').value       = vod.match_date ?? ''
  document.getElementById('f-demo-link').value  = vod.demo_link  ?? ''
  maps = (vod.maps ?? []).map(m => ({
    ...m,
    notes: (m.notes && typeof m.notes === 'object') ? m.notes : {}
  }))
}

renderMaps()

document.getElementById('add-map-btn').addEventListener('click', () => {
  saveActiveNotes()
  maps.push({ map: 'mirage', score_us: null, score_them: null, notes: {} })
  activeMapTab = maps.length - 1
  renderMaps()
})

// Auto-resize + autosave on textarea input
document.querySelectorAll('.review-textarea').forEach(ta => {
  ta.addEventListener('input', () => { autoResize(ta); if (isEdit) scheduleAutosave() })
})

// ── Save ───────────────────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', async () => {
  const opponent   = document.getElementById('f-opponent').value.trim() || null
  const match_type = document.getElementById('f-match-type').value
  const match_date = document.getElementById('f-date').value || null
  const demo_link  = document.getElementById('f-demo-link').value.trim() || null
  const errEl      = document.getElementById('save-error')

  saveActiveNotes()

  if (!opponent) { errEl.textContent = 'Opponent is required.'; errEl.style.display = 'block'; return }
  if (!maps.length) { errEl.textContent = 'Add at least one map.'; errEl.style.display = 'block'; return }

  const result  = computeMatchResult()
  const payload = { title: opponent, opponent, result, match_type, match_date, demo_link, notes: null, maps }

  let error
  if (isEdit) {
    ({ error } = await supabase.from('vods').update(payload).eq('id', id))
  } else {
    ({ error } = await supabase.from('vods').insert(payload))
  }

  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  location.href = 'vods.html'
})

// ── Delete ─────────────────────────────────────────────────
document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this match?')) return
  const { error } = await supabase.from('vods').delete().eq('id', id)
  if (error) {
    document.getElementById('save-error').textContent = `Delete failed: ${error.message}`
    document.getElementById('save-error').style.display = 'block'
    return
  }
  location.href = 'vods.html'
})

// ── Antistrat Panel ────────────────────────────────────────
const ANTISTRAT_MAPS = ['ancient','mirage','nuke','anubis','inferno','overpass','dust2']
const ANTISTRAT_MAP_LABELS = { ancient:'Ancient', mirage:'Mirage', nuke:'Nuke', anubis:'Anubis', inferno:'Inferno', overpass:'Overpass', dust2:'Dust2' }
const AS_GP_LABELS = { pistols:'PISTOLS', style:'STYLE', antiecos:'ANTIECOS', forces:'FORCES', tendencies:'TENDENCIES AND TELLS', exploits:'EXPLOITS', solutions:'SOLUTIONS' }

let panelOpponents = []
let panelAntistrat = {}
let panelMapIdx = 0

async function loadOpponentsForPanel() {
  const { data } = await supabase.from('opponents').select('id,name,favored_maps,antistrat').order('name')
  panelOpponents = data ?? []
  const sel = document.getElementById('antistrat-opponent-select')
  if (!sel) return
  sel.innerHTML = '<option value="">— None —</option>'
    + panelOpponents.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')

  // Pre-select if opponent field already has a name that matches
  const oppName = document.getElementById('f-opponent')?.value?.trim()?.toLowerCase()
  if (oppName) {
    const match = panelOpponents.find(o => o.name.toLowerCase() === oppName)
    if (match) { sel.value = match.id; renderPanel(match) }
  }
}

function renderPanel(opp) {
  const panelContent = document.getElementById('antistrat-panel-content')
  const panelEmpty   = document.getElementById('antistrat-panel-empty')
  if (!opp?.antistrat || !Object.keys(opp.antistrat).length) {
    panelContent.style.display = 'none'
    panelEmpty.style.display = 'block'
    panelEmpty.textContent = 'No antistrat data for this opponent.'
    return
  }
  panelAntistrat = opp.antistrat
  const maps = Object.keys(panelAntistrat).filter(m => ANTISTRAT_MAPS.includes(m))
  if (!maps.length) {
    panelContent.style.display = 'none'
    panelEmpty.style.display = 'block'
    panelEmpty.textContent = 'No maps in antistrat for this opponent.'
    return
  }
  panelEmpty.style.display = 'none'
  panelContent.style.display = 'block'
  panelMapIdx = 0

  const tabsEl = document.getElementById('panel-map-tabs')
  tabsEl.innerHTML = maps.map((m, i) => `
    <button class="review-map-tab ${i === 0 ? 'active' : ''}" data-map="${m}" data-i="${i}">
      ${esc(ANTISTRAT_MAP_LABELS[m] ?? m)}
    </button>
  `).join('')
  tabsEl.querySelectorAll('.review-map-tab').forEach(btn => btn.addEventListener('click', () => {
    tabsEl.querySelectorAll('.review-map-tab').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    panelMapIdx = +btn.dataset.i
    renderPanelMap(maps[panelMapIdx])
  }))

  renderPanelMap(maps[0])
}

function gpReadonlyBlock(d, prefix, title, subtitle, titleClass) {
  const pairs = [['pistols','style'],['antiecos','forces']]
  const singles = ['tendencies','exploits','solutions']
  const plan = d?.[`${prefix}_plan`] ?? {}
  const posSide = prefix === 'ct' ? 't' : 'ct'
  const positions = d?.[`${posSide}_positions`] ?? {}
  const lineupStr = Object.entries(positions)
    .filter(([, val]) => val)
    .map(([pos, val]) => `<span><b>${esc(pos)}</b>: ${esc(val)}</span>`)
    .join(' · ') || '<span style="opacity:0.4">—</span>'

  return `<div class="gameplan-sheet" style="margin-top:10px">
    <div class="gameplan-title ${titleClass}" style="font-size:11px">${esc(title)} <span style="font-weight:400;opacity:0.7">— ${esc(subtitle)}</span></div>
    <div style="padding:6px 10px 8px;font-size:11px">
      <div style="font-weight:700;font-size:9px;letter-spacing:1px;opacity:0.6;margin-bottom:4px">LINEUP</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${lineupStr}</div>
    </div>
    ${pairs.map(([a, b]) => `
      <div class="gameplan-split">
        <div class="gameplan-block">
          <div class="gameplan-section-label">${AS_GP_LABELS[a]}</div>
          <div style="padding:6px 10px;font-size:11px;min-height:30px;white-space:pre-wrap;word-break:break-word">${esc(plan[a] ?? '') || '<span style="opacity:0.3">—</span>'}</div>
        </div>
        <div class="gameplan-block">
          <div class="gameplan-section-label">${AS_GP_LABELS[b]}</div>
          <div style="padding:6px 10px;font-size:11px;min-height:30px;white-space:pre-wrap;word-break:break-word">${esc(plan[b] ?? '') || '<span style="opacity:0.3">—</span>'}</div>
        </div>
      </div>
    `).join('')}
    ${singles.map(f => `
      <div class="gameplan-section-label">${AS_GP_LABELS[f]}</div>
      <div style="padding:6px 10px;font-size:11px;min-height:30px;white-space:pre-wrap;word-break:break-word">${esc(plan[f] ?? '') || '<span style="opacity:0.3">—</span>'}</div>
    `).join('')}
  </div>`
}

function renderPanelMap(map) {
  const d = panelAntistrat[map]
  const el = document.getElementById('panel-gameplan-output')
  if (!d) { el.innerHTML = '<div style="color:var(--muted);font-size:12px">No data for this map.</div>'; return }
  el.innerHTML = gpReadonlyBlock(d, 'ct', 'CT GAMEPLAN', 'vs their T side', 'ct-title')
               + gpReadonlyBlock(d, 't',  'T GAMEPLAN',  'vs their CT side', 't-title')
}

document.getElementById('antistrat-opponent-select')?.addEventListener('change', e => {
  const opp = panelOpponents.find(o => o.id === e.target.value)
  const empty   = document.getElementById('antistrat-panel-empty')
  const content = document.getElementById('antistrat-panel-content')
  if (!opp) {
    content.style.display = 'none'
    empty.style.display = 'block'
    empty.textContent = 'Select an opponent to view their antistrat.'
    return
  }
  renderPanel(opp)
})

loadOpponentsForPanel()
