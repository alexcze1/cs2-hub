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
