// Modal UI for assigning team names to a demo or series. Pulled out of
// demos.js so demo-viewer.js can reuse it as a blocking entry gate.

import { supabase } from './supabase.js'
import { attachTeamAutocomplete } from './team-autocomplete.js'
import { detectRosters, namesForDemo } from './assign-teams.js'
import {
  findCandidateVods,
  pickBestVod,
  computeVodPatch,
  demoLocalDate,
} from './auto-fill-vod.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

// Lightweight one-shot toast. Appended to <body>, fades out after 4s.
// Inline to keep this module self-contained — promote to a util later if a
// third caller appears.
function showToast(msg) {
  const el = document.createElement('div')
  el.textContent = msg
  el.style.cssText = [
    'position:fixed', 'right:24px', 'bottom:24px', 'z-index:99999',
    'background:#2b2b2b', 'color:#fff', 'padding:12px 16px',
    'border-radius:6px', 'font-family:sans-serif', 'font-size:14px',
    'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
    'opacity:0', 'transition:opacity 200ms ease-out',
    'max-width:360px',
  ].join(';')
  document.body.appendChild(el)
  requestAnimationFrame(() => { el.style.opacity = '1' })
  setTimeout(() => {
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 250)
  }, 4000)
}

// After demo names are saved, look for matching vods and fill in scores.
// Idempotent + best-effort: any DB error is logged and swallowed so it never
// breaks the modal save.
async function tryAutoFillVods(savedDemos, teamId) {
  if (!savedDemos?.length || !teamId) return
  try {
    const dates = savedDemos.map(demoLocalDate).filter(Boolean).sort()
    if (!dates.length) return
    const minDate = dates[0]
    const maxDate = dates[dates.length - 1]
    const widen = (d, delta) => {
      const dt = new Date(`${d}T00:00:00`)
      dt.setDate(dt.getDate() + delta)
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    }
    const { data: vods, error } = await supabase
      .from('vods')
      .select('id, opponent, match_date, maps, result, demo_link, created_at')
      .eq('team_id', teamId)
      .gte('match_date', widen(minDate, -1))
      .lte('match_date', widen(maxDate, 1))
    if (error) { console.warn('[auto-fill] vod fetch failed:', error.message); return }
    if (!vods?.length) return

    const groups = new Map()
    for (const demo of savedDemos) {
      const cands = findCandidateVods(demo, vods)
      const chosen = pickBestVod(cands, demo)
      if (!chosen) continue
      let g = groups.get(chosen.id)
      if (!g) { g = { vod: chosen, demos: [] }; groups.set(chosen.id, g) }
      g.demos.push(demo)
    }

    const filledLines = []
    for (const { vod, demos } of groups.values()) {
      const patch = computeVodPatch(demos, vod)
      if (!patch) continue
      const { _filledMapNames, ...dbPatch } = patch
      const { error: upErr } = await supabase.from('vods').update(dbPatch).eq('id', vod.id)
      if (upErr) { console.warn('[auto-fill] vod update failed:', upErr.message); continue }
      filledLines.push(`${vod.opponent} (${_filledMapNames.join(', ')})`)
    }

    if (filledLines.length) {
      showToast(`Linked match: ${filledLines.join('; ')}`)
    }
  } catch (e) {
    console.warn('[auto-fill] unexpected error:', e)
  }
}

