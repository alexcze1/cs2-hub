// cs2-hub/opponent-overview.js
//
// Renders the auto-fetched "Recent Matches" + "Roster" panels on the opponent
// detail page. Pulls public (HLTV-ingested) demos that feature the named team
// and decorates them with per-demo opponent identification, so the player and
// team stats panels can be scoped to THAT team rather than the user's own.

import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function norm(s) { return (s ?? '').toString().trim().toLowerCase() }

const MAP_LABELS = {
  ancient: 'Ancient', mirage: 'Mirage', nuke: 'Nuke', anubis: 'Anubis',
  inferno: 'Inferno', overpass: 'Overpass', dust2: 'Dust2', train: 'Train',
}
const MAP_IMG = { dust2: 'dust' }
function mapImg(m) { return `images/maps/${MAP_IMG[m] ?? m}.png` }
function mapName(m) { return MAP_LABELS[m] ?? (m ? m[0].toUpperCase() + m.slice(1) : '—') }

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Data fetch ─────────────────────────────────────────────────

async function loadRosterIgns(teamName) {
  if (!teamName) return new Set()
  try {
    const { data, error } = await supabase
      .from('hltv_players')
      .select('ign')
      .ilike('team_name', teamName)
    if (error) { console.warn('[opp] hltv_players load failed', error); return new Set() }
    return new Set((data ?? []).map(p => norm(p.ign)).filter(Boolean))
  } catch (e) {
    console.warn('[opp] hltv_players load threw', e)
    return new Set()
  }
}

