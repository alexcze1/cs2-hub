# Keywords / Map Veto / Anti-Strat Tactical Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `keywords.html`, `veto.html`, and `opponents.html` (sidebar label "Anti-Strat") to parity with the tactical redesigns already shipped for stratbook / issues / goals — `dx-hero` summary, `dx-filters` pill row + search, restyled card grid — without changing data model or modal UX.

**Architecture:** Three independent commits, one per page, in order keywords → veto → anti-strat. Each page extracts two pure helpers (a `derive*Stats` for the hero and a `filter*` predicate for the pill row), unit-tests them in inline `*.test.html` files matching the existing codebase pattern, then rewrites the HTML shell + JS render layer + appends a CSS block. All new layout reuses existing `dx-*` and `sb-card` classes; new CSS is page-specific only.

**Tech Stack:** Vanilla ES modules, Supabase JS client, plain CSS variables, inline `*.test.html` assertions (no test runner — open file in browser, count `✓`/`✗`).

**Spec:** `docs/superpowers/specs/2026-05-16-cs2-hub-keywords-veto-antistrat-overhaul.md`

---

## File Map

### Page 1 — Keywords
- **Modify:** `cs2-hub/keywords.html` (replace markup, keep modal block verbatim)
- **Modify:** `cs2-hub/keywords.js` (restructure into `renderHero / renderFilters / renderList`, export pure helpers)
- **Create:** `cs2-hub/keywords-stats.test.html` (tests `deriveKeywordStats`)
- **Create:** `cs2-hub/keywords-filter.test.html` (tests `filterKeywords`)
- **Modify:** `cs2-hub/style.css` (append `/* ── Keywords (tactical) ── */` block at EOF)

### Page 2 — Map Veto
- **Modify:** `cs2-hub/veto.html` (replace markup, keep modal block verbatim)
- **Modify:** `cs2-hub/veto.js` (restructure, export pure helpers)
- **Create:** `cs2-hub/veto-stats.test.html` (tests `deriveVetoStats`)
- **Create:** `cs2-hub/veto-filter.test.html` (tests `filterVetos`)
- **Modify:** `cs2-hub/style.css` (append `/* ── Map Veto hero/filters ── */` block at EOF; existing `.veto-flow-card`/`.veto-step` rules untouched)

### Page 3 — Anti-Strat (opponents)
- **Modify:** `cs2-hub/opponents.html` (replace markup; no modal on this page)
- **Modify:** `cs2-hub/opponents.js` (restructure, export pure helpers)
- **Create:** `cs2-hub/opponents-stats.test.html` (tests `deriveOpponentStats`)
- **Create:** `cs2-hub/opponents-filter.test.html` (tests `filterOpponents`)
- **Modify:** `cs2-hub/style.css` (append `/* ── Anti-Strat hero/filters ── */` block at EOF; existing `.intel-*` rules untouched, optional `.intel-card-wash` added)

### Shared constants
The `MAPS` array and `dust2 → dust` filename mapping already exist as inline constants in `stratbook.js` and `veto.js`. Do NOT extract a new shared module — duplicating these tiny constants matches the existing codebase pattern.

---

# Task 1: Keywords — `deriveKeywordStats` helper (TDD)

**Files:**
- Modify: `cs2-hub/keywords.js` (add named export)
- Create: `cs2-hub/keywords-stats.test.html`

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/keywords-stats.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<h1>keywords-stats tests</h1>
<pre id="out"></pre>
<script type="module">
import { deriveKeywordStats } from './keywords.js'

const out = document.getElementById('out')
let pass = 0, fail = 0
function assert(cond, msg) {
  const line = (cond ? '✓ ' : '✗ ') + msg
  out.textContent += line + '\n'
  if (cond) pass++; else fail++
}

// Empty
let s = deriveKeywordStats([])
assert(s.total === 0,           'empty: total = 0')
assert(s.categoryCount === 0,   'empty: categoryCount = 0')
assert(s.uncategorized === 0,   'empty: uncategorized = 0')
assert(s.topCategory === null,  'empty: topCategory = null')
assert(s.latest === null,       'empty: latest = null')

// Mixed
const kws = [
  { name: 'A', category: 'Callout', created_at: '2026-05-10T00:00:00Z' },
  { name: 'B', category: 'Callout', created_at: '2026-05-12T00:00:00Z' },
  { name: 'C', category: 'Economy', created_at: '2026-05-11T00:00:00Z' },
  { name: 'D', category: null,      created_at: '2026-05-13T00:00:00Z' },
  { name: 'E', category: '',        created_at: '2026-05-09T00:00:00Z' },
]
s = deriveKeywordStats(kws)
assert(s.total === 5,                 'mixed: total = 5')
assert(s.categoryCount === 2,         'mixed: categoryCount = 2 (Callout, Economy)')
assert(s.uncategorized === 2,         'mixed: uncategorized = 2 (null + empty string)')
assert(s.topCategory === 'Callout',   `mixed: topCategory = Callout (got ${s.topCategory})`)
assert(s.latest === 'D',              `mixed: latest = D (got ${s.latest})`)

// Tie on top category — first-appearance wins
const tie = [
  { name: 'A', category: 'X', created_at: '2026-05-01T00:00:00Z' },
  { name: 'B', category: 'Y', created_at: '2026-05-02T00:00:00Z' },
  { name: 'C', category: 'Y', created_at: '2026-05-03T00:00:00Z' },
  { name: 'D', category: 'X', created_at: '2026-05-04T00:00:00Z' },
]
s = deriveKeywordStats(tie)
assert(s.topCategory === 'X',         `tie: first-appearance wins, X (got ${s.topCategory})`)

out.textContent += `\n${pass} passed, ${fail} failed\n`
</script>
</body>
</html>
```

- [ ] **Step 2: Run the test and verify it fails**

Open `cs2-hub/keywords-stats.test.html` in a browser (or run `start cs2-hub/keywords-stats.test.html` on Windows). Expected: page shows a JS import error or `deriveKeywordStats is not a function` — the helper doesn't exist yet.

- [ ] **Step 3: Write the minimal implementation**

Add this named export to `cs2-hub/keywords.js`, before any other top-level code (right after the `esc` helper around line 6):

```js
export function deriveKeywordStats(keywords) {
  const total = keywords.length
  if (total === 0) {
    return { total: 0, categoryCount: 0, uncategorized: 0, topCategory: null, latest: null }
  }
  const counts = new Map()       // category -> { n, firstIdx }
  let uncategorized = 0
  for (let i = 0; i < keywords.length; i++) {
    const c = keywords[i].category
    if (c == null || c === '') { uncategorized++; continue }
    const entry = counts.get(c)
    if (entry) entry.n++
    else counts.set(c, { n: 1, firstIdx: i })
  }
  let topCategory = null, topN = 0, topIdx = Infinity
  for (const [cat, { n, firstIdx }] of counts) {
    if (n > topN || (n === topN && firstIdx < topIdx)) {
      topCategory = cat; topN = n; topIdx = firstIdx
    }
  }
  // Latest = name of the keyword with greatest created_at
  let latestRow = keywords[0]
  for (const k of keywords) {
    if ((k.created_at ?? '') > (latestRow.created_at ?? '')) latestRow = k
  }
  return {
    total,
    categoryCount: counts.size,
    uncategorized,
    topCategory,
    latest: latestRow?.name ?? null,
  }
}
```

Note: `keywords.js` currently uses a top-level `await requireAuth()`. The named export must be defined ABOVE that await so the module exports it before it suspends. If unsure, place it immediately after the `function esc(...)` helper.

- [ ] **Step 4: Run the test and verify it passes**

Reload `cs2-hub/keywords-stats.test.html`. Expected: `9 passed, 0 failed` with all `✓` lines.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/A/Documents/claude
git add cs2-hub/keywords.js cs2-hub/keywords-stats.test.html
git commit -m "test(keywords): deriveKeywordStats helper"
```

---

# Task 2: Keywords — `filterKeywords` helper (TDD)

**Files:**
- Modify: `cs2-hub/keywords.js` (add named export)
- Create: `cs2-hub/keywords-filter.test.html`

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/keywords-filter.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<h1>keywords-filter tests</h1>
<pre id="out"></pre>
<script type="module">
import { filterKeywords } from './keywords.js'

const out = document.getElementById('out')
let pass = 0, fail = 0
function assert(cond, msg) {
  const line = (cond ? '✓ ' : '✗ ') + msg
  out.textContent += line + '\n'
  if (cond) pass++; else fail++
}

const kws = [
  { id: 1, name: 'Retake B',     category: 'Strat',    description: 'B-site retake after explosion' },
  { id: 2, name: 'Force Buy',    category: 'Economy',  description: 'Buy on a low round' },
  { id: 3, name: 'Triple Stack', category: 'Strat',    description: 'Three players one site' },
  { id: 4, name: 'Eco',          category: null,       description: 'Save round'              },
]

// All
let r = filterKeywords(kws, { category: 'all', q: '' })
assert(r.length === 4, `all + empty q = 4 (got ${r.length})`)

