function parseICS(text) {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '')
  const events = []
  const blocks = unfolded.split('BEGIN:VEVENT')

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]
    const get = key => {
      const m = block.match(new RegExp(`^${key}[;:][^\n]*`, 'm'))
      return m ? m[0].replace(/^[^:]+:/, '').trim() : null
    }

    const uid     = get('UID')
    const summary = get('SUMMARY')
    const dtstart = get('DTSTART')
    const dtend   = get('DTEND')
    const desc    = get('DESCRIPTION')

    if (!uid || !dtstart) continue

    const parseDate = dt => {
      if (!dt) return null
      const m = dt.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?/)
      if (!m) return null
      const [, Y, M, D, h = '00', min = '00', s = '00', z = ''] = m
      return `${Y}-${M}-${D}T${h}:${min}:${s}${z}`
    }

    const fullTitle = summary || 'Pracc Match'
    const mapMatch = fullTitle.match(/\(Map:\s*([^)]+)\)/i)
    const map = mapMatch ? mapMatch[1].replace(/^de_/i, '').trim().toLowerCase() : null
    const titleNoMap = fullTitle.replace(/\s*\(Map:\s*[^)]+\)\s*/i, '').trim()
    const cleanName = titleNoMap.replace(/^vs\.?\s+/i, '').trim()
    const opponent = cleanName || null

    events.push({
      id:       `pracc-${uid}`,
      title:    cleanName,
      type:     'scrim',
      date:     parseDate(dtstart),
      end_date: parseDate(dtend),
      opponent,
      map,
      notes:    desc || null,
      source:   'pracc',
    })
  }

  return events
}

export default async function handler(req, res) {
  const calUrl = req.query?.url
  if (!calUrl) { res.json([]); return }

  try {
    const response = await fetch(calUrl)
    if (!response.ok) throw new Error(`ICS fetch failed: ${response.status}`)
    const text = await response.text()
    const events = parseICS(text)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate')
    res.json(events)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
