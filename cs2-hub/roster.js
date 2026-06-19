// cs2-hub/roster.js
//
// Roster — the team's people AND their performance in one place. Each card
// surfaces a player's role, status and headline form (rating, K/D, ADR,
// KAST, opening duels) aggregated from `demo_players`; clicking a card opens
// the shared player drawer with the full breakdown (side splits, clutches,
// per-map, recent matches). Owner management (role, Steam ID, remove) lives
// inside that drawer so the grid stays clean.

import { requireAuth, isTeamOwner } from './auth.js'
import { renderSidebar, renderToolHeader } from './layout.js'
import { supabase, getTeamId } from './supabase.js'
import { toast } from './toast.js'
import { getPlayerImage } from './player-autocomplete.js'
import { mountDrawer } from './player-drawer.js'
import { buildPlayerDrawerBody, buildSubtitle } from './roster-stats-render.js'
import { aggregatePlayer } from './roster-stats-aggregate.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function fmt(n, d = 2) { return n == null ? '—' : Number(n).toFixed(d) }
function fmtPct(p) { return p == null ? '—' : `${Math.round(p * 100)}%` }
function fmtKD(kd) { return kd == null ? '—' : !isFinite(kd) ? '∞' : kd.toFixed(2) }
function cleanMap(m) { return String(m || '').replace(/^de_/, '') }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '' }
function ratingTone(r) { return r == null ? '' : r >= 1.10 ? 'good' : r <= 0.95 ? 'bad' : 'mid' }

const ROLE_COLORS = {
  IGL: 'var(--accent)', AWPer: 'var(--special)', Entry: 'var(--danger)',
  Support: 'var(--success)', Lurker: 'var(--warning)',
  Coach: 'var(--muted)', Manager: 'var(--muted)',
  Bench: 'var(--muted)', Unassigned: 'var(--text-faint)',
}
const ALL_ROLES = ['IGL','AWPer','Entry','Support','Lurker','Coach','Manager','Bench','Unassigned']
const STAFF_ROLES = new Set(['Coach','Manager','Bench'])

await requireAuth()
renderSidebar('roster')

const teamId = getTeamId()
const isOwner = await isTeamOwner(teamId)
const drawer = mountDrawer()

let allPlayers = []
let statsByPlayer = new Map()   // roster.id -> { agg, rowsAll, rowsCT, rowsT, recent, matches, rounds }
let ourTeamName = ''

// ── Load ───────────────────────────────────────────────────────────────
async function loadRoster() {
  const [{ data: roster, error }, { data: team }] = await Promise.all([
    supabase.from('roster').select('*').eq('team_id', teamId).order('nickname', { ascending: true }),
    supabase.from('teams').select('name').eq('id', teamId).single(),
  ])

  const grid = document.getElementById('roster-grid')
  if (error) {
    renderHeader(null)
    grid.innerHTML = `<div class="rstr-empty"><h3>Couldn't load the roster</h3><p>${esc(error.message)}</p></div>`
    return
  }
  ourTeamName = team?.name || ''
  allPlayers = roster ?? []

  // Pull per-player stats from ready demos. One demos fetch + one demo_players
  // fetch, aggregated client-side by steam_id and side.
  await loadStats()

  renderHeader(deriveTeamStats())
  renderGrid()
}

