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
    { id: 'dashboard',  label: 'Dashboard',        href: 'dashboard.html',  icon: '⌂',  section: 'MAIN' },
    { id: 'schedule',   label: 'Schedule',          href: 'schedule.html',   icon: '⊡' },
    { id: 'stratbook',  label: 'Stratbook',         href: 'stratbook.html',  icon: '▤',  section: 'TOOLS' },
    { id: 'vods',       label: 'Results & Review',  href: 'vods.html',       icon: '⊙' },
    { id: 'opponents',  label: 'Anti-Strat',        href: 'opponents.html',  icon: '⊕' },
    { id: 'veto',       label: 'Map Veto',          href: 'veto.html',       icon: '⬡' },
    { id: 'keywords',   label: 'Keywords',          href: 'keywords.html',   icon: '#' },
    { id: 'goals',      label: 'Team Goals',        href: 'goals.html',      icon: '◎' },
    { id: 'issues',     label: 'Issues',            href: 'issues.html',     icon: '⚠' },
    { id: 'roster',     label: 'Roster',            href: 'roster.html',     icon: '⊛', section: 'TEAM' },
  ]

  let html = `
    <div class="sidebar-brand">
      <img src="images/logo-lettering.png" alt="MIDROUND" class="sidebar-logo-img"/>
      <div class="team-name">${esc(teamName)}</div>
    </div>`

  for (const link of links) {
    if (link.section) html += `<div class="nav-section">${link.section}</div>`
    html += `<a class="nav-item ${activePage === link.id ? 'active' : ''}" href="${link.href}">
      <span class="nav-icon">${link.icon}</span>${link.label}
    </a>`
  }

  html += `<div style="flex:1"></div>`
  html += `<div class="sidebar-footer">
    <a class="nav-item nav-item-footer" href="team-select.html"><span class="nav-icon">⇄</span>Switch Team</a>
    <button class="nav-item nav-item-footer" id="signout-btn"><span class="nav-icon">→</span>Sign Out</button>
  </div>`

  sidebar.innerHTML = html
  document.getElementById('signout-btn').addEventListener('click', signOut)
}

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
