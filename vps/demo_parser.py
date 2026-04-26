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
    x = _safe_float(r.get("x") or r.get("user_X") or r.get("X"))
    y = _safe_float(r.get("y") or r.get("user_Y") or r.get("Y"))
    return x, y


def _parse_grenades(p) -> list:
    grenades = []

    # Smokes
    try:
        for r in _to_records(p.parse_event("smokegrenade_detonate")):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = int(r["tick"])
            grenades.append({"tick": tick, "type": "smoke", "x": x, "y": y, "end_tick": tick + 2304})
    except Exception:
        pass

    # Molotov / incendiary — match start→end by entityid
    try:
        end_by_id = {
            int(r.get("entityid", 0)): int(r["tick"])
            for r in _to_records(p.parse_event("inferno_expire"))
        }
        for r in _to_records(p.parse_event("inferno_startburn")):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = int(r["tick"])
            eid  = int(r.get("entityid", 0))
            grenades.append({
                "tick": tick, "type": "molotov", "x": x, "y": y,
                "end_tick": end_by_id.get(eid, tick + 896),
            })
    except Exception:
        pass

    # Flash
    try:
        for r in _to_records(p.parse_event("flashbang_detonate")):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = int(r["tick"])
            grenades.append({"tick": tick, "type": "flash", "x": x, "y": y, "end_tick": tick + 64})
    except Exception:
        pass

    # HE
    try:
        for r in _to_records(p.parse_event("hegrenade_detonate")):
            x, y = _event_pos(r)
            if x == 0 and y == 0:
                continue
            tick = int(r["tick"])
            grenades.append({"tick": tick, "type": "he", "x": x, "y": y, "end_tick": tick + 32})
    except Exception:
        pass

    return grenades


def _parse_bomb(p) -> list:
    bomb_events = []
    for event_name, event_type in [
        ("bomb_planted",  "planted"),
        ("bomb_defused",  "defused"),
        ("bomb_exploded", "exploded"),
    ]:
        try:
            for r in _to_records(p.parse_event(event_name)):
                x, y = _event_pos(r)
                bomb_events.append({"tick": int(r["tick"]), "type": event_type, "x": x, "y": y})
        except Exception:
            pass
    return bomb_events


def parse_demo(dem_path: str) -> dict:
    p = DemoParser(dem_path)
    header = p.parse_header()

    # Parse round events first (cheap) so we can compute sampled ticks before loading tick data
    kills_df       = p.parse_event("player_death")
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
        ["X", "Y", "health", "is_alive", "team_num", "active_weapon_name", "cash", "armor_value"],
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
            })
        frames.append({"tick": int(tick), "players": players})

    print(f"[parser] frames: {len(frames)}  frame[0] players: {len(frames[0]['players']) if frames else 0}")

    kills = []
    for r in _to_records(kills_df):
        kills.append({
            "tick":        int(r["tick"]),
            "killer_id":   str(r.get("attacker_steamid") or ""),
            "killer_name": str(r.get("attacker_name") or ""),
            "victim_id":   str(r.get("user_steamid") or ""),
            "victim_name": str(r.get("user_name") or ""),
            "weapon":      str(r.get("weapon") or ""),
            "headshot":    bool(r.get("headshot") or False),
            "victim_x":    _safe_float(r.get("user_X")),
            "victim_y":    _safe_float(r.get("user_Y")),
        })

    raw_rate = header.get("playback_ticks", 128) / max(header.get("playback_time", 1), 0.001)
    tick_rate = 64 if raw_rate < 100 else 128
    ct_score  = sum(1 for r in rounds if r["winner_side"] == "ct")
    t_score   = sum(1 for r in rounds if r["winner_side"] == "t")

    grenades = _parse_grenades(p)
    bomb     = _parse_bomb(p)
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
    }