async function loadStats() {
  statsByPlayer = new Map()
  const sids = allPlayers.map(p => p.steam_id).filter(Boolean)
  if (!sids.length) return

  const { data: demos } = await supabase
    .from('demos')
    .select('id, map, opponent_name, ct_team_name, t_team_name, team_a_name, team_b_name, team_a_score, team_b_score, played_at, created_at')
    .eq('team_id', teamId)
    .eq('status', 'ready')
  const demoList = demos ?? []
  if (!demoList.length) return

  const demosById = new Map(demoList.map(d => [d.id, d]))
  const demoIds = demoList.map(d => d.id)

  const { data: rows } = await supabase
    .from('demo_players')
    .select('*')
    .in('demo_id', demoIds)
  const allRows = (rows ?? []).filter(r => sids.includes(r.steam_id))
  // Attach the (cleaned) map name so per-map aggregation works in the drawer.
  for (const r of allRows) r.map = cleanMap(demosById.get(r.demo_id)?.map)

  for (const p of allPlayers) {
    if (!p.steam_id) { statsByPlayer.set(p.id, emptyStats()); continue }
    const mine   = allRows.filter(r => r.steam_id === p.steam_id)
    const rowsAll = mine.filter(r => r.side === 'all')
    const rowsCT  = mine.filter(r => r.side === 'ct')
    const rowsT   = mine.filter(r => r.side === 't')
    const agg = aggregatePlayer(rowsAll)
    const matches = rowsAll.length
    const rounds = rowsAll.reduce((s, r) => s + (r.rounds_played || 0), 0)

    const recent = rowsAll
      .map(r => {
        const demo = demosById.get(r.demo_id)
        return {
          vod_id: '',
          opponent: demo?.opponent_name || resolveOpponent(demo) || '—',
          map: r.map || cleanMap(demo?.map) || '—',
          rating: r.rating,
          result: demoResult(demo),
          played_at: demo?.played_at || demo?.created_at || null,
        }
      })
      .sort((a, b) => String(b.played_at || '').localeCompare(String(a.played_at || '')))
      .slice(0, 12)

    statsByPlayer.set(p.id, { agg, rowsAll, rowsCT, rowsT, recent, matches, rounds })
  }
}

function emptyStats() {
  return { agg: aggregatePlayer([]), rowsAll: [], rowsCT: [], rowsT: [], recent: [], matches: 0, rounds: 0 }
}

function resolveOpponent(demo) {
  if (!demo) return null
  const ct = (demo.ct_team_name || '').trim()
  const t  = (demo.t_team_name || '').trim()
  const us = ourTeamName.trim().toLowerCase()
  if (ct && ct.toLowerCase() !== us) return ct
  if (t && t.toLowerCase() !== us) return t
  return null
}

function demoResult(demo) {
  if (!demo || demo.team_a_score == null || demo.team_b_score == null) return 'd'
  const us = ourTeamName.trim().toLowerCase()
  const aIsUs = (demo.team_a_name || '').trim().toLowerCase() === us
  const ourScore   = aIsUs ? demo.team_a_score : demo.team_b_score
  const theirScore = aIsUs ? demo.team_b_score : demo.team_a_score
  if (ourScore > theirScore) return 'w'
  if (ourScore < theirScore) return 'l'
  return 'd'
}

// ── Team-level KPI rollup ────────────────────────────────────────────────
function deriveTeamStats() {
  const players = allPlayers.filter(p => !STAFF_ROLES.has(p.role))
  let wRating = 0, wRounds = 0, ok = 0, od = 0, matchSet = new Set()
  let top = null
  for (const p of allPlayers) {
    const st = statsByPlayer.get(p.id)
    if (!st || st.matches === 0) continue
    const a = st.agg
    if (a.rating != null) { wRating += a.rating * st.rounds; wRounds += st.rounds }
    ok += a.opening_kills || 0
    od += a.opening_deaths || 0
    for (const r of st.rowsAll) matchSet.add(r.demo_id)
    if (!STAFF_ROLES.has(p.role) && a.rating != null && (!top || a.rating > top.rating)) {
      top = { name: p.nickname, rating: a.rating }
    }
  }
  const avgRating = wRounds > 0 ? wRating / wRounds : null
  const openTotal = ok + od
  const openPct = openTotal > 0 ? ok / openTotal : null
  return {
    players: players.length,
    staff: allPlayers.length - players.length,
    avgRating, openPct,
    matches: matchSet.size,
    top,
    tracked: allPlayers.filter(p => (statsByPlayer.get(p.id)?.matches || 0) > 0).length,
  }
}

