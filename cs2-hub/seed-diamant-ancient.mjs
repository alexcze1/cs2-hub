const TEAM_ID = '78e5b288-d32d-493b-9aed-57da82627911'
const SUPABASE_URL = 'https://yujlmvqxffkojsokcdiu.supabase.co'
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const now = new Date().toISOString()
const s = (name, type, player_roles, notes = null) => ({
  team_id: TEAM_ID, name, map: 'ancient', side: 't', type,
  player_roles, notes, tags: [], updated_at: now
})
const r = (player, role) => ({ player, role })

const strats = [
  s('SPIRIT', 'execute', [
    r('Destro', 'smoke window + 2x flash'),
    r('Libra',  'default B'),
    r('Jkxy',   'smoke donut + 2x flash'),
  ], '1st mid: smoke molo + entry\n2nd mid: drop smoke + molo cubby'),

  s('LIQUID A', 'execute', [
    r('JuN1',   'molo jungle, flash out, drop smoke'),
    r('Jkxy',   'smoke ct + entry flash mid'),
    r('Libra',  'smoke b molo + entry out A (spawn lineup)'),
    r('Jernej', 'entry flash + entry'),
    r('Destro', '2x flash levo za entry'),
  ]),

  s('DELETE A POP (1.30)', 'execute', [
    r('JuN1',   'smoke insta, molo boost, 2x flash A'),
    r('Jkxy',   'gre out mid 1.40 prot donatu'),
    r('Libra',  'smoka cave molo'),
    r('Jernej', 'fake A rush'),
    r('Destro', 'fake A rush'),
  ]),

  s('BIG', 'default', [
    r('JuN1',   'gre out mid 1.40 prot donatu'),
    r('Jkxy',   'gre out mid 1.40 prot donatu'),
    r('Libra',  'smoka cave molo'),
    r('Jernej', 'fake A rush'),
    r('Destro', 'fake A rush'),
  ]),

  s('A FAKE', 'fake', [
    r('JuN1',   'smoka donut + 2x flasha za entry'),
    r('Jkxy',   'molo close mid + smoke ct'),
    r('Destro', 'walk out B'),
    r('Libra',  'walk out B (smoke cave molo)'),
    r('Jernej', 'entry flash + big box molo'),
  ]),

  s('FNATIC', 'execute', [], [
    '1st: rush cave',
    '2nd: rush cave',
    '3rd: smoke molo, rush cave',
    '4th: smoke short, molo cave entrance, molo long + flash above cave',
    '5th: molo long',
  ].join('\n')),

  s('B CONTACT', 'contact', [
    r('Jkxy',   'boosted with awp'),
    r('Destro', 'smoke short + molo gay'),
    r('Jernej', 'contact up + molo pillar ko gre gor'),
    r('Libra',  'contact up + molo pillar ko gre gor'),
    r('JuN1',   'fake mid'),
  ], '3 guys go smoke and get flashed out'),

  s('ENCE 4B', 'default', [
    r('JuN1',   'default mid'),
    r('Jkxy',   'smoke long + molo gay'),
    r('Libra',  'default b, contact gor po rampi, pop na exec'),
    r('Destro', 'window smoke, short smoke + default molo'),
    r('Jernej', 'default b, contact gor po rampi, pop na exec'),
  ]),

  s('POKEMON', 'contact', [], '3a main contact, 1 mid, 1 heaven'),

  s('4B MOLO EXEC / ANTIECO', 'anti-eco', [
    r('JuN1',   'smoke cave, smoke short + molo pillar'),
    r('Destro', 'smoke window + molo long + 2x flash ramp'),
    r('Jkxy',   'smokes cave + molo gay + flash entry'),
    r('Jernej', 'contact up ramp (molo ramp)'),
    r('Libra',  'contact up ramp'),
  ]),

  s('K27 B HIT', 'execute', [
    r('JuN1',   '2x entry flash for long + molo deep long'),
    r('Destro', 'smoke window, molo default + 2x flash + smoke deep ct'),
    r('Jkxy',   'smoke deep cave + flash entry + flash right side ramp'),
    r('Jernej', 'smoke outside cave + molo top ramp, entrija site'),
    r('Libra',  'drop smoke destrotu, entrija site'),
  ]),

  s('DELAYED MID TAKE (1.45)', 'default', [
    r('Jkxy',   '2x flash z spawna (1.45)'),
    r('JuN1',   'default mid gre out na 1.45'),
    r('Destro', 'smoke window + molo cubby (1.45) + entry out mid'),
    r('Jernej', '2x flash z spawna (combo z jkxy-jom)'),
    r('Libra',  'default B'),
  ]),

  s('ASTRALIS 3MID', 'default', [
    r('Destro', 'insta window + flash mid z spawna 2x'),
    r('Jernej', 'nade mid + retake molo + entry out mid'),
    r('JuN1',   'nade mid + molo close'),
    r('Libra',  'b default'),
    r('Jkxy',   'donut smoke + 2x flash close + pride out mid'),
  ]),
]

const res = await fetch(`${SUPABASE_URL}/rest/v1/strats`, {
  method: 'POST',
  headers: { ...H, Prefer: 'return=minimal' },
  body: JSON.stringify(strats),
})
if (!res.ok) { console.error('Insert failed:', await res.text()); process.exit(1) }
console.log(`✅ Inserted ${strats.length} Ancient T strats for Diamant`)
