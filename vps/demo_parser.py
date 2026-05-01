import bisect
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
    """Pair each round_start with its corresponding round_end.

    When counts match (the common case), pair by chronological index — this is
    robust to warmup_end firing AFTER round 1's round_start (a real CS2 demo
    timing where the match-start announcement straddles the warmup→live boundary).

    When counts mismatch, fall back to window-based pairing: walk ends, pick the
    first start in (prev_end, end_tick).
    """
    starts = sorted(int(t) for t in start_ticks)
    ends   = sorted(end_rows, key=lambda r: int(r["tick"]))

    if len(starts) == len(ends):
        return [
            {
                "start_tick": starts[i],
                "end_tick":   int(ends[i]["tick"]),
                "winner":     ends[i].get("winner"),
                "reason":     ends[i].get("reason"),
            }
            for i in range(len(starts))
        ]

    pairs = []
    prev_end_tick = -1
    for end_row in ends:
        end_tick = int(end_row["tick"])
        window = [s for s in starts if s > prev_end_tick and s < end_tick]
        if not window:
            continue
        pairs.append({
            "start_tick": window[0],
            "end_tick":   end_tick,
            "winner":     end_row.get("winner"),
            "reason":     end_row.get("reason"),
        })
        prev_end_tick = end_tick
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


_KNIFE_WEAPONS = {
    "knife", "knifegg", "knife_t", "knife_ct", "bayonet",
    "knife_butterfly", "knife_karambit", "knife_m9_bayonet", "knife_flip",
    "knife_gut", "knife_falchion", "knife_shadow_daggers", "knife_bowie",
    "knife_ursus", "knife_gypsy_jackknife", "knife_stiletto", "knife_widowmaker",
    "knife_skeleton", "knife_cord", "knife_canis", "knife_outdoor", "knife_push",
    "knife_tactical", "knife_css",
}


def _is_knife_round(rnd: dict, kills: list, tick_rate: int) -> bool:
    """A round is a knife round iff it is short (<=75 s) AND has at least one
    kill in-window AND none of the in-window kills used a non-knife weapon.

    Empty kill list means no evidence - keep the round (conservative)."""
    duration_s = (rnd["end_tick"] - rnd["start_tick"]) / max(tick_rate, 1)
    if duration_s > 75:
        return False
    in_window = [k for k in kills
                 if rnd["start_tick"] <= k.get("tick", 0) <= rnd["end_tick"]]
    if not in_window:
        return False
    has_gun_kill = False
    for k in in_window:
        w = (k.get("weapon") or "").lower().replace("weapon_", "")
        if w and w not in _KNIFE_WEAPONS and w != "world":
            has_gun_kill = True
            break
    return not has_gun_kill


def _safe_float(val) -> float:
    if val is None:
        return 0.0
    try:
        f = float(val)
        return 0.0 if math.isnan(f) else f
    except (TypeError, ValueError):
        return 0.0


def _to_records(df) -> list:
    if isinstance(df, list):
        return df
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
            throws_by_type.setdefault(gtype, []).append({"tick": tick, "x": x, "y": y, "steam_id": steam_id})
    except Exception as e:
        print(f"[parser] throw origins error: {e}")
        return

    for lst in throws_by_type.values():
        lst.sort(key=lambda t: t["tick"])

    sorted_grenades = sorted(grenades, key=lambda g: g["tick"])
    consumed: dict = {}  # gtype -> set of consumed indices (per-type to avoid cross-contamination)

    for g in sorted_grenades:
        gtype = g["type"]
        candidates = throws_by_type.get(gtype, [])
        type_consumed = consumed.setdefault(gtype, set())
        g_sid = g.get("steam_id", "")

        # Prefer same-player throw (most recent unconsumed before detonation)
        best = None
        best_idx = None
        for i, t in enumerate(candidates):
            if i in type_consumed or t["tick"] >= g["tick"]:
                continue
            if g_sid and t.get("steam_id") != g_sid:
                continue
            if best is None or t["tick"] > best["tick"]:
                best = t
                best_idx = i

        # Fallback: any most-recent unconsumed throw of same type
        if best is None:
            for i, t in enumerate(candidates):
                if i in type_consumed or t["tick"] >= g["tick"]:
                    continue
                if best is None or t["tick"] > best["tick"]:
                    best = t
                    best_idx = i

        if best is not None:
            type_consumed.add(best_idx)
            g["origin_x"]    = best["x"]
            g["origin_y"]    = best["y"]
            g["origin_tick"] = best["tick"]



