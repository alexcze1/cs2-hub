# Public Pro Demos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public "Pro" section to the demos page that auto-ingests pro CS2 matches from HLTV (last ~90 days, daily refresh) and makes them browsable + viewable by any visitor (no auth required).

**Architecture:** A new scraper module on the VPS discovers matches on `hltv.org/results`, downloads + unzips each match's GOTV demo archive, and inserts one `demos` row per `.dem` file with `is_public=true`, `team_id=null`, `status='pending'`. The existing `_poll_loop` in `vps/main.py` parses those rows unchanged. After a successful parse the local `.dem` is deleted to keep VPS disk bounded; parsed `match_data` / `match_data_slim` / per-player + per-team stat rows stay in Postgres. Frontend grows a Team/Pro tab on `demos.html`; the demo viewer is unlocked for `anon` reads when `is_public=true`.

**Tech Stack:** Python 3 with `cloudscraper` (fallback: Playwright) + `rarfile`/`patoolib` for the scraper; Supabase Postgres (DDL + RLS) for storage; vanilla ES modules + supabase-js for the browser.

**Spec:** `docs/superpowers/specs/2026-05-18-public-pro-demos-design.md`. HLTV markup needs probing before we can lock selectors — treat Tasks 3–4 as exploratory; expect to revise once we see live HTML.

**Risks called out up front:**
- HLTV ToS forbids automated access; Cloudflare actively blocks bots. Expect breakage; rate-limit aggressively.
- Backfill is transiently disk-heavy (~150 MB per match × hundreds of matches). The ingest loop must refuse new downloads when `DEMOS_DIR` exceeds a soft cap.
- `match_data` jsonb is ~MB per demo. After ~50 demos parsed, measure Postgres growth before backfilling the full 90 days.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `cs2-hub/supabase-public-demos-migration.sql` | new | Schema additions + public-read RLS policies |
| `vps/hltv_scraper.py` | new | `list_recent_matches(days)` + `download_demos(match_url, dest_dir)` |
| `vps/tests/test_hltv_scraper.py` | new | Unit tests against canned HTML fixtures |
| `vps/tests/fixtures/hltv_results.html` | new | Saved snapshot of a results page for tests |
| `vps/tests/fixtures/hltv_match.html` | new | Saved snapshot of a match page for tests |
| `vps/hltv_ingest.py` | new | Glue: scraper → DB row inserts, idempotent |
| `vps/backfill_hltv.py` | new | One-shot CLI to backfill N days |
| `vps/main.py` | modify | Wire `_hltv_ingest_loop` into lifespan; delete `.dem` after public parse |
| `vps/requirements.txt` | modify | Add `cloudscraper`, `rarfile`, `beautifulsoup4` |
| `cs2-hub/demos.html` | modify | Add Team/Pro tab strip above filters |
| `cs2-hub/demos.js` | modify | Tab state + public query path (no auth) |
| `cs2-hub/demo-viewer.js` | modify | Allow anon read for `is_public=true` demos |
| `cs2-hub/style.css` | modify | Tab + Pro-demo card styles |

---

## Task 1: Schema migration

**Files:**
- Create: `cs2-hub/supabase-public-demos-migration.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Public Pro Demos: schema additions + RLS for anon read
-- Idempotent: safe to re-run.

-- 1. Allow demos rows without a team (HLTV-ingested demos are not team-scoped)
alter table demos alter column team_id drop not null;

-- 2. Public flag + provenance columns
alter table demos add column if not exists is_public        boolean not null default false;
alter table demos add column if not exists source           text not null default 'team_upload'
  check (source in ('team_upload', 'hltv'));
alter table demos add column if not exists source_match_id  text;  -- HLTV match id
alter table demos add column if not exists source_map_index int;   -- which .dem inside the archive (0-based)
alter table demos add column if not exists source_url       text;  -- HLTV match URL
alter table demos add column if not exists event_name       text;
alter table demos add column if not exists team_a_name      text;
alter table demos add column if not exists team_b_name      text;

-- 3. Idempotency: one row per (source, match, map)
create unique index if not exists demos_source_match_unique
  on demos (source, source_match_id, source_map_index)
  where source_match_id is not null;

-- 4. Index for the public-list query
create index if not exists demos_public_recent_idx
  on demos (created_at desc) where is_public = true;

-- 5. Public-read RLS policies (anon + authenticated)
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

- [ ] **Step 2: Apply migration in Supabase SQL editor; verify existing team policies still pass by reading one team demo as the owning user.**

---

## Task 2: Scraper — list recent matches

**Files:**
- Create: `vps/hltv_scraper.py`
- Modify: `vps/requirements.txt` (add `cloudscraper`, `beautifulsoup4`)

- [ ] **Step 1: Skeleton with `cloudscraper` session**

```python
# vps/hltv_scraper.py
import time
import cloudscraper
from bs4 import BeautifulSoup
from dataclasses import dataclass
from datetime import datetime, timedelta

