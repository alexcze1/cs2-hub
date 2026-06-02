# vps/hltv_scraper.py
#
# HLTV match discovery + demo download. Used by hltv_ingest.py.
#
# Spec: docs/superpowers/specs/2026-05-18-public-pro-demos-design.md
# Plan: docs/superpowers/plans/2026-05-18-public-pro-demos.md
#
# Notes:
# - HLTV has no public API and their ToS forbids automated access. We use
#   cloudscraper to clear Cloudflare. If it stops working, escalate to Playwright.
# - All HTTP fetches go through `_get`, which sleeps before each request. Callers
#   cannot bypass the rate limit by accident.
# - Selectors live in `_parse_results_page` / `_parse_match_page` and are
#   validated against checked-in HTML fixtures in tests/fixtures/.

from __future__ import annotations

import logging
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import cloudscraper
import patoolib
from bs4 import BeautifulSoup

log = logging.getLogger(__name__)

BASE = "https://www.hltv.org"

# Realistic desktop-Chrome UA used by both cloudscraper and Playwright. Keeping
# them aligned helps when we hand off cookies between transports.
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
)

# One session per process; cloudscraper caches the CF clearance cookie.
_session = cloudscraper.create_scraper(
    browser={"browser": "chrome", "platform": "windows", "desktop": True},
)

# Default sleep before every fetch. Callers can pass `sleep=` to override
# (backfill uses larger values), but never smaller than DEFAULT_SLEEP.
DEFAULT_SLEEP = 2.0

# ── Playwright fallback ─────────────────────────────────────────────────────
# Cloudflare regularly hard-blocks cloudscraper (the JS challenge has moved
# past what cloudscraper can solve). When that happens we switch the whole
# process to Playwright with a real Chromium engine.
#
# Lazy import + lazy launch — Playwright is a 150 MB browser download, so a
# dev box / CI that never hits the fallback doesn't pay for it. Once flipped,
# we stay on Playwright for the rest of the process; probing cloudscraper
# every request would just add CF-challenge latency we already failed.
_pw_lock = threading.Lock()
_pw_handle = None       # sync_playwright().start() handle
_pw_browser = None
_pw_context = None
_use_playwright = bool(int(os.getenv("HLTV_FORCE_PLAYWRIGHT", "0")))