def _fetch_grenade_tracks(dem_path) -> list:
    """Run Go grenade parser before demoparser2 loads to avoid double-RAM peak."""
    import os, subprocess, json as _json
    binary = "/opt/midround/vps/parse_grenades/parse_grenades"
    if not os.path.exists(binary):
        print("[parser] grenade binary not found — using straight-line fallback")
        return []
    try:
        result = subprocess.run(
            [binary, dem_path],
            capture_output=True, text=True, timeout=180,
        )
        if result.returncode != 0:
            print(f"[parser] grenade binary error (exit {result.returncode}): {result.stderr[:400]}")
            return []
        tracks = _json.loads(result.stdout)
        print(f"[parser] grenade paths: {len(tracks)} tracks from Go binary")
        return tracks
    except Exception as e:
        print(f"[parser] grenade binary failed: {e}")
        return []


def _build_grenade_paths(grenades, raw_tracks) -> None:
    """Match Go-binary projectile tracks onto parsed grenade rows.

    Match key is type-only; steam_id is a tiebreaker, not a primary key.
    This handles two same-player throws (different projectiles, same steam_id+type)
    and pickup-and-rethrow (different steam_ids on grenade vs. track) uniformly.
    """
    if not raw_tracks:
        return
    from collections import defaultdict as _dd
    by_type = _dd(list)
    for t in raw_tracks:
        by_type[t.get("type", "")].append(t)
    for lst in by_type.values():
        lst.sort(key=lambda t: t.get("throw_tick", 0))

    consumed = _dd(set)
    for g in sorted(grenades, key=lambda x: x.get("tick", 0)):
        gtype = g.get("type", "")
        candidates = by_type.get(gtype, [])
        best = None
        best_i = None
        best_score = None
        for i, t in enumerate(candidates):
            if i in consumed[gtype]:
                continue
            d = abs(t.get("det_tick", 0) - g.get("tick", 0))
            if d >= 256:
                continue
            same_thrower = (t.get("steam_id", "") == g.get("steam_id", ""))
            score = (0 if same_thrower else 1, d)
            if best_score is None or score < best_score:
                best, best_i, best_score = t, i, score
        if best is not None:
            consumed[gtype].add(best_i)
            g["path"]            = [[pt["x"], pt["y"]] for pt in best["path"]]
            g["path_ticks"]      = [pt["tick"] for pt in best["path"]] if best["path"] and "tick" in best["path"][0] else None
            g["origin_x"]        = best["path"][0]["x"]
            g["origin_y"]        = best["path"][0]["y"]
            g["origin_tick"]     = best.get("throw_tick", 0)
            g["path_throw_tick"] = best.get("throw_tick", 0)
            g["path_det_tick"]   = best.get("det_tick", 0)

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
            grenades.append({"tick": tick, "type": "smoke", "x": x, "y": y, "end_tick": tick + 2816, "steam_id": str(r.get("user_steamid") or "")})
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
                "end_tick": tick + 896, "steam_id": str(r.get("user_steamid") or ""),
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
            grenades.append({"tick": tick, "type": "flash", "x": x, "y": y, "end_tick": tick + 64, "steam_id": str(r.get("user_steamid") or "")})
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
            grenades.append({"tick": tick, "type": "he", "x": x, "y": y, "end_tick": tick + 32, "steam_id": str(r.get("user_steamid") or "")})
    except Exception as e:
        print(f"[parser] he error: {e}")

    return grenades


