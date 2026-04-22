import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('veto')

const MAPS = ['ancient','mirage','nuke','anubis','inferno','overpass','dust2']
const MAP_LABELS = { ancient:'Ancient', mirage:'Mirage', nuke:'Nuke', anubis:'Anubis', inferno:'Inferno', overpass:'Overpass', dust2:'Dust2' }
const MAP_IMAGES = { ancient:'images/maps/ancient.png', mirage:'images/maps/mirage.png', nuke:'images/maps/nuke.png', anubis:'images/maps/anubis.png', inferno:'images/maps/inferno.png', overpass:'images/maps/overpass.png', dust2:'images/maps/dust.png' }

const BO1_SEQUENCE = [
  { type:'ban',     team:'away' },
  { type:'ban',     team:'home' },
  { type:'ban',     team:'home' },
  { type:'ban',     team:'away' },
  { type:'ban',     team:'away' },
  { type:'ban',     team:'home' },
  { type:'decider', team:'left' },
]
const BO3_SEQUENCE = [
  { type:'ban',     team:'away' },
  { type:'ban',     team:'home' },
  { type:'pick',    team:'away' },
  { type:'pick',    team:'home' },
  { type:'ban',     team:'away' },
  { type:'ban',     team:'home' },
  { type:'decider', team:'left' },
]

let allVetos = []
let editingId = null
let vetoSteps = []

function getSequence() {
  return document.getElementById('f-format').value === 'bo3' ? BO3_SEQUENCE : BO1_SEQUENCE
}

function renderVetoBuilder() {
  const seq = getSequence()
  const home = document.getElementById('f-home').value.trim() || 'Home'
  const away = document.getElementById('f-away').value.trim() || 'Away'

  while (vetoSteps.length < seq.length) vetoSteps.push({ ...seq[vetoSteps.length], map: '' })
  if (vetoSteps.length > seq.length) vetoSteps.length = seq.length

  const usedMaps = vetoSteps.map(s => s.map).filter(Boolean)
  const el = document.getElementById('veto-builder')

  el.innerHTML = `<div style="font-size:11px;font-weight:700;letter-spacing:1px;color:var(--muted);margin-bottom:10px">VETO SEQUENCE</div>
  ${seq.map((step, i) => {
    const teamLabel  = step.team === 'away' ? away : step.team === 'home' ? home : '—'
    const actionLabel = step.type === 'ban' ? 'BAN' : step.type === 'pick' ? 'PICK' : 'PLAYS'
    const actionColor = step.type === 'ban' ? 'var(--danger)' : step.type === 'pick' ? 'var(--success)' : 'var(--accent)'

    if (step.type === 'decider') {
      const leftMap = MAPS.find(m => !usedMaps.slice(0, usedMaps.length - (vetoSteps[i].map ? 1 : 0)).includes(m)) ?? '?'
      return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--border)">
        <span style="width:20px;text-align:center;color:var(--muted);font-size:12px">${i+1}</span>
        <span style="min-width:60px;color:var(--muted);font-size:11px">${esc(teamLabel)}</span>
        <span style="min-width:44px;color:${actionColor};font-size:11px;font-weight:700">${actionLabel}</span>
        <span style="font-size:13px;font-weight:700;color:var(--accent)">${esc(MAP_LABELS[leftMap] ?? leftMap)}</span>
      </div>`
    }

    const availableMaps = MAPS.filter(m => !usedMaps.includes(m) || m === vetoSteps[i]?.map)
    return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--border)">
      <span style="width:20px;text-align:center;color:var(--muted);font-size:12px">${i+1}</span>
      <span style="min-width:60px;color:var(--muted);font-size:11px">${esc(teamLabel)}</span>
      <span style="min-width:44px;color:${actionColor};font-size:11px;font-weight:700">${actionLabel}</span>
      <select class="form-select" style="width:130px;padding:4px 8px;font-size:12px" data-i="${i}">
        <option value="">Pick map…</option>
        ${availableMaps.map(m => `<option value="${m}" ${vetoSteps[i]?.map === m ? 'selected' : ''}>${MAP_LABELS[m]}</option>`).join('')}
      </select>
    </div>`
  }).join('')}`

  el.querySelectorAll('select[data-i]').forEach(sel => sel.addEventListener('change', e => {
    vetoSteps[+e.target.dataset.i].map = e.target.value
    renderVetoBuilder()
  }))
}

