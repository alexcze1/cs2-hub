import { signOut, isAdmin } from './auth.js'
import { supabase, getTeamId } from './supabase.js'
import { initCommandPalette } from './command-palette.js'
import { initHoverPreview } from './hover-preview.js'

// One-time chrome installation: PWA manifest link, service-worker
// registration, command palette + keyboard shortcuts. Idempotent — every
// page calls renderSidebar() which runs this once.
function installChrome() {
  if (window.__chromeInstalled) return
  window.__chromeInstalled = true

  // Manifest <link> — injected so individual HTML pages don't need to
  // reference it. Same goes for theme-color.
  if (!document.querySelector('link[rel="manifest"]')) {
    const link = document.createElement('link')
    link.rel = 'manifest'
    link.href = 'manifest.json'
    document.head.appendChild(link)
  }
  if (!document.querySelector('meta[name="theme-color"]')) {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = '#8B6DFF'
    document.head.appendChild(meta)
  }

  // Service worker. Only on https or localhost; ignore failures silently
  // (a missing sw.js on a stale Vercel deploy must not break the page).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {})
    })
  }

  // Command palette + keyboard shortcuts (Cmd-K, ?, g-d, etc.)
  initCommandPalette()

  // Hover preview cards for [data-preview-demo] / [data-preview-vod].
  initHoverPreview()

  installMobileChrome()
}

// Mobile slide-out sidebar trigger + backdrop. Injected once per page;
// the CSS in style.css hides the toggle and backdrop above 880px so
// desktop is unaffected.
function installMobileChrome() {
  if (document.getElementById('mobile-menu-toggle')) return

  const toggle = document.createElement('button')
  toggle.id = 'mobile-menu-toggle'
  toggle.className = 'mobile-menu-toggle'
  toggle.setAttribute('aria-label', 'Toggle navigation')
  toggle.setAttribute('aria-controls', 'sidebar')
  toggle.innerHTML = `
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="3" y1="6"  x2="21" y2="6"/>
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>`
  document.body.appendChild(toggle)

  const backdrop = document.createElement('div')
  backdrop.className = 'mobile-sidebar-backdrop'
  document.body.appendChild(backdrop)

  function setOpen(v) {
    document.body.setAttribute('data-sidebar', v ? 'open' : 'closed')
    toggle.setAttribute('aria-expanded', v ? 'true' : 'false')
  }
  setOpen(false)

  toggle.addEventListener('click', () => {
    const isOpen = document.body.getAttribute('data-sidebar') === 'open'
    setOpen(!isOpen)
  })
  backdrop.addEventListener('click', () => setOpen(false))
  // Close on nav click — links inside the sidebar should always retreat
  // the drawer so the user lands on the new page with chrome reset.
  document.addEventListener('click', e => {
    if (e.target.closest?.('.sidebar a.nav-item')) setOpen(false)
  })
  // Close on ESC if the palette/shortcuts aren't already eating it.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.getAttribute('data-sidebar') === 'open') {
      setOpen(false)
    }
  })
  // Close automatically when crossing back above the breakpoint.
  const mq = window.matchMedia('(min-width: 881px)')
  mq.addEventListener?.('change', e => { if (e.matches) setOpen(false) })
}

// Breadcrumb helper for detail pages. Pass an array of { label, href? }.
// Last item is treated as the current page (rendered as plain text).
//
// Example:
//   renderBreadcrumb([
//     { label: 'Demos', href: 'demos.html' },
//     { label: 'Demo vs Spirit · Inferno' },
//   ])
export function renderBreadcrumb(items, mountId = 'breadcrumb-slot') {
  const slot = document.getElementById(mountId)
  if (!slot || !items?.length) return
  slot.innerHTML = `
    <nav class="breadcrumb-trail" aria-label="Breadcrumb">
      ${items.map((it, i) => {
        const isLast = i === items.length - 1
        const sep = i > 0 ? `<span class="breadcrumb-sep" aria-hidden="true">/</span>` : ''
        const label = `<span class="breadcrumb-label">${esc(it.label)}</span>`
        const inner = !isLast && it.href
          ? `<a class="breadcrumb-link" href="${esc(it.href)}">${label}</a>`
          : `<span class="breadcrumb-current" aria-current="page">${label}</span>`
        return `${sep}${inner}`
      }).join('')}
    </nav>`
}

