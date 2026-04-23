export const config = { api: { bodyParser: { sizeLimit: '6mb' } } }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { image, mediaType } = req.body
  if (!image) return res.status(400).json({ error: 'No image provided' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType || 'image/png', data: image },
          },
          {
            type: 'text',
            text: `This is a CS2 match scoreboard screenshot. Extract the final round scores for both teams and the map name if visible.

Return ONLY valid JSON, no explanation:
{"score_a": <number>, "score_b": <number>, "map": "<map name or null>"}

score_a is the left/top team score, score_b is the right/bottom team score. If scores are equal or unclear, still return your best reading. Map name should be lowercase (e.g. "mirage", "inferno", "nuke", "ancient", "anubis", "overpass", "dust2") or null if not visible.`,
          },
        ],
      }],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    return res.status(502).json({ error: `Claude API error: ${err}` })
  }

  const data = await response.json()
  const text = data.content?.[0]?.text?.trim() ?? ''

  try {
    const parsed = JSON.parse(text)
    return res.status(200).json(parsed)
  } catch {
    return res.status(422).json({ error: 'Could not parse scores from image', raw: text })
  }
}
