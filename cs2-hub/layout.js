import { signOut, isAdmin } from './auth.js'
import { supabase, getTeamId } from './supabase.js'
import { initCommandPalette } from './command-palette.js'
import { initHoverPreview } from './hover-preview.js'
import { initPresence } from './presence.js'
import { initTooltips } from './tooltip.js'
import { countUp } from './charts.js'
import { initPixelFields } from './pixel-field.js'

// One-time chrome installation: PWA manifest link, service-worker
// registration, command palette + keyboard shortcuts. Idempotent — every
// page calls renderSidebar() which runs this once.
function installChrome() {
  if (window.__chromeInstalled) return
  window.__chromeInstalled = true

  // Theme + density applied at chrome-install time so the right palette
  // is up before sidebar/render. Same keys as the dashboard toggles.
  try {
    const theme = localStorage.getItem('dash:theme') || 'dark'
    document.body.setAttribute('data-theme', theme)
  } catch {}
  try {
    const density = localStorage.getItem('dash:density') || 'comfortable'
    document.body.setAttribute('data-density', density)
  } catch {}
  try {
    const mode = localStorage.getItem('dash:mode') || 'coach'
    document.body.setAttribute('data-mode', mode)
  } catch {}

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

  // Generative pixel-marble fields on hero cards + empty states.
  initPixelFields()

  // Hover preview cards for [data-preview-demo] / [data-preview-vod].
  initHoverPreview()

  // Custom tooltip layer for [data-tip].
  initTooltips()

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

// Unified tool-page header. Every list/tool page renders its title block
// through this so the title scale, kicker, subtitle, KPI chips and action
// placement are identical app-wide. `kpis` is [{ k, v, tone? }] where tone
// is '' | 'good' | 'warn' | 'bad'. `actions` is an HTML string (buttons keep
// their ids so existing wiring works).
export function renderToolHeader(el, { section = '', title = '', sub = '', kpis = [], actions = '' } = {}) {
  if (!el) return
  const chips = kpis
    .filter(k => k && k.v !== undefined && k.v !== null)
    .map(k => `
      <div class="kpi-chip ${k.tone ? `kpi-${k.tone}` : ''}">
        <span class="kpi-chip-v">${esc(String(k.v))}</span>
        <span class="kpi-chip-k">${esc(k.k)}</span>
      </div>`).join('')
  el.innerHTML = `
    <div class="tool-head">
      <div class="tool-head-top">
        <div class="tool-head-text">
          ${section ? `<div class="tool-head-kicker">${esc(section)}</div>` : ''}
          <h1 class="tool-head-title">${esc(title)}</h1>
          ${sub ? `<div class="tool-head-sub">${esc(sub)}</div>` : ''}
        </div>
        ${actions ? `<div class="tool-head-actions">${actions}</div>` : ''}
      </div>
      ${chips ? `<div class="tool-head-kpis">${chips}</div>` : ''}
    </div>`
  // Animated count-up on numeric KPI values — only on the first render per
  // page load so re-renders (filter changes etc.) don't replay it.
  if (!el.dataset.kpiAnimated) {
    el.dataset.kpiAnimated = '1'
    for (const v of el.querySelectorAll('.kpi-chip-v')) countUp(v)
  }
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
  scrim:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  compare:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>`,
  settings:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
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
    { id: 'dashboard',     label: 'Dashboard',     href: 'dashboard.html',     icon: ICONS.dashboard, section: 'OVERVIEW' },
    { id: 'schedule',      label: 'Schedule',      href: 'schedule.html',      icon: ICONS.schedule },
    { id: 'stratbook',     label: 'Stratbook',     href: 'stratbook.html',     icon: ICONS.stratbook, section: 'PREPARATION' },
    { id: 'opponents',     label: 'Opponents',     href: 'opponents.html',     icon: ICONS.opponents },
    { id: 'veto',          label: 'Map Veto',      href: 'veto.html',          icon: ICONS.veto },
    { id: 'scrim-finder',  label: 'Scrim Finder',  href: 'scrim-finder.html',  icon: ICONS.scrim },
    { id: 'vods',          label: 'Matches',       href: 'vods.html',          icon: ICONS.vods,      section: 'REVIEW' },
    { id: 'demos',         label: 'Demos',         href: 'demos.html',         icon: ICONS.demos },
    { id: 'analysis',      label: '2D Replay',     href: 'analysis.html',      icon: ICONS.analysis },
    { id: 'round-compare', label: 'Round Compare', href: 'round-compare.html', icon: ICONS.compare },
    { id: 'roster',        label: 'Roster',        href: 'roster.html',        icon: ICONS.roster,    section: 'TEAM' },
    { id: 'goals',         label: 'Goals',         href: 'goals.html',         icon: ICONS.goals },
    { id: 'issues',        label: 'Issues',        href: 'issues.html',        icon: ICONS.issues },
    { id: 'keywords',      label: 'Keywords',      href: 'keywords.html',      icon: ICONS.keywords },
    ...(isAdmin(user) ? [{ id: 'admin', label: 'Admin', href: 'admin.html', icon: adminIcon, section: 'ADMIN' }] : []),
  ]

  let html = `
    <div class="sidebar-brand">
      <div class="sidebar-logo-img" aria-label="MIDROUND">MIDROUND</div>
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
    <div class="presence-slot" id="sidebar-presence-slot"></div>
    <a class="nav-item nav-item-footer" href="team-select.html"><span class="nav-icon">${ICONS.switch}</span>Switch Team</a>
    <button class="nav-item nav-item-footer" id="prefs-btn" aria-haspopup="true" aria-expanded="false"><span class="nav-icon">${ICONS.settings}</span>Preferences</button>
    <button class="nav-item nav-item-footer" id="signout-btn"><span class="nav-icon">${ICONS.signout}</span>Sign Out</button>
  </div>`

  sidebar.innerHTML = html
  document.getElementById('signout-btn').addEventListener('click', signOut)
  installPrefsPopover()

  // Realtime team presence — joins a per-team channel and renders the
  // "online now" list into #sidebar-presence-slot above.
  initPresence().catch(e => console.warn('[presence] init failed', e))
}

// ── Preferences popover ──────────────────────────────────────────────
// App-wide appearance settings (theme / density / coach-player view),
// reachable from the sidebar footer on every page. Values persist in the
// same localStorage keys installChrome() reads at boot, and apply live by
// setting the matching <body> attribute.
const PREFS = [
  { key: 'dash:theme',   attr: 'data-theme',   label: 'Theme',   options: [['dark', 'Dark'], ['light', 'Light']] },
  { key: 'dash:density', attr: 'data-density', label: 'Density', options: [['comfortable', 'Comfy'], ['compact', 'Compact']] },
  { key: 'dash:mode',    attr: 'data-mode',    label: 'View',    options: [['coach', 'Coach'], ['player', 'Player']] },
]

function installPrefsPopover() {
  const btn = document.getElementById('prefs-btn')
  if (!btn || document.getElementById('prefs-popover')) {
    if (btn && document.getElementById('prefs-popover')) wirePrefsToggle(btn)
    return
  }

  const pop = document.createElement('div')
  pop.id = 'prefs-popover'
  pop.className = 'prefs-popover'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', 'Preferences')
  pop.hidden = true

  const current = pref => {
    try { return localStorage.getItem(pref.key) || pref.options[0][0] } catch { return pref.options[0][0] }
  }

  pop.innerHTML = `
    <div class="prefs-popover-title">Preferences</div>
    ${PREFS.map(p => `
      <div class="pref-row">
        <span class="pref-label">${p.label}</span>
        <div class="pref-seg" data-key="${p.key}" data-attr="${p.attr}" role="group" aria-label="${p.label}">
          ${p.options.map(([val, lab]) => `
            <button type="button" class="pref-seg-btn ${current(p) === val ? 'is-active' : ''}" data-val="${val}">${lab}</button>
          `).join('')}
        </div>
      </div>`).join('')}`
  document.body.appendChild(pop)

  pop.addEventListener('click', e => {
    const b = e.target.closest('.pref-seg-btn')
    if (!b) return
    const seg = b.closest('.pref-seg')
    try { localStorage.setItem(seg.dataset.key, b.dataset.val) } catch {}
    document.body.setAttribute(seg.dataset.attr, b.dataset.val)
    seg.querySelectorAll('.pref-seg-btn').forEach(x => x.classList.toggle('is-active', x === b))
  })

  wirePrefsToggle(btn)
}

function wirePrefsToggle(btn) {
  if (btn.dataset.prefsWired) return
  btn.dataset.prefsWired = '1'
  const pop = () => document.getElementById('prefs-popover')

  function setOpen(v) {
    const p = pop()
    if (!p) return
    p.hidden = !v
    btn.setAttribute('aria-expanded', v ? 'true' : 'false')
    if (v) {
      // Anchor just above the footer button, aligned to the sidebar edge.
      const r = btn.getBoundingClientRect()
      p.style.left = `${Math.max(8, r.left)}px`
      p.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`
    }
  }

  btn.addEventListener('click', e => {
    e.stopPropagation()
    setOpen(pop()?.hidden !== false ? true : false)
  })
  document.addEventListener('click', e => {
    const p = pop()
    if (p && !p.hidden && !p.contains(e.target) && e.target !== btn) setOpen(false)
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') setOpen(false)
  })
}

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }
