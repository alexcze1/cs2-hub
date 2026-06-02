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
    MapResult,
    _dir_size,
    _map_from_filename,
    _parse_headline_date,
    _parse_match_page_demo_href,
    _parse_results_page,
    download_demos,
    match_scores_for,
    parse_match_page_map_results,
    parse_match_page_played_at,
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


# --- per-row date attribute (no fixture needed) -----------------------------
#
# HLTV emits `data-zonedgrouping-entry-unix="<ms>"` on every `result-con`. The
# parser must prefer it over the legacy sublist headline so layouts that omit
# per-day headers (team-filtered /results, Featured block) still produce
# dated rows. The first three tests cover the per-row path; the last two
# verify the headline fallback still works for legacy / mixed layouts.


def _parse_one(html: str):
    """Run _parse_results_page and return the first MatchRef (or None)."""
    matches = _parse_results_page(html)
    return matches[0] if matches else None


def test_parse_results_page_uses_per_row_unix_attribute():
    """A result row with data-zonedgrouping-entry-unix and NO sublist
    headline must still produce a dated MatchRef. This is the team-filtered
    /results layout — previously every row got dropped."""
    html = """
    <div class="results-sublist">
      <div class="result-con" data-zonedgrouping-entry-unix="1779408745000">
        <a href="/matches/2394359/foo-vs-bar-event" class="a-reset">
          <div class="team">Foo</div>
          <div class="team team-won">Bar</div>
          <span class="event-name">Event Name</span>
        </a>
      </div>
    </div>
    """
    m = _parse_one(html)
    assert m is not None, "row was dropped despite valid per-row timestamp"
    # 1779408745000 ms = 2026-05-22 00:12:25 UTC
    assert m.date == datetime(2026, 5, 22, 0, 12, 25)
    assert m.team_a == "Foo"
    assert m.team_b == "Bar"
    assert m.hltv_id == "2394359"


def test_parse_results_page_per_row_unix_wins_over_headline():
    """When both sources exist, the per-row attribute is more precise (gives
    HH:MM:SS, not midnight) so it takes precedence."""
    html = """
    <div class="results-sublist">
      <div class="standard-headline">Results for May 22nd 2026</div>
      <div class="result-con" data-zonedgrouping-entry-unix="1779408745000">
        <a href="/matches/111/a-vs-b" class="a-reset">
          <div class="team">A</div>
          <div class="team">B</div>
        </a>
      </div>
    </div>
    """
    m = _parse_one(html)
    assert m is not None
    assert m.date == datetime(2026, 5, 22, 0, 12, 25), \
        "per-row unix attribute should win over the midnight headline date"


def test_parse_results_page_ignores_bad_unix_value():
    """A malformed data-zonedgrouping-entry-unix must fall back to the
    headline, not skip the row outright."""
    html = """
    <div class="results-sublist">
      <div class="standard-headline">Results for May 22nd 2026</div>
      <div class="result-con" data-zonedgrouping-entry-unix="notanumber">
        <a href="/matches/222/c-vs-d" class="a-reset">
          <div class="team">C</div>
          <div class="team">D</div>
        </a>
      </div>
    </div>
    """
    m = _parse_one(html)
    assert m is not None
    assert m.date == datetime(2026, 5, 22), "should fall back to headline"


def test_parse_results_page_headline_only_still_works():
    """Legacy layout — no per-row attribute, just the sublist headline."""
    html = """
    <div class="results-sublist">
      <div class="standard-headline">Results for May 17th 2026</div>
      <div class="result-con">
        <a href="/matches/333/e-vs-f" class="a-reset">
          <div class="team">E</div>
          <div class="team">F</div>
        </a>
      </div>
    </div>
    """
    m = _parse_one(html)
    assert m is not None
    assert m.date == datetime(2026, 5, 17)


def test_parse_results_page_drops_row_with_no_date_source():
    """Rows with no per-row unix AND no headline (e.g. Featured section)
    are still skipped — we don't want undateable matches in the output."""
    html = """
    <h1 class="standard-headline inline">Featured results</h1>
    <div class="results-sublist">
      <div class="result-con">
        <a href="/matches/444/g-vs-h" class="a-reset">
          <div class="team">G</div>
          <div class="team">H</div>
        </a>
      </div>
    </div>
    """
    assert _parse_results_page(html) == []


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


