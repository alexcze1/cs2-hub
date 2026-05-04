export function computePraccVodsToInsert(praccEvents, existingUids, teamId) {
  return praccEvents
    .filter(e => !existingUids.has(e.id))
    .map(e => ({
      team_id: teamId,
      opponent: e.opponent || e.title,
      match_type: 'scrim',
      match_date: e.date.slice(0, 10),
      maps: e.map ? [{ map: e.map }] : [],
      external_uid: e.id,
    }))
}

// Backfill: for pracc events whose vod already exists but has an empty maps
// array, return updates that prefill the map. Vods with any maps already set
// are left alone (don't overwrite manual edits).
export function computePraccVodsToBackfill(praccEvents, existingVods) {
  const byUid = new Map(existingVods.map(v => [v.external_uid, v]))
  const updates = []
  for (const e of praccEvents) {
    if (!e.map) continue
    const existing = byUid.get(e.id)
    if (existing && (!existing.maps || existing.maps.length === 0)) {
      updates.push({ id: existing.id, maps: [{ map: e.map }] })
    }
  }
  return updates
}
