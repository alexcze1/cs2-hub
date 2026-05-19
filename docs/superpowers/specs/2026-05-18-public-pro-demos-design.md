# Public Pro Demos — Design

**Status:** Approved design, ready for implementation plan
**Date:** 2026-05-18
**Plan:** `docs/superpowers/plans/2026-05-18-public-pro-demos.md`

## Problem

Today the demos page is private: every demo belongs to a team, RLS scopes reads to the uploading team, and an anon visitor sees nothing. Users have to upload demos themselves to get any value from the viewer / scoreboard / analysis tools.

We want a public corpus alongside the private one — pro CS2 matches from HLTV (last ~90 days, refreshed daily) browsable by anyone, no sign-in required. This makes the viewer useful as a standalone tool, drives discoverability, and lets users compare their own demos against pro reference points.

## Goals

- Any visitor (signed-in or anon) can browse a list of recent pro matches and open them in the existing demo viewer.
- Ingest is fully automated: a daily worker discovers new HLTV matches and enqueues them; the existing parse pipeline handles the rest unchanged.
- Backfill last ~90 days as a one-shot batch.
- Local `.dem` files are deleted after a successful public parse — only the parsed `match_data` / `match_data_slim` + stat rows stay in Postgres.
- Existing team-scoped demo flow is untouched in behavior and UX.

## Non-goals

- No HLTV partnership or licensed feed. We scrape; we accept the ToS / Cloudflare risk.
- No alternate sources (Faceit, ESEA, Liquipedia) in this ship.
- No public-demo-specific UI in the viewer (HLTV match link, event branding, pro player highlight). The viewer renders public demos identically to team demos in Ship 1; pro-aware UX is a follow-up.
- No event filtering, search, or pro player landing pages. Just a chronological list.
- No re-parsing strategy for public demos beyond "ingest worker is idempotent and the `.dem` is still on disk if parse errored". We don't try to re-download HLTV demos that succeeded then later became outdated.
- No public-demo write endpoints. Insertion is service-role only, from the VPS.

## Architecture

```
HLTV (results + match pages, GOTV demo archives)
  ↓ hltv_scraper.py        (cloudscraper; rate-limited)
  ↓ hltv_ingest.py         (idempotent insert per (source, match, map))
demos row: status='pending', is_public=true, team_id=null, source='hltv'
local .dem written to DEMOS_DIR/{demo_id}.dem
  ↓ main.py:_poll_loop     (existing, unchanged)
  ↓ demo_parser.parse_demo (existing, unchanged)
demos.match_data / match_data_slim
demo_players / demo_team_stats   (existing, unchanged)
  ↓ post-parse hook: if is_public + success → unlink local .dem
  ↓ Supabase RLS: public_demos_read (anon + authenticated, is_public=true)
demos.html "Pro" tab  →  demo-viewer.html (anon-allowed when is_public)
```

Two new long-running tasks in the VPS process, sharing the same `DEMOS_DIR`:
- `_poll_loop` (existing) — picks up pending rows from any source.
- `_hltv_ingest_loop` (new) — daily HLTV discovery + enqueue.

The pipeline is one-way: scraper writes pending rows + files; parser consumes pending rows + files; UI reads parsed columns. No coupling between scraper and parser beyond the `demos` row and the file on disk.

## Schema decisions

We extend `demos` rather than creating a `public_demos` table.

**Why extend:**
- The viewer, parser, stats tables, and analysis tools all key off `demos.id`. A separate table would force every downstream module to handle two demo "kinds".
- `match_data`, `match_data_slim`, `demo_players`, `demo_team_stats` are identical for both — duplicating tables means duplicating 200+ lines of parser write code and the entire viewer.

**Cost:** RLS gets one more policy per table (the public-read policy joins through `demos.is_public`). Existing team policies stay unchanged.

### Columns added to `demos`

| Column | Type | Purpose |
|---|---|---|
| `is_public` | `boolean not null default false` | Discriminator. Drives RLS, UI tab, post-parse cleanup. |
| `team_id` | nullable (was `not null`) | Public demos have no owning team. |
| `source` | `text default 'team_upload'`, check `in ('team_upload','hltv')` | Provenance; extensible if we add Faceit later. |
| `source_match_id` | `text` | HLTV match id. Idempotency key. |
| `source_map_index` | `int` | 0-based index of the `.dem` inside the match's GOTV archive. A BO3 produces three rows sharing one `source_match_id`. |
| `source_url` | `text` | HLTV match URL. Surfaced as "View on HLTV" link in the UI (credit / non-redistribution gesture). |
| `event_name`, `team_a_name`, `team_b_name` | `text` | Captured at scrape time so the Pro tab list can render before parse completes. The parser still writes its own `ct_team_name` / `t_team_name` once the demo is parsed. |

