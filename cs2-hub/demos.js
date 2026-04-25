// cs2-hub/demos.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function formatDate(d) { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }

await requireAuth()
renderSidebar('demos')

const teamId = getTeamId()
const listEl = document.getElementById('demos-list')
const countEl = document.getElementById('demo-count-sub')
const uploadBtn = document.getElementById('upload-btn')
const fileInput = document.getElementById('demo-file-input')
const progressWrap = document.getElementById('upload-progress')
const progressText = document.getElementById('upload-progress-text')
const progressBar = document.getElementById('upload-progress-bar')

async function loadDemos() {
  const { data, error } = await supabase
    .from('demos')
    .select('id,status,error_message,map,played_at,score_ct,score_t,opponent_name,created_at')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false })

  if (error) {
    listEl.innerHTML = `<div class="empty-state"><h3>Failed to load demos</h3><p>${esc(error.message)}</p></div>`
    return
  }

  countEl.textContent = `${data.length} match${data.length === 1 ? '' : 'es'} uploaded`

  if (!data.length) {
    listEl.innerHTML = `<div class="empty-state"><h3>No demos yet</h3><p>Upload your first .dem file to get started.</p></div>`
    return
  }

  listEl.innerHTML = data.map(d => {
    const mapName = d.map ? d.map.replace('de_', '') : '?'
    const score = d.score_ct != null ? `${d.score_ct}–${d.score_t}` : ''
    const badge = {
      pending:    `<span class="badge badge-warning">Processing</span>`,
      processing: `<span class="badge badge-warning">Processing</span>`,
      ready:      `<span class="badge badge-success">Ready</span>`,
      error:      `<span class="badge badge-error" title="${esc(d.error_message ?? '')}">Error</span>`,
    }[d.status] ?? ''
    const watchBtn = d.status === 'ready'
      ? `<a class="btn btn-primary btn-sm" href="demo-viewer.html?id=${d.id}">▶ Watch</a>`
      : d.status === 'error'
        ? `<button class="btn btn-ghost btn-sm" onclick="retryDemo('${d.id}')">Retry</button>`
        : `<button class="btn btn-ghost btn-sm" disabled>▶ Watch</button>`

    return `
      <div class="list-row" id="demo-row-${d.id}">
        <div class="list-row-icon" style="background:var(--surface-2);font-size:11px;font-weight:600;color:var(--text-secondary)">${esc(mapName.slice(0,3).toUpperCase())}</div>
        <div class="list-row-body">
          <div class="list-row-title">${d.opponent_name ? `vs ${esc(d.opponent_name)}` : 'Demo'} — ${esc(d.map ?? '?')}</div>
          <div class="list-row-sub">${d.played_at ? formatDate(d.played_at) : formatDate(d.created_at)}${score ? ` · ${score}` : ''}</div>
        </div>
        ${badge}
        ${watchBtn}
      </div>`
  }).join('')
}

supabase.channel('demos-status')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'demos', filter: `team_id=eq.${teamId}` }, () => {
    loadDemos()
  })
  .subscribe()

uploadBtn.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0]
  if (!file) return
  fileInput.value = ''

  if (!file.name.endsWith('.dem')) {
    alert('Please select a .dem file.')
    return
  }

  if (file.size > 500 * 1024 * 1024) {
    alert('Demo file must be under 500 MB.')
    return
  }

  progressWrap.style.display = 'block'
  progressText.textContent = `Uploading ${file.name}…`
  progressBar.style.width = '0%'

  const { data: { user } } = await supabase.auth.getUser()
  const demoId = crypto.randomUUID()
  const storagePath = `${teamId}/${demoId}.dem`

  const { error: uploadErr } = await supabase.storage
    .from('demos')
    .upload(storagePath, file, { upsert: false })

  if (uploadErr) {
    progressText.textContent = `Upload failed: ${uploadErr.message}`
    setTimeout(() => { progressWrap.style.display = 'none' }, 4000)
    return
  }

  progressBar.style.width = '60%'
  progressText.textContent = 'Registering demo…'

  const { error: insertErr } = await supabase.from('demos').insert({
    id:           demoId,
    team_id:      teamId,
    uploaded_by:  user.id,
    status:       'pending',
    storage_path: storagePath,
  })

  if (insertErr) {
    progressText.textContent = `Failed to register: ${insertErr.message}`
    await supabase.storage.from('demos').remove([storagePath])
    setTimeout(() => { progressWrap.style.display = 'none' }, 4000)
    return
  }

  progressBar.style.width = '100%'
  progressText.textContent = 'Uploaded — processing in background…'
  setTimeout(() => { progressWrap.style.display = 'none' }, 3000)
  loadDemos()
})

window.retryDemo = async (id) => {
  await supabase.from('demos').update({ status: 'pending', error_message: null }).eq('id', id)
  loadDemos()
}

loadDemos()
