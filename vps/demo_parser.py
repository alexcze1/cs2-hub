# vps/demo_parser.py
import math
from demoparser2 import DemoParser

SAMPLE_RATE = 8  # store every 8th tick (~8-16 fps depending on tick rate)

WIN_REASONS = {
    1: "t_eliminated",
    7: "bomb_defused",
    8: "ct_eliminated",
    9: "bomb_exploded",
    12: "time_ran_out",
}

def _safe(val, default=0):
    if val is None:
        return default
    try:
        if math.isnan(val):
            return default
    except (TypeError, ValueError):
        pass
    return val

def _to_records(df):
    """Convert a DataFrame to list of row dicts (handles both polars and pandas)."""
    try:
        return df.to_dicts()          # polars native
    except AttributeError:
        return df.to_dict("records")  # pandas fallback

def _col_to_list(col):
    """Convert a Series/column to a plain Python list."""
    try:
        return col.to_list()   # polars
    except AttributeError:
        return col.tolist()    # pandas

def parse_demo(dem_path: str) -> dict:
    p = DemoParser(dem_path)
    header = p.parse_header()

    # --- tick data ---
    tick_df = p.parse_ticks([
        "X", "Y", "health", "armor_value",
        "active_weapon_name", "is_alive", "cash",
        "team_num", "current_equip_value",
    ])

    all_ticks = sorted(set(_col_to_list(tick_df["tick"])))
    print(f"[parser] tick range: {all_ticks[0] if all_ticks else 'none'} – {all_ticks[-1] if all_ticks else 'none'}  total unique ticks: {len(all_ticks)}")

    # --- events ---
    kills_df    = p.parse_event("player_death")
    round_end   = p.parse_event("round_end")
    round_start = p.parse_event("round_start")
    smoke_df    = p.parse_event("smokegrenade_detonate")
    flash_df    = p.parse_event("flashbang_detonate")
    he_df       = p.parse_event("hegrenade_detonate")
    molotov_df  = p.parse_event("inferno_startburn")

    re_records = _to_records(round_end)
    rs_records = _to_records(round_start)

    print(f"[parser] round_end rows: {len(re_records)}  round_start rows: {len(rs_records)}")
    if re_records:
        print(f"[parser] round_end[0] keys: {list(re_records[0].keys())}  sample: {re_records[0]}")
    if rs_records:
        print(f"[parser] round_start[0] sample: {rs_records[0]}")

    # --- rounds ---
    starts = sorted(int(r["tick"]) for r in rs_records) if rs_records else []

    # Filter out warmup: ignore round_end events before the actual match starts.
    # Strategy: keep only rounds where end_tick - start_tick > 200 ticks OR where
    # the round_end tick is past the first real start tick.
    # Simpler heuristic: skip any round_end whose tick <= 1.
    rounds = []
    end_idx = 0  # index into starts list
    for row in re_records:
        end_tick = int(row["tick"])
        # Match this round_end to the most recent round_start before it
        matched_start = 0
        for s in starts:
            if s <= end_tick:
                matched_start = s
            else:
                break
        winner_val = row.get("winner") if hasattr(row, "get") else row.get("winner", 2)
        if winner_val is None:
            winner_val = 2
        rounds.append({
            "round_num":   len(rounds) + 1,
            "start_tick":  matched_start,
            "end_tick":    end_tick,
            "winner_side": "ct" if winner_val == 3 else "t",
            "win_reason":  WIN_REASONS.get(row.get("reason") if hasattr(row, "get") else None, "unknown"),
        })

    print(f"[parser] rounds built: {len(rounds)}")
    if rounds:
        print(f"[parser] round[0]: {rounds[0]}  round[-1]: {rounds[-1]}")

    # --- sampled frames ---
    sampled = all_ticks[::SAMPLE_RATE]
    frames = []

    tick_records = _to_records(tick_df)
    # Group tick_records by tick for fast lookup
    from collections import defaultdict
    by_tick = defaultdict(list)
    for r in tick_records:
        by_tick[int(r["tick"])].append(r)

    for tick in sampled:
        players = []
        for r in by_tick.get(tick, []):
            team_num = _safe(r.get("team_num"), 2)
            players.append({
                "steam_id":  str(_safe(r.get("steamid"), "")),
                "name":      str(_safe(r.get("name"), "")),
                "team":      "ct" if team_num == 3 else "t",
                "x":         float(_safe(r.get("X"), 0)),
                "y":         float(_safe(r.get("Y"), 0)),
                "hp":        int(_safe(r.get("health"), 0)),
                "armor":     int(_safe(r.get("armor_value"), 0)),
                "weapon":    str(_safe(r.get("active_weapon_name"), "")),
                "money":     int(_safe(r.get("cash"), 0)),
                "is_alive":  bool(_safe(r.get("is_alive"), False)),
            })
        frames.append({"tick": int(tick), "players": players})

    print(f"[parser] frames: {len(frames)}  frame[0] players: {len(frames[0]['players']) if frames else 0}")

    # --- kills ---
    kills = []
    for r in _to_records(kills_df):
        kills.append({
            "tick":        int(r["tick"]),
            "killer_id":   str(_safe(r.get("attacker_steamid"), "")),
            "killer_name": str(_safe(r.get("attacker_name"), "")),
            "victim_id":   str(_safe(r.get("user_steamid"), "")),
            "victim_name": str(_safe(r.get("user_name"), "")),
            "weapon":      str(_safe(r.get("weapon"), "")),
            "headshot":    bool(_safe(r.get("headshot"), False)),
            "killer_x":    float(_safe(r.get("attacker_X"), 0)),
            "killer_y":    float(_safe(r.get("attacker_Y"), 0)),
            "victim_x":    float(_safe(r.get("user_X"), 0)),
            "victim_y":    float(_safe(r.get("user_Y"), 0)),
        })

    # --- grenades ---
    def _nades(df, nade_type):
        if df is None:
            return []
        rows = _to_records(df)
        if not rows:
            return []
        out = []
        for r in rows:
            thrower = r.get("userid_steamid") or r.get("attacker_steamid") or ""
            out.append({
                "tick":       int(r["tick"]),
                "type":       nade_type,
                "thrower_id": str(_safe(thrower, "")),
                "x":          float(_safe(r.get("x"), 0)),
                "y":          float(_safe(r.get("y"), 0)),
            })
        return out

    grenades = (
        _nades(smoke_df,   "smoke") +
        _nades(flash_df,   "flash") +
        _nades(he_df,      "he") +
        _nades(molotov_df, "molotov")
    )

    # --- economy (snapshot at each round start) ---
    economy = []
    for i, start_tick in enumerate(starts):
        players_eco = []
        for r in by_tick.get(start_tick, []):
            players_eco.append({
                "steam_id":        str(_safe(r.get("steamid"), "")),
                "money":           int(_safe(r.get("cash"), 0)),
                "equipment_value": int(_safe(r.get("current_equip_value"), 0)),
            })
        economy.append({"round_num": i + 1, "players": players_eco})

    # --- meta ---
    raw_rate = header.get("playback_ticks", 128) / max(header.get("playback_time", 1), 0.001)
    tick_rate = 64 if raw_rate < 100 else 128
    ct_score = sum(1 for r in rounds if r["winner_side"] == "ct")
    t_score  = sum(1 for r in rounds if r["winner_side"] == "t")

    return {
        "meta": {
            "map":         header.get("map_name", ""),
            "tick_rate":   tick_rate,
            "total_ticks": int(_safe(header.get("playback_ticks"), 0)),
            "ct_score":    ct_score,
            "t_score":     t_score,
        },
        "rounds":   rounds,
        "frames":   frames,
        "kills":    kills,
        "grenades": grenades,
        "economy":  economy,
    }
