# CS2 Hub — Design Overhaul Spec
**Date:** 2026-04-20
**Scope:** Visual redesign of `cs2-hub/style.css` — no structural or functional changes

---

## Direction
Clean, minimal, professional (Linear/Notion dark mode aesthetic). Blue as a UI color is removed and becomes CT-side semantic only. White/near-white becomes the primary accent. Surfaces lose their blue tint.

---

## 1. Color System

| Token | Old | New |
|---|---|---|
| `--accent` | `#3b82f6` | `#f0f0f0` |
| `--surface` | `#0d1526` | `#0d1117` |
| `--surface-2` | — | `#161b27` (new) |
| `--border` | `#1a2744` | `#1e2433` |
| `--muted` | `#6b7280` | `#4b5563` |
| `--text-secondary` | — | `#9ca3af` (new) |
| `--bg` | `#080c14` | unchanged |
| `--success` | `#22c55e` | unchanged |
| `--danger` | `#ef4444` | unchanged |
| `--warning` | `#f97316` | unchanged |
| `--special` | `#a78bfa` | unchanged |

Semantic colors (T-side red `#f87171`, CT-side blue `#3b82f6`, win green, loss red) are **unchanged** — they carry meaning and must stay.

---

## 2. Sidebar

- Background: `#0a0e1a` (darker than main content for separation)
- Team name: `#f0f0f0`, weight 800, size 14px
- Active nav item: white text, `2px solid #f0f0f0` left border, `rgba(255,255,255,0.06)` background
- Inactive nav items: `--text-secondary` (#9ca3af)
- Nav section labels: `#4b5563`
- Sign out: same style as nav items

---

## 3. Typography

- **Page titles**: remove `text-transform: uppercase`. Weight 700, size 22px, normal case.
- **Section labels** (small dividers): keep uppercase, change color from `--accent` to `#6b7280`
- **Stat card labels**: `#6b7280` instead of `--accent`
- **Page subtitle**: use `--text-secondary` (#9ca3af)

---

## 4. Components

### Buttons
- `btn-primary`: `background: #f0f0f0`, `color: #0d1117` (white button, dark text)
- `btn-ghost`: `background: transparent`, `border: 1px solid #1e2433`, `color: #9ca3af`, hover → white text + `border-color: #f0f0f0`
- `btn-danger`: unchanged

### Cards
- Stat cards, strat cards, info panels: use `--surface-2` (`#161b27`) instead of `--surface`
- Border: `#1e2433`
- Border-radius: keep current (8–10px)

### Badges
- Type badges (execute, default, setup, etc.): `background: #1e2433`, `color: #9ca3af` — neutral, no color
- Win/loss/draw badges: unchanged (semantic)
- Side badges (T/CT): unchanged (semantic)
- Event type badges (scrim/tournament/etc.): unchanged (semantic)

### Form inputs
- Border: `#1e2433`
- Focus ring: `1px solid #f0f0f0` (white) instead of blue
- Background: `--bg` unchanged

### Tabs
- Active tab: `background: #f0f0f0`, `color: #0d1117` (white, like btn-primary)
- Inactive: `background: var(--surface)`, `color: #9ca3af`
- T-side active tab keeps red, CT-side active tab keeps blue (semantic)

### Section labels (`.section-label`)
- Color: `#6b7280` instead of `--accent`

### Accent-colored borders / left-borders
- Any decorative left-border that was blue (nav active, strat cards): switch to `#f0f0f0`

---

## 5. Scope

**Only `cs2-hub/style.css` changes.** No HTML or JS changes. The exception: if a color is hardcoded inline in HTML (e.g. `style="color:var(--accent)"`), those are left as-is since they'll inherit the new `--accent` value automatically.

---

## Out of Scope
- Layout changes
- New components
- Font changes
- Animations
