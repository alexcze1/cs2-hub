// Design preview mock — injected before any module loads.
// Overrides Supabase + auth so pages render their full layout w/ realistic data
// without requiring a live login.  ONLY used for visual screenshots.

const TEAM_ID = '00000000-0000-0000-0000-000000000001'
const USER_ID = '00000000-0000-0000-0000-000000000002'
const TEAM_NAME = 'PHANTOM5'

const FAKE_SESSION = {
  access_token: 'mock',
  refresh_token: 'mock',
  expires_at: Date.now() + 3600_000,
  user: {
    id: USER_ID,
    email: 'design@preview.local',
    user_metadata: { is_admin: true },
    app_metadata: {},
  },
}

localStorage.setItem('cs2hub_team_id', TEAM_ID)

const TODAY = new Date()
const HOUR_MS = 3600_000
const DAY_MS = 86_400_000
const addDays = (d) => new Date(Date.now() + d * DAY_MS).toISOString()
const subDays = (d) => new Date(Date.now() - d * DAY_MS).toISOString()

const FAKE = {
  teams: [{ id: TEAM_ID, name: TEAM_NAME, pracc_url: null, gcal_url: null }],
  team_members: [
    { id: 'm1', team_id: TEAM_ID, user_id: USER_ID, role: 'owner', nickname: 'fl0m', ign: 'fl0m',
      steam_id: '76561198000000001', display_role: 'IGL' },
    { id: 'm2', team_id: TEAM_ID, user_id: 'u2', role: 'member', nickname: 's1mple', ign: 's1mple',
      steam_id: '76561198000000002', display_role: 'AWPer' },
    { id: 'm3', team_id: TEAM_ID, user_id: 'u3', role: 'member', nickname: 'electronic', ign: 'electronic',
      steam_id: '76561198000000003', display_role: 'Entry' },
    { id: 'm4', team_id: TEAM_ID, user_id: 'u4', role: 'member', nickname: 'b1t', ign: 'b1t',
      steam_id: '76561198000000004', display_role: 'Lurker' },
    { id: 'm5', team_id: TEAM_ID, user_id: 'u5', role: 'member', nickname: 'Perfecto', ign: 'Perfecto',
      steam_id: '76561198000000005', display_role: 'Support' },
  ],
  events: [
    { id: 'e1', team_id: TEAM_ID, type: 'tournament', title: 'IEM Cologne — Group Stage',
      opponent: 'NaVi', date: addDays(2), end_date: addDays(2.1), notes: 'BO3, Map veto at 14:00 CET' },
    { id: 'e2', team_id: TEAM_ID, type: 'scrim', title: 'Scrim vs FaZe',
      opponent: 'FaZe', date: addDays(0.3), end_date: addDays(0.5), notes: '' },
    { id: 'e3', team_id: TEAM_ID, type: 'scrim', title: 'Scrim vs Vitality',
      opponent: 'Vitality', date: addDays(1.4), end_date: addDays(1.5), notes: '' },
    { id: 'e4', team_id: TEAM_ID, type: 'vod_review', title: 'VOD: Mirage vs G2',
      opponent: 'G2', date: addDays(3), end_date: addDays(3.05), notes: '' },
    { id: 'e5', team_id: TEAM_ID, type: 'meeting', title: 'Strategy meeting',
      opponent: null, date: addDays(4), end_date: addDays(4.04), notes: '' },
  ],
  strats: [
    { id: 's1', team_id: TEAM_ID, name: 'Default A — Slow Mid', map: 'mirage', side: 't',
      type: 'default', notes: 'Pop flash over ramp, stack 3 mid, 2 A apps. Trigger on AWP picked. Roll into Anti-Eco Default if they save.',
      tags: ['A SITE', 'MID', 'DEFAULT'], roles: [
        { player: 'fl0m', position: 'CT spawn' },
        { player: 's1mple', position: 'Connector' },
        { player: 'electronic', position: 'Top mid' },
        { player: 'b1t', position: 'A ramp' },
        { player: 'Perfecto', position: 'A apps' },
      ], created_at: subDays(1) },
    { id: 's2', team_id: TEAM_ID, name: 'B Split — Smoke Window', map: 'mirage', side: 't',
      type: 'opening', notes: 'Two through apps, three through ramp window after smoke.',
      tags: ['B SITE', 'SPLIT'], roles: [], created_at: subDays(2) },
    { id: 's3', team_id: TEAM_ID, name: 'Banana Stack', map: 'inferno', side: 'ct',
      type: 'setup', notes: '4-stack banana on round 4 if they go A first half.',
      tags: ['B SITE', 'STACK', 'ROUND 4'], roles: [], created_at: subDays(3) },
    { id: 's4', team_id: TEAM_ID, name: 'Pistol — Default A', map: 'nuke', side: 't',
      type: 'pistol', notes: 'Standard pistol exec onto A with split smokes.',
      tags: ['PISTOL', 'A SITE'], roles: [], created_at: subDays(4) },
    { id: 's5', team_id: TEAM_ID, name: 'Outside Hit', map: 'nuke', side: 't',
      type: 'opening', notes: 'Outside control then heaven flash for entry.',
      tags: ['OUTSIDE', 'HEAVEN'], roles: [], created_at: subDays(5) },
    { id: 's6', team_id: TEAM_ID, name: 'A Execute — Triple', map: 'anubis', side: 't',
      type: 'opening', notes: 'Triple A through palace + main + connector.',
      tags: ['A SITE', 'EXECUTE', 'Triple Stack'], roles: [], created_at: subDays(6) },
  ],
  vods: [
    { id: 'v1', team_id: TEAM_ID, opponent: 'NaVi', opponent_name: 'NaVi', match_type: 'tournament',
      date: subDays(2), match_date: subDays(2).slice(0, 10), dismissed: false, created_at: subDays(2),
      demo_link: 'https://example.com/demo1', maps: [
        { map: 'mirage', score_us: 16, score_them: 11 },
        { map: 'inferno', score_us: 13, score_them: 16 },
        { map: 'nuke', score_us: 16, score_them: 14 },
      ], notes: { overview: 'Solid map veto, won mirage convincingly.' } },
    { id: 'v2', team_id: TEAM_ID, opponent: 'FaZe', opponent_name: 'FaZe', match_type: 'scrim',
      date: subDays(5), match_date: subDays(5).slice(0, 10), dismissed: false, created_at: subDays(5),
      maps: [{ map: 'anubis', score_us: 16, score_them: 13 }], notes: {} },
    { id: 'v3', team_id: TEAM_ID, opponent: 'G2', opponent_name: 'G2', match_type: 'tournament',
      date: subDays(8), match_date: subDays(8).slice(0, 10), dismissed: false, created_at: subDays(8),
      maps: [
        { map: 'overpass', score_us: 13, score_them: 16 },
        { map: 'ancient', score_us: 10, score_them: 16 },
      ], notes: {} },
    { id: 'v4', team_id: TEAM_ID, opponent: 'Vitality', opponent_name: 'Vitality', match_type: 'scrim',
      date: subDays(10), match_date: subDays(10).slice(0, 10), dismissed: false, created_at: subDays(10),
      maps: [
        { map: 'dust2', score_us: 16, score_them: 8 },
        { map: 'mirage', score_us: 16, score_them: 13 },
      ], notes: {} },
    { id: 'v5', team_id: TEAM_ID, opponent: 'Heroic', opponent_name: 'Heroic', match_type: 'tournament',
      date: subDays(14), match_date: subDays(14).slice(0, 10), dismissed: false, created_at: subDays(14),
      maps: [{ map: 'nuke', score_us: 16, score_them: 7 }], notes: {} },
    { id: 'v6', team_id: TEAM_ID, opponent: 'MOUZ', opponent_name: 'MOUZ', match_type: 'scrim',
      date: subDays(17), match_date: subDays(17).slice(0, 10), dismissed: false, created_at: subDays(17),
      maps: [{ map: 'inferno', score_us: 9, score_them: 16 }], notes: {} },
    { id: 'v7', team_id: TEAM_ID, opponent: 'Astralis', opponent_name: 'Astralis', match_type: 'scrim',
      date: subDays(21), match_date: subDays(21).slice(0, 10), dismissed: false, created_at: subDays(21),
      maps: [{ map: 'mirage', score_us: 16, score_them: 12 }], notes: {} },
    { id: 'v8', team_id: TEAM_ID, opponent: 'ENCE', opponent_name: 'ENCE', match_type: 'tournament',
      date: subDays(25), match_date: subDays(25).slice(0, 10), dismissed: false, created_at: subDays(25),
      maps: [{ map: 'nuke', score_us: 11, score_them: 16 }], notes: {} },
  ],
  opponents: [
    { id: 'o1', team_id: TEAM_ID, name: 'NaVi', maps: ['mirage', 'inferno', 'nuke'],
      strength: 'strong', notes: {} },
    { id: 'o2', team_id: TEAM_ID, name: 'FaZe Clan', maps: ['inferno', 'ancient'],
      strength: 'even', notes: {} },
    { id: 'o3', team_id: TEAM_ID, name: 'Vitality', maps: ['dust2', 'mirage', 'overpass'],
      strength: 'even', notes: {} },
    { id: 'o4', team_id: TEAM_ID, name: 'G2 Esports', maps: ['overpass', 'ancient'],
      strength: 'strong', notes: {} },
    { id: 'o5', team_id: TEAM_ID, name: 'Heroic', maps: ['nuke', 'mirage'],
      strength: 'weak', notes: {} },
    { id: 'o6', team_id: TEAM_ID, name: 'Cloud9', maps: [], strength: 'new', notes: {} },
  ],
  vetos: [
    { id: 'vt1', team_id: TEAM_ID, title: 'vs NaVi — BO3', opponent: 'NaVi', format: 'bo3',
      home: 'Us', away: 'NaVi', steps: [
        { action: 'ban', map: 'overpass', team: 'us' },
        { action: 'ban', map: 'dust2', team: 'them' },
        { action: 'pick', map: 'mirage', team: 'us' },
        { action: 'pick', map: 'inferno', team: 'them' },
        { action: 'ban', map: 'ancient', team: 'us' },
        { action: 'ban', map: 'anubis', team: 'them' },
        { action: 'decider', map: 'nuke', team: 'system' },
      ], notes: 'They love picking inferno, banned dust2 first.', created_at: subDays(2) },
  ],
  veto_predictions: [
    { id: 'vp1', team_id: TEAM_ID, title: 'vs NaVi — BO3', opponent: 'NaVi', format: 'bo3',
      steps: [
        { type: 'ban', map: 'overpass', team: 'us' },
        { type: 'ban', map: 'dust2', team: 'them' },
        { type: 'pick', map: 'mirage', team: 'us' },
        { type: 'pick', map: 'inferno', team: 'them' },
        { type: 'ban', map: 'ancient', team: 'us' },
        { type: 'ban', map: 'anubis', team: 'them' },
        { type: 'decider', map: 'nuke', team: 'system' },
      ], notes: 'They love picking inferno, banned dust2 first.', created_at: subDays(2) },
    { id: 'vp2', team_id: TEAM_ID, title: 'vs FaZe — BO1', opponent: 'FaZe', format: 'bo1',
      steps: [
        { type: 'ban', map: 'overpass', team: 'us' },
        { type: 'ban', map: 'nuke', team: 'them' },
        { type: 'ban', map: 'dust2', team: 'us' },
        { type: 'ban', map: 'ancient', team: 'them' },
        { type: 'ban', map: 'anubis', team: 'us' },
        { type: 'ban', map: 'inferno', team: 'them' },
        { type: 'decider', map: 'mirage', team: 'system' },
      ], notes: '', created_at: subDays(6) },
    { id: 'vp3', team_id: TEAM_ID, title: 'vs Vitality — BO3', opponent: 'Vitality', format: 'bo3',
      steps: [
        { type: 'ban', map: 'overpass', team: 'us' },
        { type: 'ban', map: 'mirage', team: 'them' },
        { type: 'pick', map: 'nuke', team: 'us' },
        { type: 'pick', map: 'dust2', team: 'them' },
        { type: 'ban', map: 'anubis', team: 'us' },
        { type: 'ban', map: 'ancient', team: 'them' },
        { type: 'decider', map: 'inferno', team: 'system' },
      ], notes: '', created_at: subDays(11) },
  ],
  keywords: [
    { id: 'k1', team_id: TEAM_ID, name: 'Retake B', category: 'Callout',
      description: 'Coordinated B retake from CT + connector. Always util-heavy.' },
    { id: 'k2', team_id: TEAM_ID, name: 'Force Buy', category: 'Economy',
      description: 'Round 3 force after pistol loss, save save save plan.' },
    { id: 'k3', team_id: TEAM_ID, name: 'Triple Stack', category: 'Strat',
      description: '3 players hold one bombsite — used vs aggressive Ts.' },
    { id: 'k4', team_id: TEAM_ID, name: 'Anti-Eco Default', category: 'Strat',
      description: 'Slow default anti-eco. Stack mid, deny info.' },
  ],
  goals: [
    { id: 'g1', team_id: TEAM_ID, title: 'Reach top 30 HLTV ranking', category: 'competition',
      owner: 'Team', horizon: 'long_term', status: 'active', due_date: addDays(180),
      description: 'Stable top-30 finish by end of Q4 season.',
      action_steps: '• Win 60% of LAN matches\n• Maintain 1.05+ rating average', created_at: subDays(20) },
    { id: 'g2', team_id: TEAM_ID, title: 'Master Anubis map pool', category: 'strategy',
      owner: 'fl0m', horizon: 'monthly', status: 'active', due_date: addDays(28),
      description: 'Anubis has been our worst map. Need 10 strats min.',
      action_steps: '• 3 scrims/week on Anubis\n• Build out 12 strats for the map', created_at: subDays(10) },
    { id: 'g3', team_id: TEAM_ID, title: 'Improve mid-round comms', category: 'communication',
      owner: 'Team', horizon: 'weekly', status: 'active', due_date: addDays(7),
      description: 'Mid-round calls are too slow and contradictory.',
      action_steps: '• IGL takes priority during mid-round\n• Cap comms to 3-word callouts', created_at: subDays(3) },
  ],
  issues: [
    { id: 'i1', team_id: TEAM_ID, title: 'Losing B-site pistol on Mirage',
      category: 'tactical', priority: 'high', status: 'active',
      description: 'We lose 70% of B-side pistols on mirage. Smokes mistimed.',
      actions: 'Practice smoke timing in deathmatch every morning. Lock in the Retake B protocol for post-plants.', created_at: subDays(4) },
    { id: 'i2', team_id: TEAM_ID, title: 'Slow rotations on Nuke',
      category: 'tactical', priority: 'medium', status: 'improving',
      description: 'Rotations from outside to ramp take 12+ seconds.',
      actions: 'Practice setup with outside player tighter to elevator.', created_at: subDays(8) },
    { id: 'i3', team_id: TEAM_ID, title: 'Comms tilt in clutch rounds',
      category: 'mental', priority: 'low', status: 'active',
      description: 'Comms get heated when round goes wrong. Hurts next round.',
      actions: 'IGL calls a 5-second mute after any clutch attempt.', created_at: subDays(12) },
  ],
  scoreboard_demos: [],
  demos: [
    { id: 'd1', team_id: TEAM_ID, status: 'ready', map: 'de_mirage',
      played_at: subDays(2), created_at: subDays(2),
      opponent_name: 'NaVi', ct_team_name: TEAM_NAME, t_team_name: 'NaVi',
      team_a_name: TEAM_NAME, team_b_name: 'NaVi', team_a_first_side: 'ct',
      team_a_score: 16, team_b_score: 11, score_ct: 16, score_t: 11,
      series_id: null, storage_path: 'demos/d1.dem', error_message: null },
    { id: 'd2', team_id: TEAM_ID, status: 'ready', map: 'de_nuke',
      played_at: subDays(6), created_at: subDays(6),
      opponent_name: 'FaZe', ct_team_name: 'FaZe', t_team_name: TEAM_NAME,
      team_a_name: TEAM_NAME, team_b_name: 'FaZe', team_a_first_side: 't',
      team_a_score: 13, team_b_score: 16, score_ct: 16, score_t: 13,
      series_id: null, storage_path: 'demos/d2.dem', error_message: null },
    { id: 'd3', team_id: TEAM_ID, status: 'ready', map: 'de_inferno',
      played_at: subDays(12), created_at: subDays(12),
      opponent_name: 'Vitality', ct_team_name: TEAM_NAME, t_team_name: 'Vitality',
      team_a_name: TEAM_NAME, team_b_name: 'Vitality', team_a_first_side: 'ct',
      team_a_score: 16, team_b_score: 9, score_ct: 16, score_t: 9,
      series_id: null, storage_path: 'demos/d3.dem', error_message: null },
  ],
  demo_team_stats: [
    { demo_id: 'd1', team: 'a',
      pistol_wins: 2, pistol_played: 2, five_v_four_wins: 7, five_v_four_played: 9,
      hard_eco_wins: 1, hard_eco_played: 4, eco_wins: 1, eco_played: 3,
      force_wins: 2, force_played: 4, half_buy_wins: 2, half_buy_played: 3,
      full_buy_wins: 9, full_buy_played: 13, anti_eco_wins: 3, anti_eco_played: 3,
      anti_force_wins: 2, anti_force_played: 3,
      ct_round_wins: 10, ct_rounds_played: 15, t_round_wins: 6, t_rounds_played: 12,
      first_kills: 16, first_deaths: 11 },
    { demo_id: 'd1', team: 'b',
      pistol_wins: 0, pistol_played: 2, five_v_four_wins: 4, five_v_four_played: 7,
      hard_eco_wins: 0, hard_eco_played: 3, eco_wins: 1, eco_played: 4,
      force_wins: 1, force_played: 4, half_buy_wins: 1, half_buy_played: 3,
      full_buy_wins: 7, full_buy_played: 13, anti_eco_wins: 2, anti_eco_played: 3,
      anti_force_wins: 1, anti_force_played: 3,
      ct_round_wins: 6, ct_rounds_played: 12, t_round_wins: 5, t_rounds_played: 15,
      first_kills: 11, first_deaths: 16 },
    { demo_id: 'd2', team: 'a',
      pistol_wins: 1, pistol_played: 2, five_v_four_wins: 5, five_v_four_played: 8,
      hard_eco_wins: 0, hard_eco_played: 3, eco_wins: 1, eco_played: 4,
      force_wins: 1, force_played: 3, half_buy_wins: 2, half_buy_played: 4,
      full_buy_wins: 7, full_buy_played: 12, anti_eco_wins: 2, anti_eco_played: 4,
      anti_force_wins: 1, anti_force_played: 2,
      ct_round_wins: 7, ct_rounds_played: 14, t_round_wins: 6, t_rounds_played: 15,
      first_kills: 13, first_deaths: 16 },
    { demo_id: 'd2', team: 'b',
      pistol_wins: 1, pistol_played: 2, five_v_four_wins: 6, five_v_four_played: 8,
      hard_eco_wins: 1, hard_eco_played: 4, eco_wins: 0, eco_played: 3,
      force_wins: 2, force_played: 3, half_buy_wins: 2, half_buy_played: 4,
      full_buy_wins: 9, full_buy_played: 12, anti_eco_wins: 3, anti_eco_played: 4,
      anti_force_wins: 1, anti_force_played: 2,
      ct_round_wins: 9, ct_rounds_played: 15, t_round_wins: 7, t_rounds_played: 14,
      first_kills: 16, first_deaths: 13 },
    { demo_id: 'd3', team: 'a',
      pistol_wins: 2, pistol_played: 2, five_v_four_wins: 8, five_v_four_played: 10,
      hard_eco_wins: 1, hard_eco_played: 3, eco_wins: 1, eco_played: 2,
      force_wins: 3, force_played: 4, half_buy_wins: 2, half_buy_played: 3,
      full_buy_wins: 8, full_buy_played: 11, anti_eco_wins: 4, anti_eco_played: 4,
      anti_force_wins: 2, anti_force_played: 3,
      ct_round_wins: 11, ct_rounds_played: 13, t_round_wins: 5, t_rounds_played: 12,
      first_kills: 15, first_deaths: 10 },
    { demo_id: 'd3', team: 'b',
      pistol_wins: 0, pistol_played: 2, five_v_four_wins: 3, five_v_four_played: 6,
      hard_eco_wins: 0, hard_eco_played: 4, eco_wins: 0, eco_played: 3,
      force_wins: 1, force_played: 4, half_buy_wins: 1, half_buy_played: 3,
      full_buy_wins: 6, full_buy_played: 11, anti_eco_wins: 2, anti_eco_played: 4,
      anti_force_wins: 1, anti_force_played: 3,
      ct_round_wins: 7, ct_rounds_played: 12, t_round_wins: 2, t_rounds_played: 13,
      first_kills: 10, first_deaths: 15 },
  ],
  demo_match_data: [],
  pro_demos: [],
  scrim_demos: [],
  playlists: [],
}

