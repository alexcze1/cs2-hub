# Test fixtures — HLTV scraper

Saved HTML snapshots used by `test_hltv_scraper.py`. Fixture files are **not
checked into git when first written by the agent** — capture them from a
working environment as described below, then commit.

## Why fixtures (not live fetches)?

HLTV is Cloudflare-protected and bans automated traffic. Tests must never hit
HLTV in CI. Selectors are validated against a captured snapshot; when HLTV
redesigns and our parser breaks in production, we re-capture and re-test.

## Required fixtures

| File | Source URL |
|---|---|
| `hltv_results.html` | `https://www.hltv.org/results` |
| `hltv_match.html` | `https://www.hltv.org/matches/<id>/<slug>` — pick any recent BO3 with a published GOTV demo |

## How to capture

### Option A — from the VPS (preferred)

The VPS runs `cloudscraper` and should be able to clear Cloudflare:

```bash
cd /opt/midround   # or wherever vps/ lives
python -m hltv_scraper capture-results tests/fixtures/hltv_results.html
python -m hltv_scraper capture-match https://www.hltv.org/matches/<id>/<slug> tests/fixtures/hltv_match.html
```

### Option B — from a real browser

1. Open the URL in a regular browser session.
2. Right-click → "View Page Source" → select all → save as the fixture path.

This produces clean HTML without injected dev-tools artifacts. It also bypasses
Cloudflare because you are a real user.

## System dependencies for archive extraction

`download_demos` uses `patoolib`, which shells out to the system's archive tools.
The VPS needs at minimum `unrar` (HLTV usually serves `.rar`); `unzip` is also
worth installing for the occasional `.zip` archive.

```bash
apt-get install -y unrar unzip
```

## Cloudflare + Playwright fallback (2026-05+)

Cloudflare's anti-bot now hard-blocks `cloudscraper` for both /results and the
GOTV download URLs (the CDN at `r2-demos.hltv.org` checks the TLS fingerprint,
not just cookies). `hltv_scraper.py` falls back to Playwright + Chromium when
cloudscraper hits a 403/503.

VPS install (one-time):

```bash
pip install -r requirements.txt           # pulls playwright
python -m playwright install --with-deps chromium
```

The `--with-deps` flag installs the system libraries Chromium needs
(`libnss3`, `libnspr4`, `libdrm2`, etc.) via apt — required on a fresh
Debian/Ubuntu box.

Force-Playwright mode (skip cloudscraper entirely) is useful for boxes where
we know CF won't ever let cloudscraper through:

```bash
HLTV_FORCE_PLAYWRIGHT=1 ...
```

## When to re-capture

- A test starts failing on a fresh run with no code change → HLTV markup drift.
- Production logs show "discovered 0 matches" for 3+ consecutive ingest cycles.
- HLTV announces a redesign.
