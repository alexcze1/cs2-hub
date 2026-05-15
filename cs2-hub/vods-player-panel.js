// cs2-hub/vods-player-panel.js
//
// Inline slide-down panel for player details, mounted between the player grid
// and the map pool. Same content surface as the old side drawer
// (`buildPlayerDrawerBody`), just laid out in-page with a max-height
// transition instead of a fixed side panel.

export function mountPlayerPanel(root) {
  root.innerHTML = `
    <div class="rr-player-panel" aria-hidden="true">
      <div class="rr-player-panel-inner">
        <header class="rr-player-panel-head">
          <div>
            <div class="rr-player-panel-title"></div>
            <div class="rr-player-panel-subtitle"></div>
          </div>
          <button type="button" class="rr-player-panel-close" aria-label="Close">×</button>
        </header>
        <div class="rr-player-panel-body"></div>
      </div>
    </div>
  `

  const wrap     = root.querySelector('.rr-player-panel')
  const titleEl  = root.querySelector('.rr-player-panel-title')
  const subEl    = root.querySelector('.rr-player-panel-subtitle')
  const bodyEl   = root.querySelector('.rr-player-panel-body')
  const closeBtn = root.querySelector('.rr-player-panel-close')

  let onCloseCb = null

  function close() {
    if (wrap.getAttribute('aria-hidden') === 'true') return
    wrap.setAttribute('aria-hidden', 'true')
    if (typeof onCloseCb === 'function') { const cb = onCloseCb; onCloseCb = null; cb() }
  }

  closeBtn.addEventListener('click', close)

  return {
    open({ title, subtitle, body, onClose }) {
      onCloseCb = onClose ?? null
      titleEl.textContent = title ?? ''
      subEl.textContent   = subtitle ?? ''
      bodyEl.innerHTML    = body ?? ''
      wrap.setAttribute('aria-hidden', 'false')
      bodyEl.scrollTop = 0
    },
    close,
    isOpen() { return wrap.getAttribute('aria-hidden') === 'false' },
  }
}
