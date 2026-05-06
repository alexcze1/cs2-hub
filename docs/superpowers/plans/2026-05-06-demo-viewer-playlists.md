# Demo Viewer Playlists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move round playlists from the analysis page to the demo viewer (save) + demos list page (browse).

**Architecture:** Reuse existing `playlists.js` data layer. Extract the save popover from `playlist-rail.js` into a standalone `save-popover.js` module. Wire ★ into the demo viewer's round label (`#vh-round`); add a Playlists section above the demos table on `demos.html`. Demo viewer parses `?round=` to deep-link to a saved round. Strip the analysis-page integration; delete `playlist-rail.js`.

**Tech Stack:** Vanilla ES modules (no build), Supabase JS v2, existing CSS tokens.

---

## File structure

- **Create:** `cs2-hub/save-popover.js` — owns the save popover (save mode + manage mode). Self-contained: caches its own playlist list per team, no external lifecycle hooks.
- **Modify:** `cs2-hub/demo-viewer.html` — ★ button next to `#vh-round`; popover container.
- **Modify:** `cs2-hub/demo-viewer.js` — wire ★, outside-click closer, parse `?round=` and jump to round on load.
- **Modify:** `cs2-hub/demos.html` — Playlists section markup above `#demos-list`.
- **Modify:** `cs2-hub/demos.js` — render Playlists master/detail, navigate to `demo-viewer.html?demo=&round=` on row click.
- **Modify:** `cs2-hub/style.css` — append demo-viewer ★ button styles, demos-page Playlists section styles. Strip analysis-only `.playlist-rail`, `.pr-*`, `.pp-save-btn` blocks at the end.
- **Modify:** `cs2-hub/analysis.html` — strip rail aside, ★ button, save-popover container.
- **Modify:** `cs2-hub/analysis.js` — strip playlist imports, helpers, mount call, ★ wiring, B keyboard shortcut, `setActiveRoundKey` calls; revert `advancePlaylist` to looping.
- **Delete:** `cs2-hub/playlist-rail.js`.

Files **kept unchanged:** `cs2-hub/supabase-playlists.sql`, `cs2-hub/playlists.js`, `cs2-hub/playlists.test.html`.

---

## Task 1: Create `save-popover.js` (extract from `playlist-rail.js`)

Self-contained popover module. Caches the playlist list per team on first open; refreshes after `createPlaylist`. No `mount`/`setTeam` lifecycle — `openSavePopoverFor` accepts everything it needs per call.

**Files:**
- Create: `cs2-hub/save-popover.js`

- [ ] **Step 1: Write the module**

```javascript
// cs2-hub/save-popover.js
//
// Standalone save popover for round playlists. Used by the demo viewer (★
// button on the round label) and any other surface that wants the same flow.
//
// Lifecycle: no mount/unmount. The host page provides a #save-popover
// container in its DOM and calls openSavePopoverFor({demoId, roundIdx,
// anchorRect, teamId, onChanged}). The module loads & caches the team's
// playlist list lazily on first open and refreshes it after a new playlist
// is created.

import { toast } from './toast.js'
import { supabase } from './supabase.js'
import {
  loadPlaylists, loadPlaylistRounds,
  createPlaylist,
  addRoundToPlaylist, removeRoundFromPlaylist, updateRoundNote,
  findRoundMemberships, sortByPosition,
} from './playlists.js'

let popoverState = null
let cachedPlaylists = []
let cachedTeamId = null

export async function openSavePopoverFor({ demoId, roundIdx, anchorRect, teamId, onChanged }) {
  if (!teamId) return
  const popEl = document.getElementById('save-popover')
  if (!popEl) { console.warn('[save-popover] no #save-popover element in DOM'); return }

  popoverState = {
    demoId, roundIdx, teamId, onChanged,
    memberships: [], showCreate: false, newName: '', note: '', selectedId: null, addingMore: false,
  }
  positionPopover(popEl, anchorRect)
  popEl.hidden = false
  popEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--muted)">Loading…</div>`

  try {
    if (cachedTeamId !== teamId) {
      cachedPlaylists = await loadPlaylists(teamId)
      cachedTeamId = teamId
    }
    popoverState.memberships = await findRoundMemberships(teamId, demoId, roundIdx)
  } catch (e) { console.error(e); toast('Failed to load playlists', 'error') }
  renderPopover()
}

export function closeSavePopover() {
  const popEl = document.getElementById('save-popover')
  if (popEl) popEl.hidden = true
  popoverState = null
}

export function isPopoverOpen() {
  return !!popoverState
}

/** Force the cached playlist list to reload on next open (e.g. after the
    host page itself created/deleted a playlist). */
export function invalidatePlaylistCache() {
  cachedPlaylists = []
  cachedTeamId = null
}

