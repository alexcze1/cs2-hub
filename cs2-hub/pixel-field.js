// pixel-field.js — generative chunky pixel-marble fields (wounder idiom).
// Coarse value noise quantized into blocky zones: solid lavender blocks,
// halftone-dot cells in the transition band, sparse bright "dead pixel"
// accents. Drifts slowly like a living pattern unless the user prefers
// reduced motion. Auto-attaches to .hero-card and .empty-state-art via
// a MutationObserver so async-rendered pages get it for free.

const TONES = {
  block:  'rgba(139, 109, 255, 0.42)',   // lavender-3 — main mass
  blockHi:'rgba(169, 149, 255, 0.55)',   // lavender-2 — ridges
  dot:    'rgba(201, 188, 255, 0.50)',   // lavender-1 — halftone cells
  spark:  'rgba(201, 188, 255, 0.85)',   // accent pixels
}

// Deterministic lattice hash → [0,1). Math.imul keeps every step in
// 32-bit integer space — plain * overflows into floats and the bias
// collapses the whole field below threshold.
function hash(ix, iy, seed) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const smooth = t => t * t * (3 - 2 * t)

function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = smooth(x - ix), fy = smooth(y - iy)
  const a = hash(ix, iy, seed),     b = hash(ix + 1, iy, seed)
  const c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

// Two octaves is enough for marbled blobs at cell scale.
function fbm(x, y, seed) {
  return valueNoise(x, y, seed) * 0.65 + valueNoise(x * 2.13, y * 2.13, seed + 7) * 0.35
}

export function renderPixelField(canvas, { cell = 12, seed = 1, t = 0, freq = 0.17 } = {}) {
  const w = canvas.clientWidth, h = canvas.clientHeight
  if (!w || !h) return
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)

  const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell)
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const n = fbm(gx * freq + t, gy * freq - t * 0.6, seed)
      const x = gx * cell, y = gy * cell
      if (n > 0.66) {
        ctx.fillStyle = TONES.blockHi
        ctx.fillRect(x, y, cell - 1, cell - 1)
      } else if (n > 0.56) {
        ctx.fillStyle = TONES.block
        ctx.fillRect(x, y, cell - 1, cell - 1)
      } else if (n > 0.47) {
        // halftone transition band — a centered dot instead of a block
        ctx.fillStyle = TONES.dot
        const r = Math.max(1, cell * 0.16)
        ctx.fillRect(x + cell / 2 - r, y + cell / 2 - r, r * 2, r * 2)
      }
      // sparse dead-pixel accents scattered over everything
      if (hash(gx + 31, gy + 57, seed + Math.floor(t * 3)) > 0.994) {
        ctx.fillStyle = TONES.spark
        ctx.fillRect(x + 1, y + 1, Math.max(2, cell * 0.3), Math.max(2, cell * 0.3))
      }
    }
  }
}

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function attachPixelField(el, { className = '', cell = 12, animate = true } = {}) {
  if (!el || el.querySelector(':scope > .pixel-canvas')) return
  const canvas = document.createElement('canvas')
  canvas.className = `pixel-canvas ${className}`.trim()
  canvas.setAttribute('aria-hidden', 'true')
  el.prepend(canvas)

  const seed = (Math.random() * 1e9) | 0
  let t = hash(seed, 1, 1) * 100
  const draw = () => renderPixelField(canvas, { cell, seed, t })

  // First paint next frame so layout has settled and clientWidth is real.
  requestAnimationFrame(draw)

  if (animate && !reducedMotion()) {
    // Slow stepped drift — the generative-GIF feel, at negligible cost.
    const timer = setInterval(() => {
      if (!canvas.isConnected) { clearInterval(timer); return }
      t += 0.045
      draw()
    }, 420)
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => draw()).observe(el)
  }
}

function scan(root) {
  root.querySelectorAll?.('.hero-card').forEach(el =>
    attachPixelField(el, { className: 'pixel-hero', cell: 13 }))
  root.querySelectorAll?.('.empty-state-art').forEach(el =>
    attachPixelField(el, { className: 'pixel-empty', cell: 10, animate: false }))
}

// Heroes and empty states render asynchronously after data loads, so we
// watch the DOM rather than asking every page to call us.
export function initPixelFields() {
  if (window.__pixelFieldsInit) return
  window.__pixelFieldsInit = true
  scan(document)
  new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue
        if (node.matches?.('.hero-card')) attachPixelField(node, { className: 'pixel-hero', cell: 13 })
        if (node.matches?.('.empty-state-art')) attachPixelField(node, { className: 'pixel-empty', cell: 10, animate: false })
        scan(node)
      }
    }
  }).observe(document.body, { childList: true, subtree: true })
}
