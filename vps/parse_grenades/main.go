package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"

	dem "github.com/markus-wa/demoinfocs-golang/v4/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v4/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v4/pkg/demoinfocs/events"
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

func grenadeType(t common.EquipmentType) string {
	switch t {
	case common.EqSmoke:
		return "smoke"
	case common.EqHE:
		return "he"
	case common.EqFlash:
		return "flash"
	case common.EqMolotov:
		return "molotov"
	case common.EqIncendiary:
		return "molotov"
	default:
		return ""
	}
}

type trackState struct {
	Track
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

	parser, err := dem.NewParser(f)
	if err != nil {
		fmt.Fprintln(os.Stderr, "parser:", err)
		os.Exit(1)
	}
	defer parser.Close()

	active := map[int64]*trackState{}
	var completed []Track

	parser.RegisterEventHandler(func(e events.GrenadeProjectileThrow) {
		gt := grenadeType(e.Projectile.WeaponInstance.Type)
		if gt == "" {
			return
		}
		uid := e.Projectile.UniqueID()
		sid := ""
		if e.Projectile.Thrower != nil {
			sid = fmt.Sprintf("%d", e.Projectile.Thrower.SteamID64)
		}
		pos := e.Projectile.Position()
		active[uid] = &trackState{
			Track: Track{
				SteamID:   sid,
				Type:      gt,
				ThrowTick: parser.CurrentFrame(),
				Path:      []Point{{X: pos.X, Y: pos.Y}},
			},
			prevX: pos.X,
			prevY: pos.Y,
		}
	})

	parser.RegisterEventHandler(func(e events.GrenadeProjectileUpdated) {
		uid := e.Projectile.UniqueID()
		s, ok := active[uid]
		if !ok {
			return
		}
		pos := e.Projectile.Position()
		dx := pos.X - s.prevX
		dy := pos.Y - s.prevY
		dist := math.Sqrt(dx*dx + dy*dy)
		if dist < 5 {
			return
		}
		ndx, ndy := dx/dist, dy/dist
		s.sinceLast++

		// Detect bounce: direction change > 45 degrees
		isBounce := false
		if (s.prevNDX != 0 || s.prevNDY != 0) && s.sinceLast > 1 {
			dot := ndx*s.prevNDX + ndy*s.prevNDY
			if dot < 0.707 {
				isBounce = true
			}
		}

		if isBounce || s.sinceLast >= 8 {
			s.Path = append(s.Path, Point{X: pos.X, Y: pos.Y})
			s.sinceLast = 0
		}
		s.prevX, s.prevY = pos.X, pos.Y
		s.prevNDX, s.prevNDY = ndx, ndy
	})

	parser.RegisterEventHandler(func(e events.GrenadeProjectileDestroyed) {
		uid := e.Projectile.UniqueID()
		s, ok := active[uid]
		if !ok {
			return
		}
		pos := e.Projectile.Position()
		s.DetTick = parser.CurrentFrame()
		s.Path = append(s.Path, Point{X: pos.X, Y: pos.Y})
		if len(s.Path) >= 2 {
			completed = append(completed, s.Track)
		}
		delete(active, uid)
	})

	if err := parser.ParseToEnd(); err != nil {
		fmt.Fprintln(os.Stderr, "parse:", err)
		os.Exit(1)
	}

	if err := json.NewEncoder(os.Stdout).Encode(completed); err != nil {
		fmt.Fprintln(os.Stderr, "json:", err)
		os.Exit(1)
	}
}
