import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('vods')

const MAPS = ['ancient','mirage','nuke','anubis','inferno','overpass','dust2']
const id     = new URLSearchParams(location.search).get('id')
const isEdit = !!id
let maps = []
let activeMapTab = 0
let autosaveTimer = null
let scanTarget = null
let _ocrWorker = null

async function getOcrWorker() {
  if (_ocrWorker) return _ocrWorker
  _ocrWorker = await Tesseract.createWorker('eng', 1, { logger: () => {} })
  await _ocrWorker.setParameters({
    tessedit_char_whitelist: '0123456789:- ',
    tessedit_pageseg_mode: '11', // sparse text — find numbers anywhere
  })
  return _ocrWorker
}

// Upscale 2x + hard black/white threshold for cleaner OCR
function preprocessImage(file) {
  return new Promise(resolve => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = 2
      const canvas = document.createElement('canvas')
      canvas.width  = img.naturalWidth  * scale
      canvas.height = img.naturalHeight * scale
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height)
      for (let i = 0; i < d.data.length; i += 4) {
        const g = 0.299 * d.data[i] + 0.587 * d.data[i+1] + 0.114 * d.data[i+2]
        const v = g > 100 ? 255 : 0  // hard threshold — white text on black
        d.data[i] = d.data[i+1] = d.data[i+2] = v
      }
      ctx.putImageData(d, 0, 0)
      canvas.toBlob(resolve, 'image/png')
    }
    img.src = url
  })
}

function parseScores(text) {
  // Find number pairs separated by - : – etc.
  const pairs = [...text.matchAll(/\b(\d{1,2})\s*[-:–—]\s*(\d{1,2})\b/g)]
    .map(m => [+m[1], +m[2]])
    .filter(([a, b]) => a <= 30 && b <= 30 && a + b > 0)
  if (pairs.length) {
    // Highest total = most likely the final score (not halftime)
    pairs.sort((a, b) => (b[0] + b[1]) - (a[0] + a[1]))
    return { score_a: pairs[0][0], score_b: pairs[0][1] }
  }
  // Fallback: any two numbers in range
  const nums = [...text.matchAll(/\b(\d{1,2})\b/g)].map(m => +m[1]).filter(n => n <= 30)
  if (nums.length >= 2) return { score_a: nums[0], score_b: nums[1] }
  return null
}

// Shared hidden file input for scoreboard scans
const scanInput = document.createElement('input')
scanInput.type = 'file'
scanInput.accept = 'image/*'
scanInput.style.display = 'none'
document.body.appendChild(scanInput)

scanInput.addEventListener('change', async () => {
  const file = scanInput.files[0]
  scanInput.value = ''
  if (!file || scanTarget === null) return
  const idx = scanTarget
  scanTarget = null
  const scanBtn = document.querySelector(`.map-row-scan[data-i="${idx}"]`)
  if (scanBtn) { scanBtn.disabled = true; scanBtn.classList.add('scanning') }
  try {
    const worker = await getOcrWorker()
    const processed = await preprocessImage(file)
    const { data: { text } } = await worker.recognize(processed)
    const result = parseScores(text)
    if (!result) throw new Error('no scores found')
    maps[idx].score_us   = result.score_a
    maps[idx].score_them = result.score_b
    renderMaps()
    toast(`Scores filled: ${result.score_a}–${result.score_b} — tap ⇄ to flip if reversed`)
  } catch {
    toast('Could not read scores — try cropping tighter around the numbers', 'error')
  }
  if (scanBtn) { scanBtn.disabled = false; scanBtn.classList.remove('scanning') }
})

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
    const opts    = MAPS.map(n => `<option value="${n}" ${m.map === n ? 'selected' : ''}>${n.charAt(0).toUpperCase()+n.slice(1)}</option>`).join('')
    const r       = mapResult(m)
    const mapFile = m.map === 'dust2' ? 'dust' : m.map
    return `
      <div class="map-row">
        <select class="form-select map-row-map" style="width:130px" data-i="${i}">${opts}</select>
        <div class="map-score-inputs">
          <input class="form-input map-row-us"   type="number" min="0" max="30" placeholder="Us"   value="${m.score_us   ?? ''}" data-i="${i}" style="width:66px;text-align:center"/>
          <span class="map-score-sep">—</span>
          <input class="form-input map-row-them" type="number" min="0" max="30" placeholder="Them" value="${m.score_them ?? ''}" data-i="${i}" style="width:66px;text-align:center"/>
        </div>
        ${r ? `<span class="badge badge-${r}">${r.toUpperCase()}</span>` : '<span style="width:52px"></span>'}
        <button class="map-row-icon-btn map-row-scan" data-i="${i}" title="Scan scoreboard screenshot">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </button>
        <button class="map-row-icon-btn map-row-swap" data-i="${i}" title="Swap Us / Them scores">⇄</button>
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
  el.querySelectorAll('.map-row-scan').forEach(btn => btn.addEventListener('click', () => {
    scanTarget = +btn.dataset.i
    scanInput.click()
  }))
  el.querySelectorAll('.map-row-swap').forEach(btn => btn.addEventListener('click', () => {
    const i = +btn.dataset.i
    const tmp = maps[i].score_us
    maps[i].score_us = maps[i].score_them
    maps[i].score_them = tmp
    renderMaps()
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
    const r       = mapResult(m)
    const mapFile = m.map === 'dust2' ? 'dust' : m.map
    const borderColor = r === 'win' ? 'var(--success)' : r === 'loss' ? 'var(--danger)' : i === activeMapTab ? 'var(--accent)' : 'var(--border)'
    const labelColor  = r === 'win' ? 'var(--success)' : r === 'loss' ? 'var(--danger)' : 'var(--muted)'
    return `<button class="review-map-tab ${i === activeMapTab ? 'active' : ''}" data-i="${i}" style="position:relative;overflow:hidden;padding:0;width:90px;height:54px;border:1.5px solid ${borderColor};background:var(--surface)">
      <img src="images/maps/${mapFile}.png" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:${i === activeMapTab ? '0.3' : '0.15'};pointer-events:none">
      <div style="position:relative;padding:6px 8px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between">
        <span style="font-size:9px;font-weight:700;letter-spacing:0.8px;color:${labelColor}">${r ? r.toUpperCase() : '—'}</span>
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--text)">${m.map.charAt(0).toUpperCase() + m.map.slice(1)}</div>
          ${m.score_us != null && m.score_them != null ? `<div style="font-size:10px;color:var(--muted)">${m.score_us}–${m.score_them}</div>` : ''}
        </div>
      </div>
    </button>`
  }).join('')

  el.querySelectorAll('.review-map-tab').forEach(btn => btn.addEventListener('click', () => {
    saveActiveNotes()
    activeMapTab = +btn.dataset.i
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
  const payload = { title: opponent, opponent, result, match_type, match_date, demo_link, notes: null, maps, team_id: getTeamId() }

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

