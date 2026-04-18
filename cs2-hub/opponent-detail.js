// cs2-hub/opponent-detail.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

await requireAuth()
renderSidebar('opponents')

const id     = new URLSearchParams(location.search).get('id')
const isEdit = !!id

let strengths  = []
let weaknesses = []

function renderBulletList(listId, arr, color) {
  const el = document.getElementById(listId)
  el.innerHTML = arr.length
    ? `<ul class="bullet-list">${arr.map((item, i) => `
        <li>
          <span class="dot ${color}"></span>
          <span>${esc(item)}</span>
          <button onclick="removeItem('${listId}', ${i})">×</button>
        </li>`).join('')}</ul>`
    : `<div style="color:var(--muted);font-size:13px;padding:8px 0">None added yet.</div>`
}

window.removeItem = (listId, index) => {
  if (listId === 'strengths-list') strengths.splice(index, 1)
  else weaknesses.splice(index, 1)
  renderBulletList('strengths-list',  strengths,  'dot-green')
  renderBulletList('weaknesses-list', weaknesses, 'dot-red')
}

function addItem(inputId, arr, listId, color) {
  const input = document.getElementById(inputId)
  const val = input.value.trim()
  if (!val) return
  arr.push(val)
  input.value = ''
  renderBulletList(listId, arr, color)
}

document.getElementById('add-strength-btn').addEventListener('click', () =>
  addItem('new-strength', strengths, 'strengths-list', 'dot-green'))
document.getElementById('add-weakness-btn').addEventListener('click', () =>
  addItem('new-weakness', weaknesses, 'weaknesses-list', 'dot-red'))

document.getElementById('new-strength').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('add-strength-btn').click()
})
document.getElementById('new-weakness').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('add-weakness-btn').click()
})

if (isEdit) {
  document.getElementById('page-title').textContent = 'Edit Opponent'
  document.getElementById('delete-btn').style.display = 'block'

  const { data: opp, error } = await supabase.from('opponents').select('*').eq('id', id).single()
  if (error || !opp) { alert('Opponent not found.'); location.href = 'opponents.html'; return; }

  document.getElementById('f-name').value       = opp.name
  document.getElementById('f-maps').value       = (opp.favored_maps ?? []).join(', ')
  document.getElementById('f-anti-strat').value = opp.anti_strat ?? ''
  document.getElementById('f-notes').value      = opp.notes ?? ''

  strengths  = opp.strengths  ?? []
  weaknesses = opp.weaknesses ?? []
}

renderBulletList('strengths-list',  strengths,  'dot-green')
renderBulletList('weaknesses-list', weaknesses, 'dot-red')

document.getElementById('save-btn').addEventListener('click', async () => {
  const name         = document.getElementById('f-name').value.trim()
  const favored_maps = document.getElementById('f-maps').value.split(',').map(m => m.trim()).filter(Boolean)
  const anti_strat   = document.getElementById('f-anti-strat').value.trim() || null
  const notes        = document.getElementById('f-notes').value.trim()      || null
  const errEl        = document.getElementById('save-error')

  if (!name) { errEl.textContent = 'Team name is required.'; errEl.style.display = 'block'; return }

  const payload = { name, favored_maps, strengths, weaknesses, anti_strat, notes, updated_at: new Date().toISOString() }

  let error
  if (isEdit) {
    ({ error } = await supabase.from('opponents').update(payload).eq('id', id))
  } else {
    ({ error } = await supabase.from('opponents').insert(payload))
  }

  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  location.href = 'opponents.html'
})

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
