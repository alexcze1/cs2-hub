import math
from collections import defaultdict
from demoparser2 import DemoParser

SAMPLE_RATE = 16

_WIN_REASONS = {
    1: "t_eliminated",
    7: "bomb_defused",
    8: "ct_eliminated",
    9: "bomb_exploded",
    12: "time_ran_out",
}


def _pair_rounds(start_ticks: list, end_rows: list) -> list:
    """Pair each round_start with the next round_end that follows it."""
    starts = sorted(int(t) for t in start_ticks)
    ends   = sorted(end_rows, key=lambda r: int(r["tick"]))
    pairs  = []
    ei     = 0
    for start in starts:
        while ei < len(ends) and int(ends[ei]["tick"]) <= start:
            ei += 1
        if ei >= len(ends):
            break
        pairs.append({
            "start_tick": start,
            "end_tick":   int(ends[ei]["tick"]),
            "winner":     ends[ei].get("winner"),
            "reason":     ends[ei].get("reason"),
        })
        ei += 1
    return pairs


def _winner_side(winner_val) -> str | None:
    """Return 'ct', 't', or None. Handles both int (3/2) and string ('CT'/'T') forms."""
    if winner_val == 3 or winner_val == "CT":
        return "ct"
    if winner_val == 2 or winner_val == "T":
        return "t"
    return None


def _is_warmup(start_tick: int, end_tick: int, min_ticks: int = 500) -> bool:
    return (end_tick - start_tick) < min_ticks


def _safe_float(val) -> float:
    if val is None:
        return 0.0
    try:
        f = float(val)
        return 0.0 if math.isnan(f) else f
    except (TypeError, ValueError):
        return 0.0


def _to_records(df) -> list:
    try:
        return df.to_dicts()
    except AttributeError:
        return df.to_dict("records")


def _col_to_list(col) -> list:
    try:
        return col.to_list()
    except AttributeError:
        return list(col)


def _safe_int(val) -> int:
    if val is None:
        return 0
    try:
        f = float(val)
        return 0 if math.isnan(f) else int(f)
    except (TypeError, ValueError):
        return 0


def _event_pos(r) -> tuple:
    """Extract (x, y) from an event row, trying multiple column name variants."""
    def _first(*keys):
        for k in keys:
            v = r.get(k)
            if v is not None:
                return v
        return None
    return _safe_float(_first("x", "user_X", "X")), _safe_float(_first("y", "user_Y", "Y"))


def _add_throw_origins(grenades, shots_df, by_tick, sampled_sorted) -> None:
    """Add origin_x/origin_y to each grenade from weapon_fire events."""
    import bisect

    WEAPON_TO_TYPE = {
        "weapon_smokegrenade": "smoke",
        "weapon_flashbang":    "flash",
        "weapon_hegrenade":    "he",
        "weapon_molotov":      "molotov",
        "weapon_incgrenade":   "molotov",
    }

    def nearest_player_pos(tick, steam_id):
        idx = bisect.bisect_left(sampled_sorted, tick)
        for i in [idx, idx - 1, idx + 1]:
            if 0 <= i < len(sampled_sorted):
                for r in by_tick.get(sampled_sorted[i], []):
                    if str(r.get("steamid") or "") == str(steam_id):
                        return _safe_float(r.get("X")), _safe_float(r.get("Y"))
        return None, None

    throws_by_type: dict = {}
    try:
        for r in _to_records(shots_df):
            weapon = str(r.get("weapon") or "")
            gtype = WEAPON_TO_TYPE.get(weapon)
            if not gtype:
                continue
            tick = _safe_int(r.get("tick"))
            if tick == 0:
                continue
            steam_id = str(r.get("user_steamid") or "")
            x, y = nearest_player_pos(tick, steam_id)
            if x is None:
                continue
            throws_by_type.setdefault(gtype, []).append({"tick": tick, "x": x, "y": y})
    except Exception as e:
        print(f"[parser] throw origins error: {e}")
        return

    for lst in throws_by_type.values():
        lst.sort(key=lambda t: t["tick"])

    for g in grenades:
        candidates = [t for t in throws_by_type.get(g["type"], []) if t["tick"] < g["tick"]]
        if candidates:
            origin = candidates[-1]
            g["origin_x"] = origin["x"]
            g["origin_y"] = origin["y"]


