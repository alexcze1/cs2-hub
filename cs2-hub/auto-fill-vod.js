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
