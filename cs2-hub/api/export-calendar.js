const SUPABASE_URL = 'https://yujlmvqxffkojsokcdiu.supabase.co'
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

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
  if (!SERVICE_KEY) { res.status(500).send('Server misconfigured'); return }

  const teams = await query(`teams?id=eq.${team_id}&select=name,join_code`)
  const team  = teams?.[0]
  if (!team)                   { res.status(404).send('Team not found'); return }
  if (token !== team.join_code) { res.status(403).send('Invalid token');  return }

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
