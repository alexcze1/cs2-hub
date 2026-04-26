import math
from collections import defaultdict
from demoparser2 import DemoParser

SAMPLE_RATE = 8

_WIN_REASONS = {
    1: "t_eliminated",
    7: "bomb_defused",
    8: "ct_eliminated",
    9: "bomb_exploded",
    12: "time_ran_out",
}


def _pair_rounds(start_ticks: list, end_rows: list) -> list:
    """Pair round_start ticks with round_end rows by sorted position."""
    start_ticks = sorted(int(t) for t in start_ticks)
    end_rows = sorted(end_rows, key=lambda r: int(r["tick"]))
    n = min(len(start_ticks), len(end_rows))
    return [
        {
            "start_tick": start_ticks[i],
            "end_tick":   int(end_rows[i]["tick"]),
            "winner":     end_rows[i].get("winner"),
            "reason":     end_rows[i].get("reason"),
        }
        for i in range(n)
    ]


def _winner_side(winner_val) -> str | None:
    """Return 'ct', 't', or None. CS2: winner==3 → CT, winner==2 → T."""
    if winner_val == 3:
        return "ct"
    if winner_val == 2:
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


def _safe_int(val) -> int:
    if val is None:
        return 0
    try:
        f = float(val)
        return 0 if math.isnan(f) else int(f)
    except (TypeError, ValueError):
        return 0


def parse_demo(dem_path: str) -> dict:
    p = DemoParser(dem_path)
    header = p.parse_header()

    tick_df = p.parse_ticks([
        "X", "Y", "health", "is_alive", "team_num",
        "active_weapon_name", "cash", "armor_value",
    ])

    kills_df      = p.parse_event("player_death")
    round_end_df  = p.parse_event("round_end")
    round_start_df = p.parse_event("round_start")

    start_ticks = round_start_df["tick"].to_list()
    end_rows    = round_end_df.to_dicts()

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

    all_ticks = sorted(tick_df["tick"].unique().to_list())
    sampled   = all_ticks[::SAMPLE_RATE]
    print(f"[parser] tick range: {all_ticks[0] if all_ticks else 'none'}–{all_ticks[-1] if all_ticks else 'none'}  sampled: {len(sampled)}")

    tick_records = tick_df.to_dicts()
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
    for r in kills_df.to_dicts():
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
    }
