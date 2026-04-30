# Demo Viewer Quick Fixes — Design Spec

**Date:** 2026-04-30
**Scope:** `cs2-hub/demo-viewer.js`, `cs2-hub/demo-viewer.html`, `cs2-hub/demos.js`, `vps/demo_parser.py`, `vps/main.py`

---

## Goals

Fix seven bugs / small UX gaps in the existing demo viewer, in two ship bundles:

1. Team-name assignment is sided, per-map, and breaks across BO3 series and half-time swaps.
2. Some grenades render their throw arc twice (subtick double-fire).
3. When a player throws a picked-up grenade after their own, the second one sometimes doesn't render at all (path-matching collision).
4. Round processing includes warmup / knife / pre-restart rounds → wrong final score.
5. No way to copy `setpos` from a player.
6. Round click pauses playback — should auto-play.
7. Flash blind state is post-hoc estimated, ignoring line-of-sight and exact engine state.

**Non-goals (separate specs later):** Multi-round analysis tool. HLTV public demo database.

---

## Out-of-band decisions

These decisions were settled in brainstorming and apply to the whole spec:

- **Old demos stay as-is.** All parser-side fixes apply only to demos uploaded *after* this lands. No batch re-parse. The existing per-row "Retry" button (already in `demos.js`) provides on-demand re-upload if a user wants old demos refreshed.
- **Setpos Z + pitch:** added to the parser, only-new-uploads benefit. Old demos fall back to a partial `setpos X Y; setang 0 yaw 0`.
- **No schema changes** beyond what's already implied (no new columns).

---

## 1. Team-name assignment by roster (BO3-aware)

### Problem

Today's `showAssignTeamsModal` (`cs2-hub/demos.js`) shows the players grouped by **first-frame side** (CT / T) and saves `ct_team_name` and `t_team_name` per-map. Two consequences:

- After the half-time swap, the side labels invert; the saved per-side name becomes wrong if interpreted as "this team is CT".
- For BO3 series, the user has to fill the modal three times — once per map — even though the team rosters are identical.

### Fix

Bind team names to **rosters** (5 steam IDs each), not to sides. Show one modal for the whole series.

### Trigger

The realtime subscription in `demos.js` listens for status `UPDATE` on the demos table. Add: when a demo flips to `ready`:

- If `series_id IS NULL` (single map): trigger immediately for that demo.
- If `series_id IS NOT NULL`: query the series. Trigger only when **every demo in the series has `status = 'ready'`** (i.e. the *last* one just finished). If any of the series demos already has both `ct_team_name` and `t_team_name` set, skip the trigger (already assigned).

### Roster detection

Given the set of demos in the trigger group (1 demo for singles, all maps for series):

1. Sort demos in the trigger group by `created_at` ascending. Map 1 = earliest.
2. For each demo, take `match_data.frames[0].players[]`. Each player has `steam_id`, `name`, and a `team` ('ct' or 't' at frame 0).
3. Group the 10 steam IDs into two rosters of 5 each:
   - Roster A = first-frame CT players of map 1.
   - Roster B = first-frame T players of map 1.
4. Validation pass over remaining maps: for each subsequent map's first frame, the 5 CT IDs must be a subset of either roster A or roster B. If not (mixed roster — e.g. substitution mid-series), fall back to the legacy by-side modal for that map only and log a console warning.

### Modal UI

Replace today's "CT Side" / "T Side" panels with "Roster A" / "Roster B" panels. Same visual layout — two panels side-by-side, one input each.

```
┌─────────────────────────────────────┐
│  Assign Teams                       │
│                                     │
│  ┌──────────────┐ ┌──────────────┐  │
│  │ Roster A     │ │ Roster B     │  │
│  │ • Player 1   │ │ • Player 6   │  │
│  │ • Player 2   │ │ • Player 7   │  │
│  │ • Player 3   │ │ • Player 8   │  │
│  │ • Player 4   │ │ • Player 9   │  │
│  │ • Player 5   │ │ • Player 10  │  │
│  └──────────────┘ └──────────────┘  │
│                                     │
│  Roster A team name: [_________]    │
│  Roster B team name: [_________]    │
│                                     │
│           [Cancel]  [Save]          │
└─────────────────────────────────────┘
```

