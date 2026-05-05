# cs2-hub — bolder redesign (v0.5 design system)

**Date:** 2026-05-05
**Owner:** Alex
**Status:** spec, awaiting review

## 1. Goal

Replace the current cs2-hub look — soft, glass-blurred, generic-esports-dark — with a sharper, more confident system that has identity. Same layouts and information hierarchy; new palette, sharper edges, bolder type, fewer surface effects. The app should feel like *something* rather than a default admin dashboard.

## 2. What changes (and what doesn't)

**Changes:**
- Palette swap: drop the `#D81A1D` red + `#A1A1AA` muted + glass blur. Replace with the five-tone palette below.
- Corners: 16px / 11px / 8px radii → **0px** everywhere. (Map-badge, tag-pill 9999, and a 2px hairline on inputs are the only exceptions.)
- Surfaces: glass + `backdrop-filter` blur removed entirely. Solid panels with 1px hairline borders only.
- Type: Oswald display pushed bigger and louder. 21px page title → 56px. 26px stat values → 54px on the feature stat, 38px elsewhere. Section labels gain heavier letter-spacing.
- Color usage: each stat tile in the 4-up grid takes a *different* surface treatment (cream feature / plum deep / dark neutral / pink statement) so the row reads as a composition rather than four identical glass boxes.

**Doesn't change:**
- Information architecture. Every existing page keeps its current sections, fields, and data.
- Page layouts (sidebar 220px + main, page-header on top, stat-grid → week-grid → list pattern, etc.).
- HTML structure of pages — only class names and `style.css` change. Existing JS keeps working.
- The Oswald + Inter type pair.
- Sidebar shape, navigation list, map-badge size and placement.

## 3. Scope

**In scope:**
- Rewrite `cs2-hub/style.css` tokens + all shared component classes used by the dashboard.
- Apply to **dashboard.html only** as a proof. Land it, look at it on real data, tweak.
- Document open issues / decisions to revisit when expanding.

**Out of scope (separate plans, later):**
- Schedule, stratbook (+ detail + fullscreen), demos, demo-viewer (+ drawer), vods (+ detail), roster, opponents (+ detail), anti-strat, veto, goals, keywords, issues, admin, login, team-select.
- `landing.html` (public marketing page — different rules apply).
- Any new features. This is pure visual refresh.

**Order for follow-up plans (suggested, not committed):** stratbook → schedule → demos/demo-viewer → opponents/anti-strat → veto → roster → goals/keywords/issues → admin/login/team-select.

## 4. Design tokens

### 4.1 Colors and roles

| Token | Hex | Role |
|---|---|---|
| `--bg` | `#142030` | App canvas. Replaces current `#000` + red gradient. |
| `--surface` | `#1a2638` | Default panel surface (stat card, list row, week day, sidebar). |
| `--surface-side` | `#0e1826` | Sidebar background (one shade darker than canvas). |
| `--accent` | `#ff5b8d` | Primary action / statement. The *only* "pop" color. |
| `--accent-deep` | `#732654` | Deep secondary surface (today-cell, plum stat, map-badge bg, sidebar hover). |
| `--cream` | `#e9d8c8` | Primary text on dark; feature surface; win indicators. |
| `--slate` | `#86a3b3` | Atmospheric — secondary text, labels, hairlines, neutral tags. |
| `--border` | `rgba(134,163,179,.15)` | Default 1px hairline. |
| `--border-strong` | `rgba(134,163,179,.30)` | Section dividers, ghost-button border. |
| `--success` | `#e9d8c8` | Alias of `--cream`. Win / positive — kept as a token because existing classes (`.badge-win`, dashboard form-dots, etc.) reference `var(--success)`. |
| `--danger` | `#ff5b8d` | Alias of `--accent`. Loss / down — kept for `.badge-loss`, `.btn-danger`, etc. |
| `--warning` | `#732654` | Alias of `--accent-deep`. Kept for any class still referencing `var(--warning)`. |
| `--special` | `#ff5b8d` | Alias of `--accent`. Legacy token, used in `dashboard.html` inline styles + a few JS files. Re-pointing it removes the old `#FF3333` red without touching consumers. |
| `--accent-dim` | `rgba(255,91,141,0.15)` | Alias kept for any class still referencing the old red-dim background. |