// Category filter
r = filterKeywords(kws, { category: 'Strat', q: '' })
assert(r.length === 2, `category=Strat → 2 (got ${r.length})`)
assert(r.every(k => k.category === 'Strat'), 'category=Strat → all match')

// Search matches name
r = filterKeywords(kws, { category: 'all', q: 'retake' })
assert(r.length === 1 && r[0].id === 1, `q=retake matches name (id=${r[0]?.id})`)

// Search matches description
r = filterKeywords(kws, { category: 'all', q: 'save' })
assert(r.length === 1 && r[0].id === 4, `q=save matches description (id=${r[0]?.id})`)

// Search matches category
r = filterKeywords(kws, { category: 'all', q: 'economy' })
assert(r.length === 1 && r[0].id === 2, `q=economy matches category (id=${r[0]?.id})`)

// Case-insensitive
r = filterKeywords(kws, { category: 'all', q: 'STACK' })
assert(r.length === 1 && r[0].id === 3, `q is case-insensitive (id=${r[0]?.id})`)

// Combined
r = filterKeywords(kws, { category: 'Strat', q: 'retake' })
assert(r.length === 1 && r[0].id === 1, `combined filter (id=${r[0]?.id})`)

// Null-category keyword excluded from named category filter
r = filterKeywords(kws, { category: 'Economy', q: '' })
assert(r.length === 1 && r[0].id === 2, `null-category excluded from named filter`)

out.textContent += `\n${pass} passed, ${fail} failed\n`
</script>
</body>
</html>
```

- [ ] **Step 2: Run and verify failure**

Open `cs2-hub/keywords-filter.test.html`. Expected: import error for `filterKeywords`.

- [ ] **Step 3: Add the helper**

Add this named export to `cs2-hub/keywords.js`, immediately after `deriveKeywordStats`:

```js
export function filterKeywords(keywords, filter) {
  const q = (filter.q ?? '').toLowerCase().trim()
  return keywords.filter(k => {
    if (filter.category !== 'all' && (k.category ?? '') !== filter.category) return false
    if (!q) return true
    return (
      (k.name ?? '').toLowerCase().includes(q) ||
      (k.description ?? '').toLowerCase().includes(q) ||
      (k.category ?? '').toLowerCase().includes(q)
    )
  })
}
```

- [ ] **Step 4: Run and verify pass**

Reload `cs2-hub/keywords-filter.test.html`. Expected: `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/keywords.js cs2-hub/keywords-filter.test.html
git commit -m "test(keywords): filterKeywords helper"
```

---

# Task 3: Keywords — HTML shell, JS render layer, CSS

**Files:**
- Modify: `cs2-hub/keywords.html` (replace top of body, keep modal verbatim)
- Modify: `cs2-hub/keywords.js` (replace everything below the two new helpers)
- Modify: `cs2-hub/style.css` (append block at EOF)

- [ ] **Step 1: Replace `keywords.html` body markup**

Replace lines 14–55 of `cs2-hub/keywords.html` (everything inside `<main class="main-content">…</main>`) with this. The modal block stays verbatim — only the surrounding markup changes:

```html
  <main class="main-content">

    <section id="kw-hero"    class="dx-hero"><div class="dx-hero-loading">Loading…</div></section>
    <section id="kw-filters" class="dx-filters"></section>

    <div class="modal-backdrop" id="modal" style="display:none">
      <div class="modal" style="max-width:440px;width:100%">
        <div class="modal-header">
          <div class="modal-title" id="modal-title">Add Keyword</div>
          <button class="modal-close" id="modal-close">×</button>
        </div>
        <div class="form-group">
          <label class="form-label">Keyword / Term</label>
          <input class="form-input" id="f-name" placeholder="e.g. Retake B, Triple Stack, Force Buy"/>
        </div>
        <div class="form-group">
          <label class="form-label">Category (optional)</label>
          <input class="form-input" id="f-category" placeholder="e.g. Callout, Economy, Strat"/>
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea class="form-textarea" id="f-description" placeholder="What does this term mean for our team?" style="min-height:80px"></textarea>
        </div>
        <div class="error-msg" id="modal-error" style="display:none"></div>
        <div class="modal-actions">
          <button class="btn btn-danger btn-sm" id="delete-btn" style="display:none;margin-right:auto">Delete</button>
          <button class="btn btn-ghost" id="cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="save-btn">Save</button>
        </div>
      </div>
    </div>

    <div id="keywords-list"></div>
  </main>
```

Note: The container id changes from `keywords-grid` to `keywords-list` to match the `<page>-list` convention used by stratbook/issues/goals. The JS render layer updates accordingly.

- [ ] **Step 2: Replace the body of `keywords.js`**

Replace everything in `cs2-hub/keywords.js` BELOW the two exported helpers (`deriveKeywordStats`, `filterKeywords`) with this. The top imports and `esc` helper stay; the two helpers stay; the rest is rewritten:

```js
await requireAuth()
renderSidebar('keywords')

const FILTER_LS_KEY = 'keywords:filter:v1'
const DEFAULT_FILTER = { category: 'all', q: '' }
function loadSavedFilter() {
  try { return { ...DEFAULT_FILTER, ...JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '{}') } }
  catch { return { ...DEFAULT_FILTER } }
}
function saveFilter(f) { try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify(f)) } catch {} }

const state = {
  filter: loadSavedFilter(),
  keywords: [],
}
let editingId = null

const heroEl    = document.getElementById('kw-hero')
const filtersEl = document.getElementById('kw-filters')
const listEl    = document.getElementById('keywords-list')

async function loadKeywords() {
  const { data, error } = await supabase
    .from('keywords').select('*')
    .eq('team_id', getTeamId())
    .order('name', { ascending: true })
  if (error) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">Failed to load</h3>${esc(error.message)}</div>`
    return
  }
  state.keywords = data ?? []
  renderAll()
}

// ── Hero ──────────────────────────────────────────────────────
function renderHero() {
  const s = deriveKeywordStats(state.keywords)
  heroEl.innerHTML = `
    <div class="dx-hero-grid">
      <div class="dx-hero-left">
        <div class="dx-hero-title">KEYWORDS</div>
        <div class="dx-hero-count">${s.total}<span class="dx-hero-count-unit">${s.total === 1 ? ' term' : ' terms'}</span></div>
        <div class="dx-hero-substats">
          <div class="dx-kv"><div class="dx-kv-k">Categories</div><div class="dx-kv-v">${s.categoryCount}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Uncategorized</div><div class="dx-kv-v">${s.uncategorized}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Top category</div><div class="dx-kv-v">${s.topCategory ? esc(s.topCategory) : '—'}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Latest</div><div class="dx-kv-v">${s.latest ? esc(s.latest) : '—'}</div></div>
        </div>
        <div class="dx-hero-actions">
          <button type="button" class="dx-upload-cta" id="add-btn">+ Add Keyword</button>
        </div>
      </div>
      <div class="dx-hero-right"></div>
    </div>`
  document.getElementById('add-btn').addEventListener('click', () => openModal())
}

// ── Filters ───────────────────────────────────────────────────
function distinctCategoriesInOrder(keywords) {
  const seen = new Set(), out = []
  for (const k of keywords) {
    const c = k.category
    if (c == null || c === '') continue
    if (!seen.has(c)) { seen.add(c); out.push(c) }
  }
  return out
}

function renderFilters() {
  const f = state.filter
  const cats = distinctCategoriesInOrder(state.keywords)
  const pill = (val, label) =>
    `<button type="button" class="dx-pill ${f.category === val ? 'is-active' : ''}" data-val="${esc(val)}">${esc(label)}</button>`

  filtersEl.innerHTML = `
    <div class="dx-filter-row">
      <div class="dx-filter-group">
        ${pill('all', 'All Categories')}
        ${cats.map(c => pill(c, c)).join('')}
      </div>
      <div class="dx-filter-spacer"></div>
      <input type="search" class="dx-search-input" id="kw-search" placeholder="Search keywords…" value="${esc(f.q)}"/>
    </div>`

  for (const btn of filtersEl.querySelectorAll('.dx-pill')) {
    btn.addEventListener('click', () => {
      const v = btn.dataset.val
      if (state.filter.category === v) return
      state.filter = { ...state.filter, category: v }
      saveFilter(state.filter)
      renderFilters(); renderList()
    })
  }
  document.getElementById('kw-search').addEventListener('input', e => {
    state.filter = { ...state.filter, q: e.target.value }
    saveFilter(state.filter)
    renderList()
  })
}

