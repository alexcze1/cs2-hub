// cs2-hub/vods-match-reports.js
//
// Per-vod match cards. Pure render — orchestrator passes in the linked
// demo map and the demo_players rows. mapFilter narrows the list.

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
  // demoToVod is Map<demo_id, vod>. Reverse-scan to find the demo linked to this vod.
  for (const [demoId, v] of demoToVod) {
    if (v?.id === vod.id) return demoId
  }
  return null
}

function topPerformers(demoId, demoPlayersByDemoId) {
  if (!demoId) return []
  const rows = (demoPlayersByDemoId.get(demoId) ?? []).filter(r => r.side === 'all')
  return [...rows]
    .filter(r => r.rating != null)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 3)
}

export function renderMatchReports(root, { vods, demoToVod, demoPlayersByDemoId, mapFilter }) {
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
    const performers = topPerformers(demoId, demoPlayersByDemoId || new Map())
    const perfHtml = performers.length
      ? `<div class="rr-match-performers">
           <div class="rr-match-performers-label">Top performers</div>
           ${performers.map(p =>
             `<span class="rr-match-perf"><b>${esc(p.name)}</b> ${p.rating.toFixed(2)}</span>`
           ).join(' · ')}
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
        <div class="rr-match-right">${perfHtml}</div>
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
