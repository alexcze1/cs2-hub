// cs2-hub/playlist-rail.js
//
// UI for the analysis-page playlist rail (4th column). Two views:
//   - Master: list of team playlists.
//   - Detail: rounds inside a single playlist.
// Wires into analysis.js via the {onLoadRound, onPlayAll, getCurrentTeamId,
// getDemoMeta} hooks passed at mount time.

import { toast } from './toast.js'
import { supabase } from './supabase.js'
import {
  loadPlaylists, loadPlaylistRounds,
  createPlaylist, renamePlaylist, deletePlaylist,
  addRoundToPlaylist, removeRoundFromPlaylist, updateRoundNote,
  findRoundMemberships, sortByPosition, reorderPlaylistRound,
} from './playlists.js'

let host = null
let hooks = null
const state = {
  teamId:        null,
  playlists:     [],     // master list
  loadingMaster: false,
  openId:        null,   // when set, detail view is shown for this playlist id
  openRows:      [],     // playlist_rounds rows for openId, sorted by position
  loadingDetail: false,
  activeRoundKey: null,  // `${demoId}|${roundIdx}` of currently-playing playlist round
}

export function mount(rootEl, h) {
  host = rootEl
  hooks = h
  render()
}

export function unmount() {
  host = null
  hooks = null
}

export async function setTeam(teamId) {
  state.teamId = teamId
  state.openId = null
  state.openRows = []
  if (!teamId) { state.playlists = []; render(); return }
  state.loadingMaster = true
  render()
  try {
    state.playlists = await loadPlaylists(teamId)
  } catch (e) {
    console.error('[playlist-rail] loadPlaylists failed:', e)
    toast('Failed to load playlists', 'error')
    state.playlists = []
  }
  state.loadingMaster = false
  render()
}

/** Called from analysis.js whenever single-round playback enters/leaves a
    saved playlist round, so the rail can highlight the active row. */
export function setActiveRoundKey(key) {
  state.activeRoundKey = key
  render()
}