// ── List ──────────────────────────────────────────────────────
function renderList() {
  const filtered = filterKeywords(state.keywords, state.filter)
  if (state.keywords.length === 0) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">No keywords yet</h3>Define your first term to seed the team glossary.</div>`
    return
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="dx-empty">No keywords match the current filters.</div>`
    return
  }
  listEl.innerHTML = `<div class="kw-grid">${filtered.map(keywordCard).join('')}</div>`
  for (const btn of listEl.querySelectorAll('[data-edit]')) {
    btn.addEventListener('click', e => { e.stopPropagation(); openModal(btn.dataset.edit) })
  }
}

function keywordCard(k) {
  return `
    <div class="kw-card">
      <div class="kw-card-head">
        <div class="kw-card-name">${esc(k.name)}</div>
        <button type="button" class="btn btn-ghost btn-sm" data-edit="${esc(k.id)}">Edit</button>
      </div>
      ${k.category ? `<div class="kw-card-cat">${esc(k.category)}</div>` : ''}
      <div class="kw-card-desc">${esc(k.description)}</div>
    </div>`
}

// ── Modal ─────────────────────────────────────────────────────
function openModal(id = null) {
  editingId = id
  const k = id ? state.keywords.find(x => String(x.id) === String(id)) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Keyword' : 'Add Keyword'
  document.getElementById('f-name').value        = k?.name        ?? ''
  document.getElementById('f-category').value    = k?.category    ?? ''
  document.getElementById('f-description').value = k?.description ?? ''
  document.getElementById('delete-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  document.getElementById('modal').style.display = 'flex'
}
function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click', closeModal)
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal() })

document.getElementById('save-btn').addEventListener('click', async () => {
  const name        = document.getElementById('f-name').value.trim()
  const category    = document.getElementById('f-category').value.trim() || null
  const description = document.getElementById('f-description').value.trim()
  const errEl       = document.getElementById('modal-error')
  if (!name)        { errEl.textContent = 'Keyword name is required.'; errEl.style.display = 'block'; return }
  if (!description) { errEl.textContent = 'Description is required.';  errEl.style.display = 'block'; return }
  const payload = { name, category, description, team_id: getTeamId() }
  let error
  if (editingId) ({ error } = await supabase.from('keywords').update(payload).eq('id', editingId))
  else           ({ error } = await supabase.from('keywords').insert(payload))
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  const wasEditing = !!editingId
  closeModal(); toast(wasEditing ? 'Keyword updated' : 'Keyword added'); loadKeywords()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this keyword?')) return
  const { error } = await supabase.from('keywords').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); toast('Keyword deleted'); loadKeywords()
})

function renderAll() { renderHero(); renderFilters(); renderList() }

loadKeywords()
```

- [ ] **Step 3: Append CSS block at end of `cs2-hub/style.css`**

```css

/* ── Keywords (tactical) ─────────────────────────────────────── */
.kw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.kw-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
  transition: transform 220ms ease, box-shadow 220ms ease, border-color 160ms;
}
.kw-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 0 24px rgba(0,255,156,0.10);
  border-color: rgba(0,255,156,0.25);
}
.kw-card-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
}
.kw-card-name {
  font-family: var(--display-font);
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--text);
  line-height: 1.2;
}
.kw-card-cat {
  align-self: flex-start;
  font-family: var(--display-font);
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent);
  background: rgba(0,255,156,0.10);
  padding: 3px 8px;
  border-radius: 4px;
  font-weight: 700;
}
.kw-card-desc {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}
```

- [ ] **Step 4: Re-run helper tests to confirm no regression**

Open both `cs2-hub/keywords-stats.test.html` and `cs2-hub/keywords-filter.test.html`. Both must show `X passed, 0 failed`.

- [ ] **Step 5: Manual browser verification**

Run a static server from the repo root and open `cs2-hub/keywords.html` (the Vercel dev server or `npx serve .` both work; whichever the user normally uses for this project).

Check:
- Hero renders with title, count, four sub-stats, and `+ Add Keyword` CTA. Right column is empty (no map wash on keywords).
- Filter row shows `All Categories` + one pill per distinct category. Search input is on the right.
- Cards render in a grid; hover shows lift and accent glow.
- Clicking a pill or typing in search filters the grid; reloading the page preserves the filter (localStorage key `keywords:filter:v1`).
- `+ Add Keyword` and `Edit` open the existing modal; save / delete still work.
- Empty data → "No keywords yet" empty state. Filter that excludes everything → "No keywords match" empty state.

If any check fails, fix before committing.

- [ ] **Step 6: Commit**

```bash
git add cs2-hub/keywords.html cs2-hub/keywords.js cs2-hub/style.css
git commit -m "feat(keywords): tactical hero + reskinned filters + redesigned cards"
```

---

# Task 4: Map Veto — `deriveVetoStats` helper (TDD)

**Files:**
- Modify: `cs2-hub/veto.js` (add named export)
- Create: `cs2-hub/veto-stats.test.html`

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/veto-stats.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<h1>veto-stats tests</h1>
<pre id="out"></pre>
<script type="module">
import { deriveVetoStats } from './veto.js'

const out = document.getElementById('out')
let pass = 0, fail = 0
function assert(cond, msg) {
  const line = (cond ? '✓ ' : '✗ ') + msg
  out.textContent += line + '\n'
  if (cond) pass++; else fail++
}

// Empty
let s = deriveVetoStats([])
assert(s.total === 0,             'empty: total = 0')
assert(s.bo1 === 0 && s.bo3 === 0, 'empty: bo1 = bo3 = 0')
assert(s.topOpponent === null,    'empty: topOpponent = null')
assert(s.mostBanned === null,     'empty: mostBanned = null')

// Mixed
const vetos = [
  { format: 'bo1', opponent: 'NAVI', steps: [
    { type: 'ban',  team: 'home', map: 'mirage' },
    { type: 'ban',  team: 'away', map: 'inferno' },
    { type: 'ban',  team: 'home', map: 'mirage' }, // duplicate map within same veto still counts
    { type: 'decider', team: 'left', map: 'ancient' },
  ]},
  { format: 'bo3', opponent: 'NAVI', steps: [
    { type: 'ban',  team: 'home', map: 'nuke' },
    { type: 'pick', team: 'away', map: 'overpass' },
  ]},
  { format: 'bo3', opponent: 'Vitality', steps: [
    { type: 'ban',  team: 'home', map: 'inferno' },
    { type: 'ban',  team: 'home', map: 'inferno' },
  ]},
]
s = deriveVetoStats(vetos)
assert(s.total === 3,                'mixed: total = 3')
assert(s.bo1 === 1,                  'mixed: bo1 = 1')
assert(s.bo3 === 2,                  'mixed: bo3 = 2')
assert(s.topOpponent === 'NAVI',     `mixed: topOpponent = NAVI (got ${s.topOpponent})`)
// inferno appears 3x in bans (1 + 2), mirage 2x, nuke 1x → mostBanned = inferno
assert(s.mostBanned === 'inferno',   `mixed: mostBanned = inferno (got ${s.mostBanned})`)

// No bans at all → mostBanned = null
const noBans = [{ format: 'bo1', opponent: 'X', steps: [
  { type: 'decider', team: 'left', map: 'mirage' }
]}]
s = deriveVetoStats(noBans)
assert(s.mostBanned === null, `no bans: mostBanned = null (got ${s.mostBanned})`)

// Null/empty opponent excluded from topOpponent
const noOpp = [
  { format: 'bo1', opponent: null,  steps: [] },
  { format: 'bo3', opponent: '',    steps: [] },
  { format: 'bo1', opponent: 'TYL', steps: [] },
]
s = deriveVetoStats(noOpp)
assert(s.topOpponent === 'TYL', `null/empty opponent skipped (got ${s.topOpponent})`)

out.textContent += `\n${pass} passed, ${fail} failed\n`
</script>
</body>
</html>
```

- [ ] **Step 2: Run and verify failure**

Open `cs2-hub/veto-stats.test.html`. Expected: `deriveVetoStats is not a function` import error.

- [ ] **Step 3: Add the helper**

Add to `cs2-hub/veto.js`, immediately after the `esc` helper around line 7:

```js
export function deriveVetoStats(vetos) {
  const total = vetos.length
  let bo1 = 0, bo3 = 0
  const oppCounts = new Map()   // opponent -> { n, firstIdx }
  const banCounts = new Map()   // map -> { n, firstIdx }
  for (let i = 0; i < vetos.length; i++) {
    const v = vetos[i]
    if (v.format === 'bo1') bo1++
    else if (v.format === 'bo3') bo3++
    const opp = v.opponent
    if (opp != null && opp !== '') {
      const e = oppCounts.get(opp)
      if (e) e.n++; else oppCounts.set(opp, { n: 1, firstIdx: i })
    }
    for (const step of v.steps ?? []) {
      if (step.type !== 'ban' || !step.map) continue
      const e = banCounts.get(step.map)
      if (e) e.n++; else banCounts.set(step.map, { n: 1, firstIdx: i })
    }
  }
  function pickTop(counts) {
    let key = null, top = 0, topIdx = Infinity
    for (const [k, { n, firstIdx }] of counts) {
      if (n > top || (n === top && firstIdx < topIdx)) { key = k; top = n; topIdx = firstIdx }
    }
    return key
  }
  return {
    total, bo1, bo3,
    topOpponent: pickTop(oppCounts),
    mostBanned:  pickTop(banCounts),
  }
}
```

- [ ] **Step 4: Run and verify pass**

Reload `cs2-hub/veto-stats.test.html`. Expected: `10 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/veto.js cs2-hub/veto-stats.test.html
git commit -m "test(veto): deriveVetoStats helper"
```

---

# Task 5: Map Veto — `filterVetos` helper (TDD)

**Files:**
- Modify: `cs2-hub/veto.js`
- Create: `cs2-hub/veto-filter.test.html`

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/veto-filter.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<h1>veto-filter tests</h1>
<pre id="out"></pre>
<script type="module">
import { filterVetos } from './veto.js'

const out = document.getElementById('out')
let pass = 0, fail = 0
function assert(cond, msg) {
  const line = (cond ? '✓ ' : '✗ ') + msg
  out.textContent += line + '\n'
  if (cond) pass++; else fail++
}

const vetos = [
  { id: 'a', title: 'vs NAVI',     opponent: 'NAVI',     format: 'bo1', notes: 'plays default', steps: [{ type: 'ban', map: 'mirage' }] },
  { id: 'b', title: 'vs NAVI rematch', opponent: 'NAVI', format: 'bo3', notes: '',              steps: [{ type: 'pick', map: 'inferno' }] },
  { id: 'c', title: 'vs Vitality', opponent: 'Vitality', format: 'bo1', notes: 'aggro CT',      steps: [{ type: 'ban', map: 'nuke' }] },
  { id: 'd', title: 'scrim',       opponent: null,       format: 'bo3', notes: '',              steps: [] },
]

let r = filterVetos(vetos, { format: 'all', opponent: 'all', q: '' })
assert(r.length === 4, `all → 4 (got ${r.length})`)

r = filterVetos(vetos, { format: 'bo1', opponent: 'all', q: '' })
assert(r.length === 2 && r.every(v => v.format === 'bo1'), `format=bo1 → 2`)

r = filterVetos(vetos, { format: 'all', opponent: 'NAVI', q: '' })
assert(r.length === 2 && r.every(v => v.opponent === 'NAVI'), `opponent=NAVI → 2`)

r = filterVetos(vetos, { format: 'all', opponent: 'all', q: 'rematch' })
assert(r.length === 1 && r[0].id === 'b', `q matches title`)

r = filterVetos(vetos, { format: 'all', opponent: 'all', q: 'aggro' })
assert(r.length === 1 && r[0].id === 'c', `q matches notes`)

r = filterVetos(vetos, { format: 'all', opponent: 'all', q: 'inferno' })
assert(r.length === 1 && r[0].id === 'b', `q matches step map`)

r = filterVetos(vetos, { format: 'all', opponent: 'all', q: 'NAVI' })
assert(r.length === 2, `q matches opponent (case-insensitive expected)`)

// Combined
r = filterVetos(vetos, { format: 'bo3', opponent: 'NAVI', q: '' })
assert(r.length === 1 && r[0].id === 'b', `combined bo3 + NAVI`)

out.textContent += `\n${pass} passed, ${fail} failed\n`
</script>
</body>
</html>
```

- [ ] **Step 2: Run and verify failure**

Open `cs2-hub/veto-filter.test.html`. Expected: import error.

- [ ] **Step 3: Add the helper**

Add to `cs2-hub/veto.js`, immediately after `deriveVetoStats`:

```js
export function filterVetos(vetos, filter) {
  const q = (filter.q ?? '').toLowerCase().trim()
  return vetos.filter(v => {
    if (filter.format   !== 'all' && v.format   !== filter.format)   return false
    if (filter.opponent !== 'all' && (v.opponent ?? '') !== filter.opponent) return false
    if (!q) return true
    if ((v.title    ?? '').toLowerCase().includes(q)) return true
    if ((v.opponent ?? '').toLowerCase().includes(q)) return true
    if ((v.notes    ?? '').toLowerCase().includes(q)) return true
    for (const step of v.steps ?? []) {
      if ((step.map ?? '').toLowerCase().includes(q)) return true
    }
    return false
  })
}
```

- [ ] **Step 4: Run and verify pass**

Reload `cs2-hub/veto-filter.test.html`. Expected: `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/veto.js cs2-hub/veto-filter.test.html
git commit -m "test(veto): filterVetos helper"
```

---

# Task 6: Map Veto — HTML shell, JS render layer, CSS

**Files:**
- Modify: `cs2-hub/veto.html`
- Modify: `cs2-hub/veto.js`
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Replace `veto.html` body**

Replace lines 14–73 of `cs2-hub/veto.html` (the entire `<main>` content) with this. The modal block — including `veto-opp-logo`, `veto-builder`, all form fields — stays verbatim:

```html
  <main class="main-content">

    <section id="veto-hero"    class="dx-hero"><div class="dx-hero-loading">Loading…</div></section>
    <section id="veto-filters" class="dx-filters"></section>

    <div class="modal-backdrop" id="modal" style="display:none">
      <div class="modal" style="max-width:560px;width:100%">
        <div class="modal-header">
          <div class="modal-title" id="modal-title">New Veto</div>
          <button class="modal-close" id="modal-close">×</button>
        </div>
        <div class="form-group">
          <label class="form-label">Title</label>
          <input class="form-input" id="f-title" placeholder="e.g. vs TEAM NAME"/>
        </div>
        <div class="form-group">
          <label class="form-label">Opponent</label>
          <div style="display:flex;align-items:center;gap:10px">
            <div id="veto-opp-logo"></div>
            <input class="form-input" id="f-opponent" placeholder="Opponent team name" style="flex:1"/>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Format</label>
          <select class="form-select" id="f-format">
            <option value="bo1">BO1</option>
            <option value="bo3">BO3</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Home Team Label</label>
            <input class="form-input" id="f-home" placeholder="Us" value="Us"/>
          </div>
          <div class="form-group">
            <label class="form-label">Away Team Label</label>
            <input class="form-input" id="f-away" placeholder="Them" value="Them"/>
          </div>
        </div>
        <div id="veto-builder" style="margin-top:8px"></div>
        <div class="form-group" style="margin-top:16px">
          <label class="form-label">Notes</label>
          <textarea class="form-textarea" id="f-notes" placeholder="Reasoning, tendencies…" style="min-height:60px"></textarea>
        </div>
        <div class="error-msg" id="modal-error" style="display:none"></div>
        <div class="modal-actions">
          <button class="btn btn-danger btn-sm" id="delete-btn" style="display:none;margin-right:auto">Delete</button>
          <button class="btn btn-ghost" id="cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="save-btn">Save</button>
        </div>
      </div>
    </div>

    <div id="veto-list"></div>
  </main>
```

- [ ] **Step 2: Replace the body of `veto.js`**

Keep the top imports, `esc` helper, `MAPS`, `MAP_LABELS`, `MAP_IMAGES`, `BO1_SEQUENCE`, `BO3_SEQUENCE`, `deriveVetoStats`, `filterVetos`. Replace everything else (the `let allVetos`, the entire `renderVetoBuilder`, `loadVetos`, `openModal`, etc.) with this:

```js
const MAP_IMG = { dust2: 'dust' }
function mapFile(map) { return MAP_IMG[map] ?? map }
function mapBg(map)   { return map ? `images/maps/${mapFile(map)}.png` : '' }

await requireAuth()
renderSidebar('veto')

const FILTER_LS_KEY = 'veto:filter:v1'
const DEFAULT_FILTER = { format: 'all', opponent: 'all', q: '' }
function loadSavedFilter() {
  try { return { ...DEFAULT_FILTER, ...JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '{}') } }
  catch { return { ...DEFAULT_FILTER } }
}
function saveFilter(f) { try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify(f)) } catch {} }

const state = {
  filter: loadSavedFilter(),
  vetos: [],
  logos: [],          // index-aligned with vetos
}
let editingId = null
let vetoSteps = []

const heroEl    = document.getElementById('veto-hero')
const filtersEl = document.getElementById('veto-filters')
const listEl    = document.getElementById('veto-list')

function getSequence() {
  return document.getElementById('f-format').value === 'bo3' ? BO3_SEQUENCE : BO1_SEQUENCE
}

function renderVetoBuilder() {
  const seq = getSequence()
  const home = document.getElementById('f-home').value.trim() || 'Home'
  const away = document.getElementById('f-away').value.trim() || 'Away'
  while (vetoSteps.length < seq.length) vetoSteps.push({ ...seq[vetoSteps.length], map: '' })
  if (vetoSteps.length > seq.length) vetoSteps.length = seq.length
  const usedMaps = vetoSteps.map(s => s.map).filter(Boolean)
  const el = document.getElementById('veto-builder')
  el.innerHTML = `<div style="font-size:11px;font-weight:700;letter-spacing:1px;color:var(--muted);margin-bottom:10px">VETO SEQUENCE</div>
  ${seq.map((step, i) => {
    const teamLabel  = step.team === 'away' ? away : step.team === 'home' ? home : '—'
    const actionLabel = step.type === 'ban' ? 'BAN' : step.type === 'pick' ? 'PICK' : 'PLAYS'
    const actionColor = step.type === 'ban' ? 'var(--danger)' : step.type === 'pick' ? 'var(--success)' : 'var(--accent)'
    if (step.type === 'decider') {
      const leftMap = MAPS.find(m => !usedMaps.slice(0, usedMaps.length - (vetoSteps[i].map ? 1 : 0)).includes(m)) ?? '?'
      return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--border)">
        <span style="width:20px;text-align:center;color:var(--muted);font-size:12px">${i+1}</span>
        <span style="min-width:60px;color:var(--muted);font-size:11px">${esc(teamLabel)}</span>
        <span style="min-width:44px;color:${actionColor};font-size:11px;font-weight:700">${actionLabel}</span>
        <span style="font-size:13px;font-weight:700;color:var(--accent)">${esc(MAP_LABELS[leftMap] ?? leftMap)}</span>
      </div>`
    }
    const availableMaps = MAPS.filter(m => !usedMaps.includes(m) || m === vetoSteps[i]?.map)
    return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--border)">
      <span style="width:20px;text-align:center;color:var(--muted);font-size:12px">${i+1}</span>
      <span style="min-width:60px;color:var(--muted);font-size:11px">${esc(teamLabel)}</span>
      <span style="min-width:44px;color:${actionColor};font-size:11px;font-weight:700">${actionLabel}</span>
      <select class="form-select" style="width:130px;padding:4px 8px;font-size:12px" data-i="${i}">
        <option value="">Pick map…</option>
        ${availableMaps.map(m => `<option value="${m}" ${vetoSteps[i]?.map === m ? 'selected' : ''}>${MAP_LABELS[m]}</option>`).join('')}
      </select>
    </div>`
  }).join('')}`
  el.querySelectorAll('select[data-i]').forEach(sel => sel.addEventListener('change', e => {
    vetoSteps[+e.target.dataset.i].map = e.target.value
    renderVetoBuilder()
  }))
}

async function loadVetos() {
  const { data, error } = await supabase
    .from('veto_predictions').select('*')
    .eq('team_id', getTeamId())
    .order('created_at', { ascending: false })
  if (error) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">Failed to load</h3>${esc(error.message)}</div>`
    return
  }
  state.vetos = data ?? []
  state.logos = await Promise.all(state.vetos.map(v => getTeamLogo(v.opponent ?? v.title)))
  renderAll()
}

