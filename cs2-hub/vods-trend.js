// cs2-hub/vods-trend.js
//
// Pure helpers used by player-impact and map-pool to render trend arrows.
// `computeTrend`: classifies a current-vs-prior delta into up/down/flat/unknown.
// `splitVodsByWindow`: partitions vods into the current selected window and
// the same-length window immediately preceding it.

export function computeTrend(curr, prev, threshold) {
  if (curr == null || prev == null) return 'unknown'
  const delta = curr - prev
  if (delta >  threshold) return 'up'
  if (delta < -threshold) return 'down'
  return 'flat'
}

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function addDays(date, n) {
  const d = new Date(date); d.setDate(d.getDate() + n); return d
}

// allVods: sorted newest-first (matches the existing vods.js load order).
// filter:  { window: '10' | '30d' | '90d' | 'all' }
// now:     injectable for tests; defaults to new Date()
// Returns: { current, prior } — both arrays of vod objects (no copies).
export function splitVodsByWindow(allVods, filter, now = new Date()) {
  if (!Array.isArray(allVods) || allVods.length === 0) return { current: [], prior: [] }
  const w = filter?.window ?? '10'
  if (w === 'all') return { current: allVods.slice(), prior: [] }

  if (w === '10') {
    const sorted = [...allVods]
      .filter(v => v.match_date)
      .sort((a, b) => String(b.match_date).localeCompare(String(a.match_date)))
    return { current: sorted.slice(0, 10), prior: sorted.slice(10, 20) }
  }

  const days = w === '30d' ? 30 : w === '90d' ? 90 : null
  if (days == null) return { current: allVods.slice(), prior: [] }

  const currentCutoff = ymd(addDays(now, -days))
  const priorCutoff   = ymd(addDays(now, -days * 2))
  const current = allVods.filter(v => v.match_date && String(v.match_date) >= currentCutoff)
  const prior   = allVods.filter(v => v.match_date
    && String(v.match_date) >= priorCutoff
    && String(v.match_date) <  currentCutoff)
  return { current, prior }
}
