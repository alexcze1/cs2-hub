package main

import (
	"encoding/json"
	"fmt"
	"os"

	dem "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
)

type Point struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Tick int     `json:"tick"`
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
	lastTick int
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

	// Throw: start tracking
	parser.RegisterEventHandler(func(e events.GrenadeProjectileThrow) {
		defer func() { recover() }()
		if e.Projectile == nil || e.Projectile.Entity == nil {
			return
		}
		gt := grenadeTypeFromClass(e.Projectile.Entity.ServerClass().Name())
		if gt == "" {
			return
		}
		sid := ""
		if e.Projectile.Thrower != nil {
			sid = fmt.Sprintf("%d", e.Projectile.Thrower.SteamID64)
		}
		gameTick := parser.GameState().IngameTick()
		pos := e.Projectile.Position()
		uid := e.Projectile.UniqueID()
		active[uid] = &trackState{
			Track: Track{
				SteamID:   sid,
				Type:      gt,
				ThrowTick: gameTick,
				Path:      []Point{{X: pos.X, Y: pos.Y, Tick: gameTick}},
			},
			lastTick: gameTick,
		}
	})

	// Bounce: always record exact position
	parser.RegisterEventHandler(func(e events.GrenadeProjectileBounce) {
		defer func() { recover() }()
		if e.Projectile == nil {
			return
		}
		s, ok := active[e.Projectile.UniqueID()]
		if !ok {
			return
		}
		pos := e.Projectile.Position()
		gameTick := parser.GameState().IngameTick()
		s.Path = append(s.Path, Point{X: pos.X, Y: pos.Y, Tick: gameTick})
		s.lastTick = gameTick
	})

	// FrameDone: regular samples between bounces
	parser.RegisterEventHandler(func(events.FrameDone) {
		defer func() { recover() }()
		gameTick := parser.GameState().IngameTick()
		for _, proj := range parser.GameState().GrenadeProjectiles() {
			s, ok := active[proj.UniqueID()]
			if !ok {
				continue
			}
			if gameTick-s.lastTick >= 4 {
				pos := proj.Position()
				s.Path = append(s.Path, Point{X: pos.X, Y: pos.Y, Tick: gameTick})
				s.lastTick = gameTick
			}
		}
	})

	// Destroy: finalize
	parser.RegisterEventHandler(func(e events.GrenadeProjectileDestroy) {
		defer func() { recover() }()
		if e.Projectile == nil {
			return
		}
		uid := e.Projectile.UniqueID()
		s, ok := active[uid]
		if !ok {
			return
		}
		gameTick := parser.GameState().IngameTick()
		pos := e.Projectile.Position()
		s.Path = append(s.Path, Point{X: pos.X, Y: pos.Y, Tick: gameTick})
		s.DetTick = gameTick
		if len(s.Path) >= 2 {
			completed = append(completed, s.Track)
		}
		delete(active, uid)
	})

	if err := parser.ParseToEnd(); err != nil {
		fmt.Fprintln(os.Stderr, "[warn] parse:", err)
	}

	if err := json.NewEncoder(os.Stdout).Encode(completed); err != nil {
		fmt.Fprintln(os.Stderr, "json:", err)
		os.Exit(1)
	}
}