// ── Hero ──────────────────────────────────────────────────────
function renderHero() {
  const s = deriveVetoStats(state.vetos)
  const wash = s.mostBanned ? mapBg(s.mostBanned) : ''
  heroEl.innerHTML = `
    <div class="dx-hero-grid">
      <div class="dx-hero-left">
        <div class="dx-hero-title">MAP VETO</div>
        <div class="dx-hero-count">${s.total}<span class="dx-hero-count-unit">${s.total === 1 ? ' veto' : ' vetos'}</span></div>
        <div class="dx-hero-substats">
          <div class="dx-kv"><div class="dx-kv-k">BO1</div><div class="dx-kv-v">${s.bo1}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">BO3</div><div class="dx-kv-v">${s.bo3}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Top opponent</div><div class="dx-kv-v">${s.topOpponent ? esc(s.topOpponent) : '—'}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Most banned</div><div class="dx-kv-v">${s.mostBanned ? esc(MAP_LABELS[s.mostBanned] ?? s.mostBanned) : '—'}</div></div>
        </div>
        <div class="dx-hero-actions">
          <button type="button" class="dx-upload-cta" id="new-veto-btn">+ New Veto</button>
        </div>
      </div>
      <div class="dx-hero-right">
        ${wash ? `<div class="dx-hero-mapwash" style="background-image:url('${esc(wash)}')"></div>` : ''}
      </div>
    </div>`
  document.getElementById('new-veto-btn').addEventListener('click', () => openModal())
}

