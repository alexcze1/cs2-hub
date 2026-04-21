import { supabase, setTeamId } from './supabase.js'
import { signOut } from './auth.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const { data: { session } } = await supabase.auth.getSession()
if (!session) { window.location.href = 'index.html'; throw 0 }

const userId = session.user.id

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

async function loadTeams() {
  const { data: memberships } = await supabase
    .from('team_members')
    .select('team_id, role, player_role, teams(id, name, join_code)')
    .eq('user_id', userId)

  const el = document.getElementById('teams-list')
  if (!memberships?.length) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;margin-bottom:8px">You're not in any teams yet.</div>`
    return
  }

  el.innerHTML = `<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;margin-bottom:10px;color:var(--muted)">YOUR TEAMS</div>`
    + memberships.map(m => `
      <button class="list-row" style="width:100%;text-align:left;background:none;border:none;padding:12px 14px;margin-bottom:8px;cursor:pointer;display:flex;align-items:center" data-team-id="${m.team_id}">
        <div style="flex:1">
          <div class="row-name">${esc(m.teams.name)}</div>
          <div class="row-meta" style="display:flex;align-items:center;gap:8px">
            <span>${m.role === 'owner' ? 'Owner' : 'Member'}${m.player_role ? ' · ' + m.player_role : ''}</span>
            ${m.teams.join_code ? `<span style="font-family:monospace;font-size:11px;font-weight:700;letter-spacing:2px;color:var(--accent);background:var(--surface);padding:1px 6px;border-radius:4px;border:1px solid var(--border)">${esc(m.teams.join_code)}</span>` : ''}
          </div>
        </div>
        <span style="color:var(--accent);font-size:12px">Enter →</span>
      </button>
    `).join('')

  el.querySelectorAll('[data-team-id]').forEach(btn => btn.addEventListener('click', () => {
    setTeamId(btn.dataset.teamId)
    window.location.href = 'dashboard.html'
  }))
}

// ── Join with code ─────────────────────────────────────────────
document.getElementById('join-btn').addEventListener('click', async () => {
  const code        = document.getElementById('f-join-code').value.trim().toUpperCase()
  const displayName = document.getElementById('f-join-display').value.trim()
  const nickname    = document.getElementById('f-join-nickname').value.trim()
  const errEl       = document.getElementById('join-error')

  if (!code)        { errEl.textContent = 'Enter a join code.';        errEl.style.display = 'block'; return }
  if (!displayName) { errEl.textContent = 'Display name is required.'; errEl.style.display = 'block'; return }
  errEl.style.display = 'none'

  const { data: team, error: findErr } = await supabase
    .from('teams')
    .select('id, name')
    .eq('join_code', code)
    .maybeSingle()

  if (findErr || !team) { errEl.textContent = 'Team not found. Check the code and try again.'; errEl.style.display = 'block'; return }

  const { error: memberErr } = await supabase
    .from('team_members')
    .insert({ team_id: team.id, user_id: userId, role: 'member' })

  if (memberErr && !memberErr.message.includes('duplicate')) {
    errEl.textContent = memberErr.message; errEl.style.display = 'block'; return
  }

  const { error: rosterErr } = await supabase.from('roster').upsert(
    { team_id: team.id, user_id: userId, username: displayName, nickname: nickname || null },
    { onConflict: 'team_id,user_id', ignoreDuplicates: false }
  )
  if (rosterErr) { errEl.textContent = `Roster error: ${rosterErr.message}`; errEl.style.display = 'block'; return }

  setTeamId(team.id)
  window.location.href = 'dashboard.html'
})

// ── Create team ────────────────────────────────────────────────
document.getElementById('create-btn').addEventListener('click', async () => {
  const teamName    = document.getElementById('f-team-name').value.trim()
  const displayName = document.getElementById('f-display-name').value.trim()
  const nickname    = document.getElementById('f-nickname').value.trim()
  const errEl       = document.getElementById('create-error')

  if (!teamName)    { errEl.textContent = 'Team name is required.';    errEl.style.display = 'block'; return }
  if (!displayName) { errEl.textContent = 'Display name is required.'; errEl.style.display = 'block'; return }
  errEl.style.display = 'none'

  let joinCode = generateCode()

  const { data: team, error: teamErr } = await supabase
    .from('teams')
    .insert({ name: teamName, owner_id: userId, join_code: joinCode })
    .select()
    .single()
  if (teamErr) { errEl.textContent = teamErr.message; errEl.style.display = 'block'; return }

  const { error: memberErr } = await supabase
    .from('team_members')
    .insert({ team_id: team.id, user_id: userId, role: 'owner' })
  if (memberErr) { errEl.textContent = memberErr.message; errEl.style.display = 'block'; return }

  const { error: rosterErr } = await supabase.from('roster').insert({
    team_id: team.id,
    user_id: userId,
    username: displayName,
    nickname: nickname || null,
  })
  if (rosterErr) { errEl.textContent = `Roster error: ${rosterErr.message}`; errEl.style.display = 'block'; return }

  setTeamId(team.id)
  window.location.href = 'dashboard.html'
})

document.getElementById('signout-btn').addEventListener('click', signOut)

loadTeams()