export async function fetchOpponentOverview(teamName) {
  const safe = (teamName || '').replace(/[(),]/g, '').trim()
  if (!safe) return null

  // 1. Public demos featuring this team (HLTV-ingested only — those are what
  //    we get for scouting). Team-uploaded demos are scoped to a specific
  //    user-team and not appropriate to surface here.
  //
  // Lookup runs in two passes that get UNIONed:
  //   (a) exact ilike match on team_a_name / team_b_name — catches the
  //       common case (FaZe → demos labelled "FaZe").
  //   (b) IGN-based lookup — for teams in hltv_players, fetch their player
  //       IGNs and find demos where ≥3 of those IGNs land in demo_players.
  //       This catches teams that play under a variant name on HLTV
  //       (Aurora → "Aurora Young Blud", G2 → "G2 Ares", etc.) where (a)
  //       returns nothing.
  const COLS = 'id, map, played_at, created_at, source_url, team_a_name, team_b_name, team_a_score, team_b_score, team_a_first_side, score_ct, score_t, is_public'

  const [exactRes, rosterIgns] = await Promise.all([
    supabase
      .from('demos')
      .select(COLS)
      .eq('status', 'ready')
      .eq('is_public', true)
      .or(`team_a_name.ilike.${safe},team_b_name.ilike.${safe}`)
      .order('played_at', { ascending: false, nullsFirst: false })
      .limit(50),
    loadRosterIgns(safe),
  ])
  if (exactRes.error) throw exactRes.error

  let demos = exactRes.data ?? []
  const seenIds = new Set(demos.map(d => d.id))

  if (rosterIgns.size > 0) {
    // Fetch demo_ids whose demo_players.name matches any of the roster IGNs.
    // Group → only keep demo_ids where ≥3 IGNs landed (avoids one-off
    // stand-ins of an HLTV player in a totally unrelated team's match).
    const { data: ignHits, error: ignErr } = await supabase
      .from('demo_players')
      .select('demo_id, name')
      .in('name', [...rosterIgns])
    if (ignErr) throw ignErr
    const ignCount = new Map() // demo_id -> count
    const seenNamesByDemo = new Map() // demo_id -> Set(name)
    for (const r of ignHits || []) {
      const nameSet = seenNamesByDemo.get(r.demo_id) ?? new Set()
      if (nameSet.has(r.name)) continue
      nameSet.add(r.name)
      seenNamesByDemo.set(r.demo_id, nameSet)
      ignCount.set(r.demo_id, (ignCount.get(r.demo_id) || 0) + 1)
    }
    const ignDemoIds = [...ignCount.entries()]
      .filter(([, n]) => n >= 3)
      .map(([id]) => id)
      .filter(id => !seenIds.has(id))

    if (ignDemoIds.length) {
      const { data: extraDemos, error: extraErr } = await supabase
        .from('demos')
        .select(COLS)
        .in('id', ignDemoIds)
        .eq('status', 'ready')
        .eq('is_public', true)
        .order('played_at', { ascending: false, nullsFirst: false })
        .limit(50)
      if (extraErr) throw extraErr
      for (const d of extraDemos || []) {
        if (!seenIds.has(d.id)) { demos.push(d); seenIds.add(d.id) }
      }
    }
  }

  if (!demos.length) return { teamName, demos: [], byPlayer: new Map(), wins: 0, losses: 0, draws: 0, mapPool: new Map() }
  // Re-sort merged result.
  demos.sort((a, b) => new Date(b.played_at || 0) - new Date(a.played_at || 0))
  demos = demos.slice(0, 50)

  const demoIds = demos.map(d => d.id)

  // 2. demo_team_stats — used to figure out which "team letter" (a/b) the
  //    opponent is for each demo, by comparing parser-summed wins to the
  //    HLTV-stored team_a_score / team_b_score columns.
  // 3. demo_players — opponent's roster + per-player K/D/ADR.
  const [{ data: tStats, error: e2 }, { data: pStats, error: e3 }] = await Promise.all([
    supabase.from('demo_team_stats').select('demo_id, team, ct_round_wins, t_round_wins').in('demo_id', demoIds),
    supabase.from('demo_players')
      .select('demo_id, steam_id, name, team, side, kills, deaths, assists, adr, kast_pct, rating, hs_pct, opening_kills, opening_deaths, clutches_won, clutches_lost')
      .in('demo_id', demoIds)
      .eq('side', 'all'),
  ])
  if (e2) throw e2
  if (e3) throw e3

  // Per-demo: parser-team-letter wins. Sum ct+t for each (demo_id, team).
  const teamWins = new Map() // demoId -> { a: n, b: n }
  for (const r of tStats || []) {
    const e = teamWins.get(r.demo_id) ?? { a: 0, b: 0 }
    if (r.team === 'a' || r.team === 'b') {
      e[r.team] = (r.ct_round_wins || 0) + (r.t_round_wins || 0)
    }
    teamWins.set(r.demo_id, e)
  }

  // Per-demo: decide which parser-letter is the opponent (the team we're
  // viewing). Two strategies depending on how the demo was found:
  //   (a) name match — d.team_a_name or d.team_b_name equals targetN.
  //       Then we know which HLTV side is the user, and score correlation
  //       maps that to parser's letter.
  //   (b) IGN-found demo where the HLTV name doesn't match the picked team
  //       (variant name). Use IGN evidence: count how many of the team's
  //       IGNs land on parser-letter 'a' vs 'b' in this demo, and the
  //       majority wins.
  const targetN = norm(teamName)
  const opponentLetterByDemo = new Map()
  const enrichedDemos = []
  let dropped = 0

  // For IGN-side counting we need per-demo (sid, parser-letter, name).
  const playerLetterByDemo = new Map() // demo_id -> Map(name_lower -> letter)
  if (rosterIgns.size > 0) {
    for (const r of pStats || []) {
      if (!(r.team === 'a' || r.team === 'b')) continue
      const nm = norm(r.name)
      if (!nm) continue
      const m = playerLetterByDemo.get(r.demo_id) ?? new Map()
      if (!m.has(nm)) m.set(nm, r.team)
      playerLetterByDemo.set(r.demo_id, m)
    }
  }

  for (const d of demos) {
    const ta = norm(d.team_a_name)
    const tb = norm(d.team_b_name)
    const isHltvA = ta === targetN
    const isHltvB = tb === targetN
    const tas = d.team_a_score, tbs = d.team_b_score
    const w = teamWins.get(d.id) ?? { a: 0, b: 0 }
    let parserOurLetter = null
    let ourName = null, oppName = null, ourScore = null, oppScore = null

    if (isHltvA || isHltvB) {
      // (a) Name-match path: use score correlation.
      if (tas != null && tbs != null && tas !== tbs) {
        const ourHltvScore = isHltvA ? tas : tbs
        if (w.a === ourHltvScore && w.b !== ourHltvScore) parserOurLetter = 'a'
        else if (w.b === ourHltvScore && w.a !== ourHltvScore) parserOurLetter = 'b'
      }
      if (!parserOurLetter) { dropped++; continue }
      ourName  = isHltvA ? d.team_a_name : d.team_b_name
      oppName  = isHltvA ? d.team_b_name : d.team_a_name
      ourScore = isHltvA ? tas : tbs
      oppScore = isHltvA ? tbs : tas
    } else {
      // (b) IGN-found path: name doesn't match either HLTV team. Look at
      //     demo_players for this demo and count which parser letter has
      //     more of the team's IGNs.
      const m = playerLetterByDemo.get(d.id)
      if (!m) { dropped++; continue }
      let aHits = 0, bHits = 0
      for (const ign of rosterIgns) {
        const letter = m.get(ign)
        if (letter === 'a') aHits++
        else if (letter === 'b') bHits++
      }
      if (aHits >= 3 && aHits > bHits) parserOurLetter = 'a'
      else if (bHits >= 3 && bHits > aHits) parserOurLetter = 'b'
      if (!parserOurLetter) { dropped++; continue }
      // Derive a friendly "us / opponent" name from HLTV's team_a_name / b_name.
      ourName = parserOurLetter === 'a' ? d.team_a_name : d.team_b_name
      oppName = parserOurLetter === 'a' ? d.team_b_name : d.team_a_name
      if (tas != null && tbs != null) {
        ourScore = parserOurLetter === 'a' ? tas : tbs
        oppScore = parserOurLetter === 'a' ? tbs : tas
      }
    }

    opponentLetterByDemo.set(d.id, parserOurLetter)
    const outcome = (ourScore == null || oppScore == null) ? null
                  : ourScore > oppScore ? 'W'
                  : oppScore > ourScore ? 'L' : 'D'
    // The opponent's first-half side. team_a_first_side names the side
    // that *team A* started on; whether the opponent is letter 'a' or
    // 'b' determines whether they got that side or the opposite.
    let oppFirstSide = null
    if (d.team_a_first_side) {
      const lower = String(d.team_a_first_side).toLowerCase()
      const opposite = lower === 'ct' ? 't' : 'ct'
      oppFirstSide = parserOurLetter === 'a' ? lower : opposite
    }
    enrichedDemos.push({
      ...d,
      _ourName:  ourName,
      _oppName:  oppName,
      _ourScore: ourScore,
      _oppScore: oppScore,
      _outcome:  outcome,
      _oppFirstSide: oppFirstSide,
    })
  }

  // 4. Aggregate per-opponent-player stats.
  // Only count rows whose team letter matches the demo's opponent letter.
  const byPlayer = new Map() // sid -> { name, demos, kills, deaths, ... }
  for (const r of pStats || []) {
    const ourLetter = opponentLetterByDemo.get(r.demo_id)
    if (!ourLetter || r.team !== ourLetter) continue
    const sid = r.steam_id
    if (!sid) continue
    const e = byPlayer.get(sid) ?? {
      sid, name: r.name || '', demos: 0,
      kills: 0, deaths: 0, assists: 0,
      adrSum: 0, kastSum: 0, ratSum: 0, hsSum: 0,
      openK: 0, openD: 0, clutchesW: 0, clutchesL: 0,
    }
    if (!e.name && r.name) e.name = r.name
    e.demos     += 1
    e.kills     += r.kills    || 0
    e.deaths    += r.deaths   || 0
    e.assists   += r.assists  || 0
    e.adrSum    += r.adr      || 0
    e.kastSum   += r.kast_pct || 0
    e.ratSum    += r.rating   || 0
    e.hsSum     += r.hs_pct   || 0
    e.openK     += r.opening_kills  || 0
    e.openD     += r.opening_deaths || 0
    e.clutchesW += r.clutches_won   || 0
    e.clutchesL += r.clutches_lost  || 0
    byPlayer.set(sid, e)
  }

  // Tally W/L/D and map pool. Also track the opponent's first-half
  // side preference per map so veto planning can see "this team always
  // wants to start CT on Mirage" at a glance.
  let wins = 0, losses = 0, draws = 0
  const mapPool = new Map()
  for (const d of enrichedDemos) {
    if (d._outcome === 'W') wins++
    else if (d._outcome === 'L') losses++
    else if (d._outcome === 'D') draws++
    if (d.map) {
      const e = mapPool.get(d.map) ?? { played: 0, wins: 0, losses: 0, ctFirst: 0, tFirst: 0, ctFirstWins: 0, tFirstWins: 0 }
      e.played++
      if (d._outcome === 'W') e.wins++
      else if (d._outcome === 'L') e.losses++
      if (d._oppFirstSide === 'ct') { e.ctFirst++; if (d._outcome === 'W') e.ctFirstWins++ }
      else if (d._oppFirstSide === 't') { e.tFirst++; if (d._outcome === 'W') e.tFirstWins++ }
      mapPool.set(d.map, e)
    }
  }

  return { teamName, demos: enrichedDemos, byPlayer, wins, losses, draws, mapPool, dropped }
}

