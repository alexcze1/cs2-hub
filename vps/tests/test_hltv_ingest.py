"""Tests for vps/hltv_ingest.py — orchestration logic only.

DB and scraper are monkeypatched so these run with no Postgres + no network.
"""
from datetime import datetime
from pathlib import Path

import pytest

import hltv_ingest
from hltv_scraper import MatchRef


def _make_match() -> MatchRef:
    return MatchRef(
        hltv_id="12345",
        url="https://www.hltv.org/matches/12345/foo-vs-bar",
        date=datetime(2026, 5, 17),
        team_a="Foo",
        team_b="Bar",
        event="ESL Pro League S99",
    )


def _stage_dem(dir: Path, n: int = 1) -> list[Path]:
    """Create n staged .dem files mimicking what download_demos produces."""
    dir.mkdir(parents=True, exist_ok=True)
    out = []
    for i in range(n):
        p = dir / f".staged-{i}.dem"
        p.write_bytes(b"DEMO_BYTES")
        out.append(p)
    return out


def _map_results(*entries):
    """Build a list[MapResult] from (map_name, t1_name, t1_score, t2_name, t2_score) tuples."""
    from hltv_scraper import MapResult
    return [
        MapResult(map_index=i, map_name=m, team1_name=n1, team1_score=s1,
                  team2_name=n2, team2_score=s2)
        for i, (m, n1, s1, n2, s2) in enumerate(entries)
    ]


def test_ingest_returns_zero_when_already_ingested(tmp_path, monkeypatch):
    monkeypatch.setattr(hltv_ingest, "_already_ingested", lambda _: True)
    # download_demos must NOT be called when the idempotency guard fires
    monkeypatch.setattr(hltv_ingest, "download_demos",
                        lambda *a, **kw: pytest.fail("download_demos called despite already_ingested"))

    assert hltv_ingest.ingest_match(_make_match(), tmp_path) == 0


def test_ingest_returns_zero_when_no_demos_available(tmp_path, monkeypatch):
    monkeypatch.setattr(hltv_ingest, "_already_ingested", lambda _: False)
    monkeypatch.setattr(hltv_ingest, "download_demos", lambda *a, **kw: [])
    monkeypatch.setattr(hltv_ingest, "_insert_pending_public",
                        lambda **kw: pytest.fail("insert called despite empty download"))

    assert hltv_ingest.ingest_match(_make_match(), tmp_path) == 0


def test_ingest_inserts_one_row_per_dem_and_renames(tmp_path, monkeypatch):
    staged = _stage_dem(tmp_path, n=3)
    pairs = [(i, p, {"map_name": None, "map_results": []}) for i, p in enumerate(staged)]

    inserts = []
    monkeypatch.setattr(hltv_ingest, "_already_ingested", lambda _: False)
    monkeypatch.setattr(hltv_ingest, "download_demos", lambda *a, **kw: pairs)
    monkeypatch.setattr(hltv_ingest, "_insert_pending_public", lambda **kw: inserts.append(kw))

    n = hltv_ingest.ingest_match(_make_match(), tmp_path)

    assert n == 3
    assert len(inserts) == 3
    # Each insert carries a UUID id matching the renamed file on disk
    for row in inserts:
        demo_id = row["demo_id"]
        final = tmp_path / f"{demo_id}.dem"
        assert final.exists(), f"renamed file missing: {final}"
        assert row["storage_path"] == f"local:{demo_id}.dem"
        assert row["source_match_id"] == "12345"
        assert row["source_url"] == "https://www.hltv.org/matches/12345/foo-vs-bar"
        assert row["team_a_name"] == "Foo"
        assert row["team_b_name"] == "Bar"
        assert row["event_name"] == "ESL Pro League S99"
        # No HLTV scores available -> insert with NULLs (don't guess).
        assert row["team_a_score"] is None
        assert row["team_b_score"] is None
    # map_index covers 0..2
    assert sorted(r["source_map_index"] for r in inserts) == [0, 1, 2]
    # All originally-staged files were moved (no longer at staged path)
    for p in staged:
        assert not p.exists(), f"staged file not moved: {p}"


def test_ingest_attaches_hltv_scores_aligned_to_team_a(tmp_path, monkeypatch):
    """Per-map scores come straight from HLTV and are paired with team_a_name."""
    staged = _stage_dem(tmp_path, n=2)
    map_results = _map_results(
        # Map 1: HLTV left=Foo (our team_a), right=Bar -> straight pass-through.
        ("mirage", "Foo", 16, "Bar", 13),
        # Map 2: HLTV swapped left/right ordering (Bar left, Foo right).
        # team_a_score must still be Foo's (8), team_b_score Bar's (16).
        ("nuke",   "Bar", 16, "Foo",  8),
    )
    pairs = [
        (0, staged[0], {"map_name": "mirage", "map_results": map_results}),
        (1, staged[1], {"map_name": "nuke",   "map_results": map_results}),
    ]

    inserts = []
    monkeypatch.setattr(hltv_ingest, "_already_ingested", lambda _: False)
    monkeypatch.setattr(hltv_ingest, "download_demos", lambda *a, **kw: pairs)
    monkeypatch.setattr(hltv_ingest, "_insert_pending_public", lambda **kw: inserts.append(kw))

    hltv_ingest.ingest_match(_make_match(), tmp_path)

    by_idx = {r["source_map_index"]: r for r in inserts}
    assert (by_idx[0]["team_a_score"], by_idx[0]["team_b_score"]) == (16, 13)
    assert (by_idx[1]["team_a_score"], by_idx[1]["team_b_score"]) == (8, 16)


def test_ingest_leaves_scores_null_when_team_names_dont_match(tmp_path, monkeypatch):
    """HLTV reports different team names (rename / typo) -> NULL, don't guess."""
    [staged] = _stage_dem(tmp_path, n=1)
    map_results = _map_results(("mirage", "Foozball", 16, "Barbell", 13))
    pairs = [(0, staged, {"map_name": "mirage", "map_results": map_results})]

    inserts = []
    monkeypatch.setattr(hltv_ingest, "_already_ingested", lambda _: False)
    monkeypatch.setattr(hltv_ingest, "download_demos", lambda *a, **kw: pairs)
    monkeypatch.setattr(hltv_ingest, "_insert_pending_public", lambda **kw: inserts.append(kw))

    hltv_ingest.ingest_match(_make_match(), tmp_path)

    assert inserts[0]["team_a_score"] is None
    assert inserts[0]["team_b_score"] is None


def test_ingest_cleans_up_file_when_insert_fails(tmp_path, monkeypatch):
    [staged] = _stage_dem(tmp_path, n=1)
    pairs = [(0, staged, {"map_name": None})]

    monkeypatch.setattr(hltv_ingest, "_already_ingested", lambda _: False)
    monkeypatch.setattr(hltv_ingest, "download_demos", lambda *a, **kw: pairs)

    def boom(**kw):
        raise RuntimeError("simulated DB failure")
    monkeypatch.setattr(hltv_ingest, "_insert_pending_public", boom)

    with pytest.raises(RuntimeError, match="simulated DB failure"):
        hltv_ingest.ingest_match(_make_match(), tmp_path)

    # No leftover .dem files in tmp_path after the failure
    leftovers = list(tmp_path.glob("*.dem"))
    assert leftovers == [], f"orphan files left behind: {leftovers}"
