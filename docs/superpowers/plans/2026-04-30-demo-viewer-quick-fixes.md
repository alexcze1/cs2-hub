# Demo Viewer Quick Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix seven scoped bugs and small UX gaps in the existing demo viewer — BO3 team naming, grenade dedupe, drop/pickup tracking, round filtering, click-to-setpos, auto-play on round click, engine-truth flash visibility.

**Architecture:** Two ship bundles. Bundle A — `vps/demo_parser.py` changes (deploys to VPS once, applies to new uploads only). Bundle B — `cs2-hub/demo-viewer.js`, `demo-viewer.html`, `demos.js` changes (works for old + new demos where data exists, falls back gracefully where it doesn't).

**Tech Stack:** Python 3 + `demoparser2` (server parser), vanilla JS / Canvas 2D (viewer), Supabase (DB + realtime), pytest (server tests).

**Spec:** `docs/superpowers/specs/2026-04-30-demo-viewer-quick-fixes-design.md`

---

## File Map

| File | What changes |
|---|---|
| `vps/demo_parser.py` | New helpers: `_dedupe_grenades`, `_is_knife_round`, `_pre_match_cutoff`. Rewritten `_build_grenade_paths`. `parse_demo` adds `Z` / `pitch` / `flash_duration` to `parse_ticks` columns; emits `z` / `pitch` / `flash_duration` per player; deletes `blinds[]` estimation block; runs new filters; recomputes `meta.ct_score` / `t_score` after filters. |
| `vps/tests/test_parser.py` | New unit tests for the helpers above. |
| `cs2-hub/demo-viewer.js` | Update grenade dedupe to prefer `g.id`. Remove client-side knife filter. `jumpToRound` sets `playing = true`. Add `copySetposFor` + `showSetposToast` + click handlers (panel + canvas). Replace `blindUntil` map with `flashIntensity(p)` reading `p.flash_duration`. |
| `cs2-hub/demo-viewer.html` | Add `.player-card { cursor: pointer; }` + hover. |
| `cs2-hub/demos.js` | Replace `showAssignTeamsModal` with roster-based modal. Add `detectRosters()` helper. Update realtime trigger to gate on series-completeness. |

---

## Task 1: Server — `_dedupe_grenades` helper (TDD)

**Files:**
- Modify: `vps/demo_parser.py`
- Test: `vps/tests/test_parser.py`

- [ ] **Step 1: Write the failing test**

Append to `vps/tests/test_parser.py` after the `_is_warmup` tests (around line 81):

```python
# ── _dedupe_grenades ──────────────────────────────────────────

def test_dedupe_grenades_keeps_distinct_throws():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke",   "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 2000, "type": "smoke",   "x": 800.0, "y": 800.0, "steam_id": "A"},
        {"tick": 1500, "type": "molotov", "x": 100.0, "y": 100.0, "steam_id": "A"},
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 3


def test_dedupe_grenades_collapses_subtick_double_fire():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 1002, "type": "smoke", "x": 100.5, "y": 100.5, "steam_id": "A"},  # subtick dup
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 1
    assert out[0]["tick"] == 1000  # earliest preserved


def test_dedupe_grenades_keeps_far_apart_same_player_throws():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 1080, "type": "smoke", "x": 105.0, "y": 105.0, "steam_id": "A"},  # 80 ticks apart > 64
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 2


def test_dedupe_grenades_keeps_same_tick_far_apart_positions():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 1010, "type": "smoke", "x": 900.0, "y": 900.0, "steam_id": "A"},  # 800 units apart > 300
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 2


def test_dedupe_grenades_assigns_synthetic_ids():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 2000, "type": "flash", "x": 200.0, "y": 200.0, "steam_id": "B"},
    ]
    out = _dedupe_grenades(grenades)
    assert all("id" in g for g in out)
    assert out[0]["id"] != out[1]["id"]


def test_dedupe_grenades_different_types_not_merged():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke",   "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 1010, "type": "molotov", "x": 100.0, "y": 100.0, "steam_id": "A"},
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 2


def test_dedupe_grenades_different_players_not_merged():
    from demo_parser import _dedupe_grenades
    grenades = [
        {"tick": 1000, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "A"},
        {"tick": 1010, "type": "smoke", "x": 100.0, "y": 100.0, "steam_id": "B"},
    ]
    out = _dedupe_grenades(grenades)
    assert len(out) == 2
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/Users/A/Documents/claude/vps && python -m pytest tests/test_parser.py -v -k dedupe_grenades
```

Expected: 7 tests fail with `ImportError: cannot import name '_dedupe_grenades'`.

- [ ] **Step 3: Implement `_dedupe_grenades` in `demo_parser.py`**

Insert immediately after `_parse_grenades` (after line 299 in the existing file):

```python
def _dedupe_grenades(grenades: list) -> list:
    """Collapse subtick-duplicated grenade rows. Two rows are merged if same
    steam_id, same type, within 64 ticks AND within 300 world units of each
    other. Earliest entry is preserved. Each survivor gets a synthetic 'id'
    field so the client can dedupe stably regardless of tick collisions.
    """
    sorted_g = sorted(
        grenades,
        key=lambda g: (g.get("steam_id", ""), g.get("type", ""), g.get("tick", 0)),
    )
    out: list = []
    for g in sorted_g:
        merged = False
        if out:
            prev = out[-1]
            if (prev.get("steam_id", "") == g.get("steam_id", "")
                    and prev.get("type") == g.get("type")
                    and abs(prev.get("tick", 0) - g.get("tick", 0)) <= 64):
                dx = prev.get("x", 0.0) - g.get("x", 0.0)
                dy = prev.get("y", 0.0) - g.get("y", 0.0)
                if dx * dx + dy * dy < 300 * 300:
                    merged = True
        if not merged:
            out.append(g)
    for i, g in enumerate(out):
        g["id"] = f"{g.get('type','')}-{g.get('tick',0)}-{g.get('steam_id','')}-{i}"
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd C:/Users/A/Documents/claude/vps && python -m pytest tests/test_parser.py -v -k dedupe_grenades
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/A/Documents/claude && git add vps/demo_parser.py vps/tests/test_parser.py && git commit -m "feat(parser): add _dedupe_grenades helper with synthetic ids

Merges subtick duplicate grenade rows (same steam_id+type, within 64 ticks
and 300 world units). Assigns each survivor a stable synthetic id field so
the client can dedupe across tick collisions.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Server — rewrite `_build_grenade_paths` (TDD)

**Files:**
- Modify: `vps/demo_parser.py:202-231`
- Test: `vps/tests/test_parser.py`

- [ ] **Step 1: Write the failing test**

Append to `vps/tests/test_parser.py`:

```python
# ── _build_grenade_paths ──────────────────────────────────────

def test_build_grenade_paths_matches_same_player_two_throws():
    """Player A throws smoke #1 (det 1000), throws smoke #2 (det 2000).
    Both tracks must attach to the right grenade.
    """
    from demo_parser import _build_grenade_paths
    grenades = [
        {"tick": 1000, "type": "smoke", "steam_id": "A", "x": 0, "y": 0},
        {"tick": 2000, "type": "smoke", "steam_id": "A", "x": 0, "y": 0},
    ]
    raw_tracks = [
        {"steam_id": "A", "type": "smoke", "throw_tick":  900, "det_tick": 1000,
         "path": [{"x": 1.0, "y": 1.0, "tick":  900}, {"x": 2.0, "y": 2.0, "tick": 1000}]},
        {"steam_id": "A", "type": "smoke", "throw_tick": 1900, "det_tick": 2000,
         "path": [{"x": 3.0, "y": 3.0, "tick": 1900}, {"x": 4.0, "y": 4.0, "tick": 2000}]},
    ]
    _build_grenade_paths(grenades, raw_tracks)
    assert grenades[0]["origin_tick"] == 900
    assert grenades[1]["origin_tick"] == 1900
    assert grenades[0]["path"][0] == [1.0, 1.0]
    assert grenades[1]["path"][0] == [3.0, 3.0]


def test_build_grenade_paths_picked_up_grenade_attribution():
    """Player B picks up A's dropped smoke and throws it. The detonation event
    has B as steam_id; the Go-binary track also has B (since it tracks the
    re-thrown projectile entity from B's hand). Match must succeed.
    """
    from demo_parser import _build_grenade_paths
    grenades = [
        {"tick": 1000, "type": "smoke", "steam_id": "A", "x": 0, "y": 0},
        {"tick": 2000, "type": "smoke", "steam_id": "B", "x": 0, "y": 0},
    ]
    raw_tracks = [
        {"steam_id": "A", "type": "smoke", "throw_tick":  900, "det_tick": 1000,
         "path": [{"x": 1.0, "y": 1.0, "tick":  900}, {"x": 2.0, "y": 2.0, "tick": 1000}]},
        {"steam_id": "B", "type": "smoke", "throw_tick": 1900, "det_tick": 2000,
         "path": [{"x": 3.0, "y": 3.0, "tick": 1900}, {"x": 4.0, "y": 4.0, "tick": 2000}]},
    ]
    _build_grenade_paths(grenades, raw_tracks)
    assert grenades[0]["origin_tick"] == 900
    assert grenades[1]["origin_tick"] == 1900


def test_build_grenade_paths_steamid_mismatch_falls_back_to_proximity():
    """Detonation steam_id differs from track steam_id (e.g. attribution glitch).
    Match should still succeed by tick proximity."""
    from demo_parser import _build_grenade_paths
    grenades = [
        {"tick": 1000, "type": "smoke", "steam_id": "A", "x": 0, "y": 0},
    ]
    raw_tracks = [
        {"steam_id": "OTHER", "type": "smoke", "throw_tick": 900, "det_tick": 1000,
         "path": [{"x": 1.0, "y": 1.0, "tick": 900}, {"x": 2.0, "y": 2.0, "tick": 1000}]},
    ]
    _build_grenade_paths(grenades, raw_tracks)
    assert grenades[0]["origin_tick"] == 900


def test_build_grenade_paths_too_far_apart_no_match():
    from demo_parser import _build_grenade_paths
    grenades = [{"tick": 1000, "type": "smoke", "steam_id": "A", "x": 0, "y": 0}]
    raw_tracks = [
        {"steam_id": "A", "type": "smoke", "throw_tick": 5000, "det_tick": 5300,
         "path": [{"x": 1.0, "y": 1.0, "tick": 5000}]},
    ]
    _build_grenade_paths(grenades, raw_tracks)
    assert "origin_tick" not in grenades[0]


def test_build_grenade_paths_consumed_track_not_reused():
    """If two grenades both want the same track, only one consumes it."""
    from demo_parser import _build_grenade_paths
    grenades = [
        {"tick": 1000, "type": "smoke", "steam_id": "A", "x": 0, "y": 0},
        {"tick": 1010, "type": "smoke", "steam_id": "A", "x": 0, "y": 0},
    ]
    raw_tracks = [
        {"steam_id": "A", "type": "smoke", "throw_tick": 900, "det_tick": 1000,
         "path": [{"x": 1.0, "y": 1.0, "tick": 900}]},
    ]
    _build_grenade_paths(grenades, raw_tracks)
    assert grenades[0].get("origin_tick") == 900
    assert "origin_tick" not in grenades[1]
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/Users/A/Documents/claude/vps && python -m pytest tests/test_parser.py -v -k build_grenade_paths
```

Expected: tests covering picked-up attribution and steam_id mismatch fail (the others may pass with the old implementation).

- [ ] **Step 3: Replace `_build_grenade_paths` body**

In `vps/demo_parser.py`, replace lines 202-231 (the `_build_grenade_paths` function) with:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd C:/Users/A/Documents/claude/vps && python -m pytest tests/test_parser.py -v -k build_grenade_paths
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/A/Documents/claude && git add vps/demo_parser.py vps/tests/test_parser.py && git commit -m "fix(parser): match grenade paths by type+proximity, not (steam_id,type)

Old key collided when one player threw multiple grenades of the same type
(own + picked-up), causing the second grenade to lose its path. New key is
type-only, with same-thrower as a tiebreaker among same-tick candidates.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Server — pre-match cutoff + knife round filter helpers (TDD)

**Files:**
- Modify: `vps/demo_parser.py`
- Test: `vps/tests/test_parser.py`

- [ ] **Step 1: Write the failing tests**

Append to `vps/tests/test_parser.py`:

```python
# ── _is_knife_round ───────────────────────────────────────────

def test_is_knife_round_short_with_only_knife_kills():
    from demo_parser import _is_knife_round
    rnd   = {"start_tick": 1000, "end_tick": 1000 + 64 * 30}  # 30 s
    kills = [
        {"tick": 1100, "weapon": "knife"},
        {"tick": 1200, "weapon": "weapon_knife_t"},
    ]
    assert _is_knife_round(rnd, kills, tick_rate=64) is True


def test_is_knife_round_short_with_gun_kill_not_knife():
    from demo_parser import _is_knife_round
    rnd   = {"start_tick": 1000, "end_tick": 1000 + 64 * 30}
    kills = [{"tick": 1100, "weapon": "ak47"}]
    assert _is_knife_round(rnd, kills, tick_rate=64) is False


def test_is_knife_round_long_round_never_knife():
    from demo_parser import _is_knife_round
    rnd   = {"start_tick": 1000, "end_tick": 1000 + 64 * 80}  # 80 s > 75 s
    kills = []  # even with no kills, too long to be knife
    assert _is_knife_round(rnd, kills, tick_rate=64) is False


def test_is_knife_round_no_kills_at_all_short_round():
    """Short round with no kills (timed out) — treat as non-knife since we
    cannot prove it was a knife round. Conservative: keep it."""
    from demo_parser import _is_knife_round
    rnd   = {"start_tick": 1000, "end_tick": 1000 + 64 * 30}
    kills = []
    assert _is_knife_round(rnd, kills, tick_rate=64) is False


def test_is_knife_round_kills_outside_window_ignored():
    from demo_parser import _is_knife_round
    rnd   = {"start_tick": 1000, "end_tick": 1000 + 64 * 30}
    kills = [
        {"tick": 500,  "weapon": "ak47"},   # before round
        {"tick": 5000, "weapon": "ak47"},   # after round
        {"tick": 1100, "weapon": "knife"},  # only kill in-round → knife
    ]
    assert _is_knife_round(rnd, kills, tick_rate=64) is True
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/Users/A/Documents/claude/vps && python -m pytest tests/test_parser.py -v -k is_knife_round
```

Expected: 5 tests fail with `ImportError: cannot import name '_is_knife_round'`.

- [ ] **Step 3: Implement `_is_knife_round`**

Insert into `vps/demo_parser.py` immediately after `_is_warmup` (around line 49):

```python
_KNIFE_WEAPONS = {
    "knife", "knifegg", "knife_t", "knife_ct", "bayonet",
    "knife_butterfly", "knife_karambit", "knife_m9_bayonet", "knife_flip",
    "knife_gut", "knife_falchion", "knife_shadow_daggers", "knife_bowie",
    "knife_ursus", "knife_gypsy_jackknife", "knife_stiletto", "knife_widowmaker",
    "knife_skeleton", "knife_cord", "knife_canis", "knife_outdoor", "knife_push",
    "knife_tactical", "knife_css",
}


def _is_knife_round(rnd: dict, kills: list, tick_rate: int) -> bool:
    """A round is a knife round iff it is short (≤75 s) AND has at least one
    kill in-window AND none of the in-window kills used a non-knife weapon.

    Empty kill list means no evidence — keep the round (conservative)."""
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd C:/Users/A/Documents/claude/vps && python -m pytest tests/test_parser.py -v -k is_knife_round
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/A/Documents/claude && git add vps/demo_parser.py vps/tests/test_parser.py && git commit -m "feat(parser): add _is_knife_round helper

Server-side knife round detection. Conservative: empty kill list means keep
the round; only rounds with kills, all knife, under 75 s qualify.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Server — wire `parse_demo` to use new helpers + add columns + drop `blinds[]`

**Files:**
- Modify: `vps/demo_parser.py:343-611`

- [ ] **Step 1: Add `Z`, `pitch`, `flash_duration` to `parse_ticks` columns**

In `vps/demo_parser.py`, find the `tick_df = p.parse_ticks(...)` call (around line 431) and replace with:

```python
    tick_df = p.parse_ticks(
        ["X", "Y", "Z", "health", "is_alive", "team_num", "active_weapon_name",
         "balance", "armor_value", "yaw", "pitch", "flash_duration"] + _util_cols,
        ticks=sampled,
    )
```

- [ ] **Step 2: Emit `z`, `pitch`, `flash_duration` per player in the frame build**

In the per-player append block in `parse_demo` (around line 485-501, the `players.append({...})` call), update to:

```python
            players.append({
                "steam_id":       str(r.get("steamid") or ""),
                "name":           str(r.get("name") or ""),
                "team":           "ct" if team_num == 3 else "t",
                "x":              _safe_float(r.get("X")),
                "y":              _safe_float(r.get("Y")),
                "z":              _safe_float(r.get("Z")),
                "hp":             _safe_int(r.get("health")),
                "armor":          _safe_int(r.get("armor_value")),
                "weapon":         str(r.get("active_weapon_name") or ""),
                "money":          _safe_int(r.get("balance")),
                "is_alive":       bool(r.get("is_alive") or False),
                "yaw":            _safe_float(r.get("yaw")),
                "pitch":          _safe_float(r.get("pitch")),
                "flash_duration": _safe_float(r.get("flash_duration")),
                "has_smoke":      has_smoke,
                "has_flash":      has_flash,
                "has_molotov":    has_molotov,
                "has_he":         has_he,
            })
```

- [ ] **Step 3: Add pre-match cutoff filter to `parse_demo`**

In `vps/demo_parser.py`, after the `pairs = _pair_rounds(...)` line (around line 368) and before the `rounds = []` line, add:

```python
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
```

Then, inside the round-build loop where the warmup filter is, after the `_is_warmup` check, add a pre-match cutoff check. Find:

```python
    for pair in pairs:
        if _is_warmup(pair["start_tick"], pair["end_tick"]):
            print(f"[parser] skip warmup: {pair['start_tick']}→{pair['end_tick']}")
            continue
        winner = _winner_side(pair["winner"])
```

Replace with:

```python
    for pair in pairs:
        if _is_warmup(pair["start_tick"], pair["end_tick"]):
            print(f"[parser] skip warmup: {pair['start_tick']}→{pair['end_tick']}")
            continue
        if pair["start_tick"] < live_start_tick:
            print(f"[parser] skip pre-live: {pair['start_tick']} < {live_start_tick}")
            continue
        winner = _winner_side(pair["winner"])
```

- [ ] **Step 4: Apply knife filter and recompute scores after kills are built**

In `vps/demo_parser.py`, find the block where `kills` is built (the `for r in kills_records:` loop ending around line 541). Immediately after that loop ends (before `tick_rate = 70`), insert:

```python
    # Knife-round filter (now that kills are built) and score recompute.
    pre_knife_count = len(rounds)
    rounds = [r for r in rounds if not _is_knife_round(r, kills, tick_rate=64)]
    for i, r in enumerate(rounds):
        r["round_num"] = i + 1
    print(f"[parser] knife filter: {pre_knife_count} → {len(rounds)} rounds")
```

Then update the score lines (currently lines 543-544):

```python
    tick_rate = 70  # CS2 sub-tick: header reports 128, effective playback rate ~70
    ct_score  = sum(1 for r in rounds if r["winner_side"] == "ct")
    t_score   = sum(1 for r in rounds if r["winner_side"] == "t")
```

These already recompute correctly after filter — leave as-is. Just confirm they're after the new knife filter block.

- [ ] **Step 5: Wire `_dedupe_grenades` into the grenade pipeline**

Find the existing line (around line 546-548):

```python
    grenades = _parse_grenades(p)
    _add_throw_origins(grenades, shots_df, by_tick, sorted(sampled))
    _build_grenade_paths(grenades, raw_tracks)
```

Replace with:

```python
    grenades = _parse_grenades(p)
    grenades = _dedupe_grenades(grenades)
    _add_throw_origins(grenades, shots_df, by_tick, sorted(sampled))
    _build_grenade_paths(grenades, raw_tracks)
```

- [ ] **Step 6: Delete the `blinds[]` post-hoc estimation block and field**

In `vps/demo_parser.py`, delete lines 552-594 inclusive (the entire block starting with `# CS2 demos don't include player_blind events …` and ending with `print(f"[parser] blinds estimation error: {e}")`). Also delete `blinds = []` (line 558) — gone with the rest.

In the return dict (around line 596-611), remove the `"blinds": blinds,` line.

The return becomes:

```python
    return {
        "meta": {
            "map":         header.get("map_name", ""),
            "tick_rate":   tick_rate,
            "total_ticks": _safe_int(header.get("playback_ticks")),
            "ct_score":    ct_score,
            "t_score":     t_score,
        },
        "rounds":   rounds,
        "frames":   frames,
        "kills":    kills,
        "grenades": grenades,
        "bomb":     bomb,
        "shots":    shots,
    }
```

- [ ] **Step 7: Run all parser tests**

```bash
cd C:/Users/A/Documents/claude/vps && python -m pytest tests/test_parser.py -v
```

Expected: every helper test passes (`_pair_rounds`, `_winner_side`, `_is_warmup`, `_dedupe_grenades`, `_build_grenade_paths`, `_is_knife_round`). Integration tests (gated on `fixture.dem`) skip unless a fixture is present locally.

- [ ] **Step 8: Verify with a real demo (manual integration check)**

If a `.dem` file is available locally:

```bash
cd C:/Users/A/Documents/claude/vps && python test_parse.py path/to/your.dem | head -40
```

Expected: prints meta with non-zero scores, lists rounds with `winner_side` set, no `blinds` key in any frame's debug dump (it shouldn't be referenced). No tracebacks.