// Roster-aware modal. demoIdOrSeries is either a single demo id (string)
// or an array of demos that share a series. opts may include:
//   - onSave():    invoked after Save persists names (use for list refresh)
//   - onCancel():  invoked when user cancels (button or overlay click)
// Resolves on save with one of two shapes depending on which path ran:
//   - { nameA, nameB }  — the roster-aware path (rosters confidently detected)
//   - { ct, t }         — the legacy by-side fallback (mixed lineups)
// Resolves to null on cancel. Callers that only branch on truthiness (e.g.
// the viewer entry gate) work either way; callers that read named keys must
// account for both shapes.
export async function showAssignTeamsModal(demoIdOrSeries, opts = {}) {
  // Normalise to a list of demos with match_data.
  let demos = []
  if (Array.isArray(demoIdOrSeries)) {
    demos = demoIdOrSeries
  } else {
    const { data: d, error } = await supabase
      .from('demos')
      .select('id,series_id,match_data,ct_team_name,t_team_name,created_at,team_id,played_at,team_a_score,team_b_score,team_a_first_side,map')
      .eq('id', demoIdOrSeries)
      .single()
    if (error || !d) { alert('Could not load demo data.'); return }
    if (d.series_id) {
      const { data: sib } = await supabase
        .from('demos')
        .select('id,series_id,match_data,ct_team_name,t_team_name,created_at,team_id,played_at,team_a_score,team_b_score,team_a_first_side,map')
        .eq('series_id', d.series_id)
        .order('created_at', { ascending: true })
      demos = sib || [d]
    } else {
      demos = [d]
    }
  }
  if (!demos.length || !demos[0].match_data) { alert('No demo data.'); return }

  const { rosterA, rosterB, confident } = detectRosters(demos)
  if (!confident) {
    alert('Mixed roster across maps — falling back to per-map team assignment.')
    return showLegacyBySideModal(demos[0].id, opts)
  }

  // Pre-fill names from existing data: look at map 1's saved names + side mapping.
  const m1 = demos[0]
  const m1Names = namesForDemo(m1, rosterA, rosterB, 'A', 'B')
  // m1Names.ct_team_name is 'A' if Roster A was on CT in map 1, else 'B'.
  const aSavedSide = m1Names.ct_team_name === 'A' ? 'ct' : 't'
  const initialA = aSavedSide === 'ct' ? (m1.ct_team_name ?? '') : (m1.t_team_name ?? '')
  const initialB = aSavedSide === 'ct' ? (m1.t_team_name ?? '') : (m1.ct_team_name ?? '')

  function rosterPanel(label, players, accent) {
    const lines = players.map(p =>
      `<div style="font-size:11px;color:${accent};padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>`
    ).join('')
    return `
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.10);border-radius:8px;padding:12px">
        <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.55);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">${label}</div>
        ${lines || '<span style="color:#444;font-size:11px">No players found</span>'}
      </div>`
  }

  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:1000;
      display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);
    `
    overlay.innerHTML = `
      <div style="
        background:#0a0a0a;border:1px solid rgba(175,163,254,0.22);border-radius:14px;
        padding:28px 32px;width:520px;max-width:94vw;
        box-shadow:0 0 40px rgba(175,163,254,0.12);
      ">
        <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px">Assign Teams</div>
        <div style="font-size:11px;color:#666;margin-bottom:20px">${demos.length > 1 ? `Applies to all ${demos.length} maps in this series.` : 'Applies to this map.'}</div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
          ${rosterPanel('Roster A', rosterA, '#bbb')}
          ${rosterPanel('Roster B', rosterB, '#bbb')}
        </div>

        <div style="margin-bottom:14px">
          <label style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.55);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">Roster A team name</label>
          <input id="modal-a-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(initialA)}">
        </div>
        <div style="margin-bottom:28px">
          <label style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.55);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">Roster B team name</label>
          <input id="modal-b-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(initialB)}">
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button id="modal-cancel" class="btn btn-ghost">Cancel</button>
          <button id="modal-save" class="btn btn-primary">Save</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    let nameA = initialA
    let nameB = initialB

    attachTeamAutocomplete(overlay.querySelector('#modal-a-input'), t => { nameA = t.name })
    attachTeamAutocomplete(overlay.querySelector('#modal-b-input'), t => { nameB = t.name })
    overlay.querySelector('#modal-a-input').addEventListener('input', e => { nameA = e.target.value })
    overlay.querySelector('#modal-b-input').addEventListener('input', e => { nameB = e.target.value })

    overlay.querySelector('#modal-cancel').addEventListener('click', () => { opts.onCancel?.(); overlay.remove(); resolve(null) })
    overlay.querySelector('#modal-save').addEventListener('click', async () => {
      const updates = []
      for (const d of demos) {
        const names = namesForDemo(d, rosterA, rosterB, nameA, nameB)
        d.ct_team_name = names.ct_team_name
        d.t_team_name  = names.t_team_name
        updates.push(supabase.from('demos').update({
          ct_team_name: names.ct_team_name || null,
          t_team_name:  names.t_team_name  || null,
        }).eq('id', d.id))
      }
      await Promise.all(updates)
      await tryAutoFillVods(demos, demos[0]?.team_id)
      overlay.remove()
      resolve({ nameA, nameB })
      opts.onSave?.()
    })
    overlay.addEventListener('click', e => { if (e.target === overlay) { opts.onCancel?.(); overlay.remove(); resolve(null) } })
  })
}

