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
        # Match by throw-tick proximity to (g.tick - typical_flight). The Go
        # binary's det_tick is unreliable: for smokes it fires at smoke fade
        # (~18-23s late), and even for HE/molotov small subtick offsets vs
        # Python's *_detonate event push pairings out of a tight window.
        # throw_tick is a solid anchor because the throw event is well-defined.
        # The post-match plausibility check (flight_ticks <= 768) discards bad
        # pairings; the truncation step clips any post-detonation samples.
        win = 2048 if gtype == "smoke" else 1024
        # Typical throw→det offset (ticks) for matching anchor.
        TYP_FLIGHT = {"smoke": 64, "molotov": 64, "he": 64, "flash": 64}
        anchor = g.get("tick", 0) - TYP_FLIGHT.get(gtype, 64)
        for i, t in enumerate(candidates):
            if i in consumed[gtype]:
                continue
            d = abs(t.get("throw_tick", 0) - anchor)
            if d >= win:
                continue
            same_thrower = (t.get("steam_id", "") == g.get("steam_id", ""))
            score = (0 if same_thrower else 1, d)
            if best_score is None or score < best_score:
                best, best_i, best_score = t, i, score
        if best is not None:
            consumed[gtype].add(best_i)
            # Truncate at the real detonation tick (g["tick"] from the Python
            # event stream). The Go binary's path keeps sampling until
            # GrenadeProjectileDestroy fires, which for smokes is at smoke fade
            # (~22s post-detonation) — leaving the icon "in flight" all that
            # time. We trust g["tick"] over Go's det_tick for the cutoff and
            # allow a small tail (16 ticks) so the last in-flight sample isn't
            # clipped at sub-tick boundaries.
            g_det_tick = g.get("tick", 0)
            raw_path = best["path"]
            if raw_path and "tick" in raw_path[0]:
                flight_path = [pt for pt in raw_path if pt.get("tick", 0) <= g_det_tick + 16]
            else:
                flight_path = list(raw_path)
            # Strip trailing stationary samples — the projectile lands a few
            # ticks before the smokegrenade_detonate event fires, and the
            # cloud sits at the landing spot. Without this the trajectory
            # ends early and the icon idles at landing before "exploding".
            while len(flight_path) >= 2:
                last = flight_path[-1]
                prev = flight_path[-2]
                if abs(last["x"] - prev["x"]) < 1.0 and abs(last["y"] - prev["y"]) < 1.0:
                    flight_path.pop()
                else:
                    break
            plausible = len(flight_path) >= 1
            if plausible and "tick" in flight_path[0]:
                flight_ticks = g_det_tick - flight_path[0].get("tick", 0)
                # 768 ticks = ~6s @ 128Hz, generous upper bound on real flight.
                if flight_ticks < 0 or flight_ticks > 768:
                    plausible = False
            if plausible:
                # Override the last point's tick to the real detonation tick
                # so the renderer paces the icon to arrive at landing exactly
                # when the smoke goes off.
                if "tick" in flight_path[0] and len(flight_path) >= 2:
                    flight_path[-1] = dict(flight_path[-1])
                    flight_path[-1]["tick"] = g_det_tick
                g["path"]            = [[pt["x"], pt["y"]] for pt in flight_path]
                g["path_ticks"]      = [pt["tick"] for pt in flight_path] if "tick" in flight_path[0] else None
                g["origin_x"]        = flight_path[0]["x"]
                g["origin_y"]        = flight_path[0]["y"]
                g["origin_tick"]     = flight_path[0].get("tick", best.get("throw_tick", 0))
                g["path_throw_tick"] = flight_path[0].get("tick", best.get("throw_tick", 0))
                g["path_det_tick"]   = g_det_tick