If no demo on this box, skip — VPS deploy will be the actual integration test.

- [ ] **Step 9: Commit**

```bash
cd C:/Users/A/Documents/claude && git add vps/demo_parser.py && git commit -m "feat(parser): live cutoff, knife filter, dedupe, Z/pitch/flash_duration, drop blinds[]

- Use latest round_announce_match_start as live_start_tick; rounds before
  it (warmup, restarts) are dropped.
- Server-side knife round filter; recompute meta.ct_score/t_score.
- Dedupe grenades (subtick double-fire); assign synthetic id.
- Add Z, pitch, flash_duration to per-frame player records (engine truth).
- Delete post-hoc blinds[] estimation; engine flash_duration replaces it.
- Wire _build_grenade_paths fix from prior commit into pipeline.

Applies only to demos uploaded after this lands. Old demos retain prior data.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Server — deploy parser to VPS

**Files:**
- None modified. Deployment step.

- [ ] **Step 1: Push the commits to remote**

```bash
cd C:/Users/A/Documents/claude && git push origin master
```

Expected: all four commits land on `origin/master`.

- [ ] **Step 2: Pull and restart on VPS**

The VPS deploy mechanism is project-specific. The standard flow for this repo:

```bash
ssh root@vps.midround.pro 'cd /opt/midround && git pull && systemctl restart midround-parser'
```

If the user doesn't have shell access wired here, surface this command for them to run manually. Do not attempt to deploy autonomously.

- [ ] **Step 3: Smoke test by uploading a fresh demo**

Through the existing UI: log into cs2-hub, upload a small `.dem` file, watch the demo row's status flip from `processing` → `ready`. Open the viewer for that demo. Verify:
- Score in the demo list looks right (no inflated knife rounds).
- Frame players have `z`, `pitch`, `flash_duration` (open browser devtools console: `state.match.frames[0].players[0]` should show those fields).
- Grenades have `id` field: `state.match.grenades[0].id` is a string.
- No `state.match.blinds` (or it's `undefined`).

Stop here if anything looks off — fix before continuing client work.

---

## Task 6: Client — grenade dedupe key prefers `g.id`

**Files:**
- Modify: `cs2-hub/demo-viewer.js:247-253`

- [ ] **Step 1: Update the dedupe block in `renderGrenades`**

In `cs2-hub/demo-viewer.js`, find:

```js
  // Deduplicate grenades by (type, tick, steam_id) — parser can emit duplicate rows
  const seen = new Set()
  const grenades = state.match.grenades.filter(g => {
    const key = `${g.type}:${g.tick}:${g.steam_id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
```

Replace with:

```js
  // Dedupe by stable synthetic id (new demos) or fallback key (old demos)
  const seen = new Set()
  const grenades = state.match.grenades.filter(g => {
    const key = g.id ?? `${g.type}:${g.tick}:${g.steam_id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
```

- [ ] **Step 2: Verify in browser**

Open the viewer for a freshly-uploaded demo (post-server-deploy). Watch a smoke get thrown — it should fly along its arc once, deploy, and stay deployed. No second arc. Old demos should also still render correctly (the fallback key is the original logic).

- [ ] **Step 3: Commit**

```bash
cd C:/Users/A/Documents/claude && git add cs2-hub/demo-viewer.js && git commit -m "fix(viewer): grenade dedupe prefers g.id over (type,tick,steam_id)

Old key required exact tick match; subtick double-fire (~2 tick offset)
escaped the dedupe and rendered two arcs for one logical throw.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Client — remove client-side knife filter

**Files:**
- Modify: `cs2-hub/demo-viewer.js:77-93`

- [ ] **Step 1: Delete the client knife filter block**

In `cs2-hub/demo-viewer.js`, find and delete the entire block from `// Strip knife rounds: …` through `console.log('[viewer] rounds after knife filter:', state.match.rounds.length)`. The deleted lines are 77 to 93 inclusive.

After deletion the surrounding code reads:

```js
if (!state.match.rounds.length) {
  loadingEl.textContent = 'No round data — try re-uploading.'
  throw new Error('no rounds')
}

// Use meta.map from parsed data as source of truth; fall back to DB column
const mapName = state.match.meta?.map || demo.map || ''
```

(The `KNIFE_WEAPONS` set and `tickRate0` declaration go with the block.)

- [ ] **Step 2: Verify in browser**

Open the viewer for a freshly-uploaded demo. The round row should show only competitive rounds (no knife round square at the front). For old demos, the round row may now include knife rounds (they were filtered out client-side before) — that's expected and acceptable per the only-new-uploads rule. Old demos can be re-uploaded if cleanliness matters.

- [ ] **Step 3: Commit**

```bash
cd C:/Users/A/Documents/claude && git add cs2-hub/demo-viewer.js && git commit -m "refactor(viewer): drop client-side knife filter, server now owns it

Server-side parser filters knife rounds before saving match_data, so the
viewer no longer needs to filter on load. Old demos may show knife rounds
until re-uploaded.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Client — auto-play on round click

**Files:**
- Modify: `cs2-hub/demo-viewer.js:185-197`

- [ ] **Step 1: Update `jumpToRound`**

In `cs2-hub/demo-viewer.js`, find the `jumpToRound` function and replace:

```js
function jumpToRound(idx) {
  state.roundIdx  = Math.max(0, Math.min(idx, state.match.rounds.length - 1))
  state.tick      = freezeEnd(currentRound())
  state.playing   = false
  _lastFrameTick  = -1
  _lastRoundIdx   = -1
  _lastKillTick   = -1
  Object.keys(_prevHp).forEach(k => delete _prevHp[k])
  Object.keys(_flashUntil).forEach(k => delete _flashUntil[k])
  updatePlayBtn()
  updateRoundRow()
  updateTimelineKills()
}
```

With:

```js
function jumpToRound(idx) {
  state.roundIdx  = Math.max(0, Math.min(idx, state.match.rounds.length - 1))
  state.tick      = freezeEnd(currentRound())
  state.playing   = true
  state.lastTs    = performance.now()
  _lastFrameTick  = -1
  _lastRoundIdx   = -1
  _lastKillTick   = -1
  Object.keys(_prevHp).forEach(k => delete _prevHp[k])
  Object.keys(_flashUntil).forEach(k => delete _flashUntil[k])
  updatePlayBtn()
  updateRoundRow()
  updateTimelineKills()
}
```

- [ ] **Step 2: Verify in browser**

Open any demo. Click any round square in the round row. Playback should start immediately at the round's freeze-end. Click another round — it should jump and keep playing. The play button should show `⏸` after each click.

- [ ] **Step 3: Commit**

```bash
cd C:/Users/A/Documents/claude && git add cs2-hub/demo-viewer.js && git commit -m "feat(viewer): auto-play when jumping to a round

jumpToRound now sets playing=true and resets lastTs to avoid a giant time
delta on the next loop tick.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Client — flash via engine `flash_duration`

**Files:**
- Modify: `cs2-hub/demo-viewer.js`

- [ ] **Step 1: Add `flashIntensity` helper**

In `cs2-hub/demo-viewer.js`, insert a new helper function immediately above the `// ── Render ───` comment block (around line 645, just before the `function render()` definition):

```js
// Returns 0..1 indicating how blind a player is at the current state.tick.
// New demos: read engine-truth flash_duration off the player frame.
// Old demos: derive from state.match.blinds (legacy fallback).
function flashIntensity(p) {
  if (p.flash_duration != null && p.flash_duration > 0) {
    return Math.max(0, Math.min(1, p.flash_duration / 2.5))
  }
  const tickRate = state.match.meta.tick_rate
  for (const b of (state.match.blinds ?? [])) {
    if (b.steam_id !== p.steam_id) continue
    const totalTicks = Math.round(b.duration * tickRate)
    const until      = b.tick + totalTicks
    if (state.tick >= b.tick && state.tick < until) {
      return Math.max(0, Math.min(1, (until - state.tick) / totalTicks))
    }
  }
  return 0
}
```

- [ ] **Step 2: Replace the `blindUntil` map and player-loop blind logic**

Inside `render()`, find the `// Build active blind map …` block:

```js
    // Build active blind map: steam_id → { until, totalTicks }
    const tickRate   = state.match.meta.tick_rate
    const blindUntil = {}
    for (const b of (state.match.blinds ?? [])) {
      const totalTicks = Math.round(b.duration * tickRate)
      const until      = b.tick + totalTicks
      if (state.tick >= b.tick && state.tick < until) {
        const existing = blindUntil[b.steam_id]
        if (!existing || existing.until < until) {
          blindUntil[b.steam_id] = { until, totalTicks }
        }
      }
    }
```

Replace with:

```js
    const tickRate = state.match.meta.tick_rate
```

(Just keep `tickRate` since downstream code references it. The `blindUntil` map is gone.)

- [ ] **Step 3: Update the player draw loop's blind-ring section**

Inside the player draw loop in `render()`, find the section that uses `blindInfo`:

```js
      const id       = p.steam_id
      const blindInfo = blindUntil[id]

      if (p.hp != null && p.hp > 0) {
        // ... HP arc unchanged
      }

      // Blind ring — shows team colour when dot is white
      if (blindInfo && state.tick < blindInfo.until) {
        const ringR = dotR + 5
        ctx.save()
        ctx.beginPath()
        ctx.arc(x, y, ringR, 0, Math.PI * 2)
        ctx.strokeStyle = playerColor(p.team)
        ctx.lineWidth   = 1.5
        ctx.globalAlpha = 0.7
        ctx.stroke()
        ctx.restore()
      }

      if (state.playing && _prevHp[id] != null && p.hp < _prevHp[id]) {
        _flashUntil[id] = Date.now() + 350
      }
      _prevHp[id] = p.hp
      let color
      if (blindInfo && state.tick < blindInfo.until) {
        const remaining = (blindInfo.until - state.tick) / blindInfo.totalTicks
        const [tr, tg, tb] = p.team === 'ct' ? [79, 195, 247] : [255, 149, 0]
        const fr = Math.round(255 * remaining + tr * (1 - remaining))
        const fg = Math.round(255 * remaining + tg * (1 - remaining))
        const fb = Math.round(255 * remaining + tb * (1 - remaining))
        color = `rgb(${fr},${fg},${fb})`
      } else {
        color = (Date.now() < (_flashUntil[id] ?? 0)) ? '#FF1744' : playerColor(p.team)
      }
```

Replace with:

```js
      const id      = p.steam_id
      const flashI  = flashIntensity(p)
      const blinded = flashI > 0.06

      if (p.hp != null && p.hp > 0) {
        // ... HP arc unchanged — DO NOT delete; this comment marks position only.
      }

      // Blind ring — shows team colour when dot is whitened
      if (blinded) {
        const ringR = dotR + 5
        ctx.save()
        ctx.beginPath()
        ctx.arc(x, y, ringR, 0, Math.PI * 2)
        ctx.strokeStyle = playerColor(p.team)
        ctx.lineWidth   = 1.5
        ctx.globalAlpha = 0.7
        ctx.stroke()
        ctx.restore()
      }

      if (state.playing && _prevHp[id] != null && p.hp < _prevHp[id]) {
        _flashUntil[id] = Date.now() + 350
      }
      _prevHp[id] = p.hp
      let color
      if (blinded) {
        const [tr, tg, tb] = p.team === 'ct' ? [79, 195, 247] : [255, 149, 0]
        const fr = Math.round(255 * flashI + tr * (1 - flashI))
        const fg = Math.round(255 * flashI + tg * (1 - flashI))
        const fb = Math.round(255 * flashI + tb * (1 - flashI))
        color = `rgb(${fr},${fg},${fb})`
      } else {
        color = (Date.now() < (_flashUntil[id] ?? 0)) ? '#FF1744' : playerColor(p.team)
      }
```

(The `// ... HP arc unchanged` line is a placeholder for the existing HP arc block — keep that block intact between the `flashI` line and the blind ring. Don't delete the HP arc.)

- [ ] **Step 4: Verify in browser**

Open the viewer for a freshly-uploaded demo (post-server-deploy). Watch a flash detonate where one player is in line-of-sight and another is behind a corner. The exposed player should briefly turn white-ish with a team-colored ring; the player behind cover should NOT — engine flash_duration is 0 for them.

For old demos: behavior unchanged — still uses `state.match.blinds[]`.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/A/Documents/claude && git add cs2-hub/demo-viewer.js && git commit -m "feat(viewer): use engine-truth flash_duration; fall back to blinds[] for old demos

flashIntensity(p) reads p.flash_duration (engine-computed, accounts for LOS,
view angle, walls). Old demos parsed before flash_duration was emitted fall
back to the legacy blinds[] estimation.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Client — setpos copy on click (cards + canvas + toast)

**Files:**
- Modify: `cs2-hub/demo-viewer.js`
- Modify: `cs2-hub/demo-viewer.html` (style block)

- [ ] **Step 1: Add cursor + hover CSS for player cards**

In `cs2-hub/demo-viewer.html`, find the existing `.player-card { ... }` rule in the `<style>` block. Append after that rule:

```css
.player-card { cursor: pointer; }
.player-card:hover { background: rgba(102,102,183,0.12); }
```

(If `.player-card` already has `cursor: pointer`, only add the hover rule. The existing rule today doesn't have `cursor`.)

- [ ] **Step 2: Add `data-steam-id` to the player card root in `playerCardHTML`**

In `cs2-hub/demo-viewer.js`, find both branches of `playerCardHTML` (alive and dead) and add `data-steam-id="${esc(p.steam_id)}"` to the root `<div class="player-card …">`.

Dead branch — find:
```js
    return `<div class="player-card dead">
```
Replace with:
```js
    return `<div class="player-card dead" data-steam-id="${esc(p.steam_id)}">
```

Alive branch — find:
```js
  return `<div class="player-card">
```
Replace with:
```js
  return `<div class="player-card" data-steam-id="${esc(p.steam_id)}">
```

- [ ] **Step 3: Add `copySetposFor` and `showSetposToast` helpers**

In `cs2-hub/demo-viewer.js`, insert immediately after the `playerCardHTML` function (right before `function updatePlayerCards()`):

```js
function copySetposFor(steamId) {
  const frame = getInterpolatedFrame(state.tick)
  if (!frame) return
  const p = frame.players.find(pl => pl.steam_id === steamId)
  if (!p) return
  const cmd = (p.z != null && p.pitch != null && (p.z !== 0 || p.pitch !== 0))
    ? `setpos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}; setang ${p.pitch.toFixed(1)} ${p.yaw.toFixed(1)} 0`
    : `setpos ${p.x.toFixed(1)} ${p.y.toFixed(1)}; setang 0 ${p.yaw.toFixed(1)} 0`
  navigator.clipboard.writeText(cmd)
    .then(() => showSetposToast(p.name))
    .catch(err => console.warn('clipboard write failed:', err))
}

function showSetposToast(playerName) {
  let toast = document.getElementById('setpos-toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'setpos-toast'
    toast.style.cssText = `
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      background: rgba(3,7,18,0.92); color: #fff; padding: 9px 16px;
      border: 1px solid rgba(102,102,183,0.45); border-radius: 8px;
      font: 600 12px Inter, system-ui, sans-serif; z-index: 1000;
      pointer-events: none; transition: opacity 0.2s; opacity: 0;
    `
    document.body.appendChild(toast)
  }
  toast.textContent = `Setpos copied — ${playerName}`
  toast.style.opacity = '1'
  clearTimeout(toast._hideTimer)
  toast._hideTimer = setTimeout(() => { toast.style.opacity = '0' }, 1500)
}
```

- [ ] **Step 4: Wire delegated click on the two player panels**

In `cs2-hub/demo-viewer.js`, find the `// ── Controls ──` section (around line 1194). Insert just before that comment block:

```js
// ── Player click → copy setpos ────────────────────────────────
for (const panelId of ['ct-panel', 't-panel']) {
  document.getElementById(panelId).addEventListener('click', e => {
    const card = e.target.closest('.player-card')
    if (!card) return
    const sid = card.dataset.steamId
    if (sid) copySetposFor(sid)
  })
}
```

- [ ] **Step 5: Wire canvas click → setpos (hit-test player dots)**

In `cs2-hub/demo-viewer.js`, find the existing `canvas.addEventListener('mousedown', ...)` block (around line 1251). Replace it with:

```js
canvas.addEventListener('mousedown', e => {
  if (drawingMode) {
    currentPath = { color: DRAW_COLORS[drawColorIdx], points: [getMapPos(e)] }
    return
  }
  // Hit-test player dots → copy setpos
  const frame = getInterpolatedFrame(state.tick)
  if (!frame) return
  const rect = canvas.getBoundingClientRect()
  const sx   = (e.clientX - rect.left) * (canvas.width  / rect.width)
  const sy   = (e.clientY - rect.top)  * (canvas.height / rect.height)
  const cw = canvas.width, ch = canvas.height
  const mapSize = Math.min(cw, ch)
  const mapX    = (cw - mapSize) / 2
  const mapY    = (ch - mapSize) / 2
  // screen → unzoomed canvas coords
  const ux = (sx - cw / 2 - mapPanX) / mapZoom + cw / 2
  const uy = (sy - ch / 2 - mapPanY) / mapZoom + ch / 2
  const dotR = Math.round(mapSize * 0.009)
  const hitR = dotR + 6
  for (const p of frame.players) {
    if (!p.is_alive) continue
    const { x, y } = worldToCanvas(p.x, p.y, mapName, mapSize, mapSize)
    const px = x + mapX, py = y + mapY
    if ((ux - px) ** 2 + (uy - py) ** 2 <= hitR * hitR) {
      copySetposFor(p.steam_id)
      return
    }
  }
})
```

- [ ] **Step 6: Verify in browser**

Open any demo. Click a player's card in the side panel — toast appears: `Setpos copied — Player Name`. Open clipboard somewhere; for new demos the command should be `setpos X Y Z; setang pitch yaw 0`. For old demos (no `z`/`pitch`), it should be `setpos X Y; setang 0 yaw 0`.

Click directly on a player's dot on the map (when not in draw mode). Same behavior.

Press D to enter draw mode, click on map — should draw, NOT copy setpos.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/A/Documents/claude && git add cs2-hub/demo-viewer.js cs2-hub/demo-viewer.html && git commit -m "feat(viewer): click player to copy setpos command

Click a player card or their dot on the map to copy a setpos+setang console
command. New demos copy full Z + pitch; old demos fall back to X/Y/yaw only.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: Client — roster detection helper for team modal

**Files:**
- Modify: `cs2-hub/demos.js`

- [ ] **Step 1: Add `detectRosters` helper at the top of `demos.js`**

In `cs2-hub/demos.js`, insert immediately after the `formatDate` line (line 8):

```js
// Detect two 5-player rosters across one or more demos in a series.
// Returns { rosterA: [{steam_id, name}, ...], rosterB: [...], confident: bool }.
// rosterA = first-frame CT players of map 1 (earliest by created_at).
// rosterB = first-frame T players of map 1.
// confident=false if a subsequent map's CT side is not a subset of either roster
// (e.g. mid-series substitution) — caller should fall back to legacy by-side flow.
function detectRosters(demos) {
  if (!demos.length) return { rosterA: [], rosterB: [], confident: false }
  const sorted = [...demos].sort((a, b) =>
    (a.created_at || '').localeCompare(b.created_at || '')
  )
  const m1 = sorted[0]
  const f0 = m1?.match_data?.frames?.[0]
  if (!f0) return { rosterA: [], rosterB: [], confident: false }
  const rosterA = f0.players.filter(p => p.team === 'ct').map(p => ({ steam_id: p.steam_id, name: p.name }))
  const rosterB = f0.players.filter(p => p.team === 't').map(p => ({ steam_id: p.steam_id, name: p.name }))
  const idsA = new Set(rosterA.map(p => p.steam_id))
  const idsB = new Set(rosterB.map(p => p.steam_id))
  let confident = (rosterA.length === 5 && rosterB.length === 5)
  for (const d of sorted.slice(1)) {
    const fr = d?.match_data?.frames?.[0]
    if (!fr) continue
    const ctIds = fr.players.filter(p => p.team === 'ct').map(p => p.steam_id)
    const tIds  = fr.players.filter(p => p.team === 't').map(p => p.steam_id)
    const ctMatchesA = ctIds.every(id => idsA.has(id))
    const ctMatchesB = ctIds.every(id => idsB.has(id))
    if (!ctMatchesA && !ctMatchesB) {
      confident = false
      console.warn('[demos] roster detection: map', d.id, 'has mixed roster — falling back')
      break
    }
  }
  return { rosterA, rosterB, confident }
}

// Decide which name goes on which side for a given demo's first frame,
// given the roster→name mapping.
function namesForDemo(demo, rosterA, rosterB, nameA, nameB) {
  const fr = demo?.match_data?.frames?.[0]
  if (!fr) return { ct_team_name: null, t_team_name: null }
  const idsA = new Set(rosterA.map(p => p.steam_id))
  const ctIds = fr.players.filter(p => p.team === 'ct').map(p => p.steam_id)
  const ctIsA = ctIds.length > 0 && ctIds.every(id => idsA.has(id))
  return ctIsA
    ? { ct_team_name: nameA, t_team_name: nameB }
    : { ct_team_name: nameB, t_team_name: nameA }
}
```

- [ ] **Step 2: Verify in browser console (smoke test)**

Open `demos.html` in the browser, then in the devtools console paste a tiny synthetic check:

```js
detectRosters([{
  created_at: '2026-04-01',
  match_data: { frames: [{ players: [
    { team: 'ct', steam_id: '1', name: 'a' },
    { team: 'ct', steam_id: '2', name: 'b' },
    { team: 'ct', steam_id: '3', name: 'c' },
    { team: 'ct', steam_id: '4', name: 'd' },
    { team: 'ct', steam_id: '5', name: 'e' },
    { team: 't',  steam_id: '6', name: 'f' },
    { team: 't',  steam_id: '7', name: 'g' },
    { team: 't',  steam_id: '8', name: 'h' },
    { team: 't',  steam_id: '9', name: 'i' },
    { team: 't',  steam_id: '10', name: 'j' },
  ] }] }
}])
```

Expected: `{ rosterA: [5 names], rosterB: [5 names], confident: true }`. If `detectRosters` is undefined (export issue), check that the function is at module scope.

- [ ] **Step 3: Commit**

```bash
cd C:/Users/A/Documents/claude && git add cs2-hub/demos.js && git commit -m "feat(demos): detectRosters and namesForDemo helpers

Roster A = first-frame CT of map 1, Roster B = first-frame T of map 1.
Validates remaining maps; flags mixed-roster series for legacy-modal fallback.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: Client — roster-based assign-teams modal

**Files:**
- Modify: `cs2-hub/demos.js:24-111` (the `showAssignTeamsModal` function)

- [ ] **Step 1: Replace `showAssignTeamsModal`**

In `cs2-hub/demos.js`, replace the entire `showAssignTeamsModal` function (lines 24-111) with:

```js
// Assign Teams modal — roster-based.
// Argument is either a single demo id (legacy), or an array of demos that
// share a series (the trigger gates this).
async function showAssignTeamsModal(demoIdOrSeries) {
  // Normalise to a list of demos with match_data.
  let demos = []
  if (Array.isArray(demoIdOrSeries)) {
    demos = demoIdOrSeries
  } else {
    const { data: d, error } = await supabase
      .from('demos')
      .select('id,series_id,match_data,ct_team_name,t_team_name,created_at')
      .eq('id', demoIdOrSeries)
      .single()
    if (error || !d) { alert('Could not load demo data.'); return }
    if (d.series_id) {
      const { data: sib } = await supabase
        .from('demos')
        .select('id,series_id,match_data,ct_team_name,t_team_name,created_at')
        .eq('series_id', d.series_id)
        .order('created_at', { ascending: true })
      demos = sib || [d]
    } else {
      demos = [d]
    }
  }
  if (!demos.length || !demos[0].match_data) { alert('No demo data.'); return }

  const { rosterA, rosterB, confident } = detectRosters(demos)
  if (!confident) {
    alert('Mixed roster across maps — falling back to per-map team assignment.')
    return showLegacyBySideModal(demos[0].id)
  }

  // Pre-fill names from existing data: look at map 1's saved names + side mapping.
  const m1 = demos[0]
  const m1Names = namesForDemo(m1, rosterA, rosterB, 'A', 'B')
  // m1Names.ct_team_name is 'A' if Roster A was on CT in map 1, else 'B'.
  const aSavedSide = m1Names.ct_team_name === 'A' ? 'ct' : 't'
  const initialA = aSavedSide === 'ct' ? (m1.ct_team_name ?? '') : (m1.t_team_name ?? '')
  const initialB = aSavedSide === 'ct' ? (m1.t_team_name ?? '') : (m1.ct_team_name ?? '')

  function rosterPanel(label, players, accent) {
    const lines = players.map(p =>
      `<div style="font-size:11px;color:${accent};padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>`
    ).join('')
    return `
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.10);border-radius:8px;padding:12px">
        <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.55);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">${label}</div>
        ${lines || '<span style="color:#444;font-size:11px">No players found</span>'}
      </div>`
  }

  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:1000;
      display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);
    `
    overlay.innerHTML = `
      <div style="
        background:#0a0a0f;border:1px solid rgba(102,102,183,0.22);border-radius:14px;
        padding:28px 32px;width:520px;max-width:94vw;
        box-shadow:0 0 40px rgba(102,102,183,0.12);
      ">
        <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px">Assign Teams</div>
        <div style="font-size:11px;color:#666;margin-bottom:20px">${demos.length > 1 ? `Applies to all ${demos.length} maps in this series.` : 'Applies to this map.'}</div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
          ${rosterPanel('Roster A', rosterA, '#bbb')}
          ${rosterPanel('Roster B', rosterB, '#bbb')}
        </div>

        <div style="margin-bottom:14px">
          <label style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.55);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">Roster A team name</label>
          <input id="modal-a-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(initialA)}">
        </div>
        <div style="margin-bottom:28px">
          <label style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.55);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">Roster B team name</label>
          <input id="modal-b-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(initialB)}">
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button id="modal-cancel" class="btn btn-ghost">Cancel</button>
          <button id="modal-save" class="btn btn-primary">Save</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    let nameA = initialA
    let nameB = initialB

    attachTeamAutocomplete(overlay.querySelector('#modal-a-input'), t => { nameA = t.name })
    attachTeamAutocomplete(overlay.querySelector('#modal-b-input'), t => { nameB = t.name })
    overlay.querySelector('#modal-a-input').addEventListener('input', e => { nameA = e.target.value })
    overlay.querySelector('#modal-b-input').addEventListener('input', e => { nameB = e.target.value })

    overlay.querySelector('#modal-cancel').addEventListener('click', () => { overlay.remove(); resolve(null) })
    overlay.querySelector('#modal-save').addEventListener('click', async () => {
      const updates = []
      for (const d of demos) {
        const names = namesForDemo(d, rosterA, rosterB, nameA, nameB)
        updates.push(supabase.from('demos').update({
          ct_team_name: names.ct_team_name || null,
          t_team_name:  names.t_team_name  || null,
        }).eq('id', d.id))
      }
      await Promise.all(updates)
      overlay.remove()
      resolve({ nameA, nameB })
      loadDemos()
    })
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null) } })
  })
}

