// Right-side drawer that lets users edit opponent antistrats while watching
// demos or doing analysis. Shares render helpers with opponent-detail via
// antistrat-editor.js. Owns: toggle pill, drawer shell, sticky header
// pickers, debounced Supabase autosave, localStorage UI state, KeyN shortcut.
//
// Public API: mountAntistratDrawer({ teamId }) — call once per page after
// page init. No-op on viewports narrower than 720px.
//
// Spec: docs/superpowers/specs/2026-05-04-antistrat-drawer.md

import { supabase } from './supabase.js'
import { renderPositionsGrid, renderPlanSheet, ensureMapAntistrat } from './antistrat-editor.js'

const NARROW_THRESHOLD = 720
const SAVE_DEBOUNCE_MS = 500

function lsKey(teamId, suffix) { return `antistratDrawer.${teamId}.${suffix}` }
function readLs(teamId, suffix, fallback) {
  try { const v = localStorage.getItem(lsKey(teamId, suffix)); return v == null ? fallback : JSON.parse(v) }
  catch { return fallback }
}
function writeLs(teamId, suffix, value) {
  try { localStorage.setItem(lsKey(teamId, suffix), JSON.stringify(value)) } catch {}
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function mountAntistratDrawer({ teamId }) {
  if (!teamId) return
  if (typeof window === 'undefined') return
  if (window.innerWidth < NARROW_THRESHOLD) return

  // ---- DOM scaffolding ----
  const pill = document.createElement('button')
  pill.className = 'antistrat-pill'
  pill.type = 'button'
  pill.textContent = 'Antistrat'
  document.body.appendChild(pill)

  const drawer = document.createElement('aside')
  drawer.className = 'antistrat-drawer'
  drawer.innerHTML = `
    <div class="antistrat-drawer-header">
      <select class="opponent-select"><option value="">Loading…</option></select>
      <select class="map-select"><option value="">—</option></select>
      <span class="side-toggle">
        <button type="button" data-side="t" class="active">T</button>
        <button type="button" data-side="ct">CT</button>
      </span>
      <span class="save-status" aria-live="polite"></span>
      <a class="open-detail" href="#" target="_blank" rel="noopener">Open detail →</a>
      <button type="button" class="close-btn" aria-label="Close">✕</button>
    </div>
    <div class="antistrat-drawer-body"></div>
  `
  document.body.appendChild(drawer)

  const opponentSelect = drawer.querySelector('.opponent-select')
  const mapSelect      = drawer.querySelector('.map-select')
  const sideButtons    = drawer.querySelectorAll('.side-toggle button')
  const statusEl       = drawer.querySelector('.save-status')
  const detailLink     = drawer.querySelector('.open-detail')
  const closeBtn       = drawer.querySelector('.close-btn')
  const bodyEl         = drawer.querySelector('.antistrat-drawer-body')

  // ---- State ----
  const state = {
    open:        readLs(teamId, 'open', false),
    opponentId:  readLs(teamId, 'opponentId', null),
    map:         readLs(teamId, 'map', null),
    side:        readLs(teamId, 'side', 't'),
    opponents:   null,           // null = unloaded; [] = loaded empty
    workingCopy: null,           // antistrat object for current opponent
    saveTimer:   null,
    saving:      false,
  }

  function setOpen(open) {
    state.open = open
    drawer.classList.toggle('open', open)
    writeLs(teamId, 'open', open)
    if (open && state.opponents == null) loadOpponents()
    if (open) renderBody()
    if (!open) flushPendingSave()
  }

  function setStatus(kind, msg) {
    statusEl.className = 'save-status' + (kind ? ' ' + kind : '')
    statusEl.textContent = msg ?? ''
    if (kind === 'ok') {
      clearTimeout(setStatus._t)
      setStatus._t = setTimeout(() => { statusEl.className = 'save-status'; statusEl.textContent = '' }, 1000)
    }
  }

  // ---- Loading ----
  async function loadOpponents() {
    const { data, error } = await supabase
      .from('opponents')
      .select('id, name, antistrat, favored_maps')
      .eq('team_id', teamId)
      .order('name')
    if (error) { console.warn('antistrat drawer: opponents load failed', error); state.opponents = []; renderBody(); return }
    state.opponents = data ?? []

    // Populate dropdown
    opponentSelect.innerHTML = `<option value="">— pick opponent —</option>` +
      state.opponents.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')
    if (state.opponentId && state.opponents.find(o => o.id === state.opponentId)) {
      opponentSelect.value = state.opponentId
      hydrateForOpponent()
    }
    renderBody()
  }

  function getCurrentOpponent() {
    return state.opponents?.find(o => o.id === state.opponentId) ?? null
  }

  function hydrateForOpponent() {
    const opp = getCurrentOpponent()
    state.workingCopy = opp ? (opp.antistrat ?? {}) : null
    detailLink.href = opp ? `opponent-detail.html?id=${encodeURIComponent(opp.id)}` : '#'

    // Map dropdown from favored_maps
    const favored = opp?.favored_maps ?? []
    mapSelect.innerHTML = `<option value="">— pick map —</option>` +
      favored.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
    if (state.map && favored.includes(state.map)) {
      mapSelect.value = state.map
    } else {
      state.map = null
      writeLs(teamId, 'map', null)
    }
  }

  // ---- Render ----
  function renderBody() {
    if (state.opponents == null) { bodyEl.innerHTML = `<div class="antistrat-drawer-empty">Loading opponents…</div>`; return }
    if (state.opponents.length === 0) {
      bodyEl.innerHTML = `<div class="antistrat-drawer-empty">No opponents yet. <a href="opponents.html">Add one →</a></div>`; return
    }
    const opp = getCurrentOpponent()
    if (!opp) { bodyEl.innerHTML = `<div class="antistrat-drawer-empty">Pick an opponent above.</div>`; return }
    const favored = opp.favored_maps ?? []
    if (!favored.length) {
      bodyEl.innerHTML = `<div class="antistrat-drawer-empty">No maps yet for ${esc(opp.name)}. <a href="opponent-detail.html?id=${esc(opp.id)}" target="_blank" rel="noopener">Add maps →</a></div>`; return
    }
    if (!state.map) { bodyEl.innerHTML = `<div class="antistrat-drawer-empty">Pick a map above.</div>`; return }

    ensureMapAntistrat(state.workingCopy, state.map)

    const oppPosSide = state.side === 'ct' ? 't' : 'ct'  // their lineup vs our side
    const positions = renderPositionsGrid(state.map, oppPosSide, state.workingCopy, scheduleSave)
    const plan      = renderPlanSheet(state.map, state.side,    state.workingCopy, scheduleSave)

    bodyEl.innerHTML = `
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;opacity:0.7;margin-bottom:6px">THEIR ${oppPosSide.toUpperCase()} LINEUP</div>
      ${positions.html}
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;opacity:0.7;margin-top:14px;margin-bottom:6px">${state.side.toUpperCase()} GAMEPLAN</div>
      ${plan.html}
    `
    positions.wire(bodyEl)
    plan.wire(bodyEl)
  }

  // ---- Save ----
  function scheduleSave() {
    setStatus(null, 'editing…')
    clearTimeout(state.saveTimer)
    state.saveTimer = setTimeout(flushPendingSave, SAVE_DEBOUNCE_MS)
  }

  async function flushPendingSave() {
    clearTimeout(state.saveTimer)
    state.saveTimer = null
    const opp = getCurrentOpponent()
    if (!opp || !state.workingCopy) return
    if (state.saving) return  // avoid overlapping writes; next change will reschedule
    state.saving = true
    setStatus(null, 'saving…')
    const { error } = await supabase
      .from('opponents')
      .update({ antistrat: state.workingCopy })
      .eq('id', opp.id)
    state.saving = false
    if (error) { console.warn('antistrat drawer save failed', error); setStatus('err', '✗ save failed'); return }
    // Update cached opponent so re-renders see persisted data.
    opp.antistrat = state.workingCopy
    setStatus('ok', '✓ saved')
  }

  // ---- Wiring ----
  pill.addEventListener('click', () => setOpen(!state.open))
  closeBtn.addEventListener('click', () => setOpen(false))

  opponentSelect.addEventListener('change', e => {
    flushPendingSave()
    state.opponentId = e.target.value || null
    writeLs(teamId, 'opponentId', state.opponentId)
    hydrateForOpponent()
    renderBody()
  })

  mapSelect.addEventListener('change', e => {
    flushPendingSave()
    state.map = e.target.value || null
    writeLs(teamId, 'map', state.map)
    renderBody()
  })

  sideButtons.forEach(btn => btn.addEventListener('click', () => {
    state.side = btn.dataset.side
    writeLs(teamId, 'side', state.side)
    sideButtons.forEach(b => b.classList.toggle('active', b.dataset.side === state.side))
    renderBody()
  }))
  // Initialize active side button from persisted state.
  sideButtons.forEach(b => b.classList.toggle('active', b.dataset.side === state.side))

  document.addEventListener('keydown', e => {
    if (e.code !== 'KeyN') return
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    e.preventDefault()
    setOpen(!state.open)
  })

  // Flush save before leaving the page.
  window.addEventListener('beforeunload', () => { flushPendingSave() })

  // Initial open if persisted.
  if (state.open) setOpen(true)
}