**Rules:**
- Pink is rare. If it appears more than once per visible viewport, something is wrong. CTAs, active nav rail, brand mark, statement stat, section labels, "down" rr numbers — pick the moments deliberately.
- Plum and cream are the *workhorse* color tones. Most colored surfaces are one of these.
- Slate carries every "muted" job. Do not reach for `opacity: .5` on cream — use slate.
- Never introduce a green, blue, amber, or red outside this palette. If a status genuinely needs differentiation beyond pink/cream/slate/plum, reach for slate variations or text styling first.

### 4.2 Typography

Type pair stays Oswald + Inter. Weights and sizes shift:

| Use | Family | Size | Weight | Tracking | Transform |
|---|---|---|---|---|---|
| Page title | Oswald | 56px | 700 | -0.0036em | uppercase |
| Hero stat value (feature) | Oswald | 54px | 700 | -0.0036em | uppercase |
| Stat value (regular) | Oswald | 38px | 700 | -0.0036em | — |
| Map name (list row) | Oswald | 16px | 700 | 0.5px | uppercase |
| Day number | Oswald | 22px | 700 | -0.02em | — |
| Score / round-win | Oswald | 24px | 700 | -0.02em | — |
| Section label | Inter | 10px | 700 | 0.22em | uppercase |
| Page tag (date line) | Inter | 10px | 600 | 0.22em | uppercase |
| Body | Inter | 13px | 400 | -0.012em | — |
| Caption / sub | Inter | 11px | 400 | 0.05em | — |
| Button | Inter | 12px | 700 | 0.10em | uppercase |

### 4.3 Geometry

- **Corner radius:** 0px on every surface. Exceptions: `.map-badge` keeps a square (no rounding), `.tag` becomes square pills (drop the `border-radius: 20px`), `.form-input` gets a 2px radius for affordance only. Pill `border-radius: 9999px` is removed from badges entirely.
- **Borders:** 1px hairlines only (`var(--border)`). No 2px frames, no glowing focus rings. Active states use a 3px **left rail** (sidebar) or a 4px **top bar** (feature stat) in `--accent` instead of full borders.
- **Shadows:** none. The current `box-shadow: rgba(0,0,0,0.15) 0px 30px 60px 0px` on stat cards goes away. Depth comes from color-block contrast, not shadow.
- **Backdrop filter:** removed everywhere. Surfaces are solid.
- **Spacing scale (unchanged):** 4 / 8 / 12 / 16 / 20 / 24 / 28 / 32. Stat-grid gap = 8px. Week-grid gap = 4px. List-row gap between rows = 1px (the `--border` color shows through, giving a hairline divider effect for free).

### 4.4 Motion

Existing `150ms ease` transitions stay. No new motion. Hover changes color/background only — no transforms, no scale, no shadow blooms.

## 5. Component patterns

The CSS class names below already exist in `style.css`. We're rewriting their rules, not introducing new class names — so existing HTML keeps working.

### 5.1 Sidebar (`.sidebar`, `.nav-item`, `.nav-section`)

- Background: `--surface-side` (darker than main canvas).
- Brand block: 14×14 pink square + Oswald wordmark (existing logo image swap stays).
- Nav items: 9px 18px padding, `color: var(--slate)`. Active item: `color: var(--cream)`, background `rgba(115,38,84,.50)`, 3px left rail in `--accent`. Hover: `color: var(--cream)`, background `rgba(115,38,84,.30)`.
- Drop the existing `border-radius` on hover backgrounds. Drop the glass blur entirely.

### 5.2 Page header (`.page-header`, `.page-title`, `.page-sub`)

- `.page-title`: Oswald 56px, uppercase. Hero greeting can use `<em>` (style as `--accent` color, normal style) for "Alex." emphasis on dashboard.
- `.page-sub`: 10px 0.22em uppercase `--accent`-colored tag (current 13px muted gets replaced).
- Bottom border `1px var(--border-strong)` adds a magazine-style rule under the header.

