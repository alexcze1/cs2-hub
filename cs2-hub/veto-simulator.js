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
//
// computeStats v2 — adds recency weighting (exponential decay, half-life
// 30 days) and per-map pick totals on top of the existing ban-slot /
// pick-slot frequency counts. Older matches still count, just less.

const RECENCY_HALF_LIFE_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000
function recencyWeight(playedAt, now = Date.now()) {
  if (!playedAt) return 1
  const ageDays = Math.max(0, (now - new Date(playedAt).getTime()) / MS_PER_DAY)
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
}

// Returns:
//   banBySlot, pickBySlot   — Map(map → weighted count) per slot
//   banByMapTotal, pickByMapTotal — Map(map → weighted count), all slots
//   leftoverByMap           — Map(map → weighted count) of decider results
//   totalMatches            — weighted count of the team's appearances
//   rawMatches              — unweighted count (UI display)
export function computeStats(vetos, teamName) {
  const target = norm(teamName)
  const banBySlot     = [new Map(), new Map(), new Map()]
  const pickBySlot    = [new Map(), new Map()]
  const banByMapTotal  = new Map()
  const pickByMapTotal = new Map()
  const leftoverByMap  = new Map()
  let totalMatches = 0
  let rawMatches   = 0
  const now = Date.now()

  for (const v of vetos) {
    const seq = v.sequence || []
    if (!seq.length) continue
    const myActions = seq.filter(s => s.team && norm(s.team) === target)
    if (!myActions.length) continue
    const w = recencyWeight(v.played_at, now)
    rawMatches += 1
    totalMatches += w
    let bIdx = 0, pIdx = 0
    for (const s of myActions) {
      if (s.action === 'ban' && s.map) {
        banByMapTotal.set(s.map, (banByMapTotal.get(s.map) || 0) + w)
        if (bIdx < banBySlot.length) {
          banBySlot[bIdx].set(s.map, (banBySlot[bIdx].get(s.map) || 0) + w)
        }
        bIdx++
      } else if (s.action === 'pick' && s.map) {
        pickByMapTotal.set(s.map, (pickByMapTotal.get(s.map) || 0) + w)
        if (pIdx < pickBySlot.length) {
          pickBySlot[pIdx].set(s.map, (pickBySlot[pIdx].get(s.map) || 0) + w)
        }
        pIdx++
      }
    }
    const decider = seq.find(s => s.action === 'decider' && s.map)
    if (decider) leftoverByMap.set(decider.map, (leftoverByMap.get(decider.map) || 0) + w)
  }
  return { banBySlot, pickBySlot, banByMapTotal, pickByMapTotal, leftoverByMap, totalMatches, rawMatches }
}

// ── Map win rates from demos ──────────────────────────────────────
//
// Per-map W/L for a team, derived from the public demos we've ingested.
// Returns Map(map → { wins, played, winRate }). Sparse data is the norm for
// non-top-tier teams — the simulator's shrinkage rules handle that.
export async function fetchTeamMapWinrates(teamName) {
  const safe = (teamName || '').replace(/[(),]/g, '').trim()
  const out = new Map()
  if (!safe) return out
  try {
    const { data, error } = await supabase
      .from('demos')
      .select('map, team_a_name, team_b_name, team_a_score, team_b_score')
      .eq('is_public', true)
      .eq('status', 'ready')
      .or(`team_a_name.ilike.${safe},team_b_name.ilike.${safe}`)
      .not('map', 'is', null)
      .limit(500)
    if (error) throw error
    const target = norm(teamName)
    for (const d of data ?? []) {
      const m = (d.map || '').replace(/^de_/, '')
      if (!MAPS.includes(m)) continue
      const tas = d.team_a_score, tbs = d.team_b_score
      if (tas == null || tbs == null) continue
      const isA = norm(d.team_a_name) === target
      const isB = norm(d.team_b_name) === target
      if (!isA && !isB) continue
      const ourScore = isA ? tas : tbs
      const oppScore = isA ? tbs : tas
      const e = out.get(m) ?? { wins: 0, played: 0, winRate: 0 }
      e.played++
      if (ourScore > oppScore) e.wins++
      out.set(m, e)
    }
    // Compute win rate per map
    for (const e of out.values()) e.winRate = e.played ? e.wins / e.played : 0
    return out
  } catch (e) {
    console.warn('[veto-sim] map winrate fetch failed', e)
    return out
  }
}

