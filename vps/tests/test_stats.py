import pytest
from pathlib import Path
from demo_parser import _first_event_per_round

FIXTURE = Path(__file__).parent / "fixture.dem"


def test_first_event_per_round_picks_earliest_per_round():
    rounds = [
        {"start_tick": 100, "end_tick": 200},
        {"start_tick": 300, "end_tick": 400},
    ]
    events = [
        {"tick": 150, "id": "a"},
        {"tick": 130, "id": "b"},  # earlier in round 0
        {"tick": 350, "id": "c"},
        {"tick": 320, "id": "d"},  # earlier in round 1
        {"tick": 999, "id": "z"},  # outside any round
    ]
    result = _first_event_per_round(events, rounds)
    assert result == [{"tick": 130, "id": "b"}, {"tick": 320, "id": "d"}]


def test_first_event_per_round_empty_round_yields_none():
    rounds = [{"start_tick": 100, "end_tick": 200}, {"start_tick": 300, "end_tick": 400}]
    events = [{"tick": 150, "id": "a"}]
    result = _first_event_per_round(events, rounds)
    assert result == [{"tick": 150, "id": "a"}, None]


from demo_parser import _was_traded


def test_was_traded_true_when_killer_dies_to_teammate_in_window():
    kills = [
        {"tick": 1000, "killer_id": "ATTACKER", "killer_team": "ct", "victim_id": "VICTIM", "victim_team": "t"},
        {"tick": 1200, "killer_id": "TEAMMATE", "killer_team": "t",  "victim_id": "ATTACKER", "victim_team": "ct"},
    ]
    assert _was_traded(kills, 0, window_ticks=320) is True


def test_was_traded_false_when_outside_window():
    kills = [
        {"tick": 1000, "killer_id": "A", "killer_team": "ct", "victim_id": "V", "victim_team": "t"},
        {"tick": 5000, "killer_id": "T", "killer_team": "t",  "victim_id": "A", "victim_team": "ct"},
    ]
    assert _was_traded(kills, 0, window_ticks=320) is False


def test_was_traded_false_when_killer_dies_to_own_teammate():
    kills = [
        {"tick": 1000, "killer_id": "A", "killer_team": "ct", "victim_id": "V", "victim_team": "t"},
        {"tick": 1100, "killer_id": "OTHER_CT", "killer_team": "ct", "victim_id": "A", "victim_team": "ct"},
    ]
    assert _was_traded(kills, 0, window_ticks=320) is False


from demo_parser import _alive_counts_per_round


def test_alive_counts_per_round_tracks_min_per_side():
    rounds = [{"start_tick": 100, "end_tick": 300}]
    frames = [
        {"tick": 110, "players": [
            {"steam_id": "1", "team": "ct", "hp": 100},
            {"steam_id": "2", "team": "ct", "hp": 100},
            {"steam_id": "3", "team": "t",  "hp": 100},
            {"steam_id": "4", "team": "t",  "hp": 100},
            {"steam_id": "5", "team": "t",  "hp": 100},
        ]},
        {"tick": 200, "players": [
            {"steam_id": "1", "team": "ct", "hp": 100},
            {"steam_id": "2", "team": "ct", "hp": 100},
            {"steam_id": "3", "team": "t",  "hp": 0},
            {"steam_id": "4", "team": "t",  "hp": 100},
            {"steam_id": "5", "team": "t",  "hp": 100},
        ]},
    ]
    result = _alive_counts_per_round(rounds, frames)
    assert result == [{"ct_min_alive": 2, "t_min_alive": 2}]


def test_alive_counts_detects_5v4():
    rounds = [{"start_tick": 100, "end_tick": 300}]
    frames = [
        {"tick": 110, "players": [
            {"steam_id": "1", "team": "ct", "hp": 100},
            {"steam_id": "2", "team": "ct", "hp": 100},
            {"steam_id": "3", "team": "t",  "hp": 100},
            {"steam_id": "4", "team": "t",  "hp": 100},
        ]},
        {"tick": 200, "players": [
            {"steam_id": "1", "team": "ct", "hp": 100},
            {"steam_id": "2", "team": "ct", "hp": 0},
            {"steam_id": "3", "team": "t",  "hp": 100},
            {"steam_id": "4", "team": "t",  "hp": 100},
        ]},
    ]
    result = _alive_counts_per_round(rounds, frames)
    assert result == [{"ct_min_alive": 1, "t_min_alive": 2}]


from demo_parser import _clutch_outcome


def test_clutch_outcome_winner_when_last_alive_wins_round():
    rnd = {"start_tick": 100, "end_tick": 500, "winner_side": "ct"}
    frames = [{"tick": 400, "players": [
        {"steam_id": "CT_LAST", "team": "ct", "hp": 100},
        {"steam_id": "T_A",     "team": "t",  "hp": 100},
        {"steam_id": "T_B",     "team": "t",  "hp": 100},
    ]}]
    out = _clutch_outcome(rnd, frames)
    assert out == {"clutcher_id": "CT_LAST", "won": True}


