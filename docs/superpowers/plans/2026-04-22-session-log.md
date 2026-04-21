# Session Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured post-session log page tied to past schedule events, accessible via a "Log →" link on the calendar.

**Architecture:** Three new artifacts — `session-log.html`, `session-log.js`, and a `session_logs` Supabase table — plus a small change to `schedule.js` to add log links on past events. The log page loads by `event_id` URL param, fetches the event for its header, upserts the log on save.

**Tech Stack:** Vanilla JS ES modules, Supabase JS client (`supabase.js`), existing `style.css`

---

### Task 1: Create session_logs table in Supabase

**Files:**
- No file changes — run SQL in Supabase dashboard SQL editor

- [ ] **Step 1: Open your Supabase project → SQL Editor**

- [ ] **Step 2: Run this SQL**

```sql
create table session_logs (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  team_id uuid not null,
  rating int check (rating >= 1 and rating <= 5),
  what_worked text,
  what_to_fix text,
  next_focus text,
  notes text,
  updated_at timestamptz default now(),
  unique (event_id, team_id)
);
```

- [ ] **Step 3: Verify**

In the Supabase Table Editor, confirm `session_logs` appears with the columns above.

---

### Task 2: Create session-log.html

**Files:**
- Create: `cs2-hub/session-log.html`

- [ ] **Step 1: Create the file**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Session Log — MIDROUND</title>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>
<div class="app-shell">
  <nav class="sidebar" id="sidebar"></nav>
  <main class="main-content">
    <div class="page-header">
      <div>
        <a href="schedule.html" style="color:var(--muted);font-size:13px;text-decoration:none">← Schedule</a>
        <div class="page-title" id="event-title" style="margin-top:6px">Session Log</div>
        <div id="event-meta" style="font-size:13px;color:var(--muted);margin-top:4px"></div>
      </div>
    </div>
    <div style="max-width:720px">
      <div id="log-body"></div>
    </div>
  </main>
</div>
<script type="module" src="session-log.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add cs2-hub/session-log.html
git commit -m "feat: add session-log.html shell"
```

---

### Task 3: Create session-log.js

**Files:**
- Create: `cs2-hub/session-log.js`

- [ ] **Step 1: Create the file**

```js
import { requireAuth } from './auth.js'
import { renderSidebar } from './layout.js'
import { supabase, getTeamId } from './supabase.js'

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML }

await requireAuth()
renderSidebar('schedule')

const params    = new URLSearchParams(location.search)
const eventId   = params.get('event_id')

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

    ${field('what-worked',  'What Worked',          'What did we execute well?',          'var(--success)', log?.what_worked)}
    ${field('what-to-fix',  'What to Fix',          'What broke down or needs work?',     'var(--danger)',  log?.what_to_fix)}
    ${field('next-focus',   'Next Session Focus',   'What do we prioritize next time?',   'var(--accent)',  log?.next_focus)}
    ${field('notes',        'Notes',                'Anything else',                      'var(--muted)',   log?.notes)}

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
    event_id:     eventId,
    team_id:      getTeamId(),
    rating:       selectedRating || null,
    what_worked:  document.getElementById('f-what-worked').value.trim()  || null,
    what_to_fix:  document.getElementById('f-what-to-fix').value.trim()  || null,
    next_focus:   document.getElementById('f-next-focus').value.trim()   || null,
    notes:        document.getElementById('f-notes').value.trim()        || null,
    updated_at:   new Date().toISOString()
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
```

- [ ] **Step 2: Commit**

```bash
git add cs2-hub/session-log.js
git commit -m "feat: add session-log.js — load event, render log fields, upsert on save"
```

---

### Task 4: Add "Log →" link on past events in schedule.js

**Files:**
- Modify: `cs2-hub/schedule.js` — `renderCalendar` function, lines 57–109

- [ ] **Step 1: Add `now` variable inside `renderCalendar`**

Find this line inside `renderCalendar`:

```js
  const today = new Date()
  today.setHours(0, 0, 0, 0)
```

Replace with:

```js
  const now   = new Date()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
```

- [ ] **Step 2: Add log link in the event template**

Find the existing `dayEvents.map(e => ...)` template string:

```js
          <div class="cal-event cal-event-${e.type}${e.source === 'pracc' ? ' cal-event-pracc' : ''}" data-id="${esc(e.id)}"><span class="cal-event-time">${formatTime(e.date)}${e.end_date ? ' – ' + formatTime(e.end_date) : ''}</span> ${esc(e.title)}${e.source === 'pracc' ? ' <span class="pracc-badge">PRACC</span>' : ''}</div>
```

Replace with:

```js
          <div class="cal-event cal-event-${e.type}${e.source === 'pracc' ? ' cal-event-pracc' : ''}" data-id="${esc(e.id)}"><span class="cal-event-time">${formatTime(e.date)}${e.end_date ? ' – ' + formatTime(e.end_date) : ''}</span> ${esc(e.title)}${e.source === 'pracc' ? ' <span class="pracc-badge">PRACC</span>' : ''}</div>
          ${!e.source && new Date(e.date) < now ? `<a href="session-log.html?event_id=${esc(e.id)}" onclick="event.stopPropagation()" style="display:block;font-size:10px;font-weight:700;letter-spacing:0.5px;color:var(--muted);text-decoration:none;padding:2px 0 2px 4px;margin-top:2px;opacity:0.7">LOG →</a>` : ''}
```

- [ ] **Step 3: Verify in browser**

Open `schedule.html`. Past events (events with a start time before right now) should show a small `LOG →` link below the event pill. Clicking `LOG →` should navigate to `session-log.html?event_id=<id>` without opening the event edit modal.

Future events should show no log link.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/schedule.js
git commit -m "feat: add Log link on past schedule events"
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Open a past event's log page directly**

Navigate to `session-log.html?event_id=<any-past-event-id>`. Confirm:
- Header shows correct event title, type badge, and date
- Rating circles render (1–5), none selected if new log
- Four textarea sections render with correct placeholder text and border colors
- Save button is present

- [ ] **Step 2: Fill in and save**

Select a rating, type in each field, click Save. Confirm:
- No error appears
- "Saved just now" appears below the Save button

- [ ] **Step 3: Reload and confirm persistence**

Refresh the page. Confirm all fields and the rating are pre-populated with what was saved. The status line should show "Last edited Xm ago".

- [ ] **Step 4: Test error state**

Navigate to `session-log.html` (no event_id param). Confirm the error empty-state renders with a `← Schedule` link.

- [ ] **Step 5: Push**

```bash
git push
```
