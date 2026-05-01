// Pure helpers for the analysis page. No DOM, no fetch — testable in isolation.
//
// A "slim payload" looks like:
//   { meta, rounds, frames, grenades, _team_a_first_side, _is_roster_a, _demo_id }
//
// `_is_roster_a` is set by analysis.js from the corpus row, comparing the
// selected team's name against ct_team_name + the team_a_first_side rule.
// Knowing whether the selected team is roster A or B lets us, for each round,
// derive which side (CT/T) the selected team played that round.

/** Returns 'ct' or 't': which side the selected team was on for the given round. */
export function teamSideForRound(payload, round) {
  const aSide = round.side_team_a       // side that roster A played this round
  if (!aSide) return null
  if (payload._is_roster_a) return aSide
  return aSide === 'ct' ? 't' : 'ct'
}

/** Filter a corpus of slim payloads down to a list of RenderRound objects. */
export function narrowRoundsForTeam(payloads, filters) {
  const out = []
  let hueIdx = 0
  for (const payload of payloads) {
    for (const round of payload.rounds) {
      const teamSide = teamSideForRound(payload, round)
      if (teamSide === null) continue

      // Side filter
      if (filters.side !== 'both' && teamSide !== filters.side) continue

      // Outcome filter — round.winner is the winning side ('ct'/'t')
      if (filters.outcome === 'won'  && round.winner !== teamSide) continue
      if (filters.outcome === 'lost' && round.winner === teamSide) continue

      // Bomb site filter
      if (filters.bombSite === 'a' && round.bomb_planted_site !== 'A') continue
      if (filters.bombSite === 'b' && round.bomb_planted_site !== 'B') continue
      if (filters.bombSite === 'none' && round.bomb_planted_site != null) continue

      out.push({
        demoId:         payload._demo_id,
        roundIdx:       round.idx,
        freezeEndTick:  round.freeze_end_tick,
        endTick:        round.end_tick,
        teamSide,
        hue:            (hueIdx++ * 137) % 360,   // golden-angle distribution
        // Frames + grenades referenced lazily — caller indexes into payload by roundIdx
        _payload:       payload,
      })
    }
  }
  return out
}

/** Return the subset of `frames` from the payload that belong to a round. */
export function framesForRound(payload, roundIdx) {
  return payload.frames.filter(f => f.round_idx === roundIdx)
}

/** Return the subset of `grenades` from the payload that belong to a round. */
export function grenadesForRound(payload, roundIdx) {
  return payload.grenades.filter(g => g.round_idx === roundIdx)
}