def test_clutch_outcome_loser_when_last_alive_loses_round():
    rnd = {"start_tick": 100, "end_tick": 500, "winner_side": "t"}
    frames = [{"tick": 400, "players": [
        {"steam_id": "CT_LAST", "team": "ct", "hp": 100},
        {"steam_id": "T_A",     "team": "t",  "hp": 100},
        {"steam_id": "T_B",     "team": "t",  "hp": 100},
    ]}]
    out = _clutch_outcome(rnd, frames)
    assert out == {"clutcher_id": "CT_LAST", "won": False}


def test_clutch_outcome_none_when_no_1vN_situation():
    rnd = {"start_tick": 100, "end_tick": 500, "winner_side": "ct"}
    frames = [{"tick": 400, "players": [
        {"steam_id": "CT_A", "team": "ct", "hp": 100},
        {"steam_id": "CT_B", "team": "ct", "hp": 100},
        {"steam_id": "T_A",  "team": "t",  "hp": 100},
        {"steam_id": "T_B",  "team": "t",  "hp": 100},
    ]}]
    assert _clutch_outcome(rnd, frames) is None


from demo_parser import _grenade_damage_attribution


def test_grenade_damage_attribution_sums_per_thrower():
    damage_events = [
        {"attacker_id": "A", "victim_id": "V1", "dmg_health": 30, "weapon": "hegrenade"},
        {"attacker_id": "A", "victim_id": "V2", "dmg_health": 20, "weapon": "inferno"},
        {"attacker_id": "B", "victim_id": "V1", "dmg_health": 50, "weapon": "molotov"},
        {"attacker_id": "A", "victim_id": "V1", "dmg_health": 30, "weapon": "ak47"},
    ]
    result = _grenade_damage_attribution(damage_events)
    assert result == {"A": 50, "B": 50}


from demo_parser import _flash_assist_for_kill


def test_flash_assist_credits_recent_flasher():
    kill = {"tick": 1000, "victim_id": "V", "killer_id": "K"}
    flashes = [
        {"thrower_id": "FLASHER", "victim_id": "V", "tick": 950},
    ]
    assert _flash_assist_for_kill(kill, flashes, window_ticks=140) == "FLASHER"


def test_flash_assist_none_when_outside_window():
    kill = {"tick": 1000, "victim_id": "V"}
    flashes = [{"thrower_id": "F", "victim_id": "V", "tick": 700}]
    assert _flash_assist_for_kill(kill, flashes, window_ticks=140) is None


def test_flash_assist_none_when_killer_flashed_self_assist_target():
    kill = {"tick": 1000, "victim_id": "V", "killer_id": "K"}
    flashes = [{"thrower_id": "K", "victim_id": "V", "tick": 950}]
    assert _flash_assist_for_kill(kill, flashes, window_ticks=140) is None


from demo_parser import parse_demo, compute_player_stats, compute_team_stats


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_compute_player_stats_returns_three_rows_per_player():
    parsed = parse_demo(str(FIXTURE))
    rows = compute_player_stats(parsed)
    assert rows, "fixture should produce stat rows"
    # Every (steam_id, side) is unique
    seen = set()
    for r in rows:
        key = (r["steam_id"], r["side"])
        assert key not in seen, f"duplicate row {key}"
        seen.add(key)
        assert r["side"] in ("all", "ct", "t")
    # Per-player: all, ct, t exist (or only 'all' + the side they played)
    sids = {r["steam_id"] for r in rows}
    for sid in sids:
        sides = {r["side"] for r in rows if r["steam_id"] == sid}
        assert "all" in sides


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_compute_player_stats_kill_count_consistency():
    """all-side kills should equal ct kills + t kills for each player."""
    parsed = parse_demo(str(FIXTURE))
    rows = compute_player_stats(parsed)
    by_sid: dict = {}
    for r in rows:
        by_sid.setdefault(r["steam_id"], {})[r["side"]] = r
    for sid, sides in by_sid.items():
        if "ct" in sides and "t" in sides and "all" in sides:
            assert sides["all"]["kills"] == sides["ct"]["kills"] + sides["t"]["kills"]
            assert sides["all"]["deaths"] == sides["ct"]["deaths"] + sides["t"]["deaths"]


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_compute_player_stats_rating_in_reasonable_range():
    parsed = parse_demo(str(FIXTURE))
    rows = compute_player_stats(parsed)
    for r in rows:
        if r["side"] == "all" and r["rounds_played"] and r["rounds_played"] > 5:
            assert 0.0 <= r["rating"] <= 2.5, f"unrealistic rating: {r}"


