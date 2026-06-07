// Global tooltip layer. Any element with `data-tip="…"` gets a styled
// floating tooltip on hover or focus. Replaces inline title="…" wherever
// we want chrome consistent with the lavender editorial system.
//
// Mounted once via layout.js on every page. Lives at body scope so it
// works for elements rendered after first paint.

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const HOVER_DELAY = 240
let tipEl = null
let pendingTimer = null
let activeTrigger = null

function ensureTip() {
  if (tipEl) return tipEl
  tipEl = document.createElement('div')
  tipEl.className = 'tip-floating'
  tipEl.setAttribute('role', 'tooltip')
  tipEl.style.display = 'none'
  document.body.appendChild(tipEl)
  return tipEl
}

function position(trigger) {
  ensureTip()
  const r = trigger.getBoundingClientRect()
  const tw = tipEl.offsetWidth
  const th = tipEl.offsetHeight
  const vw = window.innerWidth
  // Prefer above; fall back to below if there's no room.
  let placement = 'above'
  let top = r.top - th - 8 + window.scrollY
  if (top < window.scrollY + 8) {
    top = r.bottom + 8 + window.scrollY
    placement = 'below'
  }
  let left = r.left + r.width / 2 - tw / 2 + window.scrollX
  // Clamp to viewport with 8px padding.
  left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + vw - tw - 8))
  tipEl.style.top  = `${top}px`
  tipEl.style.left = `${left}px`
  tipEl.setAttribute('data-placement', placement)
}

function show(trigger, text) {
  ensureTip()
  tipEl.innerHTML = esc(text)
  tipEl.style.display = 'block'
  // Position after the content renders so width/height are real.
  requestAnimationFrame(() => position(trigger))
  activeTrigger = trigger
}

function hide() {
  if (!tipEl) return
  tipEl.style.display = 'none'
  activeTrigger = null
}

function schedule(trigger) {
  if (pendingTimer) clearTimeout(pendingTimer)
  const text = trigger.dataset.tip
  if (!text) return
  pendingTimer = setTimeout(() => show(trigger, text), HOVER_DELAY)
}

function cancel() {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = null
}

export function initTooltips() {
  if (window.__tipInstalled) return
  window.__tipInstalled = true

  document.addEventListener('mouseover', e => {
    const t = e.target.closest?.('[data-tip]')
    if (!t || t === activeTrigger) return
    schedule(t)
  })
  document.addEventListener('mouseout', e => {
    const t = e.target.closest?.('[data-tip]')
    if (!t) return
    cancel()
    hide()
  })
  document.addEventListener('focusin', e => {
    const t = e.target.closest?.('[data-tip]')
    if (!t) return
    show(t, t.dataset.tip)
  })
  document.addEventListener('focusout', e => {
    const t = e.target.closest?.('[data-tip]')
    if (!t) return
    hide()
  })
  window.addEventListener('scroll', hide, { passive: true })
  window.addEventListener('resize', hide)
}
