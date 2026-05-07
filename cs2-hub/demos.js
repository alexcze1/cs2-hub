// cs2-hub/demos.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { showAssignTeamsModal } from './assign-teams-modal.js'
import { getTeamLogo, teamLogoEl } from './team-autocomplete.js'
import {
  loadPlaylists, loadPlaylistRounds, createPlaylist, deletePlaylist, renamePlaylist,
  removeRoundFromPlaylist, sortByPosition,
} from './playlists.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function formatDate(d) { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }
function mapFileFor(map) {
  if (!map) return null
  const m = map.replace(/^de_/, '')
  return m === 'dust2' ? 'dust' : m
}
function mapDisplay(map) {
  if (!map) return '—'
  const m = map.replace(/^de_/, '')
  return m.charAt(0).toUpperCase() + m.slice(1)
}
function mapImg(map, cls) {
  const file = mapFileFor(map)
  if (!file) return `<div class="${cls} demo-map-empty">?</div>`
  const fallback = file.slice(0, 3).toUpperCase()
  return `<div class="${cls}"><img src="images/maps/${file}.png" alt="${esc(map)}" onerror="this.parentElement.innerHTML='<span>${fallback}</span>'"/></div>`
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

const playlistsState = {
  list:         [],
  loaded:       false,
  openId:       null,
  openRows:     [],
  roundCounts:  new Map(),
}

// ── Demo list ─────────────────────────────────────────────────
async function loadDemos() {
  const { data, error } = await supabase
    .from('demos')
    .select('id,status,error_message,map,played_at,score_ct,score_t,team_a_score,team_b_score,team_a_first_side,opponent_name,ct_team_name,t_team_name,series_id,storage_path,created_at')
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

  // Resolve "left vs right" team labels and scores using per-roster columns when
  // available (correct after halftime swap), falling back to per-side columns
  // for old demos parsed before team_a_score was added.
  function teamDisplay(d) {
    const teamsSet = d.ct_team_name && d.t_team_name
    const haveRoster = d.team_a_score != null && d.team_b_score != null && d.team_a_first_side
    if (teamsSet && haveRoster) {
      const nameA = d.team_a_first_side === 'ct' ? d.ct_team_name : d.t_team_name
      const nameB = d.team_a_first_side === 'ct' ? d.t_team_name  : d.ct_team_name
      return { left: nameA, right: nameB, leftScore: d.team_a_score, rightScore: d.team_b_score }
    }
    if (teamsSet) {
      return { left: d.ct_team_name, right: d.t_team_name, leftScore: d.score_ct, rightScore: d.score_t }
    }
    return { left: null, right: null, leftScore: d.score_ct, rightScore: d.score_t }
  }

  // Group demos into entries (single or series), then sort by most recent.
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
  const entries = []
  for (const demos of seriesMap.values()) {
    demos.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const latestAt = Math.max(...demos.map(d => +new Date(d.created_at)))
    entries.push({ kind: 'series', demos, latestAt })
  }
  for (const d of singles) {
    entries.push({ kind: 'single', demos: [d], latestAt: +new Date(d.created_at) })
  }
  entries.sort((a, b) => b.latestAt - a.latestAt)

  // Pre-resolve HLTV team logos for all visible team names.
  const names = new Set()
  for (const d of data) {
    if (d.ct_team_name) names.add(d.ct_team_name)
    if (d.t_team_name)  names.add(d.t_team_name)
    if (d.opponent_name) names.add(d.opponent_name)
  }
  const logoMap = {}
  await Promise.all([...names].map(async n => { logoMap[n] = await getTeamLogo(n) }))

  function statusBadge(d) {
    return {
      pending:    `<span class="badge badge-warning">Processing</span>`,
      processing: `<span class="badge badge-warning">Processing</span>`,
      ready:      ``,
      error:      `<span class="badge badge-error" title="${esc(d.error_message ?? '')}">Error</span>`,
    }[d.status] ?? ''
  }

  function teamsBtn(d, td) {
    if (d.status !== 'ready') return ''
    return `<button class="btn btn-ghost btn-sm" onclick="assignTeams('${d.id}')">${td.left ? '✎ Teams' : '+ Teams'}</button>`
  }

  function watchBtn(d) {
    if (d.status === 'ready')
      return `<a class="btn btn-primary btn-sm" href="demo-viewer.html?id=${d.id}">▶ Watch</a>`
    if (d.status === 'error')
      return `<button class="btn btn-ghost btn-sm" onclick="retryDemo('${d.id}')">Retry</button>`
    return `<button class="btn btn-ghost btn-sm" disabled>▶ Watch</button>`
  }

  function deleteBtn(d) {
    return `<button class="btn btn-ghost btn-sm demo-delete-btn" title="Delete demo" onclick="deleteDemo('${d.id}')">✕</button>`
  }

  function teamRow(name, score, isWinner, hasResult, logoSize = 26) {
    const logo = teamLogoEl(logoMap[name] ?? null, name ?? '???', logoSize)
    const cls = !hasResult ? 'demo-score-none' : isWinner ? 'demo-score-win' : 'demo-score-loss'
    const displayName = name ?? '—'
    return `
      <div class="demo-team-row ${isWinner && hasResult ? 'demo-team-row-winner' : ''}">
        ${logo}
        <span class="demo-team-name">${esc(displayName)}</span>
        <span class="demo-score ${cls}">${score ?? '—'}</span>
      </div>`
  }

  function singleCard(d) {
    const td = teamDisplay(d)
    const hasResult = td.leftScore != null && td.rightScore != null && d.status === 'ready'
    const leftWin  = hasResult && td.leftScore  > td.rightScore
    const rightWin = hasResult && td.rightScore > td.leftScore
    const dateStr = d.played_at ? formatDate(d.played_at) : formatDate(d.created_at)
    const leftName  = td.left  ?? d.opponent_name ?? null
    const rightName = td.right ?? null
    return `
      <div class="demo-card" id="demo-row-${d.id}">
        <div class="demo-card-map">
          ${mapImg(d.map, 'demo-map-lg')}
          <div class="demo-card-map-label">${esc(mapDisplay(d.map))}</div>
        </div>
        <div class="demo-card-body">
          ${teamRow(leftName,  td.leftScore,  leftWin,  hasResult, 28)}
          ${teamRow(rightName, td.rightScore, rightWin, hasResult, 28)}
        </div>
        <div class="demo-card-side">
          <div class="demo-card-meta">${dateStr}</div>
          <div class="demo-card-actions">
            ${statusBadge(d)}
            ${teamsBtn(d, td)}
            ${watchBtn(d)}
            ${deleteBtn(d)}
          </div>
        </div>
      </div>`
  }

  function seriesMapRow(d, i) {
    const td = teamDisplay(d)
    const hasResult = td.leftScore != null && td.rightScore != null && d.status === 'ready'
    const leftWin  = hasResult && td.leftScore  > td.rightScore
    const scoreCls = !hasResult ? 'demo-score-none' : ''
    const winnerName = !hasResult ? '' : (leftWin ? td.left : td.right) ?? ''
    return `
      <div class="demo-series-row" id="demo-row-${d.id}">
        ${mapImg(d.map, 'demo-map-sm')}
        <div class="demo-series-row-name">
          <div class="demo-series-row-map">Map ${i + 1} · ${esc(mapDisplay(d.map))}</div>
          ${winnerName ? `<div class="demo-series-row-winner">${esc(winnerName)} won</div>` : ''}
        </div>
        <div class="demo-series-row-score ${scoreCls}">
          ${hasResult
            ? `<span class="${leftWin ? 'demo-score-win' : 'demo-score-loss'}">${td.leftScore}</span>
               <span class="demo-score-sep">—</span>
               <span class="${!leftWin ? 'demo-score-win' : 'demo-score-loss'}">${td.rightScore}</span>`
            : '— —'}
        </div>
        <div class="demo-series-row-actions">
          ${statusBadge(d)}
          ${teamsBtn(d, td)}
          ${watchBtn(d)}
          ${deleteBtn(d)}
        </div>
      </div>`
  }

  function seriesCard(demos) {
    const first = demos[0]
    const named = demos.find(d => d.ct_team_name && d.t_team_name) ?? first
    const td = teamDisplay(named)
    let mapsLeftWon = 0, mapsRightWon = 0
    for (const d of demos) {
      const t = teamDisplay(d)
      if (d.status !== 'ready' || t.leftScore == null) continue
      if (t.leftScore  > t.rightScore) mapsLeftWon++
      else if (t.rightScore > t.leftScore) mapsRightWon++
    }
    const decided = mapsLeftWon !== mapsRightWon
    const leftWin  = decided && mapsLeftWon  > mapsRightWon
    const rightWin = decided && mapsRightWon > mapsLeftWon
    const total = demos.length
    const boLabel = total <= 1 ? 'BO1' : total <= 3 ? 'BO3' : total <= 5 ? 'BO5' : `BO${total}`
    const dateStr = formatDate(first.played_at ?? first.created_at)
    const leftName  = td.left  ?? first.opponent_name ?? null
    const rightName = td.right ?? null
    const seriesId = first.series_id
    return `
      <div class="demo-series">
        <div class="demo-series-head">
          <div class="demo-series-head-tag">${boLabel} SERIES · ${dateStr}</div>
          <button class="btn btn-ghost btn-sm demo-delete-btn" title="Delete entire series" onclick="deleteSeries('${seriesId}', ${demos.length})">✕ Delete series</button>
        </div>
        <div class="demo-series-teams">
          ${teamRow(leftName,  mapsLeftWon,  leftWin,  decided, 32)}
          ${teamRow(rightName, mapsRightWon, rightWin, decided, 32)}
        </div>
        <div class="demo-series-maps">
          ${demos.map((d, i) => seriesMapRow(d, i)).join('')}
        </div>
      </div>`
  }

  listEl.innerHTML = entries.map(e =>
    e.kind === 'series' ? seriesCard(e.demos) : singleCard(e.demos[0])
  ).join('')
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

async function purgeDemos(rows) {
  const paths = rows.map(r => r.storage_path).filter(Boolean)
  if (paths.length) {
    const { error: storageErr } = await supabase.storage.from('demos').remove(paths)
    if (storageErr) console.warn('Storage delete failed:', storageErr.message)
  }
  const ids = rows.map(r => r.id)
  const { error: rowErr } = await supabase.from('demos').delete().in('id', ids)
  if (rowErr) {
    alert(`Failed to delete: ${rowErr.message}`)
    return false
  }
  return true
}

window.deleteDemo = async id => {
  const { data: row } = await supabase.from('demos').select('id,storage_path,map,series_id').eq('id', id).single()
  if (!row) return
  const label = row.map ? row.map.replace(/^de_/, '') : 'this demo'
  const inSeries = row.series_id ? ' (will leave the rest of the series intact)' : ''
  if (!confirm(`Delete ${label}?${inSeries}\n\nThis cannot be undone.`)) return
  if (await purgeDemos([row])) loadDemos()
}

window.deleteSeries = async (seriesId, count) => {
  if (!confirm(`Delete this entire series (${count} map${count === 1 ? '' : 's'})?\n\nThis cannot be undone.`)) return
  const { data: rows } = await supabase.from('demos').select('id,storage_path').eq('series_id', seriesId)
  if (!rows?.length) return
  if (await purgeDemos(rows)) loadDemos()
}

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
loadPlaylistsForCurrentTeam()

// ── Playlists ─────────────────────────────────────────────────
async function loadPlaylistsForCurrentTeam() {
  const tid = getTeamId()
  if (!tid) {
    document.getElementById('dl-playlists').hidden = true
    return
  }
  try {
    playlistsState.list = await loadPlaylists(tid)
    const ids = playlistsState.list.map(p => p.id)
    const m = new Map()
    if (ids.length) {
      const { data: counts, error } = await supabase
        .from('playlist_rounds')
        .select('playlist_id')
        .in('playlist_id', ids)
      if (error) throw error
      for (const r of counts ?? []) m.set(r.playlist_id, (m.get(r.playlist_id) ?? 0) + 1)
    }
    playlistsState.roundCounts = m
    playlistsState.loaded = true
    renderPlaylistsSection()
  } catch (e) {
    console.error('[demos] load playlists failed:', e)
    toast('Failed to load playlists', 'error')
  }
}

function renderPlaylistsSection() {
  const host = document.getElementById('dl-playlists')
  host.hidden = false
  if (playlistsState.openId) renderPlaylistsDetail(host)
  else                       renderPlaylistsMaster(host)
}

function formatRelative(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const days = Math.round((Date.now() - d.getTime()) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7)  return `${days}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function renderPlaylistsMaster(host) {
  const rows = playlistsState.list.map(p => {
    const count = playlistsState.roundCounts.get(p.id) ?? 0
    return `
      <div class="dl-pl-row" data-id="${esc(p.id)}">
        <div class="dl-pl-name">${esc(p.name)}</div>
        <div class="dl-pl-count">${count} round${count === 1 ? '' : 's'}</div>
        <div class="dl-pl-date">${formatRelative(p.updated_at)}</div>
      </div>
    `
  }).join('')

  host.innerHTML = `
    <div class="dl-pl-header">
      <span class="dl-pl-title">Playlists</span>
      <button class="dl-pl-new" id="dl-pl-new">+ New</button>
    </div>
    <div class="dl-pl-list">
      ${playlistsState.list.length ? rows
        : `<div class="dl-empty">No playlists yet · save a round from the demo viewer to create one.</div>`}
    </div>
  `

  host.querySelector('#dl-pl-new').addEventListener('click', onNewPlaylist)
  for (const row of host.querySelectorAll('.dl-pl-row')) {
    row.addEventListener('click', () => openPlaylist(row.dataset.id))
  }
}

async function onNewPlaylist() {
  const name = prompt('Playlist name:')
  if (!name || !name.trim()) return
  const tid = getTeamId()
  if (!tid) return
  try {
    const userId = (await supabase.auth.getUser()).data.user?.id
    const created = await createPlaylist(tid, name.trim(), userId)
    playlistsState.list.unshift(created)
    playlistsState.roundCounts.set(created.id, 0)
    toast('Playlist created')
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to create playlist', 'error') }
}

async function openPlaylist(id) {
  playlistsState.openId = id
  playlistsState.openRows = []
  renderPlaylistsSection()
  try {
    const rows = await loadPlaylistRounds(id)
    playlistsState.openRows = sortByPosition(rows)
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to load playlist', 'error') }
}

const _demoMetaCache = new Map()

function renderPlaylistsDetail(host) {
  const pl = playlistsState.list.find(p => p.id === playlistsState.openId)
  const empty = !playlistsState.openRows.length
    ? `<div class="dl-empty">Empty playlist · save a round from the demo viewer to add one.</div>`
    : ''

  host.innerHTML = `
    <div class="dl-pl-detail-header">
      <button class="dl-pl-back" id="dl-pl-back" title="Back">←</button>
      <span class="dl-pl-detail-name">${esc(pl?.name ?? '')}</span>
      <button class="dl-pl-action" id="dl-pl-rename" title="Rename playlist">Rename</button>
      <button class="dl-pl-action dl-pl-action-danger" id="dl-pl-delete" title="Delete playlist">Delete</button>
    </div>
    <div class="dl-pl-rounds" id="dl-pl-rounds">${empty}</div>
  `

  host.querySelector('#dl-pl-back').addEventListener('click', () => {
    playlistsState.openId = null
    playlistsState.openRows = []
    renderPlaylistsSection()
  })
  host.querySelector('#dl-pl-rename').addEventListener('click', () => onRenamePlaylist(pl))
  host.querySelector('#dl-pl-delete').addEventListener('click', () => onDeletePlaylist(pl))

  if (playlistsState.openRows.length) hydrateDetailRoundRows()
}

async function getDemoMetaCached(demoId) {
  if (!_demoMetaCache.has(demoId)) {
    const { data, error } = await supabase
      .from('demos')
      .select('id, map, score_ct, score_t')
      .eq('id', demoId).maybeSingle()
    if (error) { console.warn('[demos] getDemoMeta failed:', error); _demoMetaCache.set(demoId, null) }
    else _demoMetaCache.set(demoId, data)
  }
  return _demoMetaCache.get(demoId)
}

function describeRound(row, meta) {
  if (!meta) return { side: 'ct', score: '?–?', mapFile: '' }
  const half  = Math.floor(row.round_idx / 12)
  const side  = (half % 2 === 0) ? 'ct' : 't'
  const score = (meta.score_ct != null && meta.score_t != null)
    ? `${meta.score_ct}–${meta.score_t}`
    : '—'
  const mapFile = (meta.map ?? '').replace(/^de_/, '').toLowerCase() || ''
  return { side, score, mapFile }
}

async function hydrateDetailRoundRows() {
  const listEl = document.getElementById('dl-pl-rounds')
  if (!listEl) return
  const metas = await Promise.all(playlistsState.openRows.map(r => getDemoMetaCached(r.demo_id)))

  listEl.innerHTML = playlistsState.openRows.map((r, i) => {
    const meta = metas[i]
    const info = describeRound(r, meta)
    const thumb = info.mapFile ? `images/maps/${info.mapFile}.png` : ''
    return `
      <div class="dl-round-row" data-row-id="${esc(r.id)}" data-demo-id="${esc(r.demo_id)}" data-round-idx="${r.round_idx}">
        <div class="dl-round-thumb" style="background-image:url('${esc(thumb)}')"></div>
        <div class="dl-round-meta">
          <div class="dl-round-title">
            <span class="dl-round-side-dot ${info.side}"></span>R${r.round_idx + 1} · ${esc(info.score)}
          </div>
          <div class="dl-round-note" title="${esc(r.note ?? '')}">${esc(r.note ?? '')}</div>
        </div>
        <button class="dl-round-x" data-row-id="${esc(r.id)}" title="Remove">✕</button>
      </div>
    `
  }).join('')

  for (const row of listEl.querySelectorAll('.dl-round-row')) {
    row.addEventListener('click', e => {
      if (e.target.closest('.dl-round-x')) return
      const demoId   = row.dataset.demoId
      const roundIdx = row.dataset.roundIdx
      location.href = `demo-viewer.html?id=${encodeURIComponent(demoId)}&round=${encodeURIComponent(roundIdx)}`
    })
  }
  for (const x of listEl.querySelectorAll('.dl-round-x')) {
    x.addEventListener('click', e => {
      e.stopPropagation()
      onRemoveRoundFromPlaylist(x.dataset.rowId)
    })
  }
}

async function onRemoveRoundFromPlaylist(rowId) {
  if (!confirm('Remove round from playlist?')) return
  try {
    await removeRoundFromPlaylist(rowId, playlistsState.openId)
    playlistsState.openRows = playlistsState.openRows.filter(r => r.id !== rowId)
    const cur = playlistsState.roundCounts.get(playlistsState.openId) ?? 0
    playlistsState.roundCounts.set(playlistsState.openId, Math.max(0, cur - 1))
    toast('Removed')
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to remove', 'error') }
}

async function onRenamePlaylist(pl) {
  const newName = prompt('New name:', pl.name)
  if (!newName || !newName.trim() || newName.trim() === pl.name) return
  try {
    await renamePlaylist(pl.id, newName.trim())
    pl.name = newName.trim()
    toast('Renamed')
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to rename', 'error') }
}

async function onDeletePlaylist(pl) {
  if (!confirm(`Delete playlist "${pl.name}"? This removes all its saved rounds.`)) return
  try {
    await deletePlaylist(pl.id)
    playlistsState.list = playlistsState.list.filter(x => x.id !== pl.id)
    playlistsState.roundCounts.delete(pl.id)
    playlistsState.openId = null
    playlistsState.openRows = []
    toast('Playlist deleted')
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to delete', 'error') }
}