BASE = "https://www.hltv.org"
_session = cloudscraper.create_scraper(browser={'browser': 'chrome', 'platform': 'windows'})

@dataclass
class MatchRef:
    hltv_id: str
    url: str
    date: datetime
    team_a: str
    team_b: str
    event: str

def _get(path: str, *, sleep: float = 2.0) -> str:
    # Rate-limit baked into the fetcher — every caller pays the toll.
    time.sleep(sleep)
    r = _session.get(f"{BASE}{path}", timeout=30)
    r.raise_for_status()
    return r.text

def list_recent_matches(days: int = 90) -> list[MatchRef]:
    """Walk paginated /results until matches older than `days` appear."""
    cutoff = datetime.utcnow() - timedelta(days=days)
    out: list[MatchRef] = []
    offset = 0
    while True:
        html = _get(f"/results?offset={offset}")
        page = _parse_results_page(html)
        if not page:
            break
        for m in page:
            if m.date < cutoff:
                return out
            out.append(m)
        offset += len(page)
    return out

def _parse_results_page(html: str) -> list[MatchRef]:
    # Selectors will need adjustment once we see live HTML.
    # Tests in test_hltv_scraper.py drive this against a saved fixture.
    soup = BeautifulSoup(html, "html.parser")
    raise NotImplementedError("Probe HLTV results page, then fill in selectors")
```

- [ ] **Step 2: Capture a real `/results` page once (curl or browser → save as fixture), write `test_parse_results_page` against it, then implement `_parse_results_page` until the test passes.**

- [ ] **Step 3: Tighten error handling — Cloudflare 403/503 should retry once with a longer sleep, then raise.**

---

## Task 3: Scraper — download + unzip demos

**Files:**
- Modify: `vps/hltv_scraper.py`
- Modify: `vps/requirements.txt` (add `rarfile`; system: `apt install unrar`)

- [ ] **Step 1: Implement `download_demos(match_url, dest_dir) -> list[tuple[int, Path, dict]]`**

Returns one tuple per map inside the archive: `(map_index, local_path, {"map_name": ...})`. The match page contains a "GOTV Demo" anchor pointing to `/download/demo/<id>`; follow it (HLTV redirects to a CDN), save as `.rar`, extract.

- [ ] **Step 2: Refuse download when `DEMOS_DIR` is above soft cap.**

```python
SOFT_CAP_BYTES = 20 * 1024**3  # 20 GB
def _dir_size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
```

The ingest loop (Task 5) checks this before each download and skips the match (it will be retried next cycle).

- [ ] **Step 3: Test against a saved match-page fixture for selector parsing; mock the actual download in tests (don't hit HLTV from CI).**

---

## Task 4: Ingest glue

**Files:**
- Create: `vps/hltv_ingest.py`

- [ ] **Step 1: `ingest_match(match: MatchRef)` — download, unzip, insert one `demos` row per `.dem`**

```python
# vps/hltv_ingest.py
import uuid
from pathlib import Path
from .hltv_scraper import MatchRef, download_demos
# DB helper imported from main lives in main.py — refactor get_db into a shared module
# (vps/db.py) as Step 0 if it isn't already.

def ingest_match(match: MatchRef, demos_dir: Path) -> int:
    """Return number of new demos inserted (0 if already ingested)."""
    # Skip if any row already exists for this match
    if _already_ingested(match.hltv_id):
        return 0
    pairs = download_demos(match.url, demos_dir)
    inserted = 0
    for map_index, dem_path, meta in pairs:
        demo_id = str(uuid.uuid4())
        # Rename file to {demo_id}.dem so _process_one can find it via local:{demo_id}.dem
        final = demos_dir / f"{demo_id}.dem"
        dem_path.rename(final)
        _insert_pending_public(
            demo_id=demo_id,
            storage_path=f"local:{demo_id}.dem",
            source="hltv",
            source_match_id=match.hltv_id,
            source_map_index=map_index,
            source_url=match.url,
            event_name=match.event,
            team_a_name=match.team_a,
            team_b_name=match.team_b,
        )
        inserted += 1
    return inserted
```

`_already_ingested` and `_insert_pending_public` are thin DB helpers; queries are obvious from the column list. `uploaded_by` is set to `null` for HLTV rows (RLS allows it because the new `public_demos_read` policy ignores `uploaded_by`).

- [ ] **Step 2: Test idempotency — call `ingest_match` twice with the same match, second call returns 0.**

---

## Task 5: Background loop in `main.py`

**Files:**
- Modify: `vps/main.py`

- [ ] **Step 1: Add `_hltv_ingest_loop` alongside `_poll_loop`**

```python
HLTV_INGEST_INTERVAL = int(os.getenv("HLTV_INGEST_INTERVAL", str(24 * 3600)))
HLTV_INGEST_DAYS     = int(os.getenv("HLTV_INGEST_DAYS", "2"))  # daily incremental window

