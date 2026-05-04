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
