# Session Log — Design Spec
**Date:** 2026-04-22

## Overview
A structured post-session log tied to existing schedule events. Any team member can read or edit the shared log for a given session. Accessed from the Schedule page — not a top-level nav item.

## Data

New Supabase table: `session_logs`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `event_id` | text | References events.id |
| `team_id` | uuid | References teams.id |
| `rating` | int | 1–5 session rating |
| `what_worked` | text | Structured field |
| `what_to_fix` | text | Structured field |
| `next_focus` | text | Structured field |
| `notes` | text | General overflow notes |
| `updated_at` | timestamptz | Last edited timestamp |

One log per event. Upsert on save (insert if none exists, update if it does).

## Files

- `cs2-hub/session-log.html` — new page
- `cs2-hub/session-log.js` — new page logic
- `cs2-hub/schedule.js` — add "Log →" link on past events
- `cs2-hub/schedule.html` — no changes needed

## UI

### Header
- Back link: `← Schedule`
- Event title (large)
- Row: event type badge + formatted date

### Rating
- 5 clickable circles labeled 1–5
- Selected circle fills with accent color
- Sits between header and fields

### Structured Fields
Four labeled textarea sections, stacked vertically, each in a surface card with a colored top border:

| Field | Placeholder | Border color |
|---|---|---|
| What Worked | "What did we execute well?" | `--success` (green) |
| What to Fix | "What broke down or needs work?" | `--danger` (red) |
| Next Session Focus | "What do we prioritize next time?" | `--accent` (blue) |
| Notes | "Anything else" | `--muted` |

### Save
- Explicit "Save" button (matches hub pattern)
- After save: subtle "Last edited X ago" timestamp below button
- On load: if log exists, populate all fields

## Routing
- Schedule page: past events (date < now) show a small `Log →` link alongside existing event info
- Link routes to `session-log.html?event_id=<id>`
- Future events do not show the log link

## Error Handling
- If event_id is missing or event not found: show empty state with back link
- Save errors: inline error message below save button
