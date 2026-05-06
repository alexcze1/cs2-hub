// cs2-hub/save-popover.js
//
// Standalone save popover for round playlists. Used by the demo viewer (★
// button on the round label) and any other surface that wants the same flow.
//
// Lifecycle: no mount/unmount. The host page provides a #save-popover
// container in its DOM and calls openSavePopoverFor({demoId, roundIdx,
// anchorRect, teamId, onChanged}). The module loads & caches the team's
// playlist list lazily on first open and refreshes it after a new playlist
// is created.

import { toast } from './toast.js'
import { supabase } from './supabase.js'
import {
  loadPlaylists, loadPlaylistRounds,
  createPlaylist,
  addRoundToPlaylist, removeRoundFromPlaylist, updateRoundNote,
  findRoundMemberships, sortByPosition,
} from './playlists.js'

let popoverState = null
let cachedPlaylists = []
let cachedTeamId = null

export async function openSavePopoverFor({ demoId, roundIdx, anchorRect, teamId, onChanged }) {
  if (!teamId) return
  const popEl = document.getElementById('save-popover')
  if (!popEl) { console.warn('[save-popover] no #save-popover element in DOM'); return }

  popoverState = {
    demoId, roundIdx, teamId, onChanged,
    memberships: [], showCreate: false, newName: '', note: '', selectedId: null, addingMore: false,
  }
  positionPopover(popEl, anchorRect)
  popEl.hidden = false
  popEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--muted)">Loading…</div>`

  try {
    if (cachedTeamId !== teamId) {
      cachedPlaylists = await loadPlaylists(teamId)
      cachedTeamId = teamId
    }
    popoverState.memberships = await findRoundMemberships(teamId, demoId, roundIdx)
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

/** Force the cached playlist list to reload on next open (e.g. after the
    host page itself created/deleted a playlist). */
export function invalidatePlaylistCache() {
  cachedPlaylists = []
  cachedTeamId = null
}

function positionPopover(popEl, anchorRect) {
  if (!anchorRect) return
  const margin = 6
  let top  = anchorRect.bottom + margin
  let left = anchorRect.left
  const w  = 260, h = 280
  if (left + w > window.innerWidth)  left = Math.max(8, window.innerWidth  - w - 8)
  if (top  + h > window.innerHeight) top  = Math.max(8, anchorRect.top - h - margin)
  popEl.style.top  = `${top}px`
  popEl.style.left = `${left}px`
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function renderPopover() {
  const popEl = document.getElementById('save-popover')
  if (!popEl || !popoverState) return
  const { memberships, showCreate, selectedId, note, newName } = popoverState
  const inSaveMode = memberships.length === 0 || popoverState.addingMore

  if (inSaveMode) {
    const candidates = cachedPlaylists.filter(p =>
      !memberships.some(m => m.playlist_id === p.id))
    popEl.innerHTML = `
      <h4>Add to playlist</h4>
      <div class="save-popover-list">
        ${candidates.length ? candidates.map(p => `
          <label class="save-popover-row">
            <input type="radio" name="pl" value="${esc(p.id)}" ${selectedId === p.id ? 'checked' : ''}>
            <span class="name">${esc(p.name)}</span>
          </label>
        `).join('') : `<div class="sp-empty">No playlists yet.</div>`}
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
  const { demoId, roundIdx, teamId, onChanged, selectedId, showCreate, newName, note } = popoverState
  try {
    let plId = selectedId
    if (showCreate && newName.trim()) {
      const userId = (await supabase.auth.getUser()).data.user?.id
      const created = await createPlaylist(teamId, newName.trim(), userId)
      cachedPlaylists.unshift(created)
      plId = created.id
    }
    if (!plId) { toast('Pick or create a playlist', 'error'); return }
    const userId = (await supabase.auth.getUser()).data.user?.id
    const currentRows = await loadPlaylistRounds(plId)
    await addRoundToPlaylist({ playlistId: plId, demoId, roundIdx, note, currentRows, userId })
    toast('Saved to playlist')
    closeSavePopover()
    onChanged?.(demoId, roundIdx)
  } catch (e) { console.error(e); toast('Failed to save', 'error') }
}

async function onPopoverRemove(playlistRoundId, playlistId) {
  try {
    await removeRoundFromPlaylist(playlistRoundId, playlistId)
    popoverState.memberships = popoverState.memberships.filter(m => m.playlist_round_id !== playlistRoundId)
    if (!popoverState.memberships.length) {
      const { demoId, roundIdx, onChanged } = popoverState
      closeSavePopover()
      onChanged?.(demoId, roundIdx)
    } else renderPopover()
    toast('Removed')
  } catch (e) { console.error(e); toast('Failed to remove', 'error') }
}

async function onPopoverNoteEdit(playlistRoundId, playlistId, value) {
  try {
    await updateRoundNote(playlistRoundId, value, playlistId)
  } catch (e) { console.error(e); toast('Failed to save note', 'error') }
}
