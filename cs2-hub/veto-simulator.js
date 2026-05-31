// cs2-hub/veto-simulator.js
//
// Pulls a team's recent HLTV veto history from hltv_team_vetos and turns it
// into:
//   1) a per-map ban frequency breakdown (which maps they take out, and at
//      which ban-slot — 1st, 2nd, 3rd)
//   2) a simulated veto sequence — given a BO1 or BO3 format, what the team
//      is most likely to ban / pick at each step, conditional on the maps
//      still available
//
// Last-3-months window per the goal. Falls back to "all history we have"
// when 3 months produces too few matches to draw conclusions.

import { supabase } from './supabase.js'
import { getTeamLogo, teamLogoEl } from './team-autocomplete.js'

const MAPS = ['ancient','mirage','nuke','anubis','inferno','overpass','dust2']
const MAP_LABELS = { ancient:'Ancient', mirage:'Mirage', nuke:'Nuke', anubis:'Anubis', inferno:'Inferno', overpass:'Overpass', dust2:'Dust2' }
const MAP_IMG = { dust2: 'dust' }
function mapImg(m) { return `images/maps/${MAP_IMG[m] ?? m}.png` }
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function norm(s) { return (s ?? '').toString().trim().toLowerCase() }

// ── Data fetch ────────────────────────────────────────────────────