# Anti-detection init script. Without this, headless Chromium is identified by
# Cloudflare's bot heuristics (navigator.webdriver is True, no window.chrome,
# zero plugins) and served the "Just a moment..." JS challenge page — which the
# automated browser can never solve, because the challenge specifically detects
# automation. Apply once at context creation so every page inherits it.
_STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
window.chrome = window.chrome || { runtime: {} };
const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
if (originalQuery) {
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications'
      ? Promise.resolve({state: Notification.permission})
      : originalQuery(parameters)
  );
}
"""


# Counter for proactive context recycling. CF gradually fingerprints a
# long-running context by tracking its cookie/JS-challenge history; once
# flagged, subsequent fetches all serve the "Just a moment..." page. Cheap
# to rotate the context every PAGE_RECYCLE_EVERY fetches and re-clear the
# challenge from scratch.
_pw_fetch_count = 0
PAGE_RECYCLE_EVERY = int(os.getenv("HLTV_PW_RECYCLE_EVERY", "30"))


def _new_context():
    """Build a fresh BrowserContext with the standard stealth setup.

    Pulled out so we can rotate the context without restarting Chromium.
    Caller must hold `_pw_lock`.
    """
    ctx = _pw_browser.new_context(
        user_agent=_UA,
        viewport={"width": 1440, "height": 900},
        accept_downloads=True,
    )
    ctx.add_init_script(_STEALTH_JS)
    return ctx


def _ensure_playwright() -> None:
    """Lazy-launch a single headless Chromium for the rest of the process."""
    global _pw_handle, _pw_browser, _pw_context
    if _pw_browser is not None:
        return
    with _pw_lock:
        if _pw_browser is not None:
            return
        from playwright.sync_api import sync_playwright  # lazy import
        _pw_handle = sync_playwright().start()
        # --disable-blink-features=AutomationControlled removes the
        # `navigator.webdriver = true` signal that CF flags as automation.
        # Combined with _STEALTH_JS this is enough to clear CF's match-page
        # challenge consistently (verified live 2026-05-27).
        _pw_browser = _pw_handle.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        _pw_context = _new_context()
        log.info("[hltv] Playwright Chromium launched for CF fallback")


def _recycle_context() -> None:
    """Drop the current context and build a fresh one (same browser).

    Closing the context wipes cookies + page state, so the next CF challenge
    starts from scratch. ~100ms to set up — much cheaper than relaunching
    Chromium. Used both proactively (every PAGE_RECYCLE_EVERY fetches) and
    reactively (after a CF challenge that won't clear).
    """
    global _pw_context, _pw_fetch_count
    with _pw_lock:
        try:
            if _pw_context is not None:
                _pw_context.close()
        except Exception as e:
            log.warning("[hltv] context close failed: %s", e)
        _pw_context = _new_context()
        _pw_fetch_count = 0
        log.info("[hltv] Playwright context recycled")


def shutdown_playwright() -> None:
    """Stop the headless browser. Safe to call from a FastAPI lifespan shutdown."""
    global _pw_handle, _pw_browser, _pw_context, _pw_fetch_count
    with _pw_lock:
        if _pw_browser is not None:
            try: _pw_browser.close()
            except Exception: pass
            _pw_browser = None
            _pw_context = None
        if _pw_handle is not None:
            try: _pw_handle.stop()
            except Exception: pass
            _pw_handle = None
        _pw_fetch_count = 0


def _get_via_playwright(url: str) -> str:
    """Fetch `url` through the headless Chromium context.

    CF protection varies per endpoint — /results passes with stealth in <1 s
    but /matches/<id>/... sometimes see a stricter challenge that doesn't
    resolve. Three attempts:
      1. fresh page in current context
      2. fresh page in current context after a 3 s pause
      3. RECYCLED context (drops cookies, re-runs stealth init) + fresh page

    Attempt 3 is the important one: once CF flags a context's cookie/JS
    challenge history, every page in that context inherits the flag.
    Opening a new page in the same context wasn't escaping the flag — the
    trickle was stuck CF-blocking 100% of match pages for hours despite
    the per-page retry. Closing+rebuilding the context starts CF over.

    Also rotates the context proactively every PAGE_RECYCLE_EVERY fetches
    so we don't drift into the flagged state in the first place.
    """
    _ensure_playwright()

    global _pw_fetch_count
    if _pw_fetch_count >= PAGE_RECYCLE_EVERY:
        _recycle_context()
    _pw_fetch_count += 1

    for attempt in (1, 2, 3):
        if attempt == 3:
            _recycle_context()
        page = _pw_context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            deadline = time.time() + 30.0
            while time.time() < deadline:
                if "Just a moment" not in page.title():
                    # Past the CF challenge — give lazy-loaded resources a
                    # chance to fire (HLTV's team pages set img.src via JS after
                    # the bodyshot CDN replies, and that comes well after
                    # domcontentloaded). networkidle = no network activity for
                    # 500 ms; cap at 10 s so a single slow tracker pixel
                    # doesn't hold us up.
                    try:
                        page.wait_for_load_state("networkidle", timeout=10000)
                    except Exception:
                        pass
                    return page.content()
                page.wait_for_timeout(500)
            if attempt == 3:
                log.warning("[hltv] CF challenge did not clear for %s after context "
                            "recycle — returning challenge HTML; selectors will not match", url)
                return page.content()
            log.info("[hltv] CF stuck on %s (attempt %d), retrying", url, attempt)
        finally:
            page.close()
        # Pause briefly between attempts so CF's session state has time to settle.
        time.sleep(3)
    # Unreachable — the loop above either returns or falls through.
    raise RuntimeError("unreachable")


def _download_archive_via_playwright(url: str, out_path: Path) -> None:
    """Download the GOTV archive via Playwright.

    HLTV's `/download/demo/<id>` returns a 302 → `r2-demos.hltv.org/.../<file>.rar`
    served as `application/x-compressed`. Chromium recognises the binary
    response as a download and raises "Page.goto: Download is starting".

    Direct HTTP via cloudscraper or APIRequestContext both 403 here even with
    valid CF cookies — HLTV's CDN appears to require the browser's TLS
    fingerprint. Doing the download through a real page sidesteps the issue.

    We use an explicit `page.on('download', ...)` listener + poll instead of
    `expect_download()`. The latter occasionally races with the navigation
    exception when the binary response arrives faster than expect_download's
    internal subscriber finishes registering.
    """
    _ensure_playwright()
    page = _pw_context.new_page()
    captured: list = []
    page.on("download", lambda d: captured.append(d))
    try:
        try:
            # Default wait_until='load' would block until a non-download page
            # loaded — for a binary response we just need the navigation
            # request to commit so Chromium decides "this is a download".
            page.goto(url, wait_until="commit", timeout=30000)
        except Exception:
            # "Page.goto: Download is starting" is the expected signal here.
            pass

        # Poll up to 180s for the download event. Real-world archives sit in
        # the 30-200 MB range — most fire within the first second once the
        # CDN responds, but big archives can take a while to even begin.
        for _ in range(180):
            if captured:
                break
            page.wait_for_timeout(1000)
        if not captured:
            raise RuntimeError(f"no download triggered for {url}")

        download = captured[0]
        download.save_as(str(out_path))
        failure = download.failure()
        if failure:
            raise RuntimeError(f"download failed for {url}: {failure}")
    finally:
        page.close()


@dataclass
class MatchRef:
    hltv_id: str
    url: str            # absolute URL
    date: datetime      # UTC
    team_a: str
    team_b: str
    event: str


@dataclass
class MapResult:
    """One played map within a match, as reported by HLTV.

    Names are taken verbatim from the match page and may differ in casing
    or spelling from MatchRef.team_a / team_b (HLTV occasionally swaps left/
    right ordering between the results list and the match page). Callers
    should match by case-insensitive name when joining back to MatchRef.
    """
    map_index: int        # 0-based, in HLTV's mapholder order
    map_name: str         # 'mirage', 'nuke', ... (lower, no de_ prefix)
    team1_name: str       # left team on the match page
    team1_score: int
    team2_name: str       # right team
    team2_score: int


class HLTVBlockedError(RuntimeError):
    """Cloudflare blocked us (403/503 after retry). Caller should back off."""


class DiskCapExceeded(RuntimeError):
    """DEMOS_DIR is above the soft cap. Caller should skip and retry next cycle."""


# Soft cap on the directory we extract demos into. Ingest refuses new downloads
# above this, but the parser keeps draining pending rows so the cap self-recovers.
SOFT_CAP_BYTES = int(os.getenv("HLTV_DEMOS_DIR_SOFT_CAP_BYTES", str(20 * 1024**3)))


def _dir_size(p: Path) -> int:
    """Bytes used by all files under p (recursive). 0 if p doesn't exist."""
    if not p.exists():
        return 0
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def _get(path_or_url: str, *, sleep: float = DEFAULT_SLEEP) -> str:
    """Fetch a URL or root-relative path. Sleeps `max(sleep, DEFAULT_SLEEP)` first.

    Transport choice:
      1. cloudscraper (cheap, fast) for the first request, with one retry.
      2. If both attempts hard-block (403/503), flip the process to Playwright
         and stay there. Cloudscraper rarely recovers mid-process once CF has
         decided we're a bot.

    Setting HLTV_FORCE_PLAYWRIGHT=1 skips cloudscraper entirely — useful on
    boxes where we know CF won't let cloudscraper through.
    """
    global _use_playwright
    time.sleep(max(sleep, DEFAULT_SLEEP))
    url = path_or_url if path_or_url.startswith("http") else f"{BASE}{path_or_url}"

    if _use_playwright:
        return _get_via_playwright(url)

    for attempt in (1, 2):
        r = _session.get(url, timeout=30)
        if r.status_code in (403, 503) and attempt == 1:
            # One retry with a longer pause; CF challenge sometimes clears on second hit.
            log.warning("HLTV %s on %s, retrying after 10s", r.status_code, url)
            time.sleep(10)
            continue
        if r.status_code in (403, 503):
            log.warning("HLTV %s persists on %s — escalating to Playwright for the "
                        "rest of this process", r.status_code, url)
            _use_playwright = True
            return _get_via_playwright(url)
        r.raise_for_status()
        return r.text
    raise HLTVBlockedError(f"Unreachable: exhausted retries on {url}")  # defensive


def list_recent_matches(days: int = 90) -> list[MatchRef]:
    """Walk paginated /results until matches older than `days` appear.

    Returns matches newest-first. Stops as soon as the first too-old match
    is seen on a page (HLTV /results is chronologically ordered).
    """
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


def list_team_matches(team_id: int, days: int = 90, max_pages: int = 4) -> list[MatchRef]:
    """Walk /results?team=<id>&offset=<n> for ONE team, newest-first.

    HLTV's results page accepts a team filter and returns only matches where
    that team played. Same chronological order + same .result-con structure
    as the unfiltered list, so we reuse `_parse_results_page`.

    Caps at `max_pages` * 100 = 400 results so a runaway team filter (or a
    very prolific team) can't burn HLTV-rate-limit budget. days=90 is the
    natural stop for the veto-sync use case.
    """
    cutoff = datetime.utcnow() - timedelta(days=days)
    out: list[MatchRef] = []
    offset = 0
    for _ in range(max_pages):
        html = _get(f"/results?team={team_id}&offset={offset}")
        page = _parse_results_page(html)
        if not page:
            break
        oldest_seen = False
        for m in page:
            if m.date < cutoff:
                oldest_seen = True
                break
            out.append(m)
        if oldest_seen or len(page) < 100:
            break
        offset += len(page)
    return out


# --------------------------------------------------------------------------- #
# Parsers — selectors confirmed against tests/fixtures/. If HLTV redesigns,
# re-capture the fixture (see tests/fixtures/README.md) and fix here.
# --------------------------------------------------------------------------- #

# HLTV match URLs look like /matches/2378234/team-a-vs-team-b-event-name
_MATCH_ID_RE = re.compile(r"/matches/(\d+)/")


def _parse_results_page(html: str) -> list[MatchRef]:
    """Parse one /results page into a list of MatchRef (newest-first).

    Selector layout (validated 2026-05-22 against tests/fixtures/hltv_results.html):
      .results-sublist
        .standard-headline    ('Results for May 22nd 2026' or 'Featured results')
        .result-con
          a.a-reset[href=/matches/<id>/<slug>]
            .team             team-a name
            .team.team-won    team-b name (winner gets extra class)
            .event-name       event title
    """
    soup = BeautifulSoup(html, "html.parser")
    out: list[MatchRef] = []

    # Each result row is an anchor with class "a-reset" inside a .result-con.
    for row in soup.select("div.result-con a.a-reset"):
        href = row.get("href") or ""
        m = _MATCH_ID_RE.search(href)
        if not m:
            continue
        hltv_id = m.group(1)
        url = href if href.startswith("http") else f"{BASE}{href}"

        teams = [t.get_text(strip=True) for t in row.select(".team")]
        team_a = teams[0] if len(teams) > 0 else ""
        team_b = teams[1] if len(teams) > 1 else ""

        event_el = row.select_one(".event-name") or row.select_one(".event")
        event = event_el.get_text(strip=True) if event_el else ""

        # /results pages group rows under a "results-sublist" with a date header,
        # so we walk up to find the nearest preceding date header.
        date = _extract_row_date(row)
        if date is None:
            continue

        out.append(MatchRef(hltv_id=hltv_id, url=url, date=date,
                            team_a=team_a, team_b=team_b, event=event))
    return out


def _extract_row_date(row) -> datetime | None:
    """Find the date that applies to a result row.

    Tries two sources, most-specific first:

      1. ``data-zonedgrouping-entry-unix`` on the row's ``<div class="result-con">``
         parent — HLTV emits this on every grouped result (UTC milliseconds
         since epoch). This is the only date source on layouts that don't
         render per-day headlines (e.g. ``/results?team=<id>`` and the
         "Featured results" block at the top of ``/results``). Skipping it
         was the cause of the veto-sync seeing only the handful of matches
         that happened to fall in a sublist with a date headline.

      2. Sublist headline ("Results for May 22nd 2026") on the legacy
         ``.results-sublist`` group, for fixtures captured before HLTV
         attached the per-row attribute.

    Returns None only when *both* sources are missing, in which case the
    caller skips the row.
    """
    result_con = row.find_parent("div", class_="result-con")
    if result_con is not None:
        raw = result_con.get("data-zonedgrouping-entry-unix")
        if raw:
            try:
                ms = int(raw)
            except ValueError:
                ms = None
            if ms is not None:
                return datetime.utcfromtimestamp(ms / 1000.0)

    sublist = row.find_parent("div", class_="results-sublist")
    if not sublist:
        return None
    headline = sublist.select_one(".standard-headline")
    if not headline:
        return None
    return _parse_headline_date(headline.get_text(strip=True))


_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}