// ── Rendering ─────────────────────────────────────────────────

export function renderOpponentOverview(container, data) {
  if (!data) { container.innerHTML = ''; return }
  if (!data.demos.length) {
    container.innerHTML = `
      <div class="empty-state" style="padding:32px;text-align:center;color:var(--muted)">
        <div style="font-size:14px;font-weight:600;margin-bottom:6px;color:var(--text)">No demos for ${esc(data.teamName)} yet</div>
        <div style="font-size:12px;max-width:420px;margin:0 auto;line-height:1.5">
          The HLTV-ingest pipeline only covers a slice of matches each day. If this team plays regularly
          they'll appear here within a day or two once their next match is parsed.
        </div>
      </div>`
    return
  }
  if (data.dropped && data.dropped > 0) {
    // Drop notice goes above the grid so the user knows why the match count
    // might be lower than they expected.
    container.innerHTML = `
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px;letter-spacing:0.04em">
        Showing ${data.demos.length} of ${data.demos.length + data.dropped} demos
        (${data.dropped} dropped — ambiguous score data, can't safely identify which side is ${esc(data.teamName)})
      </div>`
  } else {
    container.innerHTML = ''
  }

  // Two cards: form/map summary on the left, recent matches on the right.
  // The roster card we used to ship here is gone — the Player Impact section
  // below already shows the picked team's players from the same data.
  container.insertAdjacentHTML('beforeend', `
    <div class="opp-overview-grid opp-overview-grid-2col">
      <div class="opp-overview-card opp-summary-card">
        ${renderSummary(data)}
      </div>
      <div class="opp-overview-card opp-matches-card">
        <div class="opp-card-title">Recent Matches</div>
        ${renderMatches(data)}
      </div>
    </div>
    <div class="opp-overview-card opp-radar-card" id="opp-radar-card-${Math.random().toString(36).slice(2,8)}">
      <div class="opp-card-title">Stats vs Us · last 30 days</div>
      <div class="opp-radar-loading" data-opp-radar="loading">Crunching the comparison…</div>
    </div>`)

  // Radar is fired-and-forgotten so the rest of the overview paints
  // immediately. Failure is silent (rare data, missing roster steam ids,
  // etc.) — the loading text simply gets replaced or hidden.
  const radarHostId = container.lastElementChild.id
  fetchAndRenderRadar(data, radarHostId).catch(e => {
    console.warn('[opp] radar render failed', e)
    const slot = document.querySelector(`#${radarHostId} [data-opp-radar]`)
    if (slot) slot.textContent = ''
  })
}