// ── Filters ───────────────────────────────────────────────────
function distinctOpponentsInOrder(vetos) {
  const seen = new Set(), out = []
  for (const v of vetos) {
    const o = v.opponent
    if (o == null || o === '') continue
    if (!seen.has(o)) { seen.add(o); out.push(o) }
  }
  return out
}

function renderFilters() {
  const f = state.filter
  const opps = distinctOpponentsInOrder(state.vetos)
  const fmtPill = (val, label) =>
    `<button type="button" class="dx-pill ${f.format === val ? 'is-active' : ''}" data-group="format" data-val="${esc(val)}">${esc(label)}</button>`
  const oppPill = (val, label) =>
    `<button type="button" class="dx-pill ${f.opponent === val ? 'is-active' : ''}" data-group="opponent" data-val="${esc(val)}">${esc(label)}</button>`

  const oppRow = opps.length >= 1 ? `
    <div class="dx-filter-divider"></div>
    <div class="dx-filter-group">
      ${oppPill('all', 'All Opponents')}
      ${opps.map(o => oppPill(o, o)).join('')}
    </div>` : ''

  filtersEl.innerHTML = `
    <div class="dx-filter-row">
      <div class="dx-filter-group">
        ${fmtPill('all', 'All Formats')}
        ${fmtPill('bo1', 'BO1')}
        ${fmtPill('bo3', 'BO3')}
      </div>
      ${oppRow}
      <div class="dx-filter-spacer"></div>
      <input type="search" class="dx-search-input" id="veto-search" placeholder="Search vetos…" value="${esc(f.q)}"/>
    </div>`

  for (const btn of filtersEl.querySelectorAll('.dx-pill')) {
    btn.addEventListener('click', () => {
      const g = btn.dataset.group, v = btn.dataset.val
      if (state.filter[g] === v) return
      state.filter = { ...state.filter, [g]: v }
      saveFilter(state.filter)
      renderFilters(); renderList()
    })
  }
  document.getElementById('veto-search').addEventListener('input', e => {
    state.filter = { ...state.filter, q: e.target.value }
    saveFilter(state.filter)
    renderList()
  })
}

// ── List ──────────────────────────────────────────────────────
function renderList() {
  const filtered = filterVetos(state.vetos, state.filter)
  if (state.vetos.length === 0) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">No veto predictions yet</h3>Create one with the button above.</div>`
    return
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="dx-empty">No vetos match the current filters.</div>`
    return
  }
  // Index-align logos with the FULL vetos list. After filtering, use original index.
  const vetoIndex = new Map(state.vetos.map((v, i) => [v.id, i]))
  listEl.innerHTML = `<div class="veto-grid">${filtered.map(v => vetoCard(v, state.logos[vetoIndex.get(v.id)])).join('')}</div>`
  for (const btn of listEl.querySelectorAll('[data-edit]')) {
    btn.addEventListener('click', e => { e.stopPropagation(); openModal(btn.dataset.edit) })
  }
}

function vetoCard(v, logo) {
  const steps = (v.steps ?? []).filter(s => s.map)
  const arrowSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>`
  const stepsHtml = steps.map((s, i) => {
    const teamLabel = s.team === 'home' ? (v.home || 'Us') : s.team === 'away' ? (v.away || 'Them') : 'Decider'
    const img = MAP_IMAGES[s.map] ?? ''
    const action = s.type === 'ban' ? 'BAN' : s.type === 'pick' ? 'PICK' : 'PLAYS'
    return `${i > 0 ? `<div class="veto-arrow">${arrowSvg}</div>` : ''}
      <div class="veto-step veto-step-${s.type}">
        ${img ? `<div class="veto-step-bg" style="background-image:url('${img}')"></div>` : ''}
        <div class="veto-step-content">
          <span class="veto-step-num">#${i + 1}</span>
          <span class="veto-step-action veto-step-action-${s.type}">${action}</span>
          <div class="veto-step-map">${esc(MAP_LABELS[s.map] ?? s.map)}</div>
          <div class="veto-step-team">${esc(teamLabel)}</div>
        </div>
      </div>`
  }).join('')
  return `<div class="veto-flow-card">
    <div class="veto-flow-head">
      <div style="display:flex;align-items:center;gap:12px;min-width:0">
        ${teamLogoEl(logo, v.opponent ?? v.title, 40)}
        <div style="min-width:0">
          <div class="veto-flow-title">${esc(v.title)}</div>
          <div class="veto-flow-meta">${v.opponent ? esc(v.opponent) + ' · ' : ''}${v.format.toUpperCase()}</div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" data-edit="${esc(v.id)}">Edit</button>
    </div>
    ${steps.length
      ? `<div class="veto-flow">${stepsHtml}</div>`
      : `<div class="veto-step-empty" style="padding:8px 0">No veto steps recorded.</div>`}
    ${v.notes ? `<div style="color:var(--muted);font-size:12px;margin-top:10px">${esc(v.notes)}</div>` : ''}
  </div>`
}

