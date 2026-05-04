export function computePraccVodsToInsert(praccEvents, existingUids, teamId) {
  return praccEvents
    .filter(e => !existingUids.has(e.id))
    .map(e => ({
      team_id: teamId,
      opponent: e.opponent || e.title,
      match_type: 'scrim',
      match_date: e.date.slice(0, 10),
      maps: [],
      external_uid: e.id,
    }))
}
