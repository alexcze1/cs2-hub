// cs2-hub/playlists.js
//
// Team-shared round playlists for the analysis page. Two layers:
//   - Pure helpers (this section) — testable in isolation.
//   - Supabase wrappers (added in Task 3).

// ── Pure helpers ────────────────────────────────────────────────

/** Next `position` value when appending to a list of playlist_rounds rows. */
export function nextPosition(rows) {
  if (!rows.length) return 0
  let max = -1
  for (const r of rows) if (r.position > max) max = r.position
  return max + 1
}

/** Stable ascending-by-position copy. Does not mutate input. */
export function sortByPosition(rows) {
  return rows.slice().sort((a, b) => a.position - b.position)
}

/** Composite identity for (demoId, roundIdx) used for client-side dedup checks. */
export function dedupeKey(demoId, roundIdx) {
  return `${demoId}|${roundIdx}`
}

/** True if any row in the list points at (demoId, roundIdx). */
export function isRoundInPlaylist(rows, demoId, roundIdx) {
  for (const r of rows) {
    if (r.demo_id === demoId && r.round_idx === roundIdx) return true
  }
  return false
}

// ── Supabase wrappers ───────────────────────────────────────────

import { supabase } from './supabase.js'

/** List all playlists for a team, sorted by most-recent activity first. */
export async function loadPlaylists(teamId) {
  const { data, error } = await supabase
    .from('playlists')
    .select('id, team_id, name, description, created_by, created_at, updated_at')
    .eq('team_id', teamId)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

/** List rounds inside a playlist, ordered by `position`. */
export async function loadPlaylistRounds(playlistId) {
  const { data, error } = await supabase
    .from('playlist_rounds')
    .select('id, playlist_id, demo_id, round_idx, note, position, added_by, added_at')
    .eq('playlist_id', playlistId)
    .order('position', { ascending: true })
  if (error) throw error
  return data ?? []
}

/** Find every playlist that already contains (demoId, roundIdx) for a team.
    Returns an array of { playlist_id, playlist_name, playlist_round_id, note }. */
export async function findRoundMemberships(teamId, demoId, roundIdx) {
  const { data, error } = await supabase
    .from('playlist_rounds')
    .select('id, note, playlist_id, playlists!inner(name, team_id)')
    .eq('demo_id', demoId)
    .eq('round_idx', roundIdx)
    .eq('playlists.team_id', teamId)
  if (error) throw error
  return (data ?? []).map(r => ({
    playlist_id:       r.playlist_id,
    playlist_name:     r.playlists?.name ?? '',
    playlist_round_id: r.id,
    note:              r.note ?? '',
  }))
}

/** Create a playlist. Returns the inserted row. */
export async function createPlaylist(teamId, name, userId) {
  const { data, error } = await supabase
    .from('playlists')
    .insert({ team_id: teamId, name, created_by: userId })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function renamePlaylist(playlistId, name) {
  const { error } = await supabase
    .from('playlists')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', playlistId)
  if (error) throw error
}

export async function deletePlaylist(playlistId) {
  const { error } = await supabase.from('playlists').delete().eq('id', playlistId)
  if (error) throw error
}

/** Append a round to a playlist. Caller passes the current rows so we can
    compute the next `position` without an extra round-trip. Touches the
    parent playlist's `updated_at` so the rail re-sorts on next load. */
export async function addRoundToPlaylist({ playlistId, demoId, roundIdx, note, currentRows, userId }) {
  const position = nextPosition(currentRows)
  const { data, error } = await supabase
    .from('playlist_rounds')
    .insert({
      playlist_id: playlistId,
      demo_id:     demoId,
      round_idx:   roundIdx,
      note:        note || null,
      position,
      added_by:    userId,
    })
    .select()
    .single()
  if (error) throw error
  await touchPlaylist(playlistId)
  return data
}

export async function removeRoundFromPlaylist(playlistRoundId, playlistId) {
  const { error } = await supabase
    .from('playlist_rounds')
    .delete()
    .eq('id', playlistRoundId)
  if (error) throw error
  await touchPlaylist(playlistId)
}

export async function updateRoundNote(playlistRoundId, note, playlistId) {
  const { error } = await supabase
    .from('playlist_rounds')
    .update({ note: note || null })
    .eq('id', playlistRoundId)
  if (error) throw error
  await touchPlaylist(playlistId)
}

/** Move a round to a new `position` value (caller computes the value). */
export async function reorderPlaylistRound(playlistRoundId, newPosition, playlistId) {
  const { error } = await supabase
    .from('playlist_rounds')
    .update({ position: newPosition })
    .eq('id', playlistRoundId)
  if (error) throw error
  await touchPlaylist(playlistId)
}

async function touchPlaylist(playlistId) {
  await supabase
    .from('playlists')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', playlistId)
}
