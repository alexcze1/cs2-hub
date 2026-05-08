// cs2-hub/demo-player-filters.js
//
// Shared filters for demo_players rows. Used by the per-demo scoreboard
// and the cross-demo roster aggregation.

// Coach-slot players have names starting with "COACH" and sit at spawn
// dying every round. Defensive filter for demos parsed before the backend
// scrub was added.
export const isCoach = (name) => /^\s*COACH/i.test(String(name || ''))

// Drop coach rows from a list of demo_players.
export const stripCoaches = (rows) => (rows || []).filter(r => !isCoach(r.name))
