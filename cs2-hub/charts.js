// cs2-hub/charts.js
//
// Dependency-free SVG chart helpers shared across pages. Everything is
// theme-aware: colors come from CSS custom properties (lavender accent,
// semantic green/red), so dark and light themes render correctly without
// per-theme code. Draw-in animations live in style.css and are disabled
// under prefers-reduced-motion.
//
// All helpers return SVG/HTML strings — callers drop them into innerHTML.

let uid = 0
function nextId(prefix) { return `${prefix}-${++uid}-${Math.random().toString(36).slice(2, 6)}` }

function escText(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

// ── Radar / spider chart ─────────────────────────────────────────────
// axes: [{ label, pct (0–100 | null) }] — null renders as 0 with a dimmed
// value so missing samples are honest rather than invisible.
export function radarSVG(axes, { size = 280 } = {}) {
  const n = axes.length
  if (n < 3) return ''
  const cx = size / 2, cy = size / 2
  const r = size / 2 - 44               // label margin
  const angle = i => (Math.PI * 2 * i) / n - Math.PI / 2
  const pt = (i, frac) => [cx + Math.cos(angle(i)) * r * frac, cy + Math.sin(angle(i)) * r * frac]
  const poly = frac => axes.map((_, i) => pt(i, frac).map(v => v.toFixed(1)).join(',')).join(' ')

  const rings = [0.25, 0.5, 0.75, 1].map(f =>
    `<polygon class="radar-ring" points="${poly(f)}"/>`).join('')
  const spokes = axes.map((_, i) => {
    const [x, y] = pt(i, 1)
    return `<line class="radar-spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`
  }).join('')

  const valuePts = axes.map((a, i) => pt(i, Math.max(0, Math.min(100, a.pct ?? 0)) / 100))
  const valuePoly = valuePts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')
  const dots = valuePts.map(([x, y], i) =>
    `<circle class="radar-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2">
       <title>${escText(axes[i].label)}: ${axes[i].pct == null ? 'no data' : Math.round(axes[i].pct) + '%'}</title>
     </circle>`).join('')

  const labels = axes.map((a, i) => {
    const [x, y] = pt(i, 1.21)
    const anchor = Math.abs(x - cx) < 8 ? 'middle' : x > cx ? 'start' : 'end'
    const pctTxt = a.pct == null ? '—' : `${Math.round(a.pct)}%`
    return `
      <text class="radar-label" x="${x.toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="${anchor}">${escText(a.label)}</text>
      <text class="radar-label-pct ${a.pct == null ? 'is-empty' : ''}" x="${x.toFixed(1)}" y="${(y + 11).toFixed(1)}" text-anchor="${anchor}">${pctTxt}</text>`
  }).join('')

  const gid = nextId('radar-grad')
  // Horizontal bleed so side labels (anchored start/end at the widest
  // points) don't clip against the viewBox.
  const bleed = 52
  return `
    <svg class="chart-radar" viewBox="${-bleed} -4 ${size + bleed * 2} ${size + 8}" role="img" aria-label="Radar chart">
      <defs>
        <radialGradient id="${gid}" cx="50%" cy="50%" r="65%">
          <stop offset="0%"  stop-color="var(--lavender-1)" stop-opacity="0.55"/>
          <stop offset="60%" stop-color="var(--lavender-3)" stop-opacity="0.30"/>
          <stop offset="100%" stop-color="var(--lavender-3)" stop-opacity="0.12"/>
        </radialGradient>
      </defs>
      ${rings}${spokes}
      <polygon class="radar-poly" points="${valuePoly}" fill="url(#${gid})"/>
      ${dots}${labels}
    </svg>`
}

// ── Donut / gauge ────────────────────────────────────────────────────
// A single-value ring with the percentage in the middle. tone colors the
// arc (good/bad/accent). Used for headline rates (round WR, etc.).
export function donutSVG(pct, { size = 120, thickness = 11, sublabel = '', tone = '' } = {}) {
  const r = (size - thickness) / 2
  const c = size / 2
  const circ = 2 * Math.PI * r
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  const dash = (p / 100) * circ
  const color = tone === 'good' ? 'var(--success)'
    : tone === 'bad' ? 'var(--danger)'
    : tone === 'warn' ? 'var(--warning)'
    : 'var(--lavender-2)'
  const big = pct == null ? '—' : `${Math.round(pct)}%`
  return `
    <svg class="chart-donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escText(sublabel)} ${big}">
      <circle class="donut-track" cx="${c}" cy="${c}" r="${r.toFixed(1)}" stroke-width="${thickness}" fill="none"/>
      <circle class="donut-arc" cx="${c}" cy="${c}" r="${r.toFixed(1)}" stroke-width="${thickness}" fill="none"
              stroke="${color}" stroke-linecap="round"
              stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}"
              transform="rotate(-90 ${c} ${c})"/>
      <text class="donut-value" x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central">${big}</text>
      ${sublabel ? `<text class="donut-sub" x="${c}" y="${(c + size * 0.2).toFixed(1)}" text-anchor="middle">${escText(sublabel)}</text>` : ''}
    </svg>`
}

// ── Smooth trend area chart ──────────────────────────────────────────
// points: [{ v (0–100), label, tone? ('good'|'bad') }] — tone colors the dot
// (e.g. win/loss). Renders a 50% reference line, gradient fill and a glow
// line that draws in.
export function areaSVG(points, { width = 560, height = 170 } = {}) {
  if (!points || points.length < 2) return ''
  const padX = 14, padT = 14, padB = 22
  const w = width - padX * 2
  const h = height - padT - padB
  const x = i => padX + (w * i) / (points.length - 1)
  const y = v => padT + h - (h * Math.max(0, Math.min(100, v))) / 100

  // Catmull-Rom → cubic bezier so the curve passes through every data
  // point (dots must sit exactly on the line).
  const coords = points.map((p, i) => [x(i), y(p.v)])
  let line = `M ${coords[0][0].toFixed(1)} ${coords[0][1].toFixed(1)}`
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i - 1] ?? coords[i]
    const p1 = coords[i]
    const p2 = coords[i + 1]
    const p3 = coords[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    line += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
  }
  const [lx, ly] = coords[coords.length - 1]
  const area = `${line} L ${lx.toFixed(1)} ${(padT + h).toFixed(1)} L ${coords[0][0].toFixed(1)} ${(padT + h).toFixed(1)} Z`

  const grid = [25, 50, 75].map(v =>
    `<line class="chart-grid ${v === 50 ? 'chart-grid-mid' : ''}" x1="${padX}" y1="${y(v).toFixed(1)}" x2="${(width - padX).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`).join('')

  const dots = coords.map(([dx, dy], i) => {
    const p = points[i]
    const last = i === coords.length - 1
    return `<circle class="chart-dot ${p.tone ? `chart-dot-${p.tone}` : ''} ${last ? 'chart-dot-last' : ''}"
                    cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="${last ? 4 : 3}">
        <title>${escText(p.label ?? '')} — ${Math.round(p.v)}%</title>
      </circle>`
  }).join('')

  const gid = nextId('area-grad')
  return `
    <svg class="chart-area" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Trend chart">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="var(--lavender-2)" stop-opacity="0.38"/>
          <stop offset="100%" stop-color="var(--lavender-3)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path class="chart-fill" d="${area}" fill="url(#${gid})"/>
      <path class="chart-line" d="${line}"/>
      ${dots}
    </svg>`
}