// ── Modal ─────────────────────────────────────────────────────
function openModal(id = null) {
  editingId = id
  const v = id ? state.vetos.find(x => String(x.id) === String(id)) : null
  document.getElementById('modal-title').textContent = id ? 'Edit Veto' : 'New Veto'
  document.getElementById('f-title').value    = v?.title    ?? ''
  const opp = v?.opponent ?? ''
  document.getElementById('f-opponent').value = opp
  getTeamLogo(opp).then(logo => updateVetoLogo(logo, opp))
  document.getElementById('f-format').value   = v?.format   ?? 'bo1'
  document.getElementById('f-notes').value    = v?.notes    ?? ''
  document.getElementById('f-home').value     = v?.home     ?? 'Us'
  document.getElementById('f-away').value     = v?.away     ?? 'Them'
  vetoSteps = v?.steps ? JSON.parse(JSON.stringify(v.steps)) : []
  document.getElementById('delete-btn').style.display = id ? 'block' : 'none'
  document.getElementById('modal-error').style.display = 'none'
  renderVetoBuilder()
  document.getElementById('modal').style.display = 'flex'
}
function closeModal() { document.getElementById('modal').style.display = 'none'; editingId = null }

document.getElementById('modal-close').addEventListener('click', closeModal)
document.getElementById('cancel-btn').addEventListener('click', closeModal)
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal() })
document.getElementById('f-format').addEventListener('change', () => { vetoSteps = []; renderVetoBuilder() })
document.getElementById('f-home').addEventListener('input', renderVetoBuilder)
document.getElementById('f-away').addEventListener('input', renderVetoBuilder)

document.getElementById('save-btn').addEventListener('click', async () => {
  const title    = document.getElementById('f-title').value.trim()
  const opponent = document.getElementById('f-opponent').value.trim() || null
  const format   = document.getElementById('f-format').value
  const notes    = document.getElementById('f-notes').value.trim() || null
  const errEl    = document.getElementById('modal-error')
  if (!title) { errEl.textContent = 'Title is required.'; errEl.style.display = 'block'; return }
  const home = document.getElementById('f-home').value.trim() || 'Us'
  const away = document.getElementById('f-away').value.trim() || 'Them'
  const payload = { title, opponent, format, steps: vetoSteps, notes, home, away, team_id: getTeamId(), updated_at: new Date().toISOString() }
  let error
  if (editingId) ({ error } = await supabase.from('veto_predictions').update(payload).eq('id', editingId))
  else           ({ error } = await supabase.from('veto_predictions').insert(payload))
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return }
  const wasEditing = !!editingId
  closeModal(); toast(wasEditing ? 'Veto updated' : 'Veto saved'); loadVetos()
})

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this veto prediction?')) return
  const { error } = await supabase.from('veto_predictions').delete().eq('id', editingId)
  if (error) { document.getElementById('modal-error').textContent = error.message; document.getElementById('modal-error').style.display = 'block'; return }
  closeModal(); toast('Veto deleted'); loadVetos()
})

const vetoOppInput    = document.getElementById('f-opponent')
const vetoOppLogoWrap = document.getElementById('veto-opp-logo')

function updateVetoLogo(logo, name) {
  vetoOppLogoWrap.innerHTML = logo || name ? teamLogoEl(logo, name, 36) : ''
}

attachTeamAutocomplete(vetoOppInput, team => updateVetoLogo(team.logo, team.name))

vetoOppInput.addEventListener('input', async () => {
  const n = vetoOppInput.value.trim()
  updateVetoLogo(n ? await getTeamLogo(n) : null, n)
})

function renderAll() { renderHero(); renderFilters(); renderList() }

loadVetos()
```

- [ ] **Step 3: Append CSS block at end of `cs2-hub/style.css`**

```css

/* ── Map Veto (tactical hero/filters) ────────────────────────── */
.veto-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}
```

(All `.veto-flow-card`, `.veto-step`, `.veto-arrow` rules already exist and stay unchanged.)

- [ ] **Step 4: Re-run helper tests**

Open both `cs2-hub/veto-stats.test.html` and `cs2-hub/veto-filter.test.html`. Both must show `X passed, 0 failed`.

- [ ] **Step 5: Manual browser verification**

Open `cs2-hub/veto.html` via the dev server.

Check:
- Hero shows MAP VETO title, total count, BO1/BO3 sub-stats, top opponent, most-banned map. Right column shows the most-banned map's wash if any.
- Format pills (All / BO1 / BO3) and opponent pills render; opponent pill row hides if no opponents exist.
- Search input filters by title / opponent / notes / step map.
- Filter state persists across reload (localStorage `veto:filter:v1`).
- Cards render in a single column. `.veto-step` flow visualization unchanged.
- `+ New Veto` and `Edit` open the existing modal; opponent autocomplete + logo still work; save/delete still work.
- Empty data state and empty-filter state both render correctly.

- [ ] **Step 6: Commit**

```bash
git add cs2-hub/veto.html cs2-hub/veto.js cs2-hub/style.css
git commit -m "feat(veto): tactical hero + reskinned filters + redesigned cards"
```

---

# Task 7: Anti-Strat — `deriveOpponentStats` helper (TDD)

**Files:**
- Modify: `cs2-hub/opponents.js`
- Create: `cs2-hub/opponents-stats.test.html`

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/opponents-stats.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<h1>opponents-stats tests</h1>
<pre id="out"></pre>
<script type="module">
import { deriveOpponentStats } from './opponents.js'

const out = document.getElementById('out')
let pass = 0, fail = 0
function assert(cond, msg) {
  const line = (cond ? '✓ ' : '✗ ') + msg
  out.textContent += line + '\n'
  if (cond) pass++; else fail++
}

// Empty
let s = deriveOpponentStats([], {})
assert(s.total === 0,        'empty: total = 0')
assert(s.withMaps === 0,     'empty: withMaps = 0')
assert(s.threats === 0,      'empty: threats = 0')
assert(s.favored === 0,      'empty: favored = 0')
assert(s.mapsCovered === 0,  'empty: mapsCovered = 0')
assert(s.topMap === null,    'empty: topMap = null')

// Mixed. threatTagCls inputs:
//  - strong = wp ≤ 33% with ≥2 matches
//  - weak   = wp ≥ 67% with ≥2 matches
//  - new    = matches < 2
const opps = [
  { name: 'A',  favored_maps: ['mirage', 'inferno'] },
  { name: 'B',  favored_maps: ['mirage'] },
  { name: 'C',  favored_maps: [] },
  { name: 'D',  favored_maps: ['inferno', 'nuke'] },
]
// Simulated history index keyed by lowercased name:
const history = {
  a: { matches: 4, mw: 1, ml: 3 },   // wp=25 → strong
  b: { matches: 3, mw: 3, ml: 0 },   // wp=100 → weak
  c: { matches: 1, mw: 1, ml: 0 },   // matches<2 → new
  // d: no history → new
}
s = deriveOpponentStats(opps, history)
assert(s.total === 4,         'mixed: total = 4')
assert(s.withMaps === 3,      'mixed: withMaps = 3 (A, B, D)')
assert(s.threats === 1,       'mixed: threats = 1 (A)')
assert(s.favored === 1,       'mixed: favored = 1 (B)')
// Distinct maps across all favored_maps: mirage, inferno, nuke = 3
assert(s.mapsCovered === 3,   `mixed: mapsCovered = 3 (got ${s.mapsCovered})`)
// mirage appears 2x (A, B), inferno 2x (A, D), nuke 1x (D)
// Tie between mirage and inferno → first-appearance wins → mirage (from A's first slot)
assert(s.topMap === 'mirage', `mixed: topMap = mirage (got ${s.topMap})`)

out.textContent += `\n${pass} passed, ${fail} failed\n`
</script>
</body>
</html>
```

- [ ] **Step 2: Run and verify failure**

Open `cs2-hub/opponents-stats.test.html`. Expected: import error.

- [ ] **Step 3: Add the helper**

Add to `cs2-hub/opponents.js`, immediately after the `esc` helper (around line 11):

```js
export function deriveOpponentStats(opponents, historyIndex) {
  const total = opponents.length
  if (total === 0) return { total: 0, withMaps: 0, threats: 0, favored: 0, mapsCovered: 0, topMap: null }
  let withMaps = 0, threats = 0, favored = 0
  const mapCounts = new Map()   // map -> { n, firstIdx }
  for (let i = 0; i < opponents.length; i++) {
    const o = opponents[i]
    const maps = o.favored_maps ?? []
    if (maps.length > 0) withMaps++
    for (const m of maps) {
      const e = mapCounts.get(m)
      if (e) e.n++; else mapCounts.set(m, { n: 1, firstIdx: i })
    }
    const h = historyIndex?.[(o.name ?? '').trim().toLowerCase()]
    if (h && h.matches >= 2) {
      const wp = (h.mw / h.matches) * 100
      if (wp <= 33) threats++
      else if (wp >= 67) favored++
    }
  }
  let topMap = null, top = 0, topIdx = Infinity
  for (const [k, { n, firstIdx }] of mapCounts) {
    if (n > top || (n === top && firstIdx < topIdx)) { topMap = k; top = n; topIdx = firstIdx }
  }
  return { total, withMaps, threats, favored, mapsCovered: mapCounts.size, topMap }
}
```