### 5.3 Buttons (`.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-sm`)

- `--padding` 10px 18px, `--font` 12px / 700 / 0.10em / uppercase. `border-radius: 0`.
- `.btn-primary`: bg `--accent`, text `--bg`. Hover: lighter pink `#ff7aa3`.
- `.btn-ghost`: transparent, 1px `--border-strong`, text `--cream`. Hover: bg `rgba(134,163,179,.10)`.
- `.btn-danger`: transparent bg, 1px `--accent` border, text `--accent`. Hover: bg `rgba(255,91,141,.10)`. (The pink as a *warning frame* rather than a filled button — keeps the filled-pink slot reserved for the primary action on a page.)
- `.btn-sm`: padding 6px 12px, font 11px (rest unchanged).

### 5.4 Stat cards (`.stat-card`)

Four variants. Default + three modifier classes:
- Default: `--surface` bg, 1px `--border`, cream text. Stat label `--slate`.
- `.stat-card--cream` (feature): `--cream` bg, navy text, plum label, 4px top bar in `--accent`. Used for "Next Match" — the highest-priority stat.
- `.stat-card--plum`: `--accent-deep` bg, cream text, pink label. Used for "Match Record."
- `.stat-card--pink`: `--accent` bg, navy text, navy label. Used for "Open Issues" or whatever the *single* statement stat on a page should be.

The dashboard arrangement: cream / plum / default / pink. Composition pattern, not random.

### 5.5 Week grid (`.week-col`, `.week-event-*`)

- `.week-col`: `--surface` bg, 1px `--border`, 0px radius.
- `.week-col-today`: `--accent-deep` bg, day number flips to `--accent`.
- Events: drop the four-way color coding (scrim red / tournament green / meeting magenta / vod orange). Existing class names stay; their styles change. Mapping:
  - `.week-event-scrim` → 3px left border `--accent`, bg `rgba(255,91,141,.10)`, label `--accent`. (Pink — the active competitive moment.)
  - `.week-event-tournament` → 3px left border `--cream`, bg `rgba(233,216,200,.10)`, label `--cream`. (Cream — external / earned weight.)
  - `.week-event-meeting` → 3px left border `--slate`, bg `rgba(134,163,179,.12)`, label `--slate`.
  - `.week-event-vod_review` → 3px left border `--slate`, bg `rgba(134,163,179,.12)`, label `--slate`.

### 5.6 List rows (`.list-row`, table-row pattern)

- Row bg: `--surface`. Row gap: 1px (`--border` shows through). 0px radius. No glow on hover — switch to a slightly lighter bg `#21304a`.
- Map name: Oswald 16px uppercase, `--cream`.
- Round-win number: Oswald 24px right-aligned. Up = `--cream`. Down = `--accent`.

### 5.7 Badges + tags (`.badge`, `.tag`)

- 0px radius (down from 20px / pill). Padding 2px 7px, 10px / 0.15em / uppercase.
- Default: `rgba(134,163,179,.15)` bg, `--slate` text.
- `.badge-win`: `rgba(233,216,200,.15)` bg, `--cream` text. Stays semantic — match outcomes need to read at a glance.
- `.badge-loss`: `rgba(255,91,141,.15)` bg, `--accent` text. Stays semantic.
- `.badge-draw`: default slate variant.
- `.badge-scrim`, `.badge-tournament`, `.badge-meeting`, `.badge-vod_review` all collapse to the default slate variant. Color stays reserved for *surface* roles and outcomes, not event-type taxonomy.
- `.tag` (used for filter chips, strat tags) → default slate variant only.

### 5.8 Map badge (`.map-badge`)

- 32×32 square, `--accent-deep` bg, `--accent` text. Oswald 12px uppercase. 0px radius.
- Drop the existing image overlay (or invert it: image at 50% opacity over the plum if image present).

### 5.9 Form dots / sparklines (`.form-dots`)

- 10×10 squares, no radius. Win = `--cream`, loss = `--accent`, draw/empty = `rgba(233,216,200,.20)`.