// Legacy by-side modal — used as a fallback when roster detection fails.
async function showLegacyBySideModal(demoId) {
  const { data, error } = await supabase
    .from('demos')
    .select('match_data,ct_team_name,t_team_name')
    .eq('id', demoId)
    .single()
  if (error || !data?.match_data) { alert('Could not load demo data.'); return null }
  const firstFrame = data.match_data.frames?.[0]
  const ctPlayers  = (firstFrame?.players ?? []).filter(p => p.team === 'ct').map(p => p.name)
  const tPlayers   = (firstFrame?.players ?? []).filter(p => p.team === 't').map(p => p.name)

  function playerList(names, color) {
    if (!names.length) return '<span style="color:#444;font-size:11px">No players found</span>'
    return names.map(n =>
      `<div style="font-size:11px;color:${color};padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(n)}</div>`
    ).join('')
  }

  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:1000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);`
    overlay.innerHTML = `
      <div style="background:#0a0a0f;border:1px solid rgba(102,102,183,0.22);border-radius:14px;padding:28px 32px;width:480px;max-width:94vw;box-shadow:0 0 40px rgba(102,102,183,0.12);">
        <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:20px">Assign Teams (per-side)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
          <div style="background:rgba(79,195,247,0.05);border:1px solid rgba(79,195,247,0.14);border-radius:8px;padding:12px">
            <div style="font-size:10px;font-weight:700;color:rgba(79,195,247,0.7);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">CT Side</div>
            ${playerList(ctPlayers, '#4FC3F7')}
          </div>
          <div style="background:rgba(255,149,0,0.05);border:1px solid rgba(255,149,0,0.14);border-radius:8px;padding:12px">
            <div style="font-size:10px;font-weight:700;color:rgba(255,149,0,0.7);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">T Side</div>
            ${playerList(tPlayers, '#FF9500')}
          </div>
        </div>
        <div style="margin-bottom:14px"><label style="font-size:10px;font-weight:700;color:rgba(79,195,247,0.7);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">CT Team Name</label><input id="legacy-ct-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(data.ct_team_name ?? '')}"></div>
        <div style="margin-bottom:28px"><label style="font-size:10px;font-weight:700;color:rgba(255,149,0,0.7);letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">T Team Name</label><input id="legacy-t-input" class="input" placeholder="Search team…" autocomplete="off" style="width:100%" value="${esc(data.t_team_name ?? '')}"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end"><button id="legacy-cancel" class="btn btn-ghost">Cancel</button><button id="legacy-save" class="btn btn-primary">Save</button></div>
      </div>`
    document.body.appendChild(overlay)
    let ct = data.ct_team_name ?? '', t = data.t_team_name ?? ''
    attachTeamAutocomplete(overlay.querySelector('#legacy-ct-input'), x => { ct = x.name })
    attachTeamAutocomplete(overlay.querySelector('#legacy-t-input'),  x => { t  = x.name })
    overlay.querySelector('#legacy-ct-input').addEventListener('input', e => { ct = e.target.value })
    overlay.querySelector('#legacy-t-input').addEventListener('input',  e => { t  = e.target.value })
    overlay.querySelector('#legacy-cancel').addEventListener('click', () => { overlay.remove(); resolve(null) })
    overlay.querySelector('#legacy-save').addEventListener('click', async () => {
      await supabase.from('demos').update({
        ct_team_name: ct || null,
        t_team_name:  t  || null,
      }).eq('id', demoId)
      overlay.remove()
      resolve({ ct, t })
      loadDemos()
    })
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null) } })
  })
}
```

