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
  // Names live on match_data.players_meta on new demos; fall back to per-frame
  // p.name for old demos parsed before the payload trim.
  const meta1 = m1?.match_data?.players_meta ?? {}
  const nameOf = p => meta1[p.steam_id]?.name ?? p.name ?? ''
  const rosterA = f0.players.filter(p => p.team === 'ct').map(p => ({ steam_id: p.steam_id, name: nameOf(p) }))
  const rosterB = f0.players.filter(p => p.team === 't').map(p => ({ steam_id: p.steam_id, name: nameOf(p) }))
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

// ── Assign Teams modal (roster-based) ─────────────────────────
// Argument is either a single demo id (legacy), or an array of demos that
// share a series (the trigger gates this).
async function showAssignTeamsModal(demoIdOrSeries) {
  // Normalise to a list of demos with match_data.
  let demos = []
  if (Array.isArray(demoIdOrSeries)) {
    demos = demoIdOrSeries
  } else {
    const { data: d, error } = await supabase
      .from('demos')
      .select('id,series_id,match_data,ct_team_name,t_team_name,created_at')
      .eq('id', demoIdOrSeries)
      .single()
    if (error || !d) { alert('Could not load demo data.'); return }
    if (d.series_id) {
      const { data: sib } = await supabase
        .from('demos')
        .select('id,series_id,match_data,ct_team_name,t_team_name,created_at')
        .eq('series_id', d.series_id)
        .order('created_at', { ascending: true })
      demos = sib || [d]
    } else {
      demos = [d]
    }
  }
  if (!demos.length || !demos[0].match_data) { alert('No demo data.'); return }

  const { rosterA, rosterB, confident } = detectRosters(demos)
  if (!confident) {
    alert('Mixed roster across maps — falling back to per-map team assignment.')
    return showLegacyBySideModal(demos[0].id)
  }

  // Pre-fill names from existing data: look at map 1's saved names + side mapping.
  const m1 = demos[0]
  const m1Names = namesForDemo(m1, rosterA, rosterB, 'A', 'B')
  // m1Names.ct_team_name is 'A' if Roster A was on CT in map 1, else 'B'.
  const aSavedSide = m1Names.ct_team_name === 'A' ? 'ct' : 't'
  const initialA = aSavedSide === 'ct' ? (m1.ct_team_name ?? '') : (m1.t_team_name ?? '')
  const initialB = aSavedSide === 'ct' ? (m1.t_team_name ?? '') : (m1.ct_team_name ?? '')

  function rosterPanel(label, players, accent) {
    const lines = players.map(p =>
      `<div style="font-size:11px;color:${accent};padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>`
    ).join('')
    return `
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.10);border-radius:8px;padding:12px">
        <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.55);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">${label}</div>
        ${lines || '<span style="color:#444;font-size:11px">No players found</span>'}
      </div>`
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
        padding:28px 32px;width:520px;max-width:94vw;
        box-shadow:0 0 40px rgba(102,102,183,0.12);
      ">
        <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px">Assign Teams</div>
        <div style="font-size:11px;color:#666;margin-bottom:20px">${demos.length > 1 ? `Applies to all ${demos.length} maps in this series.` : 'Applies to this map.'}</div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
          ${rosterPanel('Roster A', rosterA, '#bbb')}
          ${rosterPanel('Roster B', rosterB, '#bbb')}
        </div>

        <div style="margin-bottom:14px">
          <label style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.55);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">Roster A team name</label>
          <input id="modal-a-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(initialA)}">
        </div>
        <div style="margin-bottom:28px">
          <label style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.55);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">Roster B team name</label>
          <input id="modal-b-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(initialB)}">
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button id="modal-cancel" class="btn btn-ghost">Cancel</button>
          <button id="modal-save" class="btn btn-primary">Save</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    let nameA = initialA
    let nameB = initialB

    attachTeamAutocomplete(overlay.querySelector('#modal-a-input'), t => { nameA = t.name })
    attachTeamAutocomplete(overlay.querySelector('#modal-b-input'), t => { nameB = t.name })
    overlay.querySelector('#modal-a-input').addEventListener('input', e => { nameA = e.target.value })
    overlay.querySelector('#modal-b-input').addEventListener('input', e => { nameB = e.target.value })

    overlay.querySelector('#modal-cancel').addEventListener('click', () => { overlay.remove(); resolve(null) })
    overlay.querySelector('#modal-save').addEventListener('click', async () => {
      const updates = []
      for (const d of demos) {
        const names = namesForDemo(d, rosterA, rosterB, nameA, nameB)
        updates.push(supabase.from('demos').update({
          ct_team_name: names.ct_team_name || null,
          t_team_name:  names.t_team_name  || null,
        }).eq('id', d.id))
      }
      await Promise.all(updates)
      overlay.remove()
      resolve({ nameA, nameB })
      loadDemos()
    })
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null) } })
  })
}

