// Shared HLTV team autocomplete — attach to any text input.
//
// We MERGE two sources so lower-tier teams (which the daily refresh's
// top-30 scope misses) still get their logo:
//   1. `hltv_teams` Supabase table — fresh, daily-refreshed, top-30 only.
//   2. Bundled `hltv-teams.json` — hundreds of teams captured once, may be
//      stale on logo URLs but covers the long tail.
// DB entries win on collisions (case-insensitive name match), so a team
// renamed/rebranded since the JSON was captured still resolves to the
// current logo when it makes the top 30.

import { supabase } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

let _teams = null

async function loadTeams() {
  if (_teams) return _teams

  const [dbTeams, jsonTeams] = await Promise.all([
    (async () => {
      try {
        const { data, error } = await supabase
          .from('hltv_teams')
          .select('id, name, logo_url, rank')
          .order('rank', { ascending: true, nullsFirst: false })
        if (error) throw error
        return (data ?? []).map(t => ({ id: t.id, name: t.name, logo: t.logo_url, rank: t.rank }))
      } catch (e) {
        console.warn('[team-autocomplete] DB load failed:', e)
        return []
      }
    })(),
    (async () => {
      try { return await (await fetch('hltv-teams.json')).json() }
      catch { return [] }
    })(),
  ])

  // Merge keyed on lowercased name. DB wins; JSON fills the long tail.
  const byName = new Map()
  for (const t of jsonTeams) {
    if (t?.name) byName.set(t.name.toLowerCase(), t)
  }
  for (const t of dbTeams) {
    if (t?.name) byName.set(t.name.toLowerCase(), t)
  }
  _teams = [...byName.values()]
  return _teams
}

export async function getTeamLogo(name) {
  const teams = await loadTeams()
  const match = teams.find(t => t.name.toLowerCase() === name?.toLowerCase())
  return match?.logo ?? null
}

export function teamLogoEl(logo, name, size = 40) {
  if (logo) {
    // Only same-origin or HTTPS image URLs are safe to render. HLTV logos are
    // sourced from img-cdn.hltv.org; reject anything else (e.g. a poisoned
    // hltv_teams row that points at `javascript:` or `data:`) to keep this from
    // becoming an XSS sink via crafted team names/logos.
    const safeLogo = /^https:\/\//i.test(logo) ? logo : ''
    if (safeLogo) {
      return `<img src="${esc(safeLogo)}" alt="${esc(name)}" style="width:${size}px;height:${size}px;object-fit:contain;border-radius:6px;background:var(--surface);padding:3px;flex-shrink:0">`
    }
  }
  const abbr = String(name ?? '???').slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, '') || '???'
  return `<div style="width:${size}px;height:${size}px;background:var(--border);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--accent);font-size:${Math.round(size * 0.28)}px;font-weight:700;flex-shrink:0">${abbr}</div>`
}

// Attach autocomplete dropdown to an input.
// onSelect(team) called when user picks a suggestion.
export async function attachTeamAutocomplete(input, onSelect) {
  const teams = await loadTeams()

  // Dropdown container
  const drop = document.createElement('div')
  drop.style.cssText = `
    position:absolute;z-index:9999;background:var(--surface);border:1px solid var(--border);
    border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);min-width:260px;max-height:280px;
    overflow-y:auto;display:none;top:calc(100% + 4px);left:0;
  `
  // Position relative to input
  const wrap = document.createElement('div')
  wrap.style.cssText = 'position:relative;'
  input.parentNode.insertBefore(wrap, input)
  wrap.appendChild(input)
  wrap.appendChild(drop)

  let activeIdx = -1

  function show(filtered) {
    if (!filtered.length) { drop.style.display = 'none'; return }
    drop.innerHTML = filtered.map((t, i) => `
      <div class="ac-item" data-idx="${i}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;transition:background 0.1s;border-radius:${i===0?'8px 8px':i===filtered.length-1?'0 0 8px 8px':'0'} 0">
        ${teamLogoEl(t.logo, t.name, 28)}
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--text)">${esc(t.name)}</div>
          <div style="font-size:11px;color:var(--muted)">#${esc(t.rank)} HLTV</div>
        </div>
      </div>
    `).join('')
    drop.style.display = 'block'
    activeIdx = -1

    drop.querySelectorAll('.ac-item').forEach((el, i) => {
      el.addEventListener('mouseenter', () => { setActive(i) })
      el.addEventListener('mouseleave', () => { /* keep active */ })
      el.addEventListener('mousedown', e => {
        e.preventDefault()
        pick(filtered[i])
      })
    })
  }

  function setActive(i) {
    activeIdx = i
    drop.querySelectorAll('.ac-item').forEach((el, idx) => {
      el.style.background = idx === i ? 'rgba(139,109,255,0.12)' : ''
    })
  }

  function pick(team) {
    input.value = team.name
    drop.style.display = 'none'
    onSelect?.(team)
    input.dispatchEvent(new Event('input'))
  }

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase()
    if (!q) { drop.style.display = 'none'; return }
    const filtered = teams.filter(t => t.name.toLowerCase().includes(q)).slice(0, 8)
    show(filtered)
  })

  input.addEventListener('keydown', e => {
    const items = drop.querySelectorAll('.ac-item')
    if (!items.length || drop.style.display === 'none') return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)) }
    else if (e.key === 'Enter' && activeIdx >= 0) {
      const q = input.value.trim().toLowerCase()
      const filtered = teams.filter(t => t.name.toLowerCase().includes(q)).slice(0, 8)
      e.preventDefault(); pick(filtered[activeIdx])
    }
    else if (e.key === 'Escape') { drop.style.display = 'none' }
  })

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) drop.style.display = 'none'
  })
}
