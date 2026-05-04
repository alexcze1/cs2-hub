// Pure detection helpers for demo team assignment.
// No DOM, no Supabase — safe to import from a test page or Node.

// Pick the first frame that has at least 5 CT and 5 T players.
// Falls back to frames[0] if no frame qualifies (so callers that already
// tolerate a partial first frame keep working). Returns null only when
// frames is empty/missing.
export function pickStartFrame(matchData) {
  const frames = matchData?.frames
  if (!frames || frames.length === 0) return null
  for (const fr of frames) {
    const ct = (fr.players ?? []).filter(p => p.team === 'ct').length
    const t  = (fr.players ?? []).filter(p => p.team === 't').length
    if (ct >= 5 && t >= 5) return fr
  }
  return frames[0]
}

// Threshold for treating a later map's CT lineup as the same roster as
// map 1's. Two 5-player rosters are disjoint, so ≥3 unambiguously assigns
// one side. Documented constant; tweak here if real-world data demands it.
const ROSTER_OVERLAP_THRESHOLD = 3

// Detect two 5-player rosters across one or more demos in a series.
// Returns { rosterA: [{steam_id, name}, ...], rosterB: [...], confident }.
// Anchor on map 1 (earliest by created_at). For each later map we tolerate
// up to two substitutions: ≥3-of-5 overlap with rosterA OR rosterB on the
// CT side counts as "same roster on CT".
export function detectRosters(demos) {
  if (!demos.length) return { rosterA: [], rosterB: [], confident: false }
  const sorted = [...demos].sort((a, b) =>
    (a.created_at || '').localeCompare(b.created_at || '')
  )
  const m1 = sorted[0]
  const fr = pickStartFrame(m1?.match_data)
  if (!fr) return { rosterA: [], rosterB: [], confident: false }

  const meta = m1?.match_data?.players_meta ?? {}
  const nameOf = p => meta[p.steam_id]?.name ?? p.name ?? ''
  const rosterA = (fr.players ?? []).filter(p => p.team === 'ct').map(p => ({ steam_id: p.steam_id, name: nameOf(p) }))
  const rosterB = (fr.players ?? []).filter(p => p.team === 't').map(p => ({ steam_id: p.steam_id, name: nameOf(p) }))
  const idsA = new Set(rosterA.map(p => p.steam_id))
  const idsB = new Set(rosterB.map(p => p.steam_id))
  let confident = (rosterA.length === 5 && rosterB.length === 5)

  for (const d of sorted.slice(1)) {
    const fr2 = pickStartFrame(d?.match_data)
    if (!fr2) continue
    const ctIds = (fr2.players ?? []).filter(p => p.team === 'ct').map(p => p.steam_id)
    if (ctIds.length < 5) continue
    const overlapA = ctIds.filter(id => idsA.has(id)).length
    const overlapB = ctIds.filter(id => idsB.has(id)).length
    if (overlapA >= ROSTER_OVERLAP_THRESHOLD) continue
    if (overlapB >= ROSTER_OVERLAP_THRESHOLD) continue
    confident = false
    console.warn('[assign-teams] map', d.id, 'has no roster majority — falling back')
    break
  }
  return { rosterA, rosterB, confident }
}