// Legacy by-side modal — used as a fallback when roster detection fails.
async function showLegacyBySideModal(demoId) {
  const { data, error } = await supabase
    .from('demos')
    .select('match_data,ct_team_name,t_team_name')
    .eq('id', demoId)
    .single()
  if (error || !data?.match_data) { alert('Could not load demo data.'); return null }
  const firstFrame = data.match_data.frames?.[0]
  const meta = data.match_data.players_meta ?? {}
  const nameOf = p => meta[p.steam_id]?.name ?? p.name ?? ''
  const ctPlayers  = (firstFrame?.players ?? []).filter(p => p.team === 'ct').map(nameOf)
  const tPlayers   = (firstFrame?.players ?? []).filter(p => p.team === 't').map(nameOf)

  function playerList(names, color) {
    if (!names.length) return '<span style="color:#444;font-size:11px">No players found</span>'
    return names.map(n =>
      `<div style="font-size:11px;color:${color};padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(n)}</div>`
    ).join('')
  }

  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:1000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);`
    overlay.innerHTML = `
      <div style="background:#0a0a0f;border:1px solid rgba(102,102,183,0.22);border-radius:14px;padding:28px 32px;width:480px;max-width:94vw;box-shadow:0 0 40px rgba(102,102,183,0.12);">
        <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:20px">Assign Teams (per-side)</div>
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
        <div style="margin-bottom:14px"><label style="font-size:10px;font-weight:700;color:rgba(79,195,247,0.7);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">CT Team Name</label><input id="legacy-ct-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(data.ct_team_name ?? '')}"></div>
        <div style="margin-bottom:28px"><label style="font-size:10px;font-weight:700;color:rgba(255,149,0,0.7);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">T Team Name</label><input id="legacy-t-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(data.t_team_name ?? '')}"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end"><button id="legacy-cancel" class="btn btn-ghost">Cancel</button><button id="legacy-save" class="btn btn-primary">Save</button></div>
      </div>`
    document.body.appendChild(overlay)
    let ct = data.ct_team_name ?? '', t = data.t_team_name ?? ''
    attachTeamAutocomplete(overlay.querySelector('#legacy-ct-input'), x => { ct = x.name })
    attachTeamAutocomplete(overlay.querySelector('#legacy-t-input'),  x => { t  = x.name })
    overlay.querySelector('#legacy-ct-input').addEventListener('input', e => { ct = e.target.value })
    overlay.querySelector('#legacy-t-input').addEventListener('input',  e => { t  = e.target.value })
    overlay.querySelector('#legacy-cancel').addEventListener('click', () => { overlay.remove(); resolve(null) })
    overlay.querySelector('#legacy-save').addEventListener('click', async () => {
      await supabase.from('demos').update({
        ct_team_name: ct || null,
        t_team_name:  t  || null,
      }).eq('id', demoId)
      overlay.remove()
      resolve({ ct, t })
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
    showAssignTeamsModal(sib)
  } else {
    if (_autoModalShown.has(updated.id)) return
    _autoModalShown.add(updated.id)
    showAssignTeamsModal(updated.id)
  }
}

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