async function loadVetos() {
  const { data, error } = await supabase.from('veto_predictions').select('*').eq('team_id', getTeamId()).order('created_at', { ascending: false })
  const el = document.getElementById('veto-list')
  if (error) { el.innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${esc(error.message)}</p></div>`; return }
  allVetos = data ?? []
  if (!allVetos.length) { el.innerHTML = `<div class="empty-state"><h3>No veto predictions yet</h3><p>Create one with the button above.</p></div>`; return }

  el.innerHTML = allVetos.map(v => {
    const steps = v.steps ?? []
    return `<div class="list-row" style="flex-direction:column;align-items:flex-start;gap:10px">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
        <div>
          <div class="row-name">${esc(v.title)}</div>
          <div class="row-meta">${v.opponent ? esc(v.opponent) + ' · ' : ''}<span class="badge badge-scrim">${v.format.toUpperCase()}</span></div>
        </div>
        <button class="btn btn-ghost" style="font-size:12px" data-edit="${v.id}">Edit</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px">
        ${steps.filter(s => s.map).map((s, i) => {
          const color = s.type === 'ban' ? 'var(--danger)' : s.type === 'pick' ? 'var(--success)' : 'var(--accent)'
          const teamLabel = s.team === 'home' ? (v.home || 'Us') : s.team === 'away' ? (v.away || 'Them') : '—'
          const img = MAP_IMAGES[s.map] ?? ''
          return `<div style="position:relative;overflow:hidden;border-radius:8px;width:120px;height:76px;border:1.5px solid ${color};flex-shrink:0">
            ${img ? `<img src="${img}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.18;pointer-events:none">` : ''}
            <div style="position:relative;padding:8px 10px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between">
              <span style="font-size:9px;font-weight:700;letter-spacing:1.2px;color:${color}">${s.type.toUpperCase()}</span>
              <div>
                <div style="font-size:13px;font-weight:700;color:var(--text);line-height:1.2">${esc(MAP_LABELS[s.map] ?? s.map)}</div>
                <div style="font-size:10px;color:var(--muted);margin-top:2px">${esc(teamLabel)}</div>
              </div>
            </div>
          </div>`
        }).join('')}
      </div>
      ${v.notes ? `<div style="color:var(--muted);font-size:12px">${esc(v.notes)}</div>` : ''}
    </div>`
  }).join('')

  el.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); openModal(e.target.dataset.edit) }))
}

function openModal(id = null) {
  editingId = id
  const v = id ? allVetos.find(x => x.id === id) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Veto' : 'New Veto'
  document.getElementById('f-title').value    = v?.title    ?? ''
  document.getElementById('f-opponent').value = v?.opponent ?? ''
  document.getElementById('f-format').value   = v?.format   ?? 'bo1'
  document.getElementById('f-notes').value    = v?.notes    ?? ''
  document.getElementById('f-home').value     = v?.home     ?? 'Us'
  document.getElementById('f-away').value     = v?.away     ?? 'Them'
  vetoSteps = v?.steps ? JSON.parse(JSON.stringify(v.steps)) : []
  document.getElementById('delete-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  renderVetoBuilder()
  document.getElementById('modal').style.display = 'flex'
}

function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

document.getElementById('new-veto-btn').addEventListener('click', () => openModal())
document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click', closeModal)
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal() })
document.getElementById('f-format').addEventListener('change', () => { vetoSteps = []; renderVetoBuilder() })
document.getElementById('f-home').addEventListener('input', renderVetoBuilder)
document.getElementById('f-away').addEventListener('input', renderVetoBuilder)

document.getElementById('save-btn').addEventListener('click', async () => {
  const title    = document.getElementById('f-title').value.trim()
  const opponent = document.getElementById('f-opponent').value.trim() || null
  const format   = document.getElementById('f-format').value
  const notes    = document.getElementById('f-notes').value.trim() || null
  const errEl    = document.getElementById('modal-error')
  if (!title) { errEl.textContent = 'Title is required.'; errEl.style.display = 'block'; return }

  const home = document.getElementById('f-home').value.trim() || 'Us'
  const away = document.getElementById('f-away').value.trim() || 'Them'
  const payload = { title, opponent, format, steps: vetoSteps, notes, home, away, team_id: getTeamId(), updated_at: new Date().toISOString() }
  let error
  if (editingId) {
    ;({ error } = await supabase.from('veto_predictions').update(payload).eq('id', editingId))
  } else {
    ;({ error } = await supabase.from('veto_predictions').insert(payload))
  }
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  const wasEditing = !!editingId
  closeModal(); toast(wasEditing ? 'Veto updated' : 'Veto saved'); loadVetos()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this veto prediction?')) return
  const { error } = await supabase.from('veto_predictions').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); toast('Veto deleted'); loadVetos()
})

loadVetos()
