// Pure render helpers for the antistrat editor surface (position grid + plan
// sheet). No DOM globals, no Supabase. Each helper returns { html, wire }:
//   html — markup string the caller injects into a container
//   wire(rootEl) — attaches `input` listeners that mutate the working-copy
//     antistrat object in place AND call the optional onChange callback with
//     a normalized payload, so the caller can drive autosave / dirty flags.
//
// Spec: docs/superpowers/specs/2026-05-04-antistrat-drawer.md

import { MAP_POSITIONS } from './map-positions.js'

const PLAN_FIELDS = ['pistols','style','antiecos','forces','tendencies','exploits','solutions']
const PLAN_LABELS = { pistols:'PISTOLS', style:'STYLE', antiecos:'ANTIECOS', forces:'FORCES', tendencies:'TENDENCIES AND TELLS', exploits:'EXPLOITS', solutions:'SOLUTIONS' }
const PLAN_CLASSES = { pistols:'pistols-label', style:'style-label', antiecos:'antiecos-label', forces:'forces-label', tendencies:'tendencies-label', exploits:'exploits-label', solutions:'solutions-label' }
const PLAN_PLACEHOLDERS = {
  pistols: 'Pistol round tendencies…', style: 'AWP roles, special player habits…',
  antiecos: 'Anti-eco approach…', forces: 'Force buy patterns…',
  tendencies: 'Recurring patterns, giveaways…', exploits: 'Weaknesses we can abuse…',
  solutions: 'Our adjustments and counters…',
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Seed an empty per-map record on the working antistrat object so callers
// can mutate `t_positions[pos]` etc. without first checking shape.
export function ensureMapAntistrat(antistrat, map) {
  if (antistrat[map]) return
  const tPos = {};  MAP_POSITIONS[map].t.forEach(p => { tPos[p] = '' })
  const ctPos = {}; MAP_POSITIONS[map].ct.forEach(p => { ctPos[p] = '' })
  antistrat[map] = {
    t_positions:  tPos,
    ct_positions: ctPos,
    t_plan:  Object.fromEntries(PLAN_FIELDS.map(f => [f, ''])),
    ct_plan: Object.fromEntries(PLAN_FIELDS.map(f => [f, ''])),
  }
}

export function renderPositionsGrid(map, side, antistratData, onChange) {
  const positions = MAP_POSITIONS[map]?.[side] ?? []
  const data = antistratData?.[map]?.[`${side}_positions`] ?? {}
  const html = `<div class="pos-grid">
    ${positions.map(pos => `
      <div class="pos-cell">
        <div class="pos-label">${esc(pos)}</div>
        <input class="form-input pos-input" style="padding:6px 8px;font-size:13px"
          data-map="${esc(map)}" data-side="${esc(side)}" data-pos="${esc(pos)}"
          placeholder="player" value="${esc(data[pos] ?? '')}"/>
      </div>
    `).join('')}
  </div>`

  function wire(rootEl) {
    rootEl.querySelectorAll('input.pos-input').forEach(inp => {
      inp.addEventListener('input', e => {
        const { map: m, side: s, pos } = e.target.dataset
        const val = e.target.value
        if (antistratData[m]) antistratData[m][`${s}_positions`][pos] = val
        if (onChange) onChange({ map: m, side: s, kind: 'position', pos, value: val })
      })
    })
  }

  return { html, wire }
}

export function renderPlanSheet(map, side, antistratData, onChange) {
  const d = antistratData?.[map]?.[`${side}_plan`] ?? {}
  const pairs = [['pistols','style'], ['antiecos','forces']]
  const singles = ['tendencies','exploits','solutions']
  const html = `<div class="gameplan-sheet" style="margin-top:12px">
    ${pairs.map(([a, b]) => `
      <div class="gameplan-split">
        <div class="gameplan-block">
          <div class="gameplan-section-label ${PLAN_CLASSES[a]}">${PLAN_LABELS[a]}</div>
          <textarea class="form-textarea gameplan-textarea gp-field" data-map="${esc(map)}" data-side="${esc(side)}" data-field="${a}" placeholder="${esc(PLAN_PLACEHOLDERS[a])}">${esc(d[a] ?? '')}</textarea>
        </div>
        <div class="gameplan-block">
          <div class="gameplan-section-label ${PLAN_CLASSES[b]}">${PLAN_LABELS[b]}</div>
          <textarea class="form-textarea gameplan-textarea gp-field" data-map="${esc(map)}" data-side="${esc(side)}" data-field="${b}" placeholder="${esc(PLAN_PLACEHOLDERS[b])}">${esc(d[b] ?? '')}</textarea>
        </div>
      </div>
    `).join('')}
    ${singles.map(f => `
      <div class="gameplan-section-label ${PLAN_CLASSES[f]}">${PLAN_LABELS[f]}</div>
      <textarea class="form-textarea gameplan-textarea gp-field" style="min-height:70px" data-map="${esc(map)}" data-side="${esc(side)}" data-field="${f}" placeholder="${esc(PLAN_PLACEHOLDERS[f])}">${esc(d[f] ?? '')}</textarea>
    `).join('')}
  </div>`

  function wire(rootEl) {
    rootEl.querySelectorAll('textarea.gp-field').forEach(ta => {
      ta.addEventListener('input', e => {
        const { map: m, side: s, field } = e.target.dataset
        const val = e.target.value
        if (antistratData[m]) antistratData[m][`${s}_plan`][field] = val
        if (onChange) onChange({ map: m, side: s, kind: 'plan', field, value: val })
      })
    })
  }

  return { html, wire }
}