function render() {
  if (!host) return
  if (state.openId) renderDetail()
  else              renderMaster()
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function renderMaster() {
  const skel = state.loadingMaster
    ? `<div class="pr-skel"></div><div class="pr-skel"></div><div class="pr-skel"></div>`
    : ''
  const empty = !state.loadingMaster && !state.playlists.length
    ? `<div class="pr-empty">No playlists yet · click + to create one.</div>`
    : ''
  const rows = state.playlists.map(p => `
    <div class="pr-pl-row" data-id="${esc(p.id)}">
      <div class="pr-pl-name">${esc(p.name)}</div>
      <div class="pr-pl-meta">${formatRelative(p.updated_at)}</div>
    </div>
  `).join('')

  host.innerHTML = `
    <div class="pr-header">
      <span class="pr-title">Playlists</span>
      <button class="pr-icon-btn" id="pr-new" title="New playlist">+</button>
    </div>
    <div class="pr-list">${skel}${empty}${rows}</div>
  `

  host.querySelector('#pr-new').addEventListener('click', onNewPlaylistClick)
  for (const row of host.querySelectorAll('.pr-pl-row')) {
    row.addEventListener('click', () => openPlaylist(row.dataset.id))
  }
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

async function onNewPlaylistClick() {
  const name = prompt('Playlist name:')
  if (!name || !name.trim()) return
  if (!state.teamId) return
  try {
    const userId = (await supabase.auth.getUser()).data.user?.id
    const row = await createPlaylist(state.teamId, name.trim(), userId)
    state.playlists.unshift(row)
    toast('Playlist created')
    render()
  } catch (e) {
    console.error(e); toast('Failed to create playlist', 'error')
  }
}

async function openPlaylist(id) {
  state.openId = id
  state.openRows = []
  state.loadingDetail = true
  render()
  try {
    const rows = await loadPlaylistRounds(id)
    state.openRows = sortByPosition(rows)
  } catch (e) {
    console.error(e); toast('Failed to load playlist', 'error')
  }
  state.loadingDetail = false
  render()
}

function renderDetail() {
  const pl = currentPlaylist()
  const skel = state.loadingDetail
    ? `<div class="pr-skel"></div><div class="pr-skel"></div>`
    : ''
  const empty = !state.loadingDetail && !state.openRows.length
    ? `<div class="pr-empty">Empty playlist · click ★ on a round to add one.</div>`
    : ''

  host.innerHTML = `
    <div class="pr-detail-header">
      <button class="pr-back" id="pr-back" title="Back">←</button>
      <span class="pr-detail-name">${esc(pl?.name ?? '')}</span>
      ${state.openRows.length ? `<button class="pr-play-all" id="pr-play-all">▶ Play all</button>` : ''}
    </div>
    <div class="pr-list" id="pr-rounds">${skel}${empty}</div>
  `

  host.querySelector('#pr-back').addEventListener('click', () => {
    state.openId = null; state.openRows = []; render()
  })
  host.querySelector('#pr-play-all')?.addEventListener('click', onPlayAllClick)

  if (!state.loadingDetail && state.openRows.length) hydrateRoundRows()
}

async function hydrateRoundRows() {
  const listEl = host.querySelector('#pr-rounds')
  const metas = await Promise.all(state.openRows.map(r => hooks.getDemoMeta(r.demo_id)))

  listEl.innerHTML = state.openRows.map((r, i) => {
    const meta = metas[i]
    const info = describeRound(r, meta)
    const key  = `${r.demo_id}|${r.round_idx}`
    const active = state.activeRoundKey === key ? ' active' : ''
    const thumb = info.mapFile ? `images/maps/${info.mapFile}.png` : ''
    return `
      <div class="pr-round-row${active}" data-row-id="${esc(r.id)}" data-key="${esc(key)}" draggable="true">
        <div class="pr-round-handle" title="Drag to reorder">≡</div>
        <div class="pr-round-thumb" style="background-image:url('${esc(thumb)}')"></div>
        <div class="pr-round-meta">
          <div class="pr-round-title">
            <span class="pr-round-side-dot ${info.side}"></span>R${r.round_idx + 1} · ${esc(info.score)}
          </div>
          <div class="pr-round-note" title="${esc(r.note ?? '')}">${esc(r.note ?? '')}</div>
        </div>
        <button class="pr-round-x" data-row-id="${esc(r.id)}" title="Remove">✕</button>
      </div>
    `
  }).join('')

  for (const row of listEl.querySelectorAll('.pr-round-row')) {
    row.addEventListener('click', e => {
      if (e.target.closest('.pr-round-x')) return  // remove button handled below
      const id = row.dataset.rowId
      const playlistRow = state.openRows.find(x => x.id === id)
      if (playlistRow) hooks.onLoadRound?.(playlistRow)
    })
  }
  for (const x of listEl.querySelectorAll('.pr-round-x')) {
    x.addEventListener('click', e => {
      e.stopPropagation()
      onRemoveRoundClick(x.dataset.rowId)
    })
  }

  let dragId = null
  for (const row of listEl.querySelectorAll('.pr-round-row')) {
    row.addEventListener('dragstart', (e) => {
      dragId = row.dataset.rowId
      row.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', dragId)
    })
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging')
      listEl.querySelectorAll('.drop-above,.drop-below').forEach(r => r.classList.remove('drop-above','drop-below'))
    })
    row.addEventListener('dragover', (e) => {
      if (!dragId || row.dataset.rowId === dragId) return
      e.preventDefault()
      const rect = row.getBoundingClientRect()
      const above = (e.clientY - rect.top) < rect.height / 2
      row.classList.toggle('drop-above', above)
      row.classList.toggle('drop-below', !above)
    })
    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-above','drop-below')
    })
    row.addEventListener('drop', async (e) => {
      e.preventDefault()
      const targetId = row.dataset.rowId
      if (!dragId || targetId === dragId) return
      const above = row.classList.contains('drop-above')
      row.classList.remove('drop-above','drop-below')
      await commitReorder(dragId, targetId, above)
      dragId = null
    })
  }
}

/** Build display fields (side, score, mapFile) from a playlist_rounds row
    and the demo metadata. Mirrors the score-derivation rules already used
    in analysis.js / demos.js. */
function describeRound(row, meta) {
  if (!meta) return { side: 'ct', score: '?–?', mapFile: '' }
  // Side: rough heuristic — pre-halftime (round_idx < 12) the row's
  // ct_team_name is the CT side; after halftime sides flip.
  // We don't know which team owns the playlist viewer, so we just show
  // the round's CT/T mapping by index. The dot reads "what side did the
  // first-named team play this round" which is a reasonable display.
  const half  = Math.floor(row.round_idx / 12)
  const side  = (half % 2 === 0) ? 'ct' : 't'
  const score = (meta.score_ct != null && meta.score_t != null)
    ? `${meta.score_ct}–${meta.score_t}`
    : '—'
  const mapFile = (meta.map ?? '').replace(/^de_/, '').toLowerCase() || ''
  return { side, score, mapFile }
}

