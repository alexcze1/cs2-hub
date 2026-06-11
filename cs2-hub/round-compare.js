// Round compare (#46) — side-by-side demo summary. Lets a coach pull
// two demos onto the same screen for at-a-glance comparison
// (date / opponent / map / score / round breakdown). Each pane links
// out to the full demo viewer for drill-down.
//
// MVP: no synced playback, no round-by-round timeline overlay. The
// summary frame is small enough that a coach can compare the
// "shape" of two scrims at a glance, then jump into the viewer for
// the rounds that look interesting.

import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
function mapFile(m) { return m === 'dust2' ? 'dust' : m }

await requireAuth()
renderSidebar('round-compare')

const params = new URLSearchParams(location.search)
const teamId = getTeamId()

// Pull the team's last 50 ready demos as picker options.
const { data: demos } = await supabase
  .from('demos')
  .select('id, map, played_at, created_at, opponent_name, team_a_name, team_b_name, team_a_score, team_b_score')
  .eq('team_id', teamId)
  .eq('status', 'ready')
  .order('created_at', { ascending: false })
  .limit(50)

const demosById = new Map((demos ?? []).map(d => [d.id, d]))
const pickA = document.getElementById('rc-pick-a')
const pickB = document.getElementById('rc-pick-b')

for (const d of demos ?? []) {
  const date = d.played_at ?? d.created_at
  const dateStr = date ? new Date(date).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '—'
  const label = `${dateStr} · ${(d.map ?? '?').toUpperCase()} · ${d.opponent_name ?? d.team_b_name ?? '?'}`
  for (const sel of [pickA, pickB]) {
    const opt = document.createElement('option')
    opt.value = d.id
    opt.textContent = label
    sel.appendChild(opt)
  }
}

function renderPane(paneId, demo) {
  const pane = document.getElementById(paneId)
  if (!demo) {
    pane.innerHTML = `<div class="rc-empty">Pick a demo above.</div>`
    return
  }
  const date = demo.played_at ?? demo.created_at
  const dateStr = date ? new Date(date).toLocaleString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—'
  const teamA = demo.team_a_name ?? 'Team A'
  const teamB = demo.team_b_name ?? 'Team B'
  const a = demo.team_a_score, b = demo.team_b_score
  const score = (a != null && b != null) ? `${a}–${b}` : '— —'
  const mapBg = demo.map ? `images/maps/${mapFile(demo.map)}.png` : ''
  pane.innerHTML = `
    <div class="rc-card">
      <div class="rc-card-map" style="${mapBg ? `background-image:url('${esc(mapBg)}')` : ''}">
        <div class="rc-card-map-overlay"></div>
        <div class="rc-card-map-label">${esc((demo.map ?? '?').toUpperCase())}</div>
      </div>
      <div class="rc-card-body">
        <div class="rc-card-date">${esc(dateStr)}</div>
        <div class="rc-card-score">
          <span class="rc-team">${esc(teamA)}</span>
          <span class="rc-score">${esc(score)}</span>
          <span class="rc-team">${esc(teamB)}</span>
        </div>
        <div class="rc-card-actions">
          <a class="dx-upload-cta" href="demo-viewer.html?id=${demo.id}">Open viewer →</a>
          <a class="dx-ghost-cta" href="demo-viewer.html?id=${demo.id}" target="_blank">New tab ↗</a>
        </div>
      </div>
    </div>`
}

function setPick(which, id) {
  const demo = demosById.get(id) ?? null
  renderPane(which === 'a' ? 'rc-pane-a' : 'rc-pane-b', demo)
  const sp = new URLSearchParams(location.search)
  if (id) sp.set(which, id); else sp.delete(which)
  history.replaceState(null, '', `${location.pathname}?${sp.toString()}`)
}

pickA.addEventListener('change', () => setPick('a', pickA.value))
pickB.addEventListener('change', () => setPick('b', pickB.value))

if (params.get('a')) {
  pickA.value = params.get('a')
  setPick('a', params.get('a'))
}
if (params.get('b')) {
  pickB.value = params.get('b')
  setPick('b', params.get('b'))
}