def test_compute_player_stats_does_not_double_count_killing_blow_damage():
    """Regression: ensure killing-blow damage isn't added from both kills and damage_events."""
    parsed = {
        "rounds": [{
            "start_tick": 100,
            "end_tick": 1000,
            "freeze_end_tick": 150,
        }],
        "kills": [
            {"tick": 500, "killer_id": "A", "victim_id": "B",
             "assister_id": "", "killer_team": "ct", "victim_team": "t",
             "headshot": False, "dmg_health": 100, "dmg_armor": 0, "weapon": "ak47"},
        ],
        # The fatal player_hurt event also fires — same tick, same damage
        "damage_events": [
            {"tick": 500, "attacker_id": "A", "victim_id": "B",
             "dmg_health": 100, "dmg_armor": 0, "weapon": "ak47", "hitgroup": ""},
        ],
        "frames": [
            {"tick": 150, "players": [
                {"steam_id": "A", "team": "ct", "hp": 100},
                {"steam_id": "B", "team": "t",  "hp": 100},
            ]},
            {"tick": 600, "players": [
                {"steam_id": "A", "team": "ct", "hp": 100},
                {"steam_id": "B", "team": "t",  "hp": 0},
            ]},
        ],
        "grenades": [],
        "players_meta": {"A": "alpha", "B": "bravo"},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_player_stats(parsed)
    a_all = next(r for r in rows if r["steam_id"] == "A" and r["side"] == "all")
    # ADR = damage / rounds_played. 1 round, 100 damage. NOT 200.
    assert a_all["adr"] == 100.0, f"expected ADR=100, got {a_all['adr']}"


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_compute_team_stats_returns_two_rows():
    parsed = parse_demo(str(FIXTURE))
    rows = compute_team_stats(parsed)
    assert len(rows) == 2
    teams = {r["team"] for r in rows}
    assert teams == {"a", "b"}


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_compute_team_stats_round_count_consistency():
    parsed = parse_demo(str(FIXTURE))
    rows = compute_team_stats(parsed)
    n_rounds = len(parsed["rounds"])
    for r in rows:
        # CT rounds + T rounds = total rounds (every round has the team on one side)
        assert r["ct_rounds_played"] + r["t_rounds_played"] == n_rounds


@pytest.mark.skipif(not FIXTURE.exists(), reason="no fixture.dem")
def test_compute_team_stats_pistol_max_two():
    parsed = parse_demo(str(FIXTURE))
    rows = compute_team_stats(parsed)
    for r in rows:
        assert 0 <= r["pistol_played"] <= 2
        assert 0 <= r["pistol_wins"] <= r["pistol_played"]


def test_compute_team_stats_attributes_bomb_planted_to_t_side_roster():
    """Regression: parser emits 'planted'/'defused', not 'plant'/'defuse'."""
    parsed = {
        "rounds": [{
            "start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150,
            "team_a_side": "t", "winner_side": "t",
        }],
        "kills": [],
        "damage_events": [],
        "frames": [],
        "grenades": [],
        "bomb": [
            {"tick": 500, "type": "planted", "x": 0, "y": 0},
            {"tick": 800, "type": "defused", "x": 0, "y": 0},
        ],
        "players_meta": {},
        "meta": {"team_a_first_side": "t"},
    }
    rows = compute_team_stats(parsed)
    a = next(r for r in rows if r["team"] == "a")
    b = next(r for r in rows if r["team"] == "b")
    # Round had team_a on T, so A planted; team_b on CT, so B defused.
    assert a["bomb_plants"] == 1, f"expected A bomb_plants=1, got {a['bomb_plants']}"
    assert b["bomb_defuses"] == 1, f"expected B bomb_defuses=1, got {b['bomb_defuses']}"


def test_compute_team_stats_classifies_full_buy_and_antieco():
    """Regression: _classify_buy returns 'fullbuy'/'antieco', not 'full'/'force'."""
    # Per-player equip uses 'weapon' + 'armor' + grenade flags (NOT an 'equip_value' key).
    # AK-47 (2700) + armor (1000) per player → 3700/player × 5 = 18500 per side, well above
    # the 5000 eco threshold so _classify_buy returns 'fullbuy' for both sides.
    # Round 0 is always treated as pistol by _is_pistol_round, so place the
    # full-buy round at idx 1 (with the same team_a_side as idx 0 → no side flip).
    parsed = {
        "rounds": [
            {"start_tick": 0, "end_tick": 90, "freeze_end_tick": 10,
             "team_a_side": "ct", "winner_side": "ct"},  # filler pistol round
            {"start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150,
             "team_a_side": "ct", "winner_side": "ct"},  # the round under test
        ],
        "kills": [],
        "damage_events": [],
        "frames": [
            {"tick": 150, "players": [
                {"steam_id": "A1", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A2", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A3", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A4", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A5", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B1", "team": "t",  "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B2", "team": "t",  "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B3", "team": "t",  "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B4", "team": "t",  "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B5", "team": "t",  "hp": 100, "weapon": "AK-47", "armor": 100},
            ]},
        ],
        "grenades": [],
        "bomb": [],
        "players_meta": {},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_team_stats(parsed)
    a = next(r for r in rows if r["team"] == "a")
    b = next(r for r in rows if r["team"] == "b")
    # Both teams full-buy in round 1 → both get full_buy_played=1; A (CT) wins.
    assert a["full_buy_played"] == 1
    assert b["full_buy_played"] == 1
    assert a["full_buy_wins"] == 1  # A is on CT and CT won
    assert b["full_buy_wins"] == 0