# HLTV uses month-first form: "Results for May 22nd 2026" (modern, 2025+).
# We also accept the older day-first form "17th of May 2026" so legacy
# fixtures keep parsing. Both forms must produce identical datetimes.
_HEADLINE_DATE_RE_MONTH_FIRST = re.compile(
    r"([A-Za-z]+)\s+(\d{1,2})\w{0,2}\s+(\d{4})",
    re.IGNORECASE,
)
_HEADLINE_DATE_RE_DAY_FIRST = re.compile(
    r"(\d{1,2})\w{0,2}\s+of\s+([A-Za-z]+)\s+(\d{4})",
    re.IGNORECASE,
)


def _parse_headline_date(text: str) -> datetime | None:
    """Parse a /results sublist headline → datetime at midnight UTC.

    Accepts both modern and legacy HLTV phrasings:
      - 'Results for May 22nd 2026'    (modern, month-first)
      - 'Results for 17th of May 2026' (legacy)

    Returns None for non-dated headlines like 'Featured results'.
    """
    # Try day-first first because it's the more specific pattern (contains "of").
    # Otherwise "May 22nd 2026" would loosely match against the day-first regex
    # in unrelated text by accident.
    m = _HEADLINE_DATE_RE_DAY_FIRST.search(text)
    if m:
        day, month_name, year = m.group(1), m.group(2), m.group(3)
    else:
        m = _HEADLINE_DATE_RE_MONTH_FIRST.search(text)
        if not m:
            return None
        month_name, day, year = m.group(1), m.group(2), m.group(3)
    month = _MONTHS.get(month_name.lower())
    if not month:
        return None
    return datetime(int(year), month, int(day))


