// cs2-hub/vods-filter.js
//
// Filter row for Results & Review. Emits filter state on mount (from
// localStorage) and on every change. Mounted by the hero into its own slot.

export const FILTER_KEY = 'vods:filter:v2'

const WINDOWS  = ['10', '30d', '90d', 'all']
const MATCH_TYPES = ['all', 'scrim', 'tournament', 'pug']

export function defaultFilter() {
  return { window: '10', matchType: 'all' }
}

function loadFilter() {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw) return defaultFilter()
    const parsed = JSON.parse(raw)
    return {
      window:    WINDOWS.includes(parsed.window) ? parsed.window : '10',
      matchType: MATCH_TYPES.includes(parsed.matchType) ? parsed.matchType : 'all',
    }
  } catch { return defaultFilter() }
}

function saveFilter(f) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)) } catch {}
}

const WINDOW_PILLS = [
  { key: '10',  label: 'Last 10' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All time' },
]
const TYPE_PILLS = [
  { key: 'all',        label: 'All' },
  { key: 'scrim',      label: 'Scrim' },
  { key: 'tournament', label: 'Tourn.' },
  { key: 'pug',        label: 'Pug' },
]

export function mountFilter(root, onChange) {
  let state = loadFilter()

  function render() {
    root.innerHTML = `
      <div class="vods-filter-row">
        <div class="vods-filter-pills" data-group="window">
          ${WINDOW_PILLS.map(p => `
            <button type="button" class="vods-filter-pill ${state.window === p.key ? 'is-active' : ''}"
                    data-window="${p.key}">${p.label}</button>
          `).join('')}
        </div>
        <div class="vods-filter-pills" data-group="type">
          ${TYPE_PILLS.map(p => `
            <button type="button" class="vods-filter-pill ${state.matchType === p.key ? 'is-active' : ''}"
                    data-type="${p.key}">${p.label}</button>
          `).join('')}
        </div>
      </div>
    `
    for (const btn of root.querySelectorAll('[data-window]')) {
      btn.addEventListener('click', () => {
        if (state.window === btn.dataset.window) return
        state = { ...state, window: btn.dataset.window }
        saveFilter(state); render(); onChange(state)
      })
    }
    for (const btn of root.querySelectorAll('[data-type]')) {
      btn.addEventListener('click', () => {
        if (state.matchType === btn.dataset.type) return
        state = { ...state, matchType: btn.dataset.type }
        saveFilter(state); render(); onChange(state)
      })
    }
  }

  render()
  onChange(state)
}