// ── Roster + demo_players (design preview only) ────────────────────────
// Mirror team_members into the `roster` table shape the Roster page reads,
// then synthesize per-player / per-demo / per-side stat rows so every
// performance surface renders with realistic, internally-consistent data.
FAKE.roster = FAKE.team_members.map(m => ({
  id: 'r' + m.id, team_id: TEAM_ID, user_id: m.user_id,
  nickname: m.nickname, steam_id: m.steam_id,
  role: m.display_role, is_ghost: false,
}))

const PLAYER_PROFILES = {
  // steam_id            rating adr  kast  hs   impact kpr  dpr  opk  opd  clutch m3 m4 util ctBias
  '76561198000000001': { rating: 1.04, adr: 78, kast: 0.74, hs: 0.46, impact: 1.02, kpr: 0.68, dpr: 0.66, opk: 0.10, opd: 0.11, clutch: 4, m3: 3, m4: 1, util: 7.2, ctBias: 0.06 }, // fl0m  IGL
  '76561198000000002': { rating: 1.34, adr: 92, kast: 0.76, hs: 0.38, impact: 1.42, kpr: 0.86, dpr: 0.58, opk: 0.18, opd: 0.10, clutch: 8, m3: 6, m4: 3, util: 3.1, ctBias: 0.10 }, // s1mple AWP
  '76561198000000003': { rating: 1.16, adr: 88, kast: 0.71, hs: 0.55, impact: 1.30, kpr: 0.82, dpr: 0.70, opk: 0.22, opd: 0.18, clutch: 3, m3: 5, m4: 2, util: 6.4, ctBias: -0.05 }, // electronic Entry
  '76561198000000004': { rating: 1.11, adr: 80, kast: 0.75, hs: 0.50, impact: 1.08, kpr: 0.74, dpr: 0.62, opk: 0.12, opd: 0.12, clutch: 6, m3: 4, m4: 1, util: 5.0, ctBias: 0.02 }, // b1t  Lurker
  '76561198000000005': { rating: 0.94, adr: 68, kast: 0.72, hs: 0.44, impact: 0.82, kpr: 0.60, dpr: 0.66, opk: 0.07, opd: 0.10, clutch: 2, m3: 2, m4: 0, util: 9.6, ctBias: 0.04 }, // Perfecto Support
}
const DEMO_ROUNDS = { d1: 27, d2: 29, d3: 25 }
const jitter = (base, amp, seed) => base + (((Math.sin(seed) * 9973) % 1) * 2 - 1) * amp

