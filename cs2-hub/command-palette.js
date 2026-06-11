// Command palette (Cmd-K / Ctrl-K) + keyboard shortcuts help (`?`).
//
// Mounted once per page via layout.js. Holds:
//   - palette modal: fuzzy-search over nav links, recent demos, and
//     quick actions. ↑/↓/Enter/ESC keyboard-only.
//   - shortcuts modal: cheat-sheet bound to `?` (shift + /).
//
// No external deps. esc() is colocated to avoid the global dedupe debt
// flagged in the audit — this module is loaded on every page.

import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

const NAV_LINKS = [
  { label: 'Dashboard',           href: 'dashboard.html',        keywords: 'home overview' },
  { label: 'Schedule',            href: 'schedule.html',         keywords: 'calendar events scrims' },
  { label: 'Stratbook',           href: 'stratbook.html',        keywords: 'strats setups defaults' },
  { label: 'Opponents',           href: 'opponents.html',        keywords: 'scouting opponent intel anti-strat antistrat' },
  { label: 'Map Veto',            href: 'veto.html',             keywords: 'simulator bo pickban' },
  { label: 'Scrim Finder',        href: 'scrim-finder.html',     keywords: 'practice partner listing board' },
  { label: 'Matches',             href: 'vods.html',             keywords: 'vods results reviews series record' },
  { label: 'Demos',               href: 'demos.html',            keywords: 'replays parser uploads' },
  { label: '2D Replay',           href: 'analysis.html',         keywords: 'analysis rounds heatmap filter viewer' },
  { label: 'Round Compare',       href: 'round-compare.html',    keywords: 'side by side diff demos' },
  { label: 'Roster',              href: 'roster.html',           keywords: 'players team members' },
  { label: 'Goals',               href: 'goals.html',            keywords: 'objectives milestones team' },
  { label: 'Issues',              href: 'issues.html',           keywords: 'tasks bugs todos' },
  { label: 'Keywords',            href: 'keywords.html',         keywords: 'callouts comms vocabulary' },
  { label: 'Switch Team',         href: 'team-select.html',      keywords: 'change team' },
]

const QUICK_ACTIONS = [
  { label: 'Upload demo',          href: 'demos.html#upload',     icon: '+', keywords: 'add new demo upload' },
  { label: 'Add strat',            href: 'stratbook.html#new',    icon: '+', keywords: 'create strat new' },
  { label: 'New event',            href: 'schedule.html#new',     icon: '+', keywords: 'create scrim tournament event' },
  { label: 'New goal',             href: 'goals.html#new',        icon: '+', keywords: 'add goal create' },
  { label: 'New issue',            href: 'issues.html#new',       icon: '+', keywords: 'log bug task' },
]

const SHORTCUTS = [
  { keys: ['?'],                 desc: 'Show keyboard shortcuts' },
  { keys: ['Ctrl', 'K'],         desc: 'Open command palette' },
  { keys: ['Esc'],               desc: 'Close any modal / dialog' },
  { keys: ['↑', '↓'],            desc: 'Navigate palette results' },
  { keys: ['Enter'],             desc: 'Open selected item' },
  { keys: ['G', 'D'],            desc: 'Go to Dashboard' },
  { keys: ['G', 'S'],            desc: 'Go to Schedule' },
  { keys: ['G', 'V'],            desc: 'Go to Matches' },
  { keys: ['G', 'M'],            desc: 'Go to Demos' },
  { keys: ['G', 'A'],            desc: 'Go to Analysis' },
  { keys: ['G', 'O'],            desc: 'Go to Opponents' },
  { keys: ['G', 'R'],            desc: 'Go to Roster' },
  // Demo viewer (only fire on demo-viewer.html but listed here for discovery)
  { keys: ['Space'],             desc: 'Demo viewer · play / pause' },
  { keys: ['←', '→'],            desc: 'Demo viewer · step ~0.5 s' },
  { keys: ['Shift', '←/→'],      desc: 'Demo viewer · step ~5 s' },
  { keys: ['[', ']'],            desc: 'Demo viewer · prev / next round' },
  { keys: ['F'],                 desc: 'Demo viewer · fullscreen' },
  { keys: ['D'],                 desc: 'Demo viewer · drawing mode' },
]

const VIM_NAV = {
  d: 'dashboard.html',
  s: 'schedule.html',
  v: 'vods.html',
  m: 'demos.html',
  a: 'analysis.html',
  o: 'opponents.html',
  r: 'roster.html',
  g: 'goals.html',
  i: 'issues.html',
  k: 'keywords.html',
  t: 'stratbook.html',
}

