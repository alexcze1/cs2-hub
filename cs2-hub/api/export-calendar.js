const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_RX = /^[A-Z0-9]{4,16}$/

async function query(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: 'application/json',
    },
  })
  return r.json()
}

function icsDate(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z/, 'Z')
}

function fold(line) {
  const chunks = []
  while (line.length > 75) {
    chunks.push(line.slice(0, 75))
    line = ' ' + line.slice(75)
  }
  chunks.push(line)
  return chunks.join('\r\n')
}

export default async function handler(req, res) {
  const { team_id, token } = req.query
  if (!team_id || !token) { res.status(400).send('Missing team_id or token'); return }
  if (!SERVICE_KEY || !SUPABASE_URL) { res.status(500).send('Server misconfigured'); return }
  if (!UUID_RX.test(team_id) || !TOKEN_RX.test(token)) {
    res.status(403).send('Invalid token')
    return
  }

  // Query with both predicates so we never disclose whether a team_id exists
  // when the token is wrong (and never echo the real join_code back).
  const teams = await query(`teams?id=eq.${team_id}&join_code=eq.${token}&select=name`)
  if (!Array.isArray(teams)) { res.status(500).send('Supabase error'); return }
  const team  = teams?.[0]
  if (!team) { res.status(403).send('Invalid token'); return }

  const events = await query(`events?team_id=eq.${team_id}&order=date.asc&select=*`)

  const now = icsDate(new Date().toISOString())
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MIDROUND//Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${team.name} — MIDROUND`),
    'X-WR-TIMEZONE:UTC',
  ]

  for (const e of events ?? []) {
    const summary = e.opponent ? `${e.title} vs ${e.opponent}` : e.title
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${e.id}@midround.app`)
    lines.push(`DTSTAMP:${now}`)
    lines.push(`DTSTART:${icsDate(e.date)}`)
    lines.push(`DTEND:${icsDate(e.end_date || new Date(new Date(e.date).getTime() + 3600000).toISOString())}`)
    lines.push(fold(`SUMMARY:${summary}`))
    if (e.notes) lines.push(fold(`DESCRIPTION:${e.notes.replace(/\r?\n/g, '\\n')}`))
    lines.push(`CATEGORIES:${(e.type || '').toUpperCase()}`)
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate')
  res.send(lines.join('\r\n'))
}