async def _hltv_ingest_loop():
    print("HLTV ingest loop started")
    while True:
        try:
            await asyncio.get_event_loop().run_in_executor(None, _hltv_ingest_once)
        except asyncio.CancelledError:
            raise
        except BaseException as e:
            print(f"HLTV ingest error ({type(e).__name__}): {e}")
        await asyncio.sleep(HLTV_INGEST_INTERVAL)

def _hltv_ingest_once():
    from hltv_scraper import list_recent_matches
    from hltv_ingest import ingest_match
    matches = list_recent_matches(days=HLTV_INGEST_DAYS)
    print(f"[hltv] discovered {len(matches)} matches in last {HLTV_INGEST_DAYS}d")
    for m in matches:
        try:
            n = ingest_match(m, DEMOS_DIR)
            if n:
                print(f"[hltv] ingested {n} demos for {m.team_a} vs {m.team_b} ({m.hltv_id})")
        except Exception as e:
            print(f"[hltv] skip {m.hltv_id}: {e}")
```

- [ ] **Step 2: Wire into `lifespan`**

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    DEMOS_DIR.mkdir(parents=True, exist_ok=True)
    poll_task   = asyncio.create_task(_poll_loop())
    ingest_task = asyncio.create_task(_hltv_ingest_loop())
    yield
    poll_task.cancel()
    ingest_task.cancel()
```

---

## Task 6: Delete `.dem` after public parse

**Files:**
- Modify: `vps/main.py`

- [ ] **Step 1: After the stats write in `_process_one`, if the demo is public + local, unlink the file**

```python
# at the end of the success branch in _process_one, after the stats write:
if is_local and _is_public_demo(demo_id):
    Path(tmp_path).unlink(missing_ok=True)
    print(f"[cleanup] deleted local .dem for public demo {demo_id}")
```

`_is_public_demo` does a tiny `SELECT is_public FROM demos WHERE id=%s`. Alternative (less query, more coupling): pass `is_public` through `_fetch_pending` and into `demo`. Pick whichever you prefer — the SELECT is fine.

**On error:** do NOT delete. Leaving the file lets us reparse without re-downloading from HLTV. The ingest loop's idempotency guard already prevents re-download.

---

## Task 7: Frontend — Team/Pro tab on demos page

**Files:**
- Modify: `cs2-hub/demos.html`, `cs2-hub/demos.js`, `cs2-hub/style.css`

- [ ] **Step 1: Add tab strip above filters in `demos.html`**

```html
<section class="dx-tabs" id="demos-tabs">
  <button class="dx-tab is-active" data-scope="team">Team</button>
  <button class="dx-tab" data-scope="public">Pro</button>
</section>
```

- [ ] **Step 2: In `demos.js`, branch the query by scope**

The existing team query uses RLS to filter to the user's team. The public query is simply:

```js
const { data } = await supabase
  .from('demos')
  .select('id, map, played_at, score_ct, score_t, team_a_name, team_b_name, event_name, source_url, status')
  .eq('is_public', true)
  .order('played_at', { ascending: false })
  .limit(100)
```

- [ ] **Step 3: Hide upload affordances and team-only filters when scope=public.**

- [ ] **Step 4: Allow the page to render when there is no signed-in user, but the Pro tab is the default in that case.**

---

## Task 8: Demo viewer anon access

**Files:**
- Modify: `cs2-hub/demo-viewer.js` (and possibly `analysis.js` if Scoreboard tab gates on auth)

- [ ] **Step 1: Audit `demo-viewer.js` for `auth.getUser()` or sidebar/auth gates that would block anon users; remove the gate when the loaded demo has `is_public=true`.**

- [ ] **Step 2: Confirm `match_data` / `match_data_slim` / `demo_players` / `demo_team_stats` reads succeed under the new RLS policies for an anon session.**

---

## Task 9: One-shot backfill

**Files:**
- Create: `vps/backfill_hltv.py`

- [ ] **Step 1: CLI that calls `list_recent_matches(days=90)` and feeds each match to `ingest_match`, with a 30s sleep between matches and the same disk-cap check.**

- [ ] **Step 2: Run from VPS shell manually after Tasks 1–6 are merged. Watch logs; abort after first 50 demos to measure Postgres growth before continuing.**

---

## Out of scope for this plan

- Demo viewer UX changes for public demos (e.g., highlighting pro player names, linking back to HLTV match page). Add in a follow-up once the data is flowing.
- Backfill > 90 days, or smarter prioritization (Tier-1 events first).
- Faceit / ESEA ingest as alternate sources.
- Replacing `cloudscraper` with a managed proxy / Playwright residential setup (only if Cloudflare starts blocking us).
