// cs2-hub/demos.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { showAssignTeamsModal } from './assign-teams-modal.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function formatDate(d) { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }

await requireAuth()
renderSidebar('demos')

const VPS_URL = 'https://vps.midround.pro'
const teamId  = getTeamId()
const listEl  = document.getElementById('demos-list')
const countEl = document.getElementById('demo-count-sub')
const uploadBtn  = document.getElementById('upload-btn')
const fileInput  = document.getElementById('demo-file-input')
const progressWrap = document.getElementById('upload-progress')
const progressText = document.getElementById('upload-progress-text')
const progressBar  = document.getElementById('upload-progress-bar')

// ── Demo list ─────────────────────────────────────────────────
async function loadDemos() {
  const { data, error } = await supabase
    .from('demos')
    .select('id,status,error_message,map,played_at,score_ct,score_t,team_a_score,team_b_score,team_a_first_side,opponent_name,ct_team_name,t_team_name,series_id,created_at')
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

  // Group by series_id
  const seriesMap = new Map()
  const singles   = []

  for (const d of data) {
    if (d.series_id) {
      if (!seriesMap.has(d.series_id)) seriesMap.set(d.series_id, [])
      seriesMap.get(d.series_id).push(d)
    } else {
      singles.push(d)
    }
  }

  // Resolve "left vs right" team labels and scores using per-roster columns when
  // available (correct after halftime swap), falling back to per-side columns
  // for old demos parsed before team_a_score was added. Returns null fields if
  // team names not set so the caller can pick a different label format.
  function teamDisplay(d) {
    const teamsSet = d.ct_team_name && d.t_team_name
    const haveRoster = d.team_a_score != null && d.team_b_score != null && d.team_a_first_side
    if (teamsSet && haveRoster) {
      // team_a_first_side tells us which name belongs to roster A
      const nameA = d.team_a_first_side === 'ct' ? d.ct_team_name : d.t_team_name
      const nameB = d.team_a_first_side === 'ct' ? d.t_team_name  : d.ct_team_name
      return { left: nameA, right: nameB, leftScore: d.team_a_score, rightScore: d.team_b_score }
    }
    if (teamsSet) {
      // Old demo (no per-roster columns) — best-effort: use CT/T mapping (wrong post-halftime)
      return { left: d.ct_team_name, right: d.t_team_name, leftScore: d.score_ct, rightScore: d.score_t }
    }
    // No team names — show side-based label
    return { left: null, right: null, leftScore: d.score_ct, rightScore: d.score_t }
  }

  function demoRow(d, label) {
    const mapName   = d.map ? d.map.replace('de_', '') : '?'
    const td        = teamDisplay(d)
    const score     = td.leftScore != null ? `${td.leftScore}–${td.rightScore}` : ''
    const teamLabel = td.left
      ? `${esc(td.left)} vs ${esc(td.right)}`
      : d.opponent_name ? `vs ${esc(d.opponent_name)}` : 'Demo'
    const title = label || teamLabel

    const badge = {
      pending:    `<span class="badge badge-warning">Processing</span>`,
      processing: `<span class="badge badge-warning">Processing</span>`,
      ready:      `<span class="badge badge-success">Ready</span>`,
      error:      `<span class="badge badge-error" title="${esc(d.error_message ?? '')}">Error</span>`,
    }[d.status] ?? ''

    const assignBtn = d.status === 'ready'
      ? `<button class="btn btn-ghost btn-sm" onclick="assignTeams('${d.id}')">
           ${td.left ? '✎ Teams' : '+ Teams'}
         </button>`
      : ''

    const watchBtn = d.status === 'ready'
      ? `<a class="btn btn-primary btn-sm" href="demo-viewer.html?id=${d.id}">▶ Watch</a>`
      : d.status === 'error'
        ? `<button class="btn btn-ghost btn-sm" onclick="retryDemo('${d.id}')">Retry</button>`
        : `<button class="btn btn-ghost btn-sm" disabled>▶ Watch</button>`

    return `
      <div class="list-row" id="demo-row-${d.id}">
        <div class="list-row-icon" style="background:var(--surface-2);font-size:11px;font-weight:600;color:var(--text-secondary)">${esc(mapName.slice(0,3).toUpperCase())}</div>
        <div class="list-row-body">
          <div class="list-row-title">${title} — ${esc(d.map ?? '?')}</div>
          <div class="list-row-sub">${d.played_at ? formatDate(d.played_at) : formatDate(d.created_at)}${score ? ` · ${score}` : ''}</div>
        </div>
        ${badge}
        ${assignBtn}
        ${watchBtn}
      </div>`
  }

  let html = ''

  for (const [, demos] of seriesMap) {
    const first = demos[0]
    const td = teamDisplay(first)
    const seriesLabel = td.left
      ? `${esc(td.left)} vs ${esc(td.right)}`
      : first.opponent_name ? `vs ${esc(first.opponent_name)}` : 'Series'
    html += `
      <div style="margin-bottom:4px;padding:4px 0 2px 4px;font-size:10px;font-weight:700;color:#555;letter-spacing:0.1em;text-transform:uppercase">
        BO${demos.length > 3 ? 5 : 3} Series · ${seriesLabel}
      </div>`
    demos.forEach((d, i) => {
      html += demoRow(d, `Map ${i + 1} — ${d.map?.replace('de_','') ?? '?'}`)
    })
    html += `<div style="height:12px"></div>`
  }

  for (const d of singles) html += demoRow(d)

  listEl.innerHTML = html
}

