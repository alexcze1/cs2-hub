// cs2-hub/demos.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { showAssignTeamsModal } from './assign-teams-modal.js'
import { getTeamLogo, teamLogoEl } from './team-autocomplete.js'
import {
  loadPlaylists, loadPlaylistRounds, createPlaylist, deletePlaylist, renamePlaylist,
  removeRoundFromPlaylist, sortByPosition,
} from './playlists.js'
import { loadPubFilter, savePubFilter, pubGroupMatchesFilter } from './demos-pub-filter.js'
import { toast } from './toast.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function formatDate(d) { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }
function mapFileFor(map) {
  if (!map) return null
  const m = map.replace(/^de_/, '')
  return m === 'dust2' ? 'dust' : m
}
function mapDisplay(map) {
  if (!map) return '—'
  const m = map.replace(/^de_/, '')
  return m.charAt(0).toUpperCase() + m.slice(1)
}
function mapImg(map, cls) {
  const file = mapFileFor(map)
  if (!file) return `<div class="${cls} demo-map-empty">?</div>`
  // Strip non-alphanumeric so a malicious map name can't escape the inline
  // onerror string context. mapFileFor preserves the raw map column verbatim.
  const fallback = file.slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return `<div class="${cls}"><img src="images/maps/${file}.png" alt="${esc(map)}" onerror="this.parentElement.innerHTML='<span>${fallback}</span>'"/></div>`
}
function mapBg(map) {
  const file = mapFileFor(map)
  return file ? `images/maps/${file}.png` : ''
}
function relativeTime(iso) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(iso)
}

// Shared logo cache + teamChip. Both team and public scopes feed names through
// here so cards render with the same chips. `warmLogos` is fire-and-forget;
// chips render with the placeholder until the lookups resolve, then re-render.
const logoCache = {}
async function warmLogos(names) {
  await Promise.all(
    [...names].filter(Boolean).map(async n => {
      if (n in logoCache) return
      logoCache[n] = await getTeamLogo(n)
    }),
  )
}
function teamChip(name, logoSize = 28) {
  const logo = teamLogoEl(logoCache[name] ?? null, name ?? '???', logoSize)
  return `
    <div class="dx-team-chip">
      ${logo}
      <span class="dx-team-name">${esc(name ?? '—')}</span>
    </div>`
}

// ── scope router ──────────────────────────────────────────────
// /demos.html supports two scopes: "team" (signed-in user's uploaded demos) and
// "public" (HLTV-ingested pro demos, readable by anon visitors). The bulk of
// this file is the team flow, wrapped in runTeamScope() so it doesn't fire for
// anon visitors. The public flow lives at the bottom of the file.

async function runTeamScope() {

await requireAuth()
renderSidebar('demos')

const VPS_URL = 'https://vps.midround.pro'
const teamId  = getTeamId()
const heroEl    = document.getElementById('demos-hero')
const filtersEl = document.getElementById('demos-filters')
const listEl    = document.getElementById('demos-list')
const fileInput = document.getElementById('demo-file-input')
const progressWrap = document.getElementById('upload-progress')
const progressText = document.getElementById('upload-progress-text')
const progressBar  = document.getElementById('upload-progress-bar')

const FILTER_LS_KEY = 'demos:filter:v1'
const DEFAULT_FILTER = { window: 'all', map: 'all' }
function loadSavedFilter() {
  try {
    const v = JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '{}')
    return { ...DEFAULT_FILTER, ...v }
  } catch { return { ...DEFAULT_FILTER } }
}
function saveFilter(f) { try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify(f)) } catch {} }

const state = {
  filter:   loadSavedFilter(),
  rawDemos: [],
  entries:  [],
  // The user's own team name (from the teams table). Used to anchor the
  // win/loss border accent on each card — green when the team page's team
  // won, red when it lost. Without this, the accent would just follow
  // whichever team got rendered on the left, which inverts per-map for
  // series where sides flip.
  ownTeamName: null,
}

async function loadOwnTeamName() {
  if (!teamId) return null
  const { data } = await supabase
    .from('teams')
    .select('name')
    .eq('id', teamId)
    .maybeSingle()
  return data?.name ?? null
}

// Returns 'win' | 'loss' | 'draw' | null for a single demo, anchored on the
// team page's own team name. Null when we can't tell (no scores, can't match
// own team to either side).
function ownOutcome(d, ownName) {
  if (d.status !== 'ready' || !ownName) return null
  const td = teamDisplay(d)
  if (td.leftScore == null || td.rightScore == null) return null
  const own = ownName.toLowerCase()
  let ours, theirs
  if (td.left && td.left.toLowerCase() === own) {
    ours = td.leftScore; theirs = td.rightScore
  } else if (td.right && td.right.toLowerCase() === own) {
    ours = td.rightScore; theirs = td.leftScore
  } else {
    return null
  }
  if (ours > theirs) return 'win'
  if (ours < theirs) return 'loss'
  return 'draw'
}

const playlistsState = {
  list: [], loaded: false, openId: null, openRows: [], roundCounts: new Map(),
}

// ── Data layer ────────────────────────────────────────────────
async function loadDemos() {
  // Fetch the user's own team name once (lazy) — cached on state so we don't
  // re-query on every realtime reload.
  if (state.ownTeamName == null) {
    state.ownTeamName = await loadOwnTeamName()
  }

  const { data, error } = await supabase
    .from('demos')
    .select('id,status,error_message,map,played_at,score_ct,score_t,team_a_score,team_b_score,team_a_first_side,opponent_name,ct_team_name,t_team_name,series_id,storage_path,created_at')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false })

  if (error) {
    heroEl.innerHTML = `<div class="empty-state"><h3>Failed to load demos</h3><p>${esc(error.message)}</p></div>`
    listEl.innerHTML = ''
    return
  }

  state.rawDemos = data ?? []

  // Group into entries (single or series).
  const seriesMap = new Map(), singles = []
  for (const d of state.rawDemos) {
    if (d.series_id) {
      if (!seriesMap.has(d.series_id)) seriesMap.set(d.series_id, [])
      seriesMap.get(d.series_id).push(d)
    } else {
      singles.push(d)
    }
  }
  const entries = []
  for (const demos of seriesMap.values()) {
    demos.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const latestAt = Math.max(...demos.map(d => +new Date(d.created_at)))
    entries.push({ kind: 'series', demos, latestAt })
  }
  for (const d of singles) {
    entries.push({ kind: 'single', demos: [d], latestAt: +new Date(d.created_at) })
  }
  entries.sort((a, b) => b.latestAt - a.latestAt)
  state.entries = entries

  // Resolve team logos for every team name we'll show (module-level cache).
  const names = new Set()
  for (const d of state.rawDemos) {
    if (d.ct_team_name) names.add(d.ct_team_name)
    if (d.t_team_name)  names.add(d.t_team_name)
    if (d.opponent_name) names.add(d.opponent_name)
  }
  await warmLogos(names)

  renderAll()
}