export async function fetchTeamVetoHistory(teamName, { months = 3 } = {}) {
  const safe = (teamName || '').replace(/[(),]/g, '').trim()
  if (!safe) return { teamName, vetos: [], windowMonths: months }

  const since = new Date()
  since.setMonth(since.getMonth() - months)
  const sinceIso = since.toISOString()

  // PostgREST .or() on two ilike clauses — we want matches where the team
  // played either side.
  const { data, error } = await supabase
    .from('hltv_team_vetos')
    .select('match_id, played_at, team_a_name, team_b_name, format, sequence')
    .or(`team_a_name.ilike.${safe},team_b_name.ilike.${safe}`)
    .gte('played_at', sinceIso)
    .order('played_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return { teamName, vetos: data ?? [], windowMonths: months }
}

// ── Stats ────────────────────────────────────────────────────────

// For the picked team across all their matches, return:
//   { banBySlot: [Map(map->count) for slot 0, 1, 2], pickBySlot,
//     leftoverByMap, totalMatches }
// slot 0 = the team's FIRST ban in a match, slot 1 = second, etc.
export function computeStats(vetos, teamName) {
  const target = norm(teamName)
  const banBySlot = [new Map(), new Map(), new Map()]
  const pickBySlot = [new Map(), new Map()]
  const leftoverByMap = new Map()
  const banByMapTotal = new Map()
  let totalMatches = 0

  for (const v of vetos) {
    const seq = v.sequence || []
    if (!seq.length) continue
    const myActions = seq.filter(s => s.team && norm(s.team) === target)
    if (!myActions.length) continue
    totalMatches++
    let bIdx = 0, pIdx = 0
    for (const s of myActions) {
      if (s.action === 'ban' && s.map) {
        const total = banByMapTotal.get(s.map) || 0
        banByMapTotal.set(s.map, total + 1)
        if (bIdx < banBySlot.length) {
          const m = banBySlot[bIdx]
          m.set(s.map, (m.get(s.map) || 0) + 1)
        }
        bIdx++
      } else if (s.action === 'pick' && s.map) {
        if (pIdx < pickBySlot.length) {
          const m = pickBySlot[pIdx]
          m.set(s.map, (m.get(s.map) || 0) + 1)
        }
        pIdx++
      }
    }
    // Leftover/decider tracking — what map did they get left with?
    const decider = seq.find(s => s.action === 'decider' && s.map)
    if (decider) leftoverByMap.set(decider.map, (leftoverByMap.get(decider.map) || 0) + 1)
  }

  return { banBySlot, pickBySlot, leftoverByMap, banByMapTotal, totalMatches }
}

// ── Simulation ────────────────────────────────────────────────────

// "away" = the picked / opponent team we simulate; "home" = the user.
// Same shape as veto.js's BO1_SEQUENCE / BO3_SEQUENCE so steps saved from
// here drop straight into veto_predictions without translation.
const BO1_SEQUENCE = [
  { type: 'ban',     team: 'away' },
  { type: 'ban',     team: 'home' },
  { type: 'ban',     team: 'home' },
  { type: 'ban',     team: 'away' },
  { type: 'ban',     team: 'away' },
  { type: 'ban',     team: 'home' },
  { type: 'decider', team: null   },
]
const BO3_SEQUENCE = [
  { type: 'ban',     team: 'away' },
  { type: 'ban',     team: 'home' },
  { type: 'pick',    team: 'away' },
  { type: 'pick',    team: 'home' },
  { type: 'ban',     team: 'away' },
  { type: 'ban',     team: 'home' },
  { type: 'decider', team: null   },
]

// Predict the picked team's map for each "them" step in an externally-provided
// veto sequence (so callers can use any league's BO1/BO3 ordering — e.g. the
// ESL away-home-home-away-away-home BO1 used in veto.js — without having to
// adopt this module's BO1_SEQUENCE constant).
//
// `sequence` is an array of { type: 'ban' | 'pick' | 'decider', team }, where
// `team === awayTeamKey` marks the picked team's turn. Returns an index-aligned
// array of { map, confidence } | null.
//
// Tracks "used by them" so the team's later predictions don't repeat maps
// they already banned/picked themselves. Home picks/bans are unknown so we
// don't deduct them from the pool, but the decider falls back to whatever's
// left among maps the OPPONENT didn't ban — close enough in practice.
export function predictForSequence(sequence, stats, awayTeamKey = 'away') {
  if (!Array.isArray(sequence) || !stats || !stats.totalMatches) {
    return (sequence || []).map(() => null)
  }
  const themUsed = new Set()
  let bSlot = 0, pSlot = 0
  const preds = sequence.map(step => {
    if (step.type === 'decider' || step.team !== awayTeamKey) return null
    let counts
    if (step.type === 'ban')  { counts = stats.banBySlot[bSlot]  || new Map(); bSlot++ }
    else                      { counts = stats.pickBySlot[pSlot] || new Map(); pSlot++ }
    const ranked = [...counts.entries()]
      .filter(([m]) => !themUsed.has(m))
      .sort((a, b) => b[1] - a[1])
    const map = ranked.length ? ranked[0][0] : null
    if (map) themUsed.add(map)
    const confidence = map && stats.totalMatches ? ranked[0][1] / stats.totalMatches : null
    return { map, confidence }
  })
  // Second pass for decider — pick the map most often left over for them,
  // restricted to maps they didn't themselves ban.
  for (let i = 0; i < sequence.length; i++) {
    if (sequence[i].type !== 'decider') continue
    const left = MAPS.filter(m => !themUsed.has(m))
    const ranked = [...stats.leftoverByMap.entries()]
      .filter(([m]) => left.includes(m))
      .sort((a, b) => b[1] - a[1])
    const map = ranked.length ? ranked[0][0] : (left[0] ?? null)
    const confidence = map && stats.totalMatches && ranked.length ? ranked[0][1] / stats.totalMatches : null
    preds[i] = { map, confidence }
  }
  return preds
}

// Run a step-by-step simulation in ESL BO1/BO3 order, predicting BOTH
// sides when stats are available.
//   awayStats — the picked / opponent team's stats (required)
//   homeStats — our team's stats (optional; pass null to leave home steps blank
//               for manual fill)
// Maps a team has already played in this simulation are excluded for BOTH
// teams via a global usedAll set — a map only gets banned/picked once per
// match in real CS, so neither team can recycle it.
export function simulateVeto(awayStats, homeStats, format) {
  const seq = format === 'bo3' ? BO3_SEQUENCE : BO1_SEQUENCE
  const usedAll = new Set()
  const out = []
  let awayBan = 0, awayPick = 0
  let homeBan = 0, homePick = 0

  for (const step of seq) {
    if (step.type === 'decider') {
      const left = MAPS.filter(m => !usedAll.has(m))
      let pick = null, confidence = null
      // Try the picked team's historical leftover first — we usually care
      // about what map the OPPONENT ends up on more than we do our own.
      const decider = awayStats ?? homeStats
      if (decider) {
        const ranked = [...decider.leftoverByMap.entries()]
          .filter(([m]) => left.includes(m))
          .sort((a, b) => b[1] - a[1])
        if (ranked.length) {
          pick = ranked[0][0]
          confidence = decider.totalMatches ? ranked[0][1] / decider.totalMatches : null
        } else if (left.length) {
          pick = left[0]
        }
      } else if (left.length) {
        pick = left[0]
      }
      out.push({ ...step, map: pick, confidence })
      continue
    }

    const isAway = step.team === 'away'
    const stats = isAway ? awayStats : homeStats
    if (!stats || !stats.totalMatches) {
      // No data for this side — leave blank for the user to fill in.
      if (step.type === 'ban') { if (isAway) awayBan++; else homeBan++ }
      else                     { if (isAway) awayPick++; else homePick++ }
      out.push({ ...step, map: null, confidence: null })
      continue
    }

    let counts, slot
    if (step.type === 'ban') {
      slot = isAway ? awayBan++ : homeBan++
      counts = stats.banBySlot[slot] || new Map()
    } else {
      slot = isAway ? awayPick++ : homePick++
      counts = stats.pickBySlot[slot] || new Map()
    }
    const ranked = [...counts.entries()]
      .filter(([m]) => !usedAll.has(m))
      .sort((a, b) => b[1] - a[1])
    const pick = ranked.length ? ranked[0][0] : null
    const confidence = pick && stats.totalMatches ? ranked[0][1] / stats.totalMatches : null
    out.push({ ...step, map: pick, confidence, candidates: ranked.slice(0, 3) })
    if (pick) usedAll.add(pick)
  }
  return out
}

// Convert a saved veto_predictions row into the same shape as an
// hltv_team_vetos row, so computeStats can ingest both feeds uniformly.
// The user's team is always the 'home' side in the saved record.
export function savedVetoToHltvShape(savedVeto, ourTeamName) {
  const oppName = savedVeto.opponent || 'Opponent'
  return {
    match_id:    `saved-${savedVeto.id}`,
    played_at:   savedVeto.updated_at ?? savedVeto.created_at ?? null,
    team_a_name: ourTeamName,
    team_b_name: oppName,
    format:      savedVeto.format,
    sequence:    (savedVeto.steps || []).map((s, i) => ({
      order:  i + 1,
      team:   s.team === 'home' ? ourTeamName
            : s.team === 'away' ? oppName
            : null,
      action: s.type,
      map:    s.map ?? null,
    })),
  }
}

// ── Rendering ────────────────────────────────────────────────────

// Render the simulator into `container`. Now also responsible for the
// editable sequence + save controls + dual-side predictions.
// Caller passes:
//   data       — output of fetchTeamVetoHistory for the OPPONENT
//   homeStats  — optional precomputed stats for OUR team (from HLTV + our
//                saved veto_predictions); enables home-step predictions
//   ourName    — our team's display name (shown on home rows)
//   format     — 'bo1' | 'bo3' (persists across re-renders inside the panel)
//   editing    — optional existing veto row when re-opening from the saved list
//   onSave     — async ({ format, steps, title, notes, opponent, editingId }) → void
//   onDelete   — async (editingId) → void (only shown when editing)
//   onCancel   — () → void (only shown when editing)
export function renderVetoSimulator(container, opts) {
  if (!opts || !opts.data) { container.innerHTML = ''; return }
  const {
    data, format = 'bo1', editing = null,
    homeStats = null, ourName = 'Us',
    onSave, onDelete, onCancel,
  } = opts
  const { teamName, vetos, windowMonths } = data

  if (!vetos.length) {
    container.innerHTML = `
      <div class="vs-empty">
        <h3>No veto data for ${esc(teamName)}</h3>
        <p>The HLTV-veto backfill may not have caught this team yet, or they haven't played in the last ${windowMonths} months on a match we ingested.</p>
      </div>`
    return
  }

  const stats = computeStats(vetos, teamName)
  if (stats.totalMatches === 0) {
    container.innerHTML = `
      <div class="vs-empty">
        <h3>${esc(teamName)} appeared in ${vetos.length} matches but never as a veto participant</h3>
        <p>Likely a name-casing mismatch — HLTV stored their veto under a different label.</p>
      </div>`
    return
  }

  // If we have an existing veto in `editing` with matching format, prefer its
  // step set (so opening for edit shows what the user actually saved). Else
  // freshly simulate using BOTH the opponent's stats and our team's stats.
  let steps
  if (editing && editing.format === format && Array.isArray(editing.steps) && editing.steps.length) {
    const fresh = simulateVeto(stats, homeStats, format)
    steps = editing.steps.map((s, i) => {
      const f = fresh[i]
      const predicted = !!(f && f.map && s.map === f.map)
      return { ...s, _confidence: predicted ? f.confidence : null, _predicted: predicted }
    })
  } else {
    steps = simulateVeto(stats, homeStats, format).map(s => ({
      ...s, _predicted: s.map != null && s.type !== 'decider', _confidence: s.confidence,
    }))
  }

  const titleInit = editing?.title ?? `vs ${teamName}`
  const notesInit = editing?.notes ?? ''
  const ourCoverage = homeStats?.totalMatches
    ? ` · ${ourCoverageBlurb(homeStats, ourName)}`
    : ''

  container.innerHTML = `
    <div class="vs-grid">
      <div class="vs-card vs-summary">
        <div class="vs-card-title">${esc(teamName)} — ${stats.totalMatches} match${stats.totalMatches === 1 ? '' : 'es'} (last ${windowMonths}m)${ourCoverage}</div>
        ${renderBanBreakdown(stats)}
      </div>
      <div class="vs-card vs-sim">
        <div class="vs-card-title-row">
          <div class="vs-card-title">${editing ? 'Editing veto' : 'Simulated'} ${format.toUpperCase()}</div>
          <div class="vs-format-toggle">
            <button class="vs-fmt-btn ${format === 'bo1' ? 'is-active' : ''}" data-fmt="bo1">BO1</button>
            <button class="vs-fmt-btn ${format === 'bo3' ? 'is-active' : ''}" data-fmt="bo3">BO3</button>
          </div>
        </div>
        <div id="vs-seq-host">${renderEditableSequence(steps, teamName, ourName)}</div>
        ${renderSaveRow({ titleInit, notesInit, editing })}
      </div>
    </div>`

  wireEditableSequence(container, steps, teamName, ourName)
  wireSaveRow(container, {
    steps, format, teamName,
    editing, onSave, onDelete, onCancel,
  })

  for (const btn of container.querySelectorAll('.vs-fmt-btn')) {
    btn.addEventListener('click', () => renderVetoSimulator(container, { ...opts, format: btn.dataset.fmt, editing: null }))
  }
}

function ourCoverageBlurb(homeStats, ourName) {
  const n = homeStats.totalMatches
  return `${esc(ourName)} draws on ${n} ${n === 1 ? 'match' : 'matches'} of our own veto data`
}

function renderEditableSequence(steps, teamName, ourName = 'Us') {
  const usedMaps = new Set(steps.filter(s => s.map).map(s => s.map))
  return `
    <div class="vs-seq">
      ${steps.map((s, i) => {
        const who = s.type === 'decider' ? 'Decider' : (s.team === 'away' ? esc(teamName) : esc(ourName))
        const action = s.type === 'ban' ? 'BAN' : s.type === 'pick' ? 'PICK' : 'PLAYS'
        const actionCls = s.type === 'ban' ? 'vs-act-ban' : s.type === 'pick' ? 'vs-act-pick' : 'vs-act-decider'
        const conf = s._confidence != null ? `${Math.round(s._confidence * 100)}%` : ''
        // Decider auto-computes from remaining maps every render — read only.
        if (s.type === 'decider') {
          const left = MAPS.filter(m => !usedMaps.has(m) || m === s.map)
          const pick = s.map || left[0] || null
          return `
            <div class="vs-step vs-step-decider">
              <div class="vs-step-num">${i + 1}</div>
              <div class="vs-step-team">${who}</div>
              <div class="vs-step-action ${actionCls}">${action}</div>
              <div class="vs-step-map">
                <div class="vs-step-map-badge" style="background-image:url('${pick ? mapImg(pick) : ''}')"></div>
                <span>${pick ? esc(MAP_LABELS[pick] ?? pick) : '?'}</span>
              </div>
              <div class="vs-step-conf">${conf}</div>
            </div>`
        }
        const available = MAPS.filter(m => !usedMaps.has(m) || m === s.map)
        return `
          <div class="vs-step ${s.team === 'home' ? 'vs-step-home' : ''}">
            <div class="vs-step-num">${i + 1}</div>
            <div class="vs-step-team">${who}</div>
            <div class="vs-step-action ${actionCls}">${action}</div>
            <div class="vs-step-map vs-step-map-edit">
              <div class="vs-step-map-badge" style="background-image:url('${s.map ? mapImg(s.map) : ''}')"></div>
              <select class="vs-step-select" data-i="${i}">
                <option value="">Pick map…</option>
                ${available.map(m => `<option value="${m}" ${s.map === m ? 'selected' : ''}>${MAP_LABELS[m] ?? m}</option>`).join('')}
              </select>
            </div>
            <div class="vs-step-conf" title="HLTV-prediction confidence">${s._predicted ? `SIM ${conf}` : ''}</div>
          </div>`
      }).join('')}
    </div>`
}

function wireEditableSequence(container, steps, teamName, ourName = 'Us') {
  const host = container.querySelector('#vs-seq-host')
  if (!host) return
  for (const sel of host.querySelectorAll('.vs-step-select')) {
    sel.addEventListener('change', e => {
      const i = +e.target.dataset.i
      steps[i].map = e.target.value || null
      steps[i]._predicted = false
      steps[i]._confidence = null
      host.innerHTML = renderEditableSequence(steps, teamName, ourName)
      wireEditableSequence(container, steps, teamName, ourName)
    })
  }
}

function renderSaveRow({ titleInit, notesInit, editing }) {
  return `
    <div class="vs-save-row">
      <div class="vs-save-inputs">
        <label>
          <span class="vs-save-label">Title</span>
          <input class="vs-save-input" id="vs-save-title" value="${esc(titleInit)}" placeholder="e.g. vs TEAM"/>
        </label>
        <label>
          <span class="vs-save-label">Notes</span>
          <textarea class="vs-save-input vs-save-textarea" id="vs-save-notes" placeholder="Reasoning, tendencies…">${esc(notesInit)}</textarea>
        </label>
      </div>
      <div class="vs-save-actions">
        ${editing ? `<button type="button" class="vs-btn vs-btn-danger" id="vs-delete">Delete</button>` : ''}
        ${editing ? `<button type="button" class="vs-btn vs-btn-ghost" id="vs-cancel">Cancel edit</button>` : ''}
        <button type="button" class="vs-btn vs-btn-primary" id="vs-save">${editing ? 'Update veto' : 'Save veto'}</button>
      </div>
      <div class="vs-save-error" id="vs-save-error" style="display:none"></div>
    </div>`
}

function wireSaveRow(container, { steps, format, teamName, editing, onSave, onDelete, onCancel }) {
  const errEl = container.querySelector('#vs-save-error')
  const saveBtn = container.querySelector('#vs-save')
  saveBtn?.addEventListener('click', async () => {
    errEl.style.display = 'none'
    const title = (container.querySelector('#vs-save-title')?.value ?? '').trim() || `vs ${teamName}`
    const notes = (container.querySelector('#vs-save-notes')?.value ?? '').trim() || null
    const cleanSteps = steps.map(s => ({ type: s.type, team: s.team, map: s.map ?? '' }))
    try {
      await onSave?.({
        format, steps: cleanSteps, title, notes,
        opponent: teamName, editingId: editing?.id ?? null,
      })
    } catch (e) {
      errEl.textContent = e?.message ?? String(e)
      errEl.style.display = 'block'
    }
  })
  container.querySelector('#vs-delete')?.addEventListener('click', async () => {
    if (!editing || !confirm('Delete this veto prediction?')) return
    try { await onDelete?.(editing.id) } catch (e) {
      errEl.textContent = e?.message ?? String(e)
      errEl.style.display = 'block'
    }
  })
  container.querySelector('#vs-cancel')?.addEventListener('click', () => onCancel?.())
}

function renderBanBreakdown(stats) {
  const total = stats.totalMatches || 1
  const rows = MAPS.map(m => {
    const all = stats.banByMapTotal.get(m) || 0
    const s1 = stats.banBySlot[0].get(m) || 0
    const s2 = stats.banBySlot[1].get(m) || 0
    const s3 = stats.banBySlot[2].get(m) || 0
    const left = stats.leftoverByMap.get(m) || 0
    return { map: m, all, s1, s2, s3, left, pct: all / total }
  }).sort((a, b) => b.all - a.all)

  return `
    <table class="vs-ban-table">
      <thead>
        <tr><th>Map</th><th>Banned</th><th>1st</th><th>2nd</th><th>3rd</th><th>Left over</th></tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td class="vs-map-cell">
              <div class="vs-map-badge"><img src="${mapImg(r.map)}" alt="${esc(r.map)}"/></div>
              <span>${esc(MAP_LABELS[r.map])}</span>
            </td>
            <td>
              <div class="vs-bar"><div style="width:${Math.round(r.pct * 100)}%"></div></div>
              <span class="vs-bar-label">${r.all}/${total}</span>
            </td>
            <td>${r.s1 || '—'}</td>
            <td>${r.s2 || '—'}</td>
            <td>${r.s3 || '—'}</td>
            <td>${r.left || '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`
}

