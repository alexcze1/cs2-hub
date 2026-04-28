package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"

	dem "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
)

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type Track struct {
	SteamID   string  `json:"steam_id"`
	Type      string  `json:"type"`
	ThrowTick int     `json:"throw_tick"`
	DetTick   int     `json:"det_tick"`
	Path      []Point `json:"path"`
}

func grenadeTypeFromClass(name string) string {
	switch name {
	case "CSmokeGrenadeProjectile":
		return "smoke"
	case "CHEGrenadeProjectile":
		return "he"
	case "CFlashbangProjectile":
		return "flash"
	case "CMolotovProjectile", "CIncendiaryProjectile":
		return "molotov"
	default:
		return ""
	}
}

type trackState struct {
	Track
	lastTick         int
	prevX, prevY     float64
	prevNDX, prevNDY float64
	sinceLast        int
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: parse_grenades <demo.dem>")
		os.Exit(1)
	}

	f, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "open:", err)
		os.Exit(1)
	}
	defer f.Close()

	parser := dem.NewParserWithConfig(f, dem.ParserConfig{IgnorePacketEntitiesPanic: true})
	defer parser.Close()

	active := map[int64]*trackState{}
	completed := make([]Track, 0)

	parser.RegisterEventHandler(func(events.FrameDone) {
		defer func() { recover() }()
		gameTick := parser.GameState().IngameTick()
		for _, proj := range parser.GameState().GrenadeProjectiles() {
			uid := proj.UniqueID()
			s, ok := active[uid]
			if !ok {
				gt := grenadeTypeFromClass(proj.Entity.ServerClass().Name())
				if gt == "" {
					continue
				}
				sid := ""
				if proj.Thrower != nil {
					sid = fmt.Sprintf("%d", proj.Thrower.SteamID64)
				}
				pos := proj.Position()
				s = &trackState{
					Track: Track{
						SteamID:   sid,
						Type:      gt,
						ThrowTick: gameTick,
						Path:      []Point{{X: pos.X, Y: pos.Y}},
					},
					lastTick: gameTick,
					prevX:    pos.X,
					prevY:    pos.Y,
				}
				active[uid] = s
				continue
			}

			pos := proj.Position()
			dx := pos.X - s.prevX
			dy := pos.Y - s.prevY
			dist := math.Sqrt(dx*dx + dy*dy)

			if dist < 2 {
				continue
			}

			ndx, ndy := dx/dist, dy/dist
			s.sinceLast++

			// Detect bounce: direction changed more than ~30 degrees
			isBounce := false
			if (s.prevNDX != 0 || s.prevNDY != 0) && s.sinceLast > 1 {
				dot := ndx*s.prevNDX + ndy*s.prevNDY
				if dot < 0.866 { // cos(30deg)
					isBounce = true
				}
			}

			if isBounce || s.sinceLast >= 3 {
				s.Path = append(s.Path, Point{X: pos.X, Y: pos.Y})
				s.sinceLast = 0
				s.lastTick = gameTick
			}

			s.prevX, s.prevY = pos.X, pos.Y
			s.prevNDX, s.prevNDY = ndx, ndy
		}
	})

	parser.RegisterEventHandler(func(events.FrameDone) {
		defer func() { recover() }()
		gameTick := parser.GameState().IngameTick()
		alive := make(map[int64]bool)
		for _, proj := range parser.GameState().GrenadeProjectiles() {
			alive[proj.UniqueID()] = true
		}
		for uid, s := range active {
			if !alive[uid] {
				if len(s.Path) >= 2 {
					s.DetTick = gameTick
					completed = append(completed, s.Track)
				}
				delete(active, uid)
			}
		}
	})

	if err := parser.ParseToEnd(); err != nil {
		fmt.Fprintln(os.Stderr, "[warn] parse:", err)
	}

	if err := json.NewEncoder(os.Stdout).Encode(completed); err != nil {
		fmt.Fprintln(os.Stderr, "json:", err)
		os.Exit(1)
	}
}
