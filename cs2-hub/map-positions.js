// Position labels per map and side. Source of truth shared by
// opponent-detail.js and antistrat-editor.js. Order is significant —
// each side renders its grid in this exact left-to-right order.

export const MAP_POSITIONS = {
  ancient:  { t: ['A','MID','AWP','CAVE','B'],                    ct: ['A','MID','AWP','CAVE','B'] },
  mirage:   { t: ['A','MID','FLOAT','AWP','B'],                   ct: ['A','CON','AWP','SHORT','B'] },
  nuke:     { t: ['OUTSIDE','FLOAT','AWP','2ND LBY','LOBBY'],     ct: ['OUTSIDE','AWP','DOOR','A','RAMP'] },
  anubis:   { t: ['A','FLOAT','AWP','MID','B'],                   ct: ['B','CON','AWP','MID','A'] },
  inferno:  { t: ['BANANA','B SUP','AWP','MID','APPS'],           ct: ['B','B SUP','AWP','SHORT','APPS'] },
  overpass: { t: ['A','FLOAT','AWP','CON','B'],                   ct: ['A','AWP','ROT','SHORT','B'] },
  dust2:    { t: ['B','MID','FLOAT','AWP','LONG'],                ct: ['B','MID','AWP','LONG','ROT'] },
}