// ── Stats vs Us radar ─────────────────────────────────────────
// Pulls the signed-in team's last-30-day player rows (filtered by
// roster steam_id so subs/ringers don't pollute the comparison),
// aggregates the same 5 axes for both sides, and renders an SVG radar.
function aggregateRadarFromByPlayer(byPlayer) {
  let kills = 0, deaths = 0, adrSum = 0, ratSum = 0, kastSum = 0
  let openK = 0, openD = 0, totalDemos = 0
  for (const p of byPlayer.values()) {
    kills += p.kills || 0
    deaths += p.deaths || 0
    adrSum += p.adrSum || 0
    ratSum += p.ratSum || 0
    kastSum += p.kastSum || 0
    openK += p.openK || 0
    openD += p.openD || 0
    totalDemos += p.demos || 0
  }
  if (!totalDemos) return null
  return {
    kd: deaths > 0 ? kills / deaths : kills,
    adr: adrSum / totalDemos,
    rating: ratSum / totalDemos,
    kast: kastSum / totalDemos,
    opening_pct: (openK + openD) > 0 ? openK / (openK + openD) : 0,
    demos: totalDemos,
  }
}

async function fetchOurRadarStats() {
  const teamId = getTeamId()
  if (!teamId) return null

  const ago30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const [demosRes, rosterRes] = await Promise.all([
    supabase
      .from('demos')
      .select('id')
      .eq('team_id', teamId)
      .eq('status', 'ready')
      .gte('created_at', ago30)
      .limit(60),
    supabase
      .from('roster')
      .select('steam_id')
      .eq('team_id', teamId),
  ])

  const ourDemos = demosRes.data ?? []
  if (!ourDemos.length) return null
  const rosterSids = new Set((rosterRes.data ?? []).map(r => r.steam_id).filter(Boolean))
  if (!rosterSids.size) return null

  const { data: rows } = await supabase
    .from('demo_players')
    .select('steam_id, kills, deaths, adr, rating, kast_pct, opening_kills, opening_deaths')
    .in('demo_id', ourDemos.map(d => d.id))
    .eq('side', 'all')

  const byPlayer = new Map()
  for (const r of rows ?? []) {
    if (!rosterSids.has(r.steam_id)) continue
    const e = byPlayer.get(r.steam_id) ?? {
      demos: 0, kills: 0, deaths: 0,
      adrSum: 0, kastSum: 0, ratSum: 0, openK: 0, openD: 0,
    }
    e.demos++
    e.kills  += r.kills  || 0
    e.deaths += r.deaths || 0
    if (r.adr      != null) e.adrSum  += r.adr
    if (r.rating   != null) e.ratSum  += r.rating
    if (r.kast_pct != null) e.kastSum += r.kast_pct
    e.openK  += r.opening_kills  || 0
    e.openD  += r.opening_deaths || 0
    byPlayer.set(r.steam_id, e)
  }
  return aggregateRadarFromByPlayer(byPlayer)
}

