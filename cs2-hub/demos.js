// cs2-hub/demos.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { attachTeamAutocomplete } from './team-autocomplete.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function formatDate(d) { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }

// Detect two 5-player rosters across one or more demos in a series.
// Returns { rosterA: [{steam_id, name}, ...], rosterB: [...], confident: bool }.
// rosterA = first-frame CT players of map 1 (earliest by created_at).
// rosterB = first-frame T players of map 1.
// confident=false if a subsequent map's CT side is not a subset of either roster
// (e.g. mid-series substitution) — caller should fall back to legacy by-side flow.
function detectRosters(demos) {
  if (!demos.length) return { rosterA: [], rosterB: [], confident: false }
  const sorted = [...demos].sort((a, b) =>
    (a.created_at || '').localeCompare(b.created_at || '')
  )
  const m1 = sorted[0]
  const f0 = m1?.match_data?.frames?.[0]
  if (!f0) return { rosterA: [], rosterB: [], confident: false }
  const rosterA = f0.players.filter(p => p.team === 'ct').map(p => ({ steam_id: p.steam_id, name: p.name }))
  const rosterB = f0.players.filter(p => p.team === 't').map(p => ({ steam_id: p.steam_id, name: p.name }))
  const idsA = new Set(rosterA.map(p => p.steam_id))
  const idsB = new Set(rosterB.map(p => p.steam_id))
  let confident = (rosterA.length === 5 && rosterB.length === 5)
  for (const d of sorted.slice(1)) {
    const fr = d?.match_data?.frames?.[0]
    if (!fr) continue
    const ctIds = fr.players.filter(p => p.team === 'ct').map(p => p.steam_id)
    const tIds  = fr.players.filter(p => p.team === 't').map(p => p.steam_id)
    const ctMatchesA = ctIds.every(id => idsA.has(id))
    const ctMatchesB = ctIds.every(id => idsB.has(id))
    if (!ctMatchesA && !ctMatchesB) {
      confident = false
      console.warn('[demos] roster detection: map', d.id, 'has mixed roster — falling back')
      break
    }
  }
  return { rosterA, rosterB, confident }
}

// Decide which name goes on which side for a given demo's first frame,
// given the roster→name mapping.
function namesForDemo(demo, rosterA, rosterB, nameA, nameB) {
  const fr = demo?.match_data?.frames?.[0]
  if (!fr) return { ct_team_name: null, t_team_name: null }
  const idsA = new Set(rosterA.map(p => p.steam_id))
  const ctIds = fr.players.filter(p => p.team === 'ct').map(p => p.steam_id)
  const ctIsA = ctIds.length > 0 && ctIds.every(id => idsA.has(id))
  return ctIsA
    ? { ct_team_name: nameA, t_team_name: nameB }
    : { ct_team_name: nameB, t_team_name: nameA }
}

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

