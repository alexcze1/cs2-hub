import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('schedule')

const params  = new URLSearchParams(location.search)
const eventId = params.get('event_id')

const TYPE_LABELS = { scrim: 'SCRIM', tournament: 'TOURNAMENT', meeting: 'MEETING', vod_review: 'VOD REVIEW' }
const TYPE_COLORS = { scrim: 'var(--accent)', tournament: 'var(--warning)', meeting: 'var(--special)', vod_review: 'var(--success)' }

let selectedRating = 0

function timeAgo(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── Load ───────────────────────────────────────────────────
if (!eventId) {
  renderError('No event specified.')
} else {
  const teamId = getTeamId()
  const [{ data: event, error: evErr }, { data: log }] = await Promise.all([
    supabase.from('events').select('*').eq('id', eventId).eq('team_id', teamId).single(),
    supabase.from('session_logs').select('*').eq('event_id', eventId).eq('team_id', teamId).maybeSingle()
  ])

  if (evErr || !event) {
    renderError('Event not found.')
  } else {
    document.getElementById('event-title').textContent = event.title
    const typeLabel = TYPE_LABELS[event.type] ?? event.type.toUpperCase()
    const typeColor = TYPE_COLORS[event.type] ?? 'var(--muted)'
    const dateStr   = new Date(event.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    document.getElementById('event-meta').innerHTML =
      `<span style="font-size:10px;font-weight:700;letter-spacing:0.5px;color:${typeColor};background:${typeColor}18;padding:2px 8px;border-radius:4px;margin-right:8px">${typeLabel}</span>${esc(dateStr)}`

    if (log) selectedRating = log.rating ?? 0
    renderLog(log)
  }
}

// ── Render ─────────────────────────────────────────────────
function field(id, label, placeholder, color, value) {
  return `
    <div style="background:var(--surface);border:1px solid var(--border);border-top:3px solid ${color};border-radius:8px;padding:20px;margin-bottom:12px">
      <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--muted);margin-bottom:10px">${label.toUpperCase()}</div>
      <textarea id="f-${id}" class="form-textarea" placeholder="${placeholder}" style="min-height:100px">${esc(value ?? '')}</textarea>
    </div>
  `
}

function renderLog(log) {
  document.getElementById('log-body').innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
      <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--muted);margin-bottom:12px">SESSION RATING</div>
      <div style="display:flex;gap:8px" id="rating-row">
        ${[1,2,3,4,5].map(n => `
          <button class="rating-btn" data-val="${n}" style="width:36px;height:36px;border-radius:50%;border:2px solid ${n <= selectedRating ? 'var(--accent)' : 'var(--border)'};background:${n <= selectedRating ? 'var(--accent)' : 'transparent'};color:${n <= selectedRating ? '#fff' : 'var(--muted)'};font-weight:700;font-size:13px;cursor:pointer;transition:all .15s">${n}</button>
        `).join('')}
      </div>
    </div>

    ${field('what-worked', 'What Worked',        'What did we execute well?',        'var(--success)', log?.what_worked)}
    ${field('what-to-fix', 'What to Fix',        'What broke down or needs work?',   'var(--danger)',  log?.what_to_fix)}
    ${field('next-focus',  'Next Session Focus', 'What do we prioritize next time?', 'var(--accent)',  log?.next_focus)}
    ${field('notes',       'Notes',              'Anything else',                    'var(--muted)',   log?.notes)}

    <div style="display:flex;align-items:center;gap:16px;margin-top:8px">
      <button class="btn btn-primary" id="save-btn">Save</button>
      <div id="save-status" style="font-size:12px;color:var(--muted)">${log?.updated_at ? 'Last edited ' + timeAgo(log.updated_at) : ''}</div>
    </div>
    <div class="error-msg" id="save-error" style="display:none;margin-top:8px"></div>
  `

  document.querySelectorAll('.rating-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedRating = parseInt(btn.dataset.val)
      document.querySelectorAll('.rating-btn').forEach(b => {
        const active = parseInt(b.dataset.val) <= selectedRating
        b.style.borderColor = active ? 'var(--accent)' : 'var(--border)'
        b.style.background  = active ? 'var(--accent)' : 'transparent'
        b.style.color       = active ? '#fff' : 'var(--muted)'
      })
    })
  })

  document.getElementById('save-btn').addEventListener('click', saveLog)
}

// ── Save ───────────────────────────────────────────────────
async function saveLog() {
  const payload = {
    event_id:    eventId,
    team_id:     getTeamId(),
    rating:      selectedRating || null,
    what_worked: document.getElementById('f-what-worked').value.trim() || null,
    what_to_fix: document.getElementById('f-what-to-fix').value.trim() || null,
    next_focus:  document.getElementById('f-next-focus').value.trim()  || null,
    notes:       document.getElementById('f-notes').value.trim()       || null,
    updated_at:  new Date().toISOString()
  }

  const errEl = document.getElementById('save-error')
  errEl.style.display = 'none'

  const { error } = await supabase
    .from('session_logs')
    .upsert(payload, { onConflict: 'event_id,team_id' })

  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  document.getElementById('save-status').textContent = 'Saved just now'
}

// ── Error state ────────────────────────────────────────────
function renderError(msg) {
  document.getElementById('log-body').innerHTML = `
    <div class="empty-state">
      <h3>Couldn't load session</h3>
      <p>${esc(msg)}</p>
      <a href="schedule.html" class="btn btn-ghost" style="margin-top:12px">← Schedule</a>
    </div>
  `
}