async function fetchAndRenderRadar(data, hostId) {
  const oppStats = aggregateRadarFromByPlayer(data.byPlayer)
  const usStats  = await fetchOurRadarStats()
  const host = document.getElementById(hostId)
  if (!host) return

  if (!oppStats || !usStats) {
    host.innerHTML = `
      <div class="opp-card-title">Stats vs Us · last 30 days</div>
      <div class="opp-card-empty">
        Need at least one of our team's parsed demos AND opponent data with
        per-player stats. ${!usStats ? 'No recent demos for our team found.' : 'No per-player stats for the opponent yet.'}
      </div>`
    return
  }

  // Axis ranges — calibrated to the bands where movement is visible.
  // Values outside the range clamp to the edge so the polygon stays
  // inside the radar without distorting the inner detail.
  const AXES = [
    { key: 'rating',      label: 'Rating',  lo: 0.7, hi: 1.3, fmt: v => v.toFixed(2) },
    { key: 'adr',         label: 'ADR',     lo: 40,  hi: 100, fmt: v => v.toFixed(0) },
    { key: 'kd',          label: 'K/D',     lo: 0.5, hi: 1.5, fmt: v => v.toFixed(2) },
    { key: 'kast',        label: 'KAST',    lo: 50,  hi: 85,  fmt: v => `${v.toFixed(0)}%` },
    { key: 'opening_pct', label: 'OPN%',    lo: 0.3, hi: 0.7, fmt: v => `${(v*100).toFixed(0)}%` },
  ]
  const N = AXES.length
  const SIZE = 240, CX = SIZE / 2, CY = SIZE / 2, R = 92

  function norm(value, lo, hi) {
    return Math.max(0, Math.min(1, (value - lo) / (hi - lo)))
  }
  function point(i, frac) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / N
    return [CX + Math.cos(angle) * R * frac, CY + Math.sin(angle) * R * frac]
  }
  function polygon(stats, frac0 = 1) {
    return AXES.map((a, i) => {
      const f = norm(stats[a.key], a.lo, a.hi) * frac0
      const [x, y] = point(i, f)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }

  const oppPoly = polygon(oppStats)
  const usPoly  = polygon(usStats)

  const gridLevels = [0.25, 0.5, 0.75, 1].map(frac => {
    const pts = Array.from({ length: N }, (_, i) => point(i, frac)).map(([x,y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
    return `<polygon points="${pts}" fill="none" stroke="var(--hairline)" stroke-width="1"/>`
  }).join('')

  const spokes = AXES.map((_, i) => {
    const [x, y] = point(i, 1)
    return `<line x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--hairline)" stroke-width="1"/>`
  }).join('')

  const labels = AXES.map((a, i) => {
    const [x, y] = point(i, 1.18)
    return `
      <g class="opp-radar-axis-label" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
        <text text-anchor="middle" dy="0.32em" class="opp-radar-axis-name">${a.label}</text>
      </g>`
  }).join('')

  const legendRows = AXES.map(a => `
    <tr>
      <td>${a.label}</td>
      <td class="opp-radar-cell-opp">${a.fmt(oppStats[a.key])}</td>
      <td class="opp-radar-cell-us">${a.fmt(usStats[a.key])}</td>
    </tr>`).join('')

  host.innerHTML = `
    <div class="opp-card-title-row">
      <div class="opp-card-title">Stats vs Us · last 30 days</div>
      <div class="opp-radar-meta">${oppStats.demos} opp demos · ${usStats.demos} our demos</div>
    </div>
    <div class="opp-radar-grid">
      <svg viewBox="0 0 ${SIZE} ${SIZE}" class="opp-radar-svg" aria-hidden="true">
        ${gridLevels}
        ${spokes}
        <polygon points="${oppPoly}" class="opp-radar-poly opp-radar-poly-opp"/>
        <polygon points="${usPoly}"  class="opp-radar-poly opp-radar-poly-us"/>
        ${labels}
      </svg>
      <table class="opp-radar-table">
        <thead>
          <tr>
            <th></th>
            <th class="opp-radar-cell-opp">${esc(data.teamName)}</th>
            <th class="opp-radar-cell-us">Us</th>
          </tr>
        </thead>
        <tbody>${legendRows}</tbody>
      </table>
    </div>`
}

function renderSummary(data) {
  const total = data.wins + data.losses + data.draws
  const wpct = total ? Math.round((data.wins / total) * 100) : 0
  const mapRows = [...data.mapPool.entries()]
    .sort((a, b) => b[1].played - a[1].played)
    .slice(0, 5)

  return `
    <div class="opp-card-title">Recent Form (${total} matches)</div>
    <div class="opp-summary-row">
      <div class="opp-summary-stat">
        <div class="opp-summary-num">${data.wins}<span class="opp-summary-sep">—</span>${data.losses}${data.draws ? ` <span style="font-size:14px;opacity:0.6">(${data.draws}D)</span>` : ''}</div>
        <div class="opp-summary-label">${wpct}% win rate</div>
      </div>
    </div>
    ${mapRows.length ? `
      <div class="opp-map-pool">
        ${mapRows.map(([map, m]) => {
          const mpct = m.played ? Math.round((m.wins / m.played) * 100) : 0
          const totalSided = m.ctFirst + m.tFirst
          let sideInfo = ''
          if (totalSided >= 2) {
            const prefersCt = m.ctFirst >= m.tFirst
            const cnt   = prefersCt ? m.ctFirst : m.tFirst
            const wins  = prefersCt ? m.ctFirstWins : m.tFirstWins
            const wpct  = cnt ? Math.round((wins / cnt) * 100) : 0
            const label = prefersCt ? 'CT' : 'T'
            const tone  = prefersCt ? 'var(--side-ct)' : 'var(--side-t)'
            sideInfo = `<span title="Started on ${label} side ${cnt}/${totalSided} matches · ${wpct}% W when starting ${label}" style="color:${tone};font-size:10px;margin-left:8px;letter-spacing:0.05em;text-transform:uppercase;font-weight:700">${label} ${cnt}/${totalSided}</span>`
          }
          return `
            <div class="opp-map-row">
              <div class="opp-map-badge"><img src="${mapImg(map)}" alt="${esc(map)}" onerror="this.style.display='none'"/></div>
              <div class="opp-map-name">${esc(mapName(map))}</div>
              <div class="opp-map-record">${m.wins}–${m.losses}${sideInfo}</div>
              <div class="opp-map-bar"><div style="width:${mpct}%"></div></div>
            </div>`
        }).join('')}
      </div>` : ''}`
}

function renderRoster(data) {
  // Sort by appearances desc, then by avg rating desc (where available).
  const players = [...data.byPlayer.values()]
    .map(p => ({
      ...p,
      kd:     p.deaths ? p.kills / p.deaths : p.kills,
      adr:    p.demos ? p.adrSum / p.demos : 0,
      rating: p.demos ? p.ratSum / p.demos : 0,
    }))
    .sort((a, b) => b.demos - a.demos || b.rating - a.rating)
    .slice(0, 8)

  if (!players.length) {
    return `<div class="opp-card-empty">No player stats available yet.</div>`
  }

  return `
    <table class="opp-roster-table">
      <thead>
        <tr>
          <th style="text-align:left">Player</th>
          <th>Matches</th>
          <th>K/D</th>
          <th>ADR</th>
          <th>Rating</th>
        </tr>
      </thead>
      <tbody>
        ${players.map(p => `
          <tr>
            <td class="opp-player-name">${esc(p.name || p.sid.slice(-5))}</td>
            <td>${p.demos}</td>
            <td>${p.kd.toFixed(2)}</td>
            <td>${p.adr.toFixed(1)}</td>
            <td>${p.rating ? p.rating.toFixed(2) : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`
}

function renderMatches(data) {
  const rows = data.demos // show all fetched (capped at 50 by the query)
  return `
    <div class="opp-match-list">
      ${rows.map(d => {
        const cls = d._outcome === 'W' ? 'opp-match-win'
                  : d._outcome === 'L' ? 'opp-match-loss'
                  : 'opp-match-draw'
        const scoreHtml = (d._ourScore != null && d._oppScore != null)
          ? `<span class="opp-match-score-us">${d._ourScore}</span><span class="opp-match-score-sep">—</span><span class="opp-match-score-them">${d._oppScore}</span>`
          : `<span style="opacity:0.5">score unknown</span>`
        const href = `demo-viewer.html?id=${esc(d.id)}`
        return `
          <a class="opp-match-row ${cls}" href="${href}">
            <div class="opp-match-date">${fmtDate(d.played_at)}</div>
            <div class="opp-match-map">
              <div class="opp-map-badge sm"><img src="${mapImg(d.map)}" alt="${esc(d.map)}" onerror="this.style.display='none'"/></div>
              <span>${esc(mapName(d.map))}</span>
            </div>
            <div class="opp-match-vs">vs <strong>${esc(d._oppName || 'unknown')}</strong></div>
            <div class="opp-match-score">${scoreHtml}</div>
            <div class="opp-match-tag">${d._outcome || '?'}</div>
          </a>`
      }).join('')}
    </div>`
}
