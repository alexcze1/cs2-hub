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
        _pw_context = _pw_browser.new_context(
            user_agent=_UA,
            viewport={"width": 1440, "height": 900},
            accept_downloads=True,
        )
        _pw_context.add_init_script(_STEALTH_JS)
        log.info("[hltv] Playwright Chromium launched for CF fallback")


def shutdown_playwright() -> None:
    """Stop the headless browser. Safe to call from a FastAPI lifespan shutdown."""
    global _pw_handle, _pw_browser, _pw_context
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


def _get_via_playwright(url: str) -> str:
    """Fetch `url` through the headless Chromium context.

    CF protection varies per endpoint — /results passes with stealth in <1 s
    but /team/<id>/<slug> and other less-common URLs sometimes see a stricter
    challenge that doesn't resolve. We try once, wait up to 30 s for the
    challenge to clear, and if it doesn't, close + reopen the page and retry
    once. A second navigation usually slips past because CF treats it as a
    follow-up click on a "settled" session.
    """
    _ensure_playwright()
    for attempt in (1, 2):
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
            if attempt == 2:
                log.warning("[hltv] CF challenge did not clear for %s after retry — "
                            "returning challenge HTML; selectors will not match", url)
                return page.content()
            log.info("[hltv] CF stuck on %s, retrying with fresh page", url)
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

    /results page structure (historically):
      <div class="results-sublist">
        <span class="standard-headline">Results for 17th of May 2026</span>
        <div class="result-con">...</div>
        <div class="result-con">...</div>
      </div>
    """
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
    sorted filename order inside the archive, and meta is {"map_name": str | None}.
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
            out.append((idx, final, {"map_name": map_name}))
        return out

    finally:
        tmp_archive.unlink(missing_ok=True)
        if extract_dir.exists():
            shutil.rmtree(extract_dir, ignore_errors=True)


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
