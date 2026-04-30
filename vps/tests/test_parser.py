import pytest
from pathlib import Path
from demo_parser import parse_demo, _pair_rounds, _winner_side, _is_warmup

FIXTURE = Path(__file__).parent / "fixture.dem"


# ── helper unit tests (no file I/O) ──────────────────────────

def test_pair_rounds_basic():
    starts = [100, 300, 500]
    ends = [
        {"tick": 200, "winner": 3, "reason": 7},
        {"tick": 400, "winner": 2, "reason": 8},
        {"tick": 600, "winner": 3, "reason": 9},
    ]
    pairs = _pair_rounds(starts, ends)
    assert len(pairs) == 3
    assert pairs[0]["start_tick"] == 100
    assert pairs[0]["end_tick"] == 200
    assert pairs[1]["start_tick"] == 300
    assert pairs[1]["end_tick"] == 400


def test_pair_rounds_mismatched_trims_to_shorter():
    starts = [100, 300]
    ends = [
        {"tick": 200, "winner": 3, "reason": 7},
        {"tick": 400, "winner": 2, "reason": 8},
        {"tick": 600, "winner": 3, "reason": 9},
    ]
    pairs = _pair_rounds(starts, ends)
    assert len(pairs) == 2


def test_pair_rounds_out_of_order_input_sorted():
    starts = [300, 100, 500]
    ends = [
        {"tick": 600, "winner": 3, "reason": 9},
        {"tick": 200, "winner": 3, "reason": 7},
        {"tick": 400, "winner": 2, "reason": 8},
    ]
    pairs = _pair_rounds(starts, ends)
    assert pairs[0]["start_tick"] == 100
    assert pairs[0]["end_tick"] == 200


def test_pair_rounds_winner_and_reason_preserved():
    starts = [100]
    ends = [{"tick": 200, "winner": 2, "reason": 9}]
    pairs = _pair_rounds(starts, ends)
    assert pairs[0]["winner"] == 2
    assert pairs[0]["reason"] == 9


def test_winner_side_ct():
    assert _winner_side(3) == "ct"


def test_winner_side_t():
    assert _winner_side(2) == "t"


def test_winner_side_unknown_returns_none():
    assert _winner_side(0) is None
    assert _winner_side(None) is None
    assert _winner_side(1) is None
    assert _winner_side("CT") is None


def test_is_warmup_short_round():
    assert _is_warmup(100, 400) is True   # 300 ticks < 500


def test_is_warmup_real_round():
    assert _is_warmup(100, 700) is False  # 600 ticks >= 500


def test_is_warmup_exact_boundary():
    assert _is_warmup(100, 600) is False  # 500 ticks == 500, not warmup


# ── _dedupe_grenades ──────────────────────────────────────────

def test_dedupe_grenades_keeps_distinct_throws():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke",   "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 2000, "type": "smoke",   "x": 800.0, "y": 800.0, "steam_id": "A"},
        {"tick": 1500, "type": "molotov", "x": 100.0, "y": 100.0, "steam_id": "A"},
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 3


def test_dedupe_grenades_collapses_subtick_double_fire():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 1002, "type": "smoke", "x": 100.5, "y": 100.5, "steam_id": "A"},  # subtick dup
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 1
    assert out[0]["tick"] == 1000  # earliest preserved


def test_dedupe_grenades_keeps_far_apart_same_player_throws():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 1080, "type": "smoke", "x": 105.0, "y": 105.0, "steam_id": "A"},  # 80 ticks apart > 64
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 2


def test_dedupe_grenades_keeps_same_tick_far_apart_positions():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 1010, "type": "smoke", "x": 900.0, "y": 900.0, "steam_id": "A"},  # 800 units apart > 300
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 2


def test_dedupe_grenades_assigns_synthetic_ids():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 2000, "type": "flash", "x": 200.0, "y": 200.0, "steam_id": "B"},
    ]
    out = _dedupe_grenades(grenades)
    assert all("id" in g for g in out)
    assert out[0]["id"] != out[1]["id"]


def test_dedupe_grenades_different_types_not_merged():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke",   "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 1010, "type": "molotov", "x": 100.0, "y": 100.0, "steam_id": "A"},
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 2


def test_dedupe_grenades_different_players_not_merged():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 1010, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "B"},
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 2


# ── integration tests (require fixture.dem) ──────────────────

@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_output_shape():
    result = parse_demo(str(FIXTURE))
    assert "meta" in result
    assert "rounds" in result
    assert "frames" in result
    assert "kills" in result


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_meta_fields():
    result = parse_demo(str(FIXTURE))
    m = result["meta"]
    assert m["map"].startswith("de_")
    assert m["tick_rate"] in (64, 128)
    assert m["total_ticks"] > 0


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_frames_sampled():
    result = parse_demo(str(FIXTURE))
    frames = result["frames"]
    assert len(frames) > 100


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_player_fields():
    result = parse_demo(str(FIXTURE))
    frame = result["frames"][0]
    assert "tick" in frame
    assert "players" in frame
    if frame["players"]:
        p = frame["players"][0]
        for key in ("steam_id", "name", "team", "x", "y", "hp", "armor", "weapon", "money", "is_alive"):
            assert key in p, f"missing key: {key}"
        assert p["team"] in ("ct", "t")


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_no_rounds_share_start_tick():
    result = parse_demo(str(FIXTURE))
    start_ticks = [r["start_tick"] for r in result["rounds"]]
    assert len(start_ticks) == len(set(start_ticks)), "duplicate start ticks"


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_all_rounds_have_valid_winner():
    result = parse_demo(str(FIXTURE))
    for r in result["rounds"]:
        assert r["winner_side"] in ("ct", "t"), f"bad winner: {r}"
