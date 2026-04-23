// Shared HLTV player autocomplete — attach to any text input
let _players = null

async function loadPlayers() {
  if (_players) return _players
  try {
    const r = await fetch('hltv-players.json')
    _players = await r.json()
  } catch {
    _players = []
  }
  return _players
}

export async function getPlayerImage(ign) {
  const players = await loadPlayers()
  const match = players.find(p => p.ign.toLowerCase() === ign?.toLowerCase())
  return match?.image ?? null
}

export function playerAvatarEl(image, ign, size = 40) {
  if (image) {
    return `<img src="${image}" alt="${ign}" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:50%;background:var(--surface);flex-shrink:0">`
  }
  const abbr = (ign ?? '?').slice(0, 2).toUpperCase()
  return `<div style="width:${size}px;height:${size}px;background:var(--border);border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--accent);font-size:${Math.round(size * 0.3)}px;font-weight:700;flex-shrink:0">${abbr}</div>`
}

export async function attachPlayerAutocomplete(input, onSelect) {
  const players = await loadPlayers()

  const drop = document.createElement('div')
  drop.style.cssText = `
    position:absolute;z-index:9999;background:var(--surface);border:1px solid var(--border);
    border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);min-width:260px;max-height:280px;
    overflow-y:auto;display:none;top:calc(100% + 4px);left:0;
  `
  const wrap = document.createElement('div')
  wrap.style.cssText = 'position:relative;'
  input.parentNode.insertBefore(wrap, input)
  wrap.appendChild(input)
  wrap.appendChild(drop)

  let activeIdx = -1

  function show(filtered) {
    if (!filtered.length) { drop.style.display = 'none'; return }
    drop.innerHTML = filtered.map((p, i) => `
      <div class="ac-item" data-idx="${i}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;transition:background 0.1s">
        ${playerAvatarEl(p.image, p.ign, 32)}
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--text)">${p.ign}</div>
          <div style="font-size:11px;color:var(--muted)">${p.team}${p.country ? ' · ' + p.country : ''}</div>
        </div>
      </div>
    `).join('')
    drop.style.display = 'block'
    activeIdx = -1

    drop.querySelectorAll('.ac-item').forEach((el, i) => {
      el.addEventListener('mouseenter', () => setActive(i))
      el.addEventListener('mousedown', e => { e.preventDefault(); pick(filtered[i]) })
    })
  }

  function setActive(i) {
    activeIdx = i
    drop.querySelectorAll('.ac-item').forEach((el, idx) => {
      el.style.background = idx === i ? 'rgba(102,102,183,0.12)' : ''
    })
  }

  function pick(player) {
    input.value = player.ign
    drop.style.display = 'none'
    onSelect?.(player)
    input.dispatchEvent(new Event('input'))
  }

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase()
    if (!q) { drop.style.display = 'none'; return }
    const filtered = players.filter(p =>
      p.ign.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)
    ).slice(0, 8)
    show(filtered)
  })

  input.addEventListener('keydown', e => {
    const items = drop.querySelectorAll('.ac-item')
    if (!items.length || drop.style.display === 'none') return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)) }
    else if (e.key === 'Enter' && activeIdx >= 0) {
      const q = input.value.trim().toLowerCase()
      const filtered = players.filter(p => p.ign.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)).slice(0, 8)
      e.preventDefault(); pick(filtered[activeIdx])
    }
    else if (e.key === 'Escape') { drop.style.display = 'none' }
  })

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) drop.style.display = 'none'
  })
}