- [ ] **Step 2: Verify modal opens with rosters**

Run the dev server (or open `demos.html` directly). Click `+ Teams` on a single ready demo. Modal should now show `Roster A` / `Roster B` panels (not CT/T side), each with 5 players. The two inputs are labelled `Roster A team name` / `Roster B team name`. Save writes the right name to ct/t per-map.

For a BO3 series demo, click `+ Teams` on any map row — modal should show "Applies to all N maps in this series." Save updates every map.

- [ ] **Step 3: Commit**

```bash
cd C:/Users/A/Documents/claude && git add cs2-hub/demos.js && git commit -m "feat(demos): roster-based assign-teams modal

Modal now binds team names to 5-player rosters detected from first-frame
steam ids, not to CT/T sides. For BO3 series, one save updates every map
correctly accounting for half-time swaps and per-map side flips. Falls back
to a legacy by-side modal when rosters can't be cleanly determined.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 13: Client — gate modal trigger on series-completeness

**Files:**
- Modify: `cs2-hub/demos.js`

- [ ] **Step 1: Replace the realtime subscription with completeness gating**

In `cs2-hub/demos.js`, find the realtime subscription:

```js
supabase.channel('demos-status')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'demos', filter: `team_id=eq.${teamId}` }, () => loadDemos())
  .subscribe()