function renderHeader(s) {
  const heroEl = document.getElementById('roster-hero')
  const kpis = []
  if (s) {
    kpis.push({ v: s.players, k: s.players === 1 ? 'player' : 'players' })
    if (s.staff) kpis.push({ v: s.staff, k: 'staff' })
    kpis.push({ v: s.avgRating != null ? s.avgRating.toFixed(2) : '—', k: 'avg rating',
      tone: s.avgRating == null ? '' : s.avgRating >= 1.0 ? 'good' : 'bad' })
    if (s.top) kpis.push({ v: s.top.name, k: `top · ${s.top.rating.toFixed(2)}`, tone: 'good' })
    kpis.push({ v: s.openPct != null ? `${Math.round(s.openPct * 100)}%` : '—', k: 'opening win',
      tone: s.openPct == null ? '' : s.openPct >= 0.5 ? 'good' : 'bad' })
    kpis.push({ v: s.matches, k: 'matches tracked' })
  }
  renderToolHeader(heroEl, {
    section: 'Team',
    title: 'Roster',
    sub: 'Your players and their current form. Open a card for the full performance breakdown.',
    kpis,
    actions: isOwner ? `<button type="button" class="dx-upload-cta" id="add-ghost-btn">+ Add player</button>` : '',
  })
  if (isOwner) document.getElementById('add-ghost-btn').addEventListener('click', openGhostForm)
}

// ── Grid ─────────────────────────────────────────────────────────────────
async function renderGrid() {
  const grid = document.getElementById('roster-grid')

  if (!allPlayers.length) {
    grid.innerHTML = `
      <div class="rstr-empty">
        <div class="rstr-empty-icon">${ICON_USERS}</div>
        <h3>No players on the roster yet</h3>
        <p>Add your lineup to track per-player form from your demos — rating, K/D, opening duels and per-map performance, all in one place.</p>
        ${isOwner ? `<button type="button" class="dx-upload-cta" id="empty-add-btn">+ Add your first player</button>` : `<p class="rstr-empty-note">Your team owner sets up the roster.</p>`}
      </div>`
    document.getElementById('empty-add-btn')?.addEventListener('click', openGhostForm)
    return
  }

  // Sort: players (by rating desc, then name) before staff.
  const order = [...allPlayers].sort((a, b) => {
    const aStaff = STAFF_ROLES.has(a.role), bStaff = STAFF_ROLES.has(b.role)
    if (aStaff !== bStaff) return aStaff ? 1 : -1
    const ar = statsByPlayer.get(a.id)?.agg.rating ?? -1
    const br = statsByPlayer.get(b.id)?.agg.rating ?? -1
    if (br !== ar) return br - ar
    return String(a.nickname).localeCompare(String(b.nickname))
  })

  const images = await Promise.all(order.map(p => getPlayerImage(p.nickname).catch(() => null)))

  grid.innerHTML = order.map((p, i) => playerCard(p, images[i])).join('')

  for (const card of grid.querySelectorAll('.rstr-card')) {
    card.addEventListener('click', () => openPlayer(card.dataset.pid))
  }
}

