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
