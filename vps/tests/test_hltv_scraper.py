"""Tests for vps/hltv_scraper.py — selector validation against saved fixtures.

Fixtures are checked into tests/fixtures/. See tests/fixtures/README.md for
capture instructions. Tests skip when the fixture is absent so CI doesn't
fail on a fresh clone.
"""
from datetime import datetime
from pathlib import Path

import pytest

from hltv_scraper import (
    DiskCapExceeded,
    _dir_size,
    _map_from_filename,
    _parse_headline_date,
    _parse_match_page_demo_href,
    _parse_results_page,
    download_demos,
)

FIXTURES = Path(__file__).parent / "fixtures"
RESULTS_HTML = FIXTURES / "hltv_results.html"
MATCH_HTML = FIXTURES / "hltv_match.html"


# --- pure parsers (no fixture needed) ---------------------------------------


def test_parse_headline_date_full_form():
    assert _parse_headline_date("Results for 17th of May 2026") == datetime(2026, 5, 17)


def test_parse_headline_date_no_ordinal_suffix():
    assert _parse_headline_date("Results for 3 of June 2026") == datetime(2026, 6, 3)


def test_parse_headline_date_case_insensitive_month():
    assert _parse_headline_date("Results for 1st of january 2026") == datetime(2026, 1, 1)


def test_parse_headline_date_returns_none_on_garbage():
    assert _parse_headline_date("nothing date-shaped here") is None


# --- fixture-driven (skipped until hltv_results.html is captured) -----------


@pytest.mark.skipif(not RESULTS_HTML.exists(),
                    reason="capture tests/fixtures/hltv_results.html first — see README")
def test_parse_results_page_returns_matches():
    matches = _parse_results_page(RESULTS_HTML.read_text(encoding="utf-8"))
    assert len(matches) > 0, "expected at least one result row"


@pytest.mark.skipif(not RESULTS_HTML.exists(),
                    reason="capture tests/fixtures/hltv_results.html first — see README")
def test_parse_results_page_fields_populated():
    matches = _parse_results_page(RESULTS_HTML.read_text(encoding="utf-8"))
    m = matches[0]
    assert m.hltv_id.isdigit(), f"hltv_id should be numeric, got {m.hltv_id!r}"
    assert m.url.startswith("https://www.hltv.org/matches/"), f"bad url: {m.url}"
    assert m.team_a, "team_a empty"
    assert m.team_b, "team_b empty"
    assert isinstance(m.date, datetime), "date not parsed"


@pytest.mark.skipif(not RESULTS_HTML.exists(),
                    reason="capture tests/fixtures/hltv_results.html first — see README")
def test_parse_results_page_dates_descending():
    """HLTV /results is newest-first; verify the parser preserves order."""
    matches = _parse_results_page(RESULTS_HTML.read_text(encoding="utf-8"))
    dates = [m.date for m in matches]
    assert dates == sorted(dates, reverse=True), "results not in descending date order"


# --- match page (fixture-driven) --------------------------------------------


@pytest.mark.skipif(not MATCH_HTML.exists(),
                    reason="capture tests/fixtures/hltv_match.html first — see README")
def test_parse_match_page_finds_demo_href():
    href = _parse_match_page_demo_href(MATCH_HTML.read_text(encoding="utf-8"))
    assert href is not None, "no /download/demo/<id> link found in match page"
    assert href.startswith("/download/demo/") or href.startswith("https://"), href


def test_parse_match_page_demo_href_returns_none_when_absent():
    html = "<html><body><a href='/matches/123/foo'>match link</a></body></html>"
    assert _parse_match_page_demo_href(html) is None


def test_parse_match_page_demo_href_matches_id_pattern():
    html = '<html><body><a href="/download/demo/98765">GOTV</a></body></html>'
    assert _parse_match_page_demo_href(html) == "/download/demo/98765"


# --- pure helpers -----------------------------------------------------------


def test_map_from_filename_known_map():
    assert _map_from_filename("furia-vs-mibr-bo3-m1-inferno.dem") == "de_inferno"


def test_map_from_filename_case_insensitive():
    assert _map_from_filename("TEAM-A-vs-TEAM-B-MIRAGE.dem") == "de_mirage"


def test_map_from_filename_unknown_returns_none():
    assert _map_from_filename("random-demo-name.dem") is None


def test_dir_size_nonexistent_returns_zero(tmp_path):
    assert _dir_size(tmp_path / "does-not-exist") == 0


def test_dir_size_sums_files_recursively(tmp_path):
    (tmp_path / "a.bin").write_bytes(b"x" * 100)
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "b.bin").write_bytes(b"y" * 250)
    assert _dir_size(tmp_path) == 350


def test_download_demos_raises_when_dir_over_cap(tmp_path, monkeypatch):
    """When the dest dir already exceeds SOFT_CAP_BYTES, refuse before fetching."""
    import hltv_scraper
    monkeypatch.setattr(hltv_scraper, "SOFT_CAP_BYTES", 10)
    (tmp_path / "big.bin").write_bytes(b"x" * 100)
    with pytest.raises(DiskCapExceeded):
        download_demos("/matches/1/foo", tmp_path)