// Empirical Bayes shrinkage toward 0.5 with strength α. With α=4 it takes
// ~4 matches before a 100% raw win rate shrinks below 80% on the adjusted.
// Strong enough to avoid a "1 match = comfort pick" trap.
const SHRINK_ALPHA = 4
function shrinkWinRate(wr, played) {
  if (!played) return 0.5
  return (wr * played + 0.5 * SHRINK_ALPHA) / (played + SHRINK_ALPHA)
}
function getShrunkWR(stats, map) {
  const wr = stats?.mapWinRates?.get(map)
  return shrinkWinRate(wr?.winRate ?? 0.5, wr?.played ?? 0)
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

// ── Multi-factor scoring ─────────────────────────────────────────
//
// At each step we score every still-legal map by combining:
//   • slot frequency      — what the actor banned/picked at this slot before
//   • overall ban/pick rate — soft perma-bans / comfort picks
//   • own win rate        — strong → pick, weak → ban (shrunk for sample size)
//   • opponent win rate   — opp strong → ban; opp weak → pick
//   • leftover rate       — for the decider, what map historically survives
// Output: per-map score, then softmax → pick the top. Confidence == its
// probability under softmax, so it falls naturally between 0 and 1.

// Weights — tuned by hand. Slot dominates for high-data teams; with sparse
// data the shrunk win rates pull more weight.
const W_SLOT_FREQ  = 1.4
const W_TOTAL_RATE = 0.7
const W_OWN_WEAK   = 0.9   // ban score: ban what we're weak on
const W_OPP_STRONG = 0.7   // ban score: ban what opp is strong on
const W_OWN_STRONG = 1.1   // pick score: pick what we're strong on
const W_OPP_WEAK   = 0.6   // pick score: pick what opp is weak on
const SOFTMAX_TEMP = 0.35  // lower = more deterministic top-pick

function rateOf(counts, total) {
  if (!total) return 0
  return (counts || 0) / total
}

function scoreMap(map, step, stats, oppStats, slot) {
  if (!stats || !stats.totalMatches) return 0
  const slotCounts =
    step.type === 'ban'  ? (stats.banBySlot[slot]  || new Map())
    : step.type === 'pick' ? (stats.pickBySlot[slot] || new Map())
    : new Map()
  const slotShare = rateOf(slotCounts.get(map), stats.totalMatches)
  const totalShare = step.type === 'ban'
    ? rateOf(stats.banByMapTotal.get(map),  stats.totalMatches)
    : rateOf(stats.pickByMapTotal.get(map), stats.totalMatches)
  const ownWR = getShrunkWR(stats,    map)
  const oppWR = getShrunkWR(oppStats, map)
  let score = W_SLOT_FREQ * slotShare + W_TOTAL_RATE * totalShare
  if (step.type === 'ban') {
    score += W_OWN_WEAK   * (1 - ownWR)
    score += W_OPP_STRONG * oppWR
  } else {
    score += W_OWN_STRONG * ownWR
    score += W_OPP_WEAK   * (1 - oppWR)
  }
  return score
}

function softmax(scores) {
  const vals = [...scores.values()]
  if (!vals.length) return new Map()
  const max = Math.max(...vals)
  const exps = new Map()
  for (const [k, v] of scores) exps.set(k, Math.exp((v - max) / SOFTMAX_TEMP))
  const sum = [...exps.values()].reduce((s, v) => s + v, 0) || 1
  const probs = new Map()
  for (const [k, v] of exps) probs.set(k, v / sum)
  return probs
}

function pickByScore(legalMaps, step, stats, oppStats, slot) {
  if (!stats || !stats.totalMatches || !legalMaps.length) {
    return { map: null, confidence: null, candidates: [] }
  }
  const scores = new Map()
  for (const m of legalMaps) scores.set(m, scoreMap(m, step, stats, oppStats, slot))
  const probs = softmax(scores)
  const ranked = [...probs.entries()].sort((a, b) => b[1] - a[1])
  return {
    map:        ranked[0][0],
    confidence: ranked[0][1],
    candidates: ranked.slice(0, 3).map(([map, p]) => [map, p]),
  }
}

// Run a step-by-step simulation in ESL BO1/BO3 order, predicting BOTH
// sides when stats are available.
//   awayStats — opponent (required) — should include mapWinRates
//   homeStats — our team (optional) — should include mapWinRates
//   format    — 'bo1' | 'bo3'
//   locks     — array of map names parallel to the sequence; entry i with a
//               non-null value forces that map for step i (user manually
//               picked it). Empty/missing entries are auto-predicted.
//
// Maps used in earlier steps are excluded for both sides (global usedAll
// set), and the actor's prior steps inform the slot count. Re-running with
// different locks therefore recomputes all downstream predictions in light
// of the new constraints — the percentages for un-locked steps reflect
// "what's now most likely given the maps you've taken off the table".
export function simulateVeto(awayStats, homeStats, format, locks = []) {
  const seq = format === 'bo3' ? BO3_SEQUENCE : BO1_SEQUENCE
  const usedAll = new Set()
  const out = []
  let awayBan = 0, awayPick = 0
  let homeBan = 0, homePick = 0

  for (let i = 0; i < seq.length; i++) {
    const step = seq[i]
    const lock = locks[i] || null
    const legal = MAPS.filter(m => !usedAll.has(m))

    if (step.type === 'decider') {
      if (lock && legal.includes(lock)) {
        usedAll.add(lock)
        out.push({ ...step, map: lock, confidence: null, locked: true })
        continue
      }
      const stats = awayStats?.totalMatches ? awayStats : homeStats
      let pick = null, confidence = null
      if (stats?.leftoverByMap?.size && legal.length) {
        const scores = new Map()
        for (const m of legal) scores.set(m, rateOf(stats.leftoverByMap.get(m), stats.totalMatches))
        const probs = softmax(scores)
        const ranked = [...probs.entries()].sort((a, b) => b[1] - a[1])
        pick = ranked[0]?.[0] ?? null
        confidence = ranked[0]?.[1] ?? null
      } else if (legal.length) {
        pick = legal[0]
      }
      if (pick) usedAll.add(pick)
      out.push({ ...step, map: pick, confidence })
      continue
    }

    const isAway = step.team === 'away'
    const stats  = isAway ? awayStats : homeStats
    const opp    = isAway ? homeStats : awayStats
    const slot   = step.type === 'ban'
      ? (isAway ? awayBan : homeBan)
      : (isAway ? awayPick : homePick)
    if (step.type === 'ban') (isAway ? awayBan++ : homeBan++)
    else                      (isAway ? awayPick++ : homePick++)

    if (lock && legal.includes(lock)) {
      usedAll.add(lock)
      out.push({ ...step, map: lock, confidence: null, locked: true })
      continue
    }

    if (!stats || !stats.totalMatches) {
      out.push({ ...step, map: null, confidence: null })
      continue
    }

    const { map, confidence, candidates } = pickByScore(legal, step, stats, opp, slot)
    if (map) usedAll.add(map)
    out.push({ ...step, map, confidence, candidates })
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
  // Attach the opponent's map win rates so scoreMap can incorporate strength
  // signals. Home stats arrive pre-attached.
  stats.mapWinRates = opts.awayMapWinRates ?? new Map()

  // `locks` is parallel to the sequence. Each user-edited step puts its
  // chosen map here; auto-predicted steps stay null. We re-run simulateVeto
  // with this array every time the user changes a dropdown so all the
  // downstream confidences refresh under the new constraints.
  let locks
  if (editing && editing.format === format && Array.isArray(editing.steps) && editing.steps.length) {
    // Opening a saved veto for edit — treat every saved step as a manual lock
    // so the user sees exactly what they had, but they can clear any dropdown
    // back to "auto" to reroll predictions from that point.
    locks = editing.steps.map(s => s.map || null)
  } else {
    locks = new Array(7).fill(null)
  }
  steps = computeSteps(stats, homeStats, format, locks)

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

  wireEditableSequence(container, {
    steps, locks, awayStats: stats, homeStats, format, teamName, ourName,
  })
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

// Compute the step list given current locks. The result has, per step:
//   map, confidence, candidates, locked
// plus our own _predicted / _confidence flags for the UI.
function computeSteps(awayStats, homeStats, format, locks) {
  const fresh = simulateVeto(awayStats, homeStats, format, locks)
  return fresh.map((s, i) => ({
    ...s,
    _locked:    !!s.locked,
    _predicted: !s.locked && s.map != null,
    _confidence: s.confidence,
  }))
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
        const available = MAPS.filter(m => !usedMaps.has(m) || m === s.map)
        // Every step (including the decider) is now an editable dropdown.
        // Clearing the dropdown unlocks the step → re-simulates that slot.
        const rowCls = s.type === 'decider' ? 'vs-step-decider'
                     : s.team === 'home'    ? 'vs-step-home' : ''
        const confLabel = s._locked
          ? `<span class="vs-step-locked" title="You picked this map">FIXED</span>`
          : s._predicted
            ? `<span title="Softmax probability given current locks">SIM ${conf}</span>`
            : ''
        return `
          <div class="vs-step ${rowCls}">
            <div class="vs-step-num">${i + 1}</div>
            <div class="vs-step-team">${who}</div>
            <div class="vs-step-action ${actionCls}">${action}</div>
            <div class="vs-step-map vs-step-map-edit">
              <div class="vs-step-map-badge" style="background-image:url('${s.map ? mapImg(s.map) : ''}')"></div>
              <select class="vs-step-select" data-i="${i}">
                <option value="">Auto…</option>
                ${available.map(m => `<option value="${m}" ${s.map === m ? 'selected' : ''}>${MAP_LABELS[m] ?? m}</option>`).join('')}
              </select>
            </div>
            <div class="vs-step-conf">${confLabel}</div>
          </div>`
      }).join('')}
    </div>`
}

function wireEditableSequence(container, ctx) {
  const host = container.querySelector('#vs-seq-host')
  if (!host) return
  for (const sel of host.querySelectorAll('.vs-step-select')) {
    sel.addEventListener('change', e => {
      const i = +e.target.dataset.i
      const value = e.target.value || null
      // Empty = unlock. Any value = lock to that map.
      ctx.locks[i] = value
      // Re-run the whole sim with the new lock set, so downstream slots
      // reflect "given that <map> is already taken here, what's most likely
      // for the rest". Then mutate `steps` in place so the closures in
      // saveRow keep seeing the live values.
      const fresh = computeSteps(ctx.awayStats, ctx.homeStats, ctx.format, ctx.locks)
      ctx.steps.length = 0
      for (const s of fresh) ctx.steps.push(s)
      host.innerHTML = renderEditableSequence(ctx.steps, ctx.teamName, ctx.ourName)
      wireEditableSequence(container, ctx)
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
    const pickN = stats.pickByMapTotal?.get(m) || 0
    const left = stats.leftoverByMap.get(m) || 0
    const wrRow = stats.mapWinRates?.get(m)
    const wr = wrRow?.played ? (wrRow.wins / wrRow.played) : null
    return { map: m, all, pickN, left, pct: all / total, wr, wrPlayed: wrRow?.played ?? 0 }
  }).sort((a, b) => b.all - a.all)

  return `
    <table class="vs-ban-table">
      <thead>
        <tr><th>Map</th><th>Ban rate</th><th>Pick rate</th><th>Win rate</th><th>Left over</th></tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const wrLabel = r.wr == null
            ? `<span class="vs-bar-label" style="opacity:0.5">—</span>`
            : `<span class="vs-bar-label">${Math.round(r.wr * 100)}% <span style="opacity:0.6">(${r.wrPlayed})</span></span>`
          return `
            <tr>
              <td class="vs-map-cell">
                <div class="vs-map-badge"><img src="${mapImg(r.map)}" alt="${esc(r.map)}"/></div>
                <span>${esc(MAP_LABELS[r.map])}</span>
              </td>
              <td>
                <div class="vs-bar"><div style="width:${Math.round(r.pct * 100)}%"></div></div>
                <span class="vs-bar-label">${Math.round(r.pct * 100)}%</span>
              </td>
              <td><span class="vs-bar-label">${r.pickN ? Math.round(r.pickN / total * 100) + '%' : '—'}</span></td>
              <td>${wrLabel}</td>
              <td>${r.left ? Math.round(r.left / total * 100) + '%' : '—'}</td>
            </tr>`
        }).join('')}
      </tbody>
    </table>`
}

