// cs2-hub/vod-detail.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

await requireAuth()
renderSidebar('vods')

const id = new URLSearchParams(location.search).get('id')
const isEdit = !!id
let notes = []

if (isEdit) {
  document.getElementById('page-title').textContent = 'Edit VOD'
  document.getElementById('delete-btn').style.display = 'block'
  document.getElementById('notes-section').style.display = 'block'

  const { data: vod, error } = await supabase.from('vods').select('*').eq('id', id).single()
  if (error || !vod) { alert('VOD not found.'); location.href = 'vods.html'; return; }

  document.getElementById('f-title').value      = vod.title
  document.getElementById('f-result').value     = vod.result      ?? ''
  document.getElementById('f-score').value      = vod.score       ?? ''
  document.getElementById('f-match-type').value = vod.match_type  ?? 'scrim'
  document.getElementById('f-date').value       = vod.match_date  ?? ''
  document.getElementById('f-demo-link').value  = vod.demo_link   ?? ''

  notes = vod.notes ?? []
  renderNotes()
}

function renderNotes() {
  const el = document.getElementById('notes-list')
  if (!notes.length) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:12px 0">No notes yet. Add the first one below.</div>`
    return
  }
  el.innerHTML = notes.map((n, i) => `
    <div class="note-line">
      <span class="ts-badge">${esc(n.timestamp)}</span>
      <span style="flex:1;color:var(--text)">${esc(n.note)}</span>
      <button onclick="deleteNote(${i})" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px;flex-shrink:0">×</button>
    </div>
  `).join('')
}

window.deleteNote = async (index) => {
  notes.splice(index, 1)
  await saveNotes()
  renderNotes()
}

async function saveNotes() {
  const { error } = await supabase.from('vods').update({ notes }).eq('id', id)
  if (error) console.error('Failed to save notes:', error.message)
}

document.getElementById('add-note-btn').addEventListener('click', async () => {
  const timestamp = document.getElementById('n-timestamp').value.trim()
  const note      = document.getElementById('n-text').value.trim()
  if (!timestamp || !note) return
  notes.push({ timestamp, note })
  await saveNotes()
  document.getElementById('n-timestamp').value = ''
  document.getElementById('n-text').value = ''
  renderNotes()
})

document.getElementById('n-text').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('add-note-btn').click()
})

document.getElementById('save-btn').addEventListener('click', async () => {
  const title      = document.getElementById('f-title').value.trim()
  const result     = document.getElementById('f-result').value      || null
  const score      = document.getElementById('f-score').value.trim()  || null
  const match_type = document.getElementById('f-match-type').value
  const match_date = document.getElementById('f-date').value          || null
  const demo_link  = document.getElementById('f-demo-link').value.trim() || null
  const errEl      = document.getElementById('save-error')

  if (!title) { errEl.textContent = 'Title is required.'; errEl.style.display = 'block'; return }

  const payload = { title, result, score, match_type, match_date, demo_link }

  let error, data
  if (isEdit) {
    ({ error } = await supabase.from('vods').update(payload).eq('id', id))
  } else {
    ({ error, data } = await supabase.from('vods').insert(payload).select().single())
  }

  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }

  if (!isEdit && data) {
    location.href = `vod-detail.html?id=${data.id}`
  } else {
    location.href = 'vods.html'
  }
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this VOD?')) return
  const { error } = await supabase.from('vods').delete().eq('id', id)
  if (error) {
    document.getElementById('save-error').textContent = `Delete failed: ${error.message}`
    document.getElementById('save-error').style.display = 'block'
    return
  }
  location.href = 'vods.html'
})