- [ ] **Step 4: Run and verify pass**

Reload `cs2-hub/opponents-stats.test.html`. Expected: `12 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/opponents.js cs2-hub/opponents-stats.test.html
git commit -m "test(opponents): deriveOpponentStats helper"
```

---

# Task 8: Anti-Strat — `filterOpponents` helper (TDD)

**Files:**
- Modify: `cs2-hub/opponents.js`
- Create: `cs2-hub/opponents-filter.test.html`

- [ ] **Step 1: Write the failing test**

Create `cs2-hub/opponents-filter.test.html`:

```html
<!DOCTYPE html>
<html>
<body>
<h1>opponents-filter tests</h1>
<pre id="out"></pre>
<script type="module">
import { filterOpponents } from './opponents.js'

const out = document.getElementById('out')
let pass = 0, fail = 0
function assert(cond, msg) {
  const line = (cond ? '✓ ' : '✗ ') + msg
  out.textContent += line + '\n'
  if (cond) pass++; else fail++
}

const opps = [
  { id: 1, name: 'NAVI',     favored_maps: ['mirage', 'inferno'] },
  { id: 2, name: 'Vitality', favored_maps: ['mirage'] },
  { id: 3, name: 'FaZe',     favored_maps: [] },
  { id: 4, name: 'G2',       favored_maps: ['nuke'] },
]
const history = {
  navi:     { matches: 4, mw: 1, ml: 3 },  // strong
  vitality: { matches: 3, mw: 3, ml: 0 },  // weak
  faze:     { matches: 1, mw: 1, ml: 0 },  // new
  // g2: no history → new
}

// All
let r = filterOpponents(opps, { map: 'all', threat: 'all', q: '' }, history)
assert(r.length === 4, `all → 4 (got ${r.length})`)

// Map filter
r = filterOpponents(opps, { map: 'mirage', threat: 'all', q: '' }, history)
assert(r.length === 2 && r.every(o => o.favored_maps.includes('mirage')), `map=mirage → 2`)

// Threat filter — strong
r = filterOpponents(opps, { map: 'all', threat: 'strong', q: '' }, history)
assert(r.length === 1 && r[0].name === 'NAVI', `threat=strong → NAVI`)

// Threat filter — weak
r = filterOpponents(opps, { map: 'all', threat: 'weak', q: '' }, history)
assert(r.length === 1 && r[0].name === 'Vitality', `threat=weak → Vitality`)

// Threat filter — new (both <2 matches AND no history)
r = filterOpponents(opps, { map: 'all', threat: 'new', q: '' }, history)
assert(r.length === 2 && r.some(o => o.name === 'FaZe') && r.some(o => o.name === 'G2'), `threat=new → FaZe + G2`)

// Search by name (case-insensitive)
r = filterOpponents(opps, { map: 'all', threat: 'all', q: 'navi' }, history)
assert(r.length === 1 && r[0].name === 'NAVI', `q=navi → NAVI`)

// Combined: map + threat
r = filterOpponents(opps, { map: 'mirage', threat: 'strong', q: '' }, history)
assert(r.length === 1 && r[0].name === 'NAVI', `combined map+threat → NAVI`)

// Opponent with empty favored_maps excluded from any named map filter
r = filterOpponents(opps, { map: 'mirage', threat: 'all', q: '' }, history)
assert(!r.some(o => o.name === 'FaZe'), `FaZe excluded from map filter`)

out.textContent += `\n${pass} passed, ${fail} failed\n`
</script>
</body>
</html>
```

- [ ] **Step 2: Run and verify failure**

Open `cs2-hub/opponents-filter.test.html`. Expected: import error.

- [ ] **Step 3: Add the helper**

Add to `cs2-hub/opponents.js`, immediately after `deriveOpponentStats`:

```js
// Returns 'strong' | 'even' | 'weak' | 'new' for an opponent given its history row.
export function opponentThreatClass(history) {
  if (!history || history.matches === 0) return 'new'
  if (history.matches < 2) return 'new'
  const wp = (history.mw / history.matches) * 100
  if (wp <= 33) return 'strong'
  if (wp >= 67) return 'weak'
  return 'even'
}

export function filterOpponents(opponents, filter, historyIndex) {
  const q = (filter.q ?? '').toLowerCase().trim()
  return opponents.filter(o => {
    if (filter.map !== 'all') {
      if (!(o.favored_maps ?? []).includes(filter.map)) return false
    }
    if (filter.threat !== 'all') {
      const h = historyIndex?.[(o.name ?? '').trim().toLowerCase()]
      if (opponentThreatClass(h) !== filter.threat) return false
    }
    if (!q) return true
    return (o.name ?? '').toLowerCase().includes(q)
  })
}
```

Note: `opponentThreatClass` is the same logic as the existing `threatTag` function in `opponents.js` — but `threatTag` also returns a display label. We keep `threatTag` for the card rendering and add `opponentThreatClass` as a pure helper for filtering. Both are exported so the test file can import the class-only version.

- [ ] **Step 4: Run and verify pass**

Reload `cs2-hub/opponents-filter.test.html`. Expected: `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add cs2-hub/opponents.js cs2-hub/opponents-filter.test.html
git commit -m "test(opponents): filterOpponents helper"
```

---

# Task 9: Anti-Strat — HTML shell, JS render layer, CSS

**Files:**
- Modify: `cs2-hub/opponents.html`
- Modify: `cs2-hub/opponents.js`
- Modify: `cs2-hub/style.css`

- [ ] **Step 1: Replace `opponents.html` body**

Replace the entire `<main class="main-content">…</main>` block in `cs2-hub/opponents.html` with:

```html
  <main class="main-content">

    <section id="opp-hero"    class="dx-hero"><div class="dx-hero-loading">Loading…</div></section>
    <section id="opp-filters" class="dx-filters"></section>

    <div id="opponents-list"></div>
  </main>
```

- [ ] **Step 2: Replace the body of `opponents.js`**

Keep the top imports, the `esc` helper, the `MAP_IMG` / `mapChip` helpers, the existing `buildHistoryIndex` and `threatTag` functions, plus the new `deriveOpponentStats`, `opponentThreatClass`, and `filterOpponents` exports. Replace everything from `await requireAuth()` onward with this:

```js
const MAPS = ['ancient', 'mirage', 'nuke', 'anubis', 'inferno', 'overpass', 'dust2']
const MAP_LABELS = { ancient:'Ancient', mirage:'Mirage', nuke:'Nuke', anubis:'Anubis', inferno:'Inferno', overpass:'Overpass', dust2:'Dust2' }
function mapFile(map) { return MAP_IMG[map] ?? map }
function mapBg(map)   { return map ? `images/maps/${mapFile(map)}.png` : '' }

await requireAuth()
renderSidebar('opponents')

const FILTER_LS_KEY = 'opponents:filter:v1'
const DEFAULT_FILTER = { map: 'all', threat: 'all', q: '' }
function loadSavedFilter() {
  try { return { ...DEFAULT_FILTER, ...JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '{}') } }
  catch { return { ...DEFAULT_FILTER } }
}
function saveFilter(f) { try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify(f)) } catch {} }

const state = {
  filter: loadSavedFilter(),
  opponents: [],
  history: {},
  logos: [],          // index-aligned with opponents
}

const heroEl    = document.getElementById('opp-hero')
const filtersEl = document.getElementById('opp-filters')
const listEl    = document.getElementById('opponents-list')

const teamId = getTeamId()

async function loadAll() {
  const [{ data: opponents, error }, { data: vods }] = await Promise.all([
    supabase.from('opponents').select('*').eq('team_id', teamId).order('name', { ascending: true }),
    supabase.from('vods').select('opponent, title, maps').eq('team_id', teamId).eq('dismissed', false),
  ])
  if (error) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">Failed to load opponents</h3>${esc(error.message)}</div>`
    return
  }
  state.opponents = opponents ?? []
  state.history   = buildHistoryIndex(vods)
  state.logos     = await Promise.all(state.opponents.map(o => getTeamLogo(o.name)))
  renderAll()
}

// ── Hero ──────────────────────────────────────────────────────
function renderHero() {
  const s = deriveOpponentStats(state.opponents, state.history)
  const wash = s.topMap ? mapBg(s.topMap) : ''
  heroEl.innerHTML = `
    <div class="dx-hero-grid">
      <div class="dx-hero-left">
        <div class="dx-hero-title">ANTI-STRAT</div>
        <div class="dx-hero-count">${s.total}<span class="dx-hero-count-unit">${s.total === 1 ? ' team' : ' teams'}</span></div>
        <div class="dx-hero-substats">
          <div class="dx-kv"><div class="dx-kv-k">With maps</div><div class="dx-kv-v">${s.withMaps}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Threats</div><div class="dx-kv-v" style="color:var(--danger)">${s.threats}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Favored</div><div class="dx-kv-v" style="color:var(--success)">${s.favored}</div></div>
          <div class="dx-kv"><div class="dx-kv-k">Maps covered</div><div class="dx-kv-v">${s.mapsCovered}</div></div>
        </div>
        <div class="dx-hero-actions">
          <a class="dx-upload-cta" href="opponent-detail.html">+ Add Team</a>
        </div>
      </div>
      <div class="dx-hero-right">
        ${wash ? `<div class="dx-hero-mapwash" style="background-image:url('${esc(wash)}')"></div>` : ''}
      </div>
    </div>`
}

