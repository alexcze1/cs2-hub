# Keywords / Map Veto / Anti-Strat — Tactical Redesign

**Date:** 2026-05-16
**Status:** Draft — awaiting user review before plan
**Scope:** `cs2-hub/keywords.html` + `keywords.js`, `cs2-hub/veto.html` + `veto.js`, `cs2-hub/opponents.html` + `opponents.js` (sidebar label: "Anti-Strat")

---

## 1. Goal

Bring the last three list pages — Keywords, Map Veto, Anti-Strat — up to parity with the recent tactical redesigns (stratbook, issues, goals, demos, results). Each page adopts the same shape:

1. `dx-hero` summary block (title, primary count, sub-stats, right-side visual wash, action CTAs)
2. `dx-filters` pill row + search input
3. A redesigned card grid that keeps the current data shape but adopts the tactical visual treatment
4. Existing modals preserved as-is (matches how issues / goals were handled)

No URL, sidebar, or data-model changes. No new DB columns. No new computed fields beyond what's needed to render the heroes from data already on the page.

---

## 2. Constraints

- Reuse existing CSS tokens and classes in `cs2-hub/style.css`: `--accent`, `--danger`, `--success`, `--warning`, `--special`, `--muted`, `--surface`, `--glass-bg`, `--glass-border`, `--text`, `--display-font`. Reuse `.dx-hero`, `.dx-hero-grid`, `.dx-hero-title`, `.dx-hero-count`, `.dx-hero-count-unit`, `.dx-hero-substats`, `.dx-kv`, `.dx-hero-actions`, `.dx-upload-cta`, `.dx-ghost-cta`, `.dx-hero-right`, `.dx-hero-mapwash`, `.dx-filters`, `.dx-filter-row`, `.dx-filter-group`, `.dx-filter-divider`, `.dx-filter-spacer`, `.dx-pill`, `.dx-search-input`, `.dx-empty`. No new tokens introduced.
- Page URLs (`keywords.html`, `veto.html`, `opponents.html`) and sidebar nav keys (`'keywords'`, `'veto'`, `'opponents'`) are unchanged.
- Modals stay structurally identical. They use existing `form-group`, `form-input`, `form-select`, `form-textarea`, `btn` classes which were not part of the tactical pass.
- Existing helpers stay: `auth.requireAuth`, `layout.renderSidebar`, `supabase`, `getTeamId`, `toast`, `team-autocomplete.{getTeamLogo, teamLogoEl, attachTeamAutocomplete}`.
- Cards keep their current data: keywords show name/category/description; veto cards keep the existing veto-flow visualization (`.veto-step`, `.veto-arrow`); anti-strat cards keep logo + name + threat tag + favored maps chips. Only the surrounding card shell shifts to the tactical treatment.

---

## 3. Out of Scope (deferred)

- `opponent-detail.html` editor (per-team gameplan, map tabs, positions grid, plan sheets). Detail page keeps current visuals.
- The `antistrat-drawer` component embedded in demo viewer and analysis pages.
- Modal visual restyle (forms, inputs, buttons).
- Any data-model or DB schema changes (no new tables, columns, or computed fields persisted to Supabase).
- New filters or computed values not derivable from existing rows.

---

## 4. Shared Page Pattern

All three pages adopt the same top-to-bottom shell. Markup mirrors stratbook.html:

```html
<main class="main-content">
  <section id="<key>-hero"    class="dx-hero"><div class="dx-hero-loading">Loading…</div></section>
  <section id="<key>-filters" class="dx-filters"></section>
  <!-- existing modal stays here, unchanged -->
  <div id="<key>-list"></div>
</main>
```

Hero layout (`dx-hero-grid`) is two-column:
- **Left:** title (uppercase, display font), primary count + unit, sub-stats grid (`dx-kv`), action CTAs (primary + optional ghost).
- **Right:** `dx-hero-mapwash` background image when there's a sensible visual; empty otherwise. Map wash uses `images/maps/<map>.png` (with `dust2 → dust` mapping that already exists in stratbook.js).

Filter row is built from `dx-pill` buttons grouped by filter dimension, with a `dx-search-input` in the right spacer. Active filter state is held in a per-page `state.filter` object, persisted to `localStorage` under a versioned key (`<page>:filter:v1`), and restored on load. Pattern matches stratbook.js's `loadSavedFilter` / `saveFilter`.

Empty states use `dx-empty`:
- No rows at all (data layer empty): full-card empty state with title + CTA copy.
- Rows exist but filter excludes all: small empty card with "No <items> match the current filters."

---

## 5. Page: Keywords

### Hero
- **Title:** `KEYWORDS`
- **Count:** `state.keywords.length` + unit (` term` / ` terms`)
- **Sub-stats** (`dx-kv`):
  - `Categories` — distinct non-null `category` values, count
  - `Uncategorized` — count where `category` is null/empty
  - `Top category` — most frequent category name, or `—`
  - `Latest` — `name` of most-recently `created_at` keyword, or `—`