def _parse_grenades(p) -> list:
    grenades = []

    # Smokes
    try:
        df = p.parse_event("smokegrenade_detonate")
        print(f"[parser] smokegrenade_detonate cols: {list(df.columns)}")
        for r in _to_records(df):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = _safe_int(r.get("tick"))
            if tick == 0:
                continue
            grenades.append({"tick": tick, "type": "smoke", "x": x, "y": y, "end_tick": tick + 2304})
    except Exception as e:
        print(f"[parser] smokegrenade_detonate error: {e}")

    # Molotov / incendiary — match start→end by entityid
    try:
        end_by_id = {
            _safe_int(r.get("entityid")): _safe_int(r.get("tick"))
            for r in _to_records(p.parse_event("inferno_expire"))
            if _safe_int(r.get("tick")) > 0
        }
        for r in _to_records(p.parse_event("inferno_startburn")):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = _safe_int(r.get("tick"))
            if tick == 0:
                continue
            eid = _safe_int(r.get("entityid"))
            grenades.append({
                "tick": tick, "type": "molotov", "x": x, "y": y,
                "end_tick": end_by_id.get(eid, tick + 896),
            })
    except Exception as e:
        print(f"[parser] molotov error: {e}")

    # Flash
    try:
        for r in _to_records(p.parse_event("flashbang_detonate")):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = _safe_int(r.get("tick"))
            if tick == 0:
                continue
            grenades.append({"tick": tick, "type": "flash", "x": x, "y": y, "end_tick": tick + 64})
    except Exception as e:
        print(f"[parser] flashbang error: {e}")

    # HE
    try:
        for r in _to_records(p.parse_event("hegrenade_detonate")):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = _safe_int(r.get("tick"))
            if tick == 0:
                continue
            grenades.append({"tick": tick, "type": "he", "x": x, "y": y, "end_tick": tick + 32})
    except Exception as e:
        print(f"[parser] he error: {e}")

    return grenades


def _parse_bomb(p, by_tick, sampled) -> list:
    """Parse bomb events. Derives position from planting player's frame position
    because bomb_planted/defused events don't carry reliable world coords."""
    sampled_sorted = sorted(sampled)

    def player_pos(tick, steam_id):
        import bisect
        idx = bisect.bisect_left(sampled_sorted, tick)
        for i in [idx, idx - 1, idx + 1]:
            if 0 <= i < len(sampled_sorted):
                for r in by_tick.get(sampled_sorted[i], []):
                    if str(r.get("steamid") or "") == str(steam_id):
                        return _safe_float(r.get("X")), _safe_float(r.get("Y"))
        return 0.0, 0.0

    bomb_events = []
    planted_pos = (0.0, 0.0)  # reuse for defused/exploded

    for event_name, event_type in [
        ("bomb_planted",  "planted"),
        ("bomb_defused",  "defused"),
        ("bomb_exploded", "exploded"),
    ]:
        try:
            for r in _to_records(p.parse_event(event_name)):
                tick = _safe_int(r.get("tick"))
                if tick == 0:
                    continue
                steam_id = r.get("user_steamid") or r.get("userid_steamid")
                if event_type == "planted":
                    x, y = player_pos(tick, steam_id) if steam_id else _event_pos(r)
                    if x != 0 or y != 0:
                        planted_pos = (x, y)
                else:
                    x, y = planted_pos  # bomb stays where it was planted
                bomb_events.append({"tick": tick, "type": event_type, "x": x, "y": y})
        except Exception as e:
            print(f"[parser] {event_name} error: {e}")
    return bomb_events


