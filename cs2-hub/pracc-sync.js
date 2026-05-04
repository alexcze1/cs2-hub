// YYYY-MM-DD in the runtime's LOCAL timezone (Date.toISOString uses UTC,
// which causes events near midnight to land on the wrong calendar day).
export function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function computePraccVodsToInsert(praccEvents, existingUids, teamId) {
  return praccEvents
    .filter(e => !existingUids.has(e.id))
    .map(e => ({
      team_id: teamId,
      opponent: e.opponent || e.title,
      match_type: 'scrim',
      match_date: localDateStr(new Date(e.date)),
      maps: e.map ? [{ map: e.map }] : [],
      external_uid: e.id,
    }))
}

// Backfill: produce a patch per existing pracc-sourced vod that's out of
// sync with the live pracc event. Two kinds of patch:
//   - maps: prefill the first map if vod has empty maps and event has a map
//   - match_date: correct it if the stored UTC-derived date doesn't match
//     the event's local date (legacy data from before the TZ fix)
// Vods whose maps are non-empty are not touched on the maps field — manual
// edits and entered scores are preserved.
export function computePraccVodsToBackfill(praccEvents, existingVods) {
  const byUid = new Map(existingVods.map(v => [v.external_uid, v]))
  const updates = []
  for (const e of praccEvents) {
    const existing = byUid.get(e.id)
    if (!existing) continue
    const patch = {}
    if (e.map && (!existing.maps || existing.maps.length === 0)) {
      patch.maps = [{ map: e.map }]
    }
    const correctDate = localDateStr(new Date(e.date))
    if (existing.match_date !== correctDate) {
      patch.match_date = correctDate
    }
    // Legacy: opponents stored with leading "vs"/"vs." from older parsing.
    // Strip it. Manual edits don't start with "vs" so are untouched.
    if (existing.opponent && /^vs\.?\s+/i.test(existing.opponent)) {
      const cleaned = existing.opponent.replace(/^vs\.?\s+/i, '').trim()
      if (cleaned && cleaned !== existing.opponent) patch.opponent = cleaned
    }
    if (Object.keys(patch).length) {
      updates.push({ id: existing.id, ...patch })
    }
  }
  return updates
}
