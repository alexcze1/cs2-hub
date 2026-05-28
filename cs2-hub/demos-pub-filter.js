// cs2-hub/demos-pub-filter.js
//
// Filter state + match-predicate for the public (Pro) tab on demos.html.
// Pulled out of demos.js so the predicate can be unit-tested without booting
// the full page (which authenticates and hits Supabase at module top).

export const PUB_FILTER_LS_KEY = 'demos:pubfilter:v1'
export const PUB_DEFAULT_FILTER = Object.freeze({
  window: 'all', map: 'all', event: 'all', q: '',
})

export function loadPubFilter() {
  try {
    const v = JSON.parse(localStorage.getItem(PUB_FILTER_LS_KEY) || '{}')
    // Only accept keys we know about — junk values (`window: 'bogus'`) silently
    // fall through to the default for that field on first compare.
    return { ...PUB_DEFAULT_FILTER, ...v }
  } catch { return { ...PUB_DEFAULT_FILTER } }
}

export function savePubFilter(f) {
  try { localStorage.setItem(PUB_FILTER_LS_KEY, JSON.stringify(f)) } catch {}
}

// A "group" here is the list of demos that belong to one match — either a
// single map or all maps of a series. We accept a group rather than a row
// because window/event filters apply to the series as a whole.
export function pubGroupMatchesFilter(demos, filter) {
  const latestAt = Math.max(
    ...demos.map(d => +new Date(d.played_at ?? d.created_at)),
  )
  if (filter.window !== 'all') {
    const days = filter.window === '7d'  ? 7
               : filter.window === '30d' ? 30
               : filter.window === '90d' ? 90
               : null
    if (days != null) {
      const cutoff = Date.now() - days * 86400000
      if (latestAt < cutoff) return false
    }
  }
  if (filter.map !== 'all' && !demos.some(d => d.map === filter.map)) return false
  if (filter.event !== 'all' && !demos.some(d => d.event_name === filter.event)) return false
  if (filter.q && filter.q.trim()) {
    const needle = filter.q.trim().toLowerCase()
    const hay = []
    for (const d of demos) {
      if (d.team_a_name) hay.push(d.team_a_name.toLowerCase())
      if (d.team_b_name) hay.push(d.team_b_name.toLowerCase())
      if (d.event_name)  hay.push(d.event_name.toLowerCase())
    }
    if (!hay.some(s => s.includes(needle))) return false
  }
  return true
}