# --- match page map-results parser ------------------------------------------


@pytest.mark.skipif(not MATCH_HTML.exists(),
                    reason="capture tests/fixtures/hltv_match.html first — see README")
def test_parse_match_page_map_results_basic_shape():
    results = parse_match_page_map_results(MATCH_HTML.read_text(encoding="utf-8"))
    assert results, "expected at least one played map"
    for r in results:
        assert r.map_name, "map_name empty"
        assert r.team1_name, "team1_name empty"
        assert r.team2_name, "team2_name empty"
        assert isinstance(r.team1_score, int)
        assert isinstance(r.team2_score, int)
        assert r.team1_score >= 0 and r.team2_score >= 0


@pytest.mark.skipif(not MATCH_HTML.exists(),
                    reason="capture tests/fixtures/hltv_match.html first — see README")
def test_parse_match_page_map_results_indexes_played_only():
    """map_index must be 0-based and contiguous over played maps only."""
    results = parse_match_page_map_results(MATCH_HTML.read_text(encoding="utf-8"))
    assert [r.map_index for r in results] == list(range(len(results)))


@pytest.mark.skipif(not MATCH_HTML.exists(),
                    reason="capture tests/fixtures/hltv_match.html first — see README")
def test_parse_match_page_map_results_known_tyloo_vs_pain():
    """Locked to the checked-in fixture: TYLOO vs paiN BO3 (Mirage/Nuke/Overpass)."""
    results = parse_match_page_map_results(MATCH_HTML.read_text(encoding="utf-8"))
    by_map = {r.map_name: r for r in results}
    assert set(by_map) >= {"mirage", "nuke", "overpass"}, f"got {list(by_map)}"

    mirage = by_map["mirage"]
    assert {mirage.team1_name, mirage.team2_name} == {"TYLOO", "paiN"}
    # paiN beat TYLOO 13-5 on Mirage
    pain_score = mirage.team1_score if mirage.team1_name == "paiN" else mirage.team2_score
    tyloo_score = mirage.team1_score if mirage.team1_name == "TYLOO" else mirage.team2_score
    assert (pain_score, tyloo_score) == (13, 5)

    nuke = by_map["nuke"]
    pain_score = nuke.team1_score if nuke.team1_name == "paiN" else nuke.team2_score
    tyloo_score = nuke.team1_score if nuke.team1_name == "TYLOO" else nuke.team2_score
    assert (tyloo_score, pain_score) == (13, 8)


def test_parse_match_page_map_results_returns_empty_for_no_maps():
    assert parse_match_page_map_results("<html><body></body></html>") == []


# --- match page played_at parser --------------------------------------------


@pytest.mark.skipif(not MATCH_HTML.exists(),
                    reason="capture tests/fixtures/hltv_match.html first — see README")
def test_parse_match_page_played_at_known_fixture():
    """Fixture is TYLOO vs paiN — scheduled 21st of May 2026, data-unix 1779367800000."""
    ts = parse_match_page_played_at(MATCH_HTML.read_text(encoding="utf-8"))
    assert ts == datetime.utcfromtimestamp(1779367800000 / 1000.0)
    assert ts.year == 2026 and ts.month == 5 and ts.day == 21


def test_parse_match_page_played_at_returns_none_when_absent():
    assert parse_match_page_played_at("<html><body></body></html>") is None


def test_parse_match_page_played_at_returns_none_on_garbage_unix():
    html = '<div class="timeAndEvent"><div class="time" data-unix="not-a-number">x</div></div>'
    assert parse_match_page_played_at(html) is None


def test_parse_match_page_played_at_falls_back_to_date_element():
    """Older fixtures may only have .date — parser should still find it."""
    html = '<div class="timeAndEvent"><div class="date" data-unix="1779367800000">21 May</div></div>'
    ts = parse_match_page_played_at(html)
    assert ts == datetime.utcfromtimestamp(1779367800000 / 1000.0)