async function onRemoveRoundClick(rowId) {
  if (!confirm('Remove round from playlist?')) return
  const row = state.openRows.find(x => x.id === rowId)
  if (!row) return
  try {
    await removeRoundFromPlaylist(row.id, state.openId)
    state.openRows = state.openRows.filter(x => x.id !== rowId)
    toast('Removed')
    render()
  } catch (e) { console.error(e); toast('Failed to remove', 'error') }
}

function onPlayAllClick() {
  if (!state.openRows.length) return
  hooks.onPlayAll?.(state.openRows.slice())
}

function currentPlaylist() {
  return state.playlists.find(p => p.id === state.openId)
}

async function commitReorder(srcId, targetId, above) {
  const rows = state.openRows.slice()
  const srcIdx = rows.findIndex(r => r.id === srcId)
  if (srcIdx < 0) return
  const [moved] = rows.splice(srcIdx, 1)
  let targetIdx = rows.findIndex(r => r.id === targetId)
  if (targetIdx < 0) return
  if (!above) targetIdx += 1
  rows.splice(targetIdx, 0, moved)

  // Reassign positions sequentially. Persist in parallel.
  const updates = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].position !== i) {
      rows[i].position = i
      updates.push(reorderPlaylistRound(rows[i].id, i, state.openId))
    }
  }
  state.openRows = rows
  render()
  try { await Promise.all(updates) } catch (e) {
    console.error(e); toast('Reorder failed', 'error')
  }
}

// ── Save popover ────────────────────────────────────────────────
//
// One popover instance lives in #save-popover and is owned by this module.
// analysis.js calls openSavePopoverFor() with the current round; the popover
// queries memberships and renders save-mode (round not yet saved) or
// manage-mode (round already in 1+ playlists).

let popoverState = null

export async function openSavePopoverFor({ demoId, roundIdx, anchorRect }) {
  if (!state.teamId) return
  const popEl = document.getElementById('save-popover')
  popoverState = { demoId, roundIdx, memberships: [], showCreate: false, newName: '', note: '', selectedId: null }
  positionPopover(popEl, anchorRect)
  popEl.hidden = false
  popEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--muted)">Loading…</div>`
  try {
    popoverState.memberships = await findRoundMemberships(state.teamId, demoId, roundIdx)
  } catch (e) { console.error(e); toast('Failed to load playlists', 'error') }
  renderPopover()
}

export function closeSavePopover() {
  const popEl = document.getElementById('save-popover')
  if (popEl) popEl.hidden = true
  popoverState = null
}

export function isPopoverOpen() {
  return !!popoverState
}

function positionPopover(popEl, anchorRect) {
  if (!anchorRect) return
  const margin = 6
  // Anchor below+right of the button. Clamp to viewport.
  let top  = anchorRect.bottom + margin
  let left = anchorRect.left
  const w  = 260, h = 280
  if (left + w > window.innerWidth)  left = Math.max(8, window.innerWidth  - w - 8)
  if (top  + h > window.innerHeight) top  = Math.max(8, anchorRect.top - h - margin)
  popEl.style.top  = `${top}px`
  popEl.style.left = `${left}px`
}