window.assignTeams = id => showAssignTeamsModal(id)
```

Replace with:

```js
supabase.channel('demos-status')
  .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'demos', filter: `team_id=eq.${teamId}` },
      payload => {
        loadDemos()
        maybeAutoOpenAssignModal(payload.new)
      })
  .subscribe()

// Track which series/demos we've already auto-opened a modal for, so we
// don't pop it twice if the realtime event re-fires.
const _autoModalShown = new Set()

async function maybeAutoOpenAssignModal(updated) {
  if (!updated || updated.status !== 'ready') return
  if (updated.ct_team_name && updated.t_team_name) return  // already named

  if (updated.series_id) {
    if (_autoModalShown.has(updated.series_id)) return
    const { data: sib } = await supabase
      .from('demos')
      .select('id,series_id,match_data,ct_team_name,t_team_name,created_at,status')
      .eq('series_id', updated.series_id)
      .order('created_at', { ascending: true })
    if (!sib?.length) return
    if (sib.some(d => d.status !== 'ready')) return  // wait until all done
    if (sib.some(d => d.ct_team_name && d.t_team_name)) {
      _autoModalShown.add(updated.series_id)
      return
    }
    _autoModalShown.add(updated.series_id)
    showAssignTeamsModal(sib)
  } else {
    if (_autoModalShown.has(updated.id)) return
    _autoModalShown.add(updated.id)
    showAssignTeamsModal(updated.id)
  }
}

