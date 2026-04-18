# CS2 Team Hub — Design Spec
Date: 2026-04-18

## Overview

A private, internal web application for a 5-player CS2 esports team. All content is login-gated — no public-facing pages. All 5 players have equal access to all features. Built with vanilla HTML/CSS/JS and Supabase for authentication and database.

## Goals

- Central hub for team coordination, strategy, match prep, and VOD review
- Simple enough for non-technical players to add and edit content without touching code
- Shared data: all 5 players see the same live data

## Non-Goals

- Public team page or fan-facing content
- Role-based permissions (coach vs player)
- Map drawing or diagram tools in the stratbook
- Player statistics tracking

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS | No framework overhead, easy to maintain |
| Auth + DB | Supabase (free tier) | Handles login, shared database, real-time, no server to manage |
| Hosting | Netlify (free tier) | Static hosting, connects to Supabase via env vars |
| Styling | Custom CSS, dark blue tactical theme | No external UI library dependency |

### Design System
- **Background:** `#080c14` (deep dark navy)
- **Surface:** `#0d1526`
- **Border:** `#1a2744`
- **Accent:** `#3b82f6` (electric blue)
- **Text primary:** `#ffffff`
- **Text secondary:** `#6b7280`
- **Success:** `#22c55e`
- **Danger:** `#ef4444`
- **Special:** `#a78bfa` (purple, for meetings)
- **Font:** System UI / Segoe UI
- **Layout:** Persistent left sidebar (200px) + main content area

---

## Pages & Routes

No client-side router — vanilla HTML files with query string navigation. "New" and "edit" modes share the same detail page; the page checks for `?id=` in the URL to determine mode (absent = new, present = edit).

| File | Query Params | Description |
|---|---|---|
| `index.html` | — | Login page |
| `dashboard.html` | — | Overview |
| `schedule.html` | — | Events list + add/edit inline |
| `stratbook.html` | — | Strat list with map/side filters |
| `stratbook-detail.html` | `?id=<uuid>` (optional) | Add (no id) or view/edit strat |
| `vods.html` | — | VOD list |
| `vod-detail.html` | `?id=<uuid>` (optional) | Add (no id) or view/edit VOD |
| `opponents.html` | — | Opponent list |
| `opponent-detail.html` | `?id=<uuid>` (optional) | Add (no id) or view/edit opponent |
| `roster.html` | — | Team roster grid |

---

## Authentication

- Supabase email/password auth
- Each of the 5 players gets one account (set up manually in Supabase dashboard)
- All authenticated users can read and write all data (no role separation)
- Session persisted in localStorage via Supabase JS client
- Unauthenticated users are redirected to `/` (login)

---

## Data Models

### `events` table
| Column | Type | Notes |
|---|---|---|
| id | uuid | Primary key |
| title | text | Event name |
| type | text | `scrim`, `tournament`, `meeting`, `vod_review` |
| date | timestamptz | Date and time |
| opponent | text | Optional — opponent team name |
| notes | text | Optional free-text notes |
| created_at | timestamptz | Auto |
| created_by | uuid | Supabase user ID |

### `strats` table
| Column | Type | Notes |
|---|---|---|
| id | uuid | Primary key |
| name | text | Strat name |
| map | text | `mirage`, `inferno`, `nuke`, `anubis`, `dust2`, `vertigo`, `ancient` |
| side | text | `t`, `ct` |
| type | text | `execute`, `default`, `setup`, `fake`, `eco`, `other` |
| player_roles | jsonb | Array of 5 objects: `{player: string, role: string}` |
| notes | text | General notes and trigger conditions |
| tags | text[] | Array of tag strings |
| created_at | timestamptz | Auto |
| updated_at | timestamptz | Updated on edit |
| created_by | uuid | Supabase user ID |

### `vods` table
| Column | Type | Notes |
|---|---|---|
| id | uuid | Primary key |
| title | text | e.g. "vs NaVi — Mirage" |
| result | text | `win`, `loss`, `draw` |
| score | text | e.g. "16-12" |
| match_type | text | `scrim`, `tournament`, `pug` |
| demo_link | text | Optional URL to demo file |
| match_date | date | Date of the match |
| notes | jsonb | Array of `{timestamp: string, note: string}` |
| created_at | timestamptz | Auto |
| created_by | uuid | Supabase user ID |

### `opponents` table
| Column | Type | Notes |
|---|---|---|
| id | uuid | Primary key |
| name | text | Team name |
| favored_maps | text[] | Maps they prefer |
| strengths | text[] | One item per strength |
| weaknesses | text[] | One item per weakness |
| anti_strat | text | Free-text anti-strat summary |
| notes | text | General research notes |
| created_at | timestamptz | Auto |
| updated_at | timestamptz | Updated on edit |

### `roster` table
| Column | Type | Notes |
|---|---|---|
| id | uuid | Primary key |
| username | text | In-game name |
| real_name | text | Optional |
| role | text | `IGL`, `AWPer`, `Entry`, `Support`, `Lurker` |
| user_id | uuid | Linked Supabase user ID |

---

## Feature Specs

### Dashboard
- Stat cards: next upcoming event, total strats saved, total VODs reviewed
- Upcoming events list (next 7 days), sorted by date, color-coded by type
- Recent strats list (last 3 added)

### Schedule
- List view sorted by date (no full calendar widget — simpler to implement and use)
- Filter by event type (all / scrim / tournament / meeting / VOD review)
- Add event form: title, type, date+time, opponent (optional), notes (optional)
- Edit and delete per event

### Stratbook
- List view with tab filters for map (All / Mirage / Inferno / Nuke / Anubis / Dust2 / Vertigo / Ancient)
- Secondary filter for side (All / T-Side / CT-Side)
- Each row shows: map badge, strat name, meta line, tags
- Add/edit form: name, map, side, type, player roles (5 text fields), notes, tags
- Delete with confirmation

### VOD Review
- List of VODs, sorted by match date descending
- Each card shows: title, result badge, score, match type, note count
- Detail page: all timestamped notes listed in order
- Add note inline on detail page: timestamp input + note text
- Edit/delete individual notes

### Opponents
- List of opponent teams as cards
- Detail page: strengths list, weaknesses list, favored maps, anti-strat block, general notes
- Add/edit/delete opponents and their data

### Roster
- Simple grid of player cards: IGN, real name (optional), role badge
- Managed by editing Supabase directly (no in-app edit form — low priority)

---

## File Structure

```
/
├── index.html          # Login page
├── dashboard.html
├── schedule.html
├── stratbook.html
├── stratbook-detail.html
├── vods.html
├── vod-detail.html
├── opponents.html
├── opponent-detail.html
├── roster.html
├── style.css           # Global design system
├── auth.js             # Supabase auth helpers + route guard
├── supabase.js         # Supabase client init
├── schedule.js
├── stratbook.js
├── vods.js
├── opponents.js
└── supabase.js         # Supabase client init with hardcoded URL + anon key (anon key is intentionally public; RLS enforces security)
```

---

## Supabase Setup (one-time)

1. Create free Supabase project at supabase.com
2. Run SQL to create the 5 tables above
3. Enable Row Level Security — policy: authenticated users can read/write all rows
4. Create 5 user accounts (one per player) via Supabase Auth dashboard
5. Copy project URL and anon key into `supabase.js` (anon key is safe to commit — it's designed to be public; RLS policies enforce access control)

---

## Out of Scope (future)

- Map drawing / utility lineup tool
- Player stats / rating tracking
- Mobile app
- Public team page
- Notifications / reminders
