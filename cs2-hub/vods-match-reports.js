// cs2-hub/vods-match-reports.js
//
// Per-vod match cards. Pure render — orchestrator passes in the linked
// demo, the demo_players rows, and the (our-team-filtered) team-stats rows
// keyed by demo_id. mapFilter narrows the list.
//
// Highlights (up to 3): round diff, dominant side, top performer.

const DOMINANT_SIDE_WR = 0.65
const MIN_SIDE_ROUNDS = 12

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function deriveResult(vod) {
  let mw = 0, ml = 0
  for (const m of vod.maps ?? []) {
    if ((m.score_us ?? 0) > (m.score_them ?? 0)) mw++
    else if ((m.score_them ?? 0) > (m.score_us ?? 0)) ml++
  }
  if (mw > ml) return 'win'
  if (ml > mw) return 'loss'
  if ((vod.maps ?? []).length) return 'draw'
  return vod.result ?? 'draw'
}

function findDemoForVod(vod, demoToVod) {
  for (const [demoId, v] of demoToVod) {
    if (v?.id === vod.id) return demoId
  }
  return null
}

function topPerformer(demoId, demoPlayersByDemoId) {
  if (!demoId) return null
  const rows = (demoPlayersByDemoId.get(demoId) ?? []).filter(r => r.side === 'all')
  return [...rows]
    .filter(r => r.rating != null)
    .sort((a, b) => b.rating - a.rating)[0] ?? null
}

function roundDiff(vod) {
  let us = 0, them = 0
  for (const m of vod.maps ?? []) {
    us += m.score_us ?? 0
    them += m.score_them ?? 0
  }
  return us - them
}

// "Strong CT side" / "Strong T side" / null. Uses our-team-filtered row.
function dominantSide(teamStatsRow) {
  if (!teamStatsRow) return null
  const ct = teamStatsRow.ct_rounds_played > 0
    ? teamStatsRow.ct_round_wins / teamStatsRow.ct_rounds_played : null
  const t = teamStatsRow.t_rounds_played > 0
    ? teamStatsRow.t_round_wins / teamStatsRow.t_rounds_played : null
  const eligibleCt = teamStatsRow.ct_rounds_played >= MIN_SIDE_ROUNDS && ct != null && ct >= DOMINANT_SIDE_WR
  const eligibleT  = teamStatsRow.t_rounds_played  >= MIN_SIDE_ROUNDS && t  != null && t  >= DOMINANT_SIDE_WR
  if (eligibleCt && eligibleT) return ct >= t ? 'Strong CT side' : 'Strong T side'
  if (eligibleCt) return 'Strong CT side'
  if (eligibleT)  return 'Strong T side'
  return null
}

function highlights(vod, demoId, demoPlayersByDemoId, teamStatsByDemoId) {
  const out = []
  const side = dominantSide(teamStatsByDemoId?.get(demoId))
  if (side) out.push(side)

  const diff = roundDiff(vod)
  if (Math.abs(diff) >= 4) {
    out.push(`${diff > 0 ? '+' : ''}${diff} round diff`)
  }

  const top = topPerformer(demoId, demoPlayersByDemoId || new Map())
  if (top) out.push(`${top.name} ${top.rating.toFixed(2)} rating`)

  return out.slice(0, 3)
}

export function renderMatchReports(root, { vods, demoToVod, demoPlayersByDemoId, teamStatsByDemoId, mapFilter }) {
  const filtered = (vods || []).filter(v => {
    if (!mapFilter) return true
    return (v.maps ?? []).some(m => String(m.map).toLowerCase() === String(mapFilter).toLowerCase())
  })

  if (filtered.length === 0) {
    root.innerHTML = `
      <div class="rr-section-label">MATCH REPORTS${mapFilter ? ` · ${esc(capitalize(mapFilter))} <button type="button" class="rr-clear-map">clear</button>` : ''}</div>
      <div class="rr-empty">${mapFilter ? `No matches on ${esc(capitalize(mapFilter))} in window.` : 'No matches in window.'}</div>`
    wireClearButton(root)
    return
  }

  const cards = filtered.map(v => {
    const result = deriveResult(v)
    const safeResult = ['win', 'loss', 'draw'].includes(result) ? result : 'draw'
    const maps = v.maps ?? []
    const opponent = v.opponent ?? v.title ?? '—'

    const scoreHtml = maps.length === 1
      ? `<div class="rr-match-score">${maps[0].score_us ?? '?'} <span class="rr-match-score-sep">—</span> ${maps[0].score_them ?? '?'}</div>`
      : `<div class="rr-match-bo">${maps.map(m =>
          `<div class="rr-match-bo-row">
             <span class="rr-match-bo-map">${esc(capitalize(m.map))}</span>
             <span class="rr-match-bo-score">${m.score_us ?? '?'} — ${m.score_them ?? '?'}</span>
           </div>`).join('')}</div>`

    const mapLabel = maps.length === 0
      ? 'No maps'
      : maps.length === 1
        ? capitalize(maps[0].map)
        : `BO${maps.length}`

    const demoId = findDemoForVod(v, demoToVod || new Map())
    const hl = highlights(v, demoId, demoPlayersByDemoId, teamStatsByDemoId)
    const hlHtml = hl.length
      ? `<div class="rr-match-highlights">
           <div class="rr-match-highlights-label">Highlights</div>
           <ul class="rr-match-highlights-list">
             ${hl.map(t => `<li>${esc(t)}</li>`).join('')}
           </ul>
         </div>`
      : ''

    return `
      <a class="rr-match-card rr-match-${safeResult}" data-result="${safeResult}" href="vod-detail.html?id=${esc(v.id)}">
        <div class="rr-match-left">
          <div class="rr-match-head">
            <span class="rr-match-tag rr-match-tag-${safeResult}">${safeResult.toUpperCase()}</span>
            <span class="rr-match-vs">vs ${esc(opponent)}</span>
            ${v.external_uid ? '<span class="rr-pracc-badge">PRACC</span>' : ''}
          </div>
          <div class="rr-match-meta">
            <span>${esc(mapLabel)}</span>
            <span class="rr-match-dot">·</span>
            <span>${esc(capitalize(v.match_type ?? ''))}</span>
            <span class="rr-match-dot">·</span>
            <span>${formatDate(v.match_date)}</span>
          </div>
        </div>
        <div class="rr-match-mid">${scoreHtml}</div>
        <div class="rr-match-right">${hlHtml}</div>
      </a>`
  }).join('')

  root.innerHTML = `
    <div class="rr-section-label">MATCH REPORTS${mapFilter ? ` · ${esc(capitalize(mapFilter))} <button type="button" class="rr-clear-map">clear</button>` : ''}</div>
    <div class="rr-match-list">${cards}</div>`

  wireClearButton(root)
}

function wireClearButton(root) {
  const clearBtn = root.querySelector('.rr-clear-map')
  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      root.dispatchEvent(new CustomEvent('rr:filter-map', { bubbles: true, detail: { map: null } }))
    })
  }
}