The "CT Side" / "T Side" colour accents on the panels are dropped (rosters aren't sided).

### Save logic

On Save:
- For every demo in the trigger group, look at `match_data.frames[0].players[]`. Determine which roster has the 5 CT steam IDs at frame 0. Set:
  - `ct_team_name = <that roster's saved name>`
  - `t_team_name = <other roster's saved name>`
- Issue a single `update().in('id', [demoIds])` per name (or two updates total — one per roster) so all maps update atomically.
- After save, refresh `loadDemos()`.

### Edit later

The existing `+ Teams` / `✎ Teams` button on the demo row remains. Clicking it re-opens the same roster-based modal scoped to that demo's series (or the demo itself if no series).

### Files changed

| File | Change |
|---|---|
| `cs2-hub/demos.js` | Replace `showAssignTeamsModal` body. Add `detectRosters(demoMatchData[])` helper. Update realtime trigger to gate on series-completeness. Update `assignTeams(id)` global to invoke the new modal scoped to the demo's series. |

---

## 2. Smoke "thrown twice" + grenade dedupe

### Problem

Subtick framework can fire `smokegrenade_detonate` (and `flashbang_detonate`, etc.) twice for the same projectile, with ticks differing by 1-2. The current client-side dedupe key `${g.type}:${g.tick}:${g.steam_id}` requires exact tick match, so both pass through. The first row deploys the smoke at tick T1; the second row's `inFlight` window covers `origin_tick → T2` (T2 ≈ T1+2), so for those few frames the user sees a smoke deployed AND a second arc still flying alongside it.

### Fix — server side

In `vps/demo_parser.py`, after `_parse_grenades` returns, run a merge pass:

```python
def _dedupe_grenades(grenades: list) -> list:
    grenades = sorted(grenades, key=lambda g: (g.get("steam_id", ""), g["type"], g["tick"]))
    out = []
    for g in grenades:
        # Merge into previous if same player, same type, near in time and space
        if out:
            prev = out[-1]
            if (prev.get("steam_id") == g.get("steam_id")
                    and prev["type"] == g["type"]
                    and abs(prev["tick"] - g["tick"]) <= 64
                    and (prev["x"] - g["x"]) ** 2 + (prev["y"] - g["y"]) ** 2 < 300 ** 2):
                continue  # keep earlier (already in `out`)
        out.append(g)
    return out
```

Assign a stable synthetic id to each surviving grenade:

```python
for i, g in enumerate(out):
    g["id"] = f"{g['type']}-{g['tick']}-{g.get('steam_id', '')}-{i}"
```

This runs **before** `_add_throw_origins` and `_build_grenade_paths` so those steps work off the deduped set.

### Fix — client side

In `cs2-hub/demo-viewer.js` `renderGrenades`, replace the dedupe block:

```js
// Before:
const seen = new Set()
const grenades = state.match.grenades.filter(g => {
  const key = `${g.type}:${g.tick}:${g.steam_id}`
  if (seen.has(key)) return false
  seen.add(key)
  return true
})

// After:
const seen = new Set()
const grenades = state.match.grenades.filter(g => {
  const key = g.id ?? `${g.type}:${g.tick}:${g.steam_id}`
  if (seen.has(key)) return false
  seen.add(key)
  return true
})
```

Old demos without `g.id` still use the legacy key (their already-baked grenade lists may still show the bug; acceptable per the only-new-uploads rule).

### Files changed

| File | Change |
|---|---|
| `vps/demo_parser.py` | Add `_dedupe_grenades` helper. Call after `_parse_grenades`, before `_add_throw_origins`. Assign `g["id"]` to each survivor. |
| `cs2-hub/demo-viewer.js` | Update dedupe key in `renderGrenades` to prefer `g.id`. |

---

## 3. Drop / pickup of utility

### Problem A: second grenade from same player doesn't render

`_build_grenade_paths` keys on `(steam_id, type)` and consumes one Go-binary track per match. When a player throws a smoke they had, then later throws a smoke they picked up off the ground, both grenades hash to the same `(steam_id, "smoke")` bucket. The consumed-set logic uses absolute distance to det_tick, so under bad ordering the algorithm can leave the second grenade with no path AND consume the wrong throw — the second smoke ends up with no `origin_tick` / `path`, and rendering can fail entirely if it also has bad coords.

### Fix

Change the match key from `(steam_id, type)` to `type` only. Steam ID becomes a tiebreaker. Match each grenade to the **closest unconsumed** track of the same type (within `±256` ticks); if multiple tracks tie, prefer the one whose `steam_id` matches the grenade's. This handles same-player-multiple-throws AND picked-up-from-other-player cases uniformly.

```python
def _build_grenade_paths(grenades, raw_tracks) -> None:
    if not raw_tracks:
        return
    by_type = defaultdict(list)
    for t in raw_tracks:
        by_type[t["type"]].append(t)
    for lst in by_type.values():
        lst.sort(key=lambda t: t["throw_tick"])

    consumed = defaultdict(set)
    for g in sorted(grenades, key=lambda x: x["tick"]):
        candidates = by_type.get(g["type"], [])
        best, best_i = None, None
        for i, t in enumerate(candidates):
            if i in consumed[g["type"]]:
                continue
            d = abs(t["det_tick"] - g["tick"])
            if d >= 256:
                continue
            same_thrower = (t["steam_id"] == g.get("steam_id", ""))
            # Prefer same thrower; among same-thrower, prefer closest tick.
            # Fall back to any thrower if no same-thrower track is close.
            score = (0 if same_thrower else 1, d)
            if best is None or score < best_score:
                best, best_i, best_score = t, i, score
        if best is not None:
            consumed[g["type"]].add(best_i)
            # ... existing path / origin assignment unchanged
```

### Problem B: inventory pills appear "stuck"

The parser samples player inventory every `SAMPLE_RATE = 16` ticks (~0.25 s at 64 Hz playback). A drop-then-pickup that completes inside a single sample window is invisible. This is acceptable — the user reported pills look stuck, but in the cases that matter (player has the smoke, throws it, no longer has it; or player picks up a new smoke and pulls pin) the next sample reflects the change correctly. **No change** to inventory parsing.

### Files changed

| File | Change |
|---|---|
| `vps/demo_parser.py` | Rewrite `_build_grenade_paths` to key on type-only with steam_id tiebreaker. |

---

## 4. Round processing — restart / warmup / knife / score

### Problem

`_pair_rounds` in `vps/demo_parser.py` filters warmup (`< 500 ticks`) and unknown winners but doesn't account for:

- Mid-match `mp_restartgame`: every round before the restart is included in the final round list, inflating score.
- Knife rounds: filtered client-side in `demo-viewer.js` (lines 78-92), but `meta.ct_score` / `meta.t_score` (and the `demos.score_ct` / `demos.score_t` columns derived from them in `vps/main.py`) include knife rounds → wrong score in the demo list and series header.

### Fix — server side, in `vps/demo_parser.py`

After `pairs = _pair_rounds(...)`, before the round-build loop, compute a `live_start_tick` cutoff:

```python
try:
    match_start_ticks = sorted(
        _safe_int(r.get("tick"))
        for r in _to_records(p.parse_event("round_announce_match_start"))
        if _safe_int(r.get("tick")) > 0
    )
except Exception:
    match_start_ticks = []

# Use the LATEST match-start announcement as the live cutoff.
# Handles mp_restartgame: every restart re-emits round_announce_match_start.
live_start_tick = match_start_ticks[-1] if match_start_ticks else 0
```

In the round-build loop, after `_is_warmup` / `winner is None` filters, add:

```python
if pair["start_tick"] < live_start_tick:
    print(f"[parser] skip pre-live round at {pair['start_tick']} (live starts at {live_start_tick})")
    continue
```

Then add a knife-round filter immediately after the loop:

```python
KNIFE_WEAPONS = {"knife", "knifegg", "knife_t", "knife_ct"}  # internal names
def _is_knife_round(r, kills, tick_rate):
    duration_s = (r["end_tick"] - r["start_tick"]) / tick_rate
    if duration_s > 75:
        return False
    round_kills = [k for k in kills if r["start_tick"] <= k["tick"] <= r["end_tick"]]
    has_gun_kill = any(
        (k["weapon"] or "").lower().replace("weapon_", "") not in KNIFE_WEAPONS
        and k["weapon"]
        for k in round_kills
    )
    return not has_gun_kill

rounds = [r for r in rounds if not _is_knife_round(r, kills, tick_rate)]
# Renumber after filtering
for i, r in enumerate(rounds):
    r["round_num"] = i + 1
```

Recompute scores after both filters:

```python
ct_score = sum(1 for r in rounds if r["winner_side"] == "ct")
t_score  = sum(1 for r in rounds if r["winner_side"] == "t")
```

Note: the knife filter needs `kills` to be available. Move the knife-filter + renumber + score-recompute block to immediately after `kills` is built (around current line 541), not in the round-build loop. The order in `parse_demo()` becomes: pair rounds → warmup filter → live-cutoff filter → build rounds → build frames → build kills → **knife filter → renumber rounds → recompute meta scores** → build grenades / bomb / etc.

### Fix — client side

Remove the duplicate knife filter in `cs2-hub/demo-viewer.js` lines 77–93 (the block bracketed by `// Strip knife rounds:` and `console.log('[viewer] rounds after knife filter:', ...)`).

### Files changed

| File | Change |
|---|---|
| `vps/demo_parser.py` | Add `live_start_tick` filter, server-side knife filter, renumber, recompute scores. Reorder `parse_demo()` so kills are built before knife filter. |
| `cs2-hub/demo-viewer.js` | Remove client-side knife filter block. |

---

## 5. Click player → copy setpos

### Parser change

In `vps/demo_parser.py`, add `Z` and `pitch` to the columns requested in `parse_ticks`:

```python
tick_df = p.parse_ticks(
    ["X", "Y", "Z", "health", "is_alive", "team_num", "active_weapon_name",
     "balance", "armor_value", "yaw", "pitch"] + _util_cols,
    ticks=sampled,
)
```

In the per-player frame build:

```python
"z":     _safe_float(r.get("Z")),
"pitch": _safe_float(r.get("pitch")),
```

(Existing `yaw` stays; we just add `z` and `pitch` siblings.)

### Viewer change — click target

Two click targets:

1. **Player card** in the side panel (`.player-card` in CT and T panels).
2. **Player dot** on the canvas (hit-test in canvas mouse handler).

In `playerCardHTML`, add `data-steam-id="${p.steam_id}"` to the root `.player-card` div. Add a single delegated click listener on each panel root:

```js
function setupSetposClicks() {
  for (const panelId of ['ct-panel', 't-panel']) {
    document.getElementById(panelId).addEventListener('click', e => {
      const card = e.target.closest('.player-card')
      if (!card) return
      const sid = card.dataset.steamId
      if (sid) copySetposFor(sid)
    })
  }
}
```

For the canvas, in the existing `mousedown` handler add a non-drawing-mode branch:

```js
canvas.addEventListener('mousedown', e => {
  if (drawingMode) { /* existing draw code */ return }
  // Hit-test player dots
  const frame = getInterpolatedFrame(state.tick)
  if (!frame) return
  const rect = canvas.getBoundingClientRect()
  const sx = (e.clientX - rect.left) * (canvas.width / rect.width)
  const sy = (e.clientY - rect.top)  * (canvas.height / rect.height)
  const cw = canvas.width, ch = canvas.height
  const mapSize = Math.min(cw, ch)
  const mapX = (cw - mapSize) / 2, mapY = (ch - mapSize) / 2
  // Apply zoom inversion: screen → unzoomed canvas
  const ux = (sx - cw / 2 - mapPanX) / mapZoom + cw / 2
  const uy = (sy - ch / 2 - mapPanY) / mapZoom + ch / 2
  const dotR = Math.round(mapSize * 0.009)
  const hitR = dotR + 6
  for (const p of frame.players) {
    if (!p.is_alive) continue
    const { x, y } = worldToCanvas(p.x, p.y, mapName, mapSize, mapSize)
    const px = x + mapX, py = y + mapY
    if ((ux - px) ** 2 + (uy - py) ** 2 <= hitR ** 2) {
      copySetposFor(p.steam_id)
      return
    }
  }
})
```

### `copySetposFor` helper

```js
function copySetposFor(steamId) {
  const frame = getInterpolatedFrame(state.tick)
  if (!frame) return
  const p = frame.players.find(pl => pl.steam_id === steamId)
  if (!p) return
  const cmd = (p.z != null && p.pitch != null)
    ? `setpos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}; setang ${p.pitch.toFixed(1)} ${p.yaw.toFixed(1)} 0`
    : `setpos ${p.x.toFixed(1)} ${p.y.toFixed(1)}; setang 0 ${p.yaw.toFixed(1)} 0`
  navigator.clipboard.writeText(cmd).then(() => showSetposToast(p.name))
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
      pointer-events: none; transition: opacity 0.2s;
    `
    document.body.appendChild(toast)
  }
  toast.textContent = `Setpos copied — ${playerName}`
  toast.style.opacity = '1'
  clearTimeout(toast._hideTimer)
  toast._hideTimer = setTimeout(() => { toast.style.opacity = '0' }, 1500)
}
```

### Cursor affordance

Add to `cs2-hub/demo-viewer.html` styles:

```css
.player-card { cursor: pointer; }
.player-card:hover { background: rgba(102,102,183,0.10); }
```

For the canvas, no cursor change (it'd interfere with drawing mode and zoom feel).

### Files changed

| File | Change |
|---|---|
| `vps/demo_parser.py` | Add `Z`, `pitch` to `parse_ticks`; emit `z`, `pitch` per player. |
| `cs2-hub/demo-viewer.js` | Add `data-steam-id` to player card; add click handlers (panels + canvas); add `copySetposFor`, `showSetposToast`; wire on init. |
| `cs2-hub/demo-viewer.html` | Add `.player-card { cursor: pointer; }` and hover style. |

---

## 6. Auto-play on round click

### Fix

In `cs2-hub/demo-viewer.js` `jumpToRound`:

```js
// Before:
state.playing   = false

