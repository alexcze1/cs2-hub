#!/usr/bin/env python3
"""Standalone demo parse validator.
Usage: cd vps && python test_parse.py path/to/demo.dem
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from demo_parser import parse_demo

_MAP_BOUNDS = {
    "de_mirage":  {"x": (-3230, 1890),  "y": (-3407, 1713)},
    "de_inferno": {"x": (-2087, 2930),  "y": (-1147, 3870)},
    "de_nuke":    {"x": (-3453, 3715),  "y": (-4281, 2887)},
    "de_ancient": {"x": (-2953, 2167),  "y": (-2956, 2164)},
    "de_anubis":  {"x": (-2796, 2549),  "y": (-2017, 3328)},
    "de_dust2":   {"x": (-2476, 2030),  "y": (-1267, 3239)},
    "de_vertigo": {"x": (-3168,  928),  "y": (-2334, 1762)},
    "de_train":   {"x": (-2477, 2336),  "y": (-2421, 2392)},
}


def _in_bounds(x, y, map_name):
    b = _MAP_BOUNDS.get(map_name)
    if not b:
        return True
    return b["x"][0] <= x <= b["x"][1] and b["y"][0] <= y <= b["y"][1]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_parse.py <demo.dem>")
        sys.exit(1)

    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"Error: file not found: {path}")
        sys.exit(1)
    print(f"Parsing {path} …\n")
    try:
        data = parse_demo(path)
    except Exception as e:
        print(f"Parse failed: {e}")
        sys.exit(1)

    map_name  = data["meta"]["map"]
    tick_rate = data["meta"]["tick_rate"]

    print("── META ──────────────────────────────────────────────────")
    print(f"  Map: {map_name}   Tick rate: {tick_rate}   Total ticks: {data['meta']['total_ticks']}")
    print(f"  CT {data['meta']['ct_score']} – {data['meta']['t_score']} T")

    print(f"\n── ROUNDS ({len(data['rounds'])}) ────────────────────────────────────")
    for r in data["rounds"][:5]:
        dur = r["end_tick"] - r["start_tick"]
        print(f"  R{r['round_num']:02d}  {r['start_tick']:6d} → {r['end_tick']:6d}  ({dur:4d} ticks)  {r['winner_side'].upper()}  {r['win_reason']}")
    if len(data["rounds"]) > 5:
        print(f"  … {len(data['rounds']) - 5} more rounds")

    print(f"\n── FRAMES ({len(data['frames'])}) ───────────────────────────────────")
    if data["frames"]:
        f0 = data["frames"][0]
        print(f"  Frame 0  tick={f0['tick']}  players={len(f0['players'])}")
        alive = [p for p in f0["players"] if p["is_alive"]]
        for p in alive[:10]:
            flag = "✓" if _in_bounds(p["x"], p["y"], map_name) else "⚠ OUT OF BOUNDS"
            print(f"    {p['name'][:15]:15}  {p['team'].upper()}  x={p['x']:8.0f}  y={p['y']:8.0f}  {flag}")

    print(f"\n── KILLS ({len(data['kills'])}) ─────────────────────────────────────")
    for k in data["kills"][:5]:
        hs = "  HS" if k["headshot"] else ""
        print(f"  tick={k['tick']:6d}  {k['killer_name'][:12]:12} → {k['victim_name'][:12]:12}  {k['weapon']}{hs}")

    # Sanity checks
    print("\n── CHECKS ────────────────────────────────────────────────")

    oob = [(f["tick"], p["name"], p["x"], p["y"])
           for f in data["frames"]
           for p in f["players"]
           if p["is_alive"] and not _in_bounds(p["x"], p["y"], map_name)]
    if oob:
        print(f"  ⚠ {len(oob)} out-of-bounds alive-player positions")
        for tick, name, x, y in oob[:3]:
            print(f"    tick={tick}  {name}  ({x:.0f}, {y:.0f})")
    else:
        print("  ✓ All alive-player positions within map bounds")

    zero = sum(1 for f in data["frames"]
               for p in f["players"]
               if p["is_alive"] and p["x"] == 0 and p["y"] == 0)
    if zero:
        print(f"  ⚠ {zero} alive players stuck at (0, 0) — likely parse failure")
    else:
        print("  ✓ No alive players at origin")

    start_ticks = [r["start_tick"] for r in data["rounds"]]
    if len(start_ticks) != len(set(start_ticks)):
        print("  ⚠ Duplicate round start_ticks detected")
    else:
        print("  ✓ All round start_ticks are unique")

    print("\n✓ Done")