const RECENT_LS_KEY = 'palette:recent'
function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_LS_KEY) || '[]') } catch { return [] }
}
function pushRecent(item) {
  try {
    const list = loadRecent().filter(x => x.href !== item.href)
    list.unshift({ ...item, ts: Date.now() })
    localStorage.setItem(RECENT_LS_KEY, JSON.stringify(list.slice(0, 8)))
  } catch {}
}

function fuzzyMatch(q, text) {
  if (!q) return 1
  q = q.toLowerCase()
  text = text.toLowerCase()
  if (text.includes(q)) return 2 + (text.startsWith(q) ? 1 : 0)
  // tolerate one missing character / transposition: simple subsequence match
  let i = 0
  for (const ch of text) {
    if (ch === q[i]) i++
    if (i === q.length) return 1
  }
  return 0
}

let paletteEl = null
let shortcutsEl = null
let paletteOpen = false
let shortcutsOpen = false
let currentResults = []
let activeIdx = 0
let recentDemos = []

async function loadRecentDemosForPalette() {
  const teamId = getTeamId()
  if (!teamId) return
  try {
    const { data } = await supabase
      .from('demos')
      .select('id, map, opponent_name, played_at, created_at')
      .eq('team_id', teamId)
      .order('created_at', { ascending: false })
      .limit(8)
    recentDemos = (data ?? []).map(d => ({
      label: `${d.opponent_name ?? 'Demo'} · ${d.map ?? '?'}`,
      href: `demo-viewer.html?id=${d.id}`,
      sub: d.played_at ? new Date(d.played_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '',
      keywords: `${d.opponent_name ?? ''} ${d.map ?? ''}`,
      kind: 'demo',
    }))
  } catch {
    recentDemos = []
  }
}

function buildResults(query) {
  const all = [
    ...QUICK_ACTIONS.map(x => ({ ...x, kind: 'action' })),
    ...NAV_LINKS.map(x => ({ ...x, kind: 'nav' })),
    ...recentDemos,
    ...loadRecent().map(x => ({ ...x, kind: 'recent' })),
  ]
  const scored = all
    .map(item => ({
      item,
      score: fuzzyMatch(query, `${item.label} ${item.keywords ?? ''}`),
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
  // De-dupe by href
  const seen = new Set()
  return scored.filter(x => {
    if (seen.has(x.item.href)) return false
    seen.add(x.item.href)
    return true
  }).slice(0, 12).map(x => x.item)
}

function ensurePaletteEl() {
  if (paletteEl) return paletteEl
  paletteEl = document.createElement('div')
  paletteEl.className = 'cmdk-backdrop'
  paletteEl.setAttribute('role', 'dialog')
  paletteEl.setAttribute('aria-modal', 'true')
  paletteEl.setAttribute('aria-label', 'Command palette')
  paletteEl.style.display = 'none'
  paletteEl.innerHTML = `
    <div class="cmdk-modal">
      <input class="cmdk-input" type="text" autocomplete="off" spellcheck="false" placeholder="Search pages, demos, actions…" aria-label="Search">
      <div class="cmdk-results" role="listbox"></div>
      <div class="cmdk-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>Enter</kbd> open</span>
        <span><kbd>Esc</kbd> close</span>
        <span class="cmdk-footer-spacer"></span>
        <span><kbd>?</kbd> all shortcuts</span>
      </div>
    </div>`
  document.body.appendChild(paletteEl)

  const input = paletteEl.querySelector('.cmdk-input')
  const list  = paletteEl.querySelector('.cmdk-results')

  function render() {
    if (!currentResults.length) {
      list.innerHTML = `<div class="cmdk-empty">No matches.</div>`
      return
    }
    list.innerHTML = currentResults.map((r, i) => `
      <div class="cmdk-row ${i === activeIdx ? 'cmdk-row-active' : ''}" data-idx="${i}" role="option" aria-selected="${i === activeIdx}">
        <span class="cmdk-row-icon cmdk-row-icon-${r.kind}">${r.icon ?? (r.kind === 'demo' ? '◍' : r.kind === 'recent' ? '↩' : '→')}</span>
        <span class="cmdk-row-label">${esc(r.label)}</span>
        ${r.sub ? `<span class="cmdk-row-sub">${esc(r.sub)}</span>` : ''}
        <span class="cmdk-row-kind">${r.kind}</span>
      </div>
    `).join('')
    list.querySelectorAll('.cmdk-row').forEach(el => {
      el.addEventListener('mousemove', () => { activeIdx = Number(el.dataset.idx); render() })
      el.addEventListener('click', () => choose(currentResults[Number(el.dataset.idx)]))
    })
  }

  function choose(item) {
    if (!item) return
    pushRecent({ label: item.label, href: item.href })
    closePalette()
    window.location.href = item.href
  }

  function refresh() {
    currentResults = buildResults(input.value.trim())
    activeIdx = 0
    render()
  }
  input.addEventListener('input', refresh)

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, currentResults.length - 1); render() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); render() }
    else if (e.key === 'Enter') { e.preventDefault(); choose(currentResults[activeIdx]) }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette() }
  })

  paletteEl.addEventListener('click', e => {
    if (e.target === paletteEl) closePalette()
  })

  paletteEl._refresh = refresh
  return paletteEl
}

