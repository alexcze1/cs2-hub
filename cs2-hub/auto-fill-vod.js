// Pure helpers for auto-linking uploaded demos to existing vods.
// No DOM, no Supabase — safe to import from a test page or Node.
//
// Spec: docs/superpowers/specs/2026-05-04-demo-vod-auto-link.md

// Normalize a team or opponent name for comparison: trim + lowercase.
// null/undefined → "" so comparison is total without throwing.
export function normName(s) {
  return (s ?? '').trim().toLowerCase()
}

// Calendar-day delta between two YYYY-MM-DD strings (or anything Date can parse).
// Returns abs difference in days, treating both as local midnight.
function daysApart(aStr, bStr) {
  if (!aStr || !bStr) return Infinity
  const a = new Date(`${aStr}T00:00:00`)
  const b = new Date(`${bStr}T00:00:00`)
  return Math.abs(Math.round((a - b) / 86400000))
}

// YYYY-MM-DD in local TZ. Mirror of localDateStr in pracc-sync.js — kept
// here so this module has no cross-imports. Two trivial copies > a coupling.
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Demo's best calendar date in local TZ. played_at is parser-derived (most
// accurate); fall back to created_at when the parser didn't fill it.
export function demoLocalDate(demo) {
  const ts = demo.played_at || demo.created_at
  if (!ts) return null
  return localDateStr(new Date(ts))
}

// Filter vods to those that could plausibly match the demo:
// - opponent name matches one of the demo's two team names (case-insensitive + trimmed)
// - match_date is within ±1 calendar day of demo date
// Returns a new array; never mutates input.
export function findCandidateVods(demo, vods) {
  if (!demo || !vods?.length) return []
  const demoDate = demoLocalDate(demo)
  if (!demoDate) return []
  const demoNames = [normName(demo.ct_team_name), normName(demo.t_team_name)].filter(Boolean)
  if (!demoNames.length) return []
  return vods.filter(v => {
    if (!v.opponent || !v.match_date) return false
    if (!demoNames.includes(normName(v.opponent))) return false
    return daysApart(v.match_date, demoDate) <= 1
  })
}

// True when no slot in vod.maps[] has scores. We prefer these vods because
// they are usually fresh pracc stubs ready to be filled in.
function isUnscored(vod) {
  if (!vod.maps || vod.maps.length === 0) return true
  return vod.maps.every(s => s.score_us == null && s.score_them == null)
}

// Pick the single best vod from candidates. Sort by:
// 1. unscored (empty/all-empty maps) first — fresh stubs > already-filled
// 2. closer to the demo's date — same-day before ±1
// 3. earlier created_at — deterministic tiebreak
// Returns null on empty.
export function pickBestVod(candidates, demo) {
  if (!candidates?.length) return null
  const demoDate = demoLocalDate(demo)
  const sorted = [...candidates].sort((a, b) => {
    const au = isUnscored(a) ? 0 : 1
    const bu = isUnscored(b) ? 0 : 1
    if (au !== bu) return au - bu
    const ad = daysApart(a.match_date, demoDate)
    const bd = daysApart(b.match_date, demoDate)
    if (ad !== bd) return ad - bd
    return (a.created_at || '').localeCompare(b.created_at || '')
  })
  return sorted[0]
}

// Map team_a_score / team_b_score to score_us / score_them given who the
// opponent is. Requires team_a_first_side to know which team the team_a_*
// totals belong to (the team that started on that side becomes that side's
// "team_a" in the parser's accounting).
//
// Returns null if any required field is missing or the opponent name doesn't
// match either team — those demos can't be auto-filled.
export function scoresFromDemo(demo, opponentName) {
  const a = demo.team_a_score
  const b = demo.team_b_score
  const fs = demo.team_a_first_side
  if (a == null || b == null || !fs) return null
  if (fs !== 'ct' && fs !== 't') return null

  const teamAName = fs === 'ct' ? demo.ct_team_name : demo.t_team_name
  const teamBName = fs === 'ct' ? demo.t_team_name  : demo.ct_team_name
  const opp = normName(opponentName)
  if (normName(teamAName) === opp) return { score_us: b, score_them: a }
  if (normName(teamBName) === opp) return { score_us: a, score_them: b }
  return null
}

// Build a patch for `vod` from one or more demos (a series can apply
// multiple demos to the same vod). Returns null if no slot would be filled.
//
// Patch shape: { maps, result?, demo_link?, _filledMapNames }
// _filledMapNames is metadata for the caller (toast/log); strip before
// sending to Supabase.
//
// Rules:
//   - Match each demo to a slot by map name (case-insensitive). If no name
//     match, claim the first slot whose .map is empty. If no empty slot,
//     append a new slot.
//   - NEVER overwrite a slot that already has score_us or score_them.
//   - After applying all demos, if every slot in maps has both scores set,
//     derive `result` (win/loss/draw) from map-wins.
//   - For a single non-series demo: also set demo_link if vod has none.
export function computeVodPatch(demosArg, vod) {
  if (!vod) return null
  const demos = Array.isArray(demosArg) ? demosArg : [demosArg]
  if (!demos.length) return null

  const newMaps = (vod.maps ?? []).map(s => ({ ...s }))
  const filledMapNames = []
  let filledAny = false

  for (const demo of demos) {
    const scores = scoresFromDemo(demo, vod.opponent)
    if (!scores) continue
    const demoMap = (demo.map || '').toLowerCase()

    // (a) map-name match
    let slotIdx = demoMap
      ? newMaps.findIndex(s => (s.map || '').toLowerCase() === demoMap)
      : -1

    // (b) empty-name slot — claim it
    if (slotIdx === -1) {
      slotIdx = newMaps.findIndex(s => !s.map)
      if (slotIdx !== -1 && demo.map) newMaps[slotIdx].map = demo.map
    }

    // (c) append new slot
    if (slotIdx === -1) {
      newMaps.push({ map: demo.map })
      slotIdx = newMaps.length - 1
    }

    const slot = newMaps[slotIdx]
    if (slot.score_us != null || slot.score_them != null) continue   // never overwrite

    slot.score_us = scores.score_us
    slot.score_them = scores.score_them
    filledAny = true
    if (demo.map) filledMapNames.push(demo.map)
  }

  if (!filledAny) return null

  const patch = { maps: newMaps, _filledMapNames: filledMapNames }

  // Result: only if every slot has both scores.
  if (newMaps.every(s => s.score_us != null && s.score_them != null)) {
    let usWins = 0, themWins = 0
    for (const s of newMaps) {
      if (s.score_us > s.score_them) usWins++
      else if (s.score_us < s.score_them) themWins++
    }
    if (usWins > themWins) patch.result = 'win'
    else if (themWins > usWins) patch.result = 'loss'
    else patch.result = 'draw'
  }

  // Demo link: only for single non-series demos.
  if (demos.length === 1 && !demos[0].series_id && !vod.demo_link && demos[0].id) {
    patch.demo_link = `demo-viewer.html?id=${demos[0].id}`
  }

  return patch
}