// ── Hero ──────────────────────────────────────────────────────
function computeHeroStats(demos) {
  const total      = demos.length
  const pending    = demos.filter(d => d.status === 'pending' || d.status === 'processing').length
  const errored    = demos.filter(d => d.status === 'error').length
  const latest     = demos[0] ?? null
  const mapCounts  = {}
  for (const d of demos) {
    if (!d.map) continue
    mapCounts[d.map] = (mapCounts[d.map] || 0) + 1
  }
  let topMap = null, topMapN = 0
  for (const [m, n] of Object.entries(mapCounts)) {
    if (n > topMapN) { topMap = m; topMapN = n }
  }
  return { total, pending, errored, latest, topMap }
}

function renderHero() {
  const s = computeHeroStats(state.rawDemos)
  heroEl.innerHTML = `
    <div class="dx-hero-grid">
      <div class="dx-hero-left">
        <div class="dx-hero-title">DEMOS</div>
        <div class="dx-hero-count">${s.total}<span class="dx-hero-count-unit">${s.total === 1 ? ' demo' : ' demos'}</span></div>
        <div class="dx-hero-substats">
          <div class="dx-kv"><div class="dx-kv-k">Pending</div><div class="dx-kv-v ${s.pending ? 'dx-warn' : ''}">${s.pending}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Errors</div><div class="dx-kv-v ${s.errored ? 'dx-bad' : ''}">${s.errored}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Top map</div><div class="dx-kv-v">${s.topMap ? esc(mapDisplay(s.topMap)) : '—'}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Last upload</div><div class="dx-kv-v">${s.latest ? esc(relativeTime(s.latest.created_at)) : '—'}</div></div>
        </div>
        <button type="button" class="dx-upload-cta" id="dx-upload-btn">+ Upload Demo</button>
      </div>
      <div class="dx-hero-right">
        ${s.topMap ? `<div class="dx-hero-mapwash" style="background-image:url('${esc(mapBg(s.topMap))}')"></div>` : ''}
      </div>
    </div>
  `
  document.getElementById('dx-upload-btn').addEventListener('click', () => fileInput.click())
}

// ── Filters ───────────────────────────────────────────────────
function availableMaps() {
  const set = new Set()
  for (const d of state.rawDemos) { if (d.map) set.add(d.map) }
  return [...set].sort()
}

function renderFilters() {
  const f = state.filter
  const wins = [
    ['7d',  'Last 7 days'],
    ['30d', 'Last 30 days'],
    ['all', 'All time'],
  ]
  const maps = availableMaps()
  filtersEl.innerHTML = `
    <div class="dx-filter-row">
      <div class="dx-filter-group" data-group="window">
        ${wins.map(([k, label]) => `<button type="button" class="dx-pill ${f.window === k ? 'is-active' : ''}" data-val="${k}">${esc(label)}</button>`).join('')}
      </div>
      <div class="dx-filter-divider"></div>
      <div class="dx-filter-group" data-group="map">
        <button type="button" class="dx-pill ${f.map === 'all' ? 'is-active' : ''}" data-val="all">All maps</button>
        ${maps.map(m => `<button type="button" class="dx-pill ${f.map === m ? 'is-active' : ''}" data-val="${esc(m)}">${esc(mapDisplay(m))}</button>`).join('')}
      </div>
    </div>
  `
  for (const btn of filtersEl.querySelectorAll('.dx-pill')) {
    btn.addEventListener('click', () => {
      const group = btn.parentElement.dataset.group
      const val   = btn.dataset.val
      if (state.filter[group] === val) return
      state.filter = { ...state.filter, [group]: val }
      saveFilter(state.filter)
      renderFilters()
      renderList()
    })
  }
}

// ── Filtering ─────────────────────────────────────────────────
function entryMatchesFilter(entry, filter) {
  if (filter.window !== 'all') {
    const days = filter.window === '7d' ? 7 : filter.window === '30d' ? 30 : null
    if (days != null) {
      const cutoff = Date.now() - days * 86400000
      if (entry.latestAt < cutoff) return false
    }
  }
  if (filter.map !== 'all') {
    if (!entry.demos.some(d => d.map === filter.map)) return false
  }
  return true
}

// ── Demo list ─────────────────────────────────────────────────
function teamDisplay(d) {
  const teamsSet  = d.ct_team_name && d.t_team_name
  const haveRoster = d.team_a_score != null && d.team_b_score != null && d.team_a_first_side
  if (teamsSet && haveRoster) {
    const nameA = d.team_a_first_side === 'ct' ? d.ct_team_name : d.t_team_name
    const nameB = d.team_a_first_side === 'ct' ? d.t_team_name  : d.ct_team_name
    return { left: nameA, right: nameB, leftScore: d.team_a_score, rightScore: d.team_b_score }
  }
  if (teamsSet) {
    return { left: d.ct_team_name, right: d.t_team_name, leftScore: d.score_ct, rightScore: d.score_t }
  }
  return { left: null, right: null, leftScore: d.score_ct, rightScore: d.score_t }
}

function statusBadge(d) {
  if (d.status === 'pending' || d.status === 'processing') {
    return `<span class="dx-status dx-status-pending">● Processing</span>`
  }
  if (d.status === 'error') {
    return `<span class="dx-status dx-status-error" title="${esc(d.error_message ?? '')}">● Error</span>`
  }
  return ''
}

function watchBtn(d) {
  if (d.status === 'ready')
    return `<a class="dx-watch" href="demo-viewer.html?id=${d.id}">▶ Watch</a>`
  if (d.status === 'error')
    return `<button class="dx-action-ghost" onclick="retryDemo('${d.id}')">Retry</button>`
  return `<button class="dx-watch is-disabled" disabled>▶ Watch</button>`
}

function actionMenu(d, td, opts = {}) {
  const teamsLabel = td.left ? '✎ Teams' : '+ Teams'
  const items = []
  if (d.status === 'ready') {
    items.push(`<button class="dx-action-ghost" onclick="assignTeams('${d.id}')">${teamsLabel}</button>`)
  }
  if (opts.deleteSeries) {
    items.push(`<button class="dx-action-ghost dx-danger" title="Delete series" onclick="deleteSeries('${opts.deleteSeries.id}', ${opts.deleteSeries.count})">✕</button>`)
  } else {
    items.push(`<button class="dx-action-ghost dx-danger" title="Delete demo" onclick="deleteDemo('${d.id}')">✕</button>`)
  }
  return items.join('')
}