const ICONS = {
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  schedule:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></svg>`,
  stratbook: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
  vods:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  demos: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
  analysis:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/><circle cx="7" cy="14" r="1.4"/><circle cx="11" cy="10" r="1.4"/><circle cx="15" cy="14" r="1.4"/><circle cx="20" cy="9" r="1.4"/></svg>`,
  opponents: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/><circle cx="12" cy="12" r="3"/></svg>`,
  veto:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>`,
  keywords:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>`,
  goals:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`,
  issues:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  roster:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  switch:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>`,
  signout:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
}

export async function renderSidebar(activePage) {
  installChrome()
  const sidebar = document.getElementById('sidebar')
  if (!sidebar) return

  let teamName = 'MIDROUND'
  const teamId = getTeamId()
  if (teamId) {
    const { data: team } = await supabase.from('teams').select('name').eq('id', teamId).single()
    if (team) teamName = team.name.toUpperCase()
  }

  const adminIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`

  const { data: { user } } = await supabase.auth.getUser()

  const links = [
    { id: 'dashboard',  label: 'Dashboard',        href: 'dashboard.html',  icon: ICONS.dashboard,  section: 'MAIN' },
    { id: 'schedule',   label: 'Schedule',          href: 'schedule.html',   icon: ICONS.schedule },
    { id: 'stratbook',  label: 'Stratbook',         href: 'stratbook.html',  icon: ICONS.stratbook,  section: 'TOOLS' },
    { id: 'vods',       label: 'Results & Review',  href: 'vods.html',       icon: ICONS.vods },
    { id: 'demos', label: 'Demos', href: 'demos.html', icon: ICONS.demos },
    { id: 'analysis', label: 'Analysis', href: 'analysis.html', icon: ICONS.analysis },
    { id: 'opponents',  label: 'Anti-Strat',        href: 'opponents.html',  icon: ICONS.opponents },
    { id: 'veto',       label: 'Map Veto',          href: 'veto.html',       icon: ICONS.veto },
    { id: 'keywords',   label: 'Keywords',          href: 'keywords.html',   icon: ICONS.keywords },
    { id: 'goals',      label: 'Team Goals',        href: 'goals.html',      icon: ICONS.goals },
    { id: 'issues',     label: 'Issues',            href: 'issues.html',     icon: ICONS.issues },
    { id: 'roster',     label: 'Roster',            href: 'roster.html',     icon: ICONS.roster,     section: 'TEAM' },
    ...(isAdmin(user) ? [{ id: 'admin', label: 'Admin', href: 'admin.html', icon: adminIcon, section: 'ADMIN' }] : []),
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

  // Recent items — populated by the command palette as the user opens
  // pages and demos. Pinned to the bottom of the nav so it sits just
  // above the footer chrome. Capped at 4 entries to keep the sidebar
  // skim-able.
  try {
    const recents = JSON.parse(localStorage.getItem('palette:recent') || '[]').slice(0, 4)
    if (recents.length) {
      html += `<div class="nav-section">RECENT</div>`
      for (const r of recents) {
        if (!r?.href || !r?.label) continue
        html += `<a class="nav-item nav-item-recent" href="${esc(r.href)}" title="${esc(r.label)}">
          <span class="nav-icon nav-icon-recent">↩</span>
          <span class="nav-item-label-truncate">${esc(r.label)}</span>
        </a>`
      }
    }
  } catch {}

  html += `<div style="flex:1"></div>`
  html += `<div class="sidebar-footer">
    <a class="nav-item nav-item-footer" href="team-select.html"><span class="nav-icon">${ICONS.switch}</span>Switch Team</a>
    <button class="nav-item nav-item-footer" id="signout-btn"><span class="nav-icon">${ICONS.signout}</span>Sign Out</button>
  </div>`

  sidebar.innerHTML = html
  document.getElementById('signout-btn').addEventListener('click', signOut)
}

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
