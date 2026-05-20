// cs2-hub/team-stats-aggregate.js
//
// Pure helpers to aggregate `demo_team_stats` rows into a team-level summary
// and compute current-vs-prior deltas for the percentage tiles.
// All inputs are arrays of demo_team_stats rows (already filtered to "our team"
// by the caller). No Supabase, no DOM.

// Sum field pairs (wins, played) for a list of rows.
function sumWinsPlayed(rows, winsKey, playedKey) {
  let wins = 0, played = 0
  for (const r of rows || []) {
    wins   += r[winsKey]   || 0
    played += r[playedKey] || 0
  }
  return { wins, played }
}

function pct(wins, played) {
  return played > 0 ? wins / played : null
}

// Sum a single counter across rows.
function sumOne(rows, key) {
  let n = 0
  for (const r of rows || []) n += r[key] || 0
  return n
}

// Aggregate a list of demo_team_stats rows (one per demo, our team's row only).
// Returns a shape with one entry per tile:
//   percentage tiles → { wins, played, pct }
//   force tile       → { wins, played }   (no pct — sample size too small)
//   count tiles      → number
//   opening_duel     → { pct } derived from first_kills + first_deaths
export function aggregateTeamStats(rows) {
  const pistols      = sumWinsPlayed(rows, 'pistol_wins',       'pistol_played')
  const five_v_four  = sumWinsPlayed(rows, 'five_v_four_wins',  'five_v_four_played')
  const hard_eco     = sumWinsPlayed(rows, 'hard_eco_wins',     'hard_eco_played')
  const eco          = sumWinsPlayed(rows, 'eco_wins',          'eco_played')
  const force        = sumWinsPlayed(rows, 'force_wins',        'force_played')
  const half_buy     = sumWinsPlayed(rows, 'half_buy_wins',     'half_buy_played')
  const full_buy     = sumWinsPlayed(rows, 'full_buy_wins',     'full_buy_played')
  const anti_ecos    = sumWinsPlayed(rows, 'anti_eco_wins',     'anti_eco_played')
  const anti_force   = sumWinsPlayed(rows, 'anti_force_wins',   'anti_force_played')
  const ct           = sumWinsPlayed(rows, 'ct_round_wins',     'ct_rounds_played')
  const t            = sumWinsPlayed(rows, 't_round_wins',      't_rounds_played')

  const first_kills  = sumOne(rows, 'first_kills')
  const first_deaths = sumOne(rows, 'first_deaths')
  const openTotal    = first_kills + first_deaths
  const opening_duel = { pct: openTotal > 0 ? first_kills / openTotal : null }

  return {
    pistols:      { ...pistols,     pct: pct(pistols.wins,     pistols.played) },
    anti_ecos:    { ...anti_ecos,   pct: pct(anti_ecos.wins,   anti_ecos.played) },
    anti_force:   { ...anti_force,  pct: pct(anti_force.wins,  anti_force.played) },
    hard_eco:     { ...hard_eco,    pct: pct(hard_eco.wins,    hard_eco.played) },
    eco:          { ...eco,         pct: pct(eco.wins,         eco.played) },
    force:        { ...force,       pct: pct(force.wins,       force.played) },
    half_buy:     { ...half_buy,    pct: pct(half_buy.wins,    half_buy.played) },
    full_buy:     { ...full_buy,    pct: pct(full_buy.wins,    full_buy.played) },
    first_kills,
    first_deaths,
    opening_duel,
    five_v_four:  { ...five_v_four, pct: pct(five_v_four.wins, five_v_four.played) },
    ct:           { ...ct,          pct: pct(ct.wins,          ct.played) },
    t:            { ...t,           pct: pct(t.wins,           t.played) },
  }
}

// Build a view object that pairs each tile's current value with a delta vs prior.
// Deltas are computed only for percentage tiles.
// `minPlayed` suppresses deltas when the prior sample is too small.
export function computeDeltas(current, prior, { minPlayed = 10 } = {}) {
  function withDelta(curKey, priorKey = curKey) {
    const cur = current[curKey]
    const pr  = prior[priorKey]
    const delta = (pr && pr.played >= minPlayed && cur.pct != null && pr.pct != null)
      ? cur.pct - pr.pct
      : null
    return { value: cur, delta }
  }
  function withoutDelta(curKey) {
    return { value: current[curKey] }
  }
  function openingDelta() {
    const cur = current.opening_duel
    const pr  = prior.opening_duel
    const priorTotal = (prior.first_kills || 0) + (prior.first_deaths || 0)
    const delta = (priorTotal >= minPlayed && cur.pct != null && pr.pct != null)
      ? cur.pct - pr.pct
      : null
    return { value: cur, delta }
  }
  return {
    pistols:      withDelta('pistols'),
    anti_ecos:    withDelta('anti_ecos'),
    anti_force:   withDelta('anti_force'),
    hard_eco:     withDelta('hard_eco'),
    eco:          withDelta('eco'),
    force:        withDelta('force'),
    half_buy:     withDelta('half_buy'),
    full_buy:     withDelta('full_buy'),
    first_kills:  current.first_kills,
    first_deaths: current.first_deaths,
    opening_duel: openingDelta(),
    five_v_four:  withDelta('five_v_four'),
    ct:           withDelta('ct'),
    t:            withDelta('t'),
  }
}