function scoreStrip(td, hasResult) {
  const leftWin  = hasResult && td.leftScore  > td.rightScore
  const rightWin = hasResult && td.rightScore > td.leftScore
  const leftCls  = !hasResult ? 'dx-score-none' : leftWin  ? 'dx-score-win' : 'dx-score-loss'
  const rightCls = !hasResult ? 'dx-score-none' : rightWin ? 'dx-score-win' : 'dx-score-loss'
  return `
    <div class="dx-score-strip">
      <span class="dx-score ${leftCls}">${td.leftScore ?? '—'}</span>
      <span class="dx-score-sep">—</span>
      <span class="dx-score ${rightCls}">${td.rightScore ?? '—'}</span>
    </div>`
}

function singleCard(d) {
  const td = teamDisplay(d)
  const hasResult = td.leftScore != null && td.rightScore != null && d.status === 'ready'
  const dateStr   = d.played_at ? formatDate(d.played_at) : formatDate(d.created_at)
  const leftName  = td.left  ?? d.opponent_name ?? null
  const rightName = td.right ?? null
  // Anchor the accent on the user's own team — not on whoever ended up on
  // the left chip. Same team can be on either side across maps in a series
  // when team_a_first_side flips, so left-side anchoring inverted per-map.
  const outcome = ownOutcome(d, state.ownTeamName)
  const winCls = !hasResult ? 'dx-card-none'
    : outcome === 'win'  ? 'dx-card-win'
    : outcome === 'loss' ? 'dx-card-loss'
    : outcome === 'draw' ? 'dx-card-draw'
    : 'dx-card-none'
  return `
    <article class="dx-card-compact ${winCls}" id="demo-row-${d.id}">
      <div class="dx-card-compact-map" style="${mapBg(d.map) ? `background-image:url('${esc(mapBg(d.map))}')` : ''}">
        <div class="dx-card-compact-map-overlay"></div>
        <div class="dx-card-compact-map-label">${esc(mapDisplay(d.map))}</div>
      </div>
      <div class="dx-card-compact-meta">
        <span class="dx-card-tag dx-card-tag-demo">DEMO</span>
        <span class="dx-card-date">${esc(dateStr)}</span>
      </div>
      <div class="dx-card-compact-versus">
        ${teamChip(leftName, 22)}
        ${scoreStrip(td, hasResult)}
        ${teamChip(rightName, 22)}
      </div>
      <div class="dx-card-compact-actions">
        ${statusBadge(d)}
        ${watchBtn(d)}
        ${actionMenu(d, td)}
      </div>
    </article>`
}

function seriesMapRow(d, i) {
  const td = teamDisplay(d)
  const hasResult = td.leftScore != null && td.rightScore != null && d.status === 'ready'
  const leftWin  = hasResult && td.leftScore  > td.rightScore
  const rightWin = hasResult && td.rightScore > td.leftScore
  return `
    <div class="dx-series-compact-row" id="demo-row-${d.id}">
      <div class="dx-series-compact-row-left">
        <span class="dx-series-compact-row-icon">M${i + 1}</span>
        <span class="dx-series-compact-row-map">${esc(mapDisplay(d.map))}</span>
      </div>
      <div class="dx-series-compact-row-score">
        ${hasResult
          ? `<span class="${leftWin ? 'dx-score-win' : 'dx-score-loss'}">${td.leftScore}</span>
             <span class="dx-score-sep">—</span>
             <span class="${rightWin ? 'dx-score-win' : 'dx-score-loss'}">${td.rightScore}</span>`
          : '<span class="dx-score-none">— —</span>'}
      </div>
      <div class="dx-series-compact-row-right">
        ${statusBadge(d)}
        ${watchBtn(d)}
        ${actionMenu(d, td)}
      </div>
    </div>`
}

function seriesCard(demos) {
  const first = demos[0]
  const named = demos.find(d => d.ct_team_name && d.t_team_name) ?? first
  const td = teamDisplay(named)
  let mapsLeftWon = 0, mapsRightWon = 0
  // Series accent counts maps the user's team won, not maps the left chip
  // won — same reasoning as singleCard.
  let oursWon = 0, oursLost = 0
  for (const d of demos) {
    const t = teamDisplay(d)
    if (d.status !== 'ready' || t.leftScore == null) continue
    if (t.leftScore  > t.rightScore) mapsLeftWon++
    else if (t.rightScore > t.leftScore) mapsRightWon++
    const o = ownOutcome(d, state.ownTeamName)
    if (o === 'win')  oursWon++
    if (o === 'loss') oursLost++
  }
  const decided = mapsLeftWon !== mapsRightWon
  const oursDecided = oursWon !== oursLost
  const winCls = !oursDecided ? 'dx-card-none'
    : oursWon  > oursLost ? 'dx-card-win'
    : oursLost > oursWon  ? 'dx-card-loss'
    : 'dx-card-draw'
  const total = demos.length
  const boLabel = total <= 1 ? 'BO1' : total <= 3 ? 'BO3' : total <= 5 ? 'BO5' : `BO${total}`
  const dateStr = formatDate(first.played_at ?? first.created_at)
  const leftName  = td.left  ?? first.opponent_name ?? null
  const rightName = td.right ?? null
  const seriesId = first.series_id

  const leftScoreCls  = decided && mapsLeftWon  > mapsRightWon ? 'dx-score-win'  : decided ? 'dx-score-loss' : 'dx-score-none'
  const rightScoreCls = decided && mapsRightWon > mapsLeftWon  ? 'dx-score-win'  : decided ? 'dx-score-loss' : 'dx-score-none'

  return `
    <article class="dx-series-compact ${winCls}">
      <header class="dx-series-compact-head">
        <div class="dx-series-compact-head-left">
          <span class="dx-card-tag dx-card-tag-demo">${boLabel}</span>
          <span class="dx-card-date">${esc(dateStr)}</span>
        </div>
        <div class="dx-card-compact-versus">
          ${teamChip(leftName, 22)}
          <div class="dx-score-strip">
            <span class="dx-score ${leftScoreCls}">${mapsLeftWon}</span>
            <span class="dx-score-sep">—</span>
            <span class="dx-score ${rightScoreCls}">${mapsRightWon}</span>
          </div>
          ${teamChip(rightName, 22)}
        </div>
        <div class="dx-series-compact-head-right">
          <button class="dx-action-ghost dx-danger" title="Delete entire series" onclick="deleteSeries('${seriesId}', ${demos.length})">✕</button>
        </div>
      </header>
      ${demos.map((d, i) => seriesMapRow(d, i)).join('')}
    </article>`
}

