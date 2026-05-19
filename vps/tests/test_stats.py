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


def test_compute_player_stats_ignores_damage_outside_live_rounds():
    """Regression: damage_events and kills that fall outside the live round
    windows (warmup deathmatch, between-round periods) must NOT count toward
    damage_dealt / kills / deaths. Previously this inflated ADR because the
    damage was summed but rounds_played stayed pinned to live rounds only."""
    parsed = {
        "rounds": [{
            "start_tick": 1000,
            "end_tick": 2000,
            "freeze_end_tick": 1100,
        }],
        # Kill inside the live round + a stray warmup kill before tick 1000.
        "kills": [
            {"tick": 500,  "killer_id": "A", "victim_id": "C",
             "assister_id": "", "killer_team": "ct", "victim_team": "t",
             "headshot": False, "dmg_health": 100, "dmg_armor": 0, "weapon": "ak47"},
            {"tick": 1500, "killer_id": "A", "victim_id": "B",
             "assister_id": "", "killer_team": "ct", "victim_team": "t",
             "headshot": False, "dmg_health": 100, "dmg_armor": 0, "weapon": "ak47"},
        ],
        # Warmup DM damage (tick 200) + real in-round damage (tick 1500).
        "damage_events": [
            {"tick": 200,  "attacker_id": "A", "victim_id": "C",
             "dmg_health": 500, "dmg_armor": 0, "weapon": "ak47", "hitgroup": ""},
            {"tick": 1500, "attacker_id": "A", "victim_id": "B",
             "dmg_health": 100, "dmg_armor": 0, "weapon": "ak47", "hitgroup": ""},
        ],
        "frames": [
            {"tick": 1100, "players": [
                {"steam_id": "A", "team": "ct", "hp": 100},
                {"steam_id": "B", "team": "t",  "hp": 100},
            ]},
        ],
        "grenades": [],
        "players_meta": {"A": "alpha", "B": "bravo", "C": "charlie"},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_player_stats(parsed)
    a_all = next(r for r in rows if r["steam_id"] == "A" and r["side"] == "all")
    # 1 round played, 100 damage in-round → ADR = 100. Warmup damage ignored.
    assert a_all["adr"] == 100.0, f"expected ADR=100, got {a_all['adr']}"
    # Only the in-round kill counts.
    assert a_all["kills"] == 1, f"expected kills=1, got {a_all['kills']}"


def test_compute_player_stats_extracts_name_string_from_dict_players_meta():
    """Regression: parser stores players_meta[sid] as {"name": str},
    not a bare string. compute_player_stats must extract the string,
    otherwise psycopg2 rejects the dict at INSERT time and the silent
    try/except swallows it — zeroing out demo_players in production."""
    parsed = {
        "rounds": [{
            "start_tick": 100,
            "end_tick": 1000,
            "freeze_end_tick": 150,
            "team_a_side": "ct",
            "winner_side": "ct",
        }],
        "kills": [],
        "damage_events": [],
        "frames": [
            {"tick": 150, "players": [
                {"steam_id": "76561198000000001", "team": "ct", "hp": 100},
            ]},
        ],
        "grenades": [],
        "players_meta": {"76561198000000001": {"name": "alpha"}},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_player_stats(parsed)
    assert rows, "expected at least one row"
    for r in rows:
        assert isinstance(r["name"], str), f"name must be str, got {type(r['name'])}: {r['name']!r}"
        assert r["name"] == "alpha"


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


from demo_parser import _is_coach, _scrub_coaches


def test_is_coach_detects_prefix_case_insensitively():
    assert _is_coach("COACH alex")
    assert _is_coach("coach BOB")
    assert _is_coach("  COACH spaces ")
    assert not _is_coach("alex")
    assert not _is_coach("")
    assert not _is_coach(None)
    # Player name that merely contains "coach" mid-string is NOT a coach.
    assert not _is_coach("notacoach")


def test_scrub_coaches_removes_coach_from_all_outputs():
    parsed = {
        "players_meta": {
            "PLAYER1": {"name": "alex"},
            "COACH1":  {"name": "COACH bob"},
            "PLAYER2": {"name": "carol"},
        },
        "frames": [
            {"tick": 100, "players": [
                {"steam_id": "PLAYER1", "team": "ct", "hp": 100},
                {"steam_id": "COACH1",  "team": "ct", "hp": 100},
                {"steam_id": "PLAYER2", "team": "t",  "hp": 100},
            ]},
        ],
        "kills": [
            {"tick": 110, "killer_id": "PLAYER1", "victim_id": "PLAYER2"},
            {"tick": 120, "killer_id": "PLAYER2", "victim_id": "COACH1"},
            {"tick": 130, "killer_id": "COACH1",  "victim_id": "PLAYER1"},
        ],
        "damage_events": [
            {"tick": 109, "attacker_id": "PLAYER1", "victim_id": "PLAYER2", "dmg_health": 50},
            {"tick": 119, "attacker_id": "PLAYER2", "victim_id": "COACH1",  "dmg_health": 100},
        ],
        "grenades": [
            {"tick": 105, "steam_id": "PLAYER1", "type": "smoke"},
            {"tick": 106, "steam_id": "COACH1",  "type": "flash"},
        ],
        "shots": [
            {"tick": 108, "steam_id": "COACH1"},
            {"tick": 111, "steam_id": "PLAYER1"},
        ],
    }
    out = _scrub_coaches(parsed)
    assert set(out["players_meta"].keys()) == {"PLAYER1", "PLAYER2"}
    assert all(p["steam_id"] != "COACH1" for f in out["frames"] for p in f["players"])
    # Kills involving the coach (as killer OR victim) are dropped.
    assert len(out["kills"]) == 1
    assert out["kills"][0]["killer_id"] == "PLAYER1"
    assert all("COACH1" not in (d["attacker_id"], d["victim_id"]) for d in out["damage_events"])
    assert all(g["steam_id"] != "COACH1" for g in out["grenades"])
    assert all(s["steam_id"] != "COACH1" for s in out["shots"])


def test_scrub_coaches_no_op_when_no_coaches():
    parsed = {
        "players_meta": {"P1": {"name": "alex"}},
        "frames": [{"tick": 1, "players": [{"steam_id": "P1", "team": "ct", "hp": 100}]}],
        "kills": [], "damage_events": [], "grenades": [], "shots": [],
    }
    out = _scrub_coaches(parsed)
    assert out["players_meta"] == {"P1": {"name": "alex"}}
    assert out["frames"][0]["players"][0]["steam_id"] == "P1"


def test_compute_team_stats_counts_anti_eco_when_opponent_ecos():
    """If team B is on eco and team A is on full-buy, team A's anti_eco_played +=1,
    and if A wins, anti_eco_wins +=1. Symmetric for team B."""
    # Round 0: pistol-shaped filler so _is_pistol_round() treats round 1 as non-pistol.
    # Round 1: team A on CT with AK-47s + armor (full-buy), team B on T with pistols
    # only (eco). A wins → a.anti_eco_played=1, a.anti_eco_wins=1.
    parsed = {
        "rounds": [
            {"start_tick": 0, "end_tick": 90, "freeze_end_tick": 10,
             "team_a_side": "ct", "winner_side": "ct"},
            {"start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150,
             "team_a_side": "ct", "winner_side": "ct"},
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
                {"steam_id": "B1", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B2", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B3", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B4", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B5", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
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
    # A is on full-buy, B is on eco. A wins.
    assert a["anti_eco_played"] == 1, f"expected a.anti_eco_played=1, got {a['anti_eco_played']}"
    assert a["anti_eco_wins"]   == 1, f"expected a.anti_eco_wins=1, got {a['anti_eco_wins']}"
    # B was the eco-er, not the anti-eco-er → its anti_eco_* stay 0.
    assert b["anti_eco_played"] == 0
    assert b["anti_eco_wins"]   == 0


def test_compute_team_stats_anti_eco_not_counted_when_opponent_full_buys():
    """Symmetric full-buys: neither side anti-ecos (regression vs. mis-counting)."""
    parsed = {
        "rounds": [
            {"start_tick": 0, "end_tick": 90, "freeze_end_tick": 10,
             "team_a_side": "ct", "winner_side": "ct"},
            {"start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150,
             "team_a_side": "ct", "winner_side": "ct"},
        ],
        "kills": [], "damage_events": [],
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
        "grenades": [], "bomb": [], "players_meta": {},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_team_stats(parsed)
    a = next(r for r in rows if r["team"] == "a")
    b = next(r for r in rows if r["team"] == "b")
    assert a["anti_eco_played"] == 0
    assert b["anti_eco_played"] == 0


def test_compute_team_stats_anti_eco_loss_counts_played_not_wins():
    """If opponent ecos but we still lose the round, anti_eco_played +=1 but anti_eco_wins stays 0."""
    parsed = {
        "rounds": [
            {"start_tick": 0, "end_tick": 90, "freeze_end_tick": 10,
             "team_a_side": "ct", "winner_side": "ct"},
            {"start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150,
             "team_a_side": "ct", "winner_side": "t"},  # T (=B) wins despite eco
        ],
        "kills": [], "damage_events": [],
        "frames": [
            {"tick": 150, "players": [
                {"steam_id": "A1", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A2", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A3", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A4", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A5", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B1", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B2", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B3", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B4", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
                {"steam_id": "B5", "team": "t",  "hp": 100, "weapon": "Glock-18", "armor": 0},
            ]},
        ],
        "grenades": [], "bomb": [], "players_meta": {},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_team_stats(parsed)
    a = next(r for r in rows if r["team"] == "a")
    assert a["anti_eco_played"] == 1
    assert a["anti_eco_wins"]   == 0


from demo_parser import _classify_buy, _man_advantage_per_round


def test_classify_buy_eco_below_threshold():
    # 5x Glock ($200) = $1000, well under $10k → eco
    assert _classify_buy(own_value=1000, opp_value=18500, is_pistol=False) == "eco"


def test_classify_buy_force_between_eco_and_fullbuy():
    # 5x (Galil $1800 + armor $1000 + 1 nade $300) = $15500 → force
    assert _classify_buy(own_value=15500, opp_value=18500, is_pistol=False) == "force"


def test_classify_buy_antieco_when_opp_is_force_or_eco():
    # We are fullbuy ($20k), opp is forcing ($14k) → antieco for us
    assert _classify_buy(own_value=20000, opp_value=14000, is_pistol=False) == "antieco"
    # Opp ecoing also counts as antieco for us
    assert _classify_buy(own_value=20000, opp_value=2000,  is_pistol=False) == "antieco"


def test_classify_buy_fullbuy_when_both_geared():
    assert _classify_buy(own_value=20000, opp_value=19000, is_pistol=False) == "fullbuy"


def test_classify_buy_pistol_short_circuits():
    # Even if values look like a fullbuy, pistol round wins.
    assert _classify_buy(own_value=20000, opp_value=20000, is_pistol=True) == "pistol"


def test_compute_team_stats_counts_force_buy():
    """Force-buy: team has SMGs/Galils + armor but not full rifles. Goes into force_*."""
    # Pistol filler round 0, then force round 1.
    # 5x (Galil $1800 + armor $1000 + smoke $300) = $15500/side = force.
    parsed = {
        "rounds": [
            {"start_tick": 0, "end_tick": 90, "freeze_end_tick": 10,
             "team_a_side": "ct", "winner_side": "ct"},
            {"start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150,
             "team_a_side": "ct", "winner_side": "ct"},
        ],
        "kills": [], "damage_events": [],
        "frames": [
            {"tick": 150, "players": [
                {"steam_id": "A1", "team": "ct", "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "A2", "team": "ct", "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "A3", "team": "ct", "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "A4", "team": "ct", "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "A5", "team": "ct", "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "B1", "team": "t",  "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "B2", "team": "t",  "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "B3", "team": "t",  "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "B4", "team": "t",  "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "B5", "team": "t",  "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
            ]},
        ],
        "grenades": [], "bomb": [], "players_meta": {},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_team_stats(parsed)
    a = next(r for r in rows if r["team"] == "a")
    b = next(r for r in rows if r["team"] == "b")
    assert a["force_played"] == 1, f"expected a.force_played=1, got {a['force_played']}"
    assert b["force_played"] == 1
    assert a["force_wins"]   == 1, f"A on CT won → expected a.force_wins=1, got {a['force_wins']}"
    assert b["force_wins"]   == 0
    # Neither side is on a fullbuy → no antieco
    assert a["anti_eco_played"] == 0
    assert b["anti_eco_played"] == 0


def test_man_advantage_detects_strict_5v4():
    rounds = [{"start_tick": 100, "end_tick": 500}]
    frames = [
        # All 10 alive
        {"tick": 110, "players": [
            {"steam_id": f"CT{i}", "team": "ct", "hp": 100} for i in range(5)
        ] + [
            {"steam_id": f"T{i}", "team": "t", "hp": 100} for i in range(5)
        ]},
        # One T dies → CT is 5v4
        {"tick": 200, "players": [
            {"steam_id": f"CT{i}", "team": "ct", "hp": 100} for i in range(5)
        ] + [
            {"steam_id": "T0", "team": "t", "hp": 0},
        ] + [
            {"steam_id": f"T{i}", "team": "t", "hp": 100} for i in range(1, 5)
        ]},
    ]
    out = _man_advantage_per_round(rounds, frames)
    assert out == [{"ct": True, "t": False}]


def test_man_advantage_does_not_count_5v3():
    """If T goes from 5 → 3 without ever sitting at 4 at a sampled frame, the
    5v4 strict check passes only if some frame catches a 5-vs-4 state."""
    rounds = [{"start_tick": 100, "end_tick": 500}]
    frames = [
        # 5v3 — never sampled at 5v4
        {"tick": 200, "players": [
            {"steam_id": f"CT{i}", "team": "ct", "hp": 100} for i in range(5)
        ] + [
            {"steam_id": "T0", "team": "t", "hp": 0},
            {"steam_id": "T1", "team": "t", "hp": 0},
        ] + [
            {"steam_id": f"T{i}", "team": "t", "hp": 100} for i in range(2, 5)
        ]},
    ]
    out = _man_advantage_per_round(rounds, frames)
    assert out == [{"ct": False, "t": False}]


def test_man_advantage_none_when_full_teams():
    rounds = [{"start_tick": 100, "end_tick": 500}]
    frames = [
        {"tick": 200, "players": [
            {"steam_id": f"CT{i}", "team": "ct", "hp": 100} for i in range(5)
        ] + [
            {"steam_id": f"T{i}", "team": "t", "hp": 100} for i in range(5)
        ]},
    ]
    out = _man_advantage_per_round(rounds, frames)
    assert out == [{"ct": False, "t": False}]


def test_compute_team_stats_5v4_uses_strict_per_frame():
    """Regression: previously a round where the advantaged team later took
    casualties (so min-alive < 5) was wrongly excluded from 5v4_played."""
    # Round 1: at tick 200 CT is 5v4 (T0 dead). At tick 300 CT also loses one,
    # so per-round min(ct_alive)=4 — old logic would skip this. New logic counts it.
    parsed = {
        "rounds": [
            {"start_tick": 0, "end_tick": 90, "freeze_end_tick": 10,
             "team_a_side": "ct", "winner_side": "ct"},
            {"start_tick": 100, "end_tick": 500, "freeze_end_tick": 150,
             "team_a_side": "ct", "winner_side": "ct"},
        ],
        "kills": [], "damage_events": [],
        "frames": [
            # Freeze-end frame for round 1 (used by buy classifier)
            {"tick": 150, "players": [
                {"steam_id": f"CT{i}", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100} for i in range(5)
            ] + [
                {"steam_id": f"T{i}", "team": "t", "hp": 100, "weapon": "AK-47", "armor": 100} for i in range(5)
            ]},
            # Mid-round: CT 5 alive, T 4 alive  → strict 5v4 for CT
            {"tick": 200, "players": [
                {"steam_id": f"CT{i}", "team": "ct", "hp": 100} for i in range(5)
            ] + [
                {"steam_id": "T0", "team": "t", "hp": 0},
                {"steam_id": "T1", "team": "t", "hp": 100},
                {"steam_id": "T2", "team": "t", "hp": 100},
                {"steam_id": "T3", "team": "t", "hp": 100},
                {"steam_id": "T4", "team": "t", "hp": 100},
            ]},
            # Later: CT loses one (min ct_alive=4) — old logic would discard
            {"tick": 300, "players": [
                {"steam_id": "CT0", "team": "ct", "hp": 0},
                {"steam_id": "CT1", "team": "ct", "hp": 100},
                {"steam_id": "CT2", "team": "ct", "hp": 100},
                {"steam_id": "CT3", "team": "ct", "hp": 100},
                {"steam_id": "CT4", "team": "ct", "hp": 100},
                {"steam_id": "T0", "team": "t", "hp": 0},
                {"steam_id": "T1", "team": "t", "hp": 0},
                {"steam_id": "T2", "team": "t", "hp": 100},
                {"steam_id": "T3", "team": "t", "hp": 100},
                {"steam_id": "T4", "team": "t", "hp": 100},
            ]},
        ],
        "grenades": [], "bomb": [], "players_meta": {},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_team_stats(parsed)
    a = next(r for r in rows if r["team"] == "a")
    b = next(r for r in rows if r["team"] == "b")
    assert a["five_v_four_played"] == 1, f"expected a.five_v_four_played=1, got {a['five_v_four_played']}"
    assert a["five_v_four_wins"]   == 1, f"A (CT) wins → expected wins=1, got {a['five_v_four_wins']}"
    assert a["five_v_four_ct_played"] == 1
    assert a["five_v_four_ct_wins"]   == 1
    assert b["five_v_four_played"] == 0


def test_compute_team_stats_anti_eco_when_opponent_forces():
    """User's definition: antieco fires when we are on fullbuy AND opponent is
    eco OR force. Previous behavior only counted when opponent ecoed.
    """
    # A on fullbuy ($18.5k), B on force ($15.5k = 5x Galil+armor+smoke).
    parsed = {
        "rounds": [
            {"start_tick": 0, "end_tick": 90, "freeze_end_tick": 10,
             "team_a_side": "ct", "winner_side": "ct"},
            {"start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150,
             "team_a_side": "ct", "winner_side": "ct"},
        ],
        "kills": [], "damage_events": [],
        "frames": [
            {"tick": 150, "players": [
                {"steam_id": "A1", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A2", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A3", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A4", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "A5", "team": "ct", "hp": 100, "weapon": "AK-47", "armor": 100},
                {"steam_id": "B1", "team": "t",  "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "B2", "team": "t",  "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "B3", "team": "t",  "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "B4", "team": "t",  "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
                {"steam_id": "B5", "team": "t",  "hp": 100, "weapon": "Galil AR", "armor": 100, "has_smoke": True},
            ]},
        ],
        "grenades": [], "bomb": [], "players_meta": {},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_team_stats(parsed)
    a = next(r for r in rows if r["team"] == "a")
    b = next(r for r in rows if r["team"] == "b")
    assert a["anti_eco_played"] == 1, f"expected a.anti_eco_played=1 (we fullbuy vs their force), got {a['anti_eco_played']}"
    assert a["anti_eco_wins"]   == 1  # A on CT wins
    assert a["full_buy_played"] == 0, "anti-eco and fullbuy are mutually exclusive"
    assert b["force_played"] == 1
    assert b["anti_eco_played"] == 0  # B isn't on a fullbuy


# --- ADR overkill cap + self/team damage filter ---

def _adr_test_parsed(damage_events, frames=None):
    """Minimal parsed dict: 1 live round, players A (CT) and B (T), pre-built frames."""
    default_frames = [{"tick": 150, "players": [
        {"steam_id": "A", "team": "ct", "hp": 100},
        {"steam_id": "B", "team": "t",  "hp": 100},
        {"steam_id": "C", "team": "ct", "hp": 100},  # A's teammate
    ]}]
    return {
        "rounds": [{
            "start_tick": 100, "end_tick": 2000, "freeze_end_tick": 150,
            "team_a_side": "ct", "winner_side": "ct",
        }],
        "kills": [],
        "damage_events": damage_events,
        "frames": frames if frames is not None else default_frames,
        "grenades": [],
        "players_meta": {"A": {"name": "alpha"}, "B": {"name": "bravo"}, "C": {"name": "charlie"}},
        "meta": {"team_a_first_side": "ct"},
    }


def test_adr_caps_overkill_on_full_hp_victim():
    """AWP body shot logs as dmg_health=115 but only 100 was applied. ADR=100."""
    parsed = _adr_test_parsed([
        {"tick": 500, "attacker_id": "A", "victim_id": "B", "dmg_health": 115, "weapon": "awp"},
    ])
    rows = compute_player_stats(parsed)
    a_all = next(r for r in rows if r["steam_id"] == "A" and r["side"] == "all")
    assert a_all["adr"] == 100.0, f"expected ADR=100 (capped from 115), got {a_all['adr']}"


def test_adr_caps_overkill_on_weakened_victim():
    """B takes 50 dmg, then a 75-dmg shot. Only 50 of the second shot applies."""
    parsed = _adr_test_parsed([
        {"tick": 500, "attacker_id": "A", "victim_id": "B", "dmg_health": 50, "weapon": "ak47"},
        {"tick": 600, "attacker_id": "A", "victim_id": "B", "dmg_health": 75, "weapon": "ak47"},
    ])
    rows = compute_player_stats(parsed)
    a_all = next(r for r in rows if r["steam_id"] == "A" and r["side"] == "all")
    assert a_all["adr"] == 100.0, f"expected ADR=100 (50 + 50-capped), got {a_all['adr']}"


def test_adr_drops_self_damage():
    """A throws own HE and catches self. Self-damage doesn't count as ADR."""
    parsed = _adr_test_parsed([
        {"tick": 500, "attacker_id": "A", "victim_id": "A", "dmg_health": 40, "weapon": "hegrenade"},
        {"tick": 600, "attacker_id": "A", "victim_id": "B", "dmg_health": 30, "weapon": "ak47"},
    ])
    rows = compute_player_stats(parsed)
    a_all = next(r for r in rows if r["steam_id"] == "A" and r["side"] == "all")
    assert a_all["adr"] == 30.0, f"expected ADR=30 (self-damage skipped), got {a_all['adr']}"


def test_adr_drops_team_damage():
    """A's molly damages teammate C — team damage doesn't count as ADR."""
    parsed = _adr_test_parsed([
        {"tick": 500, "attacker_id": "A", "victim_id": "C", "dmg_health": 60, "weapon": "inferno"},
        {"tick": 600, "attacker_id": "A", "victim_id": "B", "dmg_health": 40, "weapon": "ak47"},
    ])
    rows = compute_player_stats(parsed)
    a_all = next(r for r in rows if r["steam_id"] == "A" and r["side"] == "all")
    assert a_all["adr"] == 40.0, f"expected ADR=40 (team-damage skipped), got {a_all['adr']}"


def test_adr_drops_world_damage():
    """Damage with no attacker (fall damage) doesn't credit anyone."""
    parsed = _adr_test_parsed([
        {"tick": 500, "attacker_id": "", "victim_id": "B", "dmg_health": 30, "weapon": ""},
        {"tick": 600, "attacker_id": "A", "victim_id": "B", "dmg_health": 50, "weapon": "ak47"},
    ])
    rows = compute_player_stats(parsed)
    a_all = next(r for r in rows if r["steam_id"] == "A" and r["side"] == "all")
    assert a_all["adr"] == 50.0


def test_adr_resets_hp_each_round():
    """Same victim can take a full 100 dmg in round 1 AND round 2 — no carryover."""
    parsed = {
        "rounds": [
            {"start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150,
             "team_a_side": "ct", "winner_side": "ct"},
            {"start_tick": 2000, "end_tick": 3000, "freeze_end_tick": 2050,
             "team_a_side": "ct", "winner_side": "ct"},
        ],
        "kills": [],
        "damage_events": [
            {"tick": 500,  "attacker_id": "A", "victim_id": "B", "dmg_health": 100, "weapon": "ak47"},
            {"tick": 2500, "attacker_id": "A", "victim_id": "B", "dmg_health": 100, "weapon": "ak47"},
        ],
        "frames": [
            {"tick": 150,  "players": [{"steam_id": "A", "team": "ct", "hp": 100},
                                       {"steam_id": "B", "team": "t",  "hp": 100}]},
            {"tick": 2050, "players": [{"steam_id": "A", "team": "ct", "hp": 100},
                                       {"steam_id": "B", "team": "t",  "hp": 100}]},
        ],
        "grenades": [],
        "players_meta": {"A": {"name": "alpha"}, "B": {"name": "bravo"}},
        "meta": {"team_a_first_side": "ct"},
    }
    rows = compute_player_stats(parsed)
    a_all = next(r for r in rows if r["steam_id"] == "A" and r["side"] == "all")
    # 200 dmg over 2 rounds → ADR=100
    assert a_all["adr"] == 100.0, f"expected ADR=100, got {a_all['adr']}"


def test_adr_drops_post_death_damage():
    """B dies on first shot (100 dmg). A late post-mortem pellet shouldn't count."""
    parsed = _adr_test_parsed([
        {"tick": 500, "attacker_id": "A", "victim_id": "B", "dmg_health": 100, "weapon": "ak47"},
        {"tick": 501, "attacker_id": "A", "victim_id": "B", "dmg_health": 20,  "weapon": "ak47"},
    ])
    rows = compute_player_stats(parsed)
    a_all = next(r for r in rows if r["steam_id"] == "A" and r["side"] == "all")
    assert a_all["adr"] == 100.0


from demo_parser import _clean_damage_events, _player_sides_per_round


def test_clean_damage_events_returns_corrected_dmg_health():
    """Helper should emit events with adjusted dmg_health, not mutate input."""
    rounds = [{"start_tick": 100, "end_tick": 1000, "freeze_end_tick": 150}]
    frames = [{"tick": 150, "players": [
        {"steam_id": "A", "team": "ct", "hp": 100},
        {"steam_id": "B", "team": "t",  "hp": 100},
    ]}]
    sides = _player_sides_per_round({"A", "B"}, rounds, frames)
    raw = [
        {"tick": 500, "attacker_id": "A", "victim_id": "B", "dmg_health": 60},
        {"tick": 600, "attacker_id": "A", "victim_id": "B", "dmg_health": 80},  # caps to 40
    ]
    cleaned = _clean_damage_events(raw, rounds, sides)
    assert len(cleaned) == 2
    assert [e["dmg_health"] for e in cleaned] == [60, 40]
    # Input not mutated
    assert raw[1]["dmg_health"] == 80
