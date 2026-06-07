// Public team profile renderer. Reads /api/team-profile?id=<uuid>,
// renders a shareable read-only page. No Supabase client, no auth —
// the endpoint sanitises everything server-side.

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const MAP_LABELS = {
  ancient: 'Ancient', mirage: 'Mirage', nuke: 'Nuke', anubis: 'Anubis',
  inferno: 'Inferno', overpass: 'Overpass', dust2: 'Dust2', train: 'Train',
}
function mapFile(m) { return m === 'dust2' ? 'dust' : m }
function mapName(m) { return MAP_LABELS[m] ?? (m ? m[0].toUpperCase() + m.slice(1) : '—') }

const params = new URLSearchParams(location.search)
const teamId = params.get('id')

const heroEl    = document.getElementById('public-hero')
const mapPoolEl = document.getElementById('public-map-pool')
const resultsEl = document.getElementById('public-results')
const shareBtn  = document.getElementById('share-btn')

function renderInvalid(msg) {
  heroEl.innerHTML = `
    <div class="empty-state-art">
      <div class="empty-state-art-icon">!</div>
      <div class="empty-state-art-title">Profile unavailable</div>
      <div class="empty-state-art-sub">${esc(msg)}</div>
      <a href="/landing.html" class="empty-state-art-cta">Back to MIDROUND →</a>
    </div>`
  mapPoolEl.innerHTML = ''
  resultsEl.innerHTML = ''
}

if (!teamId) {
  renderInvalid('No team id supplied in the URL.')
} else {
  load()
}

async function load() {
  try {
    const r = await fetch(`/api/team-profile?id=${encodeURIComponent(teamId)}`)
    if (!r.ok) {
      const body = await r.json().catch(() => null)
      renderInvalid(body?.error || `Server returned ${r.status}.`)
      return
    }
    const data = await r.json()
    document.title = `${data.team.name} — MIDROUND`
    // Refresh OG meta now that the team name is known. Unfurlers won't
    // see the client-side update, but live previews on already-open
    // tabs (e.g. embedded in an iframe) get the correct title.
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', `${data.team.name} · MIDROUND`)
    renderHero(data)
    renderMapPool(data.stats.map_pool)
    renderResults(data.recent_results)
  } catch (e) {
    renderInvalid(e.message || 'Network error.')
  }
}

function renderHero({ team, stats }) {
  const joined = team.joined_at ? new Date(team.joined_at) : null
  const joinedLabel = joined
    ? joined.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : ''
  const formStrip = stats.form.map(r =>
    `<span class="form-dot form-dot-${r === 'W' ? 'win' : r === 'L' ? 'loss' : 'draw'}">${r}</span>`
  ).join('')
  heroEl.innerHTML = `
    <div class="public-hero-card">
      <div>
        <div class="public-hero-tag">Team Profile</div>
        <h1 class="public-hero-title">${esc(team.name)}</h1>
        ${joinedLabel ? `<div class="public-hero-sub">Tracking on MIDROUND since ${esc(joinedLabel)}</div>` : ''}
      </div>
      <div class="public-hero-stats">
        <div class="public-hero-stat">
          <div class="public-hero-stat-label">Record</div>
          <div class="public-hero-stat-value">
            <span style="color:var(--success)">${stats.record.wins}W</span>
            <span class="public-hero-stat-sep">—</span>
            <span style="color:var(--danger)">${stats.record.losses}L</span>
            ${stats.record.draws ? `<span class="public-hero-stat-sub">${stats.record.draws}D</span>` : ''}
          </div>
        </div>
        <div class="public-hero-stat">
          <div class="public-hero-stat-label">Win %</div>
          <div class="public-hero-stat-value">${stats.win_pct}<span class="public-hero-stat-sub">%</span></div>
        </div>
        <div class="public-hero-stat public-hero-stat-form">
          <div class="public-hero-stat-label">Form · last ${stats.form.length}</div>
          <div class="public-hero-form">${formStrip || '<span class="public-hero-stat-sub">no results yet</span>'}</div>
        </div>
      </div>
    </div>`
}

function renderMapPool(pool) {
  if (!pool.length) {
    mapPoolEl.innerHTML = `
      <div class="empty-state-art">
        <div class="empty-state-art-icon">·</div>
        <div class="empty-state-art-title">No map data yet</div>
        <div class="empty-state-art-sub">This team hasn't logged any match maps.</div>
      </div>`
    return
  }
  mapPoolEl.innerHTML = `
    <div class="map-pool-grid">
      <div class="map-pool-head">
        <div></div><div>Map</div><div>Win %</div><div>Played</div><div></div><div></div>
      </div>
      ${pool.map(m => {
        const status = m.win_pct >= 60 ? 'hot' : m.win_pct >= 40 ? 'warm' : 'cold'
        return `
          <div class="map-pool-row map-pool-row-${status}">
            <div class="map-pool-img" style="background-image:url('images/maps/${mapFile(m.map)}.png')"></div>
            <div class="map-pool-name">${esc(mapName(m.map))}</div>
            <div class="map-pool-wp"><strong>${m.win_pct}%</strong><span class="map-pool-wp-sub">${m.wins}–${m.losses}</span></div>
            <div class="map-pool-last">${m.played}</div>
            <div></div>
            <div class="map-pool-dot map-pool-dot-${status}"></div>
          </div>`
      }).join('')}
    </div>`
}

function renderResults(results) {
  if (!results.length) {
    resultsEl.innerHTML = `
      <div class="empty-state-art">
        <div class="empty-state-art-icon">·</div>
        <div class="empty-state-art-title">No matches logged</div>
      </div>`
    return
  }
  resultsEl.innerHTML = `
    <div class="public-results-list">
      ${results.map(r => {
        const dateStr = r.date
          ? new Date(r.date).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
          : '—'
        const resultBadge = r.result === 'win'  ? '<span class="public-result-pill public-result-win">WIN</span>'
                          : r.result === 'loss' ? '<span class="public-result-pill public-result-loss">LOSS</span>'
                          : r.result === 'draw' ? '<span class="public-result-pill public-result-draw">DRAW</span>'
                          : ''
        const mapsLine = (r.maps || [])
          .filter(m => m.map)
          .map(m => {
            const score = (m.score_us != null && m.score_them != null) ? ` ${m.score_us}-${m.score_them}` : ''
            return `<span class="public-result-map">${esc(mapName(m.map))}${esc(score)}</span>`
          }).join('')
        return `
          <div class="public-result-row">
            <div class="public-result-date">${esc(dateStr)}</div>
            <div class="public-result-opp">
              <span class="public-result-type">${esc((r.type || 'scrim').toUpperCase())}</span>
              ${r.opponent ? `vs ${esc(r.opponent)}` : '<span class="public-result-no-opp">—</span>'}
            </div>
            <div class="public-result-maps">${mapsLine || ''}</div>
            <div class="public-result-status">${resultBadge}</div>
          </div>`
      }).join('')}
    </div>`
}

// Share button. Native Web Share API where available; clipboard
// fallback otherwise. Always copies the canonical full URL so the link
// shared from a mobile install matches the link shared from desktop.
shareBtn.addEventListener('click', async () => {
  const url = location.href
  const title = document.title
  try {
    if (navigator.share) {
      await navigator.share({ title, url })
    } else {
      await navigator.clipboard.writeText(url)
      const original = shareBtn.textContent
      shareBtn.textContent = 'Copied!'
      setTimeout(() => { shareBtn.textContent = original }, 1500)
    }
  } catch {
    // Cancelled share or clipboard failure — silent.
  }
})
