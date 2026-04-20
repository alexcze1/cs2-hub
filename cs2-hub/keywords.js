import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('keywords')

let allKeywords = []
let editingId = null
let searchQ = ''

async function loadKeywords() {
  const { data, error } = await supabase.from('keywords').select('*').eq('team_id', getTeamId()).order('name', { ascending: true })
  const el = document.getElementById('keywords-grid')
  if (error) { el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Failed to load</h3><p>${esc(error.message)}</p></div>`; return }
  allKeywords = data ?? []
  document.getElementById('kw-sub').textContent = `${allKeywords.length} term${allKeywords.length !== 1 ? 's' : ''} defined`
  renderKeywords()
}

function renderKeywords() {
  const q = searchQ.toLowerCase()
  const filtered = allKeywords.filter(k =>
    !q || k.name.toLowerCase().includes(q) || k.description.toLowerCase().includes(q) || (k.category ?? '').toLowerCase().includes(q)
  )
  const el = document.getElementById('keywords-grid')
  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>No keywords found</h3><p>${searchQ ? 'Try a different search.' : 'Add your first keyword.'}</p></div>`
    return
  }

  el.innerHTML = filtered.map(k => `
    <div class="list-row" style="flex-direction:column;align-items:flex-start;gap:6px">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:flex-start">
        <div>
          <div style="font-weight:700;font-size:14px">${esc(k.name)}</div>
          ${k.category ? `<span class="tag" style="margin-top:2px">${esc(k.category)}</span>` : ''}
        </div>
        <button class="btn btn-ghost" style="font-size:11px;padding:2px 8px" data-edit="${k.id}">Edit</button>
      </div>
      <div style="color:var(--muted);font-size:13px;line-height:1.5">${esc(k.description)}</div>
    </div>
  `).join('')

  el.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); openModal(e.target.dataset.edit) }))
}

function openModal(id = null) {
  editingId = id
  const k = id ? allKeywords.find(x => x.id === id) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Keyword' : 'Add Keyword'
  document.getElementById('f-name').value        = k?.name        ?? ''
  document.getElementById('f-category').value    = k?.category    ?? ''
  document.getElementById('f-description').value = k?.description ?? ''
  document.getElementById('delete-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display = 'flex'
}

function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

document.getElementById('add-btn').addEventListener('click', () => openModal())
document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click', closeModal)
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal() })
document.getElementById('kw-search').addEventListener('input', e => { searchQ = e.target.value.trim(); renderKeywords() })

document.getElementById('save-btn').addEventListener('click', async () => {
  const name        = document.getElementById('f-name').value.trim()
  const category    = document.getElementById('f-category').value.trim() || null
  const description = document.getElementById('f-description').value.trim()
  const errEl       = document.getElementById('modal-error')
  if (!name)        { errEl.textContent = 'Keyword name is required.'; errEl.style.display = 'block'; return }
  if (!description) { errEl.textContent = 'Description is required.';  errEl.style.display = 'block'; return }

  const payload = { name, category, description, team_id: getTeamId() }
  let error
  if (editingId) {
    ;({ error } = await supabase.from('keywords').update(payload).eq('id', editingId))
  } else {
    ;({ error } = await supabase.from('keywords').insert(payload))
  }
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  closeModal(); loadKeywords()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this keyword?')) return
  const { error } = await supabase.from('keywords').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); loadKeywords()
})

loadKeywords()
