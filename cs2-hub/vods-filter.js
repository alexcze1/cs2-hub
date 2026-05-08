// cs2-hub/vods-filter.js
//
// Renders the filter row above the team stats grid on Results & Review.
// Emits filter state on mount (from localStorage) and on every change.

export const FILTER_KEY = 'vods:filter:v1'

export function defaultFilter() {
  return { window: '10', tournamentsOnly: false }
}

function loadFilter() {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw) return defaultFilter()
    const parsed = JSON.parse(raw)
    return {
      window: ['10','30d','90d','all'].includes(parsed.window) ? parsed.window : '10',
      tournamentsOnly: !!parsed.tournamentsOnly,
    }
  } catch { return defaultFilter() }
}

function saveFilter(f) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)) } catch {}
}

const PILLS = [
  { key: '10',  label: 'Last 10' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All time' },
]

// Mount the filter row inside `root`. Calls `onChange(state)` on mount and
// on every subsequent change.
export function mountFilter(root, onChange) {
  let state = loadFilter()

  function render() {
    root.innerHTML = `
      <div class="vods-filter-row">
        <div class="vods-filter-pills">
          ${PILLS.map(p => `
            <button type="button" class="vods-filter-pill ${state.window === p.key ? 'is-active' : ''}"
                    data-window="${p.key}">${p.label}</button>
          `).join('')}
        </div>
        <label class="vods-filter-toggle">
          <input type="checkbox" id="vods-tournaments-toggle" ${state.tournamentsOnly ? 'checked' : ''}/>
          <span>Tournaments only</span>
        </label>
      </div>
    `
    for (const btn of root.querySelectorAll('[data-window]')) {
      btn.addEventListener('click', () => {
        if (state.window === btn.dataset.window) return
        state = { ...state, window: btn.dataset.window }
        saveFilter(state); render(); onChange(state)
      })
    }
    root.querySelector('#vods-tournaments-toggle').addEventListener('change', (e) => {
      state = { ...state, tournamentsOnly: !!e.target.checked }
      saveFilter(state); onChange(state)
    })
  }

  render()
  onChange(state)
}
