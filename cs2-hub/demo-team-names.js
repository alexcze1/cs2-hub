// cs2-hub/demo-team-names.js
//
// Resolve real per-side team names for a single demo. Public HLTV demos
// don't have ct_team_name / t_team_name populated (the parser only fills
// those for team-uploaded demos where the user manually assigns them).
//
// The fix: project them from HLTV's team_a_name / team_b_name plus the
// parser's team_a_first_side, with score correlation used to figure out
// which HLTV-labelled team corresponds to the parser's team-letter A vs
// team-letter B. Same trick we already use on the analysis page and in
// vods.js, packaged here so the viewer header and the scoreboard can
// both rely on it.

import { supabase } from './supabase.js'

// Given a demo row + its demo_team_stats rows, returns
//   { ctName, tName, ctLetter, tLetter }
// or { ctName: null, tName: null } when the data isn't enough to resolve.
//
// ctLetter / tLetter are the PARSER letters ('a' or 'b') that ended up on
// each side at round 1 — useful when the caller already has rows keyed by
// team letter and just wants to swap them at halftime.
export function resolveTeamNames(demo, teamStatsRows) {
  if (!demo) return { ctName: null, tName: null, ctLetter: null, tLetter: null }

  // Fast path — names already set by the parser / assign-teams modal.
  if (demo.ct_team_name && demo.t_team_name) {
    const aFirstSide = demo.team_a_first_side
    const ctLetter = aFirstSide === 't' ? 'b' : 'a'  // parser A started CT iff aFirstSide==='ct'
    const tLetter  = ctLetter === 'a' ? 'b' : 'a'
    return { ctName: demo.ct_team_name, tName: demo.t_team_name, ctLetter, tLetter }
  }

  const ta = demo.team_a_name, tb = demo.team_b_name
  if (!ta || !tb) return { ctName: null, tName: null, ctLetter: null, tLetter: null }

  // Score correlation — figure out which HLTV team is parser's letter A.
  // Sum parser-letter wins from the team_stats rows, compare to the
  // HLTV-stored team_a_score / team_b_score. The HLTV name whose score
  // matches parser-letter-A's wins == parser A's actual team.
  const wins = { a: 0, b: 0 }
  for (const r of teamStatsRows || []) {
    if (r.team === 'a' || r.team === 'b') {
      wins[r.team] = (r.ct_round_wins || 0) + (r.t_round_wins || 0)
    }
  }
  const tas = demo.team_a_score, tbs = demo.team_b_score

  let parserAisHltvA = null  // true ⇒ parser's team A == HLTV's team_a_name
  if (tas != null && tbs != null && tas !== tbs && wins.a !== wins.b) {
    if (wins.a === tas && wins.b === tbs) parserAisHltvA = true
    else if (wins.a === tbs && wins.b === tas) parserAisHltvA = false
  }
  // Fall back to the assumption (correct ~50% of the time but no worse than
  // showing "Team A / Team B") when correlation is ambiguous.
  if (parserAisHltvA === null) parserAisHltvA = true

  const parserAName = parserAisHltvA ? ta : tb
  const parserBName = parserAisHltvA ? tb : ta

  // team_a_first_side='ct' ⇒ parser A started CT
  const aFirstSide = demo.team_a_first_side
  const aStartedCt = (aFirstSide ?? 'ct') !== 't'
  const ctName = aStartedCt ? parserAName : parserBName
  const tName  = aStartedCt ? parserBName : parserAName
  const ctLetter = aStartedCt ? 'a' : 'b'
  const tLetter  = aStartedCt ? 'b' : 'a'
  return { ctName, tName, ctLetter, tLetter }
}

// Convenience: fetch + resolve in one call. Caller already has the demo row
// but no team_stats rows. Returns the same shape as resolveTeamNames.
export async function fetchAndResolveTeamNames(demo) {
  if (!demo?.id) return { ctName: null, tName: null, ctLetter: null, tLetter: null }
  if (demo.ct_team_name && demo.t_team_name) {
    return resolveTeamNames(demo, [])
  }
  const { data } = await supabase
    .from('demo_team_stats')
    .select('team, ct_round_wins, t_round_wins')
    .eq('demo_id', demo.id)
  return resolveTeamNames(demo, data ?? [])
}
