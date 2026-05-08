// cs2-hub/roster-stats-aggregate.js
//
// Pure helpers to aggregate `demo_players` rows into per-player career stats,
// per-map breakdowns, and side splits. Weighted by rounds_played.
// All inputs are arrays of demo_players rows — caller fetches & filters first.

const SUM_FIELDS = [
  'kills', 'deaths', 'assists',
  'multi_2k', 'multi_3k', 'multi_4k', 'multi_5k',
  'opening_kills', 'opening_deaths',
  'clutches_won', 'clutches_lost',
  'flash_assists', 'traded_deaths',
]
const PER_ROUND_FIELDS  = ['adr', 'utility_dmg', 'impact_rating']
const PERCENT_FIELDS    = ['hs_pct', 'kast_pct']
const RATING_FIELD      = 'rating'

// Aggregate a list of demo_players rows for ONE player into a single stats object.
// Returns nulls for averaged stats when no rounds were played.
export function aggregatePlayer(rows) {
  const out = { matches: 0, rounds: 0 }
  for (const f of SUM_FIELDS) out[f] = 0

  if (!rows || rows.length === 0) {
    for (const f of PER_ROUND_FIELDS) out[f] = null
    for (const f of PERCENT_FIELDS)   out[f] = null
    out.rating = null
    out.kd = null
    out.utility_dmg_per_round = null
    return out
  }

  let totalRounds = 0
  // Weighted accumulators
  const wsum = {}
  for (const f of [...PER_ROUND_FIELDS, ...PERCENT_FIELDS, RATING_FIELD]) wsum[f] = 0

  for (const r of rows) {
    out.matches++
    const rd = r.rounds_played || 0
    totalRounds += rd
    for (const f of SUM_FIELDS) out[f] += r[f] || 0
    for (const f of [...PER_ROUND_FIELDS, ...PERCENT_FIELDS, RATING_FIELD]) {
      wsum[f] += (r[f] || 0) * rd
    }
  }

  out.rounds = totalRounds
  if (totalRounds > 0) {
    for (const f of [...PER_ROUND_FIELDS, ...PERCENT_FIELDS, RATING_FIELD]) {
      out[f] = wsum[f] / totalRounds
    }
  } else {
    for (const f of [...PER_ROUND_FIELDS, ...PERCENT_FIELDS, RATING_FIELD]) out[f] = null
  }

  out.kd = out.deaths > 0 ? out.kills / out.deaths : (out.kills > 0 ? Infinity : null)
  out.utility_dmg_per_round = totalRounds > 0 ? out.utility_dmg / totalRounds : null

  return out
}

// Aggregate rows grouped by steam_id. Returns Map<steam_id, aggregatePlayer-result>.
export function aggregateByPlayer(rows) {
  const buckets = new Map()
  for (const r of rows || []) {
    if (!r.steam_id) continue
    if (!buckets.has(r.steam_id)) buckets.set(r.steam_id, [])
    buckets.get(r.steam_id).push(r)
  }
  const out = new Map()
  for (const [sid, list] of buckets) out.set(sid, aggregatePlayer(list))
  return out
}

// Aggregate rows grouped by `map` (rows must include a `map` property — caller
// is expected to join demos.map onto demo_players rows before calling).
// Returns array sorted by rating desc: [{ map, agg }].
export function aggregateByMap(rows) {
  const buckets = new Map()
  for (const r of rows || []) {
    if (!r.map) continue
    if (!buckets.has(r.map)) buckets.set(r.map, [])
    buckets.get(r.map).push(r)
  }
  const out = []
  for (const [m, list] of buckets) out.push({ map: m, agg: aggregatePlayer(list) })
  out.sort((a, b) => (b.agg.rating ?? 0) - (a.agg.rating ?? 0))
  return out
}

// Compute the cutoff Date for a window key. Returns null for 'all'.
// `now` is injectable so tests can run deterministically.
export function cutoffDateFor(window, now = new Date()) {
  const days = window === '30d' ? 30 : window === '90d' ? 90 : null
  if (days == null) return null
  const d = new Date(now)
  d.setDate(d.getDate() - days)
  return d
}

// Apply the window filter to a list of vods (objects with `match_date`
// of the form 'YYYY-MM-DD' or ISO timestamp). For 'all', returns input
// untouched. For '30d'/'90d', filters by cutoff. For '10', returns the
// last 10 vods sorted by match_date desc.
export function applyTimeWindow(vods, window, now = new Date()) {
  if (!Array.isArray(vods)) return []
  if (window === 'all') return vods
  if (window === '10') {
    return [...vods]
      .filter(v => v.match_date)
      .sort((a, b) => String(b.match_date).localeCompare(String(a.match_date)))
      .slice(0, 10)
  }
  const cutoff = cutoffDateFor(window, now)
  if (!cutoff) return vods
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  return vods.filter(v => v.match_date && String(v.match_date) >= cutoffStr)
}
