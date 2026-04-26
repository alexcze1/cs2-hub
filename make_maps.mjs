import { readdir }   from 'node:fs/promises'
import { join }      from 'node:path'
import sharp         from 'sharp'

const MAPS_DIR = 'cs2-hub/images/maps'

const WALL_THRESHOLD      = 80
const HIGHLIGHT_THRESHOLD = 200

// Axiom palette: cool blue-grey dark mode inspired by #9CA3AF / #A69DB9
const WALL_COLOR      = [12,  13,  17 ]   // #0c0d11 — near-black with blue tint
const FLOOR_COLOR     = [26,  30,  40 ]   // #1a1e28 — dark blue-grey (9CA3AF family)
const HIGHLIGHT_COLOR = [46,  53,  69 ]   // #2e3545 — medium cool blue-grey

const TARGET_MAP = 'de_dust2_radar.png'   // remove this line to regenerate all maps

const files  = await readdir(MAPS_DIR)
const radars = files.filter(f => f === TARGET_MAP)

if (!radars.length) {
  console.error('No de_*_radar.png files found in', MAPS_DIR)
  process.exit(1)
}

for (const file of radars) {
  const src = join(MAPS_DIR, file)
  const dst = join(MAPS_DIR, file.replace('_radar.png', '_viewer.png'))

  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  const out = Buffer.alloc(data.length)

  for (let i = 0; i < data.length; i += channels) {
    const r   = data[i]
    const g   = data[i + 1]
    const b   = data[i + 2]
    const lum = 0.299 * r + 0.587 * g + 0.114 * b

    let color
    if (lum < WALL_THRESHOLD)           color = WALL_COLOR
    else if (lum > HIGHLIGHT_THRESHOLD) color = HIGHLIGHT_COLOR
    else                                color = FLOOR_COLOR

    out[i]     = color[0]
    out[i + 1] = color[1]
    out[i + 2] = color[2]
    if (channels === 4) out[i + 3] = data[i + 3]  // preserve alpha
  }

  await sharp(out, { raw: { width, height, channels } }).png().toFile(dst)
  console.log(`✓  ${file}  →  ${dst.split('/').pop()}`)
}

console.log(`\nDone. Generated ${radars.length} viewer map(s).`)