function openPalette() {
  ensurePaletteEl()
  paletteEl.style.display = 'flex'
  paletteOpen = true
  const input = paletteEl.querySelector('.cmdk-input')
  input.value = ''
  paletteEl._refresh()
  // small delay so the open animation gets to play before focus snaps
  requestAnimationFrame(() => input.focus())
  document.body.classList.add('cmdk-open')
}

function closePalette() {
  if (!paletteEl) return
  paletteEl.style.display = 'none'
  paletteOpen = false
  document.body.classList.remove('cmdk-open')
}

function ensureShortcutsEl() {
  if (shortcutsEl) return shortcutsEl
  shortcutsEl = document.createElement('div')
  shortcutsEl.className = 'shortcuts-backdrop'
  shortcutsEl.setAttribute('role', 'dialog')
  shortcutsEl.setAttribute('aria-modal', 'true')
  shortcutsEl.setAttribute('aria-label', 'Keyboard shortcuts')
  shortcutsEl.style.display = 'none'
  shortcutsEl.innerHTML = `
    <div class="shortcuts-modal">
      <div class="shortcuts-header">
        <div class="shortcuts-title">Keyboard shortcuts</div>
        <button class="shortcuts-close" aria-label="Close">×</button>
      </div>
      <div class="shortcuts-list">
        ${SHORTCUTS.map(s => `
          <div class="shortcut-row">
            <div class="shortcut-desc">${esc(s.desc)}</div>
            <div class="shortcut-keys">${s.keys.map(k => `<kbd>${esc(k)}</kbd>`).join('<span class="shortcut-plus">+</span>')}</div>
          </div>
        `).join('')}
      </div>
    </div>`
  document.body.appendChild(shortcutsEl)
  shortcutsEl.querySelector('.shortcuts-close').addEventListener('click', closeShortcuts)
  shortcutsEl.addEventListener('click', e => { if (e.target === shortcutsEl) closeShortcuts() })
  return shortcutsEl
}
function openShortcuts() {
  ensureShortcutsEl()
  shortcutsEl.style.display = 'flex'
  shortcutsOpen = true
}
function closeShortcuts() {
  if (!shortcutsEl) return
  shortcutsEl.style.display = 'none'
  shortcutsOpen = false
}

// `g d` style vim navigation — pressing g, then a key within 800ms.
let pendingG = null
function clearG() { pendingG = null }

function isEditable(el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function initCommandPalette() {
  if (window.__cmdkInstalled) return
  window.__cmdkInstalled = true
  loadRecentDemosForPalette()

  document.addEventListener('keydown', e => {
    // Cmd/Ctrl+K — open palette anywhere
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      paletteOpen ? closePalette() : openPalette()
      return
    }

    // ESC closes both
    if (e.key === 'Escape') {
      if (paletteOpen) { closePalette(); return }
      if (shortcutsOpen) { closeShortcuts(); return }
    }

    // While typing in an input, suppress single-key handlers.
    if (isEditable(e.target)) return

    // `?` → shortcuts cheatsheet
    if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      shortcutsOpen ? closeShortcuts() : openShortcuts()
      return
    }

    // vim-style `g <key>` navigation
    if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      pendingG = setTimeout(clearG, 800)
      return
    }
    if (pendingG) {
      clearTimeout(pendingG); pendingG = null
      const dest = VIM_NAV[e.key.toLowerCase()]
      if (dest) {
        e.preventDefault()
        window.location.href = dest
      }
    }
  })
}