window.assignTeams = id => showAssignTeamsModal(id)
```

- [ ] **Step 2: Verify trigger gating**

Upload a single demo. Status flips to `ready` → modal pops with one map's rosters.

Upload a 3-map BO3 (use the existing multi-file flow). As each map flips to `ready` the modal does NOT pop until the third map is also `ready` — then one modal pops with the trigger group of all 3.

After save, refresh the page and re-trigger the realtime channel — the modal should NOT pop again (`_autoModalShown` guard, plus `ct_team_name && t_team_name` check).

- [ ] **Step 3: Commit**

```bash
cd C:/Users/A/Documents/claude && git add cs2-hub/demos.js && git commit -m "feat(demos): auto-open assign-teams modal on series completion

For singles, opens immediately on ready. For BO3 series, waits until every
map is ready before opening once with all maps in scope. Skips if names are
already set.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 14: Final verification

**Files:**
- None modified.

- [ ] **Step 1: Run the full parser test suite**

```bash
cd C:/Users/A/Documents/claude/vps && python -m pytest tests/test_parser.py -v
```

Expected: every helper test passes; integration tests skip if no fixture.

- [ ] **Step 2: Browser smoke test — old demo (regression check)**

Open the viewer for a demo uploaded *before* the parser changes deployed. Verify:
- Round row shows competitive rounds (knife rounds may now appear since the client filter is gone — acceptable per scope).
- Grenade rendering looks unchanged (uses fallback dedupe key).
- Flash blinds use the legacy `blinds[]` array (intensity may be over- or under- estimated — known behavior, gated to old demos).
- Click a player card → toast appears, clipboard contains a partial `setpos X Y; setang 0 yaw 0`.
- Click a round → playback starts immediately.