function renderList() {
  const filtered = state.entries.filter(e => entryMatchesFilter(e, state.filter))
  if (state.entries.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><h3>No demos yet</h3><p>Upload your first .dem file to get started.</p></div>`
    return
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="dx-empty">No demos match the current filters.</div>`
    return
  }
  listEl.innerHTML = filtered.map(e =>
    e.kind === 'series' ? seriesCard(e.demos) : singleCard(e.demos[0])
  ).join('')
}

function renderAll() {
  renderHero()
  renderFilters()
  renderList()
}

// ── Realtime ──────────────────────────────────────────────────
// On every UPDATE event we also remember demos that just transitioned to
// 'ready'; after the page re-renders we pulse those rows so the coach
// sees which demo just finished parsing without having to scan the list.
const _justReadyIds = new Set()
supabase.channel('demos-status')
  .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'demos', filter: `team_id=eq.${teamId}` },
      payload => {
        if (payload.new?.status === 'ready' && payload.old?.status !== 'ready') {
          _justReadyIds.add(payload.new.id)
        }
        loadDemos().then(() => {
          for (const id of _justReadyIds) {
            const row = document.getElementById(`demo-row-${id}`)
            if (row) {
              row.classList.remove('demo-row-just-ready')
              // force reflow so the animation restarts even if we re-add
              void row.offsetWidth
              row.classList.add('demo-row-just-ready')
            }
          }
          _justReadyIds.clear()
        })
        maybeAutoOpenAssignModal(payload.new)
      })
  .subscribe()

const _autoModalShown = new Set()

async function maybeAutoOpenAssignModal(updated) {
  if (!updated || updated.status !== 'ready') return
  if (updated.ct_team_name && updated.t_team_name) return

  if (updated.series_id) {
    if (_autoModalShown.has(updated.series_id)) return
    const { data: sib } = await supabase
      .from('demos')
      .select('id,series_id,match_data_url,ct_team_name,t_team_name,created_at,status')
      .eq('series_id', updated.series_id)
      .order('created_at', { ascending: true })
    if (!sib?.length) return
    if (sib.some(d => d.status !== 'ready')) return
    if (sib.some(d => d.ct_team_name && d.t_team_name)) {
      _autoModalShown.add(updated.series_id)
      return
    }
    _autoModalShown.add(updated.series_id)
    showAssignTeamsModal(sib, { onSave: loadDemos })
  } else {
    if (_autoModalShown.has(updated.id)) return
    _autoModalShown.add(updated.id)
    showAssignTeamsModal(updated.id, { onSave: loadDemos })
  }
}

window.assignTeams = id => showAssignTeamsModal(id, { onSave: loadDemos })

async function purgeDemos(rows) {
  const paths = rows.map(r => r.storage_path).filter(Boolean)
  if (paths.length) {
    const { error: storageErr } = await supabase.storage.from('demos').remove(paths)
    if (storageErr) console.warn('Storage delete failed:', storageErr.message)
  }
  const ids = rows.map(r => r.id)
  const { error: rowErr } = await supabase.from('demos').delete().in('id', ids)
  if (rowErr) {
    alert(`Failed to delete: ${rowErr.message}`)
    return false
  }
  return true
}

window.deleteDemo = async id => {
  const { data: row } = await supabase.from('demos').select('id,storage_path,map,series_id').eq('id', id).single()
  if (!row) return
  const label = row.map ? row.map.replace(/^de_/, '') : 'this demo'
  const inSeries = row.series_id ? ' (will leave the rest of the series intact)' : ''
  if (!confirm(`Delete ${label}?${inSeries}\n\nThis cannot be undone.`)) return
  if (await purgeDemos([row])) loadDemos()
}

window.deleteSeries = async (seriesId, count) => {
  if (!confirm(`Delete this entire series (${count} map${count === 1 ? '' : 's'})?\n\nThis cannot be undone.`)) return
  const { data: rows } = await supabase.from('demos').select('id,storage_path').eq('series_id', seriesId)
  if (!rows?.length) return
  if (await purgeDemos(rows)) loadDemos()
}

window.retryDemo = async id => {
  await supabase.from('demos').update({ status: 'pending', error_message: null }).eq('id', id)
  loadDemos()
}

