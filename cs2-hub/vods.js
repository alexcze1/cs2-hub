// cs2-hub/vods.js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase } from './supabase.js'

function esc(text) {
  const d = document.createElement('div')
  d.textContent = text ?? ''
  return d.innerHTML
}

await requireAuth()
renderSidebar('vods')

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

const el = document.getElementById('vods-list')
const { data: vods, error } = await supabase.from('vods').select('*').order('match_date', { ascending: false })

if (error) {
  el.innerHTML = `<div class="empty-state"><h3>Failed to load VODs</h3><p>${esc(error.message)}</p></div>`
} else if (!vods?.length) {
  el.innerHTML = `<div class="empty-state"><h3>No VODs yet</h3><p>Add your first demo review.</p></div>`
} else {
  el.innerHTML = vods.map(v => {
    const noteCount = (v.notes ?? []).length
    return `
      <a class="list-row" href="vod-detail.html?id=${v.id}">
        <span class="badge badge-${v.result ?? 'draw'}">${esc((v.result ?? '—').toUpperCase())}</span>
        <div class="flex-1">
          <div class="row-name">${esc(v.title)}</div>
          <div class="row-meta">${v.score ? esc(v.score) + ' · ' : ''}${esc(v.match_type ?? '')} · ${v.match_date ? formatDate(v.match_date) : '—'}</div>
        </div>
        <div class="row-meta">${noteCount} note${noteCount !== 1 ? 's' : ''}</div>
      </a>
    `
  }).join('')
}