// After:
state.playing  = true
state.lastTs   = performance.now()
```

`updatePlayBtn()` already runs at the end of `jumpToRound` and will reflect the new state (showing ⏸).

`state.lastTs` reset prevents the loop's first frame after the jump from computing `dt = ts - lastTs` against a stale timestamp from earlier playback (which would advance `state.tick` by a giant amount).

### Files changed

| File | Change |
|---|---|
| `cs2-hub/demo-viewer.js` | One-line change in `jumpToRound`. |

---

## 7. Flash visibility — engine truth

### Parser change

Add `flash_duration` to the columns requested in `parse_ticks`:

```python
tick_df = p.parse_ticks(
    ["X", "Y", "Z", "health", "is_alive", "team_num", "active_weapon_name",
     "balance", "armor_value", "yaw", "pitch", "flash_duration"] + _util_cols,
    ticks=sampled,
)
```

In the per-player frame build:

```python
"flash_duration": _safe_float(r.get("flash_duration")),
```

This field is the engine-computed remaining flash time in seconds, decremented per-tick by the engine itself. It already reflects line-of-sight, view-angle scaling, and corner occlusion — the engine has done the math.

### Drop the post-hoc estimation

Delete the `blinds = [...]` block (lines 552-594 in `vps/demo_parser.py`) and the `"blinds": blinds` field from the return value. New demos no longer carry a `blinds[]` array.

### Viewer change

In `cs2-hub/demo-viewer.js` `render()`, replace the `blindUntil` map computation (currently built from `state.match.blinds`):

```js
// Before:
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