// ── Animated horizontal bars ─────────────────────────────────────────
// items: [{ label, pct (0–100), valueText, sub, tone? }]
// Pure HTML/CSS — widths animate in via the .hbar-fill transition that
// fires when the .is-in class lands (next frame after insert).
export function hbarsHTML(items) {
  if (!items?.length) return ''
  const rows = items.map(it => `
    <div class="hbar-row">
      <div class="hbar-label" title="${escText(it.label)}">${escText(it.label)}</div>
      <div class="hbar-track">
        <div class="hbar-fill ${it.tone ? `hbar-${it.tone}` : ''}" style="--w:${Math.max(0, Math.min(100, it.pct))}%"></div>
      </div>
      <div class="hbar-value">${escText(it.valueText ?? `${Math.round(it.pct)}%`)}${it.sub ? `<span class="hbar-sub">${escText(it.sub)}</span>` : ''}</div>
    </div>`).join('')
  return `<div class="hbars">${rows}</div>`
}

// Kick the hbar width transition after insertion (call once per render).
export function armHbars(root = document) {
  requestAnimationFrame(() => {
    for (const el of root.querySelectorAll('.hbars:not(.is-in)')) el.classList.add('is-in')
  })
}

// ── Animated count-up for KPI values ─────────────────────────────────
// Animates plain integers (optionally with a trailing %) from 0 to target.
// Non-numeric content is left untouched.
export function countUp(el, { duration = 700 } = {}) {
  const raw = el.textContent.trim()
  const m = raw.match(/^(\d{1,6})(%?)$/)
  if (!m) return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const target = parseInt(m[1], 10)
  if (!target) return
  const suffix = m[2]
  const t0 = performance.now()
  function tick(t) {
    const k = Math.min(1, (t - t0) / duration)
    const eased = 1 - Math.pow(1 - k, 3)
    el.textContent = `${Math.round(target * eased)}${suffix}`
    if (k < 1) requestAnimationFrame(tick)
  }
  el.textContent = `0${suffix}`
  requestAnimationFrame(tick)
}
