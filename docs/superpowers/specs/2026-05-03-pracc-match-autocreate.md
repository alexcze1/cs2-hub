# Pracc → Match Auto-Creation

## Problem

When a scrim is added to the CS2 Hub schedule manually, a blank match (vod) entry is auto-created in Results so the user can immediately fill in scores afterward. Scrims imported from the pracc.com iCal integration skip this — they live as read-only calendar events and never become matches. Users have to manually re-enter every pracc scrim in Results to track results, defeating the point of the integration.

## Goal

Pracc-imported scrims auto-create a corresponding vod entry, mirroring the manual-add flow. Sync is automatic on schedule load, idempotent across reloads, and survives user-driven deletion via a soft-dismiss mechanism.

## Non-goals

- Tournament events from pracc — pracc forces all events to type `scrim` and is not used for tournaments.
- Server-side / webhook sync — the schedule page load is the only sync trigger.
- Backfilling pracc events that have already aged out of the user's pracc calendar feed.
- Two-way sync of pracc edits onto existing vods (insert-once; user owns the vod after creation).

## Architecture

Sync logic runs client-side inside `loadEvents()` in `cs2-hub/schedule.js`, immediately after pracc events are fetched from `/api/calendar`. For each pracc event:

1. Look up existing vods by `external_uid`.
2. If no vod row exists for that UID (whether `dismissed` or not), insert a new vod with `external_uid` set to the pracc event id.
3. Insert-once semantics — once a vod exists for a UID, sync never touches it again.

A unique partial index on `(team_id, external_uid)` provides atomic dedupe and protects against double-insert from concurrent tabs.

## Data model

Add two columns and one index to the `vods` table:

```sql
alter table vods add column if not exists external_uid text;
alter table vods add column if not exists dismissed boolean default false;
create unique index if not exists vods_team_external_uid_idx
  on vods(team_id, external_uid) where external_uid is not null;
```

Field semantics:

- `external_uid` — non-null when the vod was auto-created from an external integration. Currently only pracc; format matches the pracc event id (`pracc-<UID>`). Null for manual vods.
- `dismissed` — when true, the vod is hidden from Results and counted as "handled" by the sync logic so it won't be re-created. Only ever set on vods with a non-null `external_uid`.

The migration goes into `cs2-hub/supabase-setup.sql` under the existing `-- Migration` comment block so the user can run it from the Supabase SQL editor.

## Sync flow

Inside `loadEvents()` in `cs2-hub/schedule.js`, after `praccEvents` is built and before the merge with manual events:

```
1. uids = praccEvents.map(e => e.id)
2. if uids is empty, skip sync
3. existing = supabase.from('vods')
     .select('external_uid')
     .eq('team_id', teamId)
     .in('external_uid', uids)
4. existingUids = new Set(existing.map(v => v.external_uid))
5. newPayloads = praccEvents
     .filter(e => !existingUids.has(e.id))
     .map(e => ({
       team_id: teamId,
       opponent: e.opponent || e.title,
       match_type: 'scrim',
       match_date: e.date.slice(0, 10),
       maps: [],
       external_uid: e.id,
     }))
6. if newPayloads.length, supabase.from('vods').insert(newPayloads)
   ignore unique-violation errors (race-safe via the partial index)
```

Sync runs in parallel with the existing event/calendar fetches where possible. Failure of the sync step never blocks calendar render — it's logged and retried on next page load.

## Delete behavior

Modify the vod delete handler in `cs2-hub/vod-detail.js` (the only `vods.delete` call in the codebase, line 295). Behavior:

- If `external_uid is null` (manual vod) → `delete()` as today.
- If `external_uid is not null` (pracc-sourced) → `update({ dismissed: true })` instead.

User-facing UX is identical: the row vanishes from Results. Internally the row sticks around with `dismissed=true` so the next sync sees the UID is "handled" and won't re-insert.

The vods list query in `cs2-hub/vods.js` adds `.eq('dismissed', false)` to hide dismissed rows. The migration's `default false` backfills existing rows with `false`, so no null-handling is needed.

## Results-page badge

In `cs2-hub/vods.js`, the match list row template gets a small `PRACC` badge next to the opponent name when the vod's `external_uid` is set. Style mirrors the existing `pracc-badge` class on the schedule page for visual consistency.

## Edge cases

| Case | Behavior |
|------|----------|
| Pracc event reschedules to a new date | Existing vod's `match_date` does **not** auto-update. User edits manually if needed. |
| Pracc event deleted from pracc | Vod remains. User can dismiss manually. |
| User edits opponent name / scores on auto-created vod | Edits stick. Sync only inserts; never updates. |
| Two browser tabs open Schedule simultaneously | Unique partial index causes second tab's insert to fail silently. No duplicate vods. |
| Sync request fails (network, RLS) | Calendar still renders. Next page load retries. |
| User dismisses then later un-dismisses | Out of scope — no UI for un-dismiss in v1. Could be added later by clearing `dismissed`. |
| Pracc returns 0 events | Sync no-ops (empty `uids` short-circuit). |

## Files touched

- `cs2-hub/supabase-setup.sql` — add migration lines for the two columns + index.
- `cs2-hub/schedule.js` — add sync logic inside `loadEvents()`.
- `cs2-hub/vod-detail.js` — branch delete vs. dismiss on `external_uid` (line 295).
- `cs2-hub/vods.js` — filter out dismissed vods; add PRACC badge to list row.

## Verification

- Manual: with a configured pracc URL, load Schedule. Confirm new pracc events appear as vods in Results.
- Manual: reload Schedule several times. Confirm no duplicate vods are created.
- Manual: delete an auto-created vod from Results. Reload Schedule. Confirm the vod does not reappear.
- Manual: delete a manual (non-pracc) vod. Confirm it hard-deletes as before.
- Manual: edit opponent name on an auto-created vod, reload Schedule. Confirm edit is preserved.
- SQL: after migration, `select column_name from information_schema.columns where table_name = 'vods'` lists `external_uid` and `dismissed`.
