// cs2-hub/roster-steam-backfill.js
//
// Pure helpers for suggesting Steam IDs to attach to roster rows.
// Input: demo_players rows from recent demos. Output: ranked candidates.

// Rank steam_ids whose appearance name contains the given nickname.
// Excludes steam_ids already assigned to other roster rows.
// Returns [{ steam_id, name, count }, ...] sorted by count desc.
export function rankCandidates(rows, nickname, assignedSteamIds) {
  if (!rows?.length || !nickname) return []
  const target = String(nickname).toLowerCase()
  const counts = new Map() // steam_id → { name, count }

  for (const r of rows) {
    if (!r?.steam_id || !r.name) continue
    if (assignedSteamIds && assignedSteamIds.has(r.steam_id)) continue
    if (!String(r.name).toLowerCase().includes(target)) continue
    const cur = counts.get(r.steam_id)
    if (cur) cur.count++
    else counts.set(r.steam_id, { steam_id: r.steam_id, name: r.name, count: 1 })
  }

  return [...counts.values()].sort((a, b) => b.count - a.count)
}