### 5.10 Tabs (`.tabs .tab`)

- 0px radius. Inactive: `color: var(--slate)`, no border. Active: `color: var(--cream)`, 2px bottom border `--accent`. (Sharp, not pill-shaped.)

### 5.11 Inputs (`.form-input`)

- Bg `--surface`, 1px `--border`, 2px radius (only exception to the 0px rule, for affordance).
- Focus: border `--accent`, no glow.

## 6. Dashboard application

Concrete mapping. `dashboard.html` is unchanged at the markup level. `dashboard.js` is unchanged. Only the *modifier classes* on the four stat cards change, plus the existing inline `style="border-top:3px solid var(--accent)"` patterns get replaced with the modifier classes above.

Current dashboard layout (`cs2-hub/dashboard.html`):
- Page header: greeting + date sub.
- 4-up stat grid: Next Event, Strats Saved, Match Record, Open Issues.
- "Upcoming This Week" section → week grid (`#upcoming-events`, populated by JS).
- "Recently Added Strats" section → list rows (`#recent-strats`).

Mapping:
- **Stat 1 (Next Event)** → `.stat-card.stat-card--cream`. Replaces `border-top:3px solid var(--accent)` inline.
- **Stat 2 (Strats Saved)** → default `.stat-card` (dark neutral — eye rest). Removes `border-top:3px solid var(--special)` inline.
- **Stat 3 (Match Record)** → `.stat-card.stat-card--plum`. Replaces `border-top:3px solid var(--success)` inline. Form-dots stay.
- **Stat 4 (Open Issues)** → `.stat-card.stat-card--pink` (the one statement). Replaces `border-top:3px solid var(--muted)` inline.

`dashboard.js` does not need to change *if* it doesn't write inline styles for these tiles. Quick check before the implementation plan: confirm `dashboard.js` only writes content (`textContent`) into `#stat-next-event`, `#stat-strats`, etc., not classes/styles.

## 7. Migration approach

1. **Rewrite `style.css` tokens block** (lines 5-24). Replace `--bg`, `--surface`, `--accent`, `--text`, `--muted`, `--card-cream`, etc. with the new five-token system. Drop `--glass-bg`, `--glass-border`, `--accent-dim`, the gradient body backdrop, and the unused-color tokens (`--success`, `--danger`, `--warning`, `--special` get re-pointed to cream/pink as noted in §4.1).
2. **Rewrite shared component classes** (sidebar, nav-item, page-header, btn, stat-card, week-col, week-event-*, list-row, badge, tag, map-badge, form-dots, tabs, form-input). One pass, top-down through the existing file.
3. **Add the three stat-card modifier classes** (`--cream`, `--plum`, `--pink`).
4. **Update `dashboard.html`** to swap `style="border-top:..."` inline declarations for the modifier classes.
5. **Visual check** at `/dashboard.html` on real data. Iterate inline as needed before locking.
6. **Defer all other pages.** They will visibly inherit the new sidebar / button / badge / list-row look immediately because they share `style.css`. That's expected and good — but those pages may have page-specific styles that need a follow-up pass. We don't fix them in this plan.

## 8. Open questions to resolve during dashboard pass

- Does the dashboard's empty-state look right with the new tokens? (`<div class="loading">Loading…</div>` — currently styled as muted text. Verify it reads in slate without disappearing.)
- The `team-name` element in the sidebar currently shows the team string in `--muted` 10px — does the slate replacement still read well? Verify in browser.
- Confirm `dashboard.js` doesn't write inline `style.borderTop` (or similar) onto the stat cards. If it does, those writes need replacing with class swaps.

## 9. Definition of done (this plan)

- `style.css` tokens block matches §4.1.
- All component classes listed in §5 use only the new tokens.
- No `backdrop-filter`, no `box-shadow` (except input focus, none planned), no `border-radius` > 2px anywhere in the rewritten classes.
- `dashboard.html` uses the new stat-card modifier classes; renders correctly with real data; the four stat tiles read as cream / plum / dark / pink left-to-right.
- Other pages may look uneven — that is acceptable and expected. Each page gets its own follow-up plan.