def _drop_path_orphan_duplicates(grenades: list) -> list:
    """Drop grenades with no Go-track path when a sibling of same type WITH a
    real path detonates nearby in tick AND position.

    These orphans are demoparser2 ghost duplicates that survived
    _dedupe_grenades — typically a second detonate event for the same physical
    projectile that didn't merge because it landed jittered (>300 u from the
    first event for smokes, or >32 ticks apart with a different attributed
    steam_id). The Go binary tracks the real projectile once, so the path
    attaches to the first matched entry and the orphan is left path-less.

    The viewer used to hide the orphan's linear fallback at render time
    (hasPathSibling), but cleaning at the data layer means the analysis tool
    and any other consumer also see correct counts and trajectories.

    Window: 512 ticks (~8 s @ 64 Hz, ~4 s @ 128 Hz) and 600 u — wider than
    the previous viewer-side 256/400 window because some demos exhibit larger
    jitter on the duplicate event's reported coords. Within these bounds, two
    real same-type throws at the same spot don't happen in real play.
    """
    TICK_WIN = 512
    DIST_SQ_WIN = 600 * 600

    keep: list = []
    drop_count = 0
    for g in grenades:
        if g.get("path"):
            keep.append(g)
            continue
        gtype = g.get("type", "")
        gtick = g.get("tick", 0)
        gx = g.get("x", 0.0)
        gy = g.get("y", 0.0)
        is_orphan = False
        for o in grenades:
            if o is g:
                continue
            if o.get("type") != gtype:
                continue
            o_path = o.get("path")
            if not (o_path and len(o_path) >= 2):
                continue
            if abs(o.get("tick", 0) - gtick) > TICK_WIN:
                continue
            dx = o.get("x", 0.0) - gx
            dy = o.get("y", 0.0) - gy
            if dx * dx + dy * dy > DIST_SQ_WIN:
                continue
            is_orphan = True
            break
        if is_orphan:
            drop_count += 1
            continue
        keep.append(g)

    if drop_count > 0:
        print(f"[parser] dropped {drop_count} path-orphan grenade duplicates")
    return keep


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
        # HE: widened to match smoke. demoparser2 emits ghost duplicate
        # hegrenade_detonate events ~150 ticks after the original, similarly
        # to smokegrenade_detonate. A single player physically cannot throw
        # two real HEs to within 300 u of each other within 256 ticks (~4 s) —
        # the first has already exploded and the second isn't off the pin yet.
        "he":      (256, 300 * 300),
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

    # Pass 2: cross-thrower near-coincidence. Per-type windows because the
    # ghost-duplicate signature differs by grenade type. HE in particular has
    # been observed with the duplicate event ~150 ticks late at coords ~200 u
    # off, which the previous tight 32/100 window missed.
    CROSS_WINDOWS = {
        "smoke":   (32,  100 * 100),
        "molotov": (32,  100 * 100),
        "flash":   (32,  100 * 100),
        "he":      (256, 300 * 300),
    }
    pass1_by_tick = sorted(pass1, key=lambda g: (g.get("type", ""), g.get("tick", 0)))
    out: list = []
    for g in pass1_by_tick:
        gtype = g.get("type", "")
        gtick = g.get("tick", 0)
        gx, gy = g.get("x", 0.0), g.get("y", 0.0)
        tick_win, dist_sq = CROSS_WINDOWS.get(gtype, (32, 100 * 100))
        merged = False
        # Walk back through recent survivors of same type
        for prev in reversed(out):
            if prev.get("type") != gtype:
                continue
            if gtick - prev.get("tick", 0) > tick_win:
                break  # sorted by tick within type — no more candidates
            dx = prev.get("x", 0.0) - gx
            dy = prev.get("y", 0.0) - gy
            if dx * dx + dy * dy < dist_sq:
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

    try:
        hurt_df = p.parse_event("player_hurt")
    except Exception as e:
        print(f"[parser] player_hurt parse failed: {e}")
        hurt_df = None

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
            "assister_id": str(r.get("assister_steamid") or ""),
            "weapon":      str(r.get("weapon") or ""),
            "headshot":    bool(r.get("headshot") or False),
            "dmg_health":  _safe_int(r.get("dmg_health")),
            "dmg_armor":   _safe_int(r.get("dmg_armor")),
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
    grenades = _drop_path_orphan_duplicates(grenades)
    bomb     = _parse_bomb(p, by_tick, sampled)
    print(f"[parser] grenades: {len(grenades)}  bomb events: {len(bomb)}")

    damage_events = []
    if hurt_df is not None:
        for r in _to_records(hurt_df):
            damage_events.append({
                "tick":        int(r.get("tick") or 0),
                "attacker_id": str(r.get("attacker_steamid") or ""),
                "victim_id":   str(r.get("user_steamid") or ""),
                "dmg_health":  _safe_int(r.get("dmg_health")),
                "dmg_armor":   _safe_int(r.get("dmg_armor")),
                "weapon":      str(r.get("weapon") or ""),
                "hitgroup":    str(r.get("hitgroup") or ""),
            })
    print(f"[parser] damage events: {len(damage_events)}")

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
        "damage_events": damage_events,
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


