// CS2 round timing helper for the demo viewer.
//
// `round.end_tick` = the `round_end` event tick (win condition met). CS2 then
// has a `round_restart_delay` (~7s default, varies per platform/cvar) before
// the next round's `round_start` event fires. The viewer plays through that
// post-round phase so the user sees the aftermath (defuse animation, last
// kills landing, players walking off).
//
// Returns the demo tick at which the current round's playback should end:
//   - non-final round, normal gap (≤ cap):  nextRound.start_tick
//   - non-final round, long gap (halftime): end_tick + POST_END_CAP_TICKS
//   - final round (no nextRound):           end_tick + FINAL_RESTART_TICKS
//
// All ticks are CS2 server ticks (64 Hz).

const POST_END_CAP_TICKS    = 650  // ~10s @ 64Hz — clips halftime / timeout dead air
const FINAL_RESTART_TICKS   = 450  // ~7s  @ 64Hz — default round_restart_delay

export function postEndTick(round, nextRound) {
  if (nextRound) {
    const gap = nextRound.start_tick - round.end_tick
    return gap <= POST_END_CAP_TICKS
      ? nextRound.start_tick
      : round.end_tick + POST_END_CAP_TICKS
  }
  return round.end_tick + FINAL_RESTART_TICKS
}