FAKE.demo_players = []
let _seed = 1
for (const m of FAKE.team_members) {
  const prof = PLAYER_PROFILES[m.steam_id]
  if (!prof) continue
  for (const [demoId, rounds] of Object.entries(DEMO_ROUNDS)) {
    const ctR = Math.round(rounds * 0.55)
    const tR = rounds - ctR
    const rAll = +jitter(prof.rating, 0.09, _seed++).toFixed(2)
    const mk = (side, rd, rating) => ({
      demo_id: demoId, team: 'a', side, steam_id: m.steam_id, name: m.ign,
      rounds_played: rd,
      kills: Math.round(prof.kpr * rd), deaths: Math.round(prof.dpr * rd), assists: Math.round(0.12 * rd),
      adr: +jitter(prof.adr, 6, _seed++).toFixed(1),
      kast_pct: Math.min(0.95, +jitter(prof.kast, 0.04, _seed++).toFixed(3)),
      hs_pct: +prof.hs.toFixed(3), rating,
      impact_rating: +jitter(prof.impact, 0.08, _seed++).toFixed(2),
      utility_dmg: Math.round(prof.util * rd),
      opening_kills: Math.round(prof.opk * rd), opening_deaths: Math.round(prof.opd * rd),
      clutches_won: side === 'all' ? prof.clutch : 0, clutches_lost: side === 'all' ? Math.round(prof.clutch * 0.7) : 0,
      multi_2k: Math.round(0.2 * rd), multi_3k: side === 'all' ? prof.m3 : 0,
      multi_4k: side === 'all' ? prof.m4 : 0, multi_5k: 0,
      flash_assists: Math.round(0.06 * rd), traded_deaths: Math.round(0.18 * rd),
    })
    FAKE.demo_players.push(mk('all', rounds, rAll))
    FAKE.demo_players.push(mk('ct', ctR, +(rAll + prof.ctBias).toFixed(2)))
    FAKE.demo_players.push(mk('t', tR, +(rAll - prof.ctBias).toFixed(2)))
  }
}

