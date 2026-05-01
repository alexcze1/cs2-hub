import pytest

from demo_parser import build_slim_payload


def _sample_parsed():
    """Minimal parsed-demo dict mirroring the shape returned by parse_demo()."""
    return {
        "meta": {
            "map": "de_mirage",
            "tick_rate": 70,
            "total_ticks": 200000,
            "ct_score": 8,
            "t_score": 5,
            "team_a_score": 8,
            "team_b_score": 5,
            "team_a_first_side": "ct",
        },
        "players_meta": {"76561": {"name": "ropz"}},
        "rounds": [
            {
                "round_num": 1,
                "start_tick": 1000,
                "freeze_end_tick": 2000,
                "end_tick": 5000,
                "winner": "CT",
                "winner_side": "ct",
                "reason": "t_eliminated",
                "team_a_side": "ct",
            },
            {
                "round_num": 2,
                "start_tick": 6000,
                "freeze_end_tick": 7000,
                "end_tick": 10000,
                "winner": "T",
                "winner_side": "t",
                "reason": "bomb_exploded",
                "team_a_side": "ct",
                "bomb_planted_site": "A",  # set in real parser; preserved if present
            },
        ],
        "frames": [
            # Round 1 frames
            {"tick": 2000, "players": [
                {"steam_id": "76561", "team": "ct", "x": 100, "y": 200, "z": 0,
                 "hp": 100, "armor": 100, "weapon": "ak47", "money": 4000,
                 "is_alive": True, "yaw": 90.0, "pitch": 0.0,
                 "has_smoke": True, "has_flash": False, "has_molotov": False, "has_he": False},
            ]},
            {"tick": 2016, "players": [  # 16 ticks later (the SAMPLE_RATE)
                {"steam_id": "76561", "team": "ct", "x": 110, "y": 210, "z": 0,
                 "hp": 100, "armor": 100, "weapon": "ak47", "money": 4000,
                 "is_alive": True, "yaw": 95.0, "pitch": 0.0,
                 "has_smoke": True, "has_flash": False, "has_molotov": False, "has_he": False},
            ]},
            # Frame outside any round (between R1 end and R2 start) — must be excluded
            {"tick": 5500, "players": []},
            # Round 2 frame
            {"tick": 7016, "players": [
                {"steam_id": "76561", "team": "t", "x": -50, "y": -100, "z": 0,
                 "hp": 100, "armor": 100, "weapon": "ak47", "money": 4000,
                 "is_alive": True, "yaw": 180.0, "pitch": 0.0,
                 "has_smoke": False, "has_flash": False, "has_molotov": True, "has_he": False},
            ]},
        ],
        "kills": [{"tick": 4000, "killer_id": "76561"}],   # excluded from slim
        "shots": [{"tick": 3000, "steam_id": "76561"}],    # excluded from slim
        "bomb":  [{"tick": 8500, "type": "planted"}],      # excluded from slim
        "grenades": [
            {
                "tick": 3500, "type": "smoke", "x": 150, "y": 250,
                "end_tick": 6316, "steam_id": "76561",
                "path": [[100, 200], [120, 220], [150, 250]],
                "origin_x": 100, "origin_y": 200, "origin_tick": 3450,
                "path_throw_tick": 3450, "path_det_tick": 3500,
            },
            # Grenade between rounds — should be excluded
            {"tick": 5500, "type": "flash", "x": 0, "y": 0,
             "end_tick": 5564, "steam_id": "76561"},
            {
                "tick": 8000, "type": "molotov", "x": -75, "y": -150,
                "end_tick": 8448, "steam_id": "76561",
                "path": [[-50, -100], [-65, -125], [-75, -150]],
                "origin_x": -50, "origin_y": -100, "origin_tick": 7950,
                "path_throw_tick": 7950, "path_det_tick": 8000,
            },
        ],
    }


def test_meta_carries_map_and_tickrate():
    slim = build_slim_payload(_sample_parsed())
    assert slim["meta"]["map"] == "de_mirage"
    assert slim["meta"]["tick_rate"] == 70


def test_meta_players_compact_to_name_only():
    slim = build_slim_payload(_sample_parsed())
    # Only steam_id → {name: ...} survives; nothing else from full players_meta
    assert slim["meta"]["players"] == {"76561": {"name": "ropz"}}


def test_rounds_keep_only_required_fields():
    slim = build_slim_payload(_sample_parsed())
    r0 = slim["rounds"][0]
    assert set(r0.keys()) == {
        "idx", "side_team_a", "freeze_end_tick", "end_tick",
        "winner", "won_by", "bomb_planted_site",
    }
    assert r0["idx"] == 0
    assert r0["side_team_a"] == "ct"
    assert r0["freeze_end_tick"] == 2000
    assert r0["end_tick"] == 5000
    assert r0["winner"] == "ct"
    assert r0["won_by"] == "t_eliminated"
    assert r0["bomb_planted_site"] is None
    # Round 2 carries the bomb plant site through
    assert slim["rounds"][1]["bomb_planted_site"] == "A"


def test_frames_assigned_to_round_and_filtered():
    slim = build_slim_payload(_sample_parsed())
    # Out-of-round frame at tick 5500 must be dropped
    assert len(slim["frames"]) == 3
    assert slim["frames"][0]["round_idx"] == 0
    assert slim["frames"][1]["round_idx"] == 0
    assert slim["frames"][2]["round_idx"] == 1


def test_frame_player_carries_only_slim_fields():
    slim = build_slim_payload(_sample_parsed())
    p = slim["frames"][0]["players"][0]
    assert set(p.keys()) == {"steam_id", "team", "x", "y", "alive", "yaw"}
    assert p["alive"] is True  # mapped from is_alive
    assert p["x"] == 100 and p["y"] == 200
    assert "hp" not in p and "weapon" not in p and "money" not in p


def test_grenades_filtered_to_in_round_and_slim_shape():
    slim = build_slim_payload(_sample_parsed())
    # The flash at tick 5500 is between rounds → excluded
    assert len(slim["grenades"]) == 2
    g = slim["grenades"][0]
    assert set(g.keys()) >= {
        "round_idx", "type", "thrower_sid", "thrower_team",
        "throw_tick", "land_x", "land_y", "trajectory",
    }
    assert g["round_idx"] == 0
    assert g["type"] == "smoke"
    assert g["thrower_sid"] == "76561"
    assert g["thrower_team"] == "ct"   # derived from frame at throw tick
    assert g["throw_tick"] == 3450
    assert g["land_x"] == 150 and g["land_y"] == 250
    assert g["trajectory"] == [[100, 200], [120, 220], [150, 250]]


def test_grenade_without_path_still_emitted_with_empty_trajectory():
    parsed = _sample_parsed()
    parsed["grenades"] = [{
        "tick": 3500, "type": "he", "x": 50, "y": 50,
        "end_tick": 3532, "steam_id": "76561",
        # no "path" key
    }]
    slim = build_slim_payload(parsed)
    assert len(slim["grenades"]) == 1
    assert slim["grenades"][0]["trajectory"] == []
    # Falls back to detonation tick when origin tick is unavailable
    assert slim["grenades"][0]["throw_tick"] == 3500


def test_empty_parsed_returns_empty_slim():
    slim = build_slim_payload({
        "meta": {"map": "de_mirage", "tick_rate": 70},
        "rounds": [], "frames": [], "grenades": [],
    })
    assert slim["rounds"] == [] and slim["frames"] == [] and slim["grenades"] == []