def test_parse_match_page_map_results_skips_unplayed():
    """Mapholder without .results.played (BO3 unplayed map 3) must be skipped."""
    html = """
      <div class="mapholder">
        <div class="played"><div class="map-name-holder"><div class="mapname">Mirage</div></div></div>
        <div class="results played">
          <div class="results-left"><div class="results-teamname">A</div><div class="results-team-score">13</div></div>
          <div class="results-right"><div class="results-teamname">B</div><div class="results-team-score">5</div></div>
        </div>
      </div>
      <div class="mapholder">
        <div class="map-name-holder"><div class="mapname">Nuke</div></div>
        <!-- no .results.played -> not played -->
      </div>
    """
    results = parse_match_page_map_results(html)
    assert [r.map_name for r in results] == ["mirage"]
    assert results[0].map_index == 0


def test_parse_match_page_map_results_skips_walkover_dash_score():
    """Forfeit rows can carry '-' instead of a numeric score; skip cleanly."""
    html = """
      <div class="mapholder">
        <div class="played"><div class="mapname">Inferno</div></div>
        <div class="results played">
          <div class="results-left"><div class="results-teamname">A</div><div class="results-team-score">-</div></div>
          <div class="results-right"><div class="results-teamname">B</div><div class="results-team-score">-</div></div>
        </div>
      </div>
    """
    assert parse_match_page_map_results(html) == []


# --- match_scores_for (label↔score join) ------------------------------------


def _mr(idx, mname, t1n, t1s, t2n, t2s):
    return MapResult(map_index=idx, map_name=mname,
                     team1_name=t1n, team1_score=t1s,
                     team2_name=t2n, team2_score=t2s)


def test_match_scores_for_same_ordering_passes_through():
    res = [_mr(0, "mirage", "Foo", 16, "Bar", 13)]
    assert match_scores_for(team_a_name="Foo", team_b_name="Bar",
                            map_name="de_mirage", map_index=0,
                            map_results=res) == (16, 13)


def test_match_scores_for_swapped_ordering_swaps_scores():
    """team_a_name must always pair with team_a_score even if HLTV listed
    the teams in the opposite order on the match page."""
    res = [_mr(0, "nuke", "Bar", 16, "Foo", 8)]
    assert match_scores_for(team_a_name="Foo", team_b_name="Bar",
                            map_name="nuke", map_index=0,
                            map_results=res) == (8, 16)


def test_match_scores_for_joins_by_map_name_not_index():
    """When parser's map name is right, use it even if the index doesn't line up."""
    res = [
        _mr(0, "mirage",   "Foo", 16, "Bar", 13),
        _mr(1, "nuke",     "Foo", 8,  "Bar", 16),
        _mr(2, "overpass", "Foo", 13, "Bar", 16),
    ]
    # Demo claims map_index=0 but its map_name is overpass -> should pick map 2.
    assert match_scores_for(team_a_name="Foo", team_b_name="Bar",
                            map_name="overpass", map_index=0,
                            map_results=res) == (13, 16)


def test_match_scores_for_falls_back_to_index_when_name_missing():
    res = [_mr(0, "mirage", "Foo", 16, "Bar", 13)]
    assert match_scores_for(team_a_name="Foo", team_b_name="Bar",
                            map_name=None, map_index=0,
                            map_results=res) == (16, 13)


def test_match_scores_for_returns_none_when_team_names_dont_match():
    """HLTV-reported names differ from MatchRef -> don't guess, leave null."""
    res = [_mr(0, "mirage", "Foozball", 16, "Barbell", 13)]
    assert match_scores_for(team_a_name="Foo", team_b_name="Bar",
                            map_name="mirage", map_index=0,
                            map_results=res) is None


def test_match_scores_for_handles_de_prefix_and_dust2_alias():
    """Match page uses 'Dust2' display name, .dem filenames use 'de_dust' / 'dust' — align them."""
    res = [_mr(0, "dust2", "Foo", 13, "Bar", 16)]
    assert match_scores_for(team_a_name="Foo", team_b_name="Bar",
                            map_name="de_dust", map_index=0,
                            map_results=res) == (13, 16)


def test_match_scores_for_returns_none_when_results_empty():
    assert match_scores_for(team_a_name="A", team_b_name="B",
                            map_name="mirage", map_index=0,
                            map_results=[]) is None


def test_match_scores_for_is_case_insensitive_on_team_names():
    res = [_mr(0, "mirage", "FOO", 16, "bar", 13)]
    assert match_scores_for(team_a_name="foo", team_b_name="BAR",
                            map_name="mirage", map_index=0,
                            map_results=res) == (16, 13)


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
