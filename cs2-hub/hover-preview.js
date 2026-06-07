// Hover preview cards. Any element with `data-preview-demo="<demo_id>"`
// or `data-preview-vod="<vod_id>"` automatically gets a floating card on
// hover showing the artifact's key fields, fetched lazily and cached.
//
// Mounted once via layout.js on every page so it works for links that
// existed at first paint AND links rendered after (event delegation +
// MutationObserver-free; we attach at the document level).
//
// Deliberately tiny: ~250ms hover delay before showing, instant hide on
// mouseout, position computed from the trigger's bounding rect so the
// card sits to the right or below, whichever fits.

import { supabase } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const HOVER_DELAY_MS = 250
const CARD_W = 280

const demoCache = new Map()
const vodCache  = new Map()

let cardEl = null
let pending = null  // { timer, trigger, kind, id }
let activeTrigger = null

function ensureCard() {
  if (cardEl) return cardEl
  cardEl = document.createElement('div')
  cardEl.className = 'hover-preview-card'
  cardEl.setAttribute('role', 'tooltip')
  cardEl.style.display = 'none'
  document.body.appendChild(cardEl)
  return cardEl
}

function position(trigger) {
  ensureCard()
  const r = trigger.getBoundingClientRect()
  const vw = window.innerWidth, vh = window.innerHeight
  // Try right of the trigger first; fall back to below if there's no room.
  let top  = r.top + window.scrollY
  let left = r.right + 10 + window.scrollX
  if (left + CARD_W + 16 > window.scrollX + vw) {
    left = Math.max(window.scrollX + 12, r.left + window.scrollX)
    top  = r.bottom + 8 + window.scrollY
  }
  cardEl.style.top  = `${top}px`
  cardEl.style.left = `${left}px`
}

function hideCard() {
  if (!cardEl) return
  cardEl.style.display = 'none'
  activeTrigger = null
}

function showCard(trigger, html) {
  ensureCard()
  cardEl.innerHTML = html
  cardEl.style.display = 'block'
  position(trigger)
  activeTrigger = trigger
}

async function loadDemo(id) {
  if (demoCache.has(id)) return demoCache.get(id)
  try {
    const { data } = await supabase
      .from('demos')
      .select('id, map, status, played_at, created_at, opponent_name, team_a_name, team_b_name, team_a_score, team_b_score, score_ct, score_t')
      .eq('id', id)
      .single()
    demoCache.set(id, data ?? null)
    return data ?? null
  } catch { demoCache.set(id, null); return null }
}

async function loadVod(id) {
  if (vodCache.has(id)) return vodCache.get(id)
  try {
    const { data } = await supabase
      .from('vods')
      .select('id, opponent, match_type, match_date, result, maps')
      .eq('id', id)
      .single()
    vodCache.set(id, data ?? null)
    return data ?? null
  } catch { vodCache.set(id, null); return null }
}

function renderDemoCard(d) {
  if (!d) return `<div class="hover-preview-empty">Demo not found.</div>`
  const map = d.map ? d.map.charAt(0).toUpperCase() + d.map.slice(1) : 'Unknown map'
  const teamA = d.team_a_name || d.opponent_name || 'Team A'
  const teamB = d.team_b_name || 'Team B'
  const a = d.team_a_score ?? d.score_ct
  const b = d.team_b_score ?? d.score_t
  const score = (a != null && b != null) ? `${a}–${b}` : '— —'
  const status = d.status === 'ready' ? 'Ready' : d.status === 'processing' ? 'Processing' : d.status === 'error' ? 'Errored' : 'Pending'
  const when = d.played_at ?? d.created_at
  const dateStr = when ? new Date(when).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : ''
  return `
    <div class="hover-preview-kind">Demo · ${esc(status)}</div>
    <div class="hover-preview-title">${esc(map)}</div>
    <div class="hover-preview-row">
      <span class="hover-preview-team">${esc(teamA)}</span>
      <span class="hover-preview-score">${esc(score)}</span>
      <span class="hover-preview-team">${esc(teamB)}</span>
    </div>
    ${dateStr ? `<div class="hover-preview-meta">${esc(dateStr)}</div>` : ''}
  `
}

function renderVodCard(v) {
  if (!v) return `<div class="hover-preview-empty">Review not found.</div>`
  const opponent = v.opponent || 'Opponent'
  const dateStr = v.match_date ? new Date(v.match_date).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : ''
  let mapsLine = ''
  if (Array.isArray(v.maps) && v.maps.length) {
    const parts = v.maps.map(m => {
      const sc = (m.score_us != null && m.score_them != null) ? ` ${m.score_us}–${m.score_them}` : ''
      const label = m.map ? m.map.charAt(0).toUpperCase() + m.map.slice(1) : '?'
      return esc(label + sc)
    })
    mapsLine = parts.join(' · ')
  }
  const resultLabel = v.result === 'win' ? 'WIN' : v.result === 'loss' ? 'LOSS' : v.result === 'draw' ? 'DRAW' : '—'
  const resultCls   = v.result === 'win' ? 'hover-preview-win' : v.result === 'loss' ? 'hover-preview-loss' : 'hover-preview-draw'
  return `
    <div class="hover-preview-kind">Match Review · ${(v.match_type || 'scrim').toUpperCase()}</div>
    <div class="hover-preview-title">vs ${esc(opponent)}</div>
    <div class="hover-preview-row">
      <span class="hover-preview-result ${resultCls}">${resultLabel}</span>
      ${dateStr ? `<span class="hover-preview-meta">${esc(dateStr)}</span>` : ''}
    </div>
    ${mapsLine ? `<div class="hover-preview-meta">${mapsLine}</div>` : ''}
  `
}

function schedulePreview(trigger) {
  cancelPending()
  const demoId = trigger.dataset.previewDemo
  const vodId  = trigger.dataset.previewVod
  if (!demoId && !vodId) return
  const kind = demoId ? 'demo' : 'vod'
  const id   = demoId || vodId

  pending = {
    trigger,
    timer: setTimeout(async () => {
      // Optimistic placeholder while the fetch lands.
      showCard(trigger, `<div class="hover-preview-loading">Loading…</div>`)
      const data = kind === 'demo' ? await loadDemo(id) : await loadVod(id)
      // The user may have moved away before the fetch returned; ignore
      // if the trigger no longer matches.
      if (activeTrigger !== trigger) return
      showCard(trigger, kind === 'demo' ? renderDemoCard(data) : renderVodCard(data))
    }, HOVER_DELAY_MS),
  }
}

function cancelPending() {
  if (pending?.timer) clearTimeout(pending.timer)
  pending = null
}

export function initHoverPreview() {
  if (window.__hoverPreviewInstalled) return
  window.__hoverPreviewInstalled = true

  document.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-preview-demo], [data-preview-vod]')
    if (!t) return
    if (t === activeTrigger) return
    schedulePreview(t)
  })
  document.addEventListener('mouseout', e => {
    const t = e.target.closest('[data-preview-demo], [data-preview-vod]')
    if (!t) return
    // Closing on mouseout is safer than waiting — the card is non-interactive.
    cancelPending()
    hideCard()
  })
  // Hide on scroll / window resize so the floating card doesn't drift.
  window.addEventListener('scroll', () => hideCard(), { passive: true })
  window.addEventListener('resize', () => hideCard())
}