function playerCard(p, image) {
  const role = p.role || 'Unassigned'
  const roleColor = ROLE_COLORS[role] ?? 'var(--text-faint)'
  const st = statsByPlayer.get(p.id) || emptyStats()
  const a = st.agg
  const hasStats = st.matches > 0
  const isStaff = STAFF_ROLES.has(role)

  const avatar = image
    ? `<img class="rstr-ava" src="${esc(image)}" alt="${esc(p.nickname)}" style="--rc:${roleColor}"/>`
    : `<div class="rstr-ava rstr-ava-init" style="--rc:${roleColor}">${esc((p.nickname || '?').slice(0, 2).toUpperCase())}</div>`

  const status = p.is_ghost
    ? `<span class="rstr-status rstr-status-pending">Pending</span>`
    : `<span class="rstr-status rstr-status-active">Active</span>`

  const openTotal = (a.opening_kills || 0) + (a.opening_deaths || 0)
  const openPct = openTotal > 0 ? a.opening_kills / openTotal : null

  const ratingBlock = isStaff
    ? `<div class="rstr-rating-wrap"><div class="rstr-rating rstr-rating-staff">—</div><div class="rstr-rating-k">staff</div></div>`
    : `<div class="rstr-rating-wrap">
         <div class="rstr-rating rstr-rating-${ratingTone(a.rating)}">${fmt(a.rating)}</div>
         <div class="rstr-rating-k">rating</div>
       </div>`

  const statsRow = hasStats
    ? `<div class="rstr-stats">
        ${miniStat('K/D', fmtKD(a.kd))}
        ${miniStat('ADR', fmt(a.adr, 0))}
        ${miniStat('KAST', fmtPct(a.kast_pct))}
        ${miniStat('Open', fmtPct(openPct))}
      </div>`
    : `<div class="rstr-nostats">${isStaff ? 'Support staff — no match stats' : 'No demo stats yet'}</div>`

  const form = hasStats ? formStrip(st.recent) : ''

  const meta = hasStats
    ? `<span>${st.matches} match${st.matches === 1 ? '' : 'es'}</span><span class="rstr-dot">·</span><span>${st.rounds} rounds</span>`
    : (p.steam_id ? `<span>Steam linked · awaiting demos</span>` : `<span>No Steam ID linked</span>`)

  return `
    <button class="rstr-card${hasStats ? '' : ' rstr-card-flat'}" data-pid="${esc(p.id)}" style="--rc:${roleColor}">
      <div class="rstr-card-top">
        ${avatar}
        <div class="rstr-id">
          <div class="rstr-nm">${esc(p.nickname || '—')}</div>
          <div class="rstr-role"><span class="rstr-role-dot"></span>${esc(role)}${status}</div>
        </div>
        ${ratingBlock}
      </div>
      ${statsRow}
      <div class="rstr-foot">
        <div class="rstr-meta">${meta}</div>
        ${form}
      </div>
    </button>`
}

function miniStat(k, v) {
  return `<div class="rstr-mini"><div class="rstr-mini-v">${esc(v)}</div><div class="rstr-mini-k">${esc(k)}</div></div>`
}

function formStrip(recent) {
  if (!recent || !recent.length) return ''
  const dots = recent.slice(0, 7).reverse().map(r =>
    `<span class="rstr-form-dot rstr-form-${r.result}" title="${esc(capitalize(r.map))} vs ${esc(r.opponent)} · ${fmt(r.rating)}"></span>`
  ).join('')
  return `<div class="rstr-form">${dots}</div>`
}

// ── Player drawer ────────────────────────────────────────────────────────
function openPlayer(pid) {
  const p = allPlayers.find(x => x.id === pid)
  if (!p) return
  const st = statsByPlayer.get(pid) || emptyStats()

  const statsBody = buildPlayerDrawerBody({
    rowsAll: st.rowsAll, rowsCT: st.rowsCT, rowsT: st.rowsT, recent: st.recent,
  })
  const manage = isOwner ? manageBlock(p) : ''
  const subtitle = st.matches > 0
    ? buildSubtitle(p, 'all', st.matches, st.rounds)
    : `${p.role || 'Player'} · ${p.steam_id ? 'Steam linked' : 'No Steam ID'}`

  drawer.open({ title: p.nickname || '—', subtitle, body: statsBody + manage })

  if (isOwner) wireManage(p)
}

