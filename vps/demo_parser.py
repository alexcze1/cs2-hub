# vps/parser.py
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
    return val if val is not None else default

def parse_demo(dem_path: str) -> dict:
    p = DemoParser(dem_path)
    header = p.parse_header()

    # --- tick data ---
    tick_df = p.parse_ticks([
        "X", "Y", "health", "armor_value",
        "active_weapon_name", "is_alive", "cash",
        "team_num", "current_equip_value",
    ])
    all_ticks = tick_df["tick"].unique().sort().to_list()

    # --- events ---
    kills_df   = p.parse_event("player_death",         player_props=["X", "Y"])
    round_end  = p.parse_event("round_end")
    round_start = p.parse_event("round_start")
    smoke_df   = p.parse_event("smokegrenade_detonate")
    flash_df   = p.parse_event("flashbang_detonate")
    he_df      = p.parse_event("hegrenade_detonate")
    molotov_df = p.parse_event("inferno_startburn")

    # --- rounds ---
    starts = sorted(round_start["tick"].to_list()) if len(round_start) else []
    rounds = []
    for i, row in enumerate(round_end.iter_rows(named=True)):
        winner_val = row.get("winner", 2)
        rounds.append({
            "round_num":   i + 1,
            "start_tick":  int(starts[i]) if i < len(starts) else 0,
            "end_tick":    int(row["tick"]),
            "winner_side": "ct" if winner_val == 3 else "t",
            "win_reason":  WIN_REASONS.get(row.get("reason"), "unknown"),
        })

    # --- sampled frames ---
    sampled = all_ticks[::SAMPLE_RATE]
    frames = []
    for tick in sampled:
        rows = tick_df.filter(tick_df["tick"] == tick)
        players = []
        for r in rows.iter_rows(named=True):
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

    # --- kills ---
    kills = []
    for r in kills_df.iter_rows(named=True):
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
        out = []
        for r in df.iter_rows(named=True):
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
        _nades(smoke_df,    "smoke") +
        _nades(flash_df,    "flash") +
        _nades(he_df,       "he") +
        _nades(molotov_df,  "molotov")
    )

    # --- economy (snapshot at each round start) ---
    economy = []
    for i, start_tick in enumerate(starts):
        rows = tick_df.filter(tick_df["tick"] == start_tick)
        players_eco = []
        for r in rows.iter_rows(named=True):
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
