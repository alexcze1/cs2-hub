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

const BO1_SEQUENCE = [
  { type: 'ban',     team: 'them' },
  { type: 'ban',     team: 'opp'  },
  { type: 'ban',     team: 'them' },
  { type: 'ban',     team: 'opp'  },
  { type: 'ban',     team: 'them' },
  { type: 'ban',     team: 'opp'  },
  { type: 'decider', team: null   },
]
const BO3_SEQUENCE = [
  { type: 'ban',     team: 'them' },
  { type: 'ban',     team: 'opp'  },
  { type: 'pick',    team: 'them' },
  { type: 'pick',    team: 'opp'  },
  { type: 'ban',     team: 'them' },
  { type: 'ban',     team: 'opp'  },
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

// Run a step-by-step simulation. For 'them' (the picked team) we predict
// using their per-slot frequencies; for 'opp' we placeholder. For decider
// we pick the map most often left over for the team historically (or the
// last remaining map).
export function simulateVeto(stats, format) {
  const seq = format === 'bo3' ? BO3_SEQUENCE : BO1_SEQUENCE
  const used = new Set()
  const out = []
  let bIdx = 0, pIdx = 0
  for (const step of seq) {
    if (step.type === 'decider') {
      const left = MAPS.filter(m => !used.has(m))
      let pick = null, confidence = null
      // Prefer the map most often left over for this team
      const ranked = [...stats.leftoverByMap.entries()]
        .filter(([m]) => left.includes(m))
        .sort((a, b) => b[1] - a[1])
      if (ranked.length) {
        pick = ranked[0][0]
        confidence = stats.totalMatches ? ranked[0][1] / stats.totalMatches : null
      } else if (left.length) {
        pick = left[0]
      }
      out.push({ ...step, map: pick, confidence })
      if (pick) used.add(pick)
      continue
    }
    if (step.team === 'them') {
      let counts
      if (step.type === 'ban') {
        counts = stats.banBySlot[bIdx] || new Map(); bIdx++
      } else {
        counts = stats.pickBySlot[pIdx] || new Map(); pIdx++
      }
      const ranked = [...counts.entries()]
        .filter(([m]) => !used.has(m))
        .sort((a, b) => b[1] - a[1])
      const pick = ranked.length ? ranked[0][0] : null
      const confidence = pick && stats.totalMatches
        ? ranked[0][1] / stats.totalMatches
        : null
      out.push({ ...step, map: pick, confidence, candidates: ranked.slice(0, 3) })
      if (pick) used.add(pick)
    } else {
      // Opponent — placeholder (no data). Pick any unused map as filler so
      // the visual sequence is complete; mark as low-info.
      const left = MAPS.filter(m => !used.has(m))
      out.push({ ...step, map: left[0] ?? null, confidence: null, unknown: true })
      if (left[0]) used.add(left[0])
    }
  }
  return out
}

// ── Rendering ────────────────────────────────────────────────────

export function renderVetoSimulator(container, { data, format = 'bo1' }) {
  if (!data) { container.innerHTML = ''; return }
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

  const sim = simulateVeto(stats, format)

  container.innerHTML = `
    <div class="vs-grid">
      <div class="vs-card vs-summary">
        <div class="vs-card-title">${esc(teamName)} — ${stats.totalMatches} match${stats.totalMatches === 1 ? '' : 'es'} (last ${windowMonths}m)</div>
        ${renderBanBreakdown(stats)}
      </div>
      <div class="vs-card vs-sim">
        <div class="vs-card-title-row">
          <div class="vs-card-title">Simulated ${format.toUpperCase()} veto</div>
          <div class="vs-format-toggle">
            <button class="vs-fmt-btn ${format === 'bo1' ? 'is-active' : ''}" data-fmt="bo1">BO1</button>
            <button class="vs-fmt-btn ${format === 'bo3' ? 'is-active' : ''}" data-fmt="bo3">BO3</button>
          </div>
        </div>
        ${renderSimSequence(sim, teamName)}
      </div>
    </div>`

  for (const btn of container.querySelectorAll('.vs-fmt-btn')) {
    btn.addEventListener('click', () => renderVetoSimulator(container, { data, format: btn.dataset.fmt }))
  }
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

function renderSimSequence(sim, teamName) {
  return `
    <div class="vs-seq">
      ${sim.map((s, i) => {
        const isThem = s.team === 'them'
        const action = s.type === 'ban' ? 'BAN' : s.type === 'pick' ? 'PICK' : 'PLAYS'
        const actionCls = s.type === 'ban' ? 'vs-act-ban' : s.type === 'pick' ? 'vs-act-pick' : 'vs-act-decider'
        const conf = s.confidence != null ? `${Math.round(s.confidence * 100)}%` : ''
        const who = s.type === 'decider' ? '—' : (isThem ? esc(teamName) : 'Opponent')
        const map = s.map ? esc(MAP_LABELS[s.map] ?? s.map) : '?'
        return `
          <div class="vs-step ${s.unknown ? 'vs-step-unknown' : ''}">
            <div class="vs-step-num">${i + 1}</div>
            <div class="vs-step-team">${who}</div>
            <div class="vs-step-action ${actionCls}">${action}</div>
            <div class="vs-step-map">
              <div class="vs-step-map-badge" style="background-image:url('${s.map ? mapImg(s.map) : ''}')"></div>
              <span>${map}</span>
            </div>
            <div class="vs-step-conf" title="Confidence — how often this team did this at this step">${conf}</div>
          </div>`
      }).join('')}
    </div>`
}
