-- cs2-hub/supabase-demo-retry-migration.sql
--
-- Add per-demo retry counter so the VPS poll loop can auto-requeue failed
-- demos a bounded number of times. Without this, a transient failure
-- (network blip, pooler timeout, parser OOM) parks a demo in status='error'
-- forever and the UI shows "Failed" until someone manually intervenes.
--
-- The cap + backoff live in vps/main.py (RETRY_MAX, RETRY_BACKOFF_MIN) so
-- they can be tuned without another migration.

alter table demos
  add column if not exists retry_count integer not null default 0;

-- Optional partial index: speeds up the auto-retry scan (status='error'
-- with attempts remaining). The retry sweep runs every POLL_INTERVAL (~10s)
-- so even without the index it's a small table scan, but the index keeps it
-- cheap once the table grows.
create index if not exists demos_error_retry_idx
  on demos (updated_at)
  where status = 'error';


-- ────────────────────────────────────────────────────────────────────────
-- One-shot: clear the current "Failed" backlog.
--
-- Resets every error row back to pending with a fresh retry budget and
-- clears the previous error_message. The poll loop will pick them up on
-- its next pass (within POLL_INTERVAL seconds of the VPS service running
-- this migration). Run this AFTER deploying the updated vps/main.py so
-- the new retry logic applies on the next failure.
--
-- If you'd rather requeue only a subset (e.g. only public demos, or only
-- ones that failed in the last 48h), narrow the WHERE clause first.
-- ────────────────────────────────────────────────────────────────────────

update demos
   set status        = 'pending',
       retry_count   = 0,
       error_message = null,
       updated_at    = now()
 where status = 'error';
