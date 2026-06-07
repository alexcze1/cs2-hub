// Team presence — joins a Supabase realtime channel scoped per team and
// renders a tiny "online now" list in the sidebar. Each tab broadcasts
// its own auth user; presenceState gives us everyone tracking the same
// channel. Cheap social glue: coaches can tell at a glance who's around.
//
// Renders into #sidebar-presence-slot if layout.js mounted it. No-op if
// the slot isn't on the page (e.g. team-select / login pages where the
// sidebar isn't rendered).

import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

let channel = null

export async function initPresence() {
  if (window.__presenceInstalled) return
  window.__presenceInstalled = true

  const teamId = getTeamId()
  if (!teamId) return

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  // Resolve a display nickname — prefer roster.nickname for the
  // signed-in user, fall back to the email local part. Best-effort,
  // failure just shows "Player".
  let myNickname = 'Player'
  try {
    const { data: rosterMe } = await supabase
      .from('roster')
      .select('nickname')
      .eq('team_id', teamId)
      .eq('user_id', user.id)
      .maybeSingle()
    myNickname = rosterMe?.nickname || user.email?.split('@')[0] || 'Player'
  } catch {
    myNickname = user.email?.split('@')[0] || 'Player'
  }

  // Tidy up any previous channel on hot navigations (SPA-style users
  // who never hard-reload — currently we DO hard-reload between pages,
  // but the guard is cheap insurance for future SPA work).
  if (channel) { try { await supabase.removeChannel(channel) } catch {} }

  channel = supabase.channel(`presence:team:${teamId}`, {
    config: { presence: { key: user.id } },
  })

  channel.on('presence', { event: 'sync' }, () => {
    const state = channel.presenceState()
    render(state, user.id)
  })

  channel.subscribe(async status => {
    if (status !== 'SUBSCRIBED') return
    try {
      await channel.track({
        user_id:  user.id,
        nickname: myNickname,
        joined_at: new Date().toISOString(),
      })
    } catch {}
  })

  // Drop our presence cleanly when the tab closes so others don't see
  // a ghost for the next ~30 s while the server times out.
  window.addEventListener('beforeunload', () => {
    try { channel?.untrack() } catch {}
    try { supabase.removeChannel(channel) } catch {}
  })
}

function render(state, myId) {
  const slot = document.getElementById('sidebar-presence-slot')
  if (!slot) return

  // Each presence key (user_id) holds an array of meta objects (one per
  // tab). De-dupe to one entry per user, prioritising the most recent
  // joined_at if it ever matters.
  const byUser = new Map()
  for (const [uid, metas] of Object.entries(state)) {
    const meta = metas?.[0]
    if (!meta) continue
    byUser.set(uid, meta)
  }
  const others = [...byUser.entries()].filter(([uid]) => uid !== myId)
  const total  = byUser.size

  if (total <= 1) {
    slot.innerHTML = `
      <div class="presence-row presence-row-alone">
        <span class="presence-dot presence-dot-self"></span>
        <span class="presence-label">Just you</span>
      </div>`
    return
  }

  const MAX_SHOWN = 4
  const visible = others.slice(0, MAX_SHOWN)
  const overflow = others.length - visible.length

  slot.innerHTML = `
    <div class="presence-row">
      <span class="presence-dot"></span>
      <span class="presence-label">${total} online</span>
    </div>
    <div class="presence-list">
      ${visible.map(([uid, meta]) => `
        <div class="presence-item" title="${esc(meta.nickname || 'Player')}">
          <span class="presence-avatar">${esc((meta.nickname || '?').slice(0, 2).toUpperCase())}</span>
          <span class="presence-name">${esc(meta.nickname || 'Player')}</span>
        </div>`).join('')}
      ${overflow > 0 ? `<div class="presence-item presence-overflow">+${overflow}</div>` : ''}
    </div>`
}