// ── Filters ───────────────────────────────────────────────────
function renderFilters() {
  const f = state.filter
  const mapPill = (val, label) =>
    `<button type="button" class="dx-pill ${f.map === val ? 'is-active' : ''}" data-group="map" data-val="${esc(val)}">${esc(label)}</button>`
  const threatPill = (val, label) =>
    `<button type="button" class="dx-pill ${f.threat === val ? 'is-active' : ''}" data-group="threat" data-val="${esc(val)}">${esc(label)}</button>`

  filtersEl.innerHTML = `
    <div class="dx-filter-row">
      <div class="dx-filter-group">
        ${mapPill('all', 'All Maps')}
        ${MAPS.map(m => mapPill(m, MAP_LABELS[m])).join('')}
      </div>
    </div>
    <div class="dx-filter-row" style="margin-top:8px">
      <div class="dx-filter-group">
        ${threatPill('all',    'All Threats')}
        ${threatPill('strong', 'Threats')}
        ${threatPill('even',   'Even')}
        ${threatPill('weak',   'Favored')}
        ${threatPill('new',    'No History')}
      </div>
      <div class="dx-filter-spacer"></div>
      <input type="search" class="dx-search-input" id="opp-search" placeholder="Search opponents…" value="${esc(f.q)}"/>
    </div>`

  for (const btn of filtersEl.querySelectorAll('.dx-pill')) {
    btn.addEventListener('click', () => {
      const g = btn.dataset.group, v = btn.dataset.val
      if (state.filter[g] === v) return
      state.filter = { ...state.filter, [g]: v }
      saveFilter(state.filter)
      renderFilters(); renderList()
    })
  }
  document.getElementById('opp-search').addEventListener('input', e => {
    state.filter = { ...state.filter, q: e.target.value }
    saveFilter(state.filter)
    renderList()
  })
}

// ── List ──────────────────────────────────────────────────────
function renderList() {
  const filtered = filterOpponents(state.opponents, state.filter, state.history)
  if (state.opponents.length === 0) {
    listEl.innerHTML = `<div class="dx-empty"><h3 style="margin:0 0 6px;font-weight:700">No opponents yet</h3>Add a team before your next match.</div>`
    return
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="dx-empty">No opponents match the current filters.</div>`
    return
  }
  const oppIndex = new Map(state.opponents.map((o, i) => [o.id, i]))
  listEl.innerHTML = `<div class="intel-grid">${filtered.map(o => opponentCard(o, state.logos[oppIndex.get(o.id)])).join('')}</div>`
}

function opponentCard(o, logo) {
  const h = state.history[(o.name ?? '').trim().toLowerCase()]
  const tag = threatTag(h)
  const topMap = (o.favored_maps ?? [])[0]
  const wash = topMap ? mapBg(topMap) : ''
  return `
    <a class="intel-card ${wash ? 'intel-card-has-wash' : ''}" href="opponent-detail.html?id=${esc(o.id)}">
      ${wash ? `<div class="intel-card-wash" style="background-image:url('${esc(wash)}')"></div>` : ''}
      <div class="intel-head">
        ${teamLogoEl(logo, o.name, 36)}
        <div class="intel-name">${esc(o.name)}</div>
        <span class="intel-tag intel-tag-${tag.cls}">${tag.label}</span>
      </div>
      <div class="intel-section-label">Favored maps</div>
      ${o.favored_maps?.length
        ? `<div class="intel-maps">${o.favored_maps.map(mapChip).join('')}</div>`
        : `<div class="intel-empty">No maps noted</div>`}
    </a>
  `
}

function renderAll() { renderHero(); renderFilters(); renderList() }

loadAll()
```

- [ ] **Step 3: Append CSS block at end of `cs2-hub/style.css`**

```css

/* ── Anti-Strat (tactical hero/filters) ──────────────────────── */
.intel-card { position: relative; overflow: hidden; }
.intel-card-wash {
  position: absolute; inset: 0;
  background-size: cover; background-position: center;
  opacity: 0.08;
  pointer-events: none;
}
.intel-card-has-wash::before {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(15,25,38,0.30) 0%, rgba(15,25,38,0.92) 100%);
  pointer-events: none;
}
.intel-card > *:not(.intel-card-wash) { position: relative; z-index: 1; }
```

Note: `.intel-card` already has its base styling (background, border, padding, hover) defined around line 1309 of `style.css`. Only the `position: relative; overflow: hidden;` and the wash overlay layer are new. Existing rules continue to apply.

- [ ] **Step 4: Re-run helper tests**

Open both `cs2-hub/opponents-stats.test.html` and `cs2-hub/opponents-filter.test.html`. Both must show `X passed, 0 failed`.

- [ ] **Step 5: Manual browser verification**

Open `cs2-hub/opponents.html` via the dev server.

Check:
- Hero shows ANTI-STRAT title, total team count, `With maps`, `Threats` (danger color), `Favored` (success color), `Maps covered`. Right column shows the most-covered map's wash if any.
- Top row of filter pills: All Maps + 7 map pills.
- Second row: threat pills (`All Threats / Threats / Even / Favored / No History`) + search input.
- Map pill filters to opponents whose `favored_maps` includes it (opponents with empty `favored_maps` are excluded from any named map filter, as the test asserts).
- Threat pill matches `opponentThreatClass`. `No History` includes both `matches < 2` and missing history rows.
- Search filters by opponent name (case-insensitive).
- Filter state persists across reload (localStorage `opponents:filter:v1`).
- Cards have a subtle map wash behind them (low opacity) when `favored_maps` is non-empty; chips render in front; threat tag in the top-right.
- Clicking a card still navigates to `opponent-detail.html?id=<id>` (unchanged).
- Empty data state and empty-filter state render correctly.

- [ ] **Step 6: Commit**

```bash
git add cs2-hub/opponents.html cs2-hub/opponents.js cs2-hub/style.css
git commit -m "feat(antistrat): tactical hero + reskinned filters + redesigned cards"
```

---

# Task 10: Final cross-page verification

- [ ] **Step 1: Re-run every helper test page**

Open each of the six test files in a browser and confirm all show `X passed, 0 failed`:

```
cs2-hub/keywords-stats.test.html
cs2-hub/keywords-filter.test.html
cs2-hub/veto-stats.test.html
cs2-hub/veto-filter.test.html
cs2-hub/opponents-stats.test.html
cs2-hub/opponents-filter.test.html
```

- [ ] **Step 2: Navigate the three pages in sequence**

Visit `cs2-hub/keywords.html`, `cs2-hub/veto.html`, `cs2-hub/opponents.html` and confirm visual parity with the existing tactical pages (stratbook, issues, goals). Side-by-side comparison: the hero typography, the filter pill style, and the card grid should all read as the same family.

- [ ] **Step 3: Smoke-test downstream pages that link in**

The sidebar nav, the dashboard quicklinks, and `opponent-detail.html` all reference these pages by URL. Click through:
- Sidebar → Keywords, Map Veto, Anti-Strat (all render).
- Anti-Strat card → Opponent detail (loads correctly).
- Opponent detail → "← Opponents" link (back to Anti-Strat).

- [ ] **Step 4: No commit needed**

If all checks pass, the three feature commits already on the branch are the complete deliverable. If any check fails, fix in a follow-up commit before opening a PR.

---

## Spec Coverage Self-Check

- §4 shared pattern (dx-hero + dx-filters + list slot) — Tasks 3, 6, 9 each replicate the shell.
- §5 Keywords hero stats — `deriveKeywordStats` in Task 1; rendered in Task 3.
- §5 Keywords filters — `filterKeywords` in Task 2; category pills + search in Task 3.
- §5 Keywords card — `kw-card` rules in Task 3.
- §6 Veto hero stats — `deriveVetoStats` in Task 4; rendered in Task 6.
- §6 Veto filters — `filterVetos` in Task 5; format + opponent pills + search in Task 6.
- §6 Veto card — existing `veto-flow-card` preserved in Task 6.
- §7 Anti-Strat hero stats — `deriveOpponentStats` in Task 7; rendered in Task 9.
- §7 Anti-Strat filters — `filterOpponents` in Task 8; map + threat pills + search in Task 9.
- §7 Anti-Strat card — existing `intel-card` preserved with new wash overlay in Task 9.
- §8 file-level changes — every modify/create call out in the file map is hit by one task.
- §9 testing — six `*.test.html` files, one per task pair (Tasks 1, 2, 4, 5, 7, 8).
- §10 migration / risk — no DB or URL changes; modals untouched; localStorage keys are new.
- §11 implementation order — keywords → veto → anti-strat, each a separate `feat(...)` commit.