// ── Upload ────────────────────────────────────────────────────
fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files]
  fileInput.value = ''
  if (!files.length) return

  for (const f of files) {
    if (!f.name.endsWith('.dem')) { alert('Please select .dem files only.'); return }
    if (f.size > 1024 * 1024 * 1024) { alert(`${f.name} is too large (max 1 GB).`); return }
  }

  const seriesId = files.length > 1 ? crypto.randomUUID() : null
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token

  progressWrap.style.display = 'block'

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    progressBar.style.width = '0%'
    progressText.textContent = files.length > 1
      ? `Uploading map ${i + 1} of ${files.length}: ${file.name}…`
      : `Uploading ${file.name}…`

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('team_id', teamId)

      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${VPS_URL}/upload`)
        xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100)
            progressBar.style.width = pct + '%'
            progressText.textContent = files.length > 1
              ? `Map ${i + 1}/${files.length}: ${file.name} — ${pct}%`
              : `Uploading… ${pct}%`
          }
        }
        xhr.onload = () => {
          // Server may return non-JSON on 5xx (HTML error pages from a CDN or
          // proxy). Parse defensively so the user sees a real error message
          // instead of "Unexpected token <".
          let body = null
          try { body = JSON.parse(xhr.responseText) } catch { /* non-JSON */ }
          if (xhr.status === 200) {
            return body
              ? resolve(body)
              : reject(new Error('Upload server returned invalid response'))
          }
          const detail = body?.detail || `Upload failed (${xhr.status})`
          reject(new Error(detail))
        }
        xhr.onerror = () => reject(new Error('Could not reach upload server'))
        xhr.send(formData)
      })

      if (seriesId) {
        await supabase.from('demos').update({ series_id: seriesId }).eq('id', result.demo_id)
      }

    } catch (err) {
      progressText.textContent = `Upload failed for ${file.name}: ${err.message}`
      await new Promise(r => setTimeout(r, 3000))
    }
  }

  progressBar.style.width = '100%'
  progressText.textContent = files.length > 1
    ? `${files.length} demos uploaded — processing in background…`
    : 'Uploaded — processing in background…'
  setTimeout(() => { progressWrap.style.display = 'none' }, 3000)
  loadDemos()
})

loadDemos()
loadPlaylistsForCurrentTeam()

// ── Playlists ─────────────────────────────────────────────────
async function loadPlaylistsForCurrentTeam() {
  const tid = getTeamId()
  if (!tid) {
    document.getElementById('dl-playlists').hidden = true
    return
  }
  try {
    playlistsState.list = await loadPlaylists(tid)
    const ids = playlistsState.list.map(p => p.id)
    const m = new Map()
    if (ids.length) {
      const { data: counts, error } = await supabase
        .from('playlist_rounds')
        .select('playlist_id')
        .in('playlist_id', ids)
      if (error) throw error
      for (const r of counts ?? []) m.set(r.playlist_id, (m.get(r.playlist_id) ?? 0) + 1)
    }
    playlistsState.roundCounts = m
    playlistsState.loaded = true
    renderPlaylistsSection()
  } catch (e) {
    console.error('[demos] load playlists failed:', e)
    toast('Failed to load playlists', 'error')
  }
}

function renderPlaylistsSection() {
  const host = document.getElementById('dl-playlists')
  host.hidden = false
  if (playlistsState.openId) renderPlaylistsDetail(host)
  else                       renderPlaylistsMaster(host)
}

function formatRelative(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const days = Math.round((Date.now() - d.getTime()) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7)  return `${days}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function renderPlaylistsMaster(host) {
  const rows = playlistsState.list.map(p => {
    const count = playlistsState.roundCounts.get(p.id) ?? 0
    return `
      <div class="dl-pl-row" data-id="${esc(p.id)}">
        <div class="dl-pl-name">${esc(p.name)}</div>
        <div class="dl-pl-count">${count} round${count === 1 ? '' : 's'}</div>
        <div class="dl-pl-date">${formatRelative(p.updated_at)}</div>
      </div>
    `
  }).join('')

  host.innerHTML = `
    <div class="dl-pl-header">
      <span class="dl-pl-title">Playlists</span>
      <button class="dl-pl-new" id="dl-pl-new">+ New</button>
    </div>
    <div class="dl-pl-list">
      ${playlistsState.list.length ? rows
        : `<div class="dl-empty">No playlists yet · save a round from the demo viewer to create one.</div>`}
    </div>
  `

  host.querySelector('#dl-pl-new').addEventListener('click', onNewPlaylist)
  for (const row of host.querySelectorAll('.dl-pl-row')) {
    row.addEventListener('click', () => openPlaylist(row.dataset.id))
  }
}

