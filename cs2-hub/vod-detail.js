import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('vods')

const MAPS = ['mirage','inferno','nuke','anubis','dust2','vertigo','ancient']
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
    if (r === 'win') w++
    else if (r === 'loss') l++
  }
  if (w === 0 && l === 0) return null
  return w > l ? 'win' : l > w ? 'loss' : 'draw'
}

function autoResize(el) {
  el.style.height = 'auto'
  el.style.height = Math.max(el.scrollHeight, 90) + 'px'
}

function getNotes() {
  return {
    overview:     document.getElementById('n-overview').value.trim()     || null,
    t_side:       document.getElementById('n-t-side').value.trim()       || null,
    ct_side:      document.getElementById('n-ct-side').value.trim()      || null,
    economy:      document.getElementById('n-economy').value.trim()      || null,
    action_items: document.getElementById('n-action-items').value.trim() || null,
  }
}

function setNotes(n) {
  if (!n || typeof n !== 'object') return
  document.getElementById('n-overview').value     = n.overview     ?? ''
  document.getElementById('n-t-side').value       = n.t_side       ?? ''
  document.getElementById('n-ct-side').value      = n.ct_side      ?? ''
  document.getElementById('n-economy').value      = n.economy      ?? ''
  document.getElementById('n-action-items').value = n.action_items ?? ''
  document.querySelectorAll('.review-textarea').forEach(autoResize)
}

// ── Map rows ───────────────────────────────────────────────
function renderMaps() {
  const el = document.getElementById('maps-list')
  if (!maps.length) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0">No maps added yet.</div>`
    renderMapNotes()
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

  el.querySelectorAll('.map-row-map').forEach(s => s.addEventListener('change', e => { maps[+e.target.dataset.i].map = e.target.value; renderMaps() }))
  el.querySelectorAll('.map-row-us').forEach(inp => inp.addEventListener('input', e => {
    maps[+e.target.dataset.i].score_us = e.target.value !== '' ? +e.target.value : null; renderMaps()
  }))
  el.querySelectorAll('.map-row-them').forEach(inp => inp.addEventListener('input', e => {
    maps[+e.target.dataset.i].score_them = e.target.value !== '' ? +e.target.value : null; renderMaps()
  }))
  el.querySelectorAll('.map-row-remove').forEach(btn => btn.addEventListener('click', e => {
    maps.splice(+e.target.dataset.i, 1)
    if (activeMapTab >= maps.length) activeMapTab = Math.max(0, maps.length - 1)
    renderMaps()
  }))

  renderMapNotes()
}

// ── Per-map notes tabs ─────────────────────────────────────
function renderMapNotes() {
  const section = document.getElementById('map-notes-section')
  const tabsEl  = document.getElementById('map-notes-tabs')
  const content = document.getElementById('map-notes-content')

  if (!maps.length) { section.style.display = 'none'; return }
  section.style.display = 'block'

  tabsEl.innerHTML = maps.map((m, i) => `
    <button class="map-note-tab ${i === activeMapTab ? 'active' : ''}" data-i="${i}">
      ${m.map.charAt(0).toUpperCase() + m.map.slice(1)}
    </button>
  `).join('')

  tabsEl.querySelectorAll('.map-note-tab').forEach(btn => btn.addEventListener('click', e => {
    // Save current tab's value before switching
    const cur = document.getElementById('map-note-textarea')
    if (cur) maps[activeMapTab].notes = cur.value
    activeMapTab = +e.target.dataset.i
    renderMapNotes()
  }))

  const m = maps[activeMapTab]
  content.innerHTML = `
    <textarea class="review-textarea map-note-active" id="map-note-textarea"
      placeholder="Notes specific to ${m.map.charAt(0).toUpperCase() + m.map.slice(1)} — site preferences, T setups, CT reads, individual mistakes…"
    >${esc(m.notes ?? '')}</textarea>
  `
  const ta = document.getElementById('map-note-textarea')
  autoResize(ta)
  ta.addEventListener('input', () => { autoResize(ta); scheduleAutosave() })
}

// ── Review section visibility ──────────────────────────────
function showReviewSection() {
  document.getElementById('review-section').style.display = 'block'
}

// ── Auto-save (only for existing matches) ─────────────────
function setAutosaveStatus(msg, color) {
  const el = document.getElementById('notes-status')
  el.textContent = msg
  el.style.color = color ?? 'var(--muted)'
}

async function doAutosave() {
  if (!isEdit) return
  // Capture current map-note textarea before saving
  const cur = document.getElementById('map-note-textarea')
  if (cur) maps[activeMapTab].notes = cur.value

  setAutosaveStatus('Saving…', 'var(--muted)')
  const notes = getNotes()
  const { error } = await supabase.from('vods').update({ notes, maps }).eq('id', id)
  if (error) { setAutosaveStatus('Failed to save', 'var(--danger)'); return }
  setAutosaveStatus('Saved ✓', 'var(--success)')
  setTimeout(() => setAutosaveStatus(''), 3000)
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer)
  setAutosaveStatus('Unsaved…', 'var(--muted)')
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
  maps = vod.maps ?? []
  setNotes(vod.notes)
  showReviewSection()
}

renderMaps()

document.getElementById('add-map-btn').addEventListener('click', () => {
  maps.push({ map: 'mirage', score_us: null, score_them: null, notes: '' })
  showReviewSection()
  renderMaps()
})

// Auto-resize + autosave on review textarea input
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

  // Capture current map-note textarea
  const cur = document.getElementById('map-note-textarea')
  if (cur) maps[activeMapTab].notes = cur.value

  if (!opponent) { errEl.textContent = 'Opponent is required.'; errEl.style.display = 'block'; return }
  if (!maps.length) { errEl.textContent = 'Add at least one map.'; errEl.style.display = 'block'; return }

  const notes   = getNotes()
  const result  = computeMatchResult()
  const payload = { title: opponent, opponent, result, match_type, match_date, demo_link, notes, maps }

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
