// cs2-hub/opponent-detail.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

await requireAuth()
renderSidebar('opponents')

const id     = new URLSearchParams(location.search).get('id')
const isEdit = !!id

const FIELDS = ['pistols','style','antiecos','forces','tendencies','exploits','solutions']

function getSheet(prefix) {
  const obj = {}
  FIELDS.forEach(f => { obj[f] = document.getElementById(`${prefix}-${f}`).value.trim() || '' })
  return obj
}

function setSheet(prefix, data) {
  FIELDS.forEach(f => { document.getElementById(`${prefix}-${f}`).value = data?.[f] ?? '' })
}

if (isEdit) {
  document.getElementById('page-title').textContent = 'Edit Opponent'
  document.getElementById('delete-btn').style.display = 'block'

  const { data: opp, error } = await supabase.from('opponents').select('*').eq('id', id).single()
  if (error || !opp) { alert('Opponent not found.'); location.href = 'opponents.html'; throw 0; }

  document.getElementById('f-name').value = opp.name
  document.getElementById('f-maps').value = (opp.favored_maps ?? []).join(', ')

  setSheet('ct', opp.ct_gameplan ?? {})
  setSheet('t',  opp.t_gameplan  ?? {})
}

document.getElementById('save-btn').addEventListener('click', async () => {
  const name         = document.getElementById('f-name').value.trim()
  const favored_maps = document.getElementById('f-maps').value.split(',').map(m => m.trim()).filter(Boolean)
  const errEl        = document.getElementById('save-error')

  if (!name) { errEl.textContent = 'Team name is required.'; errEl.style.display = 'block'; return }

  const ct_gameplan = getSheet('ct')
  const t_gameplan  = getSheet('t')

  const payload = { name, favored_maps, ct_gameplan, t_gameplan, updated_at: new Date().toISOString() }

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