// ── Assign Teams modal (shown after processing) ───────────────
async function showAssignTeamsModal(demoId) {
  // Fetch match data to show real players per side
  const { data, error } = await supabase
    .from('demos')
    .select('match_data,ct_team_name,t_team_name')
    .eq('id', demoId)
    .single()

  if (error || !data?.match_data) {
    alert('Could not load demo data.')
    return
  }

  // Get players from first frame, grouped by side
  const firstFrame = data.match_data.frames?.[0]
  const ctPlayers  = (firstFrame?.players ?? []).filter(p => p.team === 'ct').map(p => p.name)
  const tPlayers   = (firstFrame?.players ?? []).filter(p => p.team === 't').map(p => p.name)

  function playerList(names, color) {
    if (!names.length) return '<span style="color:#444;font-size:11px">No players found</span>'
    return names.map(n =>
      `<div style="font-size:11px;color:${color};padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(n)}</div>`
    ).join('')
  }

  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:1000;
      display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);
    `
    overlay.innerHTML = `
      <div style="
        background:#0a0a0f;border:1px solid rgba(102,102,183,0.22);border-radius:14px;
        padding:28px 32px;width:480px;max-width:94vw;
        box-shadow:0 0 40px rgba(102,102,183,0.12);
      ">
        <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:20px">Assign Teams</div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
          <div style="background:rgba(79,195,247,0.05);border:1px solid rgba(79,195,247,0.14);border-radius:8px;padding:12px">
            <div style="font-size:10px;font-weight:700;color:rgba(79,195,247,0.7);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">CT Side</div>
            ${playerList(ctPlayers, '#4FC3F7')}
          </div>
          <div style="background:rgba(255,149,0,0.05);border:1px solid rgba(255,149,0,0.14);border-radius:8px;padding:12px">
            <div style="font-size:10px;font-weight:700;color:rgba(255,149,0,0.7);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">T Side</div>
            ${playerList(tPlayers, '#FF9500')}
          </div>
        </div>

        <div style="margin-bottom:14px">
          <label style="font-size:10px;font-weight:700;color:rgba(79,195,247,0.7);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">CT Team Name</label>
          <input id="modal-ct-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(data.ct_team_name ?? '')}">
        </div>
        <div style="margin-bottom:28px">
          <label style="font-size:10px;font-weight:700;color:rgba(255,149,0,0.7);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">T Team Name</label>
          <input id="modal-t-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(data.t_team_name ?? '')}">
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button id="modal-cancel" class="btn btn-ghost">Cancel</button>
          <button id="modal-save" class="btn btn-primary">Save</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    let ctTeamName = data.ct_team_name ?? ''
    let tTeamName  = data.t_team_name  ?? ''

    attachTeamAutocomplete(overlay.querySelector('#modal-ct-input'), t => { ctTeamName = t.name })
    attachTeamAutocomplete(overlay.querySelector('#modal-t-input'),  t => { tTeamName  = t.name })
    overlay.querySelector('#modal-ct-input').addEventListener('input', e => { ctTeamName = e.target.value })
    overlay.querySelector('#modal-t-input').addEventListener('input',  e => { tTeamName  = e.target.value })

    overlay.querySelector('#modal-cancel').addEventListener('click', () => { overlay.remove(); resolve(null) })
    overlay.querySelector('#modal-save').addEventListener('click', async () => {
      await supabase.from('demos').update({
        ct_team_name: ctTeamName || null,
        t_team_name:  tTeamName  || null,
      }).eq('id', demoId)
      overlay.remove()
      resolve({ ctTeamName, tTeamName })
      loadDemos()
    })
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null) } })
  })
}

// ── Demo list ─────────────────────────────────────────────────
async function loadDemos() {
  const { data, error } = await supabase
    .from('demos')
    .select('id,status,error_message,map,played_at,score_ct,score_t,opponent_name,ct_team_name,t_team_name,series_id,created_at')
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

  function demoRow(d, label) {
    const mapName   = d.map ? d.map.replace('de_', '') : '?'
    const score     = d.score_ct != null ? `${d.score_ct}–${d.score_t}` : ''
    const teamsSet  = d.ct_team_name && d.t_team_name
    const teamLabel = teamsSet
      ? `${esc(d.ct_team_name)} vs ${esc(d.t_team_name)}`
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
           ${teamsSet ? '✎ Teams' : '+ Teams'}
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
    const teamsSet = first.ct_team_name && first.t_team_name
    const seriesLabel = teamsSet
      ? `${esc(first.ct_team_name)} vs ${esc(first.t_team_name)}`
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
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'demos', filter: `team_id=eq.${teamId}` }, () => loadDemos())
  .subscribe()

window.assignTeams = id => showAssignTeamsModal(id)

// ── Upload ────────────────────────────────────────────────────
uploadBtn.addEventListener('click', () => fileInput.click())

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files]
  fileInput.value = ''
  if (!files.length) return

  for (const f of files) {
    if (!f.name.endsWith('.dem')) { alert('Please select .dem files only.'); return }
    if (f.size > 500 * 1024 * 1024) { alert(`${f.name} is too large (max 500 MB).`); return }
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