def _dedupe_grenades(grenades: list) -> list:
    """Collapse duplicated grenade rows in two passes.

    Pass 1 (same-thrower): merge rows that share steam_id+type within a
    type-specific (tick, spatial) window. Catches subtick echoes and per-fire-
    patch inferno_startburn events from a single throw.

    Pass 2 (cross-thrower): merge rows that share type at near-identical tick
    AND near-identical position regardless of steam_id. Catches cases where the
    demo (or demoparser2) attributes one physical detonate event to two
    different user IDs — observed in the wild as two smokes ~10 ticks / ~30 u
    apart with different steam_ids.

    Earliest entry survives in both passes. Each survivor gets a synthetic
    'id' field so the client can dedupe stably.
    """
    # Pass 1 windows: type -> (tick_window, distance_window_squared).
    # Smoke window widened from 64→256 ticks because demoparser2 occasionally
    # emits a duplicate detonate event ~150 ticks after the original. 300 u
    # is permissive enough to catch jittered duplicates where the second event
    # carries slightly different coords (~220 u observed in the wild) without
    # affecting two-player coordination — pass 1 is same-thrower only, and a
    # single player throwing two smokes within the same 3-second window at
    # spots <300 u apart essentially never happens in real play (the first
    # smoke is still deploying).
    SAME_THROWER_WINDOWS = {
        "molotov": (256, 500 * 500),
        "smoke":   (256, 300 * 300),
        "flash":   (64,  300 * 300),
        "he":      (64,  300 * 300),
    }
    sorted_g = sorted(
        grenades,
        key=lambda g: (g.get("steam_id", ""), g.get("type", ""), g.get("tick", 0)),
    )
    pass1: list = []
    for g in sorted_g:
        merged = False
        if pass1:
            prev = pass1[-1]
            gtype = g.get("type", "")
            tick_win, dist_sq_win = SAME_THROWER_WINDOWS.get(gtype, (64, 300 * 300))
            if (prev.get("steam_id", "") == g.get("steam_id", "")
                    and prev.get("type") == gtype
                    and abs(prev.get("tick", 0) - g.get("tick", 0)) <= tick_win):
                dx = prev.get("x", 0.0) - g.get("x", 0.0)
                dy = prev.get("y", 0.0) - g.get("y", 0.0)
                if dx * dx + dy * dy < dist_sq_win:
                    merged = True
        if not merged:
            pass1.append(g)

    # Pass 2: cross-thrower near-coincidence. Tight thresholds (32 ticks / 100 u)
    # so two players throwing the same spot a half-second apart are NOT merged
    # — only essentially-simultaneous, essentially-co-located events.
    CROSS_TICK_WIN = 32
    CROSS_DIST_SQ  = 100 * 100
    pass1_by_tick = sorted(pass1, key=lambda g: (g.get("type", ""), g.get("tick", 0)))
    out: list = []
    for g in pass1_by_tick:
        gtype = g.get("type", "")
        gtick = g.get("tick", 0)
        gx, gy = g.get("x", 0.0), g.get("y", 0.0)
        merged = False
        # Walk back through recent survivors of same type
        for prev in reversed(out):
            if prev.get("type") != gtype:
                continue
            if gtick - prev.get("tick", 0) > CROSS_TICK_WIN:
                break  # sorted by tick within type — no more candidates
            dx = prev.get("x", 0.0) - gx
            dy = prev.get("y", 0.0) - gy
            if dx * dx + dy * dy < CROSS_DIST_SQ:
                merged = True
                break
        if not merged:
            out.append(g)

    pre, mid, post = len(grenades), len(pass1), len(out)
    if pre != post:
        print(f"[parser] grenade dedupe: {pre} → {mid} (same-thrower) → {post} (cross-thrower)")
    for i, g in enumerate(out):
        g["id"] = f"{g.get('type','')}-{g.get('tick',0)}-{g.get('steam_id','')}-{i}"
    return out


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
    # Run Go binary BEFORE demoparser2 loads anything — avoids double-RAM peak
    raw_tracks = _fetch_grenade_tracks(dem_path)

    p = DemoParser(dem_path)
    header = p.parse_header()

    # Parse round events first (cheap) so we can compute sampled ticks before loading tick data
    kills_df       = p.parse_event("player_death")
    shots_df       = p.parse_event("weapon_fire")
    round_end_df   = p.parse_event("round_end")
    round_start_df = p.parse_event("round_start")

    start_ticks = _col_to_list(round_start_df["tick"])
    end_rows    = _to_records(round_end_df)

    try:
        freeze_end_ticks = sorted(
            _safe_int(r.get("tick"))
            for r in _to_records(p.parse_event("round_freeze_end"))
            if _safe_int(r.get("tick")) > 0
        )
    except Exception:
        freeze_end_ticks = []

    pairs = _pair_rounds(start_ticks, end_rows)
    print(f"[parser] pairs: {len(pairs)}  starts: {len(start_ticks)}  ends: {len(end_rows)}")

    try:
        match_start_ticks = sorted(
            _safe_int(r.get("tick"))
            for r in _to_records(p.parse_event("round_announce_match_start"))
            if _safe_int(r.get("tick")) > 0
        )
    except Exception:
        match_start_ticks = []
    live_start_tick = match_start_ticks[-1] if match_start_ticks else 0
    print(f"[parser] live_start_tick: {live_start_tick}  match_start events: {len(match_start_ticks)}")

    rounds = []
    for pair in pairs:
        if _is_warmup(pair["start_tick"], pair["end_tick"]):
            print(f"[parser] skip warmup: {pair['start_tick']}→{pair['end_tick']}")
            continue
        # Filter on end_tick, not start_tick: round_announce_match_start fires
        # DURING round 1's freeze, AFTER round 1's round_start. Filtering on
        # start_tick would eat real round 1.
        if pair["end_tick"] < live_start_tick:
            print(f"[parser] skip pre-live: end {pair['end_tick']} < {live_start_tick}")
            continue
        winner = _winner_side(pair["winner"])
        if winner is None:
            print(f"[parser] skip unknown winner={pair['winner']} at tick {pair['end_tick']}")
            continue
        freeze_end_tick = pair["start_tick"]
        for fe in freeze_end_ticks:
            if fe > pair["start_tick"] and fe < pair["end_tick"]:
                freeze_end_tick = fe
                break
        rounds.append({
            "round_num":      len(rounds) + 1,
            "winner_side":    winner,
            "win_reason":     _WIN_REASONS.get(pair["reason"], "unknown"),
            "start_tick":     pair["start_tick"],
            "end_tick":       pair["end_tick"],
            "freeze_end_tick": freeze_end_tick,
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

    # Probe available tick columns for grenade inventory
    if not sampled:
        _UTIL_MODE = "none"
        print("[parser] utility mode: none — no sampled ticks to probe")
    else:
        try:
            _probe_df = p.parse_ticks(["inventory"], ticks=sampled[:1])
            _UTIL_MODE = "inventory"
            print(f"[parser] utility mode: inventory column available")
        except Exception:
            try:
                _probe_df = p.parse_ticks(["smoke_grenade_count", "flash_grenade_count", "molotov_count", "he_grenade_count"], ticks=sampled[:1])
                _UTIL_MODE = "counts"
                print(f"[parser] utility mode: counts columns available")
            except Exception:
                _UTIL_MODE = "none"
                print(f"[parser] utility mode: none — utility symbols disabled")

    _util_cols = {
        "counts":    ["smoke_grenade_count", "flash_grenade_count", "molotov_count", "he_grenade_count"],
        "inventory": ["inventory"],
        "none":      [],
    }[_UTIL_MODE]

    # Request only the sampled ticks from the parser — never loads the full DataFrame
    tick_df = p.parse_ticks(
        ["X", "Y", "Z", "health", "is_alive", "team_num", "active_weapon_name",
         "balance", "armor_value", "yaw", "pitch", "flash_duration"] + _util_cols,
        ticks=sampled,
    )

    tick_records = _to_records(tick_df)
    by_tick: dict = defaultdict(list)
    # sid → sorted [(tick, team)] — only valid teams (2=T, 3=CT), supports halftime swaps
    sid_team_hist: dict = defaultdict(list)
    # sid → name — accumulated across all sampled ticks; last write wins. Static-per-player
    # data lifted out of every frame to save ~2 MB of JSON on a 30-min match.
    players_meta: dict = {}
    for r in tick_records:
        sid = str(r.get("steamid") or "")
        tn  = _safe_int(r.get("team_num"))
        if sid and tn in (2, 3):
            sid_team_hist[sid].append((int(r["tick"]), "ct" if tn == 3 else "t"))
        if sid:
            nm = str(r.get("name") or "")
            if nm:
                players_meta[sid] = {"name": nm}
        by_tick[int(r["tick"])].append(r)
    for sid in sid_team_hist:
        sid_team_hist[sid].sort()

    def _team_at(sid: str, tick: int) -> str:
        hist = sid_team_hist.get(sid, [])
        if not hist:
            return "t"
        result = hist[0][1]
        for t, team in hist:
            if t <= tick:
                result = team
            else:
                break
        return result

    frames = []
    for tick in sampled:
        players = []
        for r in by_tick.get(tick, []):
            team_num = _safe_int(r.get("team_num")) or 2

            if _UTIL_MODE == "counts":
                has_smoke   = _safe_int(r.get("smoke_grenade_count") or 0) > 0
                has_flash   = _safe_int(r.get("flash_grenade_count") or 0) > 0
                has_molotov = _safe_int(r.get("molotov_count") or 0) > 0
                has_he      = _safe_int(r.get("he_grenade_count") or 0) > 0
            elif _UTIL_MODE == "inventory":
                inv_raw = r.get("inventory") or []
                if isinstance(inv_raw, str):
                    try:
                        import json as _json2; inv_raw = _json2.loads(inv_raw)
                    except Exception: inv_raw = []
                has_smoke   = "Smoke Grenade"  in inv_raw
                has_flash   = "Flashbang"       in inv_raw
                has_molotov = any(w in inv_raw for w in ("Molotov", "Incendiary Grenade"))
                has_he      = "High Explosive Grenade" in inv_raw
            else:
                has_smoke = has_flash = has_molotov = has_he = False

            sid = str(r.get("steamid") or "")
            fd  = _safe_float(r.get("flash_duration"))
            entry = {
                "steam_id":       sid,
                "team":           "ct" if team_num == 3 else "t",
                # World coords rounded to int — sub-unit precision is invisible at any
                # zoom on a 1024px minimap and saves ~3 MB of JSON per match.
                "x":              int(round(_safe_float(r.get("X")))),
                "y":              int(round(_safe_float(r.get("Y")))),
                "z":              int(round(_safe_float(r.get("Z")))),
                "hp":             _safe_int(r.get("health")),
                "armor":          _safe_int(r.get("armor_value")),
                "weapon":         str(r.get("active_weapon_name") or ""),
                "money":          _safe_int(r.get("balance")),
                "is_alive":       bool(r.get("is_alive") or False),
                # Yaw/pitch to 1 decimal — viewer clamps to integer pixels, more is noise.
                "yaw":            round(_safe_float(r.get("yaw")), 1),
                "pitch":          round(_safe_float(r.get("pitch")), 1),
                "has_smoke":      has_smoke,
                "has_flash":      has_flash,
                "has_molotov":    has_molotov,
                "has_he":         has_he,
            }
            # flash_duration is 0 for the vast majority of ticks; omit when 0
            # (saves ~7 MB on a 30-min match). Viewer treats absent as 0.
            if fd > 0:
                entry["flash_duration"] = round(fd, 2)
            players.append(entry)
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
        v = str(val or "").upper().strip()
        if v in ("CT", "3") or "COUNTER" in v: return "ct"
        if v in ("T", "2")  or "TERRORIST" in v: return "t"
        return "t"

    kills_records = _to_records(kills_df)
    kills = []
    for r in kills_records:
        vx, vy = _event_pos(r)
        kills.append({
            "tick":        int(r["tick"]),
            "killer_id":   str(r.get("attacker_steamid") or ""),
            "killer_name": str(r.get("attacker_name") or ""),
            "killer_team": _team_at(str(r.get("attacker_steamid") or ""), int(r["tick"])),
            "victim_id":   str(r.get("user_steamid") or ""),
            "victim_name": str(r.get("user_name") or ""),
            "victim_team": _team_at(str(r.get("user_steamid") or ""), int(r["tick"])),
            "weapon":      str(r.get("weapon") or ""),
            "headshot":    bool(r.get("headshot") or False),
            "victim_x":    vx,
            "victim_y":    vy,
        })

    # Knife-round filter (must run AFTER kills are built — _is_knife_round inspects weapons)
    # and score recompute. tick_rate=64 here is the server tickrate at which round_start/end
    # events fire (matches _is_warmup convention) — distinct from meta.tick_rate=70 below
    # which is the player frame sampling rate.
    pre_knife_count = len(rounds)
    rounds = [r for r in rounds if not _is_knife_round(r, kills, tick_rate=64)]
    for i, r in enumerate(rounds):
        r["round_num"] = i + 1
    print(f"[parser] knife filter: {pre_knife_count} → {len(rounds)} rounds")

    tick_rate = 70  # CS2 sub-tick: header reports 128, effective playback rate ~70
    ct_score  = sum(1 for r in rounds if r["winner_side"] == "ct")
    t_score   = sum(1 for r in rounds if r["winner_side"] == "t")

    # Per-roster scores. "Roster A" = whoever was on CT at round 1's freeze_end_tick;
    # "Roster B" = whoever was on T. Each round, look up roster A's current side
    # (sid_team_hist tracks halftime swaps automatically), then attribute the round
    # win to A or B accordingly. Falls back gracefully if rounds is empty.
    team_a_first_side = None
    team_a_score = 0
    team_b_score = 0
    if rounds:
        r1_tick = rounds[0]["freeze_end_tick"]
        roster_a_sample = None
        for sid in sid_team_hist:
            if _team_at(sid, r1_tick) == "ct":
                roster_a_sample = sid
                break
        if roster_a_sample:
            team_a_first_side = "ct"
        else:
            # Edge case: no CT player found at r1 — fall back to first T player
            for sid in sid_team_hist:
                if _team_at(sid, r1_tick) == "t":
                    roster_a_sample = sid
                    team_a_first_side = "t"
                    break
        if roster_a_sample:
            for r in rounds:
                a_side = _team_at(roster_a_sample, r["freeze_end_tick"])
                # Stamp the round so the viewer can swap side labels at halftime
                # without needing sid_team_hist client-side.
                r["team_a_side"] = a_side
                if r["winner_side"] == a_side:
                    team_a_score += 1
                else:
                    team_b_score += 1
    print(f"[parser] per-roster: A({team_a_first_side})={team_a_score} B={team_b_score}")

    grenades = _parse_grenades(p)
    grenades = _dedupe_grenades(grenades)
    _add_throw_origins(grenades, shots_df, by_tick, sorted(sampled))
    _build_grenade_paths(grenades, raw_tracks)
    bomb     = _parse_bomb(p, by_tick, sampled)
    print(f"[parser] grenades: {len(grenades)}  bomb events: {len(bomb)}")

    return {
        "meta": {
            "map":               header.get("map_name", ""),
            "tick_rate":         tick_rate,
            "total_ticks":       _safe_int(header.get("playback_ticks")),
            "ct_score":          ct_score,
            "t_score":           t_score,
            "team_a_score":      team_a_score,
            "team_b_score":      team_b_score,
            "team_a_first_side": team_a_first_side,
        },
        "players_meta": players_meta,
        "rounds":       rounds,
        "frames":       frames,
        "kills":        kills,
        "grenades":     grenades,
        "bomb":         bomb,
        "shots":        shots,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Slim payload for multi-round analysis tool (analysis.html).
# Pure function — no I/O. Derives a ~10x smaller representation of a parsed
# demo containing only the fields needed for round-overlay rendering and
# grenade-mode visualisation.
# ─────────────────────────────────────────────────────────────────────────────

# Maps the integer/string winner-reason from parse_demo.rounds → analysis term.
# parse_demo currently stores raw strings from _WIN_REASONS; copy through verbatim.
def _slim_won_by(reason):
    return reason if isinstance(reason, str) else None


def _round_index_for_tick(rounds, tick):
    """Return the 0-based round idx whose [start, end] contains tick, else None.
    Linear scan is fine — typical demo has ≤30 rounds."""
    for i, r in enumerate(rounds):
        if r["start_tick"] <= tick <= r["end_tick"]:
            return i
    return None


def _team_at_tick(frames, steam_id, tick):
    """Best-effort lookup of a player's team at the given tick by scanning frames.
    Used to attribute grenade throws to a side. Returns 'ct'/'t'/None."""
    # Walk frames in order; the last frame at-or-before the target tick wins.
    last = None
    for f in frames:
        if f.get("tick", 0) > tick:
            break
        for p in f.get("players", []):
            if p.get("steam_id") == steam_id:
                last = p.get("team")
    return last


def build_slim_payload(parsed: dict) -> dict:
    """Derive the slim payload from a full parse_demo() result.

    Reductions vs full match_data:
      - frames keep only steam_id/team/x/y/alive/yaw per player
      - frames carry round_idx so the client can group without scanning rounds
      - grenades keep landing coords + sparse trajectory + throw metadata
      - kills, shots, bomb timeline, players_meta omitted (live on full match_data)
    """
    meta = parsed.get("meta", {}) or {}
    rounds_in  = parsed.get("rounds", []) or []
    frames_in  = parsed.get("frames", []) or []
    grenades_in = parsed.get("grenades", []) or []

    rounds_out = []
    for i, r in enumerate(rounds_in):
        rounds_out.append({
            "idx":               i,
            "side_team_a":       r.get("team_a_side"),
            "freeze_end_tick":   int(r.get("freeze_end_tick", r.get("start_tick", 0))),
            "end_tick":          int(r.get("end_tick", 0)),
            "winner":            r.get("winner_side"),
            "won_by":            _slim_won_by(r.get("reason")),
            "bomb_planted_site": r.get("bomb_planted_site"),
        })

    frames_out = []
    for f in frames_in:
        tick = int(f.get("tick", 0))
        ridx = _round_index_for_tick(rounds_in, tick)
        if ridx is None:
            continue  # drop frames that fall outside any round (warmup, between rounds)
        slim_players = []
        for p in f.get("players", []):
            slim_players.append({
                "steam_id": p.get("steam_id", ""),
                "team":     p.get("team"),
                "x":        p.get("x", 0),
                "y":        p.get("y", 0),
                "alive":    bool(p.get("is_alive", False)),
                "yaw":      p.get("yaw", 0),
            })
        frames_out.append({
            "tick":      tick,
            "round_idx": ridx,
            "players":   slim_players,
        })

    grenades_out = []
    for g in grenades_in:
        det_tick = int(g.get("tick", 0))
        ridx = _round_index_for_tick(rounds_in, det_tick)
        if ridx is None:
            continue
        throw_tick = int(g.get("origin_tick") or g.get("path_throw_tick") or det_tick)
        thrower_sid = g.get("steam_id") or ""
        grenades_out.append({
            "round_idx":     ridx,
            "type":          g.get("type", ""),
            "thrower_sid":   thrower_sid,
            "thrower_team":  _team_at_tick(frames_in, thrower_sid, throw_tick),
            "throw_tick":    throw_tick,
            "land_x":        int(g.get("x", 0)),
            "land_y":        int(g.get("y", 0)),
            "trajectory":    list(g.get("path") or []),
        })

    # Compact players_meta into name-only lookups so the analysis side panel
    # can render thrower names (full players_meta from parse_demo carries
    # weapon counts / per-round stats we don't need for analysis).
    players_meta_in = parsed.get("players_meta", {}) or {}
    players_out = {}
    for sid, pmeta in players_meta_in.items():
        name = (pmeta or {}).get("name") if isinstance(pmeta, dict) else None
        if name:
            players_out[sid] = {"name": name}

    return {
        "meta": {
            "map":       meta.get("map", ""),
            "tick_rate": int(meta.get("tick_rate", 64)),
            "players":   players_out,
        },
        "rounds":   rounds_out,
        "frames":   frames_out,
        "grenades": grenades_out,
    }
