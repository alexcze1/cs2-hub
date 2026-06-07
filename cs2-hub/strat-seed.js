// Starter pack of well-known pro CS2 strats per map. Used by the
// "Import starter pack" button on stratbook.html (#33). Seeds give new
// teams something to scrim and review against instead of staring at an
// empty stratbook.
//
// Each strat is shaped to match the existing strats table columns —
// name, map, side, type, tags, notes, player_roles — so insertion is a
// straight `from('strats').insert(rows)`.

export const STRAT_SEEDS = [
  // ── Mirage ──────────────────────────────────────────────
  { name: 'A Default — Window control',  map: 'mirage', side: 't',  type: 'default',  tags: ['A', 'INFO'], notes: 'Window flash + mid AWP info call; default into either A spread or B execute depending on info.' },
  { name: 'A Execute — Sandwich smokes', map: 'mirage', side: 't',  type: 'opening',  tags: ['A', 'EXECUTE'], notes: 'CT + Jungle smokes + Stairs flash; entry T-spawn through ramp, support flashes over.' },
  { name: 'B Apartments Execute',        map: 'mirage', side: 't',  type: 'opening',  tags: ['B', 'EXECUTE'], notes: 'Smoke market + short, molly default plant, flash over kitchen for apps entry.' },
  { name: 'A Anchor — Stove + Truck',    map: 'mirage', side: 'ct', type: 'setup',    tags: ['A', 'ANCHOR'], notes: 'Solo A anchor: stove default, truck on info, jungle smoke on contact.' },
  { name: 'Pistol — Connector flash',    map: 'mirage', side: 't',  type: 'pistol',   tags: ['PISTOL', 'MID'], notes: 'Two flashes over connector + AWPer takes window; rotate B if mid wins.' },

  // ── Inferno ─────────────────────────────────────────────
  { name: 'B Banana — Smoke + molly',    map: 'inferno', side: 't',  type: 'default',  tags: ['B', 'BANANA'], notes: 'Coffin smoke + CT moly default; aggressive top-banana takes drop.' },
  { name: 'A Execute — Library cross',   map: 'inferno', side: 't',  type: 'opening',  tags: ['A', 'EXECUTE'], notes: 'CT smoke + Library smoke + Pit moly; entry through arch.' },
  { name: 'Mid-to-B Split',              map: 'inferno', side: 't',  type: 'script',   tags: ['B', 'SPLIT'], notes: 'Two T-side smokes mid + boost short for info; convert into banana B if info clean.' },
  { name: 'B Anchor — Coffin solo',      map: 'inferno', side: 'ct', type: 'setup',    tags: ['B', 'ANCHOR'], notes: 'Solo B coffin with drop molly; banana flash on contact, rotate quad on plant.' },
  { name: 'Eco — Banana stack',          map: 'inferno', side: 'ct', type: 'anti_eco', tags: ['ECO', 'B'], notes: 'Stack 4 CT into banana + coffin AWP; T-eco lacks utility to clear.' },

  // ── Nuke ────────────────────────────────────────────────
  { name: 'Outside Default',             map: 'nuke', side: 't',  type: 'default',  tags: ['OUTSIDE'], notes: 'Heaven smoke + secret molly; pressure outside to pull rotation, convert to ramp.' },
  { name: 'Lower B Rush',                map: 'nuke', side: 't',  type: 'opening',  tags: ['B', 'RUSH'], notes: 'Mini smoke + ramp flash; full rush ramp to mini, plant default.' },
  { name: 'Upper A Squeeze',             map: 'nuke', side: 't',  type: 'script',   tags: ['A', 'EXECUTE'], notes: 'Outside smoke + heaven smoke + hut molly; entry from squeeky + heaven simultaneously.' },
  { name: 'A Anchor — Heaven AWP',       map: 'nuke', side: 'ct', type: 'setup',    tags: ['A', 'AWP'], notes: 'AWP heaven holds rafters + squeeky; rotate to lobby on outside info.' },
  { name: 'Eco — Lobby stack',           map: 'nuke', side: 'ct', type: 'anti_eco', tags: ['ECO', 'LOBBY'], notes: 'Lobby 3-stack with kev only; deny outside takes, rotate to A on ramp pop.' },

  // ── Ancient ─────────────────────────────────────────────
  { name: 'A Default — Donut press',     map: 'ancient', side: 't',  type: 'default',  tags: ['A', 'DONUT'], notes: 'Donut + cave default; smoke A main, push lane on info.' },
  { name: 'B Tunnels Execute',           map: 'ancient', side: 't',  type: 'opening',  tags: ['B', 'EXECUTE'], notes: 'Smoke CT + flash heaven + molly default; entry through tunnels with support trade.' },
  { name: 'Mid-to-A Split',              map: 'ancient', side: 't',  type: 'script',   tags: ['A', 'SPLIT'], notes: 'Mid control via cave + donut, A main entry while mid players cross.' },
  { name: 'B Anchor — Tunnels hold',     map: 'ancient', side: 'ct', type: 'setup',    tags: ['B', 'ANCHOR'], notes: 'Solo B with tunnels molly; AWP CT default on heaven aggression.' },

  // ── Anubis ──────────────────────────────────────────────
  { name: 'A Connector Default',         map: 'anubis', side: 't',  type: 'default',  tags: ['A', 'CONNECTOR'], notes: 'Connector smoke + mid info; pressure A site through palace.' },
  { name: 'B Execute — Water + Heaven',  map: 'anubis', side: 't',  type: 'opening',  tags: ['B', 'EXECUTE'], notes: 'Water smoke + heaven smoke + walkway flash; entry through water.' },
  { name: 'Palace Wave',                 map: 'anubis', side: 't',  type: 'opening',  tags: ['A', 'PALACE'], notes: 'Palace double-stack flash + jump in; supports trade from short.' },
  { name: 'B Anchor — Walkway AWP',      map: 'anubis', side: 'ct', type: 'setup',    tags: ['B', 'AWP'], notes: 'AWP walkway holds water; flash on heaven push.' },

  // ── Overpass ────────────────────────────────────────────
  { name: 'B Long Default',              map: 'overpass', side: 't',  type: 'default',  tags: ['B', 'LONG'], notes: 'Long smoke + heaven molly; pressure B without committing to monster.' },
  { name: 'A Bathrooms Execute',         map: 'overpass', side: 't',  type: 'opening',  tags: ['A', 'EXECUTE'], notes: 'Bathrooms smoke + heaven flash + connector molly; entry through bathrooms.' },
  { name: 'Connector Take',              map: 'overpass', side: 't',  type: 'script',   tags: ['CONNECTOR'], notes: 'Smoke connector and short A; force CT off connector to free up site executes.' },
  { name: 'B Anchor — Heaven hold',      map: 'overpass', side: 'ct', type: 'setup',    tags: ['B', 'ANCHOR'], notes: 'Solo B heaven; AWP monster + long flash on contact.' },

  // ── Dust2 ───────────────────────────────────────────────
  { name: 'B Doors Default',             map: 'dust2', side: 't',  type: 'default',  tags: ['B', 'DOORS'], notes: 'Door smoke + window flash; tunnels entry with mid support.' },
  { name: 'A Catwalk Execute',           map: 'dust2', side: 't',  type: 'opening',  tags: ['A', 'CAT'], notes: 'Cross flash + cat smoke + xbox molly; long player rotates on plant.' },
  { name: 'Mid Double',                  map: 'dust2', side: 't',  type: 'script',   tags: ['MID'], notes: 'Mid double smoke (xbox + door) + AWP take; convert into A short.' },
  { name: 'A Anchor — Goose hold',       map: 'dust2', side: 'ct', type: 'setup',    tags: ['A', 'GOOSE'], notes: 'Solo A goose with default smoke; rotate to long on cat push.' },
  { name: 'Eco — Tunnels stack',         map: 'dust2', side: 't',  type: 'pistol',   tags: ['PISTOL', 'B'], notes: '3-stack tunnels rush with two flashes; force CT into 1v3 retake.' },
]