// After:
function flashIntensity(p) {
  // New demos: engine-truth flash_duration on the player.
  // Old demos: derive from state.match.blinds (legacy fallback).
  if (p.flash_duration != null) {
    return Math.max(0, Math.min(1, p.flash_duration / 2.5))
  }
  // Legacy fallback (only for demos parsed before this change)
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

In the player draw loop, replace `blindInfo` lookups:

```js
// Before:
const blindInfo = blindUntil[id]
if (blindInfo && state.tick < blindInfo.until) { /* ring */ }
// ... and the dot color computation that uses blindInfo

// After:
const flashI = flashIntensity(p)
if (flashI > 0.06) {
  // Blind ring (team-coloured, semi-transparent)
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

// Dot colour: lerp team-color → white as flashI rises
let color
if (flashI > 0.06) {
  const [tr, tg, tb] = p.team === 'ct' ? [79, 195, 247] : [255, 149, 0]
  const fr = Math.round(255 * flashI + tr * (1 - flashI))
  const fg = Math.round(255 * flashI + tg * (1 - flashI))
  const fb = Math.round(255 * flashI + tb * (1 - flashI))
  color = `rgb(${fr},${fg},${fb})`
} else {
  color = (Date.now() < (_flashUntil[id] ?? 0)) ? '#FF1744' : playerColor(p.team)
}
```

Threshold `0.06` matches the old `FLASH_MIN_DURATION = 0.15s` (0.15 / 2.5 ≈ 0.06). The white-out is proportional to remaining flash time, capped at 2.5 s of effect (longer flashes still register but visually the dot is fully white at ≥2.5 s remaining — same upper bound the old code used).

### Files changed

| File | Change |
|---|---|
| `vps/demo_parser.py` | Add `flash_duration` to `parse_ticks`; emit `flash_duration` per player; delete `blinds[]` estimation block and field from return value. |
| `cs2-hub/demo-viewer.js` | Replace `blindUntil` map with `flashIntensity(p)` helper; update player draw loop (ring + dot colour). |

---

## File summary

| File | Items affected |
|---|---|
| `vps/demo_parser.py` | 2 (server), 3, 4 (server), 5 (parser), 7 (parser) |
| `cs2-hub/demo-viewer.js` | 2 (client), 4 (client), 5 (viewer), 6, 7 (viewer) |
| `cs2-hub/demo-viewer.html` | 5 (cursor CSS) |
| `cs2-hub/demos.js` | 1 |

`vps/main.py` is **not** changed: it already reads `match_data.meta.ct_score` / `t_score` from the parser output, so the corrected scores propagate automatically.

---

## Out of scope

- **Multi-round analysis tool** (cs2.cam-style filters, grenade mode, multi-round overlay). Separate spec.
- **HLTV public demo database / public-vs-private split.** Separate spec.
- **Roster substitutions mid-series.** If a 6th steam ID appears across a series, the modal falls back to the legacy by-side flow for the affected map and logs a warning. Substitution-aware roster handling is not built.
- **Re-parsing existing demos** to backfill `z`, `pitch`, `flash_duration`, deduped grenades, corrected scores. Per the only-new-uploads decision.
- **Old-demo `blinds[]` accuracy.** Old demos keep their post-hoc `blinds[]` arrays (still inaccurate). Re-uploading the demo (Retry button) re-parses and produces engine-truth flashes.