`uploaded_by` is `null` for HLTV rows. The existing team RLS policies check `team_id` and `uploaded_by`; they evaluate to false for HLTV rows, so the new public-read policy is the only thing exposing them.

### Indexes

- `unique (source, source_match_id, source_map_index) where source_match_id is not null` — ingest idempotency. The partial predicate avoids constraining team uploads.
- `(created_at desc) where is_public = true` — covers the public list query.

### RLS

Existing team policies are untouched. Three new `select` policies (one per table):

```sql
create policy "public_demos_read" on demos
  for select to anon, authenticated
  using (is_public = true);

create policy "public_demo_players_read" on demo_players
  for select to anon, authenticated
  using (demo_id in (select id from demos where is_public = true));

create policy "public_demo_team_stats_read" on demo_team_stats
  for select to anon, authenticated
  using (demo_id in (select id from demos where is_public = true));
```

No public insert/update/delete policies — public ingest is service-role-only from the VPS.

## Scraper contract

Module: `vps/hltv_scraper.py`. Two pure-ish entry points, plus a private rate-limited fetcher:

```python
def list_recent_matches(days: int = 90) -> list[MatchRef]:
    """Walk /results pages, return matches whose date >= now - days."""

def download_demos(match_url: str, dest_dir: Path) -> list[tuple[int, Path, dict]]:
    """Download the GOTV archive for a match, extract, return one tuple
       per .dem: (map_index, local_path, {"map_name": "de_mirage"})."""
```

`MatchRef` is a dataclass: `hltv_id, url, date, team_a, team_b, event`.

**Rate limiting** is baked into the fetcher (mandatory `time.sleep` per request) so callers can't accidentally hammer HLTV. Defaults: 2s per page in `list_recent_matches`, 5s before each download. Backfill caller bumps these higher.

**Cloudflare strategy:** start with `cloudscraper`. If 403/503 returns persist past one retry, escalate to Playwright with a real Chromium session. This is invisible to callers — same function signatures.

**Testing:** selectors are validated against checked-in HTML fixtures (`vps/tests/fixtures/hltv_*.html`). CI never hits HLTV. Re-capturing fixtures is a manual chore when HLTV updates their markup.

## Ingest contract

Module: `vps/hltv_ingest.py`. One entry point:

```python
def ingest_match(match: MatchRef, demos_dir: Path) -> int:
    """Return number of new demos inserted (0 if already ingested)."""
```

Steps:
1. Check `select 1 from demos where source='hltv' and source_match_id=%s limit 1`. If exists, return 0.
2. Check `DEMOS_DIR` disk usage. If above soft cap (20 GB default), raise `DiskCapExceeded`. Caller logs and skips; next cycle retries.
3. Call `download_demos(match.url, demos_dir)`. Extract returns N temp paths.
4. For each `(map_index, tmp_path, meta)`: generate `demo_id`, rename file to `{demo_id}.dem`, insert pending row with all `source_*`, `event_name`, `team_*_name` fields populated and `storage_path = 'local:{demo_id}.dem'`.
5. Return N.

**Failure modes:**
- HLTV blocks scraper → step 3 raises; no rows inserted; next cycle retries (idempotent).
- Download partial → archive extract fails; partial files cleaned up; row not inserted.
- DB insert race (same match enqueued twice in parallel) → unique index on `(source, source_match_id, source_map_index)` rejects the second; caller treats as "already ingested".

## Parser pipeline changes

`_process_one` is the only function that needs touching. Two changes:

1. **Cleanup after success for public demos.** After the stats write completes, if the demo is `is_public=true` and `is_local=true`, `unlink` the local `.dem`. Team demos are unaffected (current behavior leaves the file on disk for re-parse).
2. **Do NOT cleanup on error.** Error keeps the file so re-parse can run without re-download. The ingest loop won't re-download (idempotency guard) so a stuck error demo needs manual `status='pending'` to re-run, or manual cleanup.

`is_public` is fetched alongside `is_local` — either by extending `_fetch_pending` to select the column, or with a one-row lookup in `_process_one`. Either works; pick whichever reads cleaner. The `_fetch_pending` extension is marginally faster (no extra query per demo).

## Frontend contract

`demos.html` grows a tab strip with two scopes: **Team** and **Pro**.