_WEAPON_COSTS = {
    # Pistols
    "Glock-18": 200, "USP-S": 200, "P2000": 200, "P250": 300,
    "Tec-9": 500, "Five-SeveN": 500, "CZ75-Auto": 500,
    "Dual Berettas": 300, "Desert Eagle": 700, "R8 Revolver": 600,
    # SMGs
    "MAC-10": 1050, "MP9": 1250, "MP7": 1500, "MP5-SD": 1500,
    "UMP-45": 1200, "P90": 2350, "PP-Bizon": 1400,
    # Rifles
    "Galil AR": 1800, "FAMAS": 1950, "AK-47": 2700,
    "M4A4": 3100, "M4A1-S": 2900, "AUG": 3300, "SG 553": 3000,
    "SSG 08": 1700, "AWP": 4750, "G3SG1": 5000, "SCAR-20": 5000,
    # Heavy
    "Nova": 1050, "XM1014": 2000, "Sawed-Off": 1100,
    "MAG-7": 1300, "M249": 5200, "Negev": 1700,
    # Utility / non-buy
    "Knife": 0, "Zeus x27": 200, "Taser": 200, "C4 Explosive": 0, "C4": 0,
}


def _player_equip_value(p: dict) -> int:
    """Approximate per-player equipment value at the sampled tick.
    Sums active weapon, grenades, and armor (assumes helmet+kevlar when armor>0).
    """
    w = (p.get("weapon") or "").strip()
    val = _WEAPON_COSTS.get(w, 0)
    if p.get("has_smoke"):    val += 300
    if p.get("has_flash"):    val += 200
    if p.get("has_molotov"):  val += 400
    if p.get("has_he"):       val += 300
    if (p.get("armor") or 0) > 0:
        val += 1000  # cannot distinguish kevlar-only from kevlar+helmet here
    return val


def _team_equip_value_at_tick(frames, tick, team) -> int:
    """Sum equipment value across all players on `team` at the sampled frame
    closest to `tick` (at-or-before). Returns 0 if no frame found."""
    target = None
    for f in frames:
        if f.get("tick", 0) > tick:
            break
        target = f
    if not target:
        return 0
    return sum(_player_equip_value(p) for p in target.get("players", []) if p.get("team") == team)


def _is_pistol_round(rounds_in, idx) -> bool:
    """First round of each half is a pistol round. Detected by side flip on
    roster A — handles regulation halftime and overtime halves uniformly."""
    if idx == 0:
        return True
    prev_side = (rounds_in[idx - 1] or {}).get("team_a_side")
    this_side = (rounds_in[idx] or {}).get("team_a_side")
    return prev_side is not None and this_side is not None and prev_side != this_side


_ECO_THRESHOLD = 5000