// ── Build a chainable thenable PostgrestBuilder mock ──
function builder(table) {
  let rows = (FAKE[table] || []).slice()
  let single = false
  let maybeSingle = false
  let _limit = null
  let _select = null

  const handlers = {
    select: function(cols) { _select = cols; return this },
    insert: function(payload) {
      const r = Array.isArray(payload) ? payload : [payload]
      const inserted = r.map(p => ({ id: 'new-' + Math.random().toString(36).slice(2,8), ...p }))
      FAKE[table] = (FAKE[table] || []).concat(inserted)
      rows = inserted
      return this
    },
    update: function() { return this },
    upsert: function() { return this },
    delete: function() { return this },
    eq: function(col, val) { rows = rows.filter(r => r[col] == val); return this },
    neq: function(col, val) { rows = rows.filter(r => r[col] != val); return this },
    is: function(col, val) { rows = rows.filter(r => r[col] == val); return this },
    in: function(col, vals) { rows = rows.filter(r => vals.includes(r[col])); return this },
    gt: function(col, v) { rows = rows.filter(r => r[col] > v); return this },
    gte: function(col, v) { rows = rows.filter(r => r[col] >= v); return this },
    lt: function(col, v) { rows = rows.filter(r => r[col] < v); return this },
    lte: function(col, v) { rows = rows.filter(r => r[col] <= v); return this },
    ilike: function() { return this },
    like: function() { return this },
    or: function() { return this },
    not: function() { return this },
    contains: function() { return this },
    order: function(col, opts) {
      const asc = !opts || opts.ascending !== false
      rows = rows.slice().sort((a, b) => {
        const A = a[col], B = b[col]
        if (A == null && B == null) return 0
        if (A == null) return 1
        if (B == null) return -1
        return asc ? (A > B ? 1 : A < B ? -1 : 0) : (A < B ? 1 : A > B ? -1 : 0)
      })
      return this
    },
    limit: function(n) { _limit = n; return this },
    range: function(from, to) { rows = rows.slice(from, to + 1); return this },
    single: function() { single = true; return this },
    maybeSingle: function() { maybeSingle = true; return this },
    then: function(onFulfilled, onRejected) {
      const out = _limit != null ? rows.slice(0, _limit) : rows
      let data
      if (single || maybeSingle) data = out[0] || null
      else data = out
      const result = { data, error: null, count: out.length, status: 200 }
      try { return Promise.resolve(onFulfilled ? onFulfilled(result) : result) }
      catch (e) { return onRejected ? Promise.resolve(onRejected(e)) : Promise.reject(e) }
    },
  }
  return handlers
}

