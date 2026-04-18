// cs2-hub/layout.js
import { signOut } from './auth.js'

export function renderSidebar(activePage) {
  const sidebar = document.getElementById('sidebar')
  if (!sidebar) return

  const links = [
    { id: 'dashboard',  label: 'Dashboard',   href: 'dashboard.html',  section: 'MAIN' },
    { id: 'schedule',   label: 'Schedule',    href: 'schedule.html' },
    { id: 'stratbook',  label: 'Stratbook',   href: 'stratbook.html',  section: 'TOOLS' },
    { id: 'vods',       label: 'VOD Review',  href: 'vods.html' },
    { id: 'opponents',  label: 'Opponents',   href: 'opponents.html' },
    { id: 'roster',     label: 'Roster',      href: 'roster.html',     section: 'TEAM' },
  ]

  let html = `<div class="team-name">⚡ YOUR TEAM</div>`

  for (const link of links) {
    if (link.section) html += `<div class="nav-section">${link.section}</div>`
    html += `<a class="nav-item ${activePage === link.id ? 'active' : ''}" href="${link.href}">${link.label}</a>`
  }

  html += `<div style="flex:1"></div>`
  html += `<button class="nav-item" id="signout-btn">Sign Out</button>`

  sidebar.innerHTML = html
  document.getElementById('signout-btn').addEventListener('click', signOut)
}
