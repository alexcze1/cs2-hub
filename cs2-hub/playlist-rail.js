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

// Detail view stubs — Task 6 fills these in.
function renderDetail() {
  host.innerHTML = `
    <div class="pr-detail-header">
      <button class="pr-back" id="pr-back">←</button>
      <span class="pr-detail-name">${esc(currentPlaylist()?.name ?? '')}</span>
    </div>
    <div class="pr-list"><div class="pr-empty">Detail view coming in Task 6.</div></div>
  `
  host.querySelector('#pr-back').addEventListener('click', () => {
    state.openId = null; state.openRows = []; render()
  })
}

function currentPlaylist() {
  return state.playlists.find(p => p.id === state.openId)
}