const mockSupabase = {
  auth: {
    getSession: async () => ({ data: { session: FAKE_SESSION }, error: null }),
    getUser: async () => ({ data: { user: FAKE_SESSION.user }, error: null }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: (cb) => {
      try { cb('SIGNED_IN', FAKE_SESSION) } catch {}
      return { data: { subscription: { unsubscribe: () => {} } } }
    },
    signInWithOAuth: async () => ({ data: {}, error: null }),
  },
  from: (table) => builder(table),
  rpc: async () => ({ data: [], error: null }),
  storage: {
    from: () => ({
      list: async () => ({ data: [], error: null }),
      download: async () => ({ data: new Blob(), error: null }),
      getPublicUrl: () => ({ data: { publicUrl: '' } }),
      upload: async () => ({ data: {}, error: null }),
    }),
  },
  channel: () => ({
    on: function() { return this },
    subscribe: () => ({ data: {} }),
    unsubscribe: () => {},
  }),
  removeChannel: () => {},
}

// ── /api/admin shim (design preview only) ───────────────────────────────
// The Admin console talks to a server endpoint, not Supabase. Shim fetch so
// the redesign renders realistic platform data without a live backend.
const ADMIN_TEAMS = [
  { id: TEAM_ID, name: TEAM_NAME, join_code: 'PH-4827', tier: 'pro', created_at: subDays(214),
    members: FAKE.team_members.map(m => ({
      user_id: m.user_id, email: `${m.nickname.toLowerCase()}@phantom5.gg`,
      role: m.role === 'owner' ? 'owner' : 'member', steam_id: m.steam_id, display_role: m.display_role,
    })) },
  { id: '00000000-0000-0000-0000-0000000000aa', name: 'Nordic Talents', join_code: 'NT-1193', tier: 'free', created_at: subDays(38),
    members: [
      { user_id: 'x1', email: 'coach@nordic.gg', role: 'owner', steam_id: '76561198000000010', display_role: 'Coach' },
      { user_id: 'x2', email: 'kygar@nordic.gg', role: 'member', steam_id: '76561198000000011', display_role: 'AWPer' },
      { user_id: 'x3', email: 'lue@nordic.gg', role: 'member', steam_id: null, display_role: 'Entry' },
    ] },
  { id: '00000000-0000-0000-0000-0000000000bb', name: 'Academy Roster', join_code: 'AC-7740', tier: 'free', created_at: subDays(6),
    members: [
      { user_id: 'y1', email: 'manager@academy.gg', role: 'owner', steam_id: null, display_role: 'Manager' },
    ] },
]
const _jsonResp = (obj) => Promise.resolve({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) })
const _origFetch = window.fetch?.bind(window)
window.fetch = (url, opts) => {
  const u = String(url)
  if (u.includes('/api/admin')) {
    const method = (opts?.method || 'GET').toUpperCase()
    return method === 'GET' ? _jsonResp(ADMIN_TEAMS) : _jsonResp({ ok: true })
  }
  if (u.includes('/api/')) return _jsonResp([])
  return _origFetch ? _origFetch(url, opts) : _jsonResp({})
}

// Override the module loader — when supabase.js is imported, return our mock.
// We do this by intercepting via import map (set by inject script in HTML).
window.__designMockSupabase = mockSupabase
window.__designMockFake = FAKE
console.log('[DESIGN PREVIEW] supabase mocked with', Object.keys(FAKE).length, 'fake tables')