def parse_demo(dem_path: str) -> dict:
    p = DemoParser(dem_path)
    header = p.parse_header()

    # Parse round events first (cheap) so we can compute sampled ticks before loading tick data
    kills_df       = p.parse_event("player_death")
    shots_df       = p.parse_event("weapon_fire")
    round_end_df   = p.parse_event("round_end")
    round_start_df = p.parse_event("round_start")

    start_ticks = _col_to_list(round_start_df["tick"])
    end_rows    = _to_records(round_end_df)

    pairs = _pair_rounds(start_ticks, end_rows)
    print(f"[parser] pairs: {len(pairs)}  starts: {len(start_ticks)}  ends: {len(end_rows)}")

    rounds = []
    for pair in pairs:
        if _is_warmup(pair["start_tick"], pair["end_tick"]):
            print(f"[parser] skip warmup: {pair['start_tick']}→{pair['end_tick']}")
            continue
        winner = _winner_side(pair["winner"])
        if winner is None:
            print(f"[parser] skip unknown winner={pair['winner']} at tick {pair['end_tick']}")
            continue
        rounds.append({
            "round_num":   len(rounds) + 1,
            "winner_side": winner,
            "win_reason":  _WIN_REASONS.get(pair["reason"], "unknown"),
            "start_tick":  pair["start_tick"],
            "end_tick":    pair["end_tick"],
        })

    print(f"[parser] rounds built: {len(rounds)}")

    # Build sampled tick list from round boundaries — avoids loading full DataFrame into memory
    if rounds:
        min_tick = rounds[0]["start_tick"]
        max_tick = rounds[-1]["end_tick"]
        candidate = list(range(min_tick, max_tick + 1, SAMPLE_RATE))
        sampled = [t for t in candidate if any(r["start_tick"] <= t <= r["end_tick"] for r in rounds)]
    else:
        sampled = []
    print(f"[parser] sampled ticks: {len(sampled)}")

    # Request only the sampled ticks from the parser — never loads the full DataFrame
    tick_df = p.parse_ticks(
        ["X", "Y", "health", "is_alive", "team_num", "active_weapon_name", "cash", "armor_value", "yaw"],
        ticks=sampled,
    )

    tick_records = _to_records(tick_df)
    by_tick: dict = defaultdict(list)
    for r in tick_records:
        by_tick[int(r["tick"])].append(r)

    frames = []
    for tick in sampled:
        players = []
        for r in by_tick.get(tick, []):
            team_num = _safe_int(r.get("team_num")) or 2
            players.append({
                "steam_id": str(r.get("steamid") or ""),
                "name":     str(r.get("name") or ""),
                "team":     "ct" if team_num == 3 else "t",
                "x":        _safe_float(r.get("X")),
                "y":        _safe_float(r.get("Y")),
                "hp":       _safe_int(r.get("health")),
                "armor":    _safe_int(r.get("armor_value")),
                "weapon":   str(r.get("active_weapon_name") or ""),
                "money":    _safe_int(r.get("cash")),
                "is_alive": bool(r.get("is_alive") or False),
                "yaw":      _safe_float(r.get("yaw")),
            })
        frames.append({"tick": int(tick), "players": players})

    print(f"[parser] frames: {len(frames)}  frame[0] players: {len(frames[0]['players']) if frames else 0}")

    shots = []
    try:
        for r in _to_records(shots_df):
            tick = _safe_int(r.get("tick"))
            if tick == 0:
                continue
            shots.append({
                "tick":     tick,
                "steam_id": str(r.get("user_steamid") or ""),
            })
    except Exception as e:
        print(f"[parser] weapon_fire error: {e}")

    def _team(val) -> str:
        v = str(val or "").upper()
        if v in ("CT", "3"):      return "ct"
        if v in ("T", "TERRORIST", "2"): return "t"
        return "t"

    kills_records = _to_records(kills_df)
    if kills_records:
        print(f"[parser] player_death cols: {list(kills_records[0].keys())}")
    kills = []
    for r in kills_records:
        vx, vy = _event_pos(r)
        kills.append({
            "tick":        int(r["tick"]),
            "killer_id":   str(r.get("attacker_steamid") or ""),
            "killer_name": str(r.get("attacker_name") or ""),
            "killer_team": _team(r.get("attacker_team_name") or r.get("attacker_side")),
            "victim_id":   str(r.get("user_steamid") or ""),
            "victim_name": str(r.get("user_name") or ""),
            "victim_team": _team(r.get("user_team_name") or r.get("user_side")),
            "weapon":      str(r.get("weapon") or ""),
            "headshot":    bool(r.get("headshot") or False),
            "victim_x":    vx,
            "victim_y":    vy,
        })

    raw_rate = header.get("playback_ticks", 128) / max(header.get("playback_time", 1), 0.001)
    tick_rate = 64 if raw_rate < 100 else 128
    ct_score  = sum(1 for r in rounds if r["winner_side"] == "ct")
    t_score   = sum(1 for r in rounds if r["winner_side"] == "t")

    grenades = _parse_grenades(p)
    _add_throw_origins(grenades, shots_df, by_tick, sorted(sampled))
    bomb     = _parse_bomb(p, by_tick, sampled)
    print(f"[parser] grenades: {len(grenades)}  bomb events: {len(bomb)}")

    return {
        "meta": {
            "map":         header.get("map_name", ""),
            "tick_rate":   tick_rate,
            "total_ticks": _safe_int(header.get("playback_ticks")),
            "ct_score":    ct_score,
            "t_score":     t_score,
        },
        "rounds": rounds,
        "frames": frames,
        "kills":  kills,
        "grenades": grenades,
        "bomb": bomb,
        "shots": shots,
    }
