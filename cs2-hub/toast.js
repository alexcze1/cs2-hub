let container = null

function getContainer() {
  if (!container) {
    container = document.createElement('div')
    container.id = 'toast-container'
    document.body.appendChild(container)
  }
  return container
}

export function toast(message, type = 'success', duration = 3000) {
  const icons = { success: '✓', error: '✕', info: 'ℹ' }
  const el = document.createElement('div')
  el.className = `toast toast-${type}`
  el.innerHTML = `<span class="toast-icon">${icons[type] ?? '✓'}</span><span>${message}</span>`

  getContainer().appendChild(el)
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')))

  setTimeout(() => {
    el.classList.remove('show')
    el.addEventListener('transitionend', () => el.remove(), { once: true })
  }, duration)
}