async function onNewPlaylist() {
  const name = prompt('Playlist name:')
  if (!name || !name.trim()) return
  const tid = getTeamId()
  if (!tid) return
  try {
    const userId = (await supabase.auth.getUser()).data.user?.id
    const created = await createPlaylist(tid, name.trim(), userId)
    playlistsState.list.unshift(created)
    playlistsState.roundCounts.set(created.id, 0)
    toast('Playlist created')
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to create playlist', 'error') }
}

async function openPlaylist(id) {
  playlistsState.openId = id
  playlistsState.openRows = []
  renderPlaylistsSection()
  try {
    const rows = await loadPlaylistRounds(id)
    playlistsState.openRows = sortByPosition(rows)
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to load playlist', 'error') }
}

const _demoMetaCache = new Map()

function renderPlaylistsDetail(host) {
  const pl = playlistsState.list.find(p => p.id === playlistsState.openId)
  const empty = !playlistsState.openRows.length
    ? `<div class="dl-empty">Empty playlist · save a round from the demo viewer to add one.</div>`
    : ''

  host.innerHTML = `
    <div class="dl-pl-detail-header">
      <button class="dl-pl-back" id="dl-pl-back" title="Back">←</button>
      <span class="dl-pl-detail-name">${esc(pl?.name ?? '')}</span>
      <button class="dl-pl-action" id="dl-pl-rename" title="Rename playlist">Rename</button>
      <button class="dl-pl-action dl-pl-action-danger" id="dl-pl-delete" title="Delete playlist">Delete</button>
    </div>
    <div class="dl-pl-rounds" id="dl-pl-rounds">${empty}</div>
  `

  host.querySelector('#dl-pl-back').addEventListener('click', () => {
    playlistsState.openId = null
    playlistsState.openRows = []
    renderPlaylistsSection()
  })
  host.querySelector('#dl-pl-rename').addEventListener('click', () => onRenamePlaylist(pl))
  host.querySelector('#dl-pl-delete').addEventListener('click', () => onDeletePlaylist(pl))

  if (playlistsState.openRows.length) hydrateDetailRoundRows()
}

async function getDemoMetaCached(demoId) {
  if (!_demoMetaCache.has(demoId)) {
    const { data, error } = await supabase
      .from('demos')
      .select('id, map, score_ct, score_t')
      .eq('id', demoId).maybeSingle()
    if (error) { console.warn('[demos] getDemoMeta failed:', error); _demoMetaCache.set(demoId, null) }
    else _demoMetaCache.set(demoId, data)
  }
  return _demoMetaCache.get(demoId)
}

function describeRound(row, meta) {
  if (!meta) return { side: 'ct', score: '?–?', mapFile: '' }
  const half  = Math.floor(row.round_idx / 12)
  const side  = (half % 2 === 0) ? 'ct' : 't'
  const score = (meta.score_ct != null && meta.score_t != null)
    ? `${meta.score_ct}–${meta.score_t}`
    : '—'
  const mapFile = (meta.map ?? '').replace(/^de_/, '').toLowerCase() || ''
  return { side, score, mapFile }
}

async function hydrateDetailRoundRows() {
  const listEl = document.getElementById('dl-pl-rounds')
  if (!listEl) return
  const metas = await Promise.all(playlistsState.openRows.map(r => getDemoMetaCached(r.demo_id)))

  listEl.innerHTML = playlistsState.openRows.map((r, i) => {
    const meta = metas[i]
    const info = describeRound(r, meta)
    const thumb = info.mapFile ? `images/maps/${info.mapFile}.png` : ''
    return `
      <div class="dl-round-row" data-row-id="${esc(r.id)}" data-demo-id="${esc(r.demo_id)}" data-round-idx="${r.round_idx}">
        <div class="dl-round-thumb" style="background-image:url('${esc(thumb)}')"></div>
        <div class="dl-round-meta">
          <div class="dl-round-title">
            <span class="dl-round-side-dot ${info.side}"></span>R${r.round_idx + 1} · ${esc(info.score)}
          </div>
          <div class="dl-round-note" title="${esc(r.note ?? '')}">${esc(r.note ?? '')}</div>
        </div>
        <button class="dl-round-x" data-row-id="${esc(r.id)}" title="Remove">✕</button>
      </div>
    `
  }).join('')

  for (const row of listEl.querySelectorAll('.dl-round-row')) {
    row.addEventListener('click', e => {
      if (e.target.closest('.dl-round-x')) return
      const demoId   = row.dataset.demoId
      const roundIdx = row.dataset.roundIdx
      location.href = `demo-viewer.html?id=${encodeURIComponent(demoId)}&round=${encodeURIComponent(roundIdx)}`
    })
  }
  for (const x of listEl.querySelectorAll('.dl-round-x')) {
    x.addEventListener('click', e => {
      e.stopPropagation()
      onRemoveRoundFromPlaylist(x.dataset.rowId)
    })
  }
}

async function onRemoveRoundFromPlaylist(rowId) {
  if (!confirm('Remove round from playlist?')) return
  try {
    await removeRoundFromPlaylist(rowId, playlistsState.openId)
    playlistsState.openRows = playlistsState.openRows.filter(r => r.id !== rowId)
    const cur = playlistsState.roundCounts.get(playlistsState.openId) ?? 0
    playlistsState.roundCounts.set(playlistsState.openId, Math.max(0, cur - 1))
    toast('Removed')
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to remove', 'error') }
}

async function onRenamePlaylist(pl) {
  const newName = prompt('New name:', pl.name)
  if (!newName || !newName.trim() || newName.trim() === pl.name) return
  try {
    await renamePlaylist(pl.id, newName.trim())
    pl.name = newName.trim()
    toast('Renamed')
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to rename', 'error') }
}

async function onDeletePlaylist(pl) {
  if (!confirm(`Delete playlist "${pl.name}"? This removes all its saved rounds.`)) return
  try {
    await deletePlaylist(pl.id)
    playlistsState.list = playlistsState.list.filter(x => x.id !== pl.id)
    playlistsState.roundCounts.delete(pl.id)
    playlistsState.openId = null
    playlistsState.openRows = []
    toast('Playlist deleted')
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to delete', 'error') }
}

}  // end runTeamScope


// ── public scope (HLTV pro demos) ─────────────────────────────

async function determineScope() {
  const hash = new URLSearchParams(location.hash.slice(1))
  const fromHash = hash.get('scope')
  if (fromHash === 'public' || fromHash === 'team') return fromHash
  const { data: { session } } = await supabase.auth.getSession()
  return session ? 'team' : 'public'
}

function renderTabs(activeScope) {
  const el = document.getElementById('demos-tabs')
  if (!el) return
  el.innerHTML = `
    <button type="button" class="dx-tab ${activeScope === 'team'   ? 'is-active' : ''}" data-scope="team">Team</button>
    <button type="button" class="dx-tab ${activeScope === 'public' ? 'is-active' : ''}" data-scope="public">Pro</button>
  `
  for (const btn of el.querySelectorAll('.dx-tab')) {
    btn.addEventListener('click', () => {
      const next = btn.dataset.scope
      if (next === activeScope) return
      location.hash = `scope=${next}`
      location.reload()
    })
  }
}

// Shared helpers (esc, formatDate, mapImg, mapBg, mapDisplay) live at module top
// alongside the team flow helpers — both scopes use them.

function pubScoreFor(d) {
  // Only the HLTV-authoritative team_a/team_b scores align to the chip order
  // we render. score_ct/score_t are per-half-side totals from the parser, so
  // using them as a fallback shows team B's score under team A's chip whenever
  // team A played the T side that map. Better to render "—" until HLTV
  // backfills than to render a misleading number.
  if (d.team_a_score != null && d.team_b_score != null) return [d.team_a_score, d.team_b_score]
  return [null, null]
}

function renderPublicSeriesCard(demos) {
  const first   = demos[0]
  // Pick a canonical (teamA, teamB) for the series. Per-map rows may have the
  // names in either order (legacy data ingested before HLTV-authoritative
  // scores), so we align each map's scores to the canonical pair by NAME
  // rather than trusting team_a_score == "score for the left chip".
  const teamA   = first.team_a_name ?? first.ct_team_name ?? 'Team A'
  const teamB   = first.team_b_name ?? first.t_team_name  ?? 'Team B'
  const dateStr = first.played_at ? formatDate(first.played_at) : formatDate(first.created_at)

  // Resolve a map's (left, right) score for the series's canonical chip order.
  // Returns nulls when scores aren't populated or alignment can't be resolved.
  const scoresAligned = (d) => {
    const ta = d.team_a_score, tb = d.team_b_score
    if (ta == null || tb == null) return [null, null]
    if (d.team_a_name === teamA && d.team_b_name === teamB) return [ta, tb]
    if (d.team_a_name === teamB && d.team_b_name === teamA) return [tb, ta]
    // Unknown name pair (drift). Best-effort: keep row order.
    return [ta, tb]
  }

  let mapsAWon = 0, mapsBWon = 0
  for (const d of demos) {
    if (d.status !== 'ready') continue
    const [a, b] = scoresAligned(d)
    if (a == null || b == null) continue
    if (a > b) mapsAWon++
    else if (b > a) mapsBWon++
  }
  const boLabel = demos.length <= 1 ? 'BO1' : demos.length <= 3 ? 'BO3' : demos.length <= 5 ? 'BO5' : `BO${demos.length}`

  const decided = mapsAWon !== mapsBWon
  // Public viewers have no stake in either team — keep the card neutral
  // (no win/loss border accent). Per-row scores still get coloured by the
  // map's own winner so the result is still visible at a glance.
  const winCls = ''
  const leftScoreCls  = decided && mapsAWon > mapsBWon ? 'dx-score-win'  : decided ? 'dx-score-loss' : 'dx-score-none'
  const rightScoreCls = decided && mapsBWon > mapsAWon ? 'dx-score-win'  : decided ? 'dx-score-loss' : 'dx-score-none'

  const mapsHtml = demos.map((d, i) => {
    const [a, b] = scoresAligned(d)
    const hasResult = a != null && b != null && d.status === 'ready'
    const aWin = hasResult && a > b
    const bWin = hasResult && b > a
    return `
      <div class="dx-series-compact-row" id="demo-row-${d.id}">
        <div class="dx-series-compact-row-left">
          <span class="dx-series-compact-row-icon">M${i + 1}</span>
          <span class="dx-series-compact-row-map">${esc(mapDisplay(d.map))}</span>
        </div>
        <div class="dx-series-compact-row-score">
          ${hasResult
            ? `<span class="${aWin ? 'dx-score-win' : 'dx-score-loss'}">${a}</span><span class="dx-score-sep">—</span><span class="${bWin ? 'dx-score-win' : 'dx-score-loss'}">${b}</span>`
            : '<span class="dx-score-none">— —</span>'}
        </div>
        <div class="dx-series-compact-row-right">
          ${d.status === 'ready'
            ? `<a class="dx-watch" href="demo-viewer.html?id=${d.id}">▶ Watch</a>`
            : d.status === 'error'
              ? `<span class="dx-status dx-status-error" title="parse failed">● Failed</span>`
              : `<span class="dx-status dx-status-pending">● Processing</span>`}
        </div>
      </div>`
  }).join('')

  return `
    <article class="dx-series-compact ${winCls}">
      <header class="dx-series-compact-head">
        <div class="dx-series-compact-head-left">
          <span class="dx-card-tag dx-card-tag-demo">${boLabel} · PRO</span>
          <span class="dx-card-date">${esc(dateStr)}</span>
        </div>
        <div class="dx-card-compact-versus">
          ${teamChip(teamA, 22)}
          <div class="dx-score-strip">
            <span class="dx-score ${leftScoreCls}">${mapsAWon}</span>
            <span class="dx-score-sep">—</span>
            <span class="dx-score ${rightScoreCls}">${mapsBWon}</span>
          </div>
          ${teamChip(teamB, 22)}
        </div>
        <div class="dx-series-compact-head-right">
          ${first.event_name ? `<span class="dx-card-compact-event" title="${esc(first.event_name)}">${esc(first.event_name)}</span>` : ''}
          ${first.source_url ? `<a class="dx-action-ghost" href="${esc(first.source_url)}" target="_blank" rel="noopener" title="View on HLTV">↗</a>` : ''}
        </div>
      </header>
      ${mapsHtml}
    </article>`
}

function renderPublicSingleCard(d) {
  const teamA = d.team_a_name ?? d.ct_team_name ?? 'Team A'
  const teamB = d.team_b_name ?? d.t_team_name  ?? 'Team B'
  const dateStr = d.played_at ? formatDate(d.played_at) : formatDate(d.created_at)
  const [a, b] = pubScoreFor(d)
  const hasResult = a != null && b != null && d.status === 'ready'
  const aWin = hasResult && a > b
  const bWin = hasResult && b > a
  // Public viewers have no stake in either team — keep the card neutral
  // (no win/loss border accent). Scores still get coloured below.
  const winCls = ''
  return `
    <article class="dx-card-compact ${winCls}" id="demo-row-${d.id}">
      <div class="dx-card-compact-map" style="${mapBg(d.map) ? `background-image:url('${esc(mapBg(d.map))}')` : ''}">
        <div class="dx-card-compact-map-overlay"></div>
        <div class="dx-card-compact-map-label">${esc(mapDisplay(d.map))}</div>
      </div>
      <div class="dx-card-compact-meta">
        <span class="dx-card-tag dx-card-tag-demo">PRO</span>
        <span class="dx-card-date">${esc(dateStr)}</span>
      </div>
      <div class="dx-card-compact-versus">
        ${teamChip(teamA, 22)}
        <div class="dx-score-strip">
          <span class="dx-score ${hasResult ? (aWin ? 'dx-score-win' : 'dx-score-loss') : 'dx-score-none'}">${a ?? '—'}</span>
          <span class="dx-score-sep">—</span>
          <span class="dx-score ${hasResult ? (bWin ? 'dx-score-win' : 'dx-score-loss') : 'dx-score-none'}">${b ?? '—'}</span>
        </div>
        ${teamChip(teamB, 22)}
      </div>
      <div class="dx-card-compact-actions">
        ${d.event_name ? `<span class="dx-card-compact-event" title="${esc(d.event_name)}">${esc(d.event_name)}</span>` : ''}
        ${d.status === 'ready'
          ? `<a class="dx-watch" href="demo-viewer.html?id=${d.id}">▶ Watch</a>`
          : d.status === 'error'
          ? `<span class="dx-status dx-status-error" title="parse failed">● Failed</span>`
          : `<button class="dx-watch is-disabled" disabled>▶ Processing</button>`}
        ${d.source_url ? `<a class="dx-action-ghost" href="${esc(d.source_url)}" target="_blank" rel="noopener" title="View on HLTV">↗</a>` : ''}
      </div>
    </article>`
}

async function runPublicScope() {
  renderSidebar('demos')

  // Hide team-only chrome.
  const upload    = document.getElementById('demo-file-input')
  const progress  = document.getElementById('upload-progress')
  const playlists = document.getElementById('dl-playlists')
  if (upload)    upload.style.display = 'none'
  if (progress)  progress.style.display = 'none'
  if (playlists) { playlists.hidden = true; playlists.style.display = 'none' }

  const heroEl    = document.getElementById('demos-hero')
  const filtersEl = document.getElementById('demos-filters')
  const listEl    = document.getElementById('demos-list')

  // All loaded rows, kept in module-scope so the filter UI can re-render
  // without re-querying Supabase. reloadPublicList() refreshes this.
  const state = {
    rows: [],
    groups: [],
    filter: loadPubFilter(),
  }

  // Hero rendered once; the count is patched in place each reload below.
  heroEl.innerHTML = `
    <div class="dx-hero-grid">
      <div class="dx-hero-left">
        <div class="dx-hero-title">PRO DEMOS</div>
        <div class="dx-hero-substats">
          <div class="dx-kv"><div class="dx-kv-k">Source</div><div class="dx-kv-v">HLTV (last 90 days)</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Total</div><div class="dx-kv-v" id="pro-total-count">…</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Showing</div><div class="dx-kv-v" id="pro-showing-count">…</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Live</div><div class="dx-kv-v" id="pro-live-status">connecting…</div></div>
        </div>
      </div>
    </div>`

  function renderFilters() {
    const f = state.filter
    const wins = [['7d','Last 7 days'], ['30d','Last 30 days'], ['90d','Last 90 days'], ['all','All time']]

    const mapSet = new Set()
    const eventSet = new Set()
    for (const d of state.rows) {
      if (d.map) mapSet.add(d.map)
      if (d.event_name) eventSet.add(d.event_name)
    }
    const maps = [...mapSet].sort()
    const events = [...eventSet].sort((a, b) => a.localeCompare(b))

    filtersEl.innerHTML = `
      <div class="dx-filter-row">
        <input type="search" id="dx-pub-search" class="dx-search-input"
               placeholder="Search team or event…" value="${esc(f.q)}"/>
        <div class="dx-filter-group" data-group="window">
          ${wins.map(([k,l]) => `<button type="button" class="dx-pill ${f.window===k?'is-active':''}" data-val="${k}">${esc(l)}</button>`).join('')}
        </div>
        <div class="dx-filter-divider"></div>
        <div class="dx-filter-group" data-group="map">
          <button type="button" class="dx-pill ${f.map==='all'?'is-active':''}" data-val="all">All maps</button>
          ${maps.map(m => `<button type="button" class="dx-pill ${f.map===m?'is-active':''}" data-val="${esc(m)}">${esc(mapDisplay(m))}</button>`).join('')}
        </div>
        <div class="dx-filter-divider"></div>
        <select id="dx-pub-event" class="dx-select">
          <option value="all" ${f.event==='all'?'selected':''}>All events</option>
          ${events.map(e => `<option value="${esc(e)}" ${f.event===e?'selected':''}>${esc(e)}</option>`).join('')}
        </select>
      </div>
    `

    for (const btn of filtersEl.querySelectorAll('.dx-pill')) {
      btn.addEventListener('click', () => {
        const group = btn.parentElement.dataset.group
        const val   = btn.dataset.val
        if (state.filter[group] === val) return
        state.filter = { ...state.filter, [group]: val }
        savePubFilter(state.filter)
        renderFilters()
        renderList()
      })
    }

    const searchEl = filtersEl.querySelector('#dx-pub-search')
    let searchTimer = null
    searchEl.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        state.filter = { ...state.filter, q: searchEl.value }
        savePubFilter(state.filter)
        renderList()
      }, 180)
    })

    const eventEl = filtersEl.querySelector('#dx-pub-event')
    eventEl.addEventListener('change', () => {
      state.filter = { ...state.filter, event: eventEl.value }
      savePubFilter(state.filter)
      renderList()
    })
  }

  function renderList() {
    const showingEl = document.getElementById('pro-showing-count')
    if (!state.groups.length) {
      listEl.innerHTML = `<div class="empty-state"><h3>No pro demos yet</h3><p>The HLTV ingest worker hasn't picked up any matches yet — check back soon.</p></div>`
      if (showingEl) showingEl.textContent = '0'
      return
    }
    const filtered = state.groups.filter(demos => pubGroupMatchesFilter(demos, state.filter))
    if (showingEl) showingEl.textContent = String(filtered.length)
    if (!filtered.length) {
      listEl.innerHTML = `<div class="dx-empty">No pro demos match the current filters.</div>`
      return
    }
    const cards = filtered.map(demos =>
      demos.length > 1 ? renderPublicSeriesCard(demos) : renderPublicSingleCard(demos[0])
    )
    listEl.innerHTML = cards.join('')
  }

  // Fetch + (re-)render. Called on first paint and again whenever the realtime
  // channel tells us a public demo row changed. Debounced from the subscription
  // so a backfill burst doesn't re-render dozens of times per second.
  async function reloadPublicList() {
    const [{ data, error }, countRes] = await Promise.all([
      supabase
        .from('demos')
        .select('id, map, played_at, score_ct, score_t, team_a_score, team_b_score, team_a_first_side, team_a_name, team_b_name, ct_team_name, t_team_name, event_name, source_url, source_match_id, source_map_index, status, created_at')
        .eq('is_public', true)
        .order('played_at', { ascending: false, nullsFirst: false })
        .limit(3000),
      supabase.from('demos').select('id', { count: 'exact', head: true }).eq('is_public', true),
    ])

    const countEl = document.getElementById('pro-total-count')
    if (countEl) countEl.textContent = countRes.count != null ? String(countRes.count) : '—'

    if (error) {
      listEl.innerHTML = `<div class="empty-state"><h3>Failed to load pro demos</h3><p>${esc(error.message)}</p></div>`
      return
    }
    state.rows = data ?? []

    const teamNames = new Set()
    for (const d of state.rows) {
      if (d.team_a_name) teamNames.add(d.team_a_name)
      if (d.team_b_name) teamNames.add(d.team_b_name)
    }
    await warmLogos(teamNames)

    const groupMap = new Map()
    for (const d of state.rows) {
      const key = d.source_match_id ?? `single:${d.id}`
      if (!groupMap.has(key)) groupMap.set(key, [])
      groupMap.get(key).push(d)
    }
    state.groups = [...groupMap.values()]
    for (const demos of state.groups) {
      demos.sort((a, b) => (a.source_map_index ?? 0) - (b.source_map_index ?? 0))
    }
    // Sort series newest-first by HLTV match date (played_at), falling back to
    // upload time when a row hasn't been backfilled yet. The initial SQL order
    // is by played_at on the row level, but per-map rows within a series can
    // share or differ in played_at and Map insertion order isn't a reliable
    // proxy for "latest match" once we've grouped.
    const latestPlayedAt = demos => Math.max(
      ...demos.map(d => +new Date(d.played_at ?? d.created_at)),
    )
    state.groups.sort((a, b) => latestPlayedAt(b) - latestPlayedAt(a))

    renderFilters()
    renderList()
  }

  await reloadPublicList()

  // Live updates — debounce reloads so a backfill INSERT burst (one row per map,
  // BO3 = 3 inserts in a few seconds) reflows the list only once.
  let reloadTimer = null
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => { reloadTimer = null; reloadPublicList() }, 2500)
  }

  const liveStatusEl = document.getElementById('pro-live-status')
  supabase.channel('public-demos-stream')
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'demos', filter: 'is_public=eq.true' },
        () => scheduleReload())
    .subscribe(status => {
      if (liveStatusEl) {
        liveStatusEl.textContent = status === 'SUBSCRIBED' ? 'on' : status.toLowerCase()
      }
    })

  // Belt-and-suspenders periodic refresh — covers the case where the realtime
  // socket silently drops or RLS replication lags. 60 s is short enough that
  // the user sees the count climb but cheap enough on the DB.
  setInterval(reloadPublicList, 60000)
}


// ── kickoff ───────────────────────────────────────────────────

const scope = await determineScope()
renderTabs(scope)
if (scope === 'public') {
  await runPublicScope()
} else {
  await runTeamScope()
}