function manageBlock(p) {
  const role = p.role || 'Unassigned'
  return `
    <div class="rstr-manage">
      <div class="rr-pd-label">Manage</div>
      <div class="rstr-manage-grid">
        <label class="rstr-field">
          <span>Role</span>
          <select class="form-select" id="pd-role">
            ${ALL_ROLES.map(r => `<option value="${r}" ${r === role ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
        </label>
        <label class="rstr-field">
          <span>Steam64 ID</span>
          <input class="form-input" id="pd-steam" inputmode="numeric" maxlength="17"
                 value="${esc(p.steam_id || '')}" placeholder="76561198…"/>
        </label>
      </div>
      <div class="rstr-manage-foot">
        <span class="rstr-field-status" id="pd-steam-status"></span>
        <button type="button" class="btn btn-ghost rstr-remove" id="pd-remove">Remove from team</button>
      </div>
    </div>`
}

function wireManage(p) {
  const root = drawer.el
  const roleSel = root.querySelector('#pd-role')
  const steamInp = root.querySelector('#pd-steam')
  const statusEl = root.querySelector('#pd-steam-status')
  const removeBtn = root.querySelector('#pd-remove')

  roleSel?.addEventListener('change', () => onRoleChange(p.id, roleSel.value))

  const commitSteam = async () => {
    const trimmed = (steamInp.value || '').trim()
    if (trimmed === (p.steam_id || '')) { statusEl.textContent = ''; return }
    const newVal = trimmed === '' ? null : trimmed
    if (newVal !== null && !/^7656119\d{10}$/.test(newVal)) {
      statusEl.textContent = 'Must be a 17-digit Steam64 starting 7656119.'
      statusEl.className = 'rstr-field-status is-bad'
      return
    }
    statusEl.textContent = 'Saving…'; statusEl.className = 'rstr-field-status'
    const { error } = await supabase.from('roster').update({ steam_id: newVal }).eq('id', p.id)
    if (error) { statusEl.textContent = error.message; statusEl.className = 'rstr-field-status is-bad'; return }
    p.steam_id = newVal
    statusEl.textContent = 'Saved — reloading stats'; statusEl.className = 'rstr-field-status is-good'
    toast('Steam ID updated')
    await loadStats(); renderHeader(deriveTeamStats()); renderGrid()
  }
  steamInp?.addEventListener('blur', commitSteam)
  steamInp?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); steamInp.blur() } })

  removeBtn?.addEventListener('click', () => onRemove(p))
}

async function onRoleChange(playerId, newRole) {
  const { error } = await supabase.from('roster').update({ role: newRole }).eq('id', playerId)
  if (error) { toast(`Failed: ${error.message}`); return }
  const p = allPlayers.find(x => x.id === playerId)
  if (p) p.role = newRole
  toast('Role updated')
  renderHeader(deriveTeamStats()); renderGrid()
}

async function onRemove(p) {
  const label = p.nickname || 'this player'
  if (!confirm(p.is_ghost
    ? `Remove ${label}? This deletes their roster slot.`
    : `Remove ${label} from the team? This deletes their team membership.`)) return

  let error
  if (p.is_ghost) {
    ;({ error } = await supabase.from('roster').delete().eq('id', p.id))
  } else {
    ;({ error } = await supabase.from('team_members').delete().eq('team_id', teamId).eq('user_id', p.user_id))
  }
  if (error) { toast(`Failed: ${error.message}`); return }
  toast(p.is_ghost ? 'Player removed' : 'Member removed')
  drawer.close()
  loadRoster()
}

// ── Add-player form ──────────────────────────────────────────────────────
function openGhostForm() {
  const form = document.getElementById('ghost-form')
  form.style.display = 'block'
  document.getElementById('g-nickname').focus()
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}
function resetGhostForm() {
  document.getElementById('ghost-form').style.display = 'none'
  document.getElementById('g-nickname').value = ''
  document.getElementById('g-steam-id').value = ''
  document.getElementById('g-role').value = 'Unassigned'
  document.getElementById('ghost-error').style.display = 'none'
}
document.getElementById('ghost-cancel-btn').addEventListener('click', resetGhostForm)
document.getElementById('ghost-save-btn').addEventListener('click', async () => {
  const nickname = document.getElementById('g-nickname').value.trim()
  const steamId  = document.getElementById('g-steam-id').value.trim()
  const role     = document.getElementById('g-role').value
  const errEl    = document.getElementById('ghost-error')

  if (!nickname) { errEl.textContent = 'Nickname is required.'; errEl.style.display = 'block'; return }
  if (steamId && !/^7656119\d{10}$/.test(steamId)) {
    errEl.textContent = 'Steam ID must be a 17-digit Steam64 starting with 7656119.'
    errEl.style.display = 'block'; return
  }

  const { error } = await supabase.from('roster').insert({
    team_id: teamId, user_id: null, nickname,
    steam_id: steamId || null, role, is_ghost: true,
  })
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  resetGhostForm()
  toast('Player added')
  loadRoster()
})

const ICON_USERS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`

loadRoster()