function positionPopover(popEl, anchorRect) {
  if (!anchorRect) return
  const margin = 6
  let top  = anchorRect.bottom + margin
  let left = anchorRect.left
  const w  = 260, h = 280
  if (left + w > window.innerWidth)  left = Math.max(8, window.innerWidth  - w - 8)
  if (top  + h > window.innerHeight) top  = Math.max(8, anchorRect.top - h - margin)
  popEl.style.top  = `${top}px`
  popEl.style.left = `${left}px`
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function renderPopover() {
  const popEl = document.getElementById('save-popover')
  if (!popEl || !popoverState) return
  const { memberships, showCreate, selectedId, note, newName } = popoverState
  const inSaveMode = memberships.length === 0 || popoverState.addingMore

  if (inSaveMode) {
    const candidates = cachedPlaylists.filter(p =>
      !memberships.some(m => m.playlist_id === p.id))
    popEl.innerHTML = `
      <h4>Add to playlist</h4>
      <div class="save-popover-list">
        ${candidates.length ? candidates.map(p => `
          <label class="save-popover-row">
            <input type="radio" name="pl" value="${esc(p.id)}" ${selectedId === p.id ? 'checked' : ''}>
            <span class="name">${esc(p.name)}</span>
          </label>
        `).join('') : `<div class="sp-empty">No playlists yet.</div>`}
        ${showCreate
          ? `<input type="text" id="pop-new-name" placeholder="New playlist name" value="${esc(newName)}">`
          : `<a class="new-link" id="pop-show-new">+ New playlist</a>`}
      </div>
      <input type="text" id="pop-note" placeholder="Note (optional, e.g. 'B rotation at 0:38')" value="${esc(note)}">
      <div class="save-popover-actions">
        <button class="btn-secondary" id="pop-cancel">Cancel</button>
        <button class="btn-primary"   id="pop-save">Save</button>
      </div>
    `
    for (const r of popEl.querySelectorAll('input[name="pl"]')) {
      r.addEventListener('change', () => { popoverState.selectedId = r.value })
    }
    popEl.querySelector('#pop-show-new')?.addEventListener('click', () => {
      popoverState.showCreate = true; renderPopover()
      popEl.querySelector('#pop-new-name')?.focus()
    })
    popEl.querySelector('#pop-new-name')?.addEventListener('input', e => {
      popoverState.newName = e.target.value
    })
    popEl.querySelector('#pop-note').addEventListener('input', e => {
      popoverState.note = e.target.value
    })
    popEl.querySelector('#pop-cancel').addEventListener('click', closeSavePopover)
    popEl.querySelector('#pop-save').addEventListener('click', onSavePopoverSubmit)
  } else {
    popEl.innerHTML = `
      <h4>Saved in ${memberships.length} playlist${memberships.length === 1 ? '' : 's'}</h4>
      <div class="save-popover-list">
        ${memberships.map(m => `
          <div class="save-popover-row" data-pr-id="${esc(m.playlist_round_id)}" data-pl-id="${esc(m.playlist_id)}">
            <span class="name">${esc(m.playlist_name)}</span>
            <button class="x" data-act="remove" title="Remove">✕</button>
          </div>
          <input type="text" class="manage-note" data-pr-id="${esc(m.playlist_round_id)}"
                 data-pl-id="${esc(m.playlist_id)}"
                 placeholder="Note" value="${esc(m.note)}">
        `).join('')}
      </div>
      <a class="new-link" id="pop-add-more">+ Add to another playlist</a>
      <div class="save-popover-actions">
        <button class="btn-secondary" id="pop-close">Close</button>
      </div>
    `
    for (const x of popEl.querySelectorAll('.x[data-act="remove"]')) {
      x.addEventListener('click', e => {
        const row = e.target.closest('[data-pr-id]')
        onPopoverRemove(row.dataset.prId, row.dataset.plId)
      })
    }
    for (const inp of popEl.querySelectorAll('.manage-note')) {
      inp.addEventListener('change', e => {
        onPopoverNoteEdit(e.target.dataset.prId, e.target.dataset.plId, e.target.value)
      })
    }
    popEl.querySelector('#pop-add-more').addEventListener('click', () => {
      popoverState.addingMore = true; renderPopover()
    })
    popEl.querySelector('#pop-close').addEventListener('click', closeSavePopover)
  }
}

async function onSavePopoverSubmit() {
  if (!popoverState) return
  const { demoId, roundIdx, teamId, onChanged, selectedId, showCreate, newName, note } = popoverState
  try {
    let plId = selectedId
    if (showCreate && newName.trim()) {
      const userId = (await supabase.auth.getUser()).data.user?.id
      const created = await createPlaylist(teamId, newName.trim(), userId)
      cachedPlaylists.unshift(created)
      plId = created.id
    }
    if (!plId) { toast('Pick or create a playlist', 'error'); return }
    const userId = (await supabase.auth.getUser()).data.user?.id
    const currentRows = await loadPlaylistRounds(plId)
    await addRoundToPlaylist({ playlistId: plId, demoId, roundIdx, note, currentRows, userId })
    toast('Saved to playlist')
    closeSavePopover()
    onChanged?.(demoId, roundIdx)
  } catch (e) { console.error(e); toast('Failed to save', 'error') }
}

async function onPopoverRemove(playlistRoundId, playlistId) {
  try {
    await removeRoundFromPlaylist(playlistRoundId, playlistId)
    popoverState.memberships = popoverState.memberships.filter(m => m.playlist_round_id !== playlistRoundId)
    if (!popoverState.memberships.length) {
      const { demoId, roundIdx, onChanged } = popoverState
      closeSavePopover()
      onChanged?.(demoId, roundIdx)
    } else renderPopover()
    toast('Removed')
  } catch (e) { console.error(e); toast('Failed to remove', 'error') }
}

async function onPopoverNoteEdit(playlistRoundId, playlistId, value) {
  try {
    await updateRoundNote(playlistRoundId, value, playlistId)
  } catch (e) { console.error(e); toast('Failed to save note', 'error') }
}
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check cs2-hub/save-popover.js`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/save-popover.js
git commit -m "feat(playlists): extract save-popover into standalone module"
```

---

## Task 2: Add ★ button + popover container to demo viewer markup

**Files:**
- Modify: `cs2-hub/demo-viewer.html`

- [ ] **Step 1: Insert ★ next to `#vh-round`**

Find the line containing `<span class="vh-round" id="vh-round">R1</span>` (around line 707). Replace it with:

```html
              <span class="vh-round" id="vh-round">R1</span>
              <button class="vh-save-btn" id="vh-save-btn" title="Save round to playlist">☆</button>
```

(Both elements live inside `vh-sub-row`; the new button comes immediately after the round label.)

- [ ] **Step 2: Add popover container at the end of `<main>`**

Just before the closing `</main>` tag in `cs2-hub/demo-viewer.html`, add:

```html
    <div class="save-popover" id="save-popover" hidden></div>
```

- [ ] **Step 3: Append CSS**

Append to `cs2-hub/style.css`:

```css
/* ── Demo viewer: save button ─────────────────────────────────── */
.vh-save-btn {
  background: transparent;
  border: 1px solid var(--border-solid);
  color: var(--muted);
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--r-sm);
  font-size: 12px;
  cursor: pointer;
  line-height: 1.4;
  transition: color 0.15s, border-color 0.15s;
}
.vh-save-btn:hover { color: var(--accent); border-color: var(--accent); }
.vh-save-btn.saved { color: var(--accent); border-color: var(--accent); }

/* ── Save popover ─────────────────────────────────────────────── */
.save-popover {
  position: fixed; z-index: 1000;
  width: 260px;
  background: var(--glass-bg);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
  box-shadow: 0 8px 28px rgba(0,0,0,0.45);
  padding: 10px;
  font-size: 12px;
  color: var(--text);
}
.save-popover[hidden] { display: none; }
.save-popover h4 {
  margin: 0 0 8px;
  font-family: var(--display-font);
  font-size: 10px; font-weight: 700;
  color: var(--accent);
  text-transform: uppercase; letter-spacing: 0.18em;
}
.save-popover-list { max-height: 180px; overflow-y: auto; margin-bottom: 8px; }
.save-popover-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 6px;
  cursor: pointer; border-radius: var(--r-sm);
}
.save-popover-row:hover { background: rgba(0,255,156,0.06); }
.save-popover-row input[type="radio"] { accent-color: var(--accent); }
.save-popover-row .name  { flex: 1; min-width: 0; }
.save-popover-row .x {
  background: transparent; border: none; cursor: pointer;
  color: var(--muted); font-size: 13px; padding: 0 4px;
}
.save-popover-row .x:hover { color: var(--danger); }
.save-popover input[type="text"] {
  width: 100%; box-sizing: border-box;
  background: var(--input-bg);
  border: 1px solid var(--border-solid);
  border-radius: var(--r-sm);
  padding: 5px 7px; font-size: 12px;
  color: var(--text);
}
.save-popover-actions { display: flex; gap: 6px; margin-top: 8px; }
.save-popover-actions button {
  flex: 1; padding: 5px 0;
  font-family: var(--display-font);
  font-size: 11px; font-weight: 700;
  border-radius: var(--r-sm); cursor: pointer;
  letter-spacing: 0.06em;
}
.save-popover .btn-primary {
  background: var(--accent); color: var(--accent-on); border: none;
}
.save-popover .btn-secondary {
  background: transparent; color: var(--muted);
  border: 1px solid var(--border-solid);
}
.save-popover .btn-secondary:hover { color: var(--accent); border-color: var(--accent); }
.save-popover .new-link {
  display: block; margin-top: 4px; padding: 5px 6px;
  color: var(--accent); cursor: pointer; font-size: 11px;
}
.save-popover .new-link:hover { background: rgba(0,255,156,0.06); border-radius: var(--r-sm); }
.sp-empty { padding: 6px; color: var(--muted); font-size: 11px; }
```

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/demo-viewer.html cs2-hub/style.css
git commit -m "feat(demo-viewer): ★ button + save-popover container"
```

---

## Task 3: Wire ★ click + outside-click closer + ★ state in `demo-viewer.js`

**Files:**
- Modify: `cs2-hub/demo-viewer.js`

- [ ] **Step 1: Add imports near the top**

Add to the imports block at the top of `cs2-hub/demo-viewer.js` (with the other imports, after the existing `mountAntistratDrawer` line):

```javascript
import { openSavePopoverFor, closeSavePopover, isPopoverOpen } from './save-popover.js'
import { findRoundMemberships } from './playlists.js'
```

- [ ] **Step 2: Add `refreshSaveBtnState` helper**

In `cs2-hub/demo-viewer.js`, near the existing UI-refresh helpers (search for `function refresh` to find a neighboring helper). Add:

```javascript
async function refreshSaveBtnState() {
  const btn = document.getElementById('vh-save-btn')
  if (!btn) return
  const teamId = getTeamId()
  if (!teamId) { btn.textContent = '☆'; btn.classList.remove('saved'); return }
  try {
    const ms = await findRoundMemberships(teamId, demoId, state.roundIdx)
    if (ms.length) { btn.textContent = '★'; btn.classList.add('saved') }
    else           { btn.textContent = '☆'; btn.classList.remove('saved') }
  } catch (e) { console.warn('[demo-viewer] refreshSaveBtnState failed:', e) }
}
```

(Note: `getTeamId` is already imported at the top of the file from `./supabase.js`.)

- [ ] **Step 3: Call `refreshSaveBtnState()` whenever the round changes**

Find the existing function `setRound()` or the place where `state.roundIdx` is assigned (around line 293 — `state.roundIdx = Math.max(0, Math.min(idx, state.match.rounds.length - 1))`). Immediately after that assignment, add:

```javascript
  refreshSaveBtnState()
```

Also call it once at boot, right after the existing initial render (look for the first call to a `render()`-style function near the bottom of module-level code; `refreshSaveBtnState()` is fire-and-forget there).

- [ ] **Step 4: Wire ★ button click + outside-click closer**

Add near the bottom of `cs2-hub/demo-viewer.js`, alongside other top-level event-binding code:

```javascript
document.getElementById('vh-save-btn').addEventListener('click', async (e) => {
  const rect = e.currentTarget.getBoundingClientRect()
  await openSavePopoverFor({
    demoId,
    roundIdx:   state.roundIdx,
    anchorRect: rect,
    teamId:     getTeamId(),
    onChanged:  () => refreshSaveBtnState(),
  })
})

document.addEventListener('click', (e) => {
  if (!isPopoverOpen()) return
  const pop = document.getElementById('save-popover')
  if (pop.contains(e.target)) return
  if (e.target.closest('#vh-save-btn')) return
  closeSavePopover()
})
```

- [ ] **Step 5: Verify**

Run: `node --check cs2-hub/demo-viewer.js`
Expected: no output (success).

- [ ] **Step 6: Smoke-test**

Open a demo in the demo viewer. Expected:
- ☆ button appears next to `R1` in the header.
- Click ☆ → popover opens.
- "+ New playlist" → type name, fill note, Save → toast, popover closes, ☆ → ★.
- Click ★ → manage mode shows the playlist with editable note + ✕.
- ✕ removes the only membership → toast, popover closes, ★ → ☆.
- Outside-click (on canvas) closes the popover.
- Walk to next round → ☆ resets (round not saved); walk back → ★ if previously saved.

- [ ] **Step 7: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat(demo-viewer): wire ★ save button to popover with state refresh"
```

---

## Task 4: Demo viewer accepts `?round=` URL param

**Files:**
- Modify: `cs2-hub/demo-viewer.js`

- [ ] **Step 1: Parse `round` param at boot**

The existing boot code at line 12 reads `id` from URL params:

```javascript
const params = new URLSearchParams(location.search)
const demoId = params.get('id')
```

Add immediately below:

```javascript
const initialRound = (() => {
  const r = parseInt(params.get('round') ?? '', 10)
  return Number.isFinite(r) && r >= 0 ? r : 0
})()
```

- [ ] **Step 2: Apply `initialRound` after match data is ready**

Find the existing line `const state = { match: null, playing: false, tick: 0, speed: 1, lastTs: 0, roundIdx: 0 }` (line 17). Change `roundIdx: 0` to `roundIdx: 0` (unchanged — we'll set it after `state.match.rounds` is loaded).

After the round-data validation block (line ~99 — the `if (!state.match.rounds.length) ...` block), and before the `_playersMeta` line, add:

```javascript
if (initialRound > 0 && initialRound < state.match.rounds.length) {
  state.roundIdx = initialRound
} else if (initialRound > 0) {
  console.warn('[demo-viewer] ?round=' + initialRound + ' out of range; falling back to round 0')
}
```

(`state.tick` will be set by the existing freeze-end seek inside the function that uses `state.roundIdx` for initial render.)

- [ ] **Step 3: Verify**

Run: `node --check cs2-hub/demo-viewer.js`
Expected: success.

- [ ] **Step 4: Smoke-test**

Open `demo-viewer.html?id=<some-demo-id>&round=4` in the browser. Expected:
- Viewer loads on round 4 (header shows "R5" since indices are 0-based).
- Without `?round=`, viewer still opens on round 0 (no regression).
- With invalid `?round=999`, viewer opens on round 0 + warning in console.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/demo-viewer.js
git commit -m "feat(demo-viewer): accept ?round= URL param for deep-linking"
```

---

## Task 5: Add Playlists section markup + base CSS to demos page

**Files:**
- Modify: `cs2-hub/demos.html`
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Insert Playlists section above `#demos-list`**

In `cs2-hub/demos.html`, find `<div id="demos-list"></div>` (line 33). Insert above it:

```html
    <section class="dl-playlists" id="dl-playlists" hidden></section>
```

- [ ] **Step 2: Append CSS to `cs2-hub/style.css`**

```css
/* ── Demos page: Playlists section ────────────────────────────── */
.dl-playlists {
  margin-bottom: 24px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
  padding: 14px 16px;
}
.dl-playlists[hidden] { display: none; }
.dl-pl-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 10px;
}
.dl-pl-title {
  font-family: var(--display-font);
  font-size: 11px; font-weight: 700;
  color: var(--accent);
  text-transform: uppercase; letter-spacing: 0.18em;
}
.dl-pl-new {
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  padding: 3px 10px;
  font-family: var(--display-font);
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em;
  border-radius: var(--r-sm);
  cursor: pointer;
}
.dl-pl-new:hover { background: rgba(0,255,156,0.10); }
.dl-pl-list { display: flex; flex-direction: column; gap: 4px; }
.dl-pl-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 12px; align-items: center;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background-color 0.12s, border-color 0.12s;
}
.dl-pl-row:hover { background: rgba(0,255,156,0.06); border-left-color: var(--accent); }
.dl-pl-name  { font-size: 13px; font-weight: 600; color: var(--text); }
.dl-pl-count { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.dl-pl-date  { font-size: 11px; color: var(--muted); }
.dl-empty    { padding: 8px 10px; color: var(--muted); font-size: 12px; }

/* Detail view */
.dl-pl-detail-header {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 10px;
}
.dl-pl-back {
  background: transparent; border: 1px solid var(--border-solid);
  color: var(--muted);
  width: 24px; height: 24px;
  border-radius: 50%;
  cursor: pointer; font-size: 13px;
}
.dl-pl-back:hover { color: var(--accent); border-color: var(--accent); }
.dl-pl-detail-name {
  font-family: var(--display-font);
  font-size: 12px; font-weight: 700;
  color: var(--text);
  letter-spacing: 0.08em;
}
.dl-pl-menu {
  margin-left: auto;
  background: transparent; border: none;
  color: var(--muted);
  font-size: 16px; cursor: pointer;
  padding: 0 6px;
}
.dl-pl-menu:hover { color: var(--accent); }
.dl-pl-rounds { display: flex; flex-direction: column; gap: 4px; }
.dl-round-row {
  display: grid;
  grid-template-columns: 36px 1fr 14px;
  gap: 10px; align-items: center;
  padding: 6px 10px;
  border-radius: var(--r-sm);
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background-color 0.12s, border-color 0.12s;
}
.dl-round-row:hover { background: rgba(0,255,156,0.06); border-left-color: var(--accent); }
.dl-round-thumb {
  width: 36px; height: 36px;
  border-radius: var(--r-sm);
  background-size: cover; background-position: center;
  background-color: rgba(255,255,255,0.04);
}
.dl-round-meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dl-round-title {
  font-size: 12px; color: var(--text); font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dl-round-note {
  font-size: 11px; color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dl-round-side-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  margin-right: 6px; vertical-align: middle;
}
.dl-round-side-dot.ct { background: #6cf; }
.dl-round-side-dot.t  { background: #f80; }
.dl-round-x {
  background: transparent; border: none; cursor: pointer;
  color: var(--muted); font-size: 13px; padding: 0 4px;
}
.dl-round-x:hover { color: var(--danger); }
```

- [ ] **Step 3: Verify**

Open `demos.html` in the browser. Expected:
- Page renders normally — the new section is hidden until JS shows it.

- [ ] **Step 4: Commit**

```bash
git add cs2-hub/demos.html cs2-hub/style.css
git commit -m "feat(demos): add Playlists section markup + styles"
```

---

## Task 6: Render Playlists master view in `demos.js`

**Files:**
- Modify: `cs2-hub/demos.js`

- [ ] **Step 1: Add imports**

Add to the imports section at the top of `cs2-hub/demos.js`:

```javascript
import { getTeamId, supabase } from './supabase.js'  // if not already imported (grep first)
import {
  loadPlaylists, loadPlaylistRounds, createPlaylist, deletePlaylist, renamePlaylist,
  removeRoundFromPlaylist, sortByPosition,
} from './playlists.js'
import { toast } from './toast.js'  // if not already imported
```

(Inspect existing imports before adding — the file already imports `supabase` and likely `toast`. Add only what's missing. `getTeamId` may already be there.)

- [ ] **Step 2: Add module-level state**

Near the top of `cs2-hub/demos.js` (after existing module-level vars):

```javascript
const playlistsState = {
  list:      [],
  loaded:    false,
  openId:    null,        // when set, detail view is shown
  openRows:  [],
  roundCounts: new Map(),  // playlistId → number
}
```

- [ ] **Step 3: Add `renderPlaylistsSection`, `loadPlaylistsForCurrentTeam`, helpers**

Append to `cs2-hub/demos.js`:

```javascript
async function loadPlaylistsForCurrentTeam() {
  const teamId = getTeamId()
  if (!teamId) {
    document.getElementById('dl-playlists').hidden = true
    return
  }
  try {
    playlistsState.list = await loadPlaylists(teamId)
    // Round counts in one query: SELECT playlist_id, count(*) GROUP BY playlist_id
    const { data: counts, error } = await supabase
      .from('playlist_rounds')
      .select('playlist_id')
      .in('playlist_id', playlistsState.list.map(p => p.id))
    if (error) throw error
    const m = new Map()
    for (const r of counts ?? []) m.set(r.playlist_id, (m.get(r.playlist_id) ?? 0) + 1)
    playlistsState.roundCounts = m
    playlistsState.loaded = true
    renderPlaylistsSection()
  } catch (e) {
    console.error('[demos] load playlists failed:', e)
    toast('Failed to load playlists', 'error')
  }
}

function renderPlaylistsSection() {
  const host = document.getElementById('dl-playlists')
  host.hidden = false
  if (playlistsState.openId) renderPlaylistsDetail(host)
  else                       renderPlaylistsMaster(host)
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function formatRelative(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const days = Math.round((Date.now() - d.getTime()) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7)  return `${days}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function renderPlaylistsMaster(host) {
  const rows = playlistsState.list.map(p => {
    const count = playlistsState.roundCounts.get(p.id) ?? 0
    return `
      <div class="dl-pl-row" data-id="${esc(p.id)}">
        <div class="dl-pl-name">${esc(p.name)}</div>
        <div class="dl-pl-count">${count} round${count === 1 ? '' : 's'}</div>
        <div class="dl-pl-date">${formatRelative(p.updated_at)}</div>
      </div>
    `
  }).join('')

  host.innerHTML = `
    <div class="dl-pl-header">
      <span class="dl-pl-title">Playlists</span>
      <button class="dl-pl-new" id="dl-pl-new">+ New</button>
    </div>
    <div class="dl-pl-list">
      ${playlistsState.list.length ? rows
        : `<div class="dl-empty">No playlists yet · save a round from the demo viewer to create one.</div>`}
    </div>
  `

  host.querySelector('#dl-pl-new').addEventListener('click', onNewPlaylist)
  for (const row of host.querySelectorAll('.dl-pl-row')) {
    row.addEventListener('click', () => openPlaylist(row.dataset.id))
  }
}

async function onNewPlaylist() {
  const name = prompt('Playlist name:')
  if (!name || !name.trim()) return
  const teamId = getTeamId()
  if (!teamId) return
  try {
    const userId = (await supabase.auth.getUser()).data.user?.id
    const created = await createPlaylist(teamId, name.trim(), userId)
    playlistsState.list.unshift(created)
    playlistsState.roundCounts.set(created.id, 0)
    toast('Playlist created')
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to create playlist', 'error') }
}

async function openPlaylist(id) {
  playlistsState.openId = id
  playlistsState.openRows = []
  renderPlaylistsSection()
  try {
    const rows = await loadPlaylistRounds(id)
    playlistsState.openRows = sortByPosition(rows)
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to load playlist', 'error') }
}
```

- [ ] **Step 4: Call `loadPlaylistsForCurrentTeam()` at boot**

Find the existing boot code in `cs2-hub/demos.js` (the place that loads the demos list at startup). After that load completes (or in parallel), call:

```javascript
loadPlaylistsForCurrentTeam()
```

(Fire-and-forget; the section appears once the data lands.)

- [ ] **Step 5: Smoke-test**

Open `demos.html`. Expected:
- "Playlists" section appears above the demos table.
- If you've previously saved any rounds (from Task 3 smoke-test), they show up here as a playlist with a round count > 0.
- Click "+ New" → enter a name → row appears with "0 rounds · today".
- Clicking a row opens detail view (next task fills this in).

- [ ] **Step 6: Commit**

```bash
git add cs2-hub/demos.js
git commit -m "feat(demos): playlists master view (list + create)"
```

---

## Task 7: Render Playlists detail view + round-row navigation

**Files:**
- Modify: `cs2-hub/demos.js`

- [ ] **Step 1: Add `renderPlaylistsDetail` + helpers**

Append to `cs2-hub/demos.js` (alongside the master-view functions from Task 6):

```javascript
function renderPlaylistsDetail(host) {
  const pl = playlistsState.list.find(p => p.id === playlistsState.openId)
  const empty = !playlistsState.openRows.length
    ? `<div class="dl-empty">Empty playlist · save a round from the demo viewer to add one.</div>`
    : ''

  host.innerHTML = `
    <div class="dl-pl-detail-header">
      <button class="dl-pl-back" id="dl-pl-back" title="Back">←</button>
      <span class="dl-pl-detail-name">${esc(pl?.name ?? '')}</span>
      <button class="dl-pl-menu" id="dl-pl-menu" title="Rename / Delete">⋯</button>
    </div>
    <div class="dl-pl-rounds" id="dl-pl-rounds">${empty}</div>
  `

  host.querySelector('#dl-pl-back').addEventListener('click', () => {
    playlistsState.openId = null
    playlistsState.openRows = []
    renderPlaylistsSection()
  })
  host.querySelector('#dl-pl-menu').addEventListener('click', () => onPlaylistMenu(pl))

  if (playlistsState.openRows.length) hydrateDetailRoundRows()
}

async function getDemoMetaCached(demoId) {
  if (!_demoMetaCache.has(demoId)) {
    const { data, error } = await supabase
      .from('demos')
      .select('id, map, score_ct, score_t')
      .eq('id', demoId).maybeSingle()
    if (error) { console.warn('[demos] getDemoMeta failed:', error); _demoMetaCache.set(demoId, null) }
    else _demoMetaCache.set(demoId, data)
  }
  return _demoMetaCache.get(demoId)
}
const _demoMetaCache = new Map()

function describeRound(row, meta) {
  if (!meta) return { side: 'ct', score: '?–?', mapFile: '' }
  const half  = Math.floor(row.round_idx / 12)
  const side  = (half % 2 === 0) ? 'ct' : 't'
  const score = (meta.score_ct != null && meta.score_t != null)
    ? `${meta.score_ct}–${meta.score_t}`
    : '—'
  const mapFile = (meta.map ?? '').replace(/^de_/, '').toLowerCase() || ''
  return { side, score, mapFile }
}

async function hydrateDetailRoundRows() {
  const listEl = document.getElementById('dl-pl-rounds')
  if (!listEl) return
  const metas = await Promise.all(playlistsState.openRows.map(r => getDemoMetaCached(r.demo_id)))

  listEl.innerHTML = playlistsState.openRows.map((r, i) => {
    const meta = metas[i]
    const info = describeRound(r, meta)
    const thumb = info.mapFile ? `images/maps/${info.mapFile}.png` : ''
    return `
      <div class="dl-round-row" data-row-id="${esc(r.id)}" data-demo-id="${esc(r.demo_id)}" data-round-idx="${r.round_idx}">
        <div class="dl-round-thumb" style="background-image:url('${esc(thumb)}')"></div>
        <div class="dl-round-meta">
          <div class="dl-round-title">
            <span class="dl-round-side-dot ${info.side}"></span>R${r.round_idx + 1} · ${esc(info.score)}
          </div>
          <div class="dl-round-note" title="${esc(r.note ?? '')}">${esc(r.note ?? '')}</div>
        </div>
        <button class="dl-round-x" data-row-id="${esc(r.id)}" title="Remove">✕</button>
      </div>
    `
  }).join('')

  for (const row of listEl.querySelectorAll('.dl-round-row')) {
    row.addEventListener('click', e => {
      if (e.target.closest('.dl-round-x')) return
      const demoId   = row.dataset.demoId
      const roundIdx = row.dataset.roundIdx
      location.href = `demo-viewer.html?id=${encodeURIComponent(demoId)}&round=${encodeURIComponent(roundIdx)}`
    })
  }
  for (const x of listEl.querySelectorAll('.dl-round-x')) {
    x.addEventListener('click', e => {
      e.stopPropagation()
      onRemoveRoundFromPlaylist(x.dataset.rowId)
    })
  }
}

async function onRemoveRoundFromPlaylist(rowId) {
  if (!confirm('Remove round from playlist?')) return
  try {
    await removeRoundFromPlaylist(rowId, playlistsState.openId)
    playlistsState.openRows = playlistsState.openRows.filter(r => r.id !== rowId)
    const cur = playlistsState.roundCounts.get(playlistsState.openId) ?? 0
    playlistsState.roundCounts.set(playlistsState.openId, Math.max(0, cur - 1))
    toast('Removed')
    renderPlaylistsSection()
  } catch (e) { console.error(e); toast('Failed to remove', 'error') }
}

async function onPlaylistMenu(pl) {
  const action = prompt(`Playlist "${pl.name}"\n\nType:\n  rename\n  delete\n  (anything else cancels)`, '')
  if (action === 'rename') {
    const newName = prompt('New name:', pl.name)
    if (!newName || !newName.trim()) return
    try {
      await renamePlaylist(pl.id, newName.trim())
      pl.name = newName.trim()
      toast('Renamed')
      renderPlaylistsSection()
    } catch (e) { console.error(e); toast('Failed to rename', 'error') }
  } else if (action === 'delete') {
    if (!confirm(`Delete playlist "${pl.name}"? This removes all its saved rounds.`)) return
    try {
      await deletePlaylist(pl.id)
      playlistsState.list = playlistsState.list.filter(x => x.id !== pl.id)
      playlistsState.roundCounts.delete(pl.id)
      playlistsState.openId = null
      playlistsState.openRows = []
      toast('Playlist deleted')
      renderPlaylistsSection()
    } catch (e) { console.error(e); toast('Failed to delete', 'error') }
  }
}
```

- [ ] **Step 2: Smoke-test**

Open `demos.html`. Click a playlist with saved rounds. Expected:
- Detail view shows back arrow + name + ⋯ menu.
- Each round row shows map thumb, R# + score, side dot, note, ✕.
- Click a round → navigates to `demo-viewer.html?id=…&round=…`, demo viewer loads on that round.
- ✕ → confirms, removes, count decrements.
- ⋯ → "rename" or "delete" works.
- Back arrow returns to master view.

- [ ] **Step 3: Commit**

```bash
git add cs2-hub/demos.js
git commit -m "feat(demos): playlists detail view with round-row navigation"
```

---

## Task 8: Strip playlist code from `analysis.html`

**Files:**
- Modify: `cs2-hub/analysis.html`

- [ ] **Step 1: Remove the rail aside**

Find and delete the `<aside class="playlist-rail" id="playlist-rail">…</aside>` element (added in Task 4 of the original plan). It's a child of `analysis-body`.

- [ ] **Step 2: Remove the ★ button from the player panel**

Find and delete the `<button class="pp-nav-btn pp-save-btn" id="pp-save-btn" title="Save round to playlist">☆</button>` line.

- [ ] **Step 3: Remove the save-popover container**

Find and delete the `<div id="save-popover" class="save-popover" hidden></div>` element near the end of `<main>`.

(Keep `<div id="kb-help-overlay" class="kb-help-overlay" hidden></div>` and `<div id="onboarding-hint" class="onboarding-hint" hidden></div>` — those are general polish.)

- [ ] **Step 4: Verify**

Open `analysis.html` in the browser. Expected: page loads without errors. The rail column is gone; the player panel no longer has a ★ button. (Some console warnings are expected because `analysis.js` still imports `playlist-rail.js` — that's fixed in the next task.)

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/analysis.html
git commit -m "refactor(analysis): remove playlist rail + ★ button + save-popover from markup"
```

---

## Task 9: Strip playlist code from `analysis.js`

**Files:**
- Modify: `cs2-hub/analysis.js`

- [ ] **Step 1: Remove the import**

At the top of `cs2-hub/analysis.js`, find and delete:

```javascript
import * as playlistRail from './playlist-rail.js'
```

- [ ] **Step 2: Remove the playlist rail mount block**

Inside `onTeamChanged()`, find and delete the entire block starting with `// Mount + populate the playlist rail (added by Task 5).` and ending after `await playlistRail.setTeam(getTeamId())` (around the original lines 138-148). Delete the comment line too.

- [ ] **Step 3: Remove the helpers**

Find and delete these functions (each in full, including the leading `async`/`function` keyword):

- `async function ensureRoundLoaded(demoId, roundIdx) { … }`
- `async function loadPlaylistRound(playlistRow) { … }`
- `async function playPlaylistAll(playlistRows) { … }`
- `async function refreshStarState() { … }`

- [ ] **Step 4: Remove the ★ button click handler + outside-click closer**

Find and delete:

```javascript
document.getElementById('pp-save-btn').addEventListener('click', async (e) => { … })
```

and the matching:

```javascript
document.addEventListener('click', (e) => {
  if (!playlistRail.isPopoverOpen()) return
  …
})
```

- [ ] **Step 5: Remove the `refreshStarState()` call inside `refreshSoloRoundNav()`**

The Task 7 work added `refreshStarState()` as the last statement of `refreshSoloRoundNav()`. Delete that line.

- [ ] **Step 6: Remove `setActiveRoundKey(null)` from `exitSingleRound()`**

Delete the `playlistRail.setActiveRoundKey(null)` line inside `exitSingleRound()`.

- [ ] **Step 7: Remove active-key update from `advancePlaylist()` AND revert to looping**

In `advancePlaylist()` (around line 495 currently), the function body looks like (Task 9 of the original plan):

```javascript
function advancePlaylist() {
  const pl = state.gren.playlist
  if (!pl || !pl.length) return
  // Stop at end (v1 — no loop).
  if (state.gren.playlistPos + 1 >= pl.length) {
    playback.playing = false
    document.getElementById('play-btn').textContent = '▶'
    return
  }
  state.gren.playlistPos += 1
  const nextIdx = pl[state.gren.playlistPos]
  …
  refreshSoloRoundNav()
  const r = state.rounds[nextIdx]
  if (r) playlistRail.setActiveRoundKey(`${r.demoId}|${r.roundIdx}`)
  …
}
```

Restore the original behavior:

```javascript
function advancePlaylist() {
  const pl = state.gren.playlist
  if (!pl || !pl.length) return
  state.gren.playlistPos = (state.gren.playlistPos + 1) % pl.length
  const nextIdx = pl[state.gren.playlistPos]
  …
  refreshSoloRoundNav()
  …
}
```

(Replace the stop-at-end guard with the modulo line; remove the `setActiveRoundKey` line near `refreshSoloRoundNav`.)

- [ ] **Step 8: Remove the `B` keyboard shortcut**

In the keydown handler installed at the bottom of the file (Task 12), delete the `case 'b':` and `case 'B':` block. Keep the rest (Space, ArrowLeft, ArrowRight, Escape, ?).

- [ ] **Step 9: Verify**

Run: `node --check cs2-hub/analysis.js`
Expected: success.

Open `analysis.html` in the browser. Pick a team. Expected:
- Filter rail + canvas + player panel render, no rail in 4th column.
- No console errors.
- Click a player → single-round playback works.
- Keyboard shortcuts (Space/←/→/Esc/?) still work; B does nothing.
- Grenade-mode "Play N rounds" loops at the end (back to the original modulo behavior).

- [ ] **Step 10: Commit**

```bash
git add cs2-hub/analysis.js
git commit -m "refactor(analysis): remove playlist integration + revert advancePlaylist to looping"
```

---

## Task 10: Strip playlist-only CSS from `style.css` + delete `playlist-rail.js`

**Files:**
- Modify: `cs2-hub/style.css`
- Delete: `cs2-hub/playlist-rail.js`

- [ ] **Step 1: Remove `.playlist-rail` and `.pr-*` rules**

In `cs2-hub/style.css`, find the `.playlist-rail { … }` block (added in Task 4) and delete it. Then delete every rule with a `.pr-` prefix: `.pr-header`, `.pr-title`, `.pr-icon-btn`, `.pr-list`, `.pr-pl-row`, `.pr-pl-row:hover`, `.pr-pl-row.active`, `.pr-pl-name`, `.pr-pl-meta`, `.pr-round-row`, `.pr-round-handle`, `.pr-round-handle:active`, `.pr-round-row.dragging`, `.pr-round-row.drop-above`, `.pr-round-row.drop-below`, `.pr-round-row:hover`, `.pr-round-row.active`, `.pr-round-thumb`, `.pr-round-meta`, `.pr-round-title`, `.pr-round-note`, `.pr-round-side-dot`, `.pr-round-side-dot.ct`, `.pr-round-side-dot.t`, `.pr-round-x`, `.pr-round-x:hover`, `.pr-empty`, `.pr-skel`, `@keyframes pr-shimmer`, `.pr-detail-header`, `.pr-back`, `.pr-back:hover`, `.pr-detail-name`, `.pr-play-all`, `.pr-play-all:hover`.

- [ ] **Step 2: Remove `.pp-save-btn` rule**

Find and delete the `.pp-save-btn { … }` block (added in Task 4 of the original plan, in the player-panel section).

(Keep `.save-popover*` rules — the demo viewer now uses them. Verify by grep before/after that `.save-popover` is still present.)

- [ ] **Step 3: Delete `cs2-hub/playlist-rail.js`**

```bash
git rm cs2-hub/playlist-rail.js
```

- [ ] **Step 4: Verify**

Run:
```bash
grep -n 'playlist-rail\|playlistRail\|pp-save-btn\|\.pr-\|class="pr-' cs2-hub/*.html cs2-hub/*.js cs2-hub/*.css
```

Expected: no matches (the only allowed remaining string is anywhere referencing `playlists.js` or `playlists` in passing, which is fine — we've kept that module).

Run: `node --check cs2-hub/analysis.js && node --check cs2-hub/demo-viewer.js && node --check cs2-hub/demos.js && node --check cs2-hub/save-popover.js && node --check cs2-hub/playlists.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/style.css cs2-hub/playlist-rail.js
git commit -m "refactor(playlists): drop playlist-rail module + analysis-only CSS"
```

---

## Task 11: Final acceptance walkthrough

**Files:** none modified.

- [ ] **Step 1: Re-run unit tests**

Open `cs2-hub/playlists.test.html` in the browser.
Expected: `13 passed, 0 failed`.

- [ ] **Step 2: Walk through every acceptance criterion**

1. Open a demo in the demo viewer. ☆ button visible next to `R1`. Click ☆ → popover. Save → toast, ☆ → ★. Walk to next round → ☆ resets.
2. Open `demos.html`. Playlists section appears above demos table. The playlist created in step 1 is listed with `1 round · today`.
3. Click the playlist → detail view with map thumb + R# + score + side dot + note + ✕.
4. Click the round → demo viewer opens at that demo, on that round.
5. ✕ on a round → confirms and removes. Count decrements on master view.
6. ⋯ menu → rename and delete both work.
7. Open `analysis.html`. No 4th-column rail. No ★ button in player panel. Keyboard `B` does nothing; Space/←/→/Esc/? still work. Grenade-mode "Play N rounds" loops at end (back to original behavior).
8. `cs2-hub/playlist-rail.js` no longer exists in the repo.

- [ ] **Step 3: No commit needed unless you found bugs**

If you needed any small fixes, commit them with a `fix(...)` message. Otherwise this verification task adds no commit.

---

## Notes for the executing engineer

- This codebase has **no build step**. ES modules load directly. Don't add bundlers or transpilers.
- The codebase is single-team-per-user; `getTeamId()` reads from `localStorage`. RLS is unchanged from the analysis-page version.
- The `?round=` URL parsing in Task 4 must run BEFORE the existing `state.match.rounds.length` validation — but the actual `state.roundIdx` assignment must come AFTER the rounds array is populated. Pattern: parse early, apply late.
- The Playlists section on demos.html lives in `dl-playlists` (`dl` prefix = "demos list"); the demo-viewer ★ uses `vh-save-btn` (`vh` = "viewer header"). Distinct from the analysis-page prefixes (`pp-` for player panel, `pr-` for playlist rail) so any leftover analysis CSS can't accidentally style the new elements.
- Never use `git add -A` or `git add .` — always stage specific files. The repo has many untracked files unrelated to this work.
- If a step's smoke test fails, fix in place and continue. Tasks are sequential by intent — Tasks 1-4 build the new save flow, 5-7 build the view flow, 8-10 are the analysis revert, 11 verifies.
