// Public team profile endpoint. Returns a sanitised JSON snapshot of a
// team for the read-only /public-team.html share page.
//
// Auth model: access is by UUID — the team_id itself acts as the
// shareable token. We deliberately do NOT return anything sensitive
// (join_code, pracc_url, member emails, RLS-protected raw demo stats,
// internal notes). If we later add an opt-in `public_profile` flag on
// teams, gate this endpoint behind it; for now the hard-to-guess UUID
// is the access boundary.

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function srHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    Accept: 'application/json',
  }
}

async function query(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: srHeaders() })
  if (!r.ok) throw new Error(`Supabase ${r.status}`)
  return r.json()
}

function aggregate(vods) {
  let wins = 0, losses = 0, draws = 0
  const mapPool = {}
  const form = []   // chronological W/L/D for the last 12 matches
  for (const v of vods) {
    let mw = 0, ml = 0
    for (const m of v.maps ?? []) {
      const us = m.score_us ?? 0, them = m.score_them ?? 0
      const e = mapPool[m.map] ??= { played: 0, wins: 0, losses: 0 }
      e.played++
      if (us > them) { e.wins++;  mw++ }
      else if (them > us) { e.losses++; ml++ }
    }
    if      (mw > ml) { wins++;   form.push('W') }
    else if (ml > mw) { losses++; form.push('L') }
    else if (mw || ml) { draws++; form.push('D') }
  }
  const total = wins + losses + draws
  return {
    record: { wins, losses, draws, total },
    win_pct: total ? Math.round((wins / total) * 100) : 0,
    map_pool: Object.entries(mapPool)
      .sort((a, b) => b[1].played - a[1].played)
      .map(([map, m]) => ({
        map,
        played:  m.played,
        wins:    m.wins,
        losses:  m.losses,
        win_pct: m.played ? Math.round((m.wins / m.played) * 100) : 0,
      })),
    form: form.slice(-12),
  }
}

export default async function handler(req, res) {
  if (!SERVICE_KEY || !SUPABASE_URL) {
    return res.status(500).json({ error: 'Server misconfigured' })
  }
  const teamId = req.query?.id
  if (!teamId || !UUID_RX.test(teamId)) {
    return res.status(400).json({ error: 'team id required' })
  }

  try {
    const [teamRows, vodsRows] = await Promise.all([
      query(`teams?id=eq.${teamId}&select=name,created_at`),
      query(`vods?team_id=eq.${teamId}&select=id,match_date,match_type,opponent,result,maps&order=match_date.desc.nullslast,created_at.desc&limit=40`),
    ])
    const team = Array.isArray(teamRows) ? teamRows[0] : null
    if (!team) return res.status(404).json({ error: 'Team not found' })

    const vods = Array.isArray(vodsRows) ? vodsRows : []
    const stats = aggregate(vods)

    // Recent results trimmed to public-safe fields only.
    const recent_results = vods.slice(0, 8).map(v => ({
      date:      v.match_date ?? null,
      type:      v.match_type ?? 'scrim',
      opponent:  v.opponent   ?? null,
      result:    v.result     ?? null,
      maps: Array.isArray(v.maps)
        ? v.maps.map(m => ({
            map:        m.map ?? null,
            score_us:   m.score_us ?? null,
            score_them: m.score_them ?? null,
          }))
        : [],
    }))

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate')
    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.json({
      team: { id: teamId, name: team.name, joined_at: team.created_at },
      stats,
      recent_results,
    })
  } catch (e) {
    console.error('[team-profile] failed', e)
    return res.status(500).json({ error: 'Could not load profile' })
  }
}