supabase.channel('demos-status')
  .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'demos', filter: `team_id=eq.${teamId}` },
      payload => {
        loadDemos()
        maybeAutoOpenAssignModal(payload.new)
      })
  .subscribe()

// Track which series/demos we've already auto-opened a modal for, so we
// don't pop it twice if the realtime event re-fires.
const _autoModalShown = new Set()

async function maybeAutoOpenAssignModal(updated) {
  if (!updated || updated.status !== 'ready') return
  if (updated.ct_team_name && updated.t_team_name) return  // already named

  if (updated.series_id) {
    if (_autoModalShown.has(updated.series_id)) return
    const { data: sib } = await supabase
      .from('demos')
      .select('id,series_id,match_data,ct_team_name,t_team_name,created_at,status')
      .eq('series_id', updated.series_id)
      .order('created_at', { ascending: true })
    if (!sib?.length) return
    if (sib.some(d => d.status !== 'ready')) return  // wait until all done
    if (sib.some(d => d.ct_team_name && d.t_team_name)) {
      _autoModalShown.add(updated.series_id)
      return
    }
    _autoModalShown.add(updated.series_id)
    showAssignTeamsModal(sib, { onSave: loadDemos })
  } else {
    if (_autoModalShown.has(updated.id)) return
    _autoModalShown.add(updated.id)
    showAssignTeamsModal(updated.id, { onSave: loadDemos })
  }
}

window.assignTeams = id => showAssignTeamsModal(id, { onSave: loadDemos })

// ── Upload ────────────────────────────────────────────────────
uploadBtn.addEventListener('click', () => fileInput.click())

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files]
  fileInput.value = ''
  if (!files.length) return

  for (const f of files) {
    if (!f.name.endsWith('.dem')) { alert('Please select .dem files only.'); return }
    if (f.size > 1024 * 1024 * 1024) { alert(`${f.name} is too large (max 1 GB).`); return }
  }

  const seriesId = files.length > 1 ? crypto.randomUUID() : null

  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token

  progressWrap.style.display = 'block'

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    progressBar.style.width = '0%'
    progressText.textContent = files.length > 1
      ? `Uploading map ${i + 1} of ${files.length}: ${file.name}…`
      : `Uploading ${file.name}…`

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('team_id', teamId)

      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${VPS_URL}/upload`)
        xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100)
            progressBar.style.width = pct + '%'
            progressText.textContent = files.length > 1
              ? `Map ${i + 1}/${files.length}: ${file.name} — ${pct}%`
              : `Uploading… ${pct}%`
          }
        }
        xhr.onload = () => xhr.status === 200
          ? resolve(JSON.parse(xhr.responseText))
          : reject(new Error(JSON.parse(xhr.responseText)?.detail || 'Upload failed'))
        xhr.onerror = () => reject(new Error('Could not reach upload server'))
        xhr.send(formData)
      })

      if (seriesId) {
        await supabase.from('demos').update({ series_id: seriesId }).eq('id', result.demo_id)
      }

    } catch (err) {
      progressText.textContent = `Upload failed for ${file.name}: ${err.message}`
      await new Promise(r => setTimeout(r, 3000))
    }
  }

  progressBar.style.width = '100%'
  progressText.textContent = files.length > 1
    ? `${files.length} demos uploaded — processing in background…`
    : 'Uploaded — processing in background…'
  setTimeout(() => { progressWrap.style.display = 'none' }, 3000)
  loadDemos()
})

window.retryDemo = async id => {
  await supabase.from('demos').update({ status: 'pending', error_message: null }).eq('id', id)
  loadDemos()
}

loadDemos()
