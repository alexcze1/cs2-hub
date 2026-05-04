// Modal UI for assigning team names to a demo or series. Pulled out of
// demos.js so demo-viewer.js can reuse it as a blocking entry gate.

import { supabase } from './supabase.js'
import { attachTeamAutocomplete } from './team-autocomplete.js'
import { detectRosters, namesForDemo } from './assign-teams.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

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
      .select('id,series_id,match_data,ct_team_name,t_team_name,created_at')
      .eq('id', demoIdOrSeries)
      .single()
    if (error || !d) { alert('Could not load demo data.'); return }
    if (d.series_id) {
      const { data: sib } = await supabase
        .from('demos')
        .select('id,series_id,match_data,ct_team_name,t_team_name,created_at')
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
        background:#0a0a0f;border:1px solid rgba(102,102,183,0.22);border-radius:14px;
        padding:28px 32px;width:520px;max-width:94vw;
        box-shadow:0 0 40px rgba(102,102,183,0.12);
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
        updates.push(supabase.from('demos').update({
          ct_team_name: names.ct_team_name || null,
          t_team_name:  names.t_team_name  || null,
        }).eq('id', d.id))
      }
      await Promise.all(updates)
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
    .select('match_data,ct_team_name,t_team_name')
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
      <div style="background:#0a0a0f;border:1px solid rgba(102,102,183,0.22);border-radius:14px;padding:28px 32px;width:480px;max-width:94vw;box-shadow:0 0 40px rgba(102,102,183,0.12);">
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
      overlay.remove()
      resolve({ ct, t })
      opts.onSave?.()
    })
    overlay.addEventListener('click', e => { if (e.target === overlay) { opts.onCancel?.(); overlay.remove(); resolve(null) } })
  })
}
