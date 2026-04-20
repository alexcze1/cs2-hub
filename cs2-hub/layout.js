import { signOut } from './auth.js'
import { supabase, getTeamId } from './supabase.js'

export async function renderSidebar(activePage) {
  const sidebar = document.getElementById('sidebar')
  if (!sidebar) return

  let teamName = 'MIDROUND'
  const teamId = getTeamId()
  if (teamId) {
    const { data: team } = await supabase.from('teams').select('name').eq('id', teamId).single()
    if (team) teamName = team.name.toUpperCase()
  }

  const links = [
    { id: 'dashboard',  label: 'Dashboard',   href: 'dashboard.html',  section: 'MAIN' },
    { id: 'schedule',   label: 'Schedule',    href: 'schedule.html' },
    { id: 'stratbook',  label: 'Stratbook',   href: 'stratbook.html',  section: 'TOOLS' },
    { id: 'vods',       label: 'VOD Review',  href: 'vods.html' },
    { id: 'opponents',  label: 'Opponents',   href: 'opponents.html' },
    { id: 'veto',       label: 'Map Veto',    href: 'veto.html' },
    { id: 'keywords',   label: 'Keywords',    href: 'keywords.html' },
    { id: 'goals',      label: 'Team Goals',  href: 'goals.html' },
    { id: 'issues',     label: 'Issues',      href: 'issues.html' },
    { id: 'roster',     label: 'Roster',      href: 'roster.html',     section: 'TEAM' },
  ]

  let html = `
    <div class="sidebar-brand">
      <img src="images/logo-icon.png" alt="MIDROUND" class="sidebar-logo-img"/>
      <div class="team-name">${esc(teamName)}</div>
    </div>`

  for (const link of links) {
    if (link.section) html += `<div class="nav-section">${link.section}</div>`
    html += `<a class="nav-item ${activePage === link.id ? 'active' : ''}" href="${link.href}">${link.label}</a>`
  }

  html += `<div style="flex:1"></div>`
  html += `<a class="nav-item" href="team-select.html" style="font-size:11px;color:var(--muted)">Switch Team</a>`
  html += `<button class="nav-item" id="signout-btn">Sign Out</button>`

  sidebar.innerHTML = html
  document.getElementById('signout-btn').addEventListener('click', signOut)
}

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