function renderPopover() {
  const popEl = document.getElementById('save-popover')
  if (!popEl || !popoverState) return
  const { memberships, showCreate, selectedId, note, newName } = popoverState
  const inSaveMode = memberships.length === 0 || popoverState.addingMore

  if (inSaveMode) {
    const candidates = state.playlists.filter(p =>
      !memberships.some(m => m.playlist_id === p.id))
    popEl.innerHTML = `
      <h4>Add to playlist</h4>
      <div class="save-popover-list">
        ${candidates.length ? candidates.map(p => `
          <label class="save-popover-row">
            <input type="radio" name="pl" value="${esc(p.id)}" ${selectedId === p.id ? 'checked' : ''}>
            <span class="name">${esc(p.name)}</span>
          </label>
        `).join('') : `<div class="pr-empty" style="padding:6px">No playlists yet.</div>`}
        ${showCreate
          ? `<input type="text" id="pop-new-name" placeholder="New playlist name" value="${esc(newName)}">`
          : `<a class="new-link" id="pop-show-new">+ New playlist</a>`}
      </div>
      <input type="text" id="pop-note" placeholder="Note (optional, e.g. 'B rotation at 0:38')" value="${esc(note)}">
      <div class="save-popover-actions">
        <button class="btn-secondary" id="pop-cancel">Cancel</button>
        <button class="btn-primary"   id="pop-save">Save</button>
      </div>
    `
    for (const r of popEl.querySelectorAll('input[name="pl"]')) {
      r.addEventListener('change', () => { popoverState.selectedId = r.value })
    }
    popEl.querySelector('#pop-show-new')?.addEventListener('click', () => {
      popoverState.showCreate = true; renderPopover()
      popEl.querySelector('#pop-new-name')?.focus()
    })
    popEl.querySelector('#pop-new-name')?.addEventListener('input', e => {
      popoverState.newName = e.target.value
    })
    popEl.querySelector('#pop-note').addEventListener('input', e => {
      popoverState.note = e.target.value
    })
    popEl.querySelector('#pop-cancel').addEventListener('click', closeSavePopover)
    popEl.querySelector('#pop-save').addEventListener('click', onSavePopoverSubmit)
  } else {
    // Manage mode — list memberships with note + remove.
    popEl.innerHTML = `
      <h4>Saved in ${memberships.length} playlist${memberships.length === 1 ? '' : 's'}</h4>
      <div class="save-popover-list">
        ${memberships.map(m => `
          <div class="save-popover-row" data-pr-id="${esc(m.playlist_round_id)}" data-pl-id="${esc(m.playlist_id)}">
            <span class="name">${esc(m.playlist_name)}</span>
            <button class="x" data-act="remove" title="Remove">✕</button>
          </div>
          <input type="text" class="manage-note" data-pr-id="${esc(m.playlist_round_id)}"
                 data-pl-id="${esc(m.playlist_id)}"
                 placeholder="Note" value="${esc(m.note)}">
        `).join('')}
      </div>
      <a class="new-link" id="pop-add-more">+ Add to another playlist</a>
      <div class="save-popover-actions">
        <button class="btn-secondary" id="pop-close">Close</button>
      </div>
    `
    for (const x of popEl.querySelectorAll('.x[data-act="remove"]')) {
      x.addEventListener('click', e => {
        const row = e.target.closest('[data-pr-id]')
        onPopoverRemove(row.dataset.prId, row.dataset.plId)
      })
    }
    for (const inp of popEl.querySelectorAll('.manage-note')) {
      inp.addEventListener('change', e => {
        onPopoverNoteEdit(e.target.dataset.prId, e.target.dataset.plId, e.target.value)
      })
    }
    popEl.querySelector('#pop-add-more').addEventListener('click', () => {
      popoverState.addingMore = true; renderPopover()
    })
    popEl.querySelector('#pop-close').addEventListener('click', closeSavePopover)
  }
}

async function onSavePopoverSubmit() {
  if (!popoverState) return
  const { demoId, roundIdx, selectedId, showCreate, newName, note } = popoverState
  try {
    let plId = selectedId
    if (showCreate && newName.trim()) {
      const userId = (await supabase.auth.getUser()).data.user?.id
      const created = await createPlaylist(state.teamId, newName.trim(), userId)
      state.playlists.unshift(created)
      plId = created.id
    }
    if (!plId) { toast('Pick or create a playlist', 'error'); return }
    const userId = (await supabase.auth.getUser()).data.user?.id
    const currentRows = (plId === state.openId) ? state.openRows : await loadPlaylistRounds(plId)
    await addRoundToPlaylist({ playlistId: plId, demoId, roundIdx, note, currentRows, userId })
    toast('Saved to playlist')
    closeSavePopover()
    // Refresh detail view if it's open and matches.
    if (state.openId === plId) {
      state.openRows = sortByPosition(await loadPlaylistRounds(plId))
      render()
    }
    // Update star state in the round-nav.
    hooks.onMembershipChanged?.(demoId, roundIdx)
  } catch (e) {
    console.error(e); toast('Failed to save', 'error')
  }
}

async function onPopoverRemove(playlistRoundId, playlistId) {
  try {
    await removeRoundFromPlaylist(playlistRoundId, playlistId)
    popoverState.memberships = popoverState.memberships.filter(m => m.playlist_round_id !== playlistRoundId)
    if (state.openId === playlistId) {
      state.openRows = state.openRows.filter(r => r.id !== playlistRoundId)
    }
    if (!popoverState.memberships.length) closeSavePopover()
    else renderPopover()
    hooks.onMembershipChanged?.(popoverState?.demoId, popoverState?.roundIdx)
    render()
    toast('Removed')
  } catch (e) { console.error(e); toast('Failed to remove', 'error') }
}

async function onPopoverNoteEdit(playlistRoundId, playlistId, value) {
  try {
    await updateRoundNote(playlistRoundId, value, playlistId)
    if (state.openId === playlistId) {
      const r = state.openRows.find(x => x.id === playlistRoundId)
      if (r) r.note = value
      render()
    }
  } catch (e) { console.error(e); toast('Failed to save note', 'error') }
}
