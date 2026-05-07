import pytest
from demo_parser import _first_event_per_round


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
