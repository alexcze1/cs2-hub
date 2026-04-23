/**
 * One-time migration: FUT ACADEMY - STRATBOOK.xlsx → Supabase strats table
 * Usage: SUPABASE_SERVICE_ROLE_KEY=<key> node migrate-strats.mjs
 */

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const XLSX = require('../node_modules/xlsx/xlsx.js')

const SUPABASE_URL = 'https://yujlmvqxffkojsokcdiu.supabase.co'
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const HEADERS = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }

const MAP_SHEETS = {
  ANCIENT:  'ancient',
  NUKE:     'nuke',
  OVERPASS: 'overpass',
  MIRAGE:   'mirage',
  TRAIN:    'train',
  DUST:     'dust2',
}

const PLAYERS = ['Brillo', 'Yoom', 'Wonder', 'Dezt', 'Rendy']

async function main() {
  // ── Find team ────────────────────────────────────────────
  const teamRes = await fetch(
    `${SUPABASE_URL}/rest/v1/teams?name=ilike.*Fut Academy*&select=id,name`,
    { headers: HEADERS }
  )
  const teams = await teamRes.json()
  if (!Array.isArray(teams) || !teams.length) {
    console.error('No team matching "Fut Academy" found. Got:', teams)
    process.exit(1)
  }
  const team = teams[0]
  console.log(`✓ Found team: "${team.name}" (${team.id})`)

  // ── Parse Excel ──────────────────────────────────────────
  const wb = XLSX.readFile('C:/Users/A/Downloads/FUT ACADEMY - STRATBOOK.xlsx')
  const strats = []

  for (const [sheetName, mapKey] of Object.entries(MAP_SHEETS)) {
    const ws = wb.Sheets[sheetName]
    if (!ws) { console.warn(`Sheet "${sheetName}" not found, skipping`); continue }

    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
    // Row 3 is the header (Type, Name, Brillo, …), data starts at row 4
    for (let i = 4; i < rows.length; i++) {
      const row = rows[i]
      const type = String(row[0] ?? '').trim()
      const name = String(row[1] ?? '').trim()
      const side = String(row[11] ?? '').trim().toLowerCase()

      // Skip empty or incomplete rows
      if (!type || !name || (side !== 't' && side !== 'ct')) continue

      const player_roles = PLAYERS.map((player, idx) => ({
        player,
        role: String(row[2 + idx] ?? '').trim(),
      })).filter(r => r.role)

      const desc  = String(row[7] ?? '').trim()
      const extra = String(row[8] ?? '').trim()
      const notes = [desc, extra].filter(Boolean).join('\n\n') || null
      const link  = String(row[9] ?? '').trim() || null

      strats.push({
        team_id:      team.id,
        name,
        map:          mapKey,
        side,
        type,
        player_roles,
        notes,
        tags:         link ? [link] : [],
        updated_at:   new Date().toISOString(),
      })
    }
    console.log(`  ${mapKey}: parsed ${strats.filter(s => s.map === mapKey).length} strats`)
  }

  console.log(`\nInserting ${strats.length} strats into team "${team.name}"…`)

  // ── Insert in batches ────────────────────────────────────
  const BATCH = 50
  for (let i = 0; i < strats.length; i += BATCH) {
    const batch = strats.slice(i, i + BATCH)
    const res = await fetch(`${SUPABASE_URL}/rest/v1/strats`, {
      method:  'POST',
      headers: { ...HEADERS, Prefer: 'return=minimal' },
      body:    JSON.stringify(batch),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error('Insert failed:', err)
      process.exit(1)
    }
    console.log(`  ✓ ${Math.min(i + BATCH, strats.length)}/${strats.length}`)
  }

  console.log('\n✅ Migration complete!')
}

main().catch(e => { console.error(e); process.exit(1) })
