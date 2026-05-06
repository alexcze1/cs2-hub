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
  findRoundMemberships, sortByPosition,
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
      <div class="pr-round-row${active}" data-row-id="${esc(r.id)}" data-key="${esc(key)}">
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