- **CTAs:** `+ Add Keyword` (primary, opens existing modal)
- **Right wash:** none (keywords have no map). Hero right column collapses gracefully — the existing CSS for `.dx-hero-right` already handles an empty child.

### Filters
- Category pills: `All Categories` + one pill per distinct category found in `state.keywords`. Categories are rendered in insertion order of first appearance (no alphabetic re-sort, to keep the row stable as the user edits).
- Search input on the right: matches on `name`, `description`, `category` (case-insensitive, same predicate as today's `renderKeywords`).
- Active filter state: `{ category: 'all' | <string>, q: '' }`. Persisted to `localStorage` key `keywords:filter:v1`.

### Card
Per-card data unchanged from today (name, category badge, description). Card shell becomes a `kw-card` div using the tactical treatment:
- `background: var(--glass-bg)`, `border: 1px solid var(--glass-border)`, `border-radius: 10px`, `padding: 14px`.
- Hover: subtle lift (`transform: translateY(-2px)`) and accent glow, matches `sb-card` hover.
- Layout: top row = name (700, 15px) + Edit ghost button; row 2 = category tag (`dx-pill`-like inline label, accent-tinted) if present; row 3 = description (`color: var(--muted)`, 13px, 1.5 line height).
- Grid: `display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px`. Same as today.

Modal preserved exactly as in current `keywords.html`.

---

## 6. Page: Map Veto

### Hero
- **Title:** `MAP VETO`
- **Count:** `state.vetos.length` + unit (` veto` / ` vetos`)
- **Sub-stats** (`dx-kv`):
  - `BO1` — count where `format === 'bo1'`
  - `BO3` — count where `format === 'bo3'`
  - `Top opponent` — most-faced opponent name (mode of `opponent`), or `—`
  - `Most banned` — map appearing most often in steps with `type === 'ban'` across all vetos, or `—`
- **CTAs:** `+ New Veto` (primary, opens existing modal)
- **Right wash:** background image of the `Most banned` map, using `images/maps/<map>.png` with the `dust2 → dust` mapping. If no `ban` steps exist across all vetos, no wash.

### Filters
- Format pills: `All` / `BO1` / `BO3`. Active state on `f.format`.
- Opponent pills: `All Opponents` + one pill per distinct `opponent` value (first appearance order). Hidden when there's only one or zero distinct opponents.
- Search input on the right: matches `title`, `opponent`, `notes`, and any `step.map` label (case-insensitive).
- Active filter state: `{ format: 'all' | 'bo1' | 'bo3', opponent: 'all' | <string>, q: '' }`. Persisted to `localStorage` key `veto:filter:v1`.

### Card
Keep today's `veto-flow-card` data and the `.veto-step` flow visualization (numbered steps, action labels, map images, arrows). What changes:
- Outer card shell adopts the tactical treatment (glass bg, border, hover lift) consistent with `sb-card`.
- Header row: opponent logo (40px) + title (uppercase, 700, 15px) + meta line (`opponent · FORMAT`, 12px muted) + right-aligned `Edit` ghost button. Unchanged data, just the head gets the tactical typography.
- The existing `.veto-step` / `.veto-arrow` flow inside the card is untouched — those classes already match the visual system and re-styling them is out of scope.
- Grid: vertical stack (`display: grid; grid-template-columns: 1fr; gap: 14px`). Veto cards are wide and not easily two-up.

Modal and `attachTeamAutocomplete` wiring preserved exactly.

---

## 7. Page: Anti-Strat (opponents.html)

### Hero
- **Title:** `ANTI-STRAT`
- **Count:** `state.opponents.length` + unit (` team` / ` teams`)
- **Sub-stats** (`dx-kv`):
  - `With maps` — opponents whose `favored_maps` array is non-empty
  - `Threats` — opponents whose `threatTag.cls === 'strong'` (computed against existing `vods` history, same predicate as today's `threatTag`)
  - `Favored` — opponents whose `threatTag.cls === 'weak'`
  - `Maps covered` — distinct map names across all `opponents[*].favored_maps`
- **CTAs:** `+ Add Team` (primary, links to `opponent-detail.html` — same as today)
- **Right wash:** background image of the map with the highest aggregate coverage (most common map across `favored_maps`), or `—` (empty wash) when none.

### Filters
- Map pills: `All Maps` + one pill per `MAPS` constant (same set used in stratbook.js: `ancient, mirage, nuke, anubis, inferno, overpass, dust2`). Active filter keeps only opponents whose `favored_maps` includes that map.
- Threat pills: `All` / `Threats` / `Even` / `Favored` / `No history`. Mapped to `threatTag.cls` values `strong | even | weak | new`.
- Search input on the right: matches `name` (case-insensitive).
- Active filter state: `{ map: 'all' | <map>, threat: 'all' | 'strong' | 'even' | 'weak' | 'new', q: '' }`. Persisted to `localStorage` key `opponents:filter:v1`.

### Card
Per-card data unchanged from today (logo, name, threat tag, favored_maps chips). What changes:
- Today's `intel-card` already uses a card-style shell. The redesign aligns it visually with the new tactical pattern by switching to the same `glass-bg + glass-border + hover lift` surface used by `sb-card`. The internal layout — `intel-head` row, `intel-section-label`, `intel-maps` row of `intel-map-chip` — stays as-is.
- A `dx-hero-mapwash`-style faint background image of the opponent's top favored map is layered behind the card (subtle, low-opacity, accent-tinted gradient overlay so it doesn't compete with the chips). When `favored_maps` is empty, no wash.
- Hover lift consistent with `sb-card`.

No modal on this page (opponent edit happens in `opponent-detail.html`).

---

## 8. File-Level Changes

### Replace
- `cs2-hub/keywords.html` — new tactical shell (hero + filters + list slots) replacing today's `page-header` + search + grid markup. Modal block copied verbatim.
- `cs2-hub/keywords.js` — restructured around `renderHero / renderFilters / renderList` (same shape as `stratbook.js`), with filter persistence and a derived stats helper.
- `cs2-hub/veto.html` — new shell. Modal block (including `veto-builder`, `f-home`/`f-away`, etc.) copied verbatim.
- `cs2-hub/veto.js` — restructured to `renderHero / renderFilters / renderList`. `renderVetoBuilder`, save/delete, autocomplete wiring kept untouched.
- `cs2-hub/opponents.html` — new shell. No modal on this page.
- `cs2-hub/opponents.js` — restructured. `buildHistoryIndex` and `threatTag` kept untouched and reused for hero stats and filter predicates.

### Append-only edits
- `cs2-hub/style.css` — append a `/* ── Keywords / Veto / Anti-Strat (tactical) ── */` block with: `.kw-card` rules, the wash overlay rules for opponent intel cards, and any per-page hero/filter tweaks. No existing `dx-*` or `sb-card` rules edited.

### Keep unchanged
- `cs2-hub/opponent-detail.html` and `opponent-detail.js`
- `cs2-hub/antistrat-drawer.js`, `antistrat-editor.js`
- `cs2-hub/layout.js` (sidebar keys already in place)
- `cs2-hub/team-autocomplete.js`, `cs2-hub/auth.js`, `cs2-hub/toast.js`, `cs2-hub/supabase.js`

---

## 9. Testing

Match the codebase pattern of `*.test.html` files with inline assertions.

- `cs2-hub/keywords-hero.test.html` — derive-hero-stats helper against fixtures: no keywords, all uncategorized, one category, ties for top category. Assert count, categories, uncategorized, top, latest.
- `cs2-hub/keywords-filter.test.html` — filter predicate: category match, search across name/category/description, combined filters, case-insensitivity.
- `cs2-hub/veto-hero.test.html` — derive-hero-stats: empty, all BO1, mixed BO1/BO3, top opponent tiebreaker (first-appearance wins), most-banned map tally across `steps[].type === 'ban'`.
- `cs2-hub/veto-filter.test.html` — format pill, opponent pill, search across title/opponent/notes/step maps, combined filters.
- `cs2-hub/opponents-hero.test.html` — derive-hero-stats: empty roster, all-no-history, mix of threat/even/favored, `Maps covered` distinct count.
- `cs2-hub/opponents-filter.test.html` — map pill (only opponents whose `favored_maps` includes the pill's map), threat pill against `threatTag.cls`, search by name, combined.

The render layer doesn't get a dedicated test page — visual changes are verified manually in browser like the prior redesigns. Helpers being tested are pure functions extracted from the page modules.

---

## 10. Migration / Risk

- No DB changes, no migrations.
- URLs unchanged; sidebar keys unchanged; deep links continue to work.
- Modals unchanged; existing form ids (`f-name`, `f-category`, `f-description`, `f-title`, `f-opponent`, etc.) preserved so save/edit flows don't shift.
- `team-autocomplete` integration on the veto modal is untouched.
- `opponent-detail.html` continues to be the link target for both `+ Add Team` and each anti-strat card. No coupling changes.
- Filter localStorage keys are new (`keywords:filter:v1`, `veto:filter:v1`, `opponents:filter:v1`). No collision risk with existing keys (`stratbook:filter:v1`, etc.).

---

## 11. Implementation Order

To match the prior cadence (`feat(stratbook)` / `feat(issues)` / `feat(goals)` as independent commits), this ships in three independent steps that can be reviewed and merged separately:

1. **Keywords** — smallest surface, validates the pattern on a page with no map/visual.
2. **Map Veto** — adds map-wash hero and complex filter row (format + opponent).
3. **Anti-Strat (opponents)** — wraps up the trio, uses the existing `threatTag` derivation.

Each step touches only its own `*.html` / `*.js`, plus an append-only block in `style.css`. No cross-page coupling.

---

## 12. Open Questions

None. Scope locked in brainstorming Q1–Q4 and approach Q5.