- Signed-out visitor: page loads with **Pro** active by default. **Team** tab visible but clicking it prompts sign-in.
- Signed-in visitor with a team: **Team** active by default. Both tabs always accessible.
- Signed-in visitor without a team: **Pro** active by default.

The Pro list query:

```js
supabase
  .from('demos')
  .select('id, map, played_at, team_a_name, team_b_name, event_name, source_url, team_a_score, team_b_score, status')
  .eq('is_public', true)
  .order('played_at', { ascending: false, nullsLast: true })
  .limit(100)
```

Pagination via standard offset; "Load more" button. No filters in Ship 1 — chronological only.

Hidden in Pro scope: upload button, file-drop affordance, team-scoped filter chips, demo deletion, demo renaming.
Shown only in Pro scope: small "via HLTV" badge on each card with `source_url` as the link.

### Demo viewer (anon)

`demo-viewer.js` currently assumes a signed-in user. We audit for `auth.getUser()` / sidebar / "switch team" gates and remove them when the loaded demo has `is_public=true`. The viewer's data queries already go through Supabase; the new RLS policies cover anon access.

The sidebar nav still renders, but team-management entries are hidden for anon visitors (the sidebar already handles this — verify, don't duplicate).

## Storage strategy

| What | Where | Lifetime |
|---|---|---|
| Original `.dem` for public demos | `DEMOS_DIR` on VPS | Deleted after successful parse |
| Original `.dem` for team demos | `DEMOS_DIR` (local) or Supabase Storage | Retained (current behavior) |
| `match_data` jsonb | Postgres `demos.match_data` | Retained forever |
| `match_data_slim` jsonb | Postgres `demos.match_data_slim` | Retained forever |
| Per-player / per-team stats | `demo_players` / `demo_team_stats` | Retained forever |

**Why delete the `.dem`:** at 50–200 MB per file × hundreds of matches per quarter, retaining originals would require GBs–TBs of storage that we'd never read again. The parsed `match_data` already covers every UI need (viewer scrubbing, scoreboard, analysis, multi-round) and is ~10× smaller raw, JSON-encoded.

**Recovery path:** if a parse bug is found and we need to re-parse a historical demo, we re-download from HLTV using `source_url`. The idempotency guard only checks "do we have a row" — we'd need a small admin path to force re-download (out of scope for Ship 1; document but don't build).

## Operational decisions

- **Ingest cadence:** 24h via `HLTV_INGEST_INTERVAL` env var (override for testing). Each cycle scans `HLTV_INGEST_DAYS=2` worth of recent matches — 1-day overlap to catch anything that posted late after the previous cycle.
- **Backfill:** one-shot CLI (`vps/backfill_hltv.py`) with `days=90`, 30s sleep between matches. Run manually, watched live, aborted at first 50 demos to measure Postgres growth. If growth projects to >20 GB for the full 90 days, narrow scope (Tier-1 events only) before continuing.
- **Disk cap:** `DEMOS_DIR` soft cap = 20 GB. Ingest loop refuses new downloads above the cap and logs; next cycle retries. Parser keeps draining pending rows, so the cap self-recovers.
- **Failed parses:** stay in `status='error'` with the file on disk. No automatic retry. Surfaced in admin tooling (existing) for manual triage.

## Open risks

1. **HLTV ToS / Cloudflare.** This is the load-bearing risk. We may get IP-banned, account-banned (we don't use an account, but Cloudflare fingerprints), or hit with a takedown request. Mitigations: aggressive rate limits, no overlap with HLTV's high-traffic windows, attribution link on every public demo, willingness to pull the feature if HLTV objects.
2. **`match_data` jsonb cost.** Comments in `_db_write_results` mention multi-MB `match_data` per demo. 1000 public demos × 5 MB = 5 GB in Postgres. If Supabase project pricing makes this painful, fall back to `match_data_slim` only for public demos (small viewer features get disabled for Pro tab; not in Ship 1).
3. **HLTV markup drift.** Our selectors break when HLTV redesigns. Tests against fixtures catch this on re-capture, but production breakage is silent until the next cycle log shows "discovered 0 matches". Add a healthcheck: alert if a daily cycle ingests 0 demos for 3 consecutive days.
4. **Demo file format inconsistency.** Some HLTV archives are `.rar`, some `.zip`, some `.tar.gz`. `download_demos` must handle all three. `patoolib` covers this transparently but requires system extractors (`unrar`).
5. **Anon RLS surface.** Opening `select to anon` on three tables means we must audit every other table's policies for "anon can read demos → derive secrets" leaks. Current schema has no cross-references from `demos` to sensitive tables, but worth a deliberate audit step before merging the migration.
