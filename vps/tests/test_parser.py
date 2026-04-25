# vps/tests/test_parser.py
import pytest
from pathlib import Path
from demo_parser import parse_demo, SAMPLE_RATE

FIXTURE = Path(__file__).parent / "fixture.dem"

@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_output_shape():
    result = parse_demo(str(FIXTURE))
    assert "meta" in result
    assert "rounds" in result
    assert "frames" in result
    assert "kills" in result
    assert "grenades" in result
    assert "economy" in result

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
    if len(frames) > 1:
        tick_gap = frames[1]["tick"] - frames[0]["tick"]
        assert tick_gap % SAMPLE_RATE == 0

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