export async function showLegacyBySideModal(demoId, opts = {}) {
  const { data, error } = await supabase
    .from('demos')
    .select('match_data,ct_team_name,t_team_name,series_id,team_id,map,played_at,created_at,team_a_score,team_b_score,team_a_first_side')
    .eq('id', demoId)
    .single()
  if (error || !data?.match_data) { alert('Could not load demo data.'); return null }
  const firstFrame = data.match_data.frames?.[0]
  const meta = data.match_data.players_meta ?? {}
  const nameOf = p => meta[p.steam_id]?.name ?? p.name ?? ''
  const ctPlayers  = (firstFrame?.players ?? []).filter(p => p.team === 'ct').map(nameOf)
  const tPlayers   = (firstFrame?.players ?? []).filter(p => p.team === 't').map(nameOf)

  function playerList(names, color) {
    if (!names.length) return '<span style="color:#444;font-size:11px">No players found</span>'
    return names.map(n =>
      `<div style="font-size:11px;color:${color};padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(n)}</div>`
    ).join('')
  }

  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:1000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);`
    overlay.innerHTML = `
      <div style="background:#0a0a0a;border:1px solid rgba(175,163,254,0.22);border-radius:14px;padding:28px 32px;width:480px;max-width:94vw;box-shadow:0 0 40px rgba(175,163,254,0.12);">
        <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:20px">Assign Teams (per-side)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
          <div style="background:rgba(79,195,247,0.05);border:1px solid rgba(79,195,247,0.14);border-radius:8px;padding:12px">
            <div style="font-size:10px;font-weight:700;color:rgba(79,195,247,0.7);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">CT Side</div>
            ${playerList(ctPlayers, '#4FC3F7')}
          </div>
          <div style="background:rgba(255,149,0,0.05);border:1px solid rgba(255,149,0,0.14);border-radius:8px;padding:12px">
            <div style="font-size:10px;font-weight:700;color:rgba(255,149,0,0.7);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">T Side</div>
            ${playerList(tPlayers, '#FF9500')}
          </div>
        </div>
        <div style="margin-bottom:14px"><label style="font-size:10px;font-weight:700;color:rgba(79,195,247,0.7);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">CT Team Name</label><input id="legacy-ct-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(data.ct_team_name ?? '')}"></div>
        <div style="margin-bottom:28px"><label style="font-size:10px;font-weight:700;color:rgba(255,149,0,0.7);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">T Team Name</label><input id="legacy-t-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(data.t_team_name ?? '')}"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end"><button id="legacy-cancel" class="btn btn-ghost">Cancel</button><button id="legacy-save" class="btn btn-primary">Save</button></div>
      </div>`
    document.body.appendChild(overlay)
    let ct = data.ct_team_name ?? '', t = data.t_team_name ?? ''
    attachTeamAutocomplete(overlay.querySelector('#legacy-ct-input'), x => { ct = x.name })
    attachTeamAutocomplete(overlay.querySelector('#legacy-t-input'),  x => { t  = x.name })
    overlay.querySelector('#legacy-ct-input').addEventListener('input', e => { ct = e.target.value })
    overlay.querySelector('#legacy-t-input').addEventListener('input',  e => { t  = e.target.value })
    overlay.querySelector('#legacy-cancel').addEventListener('click', () => { opts.onCancel?.(); overlay.remove(); resolve(null) })
    overlay.querySelector('#legacy-save').addEventListener('click', async () => {
      await supabase.from('demos').update({
        ct_team_name: ct || null,
        t_team_name:  t  || null,
      }).eq('id', demoId)
      const synthetic = {
        id: demoId,
        series_id: data.series_id ?? null,
        ct_team_name: ct, t_team_name: t,
        map: data.map, played_at: data.played_at, created_at: data.created_at,
        team_a_score: data.team_a_score, team_b_score: data.team_b_score,
        team_a_first_side: data.team_a_first_side,
      }
      await tryAutoFillVods([synthetic], data.team_id)
      overlay.remove()
      resolve({ ct, t })
      opts.onSave?.()
    })
    overlay.addEventListener('click', e => { if (e.target === overlay) { opts.onCancel?.(); overlay.remove(); resolve(null) } })
  })
}