# --------------------------------------------------------------------------- #
# Demo download — match page → GOTV archive → extracted .dem paths.
# --------------------------------------------------------------------------- #

# Match page anchor: <a ... href="/download/demo/12345">GOTV Demo</a>
_DEMO_DOWNLOAD_HREF_RE = re.compile(r"^/download/demo/\d+/?$")

# Standard CS2 active-duty + reserve maps. Used for best-effort map_name
# extraction from demo filenames; unknown maps return None (the parser
# fills in the authoritative map name later anyway).
_KNOWN_MAPS = (
    "ancient", "anubis", "dust2", "inferno", "mirage",
    "nuke", "overpass", "train", "vertigo", "cache", "tuscan",
)
_FILENAME_MAP_RE = re.compile(
    rf"({'|'.join(_KNOWN_MAPS)})", re.IGNORECASE,
)


def download_demos(match_url: str, dest_dir: Path) -> list[tuple[int, Path, dict]]:
    """Download the GOTV archive for a match, extract, return one tuple per .dem.

    Returns: list of (map_index, dem_path, meta) where map_index is 0-based by
    sorted filename order inside the archive, and meta is:
      {
        "map_name": str | None,
        "map_results": list[MapResult],  # all played maps for the match
      }

    The same map_results list is attached to every dem in the batch so the
    ingest layer can resolve per-map scores. Callers join by map name
    (case-insensitive, with the de_ prefix and 'dust' alias stripped) and
    fall back to map_index when the name lookup misses.

    Returns [] if the match has no published demo.

    Side effects:
      - Writes .dem files to dest_dir
      - Cleans up the archive + extraction temp dir on success and failure

    Raises:
      DiskCapExceeded — dest_dir already over SOFT_CAP_BYTES before download
      HLTVBlockedError — Cloudflare blocked us
      RuntimeError — match page had no demo link, or extraction yielded no .dem
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    used = _dir_size(dest_dir)
    if used > SOFT_CAP_BYTES:
        raise DiskCapExceeded(f"{dest_dir} at {used / 1024**3:.1f} GB > cap")

    html = _get(match_url)
    download_path = _parse_match_page_demo_href(html)
    if not download_path:
        return []

    # Per-map scores + precise played-at datetime from the same match page
    # we just fetched; reused for every dem in the batch so ingest doesn't
    # re-hit HLTV. played_at is the scheduled-match datetime in UTC; the
    # /results headline only gives midnight-of-date, so this is the only
    # path to a real timestamp.
    map_results = parse_match_page_map_results(html)
    played_at = parse_match_page_played_at(html)

    # Stream the archive to a temp file (could be hundreds of MB). cloudscraper
    # follows the /download/demo/<id> redirect to the CDN automatically.
    archive_url = download_path if download_path.startswith("http") else f"{BASE}{download_path}"
    tmp_archive = dest_dir / f".tmp-{uuid.uuid4()}.archive"
    extract_dir = dest_dir / f".tmp-extract-{uuid.uuid4()}"

    try:
        _download_archive(archive_url, tmp_archive)
        extract_dir.mkdir()
        patoolib.extract_archive(str(tmp_archive), outdir=str(extract_dir), verbosity=-1)

        dem_files = sorted(extract_dir.rglob("*.dem"))
        if not dem_files:
            raise RuntimeError(f"no .dem files in archive from {match_url}")

        # Move each .dem to dest_dir under a unique temp name; ingest layer renames
        # to {demo_id}.dem before inserting the DB row.
        out: list[tuple[int, Path, dict]] = []
        for idx, src in enumerate(dem_files):
            final = dest_dir / f".staged-{uuid.uuid4()}.dem"
            shutil.move(str(src), str(final))
            map_name = _map_from_filename(src.name)
            out.append((idx, final, {
                "map_name":    map_name,
                "map_results": map_results,
                "played_at":   played_at,
            }))
        return out

    finally:
        tmp_archive.unlink(missing_ok=True)
        if extract_dir.exists():
            shutil.rmtree(extract_dir, ignore_errors=True)


def match_scores_for(
    *,
    team_a_name: str,
    team_b_name: str,
    map_name: str | None,
    map_index: int,
    map_results: list[MapResult],
) -> tuple[int, int] | None:
    """Resolve (team_a_score, team_b_score) for one .dem using HLTV match data.

    Joins on map_name first (case-insensitive, stripped of 'de_' prefix and
    the dust/dust2 alias), then falls back to map_index. Returns None when:
      - map_results is empty
      - the map can't be located by name OR index
      - neither HLTV-side name matches our team_a_name / team_b_name

    Falling back to index handles the rare case where the parser's map_name
    inference from the .dem filename misses (random archive naming); the
    archive's sorted-filename order matches HLTV's mapholder order in
    practice. If both joins fail we return None and the caller leaves the
    scores NULL — better than guessing.
    """
    if not map_results:
        return None

    norm = lambda s: (s or "").lower().replace("de_", "").replace("dust2", "dust")
    map_key = norm(map_name)

    mr = None
    if map_key:
        for r in map_results:
            if norm(r.map_name) == map_key:
                mr = r
                break
    if mr is None and 0 <= map_index < len(map_results):
        mr = map_results[map_index]
    if mr is None:
        return None

    ta = team_a_name.strip().lower()
    tb = team_b_name.strip().lower()
    t1 = mr.team1_name.strip().lower()
    t2 = mr.team2_name.strip().lower()

    if t1 == ta and t2 == tb:
        return (mr.team1_score, mr.team2_score)
    if t1 == tb and t2 == ta:
        return (mr.team2_score, mr.team1_score)
    return None


def _download_archive(url: str, out_path: Path) -> None:
    """Stream a (potentially large) archive to disk.

    Uses cloudscraper streaming by default, falls back to Playwright's download
    API when CF blocks. Playwright is automatically picked when the process has
    already flipped via _get().
    """
    time.sleep(DEFAULT_SLEEP)

    if _use_playwright:
        _download_archive_via_playwright(url, out_path)
        return

    with _session.get(url, stream=True, timeout=120) as r:
        if r.status_code in (403, 503):
            log.warning("HLTV %s on archive %s — escalating to Playwright", r.status_code, url)
            globals()["_use_playwright"] = True
            _download_archive_via_playwright(url, out_path)
            return
        r.raise_for_status()
        with out_path.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)


def _parse_match_page_demo_href(html: str) -> str | None:
    """Find the GOTV demo download href on a match page. Returns root-relative
    or absolute URL, or None if no demo link present (live / cancelled match).
    """
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if _DEMO_DOWNLOAD_HREF_RE.match(href):
            return href
    return None


def parse_match_page_map_results(html: str) -> list[MapResult]:
    """Parse per-map (team, score) pairs from a match page.

    Skips unplayed maps (BO3/5 maps the loser didn't reach). map_index is
    assigned in document order over PLAYED maps only — this aligns with
    the .dem archive ordering used by download_demos, so callers can join
    on map_index.

    Selector layout (validated 2026-05-28 against tests/fixtures/hltv_match.html):
      .mapholder
        .played .mapname                  -> map display name
        .results.played                    -> only present for played maps
          .results-left   .results-teamname   -> team1 name
                          .results-team-score -> team1 score
          .results-right  .results-teamname   -> team2 name
                          .results-team-score -> team2 score
    """
    soup = BeautifulSoup(html, "html.parser")
    out: list[MapResult] = []
    idx = 0
    for holder in soup.select("div.mapholder"):
        results = holder.select_one("div.results.played")
        if not results:
            continue  # unplayed map in a BO3/5

        name_el = holder.select_one(".mapname")
        map_name = (name_el.get_text(strip=True) if name_el else "").lower()
        if not map_name:
            continue

        left  = results.select_one(".results-left")
        right = results.select_one(".results-right")
        if not left or not right:
            continue

        t1_name_el  = left.select_one(".results-teamname")
        t1_score_el = left.select_one(".results-team-score")
        t2_name_el  = right.select_one(".results-teamname")
        t2_score_el = right.select_one(".results-team-score")
        if not (t1_name_el and t1_score_el and t2_name_el and t2_score_el):
            continue

        try:
            t1_score = int(t1_score_el.get_text(strip=True))
            t2_score = int(t2_score_el.get_text(strip=True))
        except ValueError:
            # Forfeit/walkover rows sometimes carry '-' instead of a number.
            continue

        out.append(MapResult(
            map_index=idx,
            map_name=map_name,
            team1_name=t1_name_el.get_text(strip=True),
            team1_score=t1_score,
            team2_name=t2_name_el.get_text(strip=True),
            team2_score=t2_score,
        ))
        idx += 1

    return out


def fetch_match_page_map_results(match_url: str) -> list[MapResult]:
    """Fetch a match page and parse per-map results. Convenience wrapper.

    Useful for the public-demos backfill, which needs scores for an existing
    match without going through the full download_demos path.
    """
    return parse_match_page_map_results(_get(match_url))


def parse_match_page_played_at(html: str) -> datetime | None:
    """Extract the scheduled-match datetime (UTC) from an HLTV match page.

    HLTV renders the time as ``<div class="time" data-unix="1779367800000">``
    inside ``div.timeAndEvent`` (milliseconds since epoch, UTC). Returns None
    when the element is missing or the value isn't an integer — callers fall
    back to whatever date they already had.
    """
    soup = BeautifulSoup(html, "html.parser")
    el = soup.select_one("div.timeAndEvent .time[data-unix]") \
        or soup.select_one("div.timeAndEvent .date[data-unix]")
    if not el:
        return None
    raw = el.get("data-unix") or ""
    try:
        ms = int(raw)
    except ValueError:
        return None
    return datetime.utcfromtimestamp(ms / 1000.0)


def fetch_match_page_played_at(match_url: str) -> datetime | None:
    """Fetch a match page and return its scheduled-match datetime (UTC)."""
    return parse_match_page_played_at(_get(match_url))


def _map_from_filename(name: str) -> str | None:
    """Best-effort: pull a known map name from a demo filename. Returns None
    if no known map is in the name. The parser fills in the authoritative map
    name later — this is just for logging / pre-parse display.
    """
    m = _FILENAME_MAP_RE.search(name)
    if not m:
        return None
    return f"de_{m.group(1).lower()}"


# --------------------------------------------------------------------------- #
# Fixture capture helpers — invoked from a dev shell, not from production code.
# --------------------------------------------------------------------------- #


def _capture_results_fixture(out_path: Path) -> int:
    """Fetch /results and save raw HTML. Returns bytes written."""
    html = _get("/results")
    out_path.write_text(html, encoding="utf-8")
    return len(html)


def _capture_match_fixture(match_url: str, out_path: Path) -> int:
    """Fetch a match page and save raw HTML. Returns bytes written."""
    html = _get(match_url)
    out_path.write_text(html, encoding="utf-8")
    return len(html)


if __name__ == "__main__":
    # python -m hltv_scraper capture-results tests/fixtures/hltv_results.html
    # python -m hltv_scraper capture-match <url> tests/fixtures/hltv_match.html
    import sys

    if len(sys.argv) >= 3 and sys.argv[1] == "capture-results":
        n = _capture_results_fixture(Path(sys.argv[2]))
        print(f"wrote {n} bytes to {sys.argv[2]}")
    elif len(sys.argv) >= 4 and sys.argv[1] == "capture-match":
        n = _capture_match_fixture(sys.argv[2], Path(sys.argv[3]))
        print(f"wrote {n} bytes to {sys.argv[3]}")
    else:
        print("usage:")
        print("  python -m hltv_scraper capture-results <path>")
        print("  python -m hltv_scraper capture-match <url> <path>")
        sys.exit(2)
