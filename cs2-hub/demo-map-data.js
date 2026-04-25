// cs2-hub/demo-map-data.js
export const MAP_DATA = {
  de_mirage:  { pos_x: -3230, pos_y:  1713, scale: 5.00 },
  de_inferno: { pos_x: -2087, pos_y:  3870, scale: 4.90 },
  de_nuke:    { pos_x: -3453, pos_y:  2887, scale: 7.00 },
  de_ancient: { pos_x: -2953, pos_y:  2164, scale: 5.00 },
  de_anubis:  { pos_x: -2796, pos_y:  3328, scale: 5.22 },
  de_dust2:   { pos_x: -2476, pos_y:  3239, scale: 4.40 },
  de_vertigo: { pos_x: -3168, pos_y:  1762, scale: 4.00 },
  de_train:   { pos_x: -2477, pos_y:  2392, scale: 4.70 },
}

export function worldToCanvas(wx, wy, map, cw, ch) {
  const m = MAP_DATA[map]
  if (!m) return { x: 0, y: 0 }
  const x = ((wx - m.pos_x) / m.scale / 1024) * cw
  const y = ((m.pos_y - wy) / m.scale / 1024) * ch
  return { x, y }
}
