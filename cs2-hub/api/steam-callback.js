const SUPABASE_URL        = process.env.SUPABASE_URL        || 'https://yujlmvqxffkojsokcdiu.supabase.co'
const SERVICE_ROLE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL             = process.env.APP_URL

function supabaseHeaders() {
  return {
    'apikey':        SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type':  'application/json',
  }
}

async function verifySteamAssertion(query) {
  const params = new URLSearchParams(query)
  if (params.get('openid.mode') !== 'id_res') return null

  params.set('openid.mode', 'check_authentication')
  const verifyRes = await fetch('https://steamcommunity.com/openid/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  const text = await verifyRes.text()
  if (!text.includes('is_valid:true')) return null

  const claimedId = params.get('openid.claimed_id') ?? ''
  const match = claimedId.match(/\/openid\/id\/(\d+)$/)
  return match ? match[1] : null
}

async function findOrCreateUser(steamId) {
  const email = `${steamId}@steam.midround`

  // Try to find existing user by email
  const listRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
    { headers: supabaseHeaders() }
  )
  const listData = await listRes.json()
  const existing = listData.users?.find(u => u.email === email)
  if (existing) return existing

  // Create new user
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify({
      email,
      email_confirm: true,
      user_metadata: { steam_id: steamId },
    }),
  })
  return createRes.json()
}

async function generateMagicLink(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify({
      type: 'magiclink',
      email,
      options: { redirectTo: `${APP_URL}/dashboard.html` },
    }),
  })
  const data = await res.json()
  return data?.action_link ?? null
}

export default async function handler(req, res) {
  if (!SERVICE_ROLE_KEY) return res.status(500).send('SUPABASE_SERVICE_ROLE_KEY not set')
  if (!APP_URL)          return res.status(500).send('APP_URL not set')

  try {
    const steamId = await verifySteamAssertion(req.query)
    if (!steamId) return res.redirect(`${APP_URL}/login.html?error=steam_failed`)

    const user = await findOrCreateUser(steamId)
    if (!user?.email) return res.redirect(`${APP_URL}/login.html?error=user_failed`)

    const link = await generateMagicLink(user.email)
    if (!link) return res.redirect(`${APP_URL}/login.html?error=link_failed`)

    res.redirect(link)
  } catch (e) {
    console.error('Steam callback error:', e)
    res.redirect(`${APP_URL}/login.html?error=unexpected`)
  }
}
