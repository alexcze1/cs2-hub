const SUPABASE_URL     = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = s => typeof s === 'string' && UUID_RX.test(s)

function srHeaders(extra = {}) {
  return {
    'apikey': SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
    ...extra,
  }
}

async function getAdminUser(req) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SERVICE_ROLE_KEY, 'Authorization': `Bearer ${token}` }
  })
  if (!res.ok) return null
  const user = await res.json()
  // Prefer server-controlled app_metadata; fall back to user_metadata only if
  // the project hasn't migrated yet. Client-controlled user_metadata is unsafe
  // as a sole source for admin role.
  const isAdmin = user?.app_metadata?.is_admin || user?.user_metadata?.is_admin
  return isAdmin ? user : null
}

export default async function handler(req, res) {
  if (!SERVICE_ROLE_KEY || !SUPABASE_URL) return res.status(500).json({ error: 'Not configured' })

  const admin = await getAdminUser(req)
  if (!admin) return res.status(403).json({ error: 'Forbidden' })

  // ── GET: list all teams with members ───────────────────────
  if (req.method === 'GET') {
    const [teamsRes, membersRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/teams?select=id,name,join_code,created_at&order=created_at.desc`, { headers: srHeaders() }),
      fetch(`${SUPABASE_URL}/rest/v1/team_members?select=team_id,user_id,role&order=team_id`, { headers: srHeaders() }),
    ])
    const [teams, members] = await Promise.all([teamsRes.json(), membersRes.json()])

    // Fetch auth users to get Steam IDs
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers: srHeaders() })
    const authData = await authRes.json()
    const userMap = {}
    for (const u of authData.users ?? []) {
      userMap[u.id] = { email: u.email, steam_id: u.user_metadata?.steam_id }
    }

    const teamMap = {}
    for (const t of teams ?? []) teamMap[t.id] = { ...t, members: [] }
    for (const m of members ?? []) {
      if (teamMap[m.team_id]) {
        teamMap[m.team_id].members.push({ ...m, ...(userMap[m.user_id] ?? {}) })
      }
    }

    return res.json(Object.values(teamMap))
  }

  if (req.method !== 'POST') return res.status(405).end()

  const body = req.body ?? {}

  // ── POST: delete team ──────────────────────────────────────
  if (body.action === 'delete_team') {
    const { team_id } = body
    if (!isUuid(team_id)) return res.status(400).json({ error: 'team_id must be a UUID' })
    await fetch(`${SUPABASE_URL}/rest/v1/team_members?team_id=eq.${team_id}`, { method: 'DELETE', headers: srHeaders() })
    await fetch(`${SUPABASE_URL}/rest/v1/roster?team_id=eq.${team_id}`, { method: 'DELETE', headers: srHeaders() })
    await fetch(`${SUPABASE_URL}/rest/v1/teams?id=eq.${team_id}`, { method: 'DELETE', headers: srHeaders() })
    return res.json({ ok: true })
  }

  // ── POST: remove member ────────────────────────────────────
  if (body.action === 'remove_member') {
    const { team_id, user_id } = body
    if (!isUuid(team_id) || !isUuid(user_id)) {
      return res.status(400).json({ error: 'team_id and user_id must be UUIDs' })
    }
    await fetch(`${SUPABASE_URL}/rest/v1/team_members?team_id=eq.${team_id}&user_id=eq.${user_id}`, { method: 'DELETE', headers: srHeaders() })
    await fetch(`${SUPABASE_URL}/rest/v1/roster?team_id=eq.${team_id}&user_id=eq.${user_id}`, { method: 'DELETE', headers: srHeaders() })
    return res.json({ ok: true })
  }

  // ── POST: create team ──────────────────────────────────────
  if (body.action === 'create_team') {
    const { name } = body
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' })
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 80) return res.status(400).json({ error: 'invalid name' })
    const joinCode = Math.random().toString(36).slice(2, 8).toUpperCase()
    const r = await fetch(`${SUPABASE_URL}/rest/v1/teams`, {
      method: 'POST',
      headers: srHeaders(),
      body: JSON.stringify({ name: trimmed, join_code: joinCode }),
    })
    return res.json(await r.json())
  }

  return res.status(400).json({ error: 'Unknown action' })
}