- [ ] **Step 3: Browser smoke test — fresh demo (post-server-deploy)**

Upload a small `.dem`. After processing finishes:
- Demo list shows score (no inflated knife rounds).
- Modal pops automatically (single map). Or if uploaded as BO3, only after every map is ready.
- Save names → demo list reflects them.
- Open the viewer:
  - Devtools: `state.match.frames[0].players[0]` has `z`, `pitch`, `flash_duration`.
  - Devtools: `state.match.grenades[0].id` is a string. `state.match.blinds` is undefined.
  - Watch a smoke get thrown — exactly one arc, one deploy, no replay.
  - Watch a flash detonate near a corner — players in LOS turn white-ish; players behind the corner do not.
  - Click a player card → clipboard contains full `setpos X Y Z; setang pitch yaw 0`.
  - Click a round square → playback starts immediately.

- [ ] **Step 4: Browser smoke test — drop / pickup**

Find a round in a fresh demo where a player picks up a teammate's grenade and throws it. Verify the second throw renders correctly (arc + deployed effect). Verify the inventory pill row on the player card flips to `empty` after the throw and back to filled if they pick up another.

- [ ] **Step 5: Push everything**

```bash
cd C:/Users/A/Documents/claude && git push origin master
```

- [ ] **Step 6: Final commit (if any drift discovered)**

If any of the verification steps surfaced a drift between plan and implementation, fix it inline and commit:

```bash
cd C:/Users/A/Documents/claude && git add <files> && git commit -m "fix(viewer): <what was off>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

If everything checked out: no commit needed.

---

## Summary of commits

The plan produces these commits (in order):

1. `feat(parser): add _dedupe_grenades helper with synthetic ids`
2. `fix(parser): match grenade paths by type+proximity, not (steam_id,type)`
3. `feat(parser): add _is_knife_round helper`
4. `feat(parser): live cutoff, knife filter, dedupe, Z/pitch/flash_duration, drop blinds[]`
5. `fix(viewer): grenade dedupe prefers g.id over (type,tick,steam_id)`
6. `refactor(viewer): drop client-side knife filter, server now owns it`
7. `feat(viewer): auto-play when jumping to a round`
8. `feat(viewer): use engine-truth flash_duration; fall back to blinds[] for old demos`
9. `feat(viewer): click player to copy setpos command`
10. `feat(demos): detectRosters and namesForDemo helpers`
11. `feat(demos): roster-based assign-teams modal`
12. `feat(demos): auto-open assign-teams modal on series completion`

(13th commit only if final verification surfaces drift.)
