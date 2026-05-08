// cs2-hub/player-drawer.js
//
// Single drawer instance mounted into <body>. Slide-in panel from the right
// with a click-dismissable backdrop. Open is idempotent (calling open()
// while already open swaps content without animation).

let mounted = null

function ensureMounted() {
  if (mounted) return mounted
  const wrap = document.createElement('div')
  wrap.className = 'player-drawer'
  wrap.setAttribute('aria-hidden', 'true')
  wrap.innerHTML = `
    <div class="player-drawer-backdrop"></div>
    <aside class="player-drawer-panel" role="dialog" aria-modal="true">
      <header class="pd-header">
        <div>
          <div class="pd-title"></div>
          <div class="pd-subtitle"></div>
        </div>
        <button type="button" class="player-drawer-close" aria-label="Close">×</button>
      </header>
      <div class="pd-body"></div>
    </aside>
  `
  document.body.appendChild(wrap)

  let onCloseCb = null

  function close() {
    wrap.setAttribute('aria-hidden', 'true')
    if (typeof onCloseCb === 'function') { const cb = onCloseCb; onCloseCb = null; cb() }
  }

  wrap.querySelector('.player-drawer-backdrop').addEventListener('click', close)
  wrap.querySelector('.player-drawer-close').addEventListener('click', close)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wrap.getAttribute('aria-hidden') === 'false') close()
  })

  mounted = {
    el: wrap,
    open({ title, subtitle, body, onClose }) {
      // Replace the previous onClose without firing it (it's a swap, not a close).
      onCloseCb = onClose ?? null
      wrap.querySelector('.pd-title').textContent = title ?? ''
      wrap.querySelector('.pd-subtitle').textContent = subtitle ?? ''
      wrap.querySelector('.pd-body').innerHTML = body ?? ''
      wrap.setAttribute('aria-hidden', 'false')
      // Scroll body to top on open
      wrap.querySelector('.pd-body').scrollTop = 0
    },
    close,
    isOpen() { return wrap.getAttribute('aria-hidden') === 'false' },
  }
  return mounted
}

// Returns the singleton drawer controller. Mounts on first call.
export function mountDrawer() {
  return ensureMounted()
}