def _classify_buy(own_value: int, opp_value: int, is_pistol: bool) -> str:
    """Classify a team's buy into pistol/eco/antieco/fullbuy.

    - pistol:   round 1 of a half
    - eco:      this team is below the eco threshold (saving)
    - antieco:  this team is bought, but the opponent is on eco
    - fullbuy:  normal gun round (both sides geared)
    """
    if is_pistol:                  return "pistol"
    if own_value < _ECO_THRESHOLD: return "eco"
    if opp_value < _ECO_THRESHOLD: return "antieco"
    return "fullbuy"


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
        freeze_end_tick = int(r.get("freeze_end_tick", r.get("start_tick", 0)))
        team_a_side = r.get("team_a_side")
        team_b_side = "t" if team_a_side == "ct" else ("ct" if team_a_side == "t" else None)
        is_pistol = _is_pistol_round(rounds_in, i)
        val_a = _team_equip_value_at_tick(frames_in, freeze_end_tick, team_a_side) if team_a_side else 0
        val_b = _team_equip_value_at_tick(frames_in, freeze_end_tick, team_b_side) if team_b_side else 0
        rounds_out.append({
            "idx":               i,
            "side_team_a":       team_a_side,
            "freeze_end_tick":   freeze_end_tick,
            "end_tick":          int(r.get("end_tick", 0)),
            "winner":            r.get("winner_side"),
            "won_by":            _slim_won_by(r.get("reason")),
            "bomb_planted_site": r.get("bomb_planted_site"),
            "buy_type_a":        _classify_buy(val_a, val_b, is_pistol),
            "buy_type_b":        _classify_buy(val_b, val_a, is_pistol),
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
            "det_tick":      det_tick,
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


def _first_event_per_round(events: list, rounds: list) -> list:
    """For each round, return the event with the smallest tick that falls
    within (start_tick, end_tick]. Returns None for rounds with no events.
    Events outside all rounds are ignored."""
    result = [None] * len(rounds)
    for ev in events:
        t = int(ev.get("tick", 0))
        for i, r in enumerate(rounds):
            if r["start_tick"] < t <= r["end_tick"]:
                if result[i] is None or t < int(result[i].get("tick", 0)):
                    result[i] = ev
                break
    return result


def _was_traded(kills: list, victim_idx: int, window_ticks: int = 320) -> bool:
    """A death is 'traded' if the attacker is killed by a teammate of the victim
    within window_ticks. Default window: 320 ticks ~ 5 seconds @ 64 tick."""
    death = kills[victim_idx]
    attacker_id = death.get("killer_id")
    victim_team = death.get("victim_team")
    death_tick  = int(death.get("tick", 0))
    if not attacker_id:
        return False
    for k in kills[victim_idx + 1:]:
        gap = int(k.get("tick", 0)) - death_tick
        if gap > window_ticks:
            break
        if k.get("victim_id") == attacker_id and k.get("killer_team") == victim_team:
            return True
    return False


def _alive_counts_per_round(rounds: list, frames: list) -> list:
    """For each round, return the minimum alive count per side observed
    across all frames in (start_tick, end_tick].

    Returns: [{ct_min_alive: int, t_min_alive: int}, ...]
    """
    result = []
    for r in rounds:
        ct_min, t_min = 5, 5
        for f in frames:
            t = int(f.get("tick", 0))
            if not (r["start_tick"] < t <= r["end_tick"]):
                continue
            ct_alive = sum(1 for p in f.get("players", []) if p.get("team") == "ct" and int(p.get("hp", 0)) > 0)
            t_alive  = sum(1 for p in f.get("players", []) if p.get("team") == "t"  and int(p.get("hp", 0)) > 0)
            if ct_alive < ct_min: ct_min = ct_alive
            if t_alive  < t_min:  t_min  = t_alive
        result.append({"ct_min_alive": ct_min, "t_min_alive": t_min})
    return result


def _clutch_outcome(rnd: dict, frames: list) -> dict | None:
    """Detect 1vN scenario in this round and report outcome.

    Returns {clutcher_id, won} if at any frame in the round one team had
    exactly 1 alive while the opponent had >=2. The clutcher is the
    last-alive player on that team at the *earliest* such frame. 'won'
    reflects whether that team's side matched rnd['winner_side'].
    Returns None if no 1vN scenario occurred.
    """
    for f in frames:
        t = int(f.get("tick", 0))
        if not (rnd["start_tick"] < t <= rnd["end_tick"]):
            continue
        ct_alive = [p for p in f.get("players", []) if p.get("team") == "ct" and int(p.get("hp", 0)) > 0]
        t_alive  = [p for p in f.get("players", []) if p.get("team") == "t"  and int(p.get("hp", 0)) > 0]
        if len(ct_alive) == 1 and len(t_alive) >= 2:
            return {"clutcher_id": ct_alive[0]["steam_id"], "won": rnd.get("winner_side") == "ct"}
        if len(t_alive) == 1 and len(ct_alive) >= 2:
            return {"clutcher_id": t_alive[0]["steam_id"], "won": rnd.get("winner_side") == "t"}
    return None


_GRENADE_WEAPONS = {"hegrenade", "inferno", "molotov", "incendiary", "incgrenade"}


def _grenade_damage_attribution(damage_events: list) -> dict:
    """Sum grenade damage per thrower steam_id."""
    out: dict = {}
    for ev in damage_events:
        if (ev.get("weapon") or "").lower() not in _GRENADE_WEAPONS:
            continue
        sid = ev.get("attacker_id")
        if not sid:
            continue
        out[sid] = out.get(sid, 0) + int(ev.get("dmg_health", 0))
    return out


def _flash_assist_for_kill(kill: dict, flashes: list, window_ticks: int = 140) -> str | None:
    """Find a flasher who blinded the victim within window_ticks before the kill.
    Returns the flasher's steam_id, or None. Killer is not a valid flash-assister.
    """
    kill_tick = int(kill.get("tick", 0))
    victim    = kill.get("victim_id")
    killer    = kill.get("killer_id")
    best = None
    best_tick = -1
    for fl in flashes:
        if fl.get("victim_id") != victim:
            continue
        thrower = fl.get("thrower_id")
        if not thrower or thrower == killer:
            continue
        ft = int(fl.get("tick", 0))
        if ft <= kill_tick and (kill_tick - ft) <= window_ticks and ft > best_tick:
            best, best_tick = thrower, ft
    return best


def _hltv_rating(kills: int, deaths: int, rounds: int,
                 multi_1k: int, multi_2k: int, multi_3k: int,
                 multi_4k: int, multi_5k: int) -> float:
    """HLTV 1.0 rating formula."""
    if rounds <= 0:
        return 0.0
    kill_rating     = kills / rounds / 0.679
    survival_rating = max(rounds - deaths, 0) / rounds / 0.317
    rwm             = (1*multi_1k + 4*multi_2k + 9*multi_3k + 16*multi_4k + 25*multi_5k) / rounds / 1.277
    return round((kill_rating + 0.7 * survival_rating + rwm) / 2.7, 3)


def compute_player_stats(parsed: dict) -> list[dict]:
    """Returns 3 rows per player ({side: 'all'|'ct'|'t'}).

    Wraps an inner loop in try/except — if anything goes wrong we return [].
    """
    try:
        rounds        = parsed.get("rounds") or []
        kills         = parsed.get("kills") or []
        damage_events = parsed.get("damage_events") or []
        frames        = parsed.get("frames") or []
        grenades      = parsed.get("grenades") or []
        players_meta  = parsed.get("players_meta") or {}
        team_a_first  = (parsed.get("meta") or {}).get("team_a_first_side")

        # Pre-compute things shared across players
        first_kill_per_round  = _first_event_per_round(kills, rounds)
        alive_counts          = _alive_counts_per_round(rounds, frames)
        clutch_per_round      = [_clutch_outcome(r, frames) for r in rounds]
        utility_dmg_by_sid    = _grenade_damage_attribution(damage_events)

        # Build a flash list from grenades. NOTE: flash_assists requires
        # player_blind event ingestion (deferred to Ship 2). Until then
        # `hits` is always empty and flash_assists stays 0.
        flash_events = []
        for g in grenades:
            if (g.get("type") or "").lower() != "flash":
                continue
            for h in (g.get("hits") or []):
                flash_events.append({
                    "thrower_id": str(g.get("steam_id") or ""),
                    "victim_id":  str(h.get("victim_id") or ""),
                    "tick":       int(h.get("tick") or g.get("tick") or 0),
                })

        # Identify which roster (a or b) a player belongs to. team_a_first_side
        # tells us which side team_a started on. We look at the player's side
        # at round 1's freeze_end_tick.
        def player_team_letter(sid: str) -> str | None:
            if not rounds: return None
            r1 = rounds[0]
            target_tick = r1.get("freeze_end_tick") or r1["start_tick"]
            for f in frames:
                if int(f.get("tick", 0)) >= target_tick:
                    for p in f.get("players", []):
                        if p.get("steam_id") == sid:
                            side = p.get("team")
                            if side == team_a_first: return "a"
                            if side and side != team_a_first: return "b"
                    return None
            return None

        # Identify rounds each player was alive at start (rounds_played)
        def alive_at_round_start(sid: str, rnd: dict) -> bool:
            target_tick = rnd.get("freeze_end_tick") or rnd["start_tick"]
            for f in frames:
                if int(f.get("tick", 0)) >= target_tick:
                    for p in f.get("players", []):
                        if p.get("steam_id") == sid:
                            return int(p.get("hp", 0)) > 0
                    return False
            return False

        def round_side_for(sid: str, rnd: dict) -> str | None:
            """Look up the player's side at round freeze-end. Falls back to None."""
            target_tick = rnd.get("freeze_end_tick") or rnd["start_tick"]
            for f in frames:
                if int(f.get("tick", 0)) >= target_tick:
                    for p in f.get("players", []):
                        if p.get("steam_id") == sid:
                            return p.get("team")
                    return None
            return None

        # Collect all sids
        sids = set(players_meta.keys())
        for k in kills:
            if k.get("killer_id"): sids.add(k["killer_id"])
            if k.get("victim_id"): sids.add(k["victim_id"])

        out: list[dict] = []
        for sid in sids:
            if not sid:
                continue
            # Aggregator per side bucket
            buckets = {
                "all": _empty_player_bucket(),
                "ct":  _empty_player_bucket(),
                "t":   _empty_player_bucket(),
            }

            # Rounds-played + per-round multi-kill counters per side
            for ri, rnd in enumerate(rounds):
                if not alive_at_round_start(sid, rnd):
                    continue
                side = round_side_for(sid, rnd) or "ct"
                if side not in ("ct", "t"):
                    continue
                for b in (buckets["all"], buckets[side]):
                    b["rounds_played"] += 1

                # Round-level kills/deaths/assists
                rkills = [k for k in kills if rnd["start_tick"] < int(k["tick"]) <= rnd["end_tick"]]
                killed   = sum(1 for k in rkills if k.get("killer_id") == sid)
                died     = any(k.get("victim_id") == sid for k in rkills)
                assisted = any(k.get("assister_id") == sid for k in rkills)
                survived = not died

                # Multi-kill bucket
                multi_idx = min(killed, 5)
                if multi_idx > 0:
                    for b in (buckets["all"], buckets[side]):
                        b[f"multi_{multi_idx}k"] += 1

                # KAST: did player K, A, S, or get traded death?
                trade_traded_death = False
                for ki, k in enumerate(kills):
                    if k.get("victim_id") == sid and rnd["start_tick"] < int(k["tick"]) <= rnd["end_tick"]:
                        if _was_traded(kills, ki):
                            trade_traded_death = True
                            for b in (buckets["all"], buckets[side]):
                                b["traded_deaths"] += 1
                            break
                if killed > 0 or assisted or survived or trade_traded_death:
                    for b in (buckets["all"], buckets[side]):
                        b["kast_rounds"] += 1

                # Opening kill / death
                fk = first_kill_per_round[ri]
                if fk:
                    if fk.get("killer_id") == sid:
                        for b in (buckets["all"], buckets[side]):
                            b["opening_kills"] += 1
                    if fk.get("victim_id") == sid:
                        for b in (buckets["all"], buckets[side]):
                            b["opening_deaths"] += 1

                # Clutches
                clutch = clutch_per_round[ri]
                if clutch and clutch.get("clutcher_id") == sid:
                    key = "clutches_won" if clutch["won"] else "clutches_lost"
                    for b in (buckets["all"], buckets[side]):
                        b[key] += 1

            # Cross-round totals: kills, deaths, assists, hs
            for k in kills:
                if k.get("killer_id") == sid:
                    side = (k.get("killer_team") or "ct")
                    for b in (buckets["all"], buckets[side]):
                        b["kills"] += 1
                        if k.get("headshot"):
                            b["hs_kills"] += 1
                if k.get("victim_id") == sid:
                    side = (k.get("victim_team") or "ct")
                    for b in (buckets["all"], buckets[side]):
                        b["deaths"] += 1
                if k.get("assister_id") == sid:
                    # Assister side at kill tick — best effort: same as killer team
                    side = (k.get("killer_team") or "ct")
                    for b in (buckets["all"], buckets[side]):
                        b["assists"] += 1

            # Damage (from player_hurt — includes fatal blows)
            for ev in damage_events:
                if ev.get("attacker_id") == sid:
                    # Attribute by attacker's side at hit tick — best effort: use kill_team lookup
                    side = _team_at_tick(frames, sid, int(ev.get("tick", 0))) or "ct"
                    for b in (buckets["all"], buckets[side]):
                        b["damage_dealt"] += int(ev.get("dmg_health", 0))

            # Utility damage + flash assists
            ud = utility_dmg_by_sid.get(sid, 0)
            for k in kills:
                if k.get("killer_id") == sid:
                    continue
                fa = _flash_assist_for_kill(k, flash_events)
                if fa == sid:
                    side = (k.get("killer_team") or "ct")
                    for b in (buckets["all"], buckets[side]):
                        b["flash_assists"] += 1

            # Emit rows
            meta = players_meta.get(sid)
            name = (meta.get("name") if isinstance(meta, dict) else meta) or ""
            team_letter = player_team_letter(sid)
            for side_label, b in buckets.items():
                if b["rounds_played"] == 0 and side_label != "all":
                    continue  # skip empty side rows
                rounds_played = b["rounds_played"] or 1
                row = {
                    "steam_id":       sid,
                    "name":           name,
                    "team":           team_letter,
                    "side":           side_label,
                    "kills":          b["kills"],
                    "deaths":         b["deaths"],
                    "assists":        b["assists"],
                    "hs_pct":         round(b["hs_kills"] / b["kills"], 3) if b["kills"] else 0.0,
                    "adr":            round(b["damage_dealt"] / rounds_played, 1),
                    "kast_pct":       round(b["kast_rounds"] / rounds_played, 3),
                    "multi_2k":       b["multi_2k"],
                    "multi_3k":       b["multi_3k"],
                    "multi_4k":       b["multi_4k"],
                    "multi_5k":       b["multi_5k"],
                    "opening_kills":  b["opening_kills"],
                    "opening_deaths": b["opening_deaths"],
                    "clutches_won":   b["clutches_won"],
                    "clutches_lost":  b["clutches_lost"],
                    "utility_dmg":    ud if side_label == "all" else 0,
                    "flash_assists":  b["flash_assists"],
                    "traded_deaths":  b["traded_deaths"],
                    "rounds_played":  b["rounds_played"],
                    "impact_rating":  round(
                        (b["opening_kills"] + b["clutches_won"] +
                         b["multi_3k"] + b["multi_4k"] + b["multi_5k"]) / rounds_played, 3),
                    "rating":         _hltv_rating(
                        b["kills"], b["deaths"], rounds_played,
                        b["multi_1k"], b["multi_2k"], b["multi_3k"], b["multi_4k"], b["multi_5k"],
                    ),
                }
                out.append(row)
        return out
    except Exception as e:
        import traceback
        print(f"[stats] compute_player_stats failed: {e}")
        print(traceback.format_exc())
        return []


def _empty_player_bucket() -> dict:
    return {
        "kills": 0, "deaths": 0, "assists": 0, "hs_kills": 0,
        "damage_dealt": 0, "rounds_played": 0, "kast_rounds": 0,
        "multi_1k": 0, "multi_2k": 0, "multi_3k": 0, "multi_4k": 0, "multi_5k": 0,
        "opening_kills": 0, "opening_deaths": 0,
        "clutches_won": 0, "clutches_lost": 0,
        "flash_assists": 0, "traded_deaths": 0,
    }


def compute_team_stats(parsed: dict) -> list[dict]:
    """Returns 2 rows: team='a' and team='b'."""
    try:
        rounds        = parsed.get("rounds") or []
        kills         = parsed.get("kills") or []
        frames        = parsed.get("frames") or []
        bomb          = parsed.get("bomb") or []

        first_kill_per_round = _first_event_per_round(kills, rounds)
        alive_counts         = _alive_counts_per_round(rounds, frames)

        # Initialize stats for both teams
        def empty():
            return {
                "pistol_wins": 0, "pistol_played": 0,
                "five_v_four_wins": 0, "five_v_four_played": 0,
                "five_v_four_t_wins": 0, "five_v_four_t_played": 0,
                "five_v_four_ct_wins": 0, "five_v_four_ct_played": 0,
                "first_kills": 0, "first_deaths": 0,
                "first_kills_t": 0, "first_kills_ct": 0,
                "first_deaths_t": 0, "first_deaths_ct": 0,
                "eco_wins": 0, "eco_played": 0,
                "force_wins": 0, "force_played": 0,
                "full_buy_wins": 0, "full_buy_played": 0,
                "bomb_plants": 0, "bomb_defuses": 0,
                "ct_round_wins": 0, "ct_rounds_played": 0,
                "t_round_wins": 0, "t_rounds_played": 0,
            }

        a, b = empty(), empty()

        for ri, rnd in enumerate(rounds):
            a_side = rnd.get("team_a_side")  # 'ct' or 't'
            b_side = "t" if a_side == "ct" else "ct"
            winner = rnd.get("winner_side")

            # Side win/loss
            if a_side == "ct":
                a["ct_rounds_played"] += 1
                a["ct_round_wins"]    += 1 if winner == "ct" else 0
                b["t_rounds_played"]  += 1
                b["t_round_wins"]     += 1 if winner == "t" else 0
            else:
                a["t_rounds_played"]  += 1
                a["t_round_wins"]     += 1 if winner == "t" else 0
                b["ct_rounds_played"] += 1
                b["ct_round_wins"]    += 1 if winner == "ct" else 0

            # Pistol
            if _is_pistol_round(rounds, ri):
                a["pistol_played"] += 1
                b["pistol_played"] += 1
                if winner == a_side: a["pistol_wins"] += 1
                if winner == b_side: b["pistol_wins"] += 1

            # First kill / death
            fk = first_kill_per_round[ri]
            if fk:
                killer_team = fk.get("killer_team")
                victim_team = fk.get("victim_team")
                if killer_team == a_side:
                    a["first_kills"] += 1
                    a[f"first_kills_{a_side}"] += 1
                    b["first_deaths"] += 1
                    b[f"first_deaths_{b_side}"] += 1
                if killer_team == b_side:
                    b["first_kills"] += 1
                    b[f"first_kills_{b_side}"] += 1
                    a["first_deaths"] += 1
                    a[f"first_deaths_{a_side}"] += 1

            # 5v4 — at any frame, did either side have +1 alive
            ac = alive_counts[ri] if ri < len(alive_counts) else None
            if ac:
                # If at any point one side dropped below 5 while the other had >=5,
                # the team WITH the advantage played a 5v4. Approximation: if a_side
                # min alive is 5 and b_side min alive < 5, team A had a man advantage.
                a_min = ac["ct_min_alive"] if a_side == "ct" else ac["t_min_alive"]
                b_min = ac["ct_min_alive"] if b_side == "ct" else ac["t_min_alive"]
                if a_min >= 5 and b_min < 5:
                    a["five_v_four_played"] += 1
                    a[f"five_v_four_{a_side}_played"] += 1
                    if winner == a_side:
                        a["five_v_four_wins"] += 1
                        a[f"five_v_four_{a_side}_wins"] += 1
                if b_min >= 5 and a_min < 5:
                    b["five_v_four_played"] += 1
                    b[f"five_v_four_{b_side}_played"] += 1
                    if winner == b_side:
                        b["five_v_four_wins"] += 1
                        b[f"five_v_four_{b_side}_wins"] += 1

            # Buy classification — needs equip values per team
            a_equip = _team_equip_value_at_tick(frames, rnd.get("freeze_end_tick", rnd["start_tick"]), a_side)
            b_equip = _team_equip_value_at_tick(frames, rnd.get("freeze_end_tick", rnd["start_tick"]), b_side)
            is_pistol = _is_pistol_round(rounds, ri)
            a_buy = _classify_buy(a_equip, b_equip, is_pistol)
            b_buy = _classify_buy(b_equip, a_equip, is_pistol)
            for team, buy, side in ((a, a_buy, a_side), (b, b_buy, b_side)):
                if buy == "eco":
                    team["eco_played"] += 1
                    if winner == side: team["eco_wins"] += 1
                # Ship 1 maps anti-eco buys to the force_* bucket: a true
                # force-buy classifier isn't available yet, and an anti-eco is
                # the closest available proxy. The DB columns stay force_*.
                elif buy == "antieco":
                    team["force_played"] += 1
                    if winner == side: team["force_wins"] += 1
                elif buy == "fullbuy":
                    team["full_buy_played"] += 1
                    if winner == side: team["full_buy_wins"] += 1

        # Bomb plants/defuses
        for ev in bomb:
            etype = (ev.get("type") or "").lower()
            # Plant attributed to whoever's on T side at the tick;
            # defuse to whoever's on CT.
            if etype == "planted":
                # Find the planter's *roster* (a or b) by the round side
                ri = _round_index_for_tick(rounds, int(ev.get("tick", 0)))
                if ri is not None and 0 <= ri < len(rounds):
                    a_side_here = rounds[ri].get("team_a_side")
                    if a_side_here == "t":
                        a["bomb_plants"] += 1
                    else:
                        b["bomb_plants"] += 1
            elif etype == "defused":
                ri = _round_index_for_tick(rounds, int(ev.get("tick", 0)))
                if ri is not None and 0 <= ri < len(rounds):
                    a_side_here = rounds[ri].get("team_a_side")
                    if a_side_here == "ct":
                        a["bomb_defuses"] += 1
                    else:
                        b["bomb_defuses"] += 1

        return [{"team": "a", **a}, {"team": "b", **b}]
    except Exception as e:
        import traceback
        print(f"[stats] compute_team_stats failed: {e}")
        print(traceback.format_exc())
        return []
