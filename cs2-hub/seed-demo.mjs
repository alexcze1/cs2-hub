/**
 * Demo team seeder — fills every feature with realistic data
 * Run: SUPABASE_SERVICE_ROLE_KEY=<key> node cs2-hub/seed-demo.mjs
 */

const TEAM_ID = 'ca6ebd30-1eec-4798-8471-42664d27313c'
const SUPABASE_URL = 'https://yujlmvqxffkojsokcdiu.supabase.co'
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function post(table, rows) {
  if (!rows.length) return
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(rows)
  })
  if (!res.ok) { const e = await res.text(); throw new Error(`${table}: ${e}`) }
  console.log(`  ✓ ${table}: ${rows.length} rows`)
}

async function del(table) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?team_id=eq.${TEAM_ID}`, {
    method: 'DELETE', headers: H
  })
}

const T = TEAM_ID
const d = (daysOffset) => new Date(Date.now() + daysOffset * 86400000).toISOString()
const dt = (daysOffset, h = 12, m = 0) => {
  const x = new Date(Date.now() + daysOffset * 86400000)
  x.setHours(h, m, 0, 0); return x.toISOString()
}

// ─────────────────────────────────────────────────────────────
// ROSTER
// ─────────────────────────────────────────────────────────────
const PLAYERS = ['ZWO', 'NKO', 'MAT', 'ZYW', 'APX']
const roster = [
  { team_id: T, username: 'ZWO', real_name: 'Casper Eriksson', role: 'IGL',     nickname: 'zwo' },
  { team_id: T, username: 'NKO', real_name: 'Nikolas Jensen',  role: 'AWPer',   nickname: 'nko' },
  { team_id: T, username: 'MAT', real_name: 'Mathias Laursen', role: 'Entry',   nickname: 'mat' },
  { team_id: T, username: 'ZYW', real_name: 'Zywan Koch',      role: 'Support', nickname: 'zyw' },
  { team_id: T, username: 'APX', real_name: 'Alex Persson',    role: 'Lurker',  nickname: 'apx' },
]

// ─────────────────────────────────────────────────────────────
// KEYWORDS
// ─────────────────────────────────────────────────────────────
const keywords = [
  { team_id: T, name: 'Karrigan', description: 'Stack a site hard and send one player aggressive for info. If info-taker dies, hold the stacked site with numbers advantage.', category: 'CT Reaction' },
  { team_id: T, name: 'Baghdad',  description: 'Regroup all 5 into one space on CT side after losing map control. Regain with coordinated utility.', category: 'CT Reaction' },
  { team_id: T, name: 'Aleksib',  description: 'Flash-break combo — one player flashes, second breaks through immediately on the blind.', category: 'Utility' },
  { team_id: T, name: 'Snow',     description: 'Double rotate: vent to secret on Nuke. Signal to trigger simultaneous rotation by two players.', category: 'Map Specific' },
  { team_id: T, name: 'Joker',    description: 'Unexpected aggression from an unusual angle to tilt opponent reads. Used when they are passive.', category: 'T Aggression' },
  { team_id: T, name: 'Blitz',    description: 'Full 5-man commitment to one site with maximum utility dump. No fallback, pure execute.', category: 'T Execute' },
  { team_id: T, name: 'Freeze',   description: 'All 5 players hold angles without moving or shooting — bait the opponent into over-rotating then strike.', category: 'CT Passive' },
  { team_id: T, name: 'Ghost',    description: 'Lurker walks fully around the map to enemy spawn timing while team fakes opposite site.', category: 'T Lurk' },
]

// ─────────────────────────────────────────────────────────────
// GOALS
// ─────────────────────────────────────────────────────────────
const goals = [
  { team_id: T, title: 'Reach Top 50 HLTV Ranking', description: 'Consistent results in online qualifiers and open events to accumulate ranking points.', horizon: 'long_term', status: 'active', progress: 18, due_date: '2026-12-31', category: 'competitive', owner: 'ZWO', action_steps: 'Qualify for at least 3 CCT events this season' },
  { team_id: T, title: 'Win a CCT Open Qualifier',   description: 'Qualify through the open bracket of any CCT event — validate we can compete at that level.', horizon: 'long_term', status: 'active', progress: 40, due_date: '2026-07-15', category: 'competitive', owner: 'ZWO', action_steps: 'Enter every open qualifier, minimum 2/month' },
  { team_id: T, title: 'Ancient win rate above 65%', description: 'Our best map needs to be a clear strength. Study top teams\' CT setups and implement 3 new anti-strats.', horizon: 'weekly', status: 'active', progress: 60, due_date: '2026-05-30', category: 'map_pool', owner: 'MAT', action_steps: 'Dedicate 2 scrim blocks per week on Ancient' },
  { team_id: T, title: 'Develop Anubis as 3rd map',  description: 'Currently we only veto Anubis. Need to build a proper playbook and get 10 scrim sessions in.', horizon: 'long_term', status: 'active', progress: 25, due_date: '2026-06-15', category: 'map_pool', owner: 'NKO', action_steps: 'Learn CT setups from pro demos before next Anubis session' },
  { team_id: T, title: 'Improve pistol round win rate to 55%', description: 'We are losing too many pistols — better utility coordination on both sides.', horizon: 'weekly', status: 'active', progress: 35, due_date: '2026-05-15', category: 'individual', owner: 'ZYW', action_steps: 'Watch 10 pro pistol rounds per map and create utility lineups doc' },
  { team_id: T, title: 'Build full antistrat database for top 20 EU teams', description: 'Every team we might face should have a completed gameplan. Currently at 6/20.', horizon: 'long_term', status: 'active', progress: 30, due_date: '2026-08-01', category: 'preparation', owner: 'APX', action_steps: 'Add 2 opponents per week with full CT+T plans' },
]

// ─────────────────────────────────────────────────────────────
// ISSUES
// ─────────────────────────────────────────────────────────────
const issues = [
  { team_id: T, title: 'Losing rounds with man advantage', description: 'Multiple rounds lost when we have 4v2 or 3v1 situations — individual aggression instead of coordinated close-out.', category: 'teamplay', status: 'active', priority: 'high', actions: 'Call "freeze" keyword. IGL dictates who pushes, others hold crossfire. No solo peeking in advantage situations.' },
  { team_id: T, title: 'Weak T-side mid round calling', description: 'After first contact we default to holding rather than adapting. Opponents read our patterns and punish our inactivity.', category: 'tactical', status: 'active', priority: 'high', actions: 'IGL calls site direction within 5s of info. Use "Joker" plays when static too long. Review mid-round demos weekly.' },
  { team_id: T, title: 'NKO over-peeks with AWP',  description: 'AWPer is taking risky dry peeks in situations where playing safe would be higher EV. Already cost 4 rounds this week.', category: 'individual', status: 'active', priority: 'medium', actions: 'Pre-agreed AWP zones per map. Only peek outside zones on explicit IGL call.' },
  { team_id: T, title: 'Utility coordination on executes', description: 'Smokes and flashes are thrown at wrong timing — site flashes pop while entry is still out of range.', category: 'tactical', status: 'active', priority: 'medium', actions: 'Standardize exec countdowns: IGL calls GO, smoke first, 1 second delay, then flashes, then entry.' },
  { team_id: T, title: 'Slow rotations on CT side', description: 'Average rotation time is too slow — losing planted bomb rounds because second player arrives 2-3 seconds late.', category: 'teamplay', status: 'active', priority: 'medium', actions: 'Review retake protocols per map. Define rotation triggers based on info, not assumptions.' },
  { team_id: T, title: 'Economy mismanagement after pistol loss', description: 'Team splits on force vs. full save after losing pistol — results in inconsistent buys that put us further behind.', category: 'tactical', status: 'active', priority: 'low', actions: 'Simple rule: lose pistol = full save R2, force R3 together. No split buys. IGL makes final call.' },
]

// ─────────────────────────────────────────────────────────────
// STRATS
// ─────────────────────────────────────────────────────────────
const roles = (a, b, c, d, e) => [
  { player: 'ZWO', role: a }, { player: 'NKO', role: b }, { player: 'MAT', role: c },
  { player: 'ZYW', role: d }, { player: 'APX', role: e }
].filter(r => r.role)

const strats = [
  // ── MIRAGE ──────────────────────────────────────────────────
  { team_id: T, map: 'mirage', side: 't', type: 'default', name: 'Default Mid Split', player_roles: roles('Flash mid, support ramp','Smoke window or topmid, lurk conn','Entry ramp off flashes','Flash mid, run short and take space','Smoke topmid, hold B aps'), notes: 'Standard mid-take into flexible ending. Keep smokes for site hit.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'mirage', side: 't', type: 'strat', name: 'A Fast Execute', player_roles: roles('Run conn, fight fast','Smoke topmid, go ramp and swing','Smoke topmid, close ramp swing','Flash behind mid 2x, run short','Close ramp, take peeks'), notes: 'Fast 2-mid into early A split. Spawn-based between MAT/APX.\n\nWork well after winning mid first 2 rounds to condition CT habits.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'mirage', side: 't', type: 'strat', name: 'B Execute', player_roles: roles('Smoke window/topmid, flash mid, lurk conn','Smoke window/topmid, B aps, entry window','B aps, smoke kitchen window, 2x flash aps','Drop molly, smoke stairs, path window','Flash short 2x above aps, hold flank'), notes: 'Standard B anti-eco. Throw mollies on pop and commit through.\n\nZWO lurks conn, others commit B on smoke pop.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'mirage', side: 't', type: 'opening', name: 'Mid Rush', player_roles: roles('Flash behind mid 2x on call','Smoke window, go mid, push conn','Close ramp, swing mid','Flash conn, run close conn','Smoke bottom conn, B aps flash support'), notes: 'Punish CT playing passive mid. Spawn-based MAT/APX.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'mirage', side: 't', type: 'anti_eco', name: 'Palace Rush', player_roles: roles('Run conn, fight fast','Flash 2x palace, refrag','Smoke stairs+jungle, up ramp with MAT','Molly shadow, site on flash','Smoke CT, lampflash, hold ramp'), notes: 'Full A exec early. Can continue mid after second-wave fake.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'mirage', side: 't', type: 'ender', name: 'A Split Wrap', player_roles: roles('Smoke jungle, push bench','Lurk A from palace','Window boost, kill jungle back','Push stairs on pop','Flash conn from short, ticket lurk'), notes: 'Mid-heavy A split anti 3A setup. Need 2nd wave mid done first.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'mirage', side: 'ct', type: 'default', name: '1-1-3 Standard', player_roles: roles('Hold A from default/shadow','Flash mid, window AWP','Play B aps, flash out kitchen','Hold topmid, smoke conn','Peek short, rotate A/B'), notes: '2+1 Rule applies. NKO takes mid info before committing.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'mirage', side: 'ct', type: 'setup', name: 'Double AWP Palace', player_roles: roles('Hold A from ticket, hard side','AWP ramp from stairs','Push palace, hold entry','Hold B tight','Smoke window, hold under'), notes: 'Hard side A with double presence — force them into B.\n\nAPX delays B to late round then locks rotation.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'mirage', side: 'ct', type: 'opening', name: 'Short Aggro', player_roles: roles('Flash 2x above chair, shadow hold','Flash above mid, smoke conn','B standard, flash mid if needed','Run conn, swing out on flashes','Molly boxes, rotate A'), notes: 'Fast short aggro to punish T passive mid. ZYW entry conn.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'mirage', side: 't', type: 'pistol', name: 'B Delay Pistol', player_roles: roles('Smoke+flash+p250, drop to NKO, kitchen window + flash','Drop util to NKO, B aps, hold entry window','Hold B aps and path car on pop','Hold topmid, go out on util, lurk under window','Hold mid, smoke conn + molly window, B aps refrag'), notes: 'Delayed B pop off mid noise. Deceptive — looks like mid take.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'mirage', side: 'ct', type: 'pistol', name: 'B Stack', player_roles: roles('Go short, hold aps','2x dualies + flash, hold mid from window','Jail antiflash','Conn with dualies','Default B / jumpspot aps on B'), notes: 'Stack B early, rotate A if they go ramp. NKO calls rotate.', tags: [], updated_at: new Date().toISOString() },

  // ── ANCIENT ─────────────────────────────────────────────────
  { team_id: T, map: 'ancient', side: 't', type: 'opening', name: 'Heaven Pop', player_roles: roles('Smoke window, molly jungle, go out elbow','Run lane, smoke molly, call flashes for mid','Molly ramp, run heaven, refrag ZWO, hold cave push','Drop flash for NKO, mid util, go out elbow on flashes','Smoke cave, flash rightside 2x when ZWO calls'), notes: 'Double nade mid take with heavy flashes.\n\nGood against meta fast mid takes.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'ancient', side: 't', type: 'strat', name: 'B Rush Spawn Based', player_roles: roles('Run ramp, focus long/short','Run ramp, presmoke molly, run long, refrag site','Smoke B lane molly, molly deep CT, run towards site','Flash 2x above site, go up ramp [BOMB]','Smoke window, smoke cave, hold flank'), notes: 'Full B rush with site flashes. Works well on force buys.\n\nSPAWN BASED — ZWO calls which version.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'ancient', side: 'ct', type: 'opening', name: 'Mid Counter', player_roles: roles('Rush cave close mid with smoke on molo','Fight out cave','Play B, react on info','Jump heaven','Smoke elbow, 2x leftside flashes'), notes: 'Counter vs T mid meta. Extra good if they rarely go heaven.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'ancient', side: 't', type: 'anti_eco', name: 'B Anti-Eco Full Exec', player_roles: roles('Long molo, 2x flashes behind ramp, hold cave','Smoke cave, smoke short, molo backsite, follow entries','Molo long + HE long, entry long','Molo ramp, nade long, entry long','Smoke cave, molo ninja + flash on entry'), notes: 'Full B exec anti-eco. High commitment — do not fake.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'ancient', side: 'ct', type: 'force', name: 'Cave Crunch', player_roles: roles('Throw lane util, run out cave and clear mid','Run out cave and clear mid','Go donut and swing on flashes','Smoke elbow, swing donut on flashes','Smoke Nemiga, flash 2x leftside mid'), notes: 'Mid forcebuy play. High risk — only when behind on eco.\n\nSPAWN BASED.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'ancient', side: 't', type: 'strat', name: 'A Contact Walk', player_roles: roles('Hold flashes for mid, walk A','Full send cave','Walk A','Send mid or pop','Smoke donut, walk A'), notes: 'A contact with masked entry. Simple but deceptive after mid default pattern.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'ancient', side: 't', type: 'pistol', name: 'George Bush', player_roles: roles('Smoke+kit, dropped flash, left corner cave, if A go main','Duelis, hide cave Zeus corner, if A go main','2x duelis+flash, drop util, play donut left, if B go ramp','Duelis, play box cave, if A go main','Go donut, hold back right, if B go ramp'), notes: 'Good retake for both sites — punish core positions.\n\nStay in positions overly long to bait.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'ancient', side: 't', type: 'ender', name: '3 Donut Pop', player_roles: roles('Swing donut, molly behind block, push','Smoke CT from heaven, flash donut, hold flank','Play late A main','Swing donut on flash, refrag','Follow donut / smoke CT + flash deep'), notes: 'Fast A split through heaven flashes. Need smoke + 2x flash + molly.\n\nGood early in round — ZWO calls timing.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'ancient', side: 'ct', type: 'pistol', name: 'Coffee Pistol', player_roles: roles('Smoke+molo+flash, chill B doors, site combo on cave take','Smoke window, p250 drop, give flash, hold banana','Hold cave and take late','Get into window lurk through mid','P250, get NKO to window, peek donut, then cave, end B'), notes: 'Mid lurk into cave pistol. ZYW lurks through mid timing.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'ancient', side: 't', type: 'script', name: 'Double A Take', player_roles: roles('Smoke window, flash 2x A, hold elbow, lurk mid','Drop smoke outside A, hold push, walk close, molly bigbox, path donutwall','Smoke CT early, resmoke CT+donut on re-exec, go A','Smoke donut early, hold A push, walk close, molly temple','Drop smoke outside A, popflash + leftside + molly backsite, path bigbox'), notes: 'Coordinated double A take. ZWO lurks mid as safety.\n\nExecute after 2nd wave pressure.', tags: [], updated_at: new Date().toISOString() },

  // ── NUKE ────────────────────────────────────────────────────
  { team_id: T, map: 'nuke', side: 'ct', type: 'strat', name: 'Door Lurk Setup', player_roles: roles('Molly door, block early, go hut, swing on ramp contact','Molly ramp, close swing on flash, clear lobby','Optional hut nades, get close hut, swing on ramp contact','Peek ramp early, close swing on flash, clear lobby','Molly yard + flash early, go ramp, flash deep, rotate'), notes: 'Strong vs T teams that open ramp fast. APX holds outside late.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'nuke', side: 't', type: 'strat', name: 'Secret Walk into Ramp', player_roles: roles('Take secret, molly double, clear single, go vents','Smoke both navi, hold door push, go hut late','Optional door nades, molly vents, hold hut from exit','Molly secret early, walk down, refrag ZWO, go to main','Molly ramp push, hold ramp from corner, smoke main on A hit'), notes: 'Secret pressure with lobby hold early. Lobby calls B/A on info.\n\nSPAWN BASED.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'nuke', side: 't', type: 'strat', name: 'Ramp Pop', player_roles: roles('Molly tophut, flash close ramp, refrag','Smoke yard, close ramp, swing on flashes, clear rightside','Door util, bounce flash deep','Yard pressure, any angle','Start anywhere, throw 2x D flashes on call, hold/block hell'), notes: 'Early ramp pop through smoke. Can commit B or leave lurk.\n\nAPX stays flexible — commits where info points.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'nuke', side: 't', type: 'strat', name: 'A Full Exec', player_roles: roles('Smoke both navi, flash africa, silo with hut molly, late lobby','Drop smoke for ZYW, hold hut push, molly backsite + 2x flash, come hut','Drop smoke for MAT, door pressure, swing out on flashes','Drop smoke for ZYW, pressure close yard, go door, popflash on break','Standard yard smoke delay, break door smoke, smoke main, flash main'), notes: 'A exec after 2nd wave yard util.\n\nCare early lobby aggro — check before committing door.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'nuke', side: 't', type: 'anti_eco', name: 'Fast A Anti-Eco', player_roles: roles('Molo hut, smoke main, flash main, go hut','Molo tetris, entry','Molo main, cover heaven','Hut bait','Smoke heaven, molo backsite, flash, hold lobby'), notes: 'Fast A ending anti-eco. Throw all util immediately on round start.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'nuke', side: 't', type: 'ender', name: 'B Single Ending', player_roles: roles('Smoke single + flash behind silo','Molly vents, go out double on single util','Lobby whatever','Go out double on single util','Open single, preaim ramp'), notes: 'Ideally NKO AWP single peek ramp. Need smoke + flash.\n\nStay disciplined — no early gives.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'nuke', side: 'ct', type: 'setup', name: 'AWP Ramp Start', player_roles: roles('Start A normal','Drop util under heaven, play leftside garage','Start A normal','Start yard normal, play around CT area','Start AWP ramp'), notes: 'AWP ramp start good vs teams that split mid/outside.\n\nZWO first rotation to ramp on info.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'nuke', side: 't', type: 'pistol', name: 'Pokemon Pistol', player_roles: roles('Smoke+molly, ready heaven smoke + site molly, go hut','Search yard with ZYW, go main on flash','Smoke+p250 drop, smoke topmain, close bounceflash, swing main','Hold early lobby, push out hut on main split','Get p250, search yard behind red, help main/stay red'), notes: 'Flexible pistol — ZWO calls where to finish based on contacts.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'nuke', side: 'ct', type: 'pistol', name: 'Ramp Bait', player_roles: roles('Smoke+kit, flash dropped, take ramp contact','2x dualies+flash, drop all, go down shadow B','Dualies, behind HS, peek on contact','Dualies, close left, peek on contact','Break window B, play from backsite'), notes: 'Bait ramp — if they go A we retake 3 heaven 2 vent.\n\nIf bomb ramp = RUN UP AND HELP RAMP.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'nuke', side: 't', type: 'ender', name: 'A Main Push', player_roles: roles('Smoke k0nfig, molly credit, push main','Fight out A from hut','Fight out A from door','Push main on flash','Flash main from yard or lobby'), notes: 'A split through main using 3 chokepoints (hut/door/main).\n\nNeed smoke+flash+molly. Main flash can come from door or yard.', tags: [], updated_at: new Date().toISOString() },

  // ── DUST2 ───────────────────────────────────────────────────
  { team_id: T, map: 'dust2', side: 't', type: 'strat', name: 'Long Pop', player_roles: roles('Smoke mid doors, flash 2x above long on call','Go longhouse, call GO, smoke molly, run out long','Drop smoke to MAT, free role towards B','Go longhouse, refrag ZWO','Peek mid early, flash 2x behind long on call'), notes: 'Longpop on a few sec delay. ZWO calls corner smoke.\n\nAPX can peek mid early if spawn is right.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'dust2', side: 't', type: 'strat', name: 'B Tunnels Pop', player_roles: roles('Nade B, run into B','Smoke molly, refrag','Flash 2x windows, run B','Smoke lurksmoke from spawn, flash above B','Smoke doors, flash above B, hold tunnels'), notes: 'Spawn based B rush. ZYW lurksmoke from spawn.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'dust2', side: 't', type: 'strat', name: '3 Man Long', player_roles: roles('Go long, rush out or flash, stay or commit','Go long, rush out or pop on flash, commit/leave','Go long, rush out or pop, commit/leave','Go suicide, molly short, run mid, fight','Peek suicide, search mid, support if needed'), notes: '3 long fight with 2 mid off info. Always leave 1 long.\n\nAPX and ZYW play off info from long contacts.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'dust2', side: 't', type: 'strat', name: 'Long Rush', player_roles: roles('Run long, peek corner if no contact','Presmoke molly, run out','Flash 1x on run, go long','Flash 2x above long','Smoke long corner, flash 2x above long'), notes: 'SPAWN BASED fast take. If no contact = peek corner with flash above pit.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'dust2', side: 't', type: 'ender', name: 'B Split Mid', player_roles: roles('Smoke B split, go mid through windows','Lurksmoke mid, flash through smoke','Lurksmoke B, molly default, push rightside','Go tunnels, molly on contacts, leftside','Molly B as needed, hold angles/flash'), notes: 'B split 3 tunnels playing contacts.\n\nNEED pressure from B + 3 smokes total.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'dust2', side: 't', type: 'ender', name: 'Short CT Drop', player_roles: roles('Smoke 1st, get close, drop CT on flash, fight ramp','Get close short, push out (molly ramp)','Follow short or lurk lower','Entry flash, push out short on flashes','Smoke 2nd, 2x flashes ramp, hold flank'), notes: 'Heavy short exec with CT drop. Need 2 smokes + molly + flashes.\n\n4 or 5 short.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'dust2', side: 'ct', type: 'opening', name: 'Mid + Short Aggro', player_roles: roles('Smoke mid doors, flash 2x above long on call','Smoke long molly, call long flashes','Free role towards B','Flash 2x behind long on call','Peek mid, free role'), notes: 'ZWO fakes long to open mid gaps. APX reads and punishes.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'dust2', side: 'ct', type: 'pistol', name: 'Mid Pistol', player_roles: roles('Dualies+HE+flash, drop dualies to APX, play short ready HE lower','Play short, aim topmid','Solo B from backplat','Go lower with dualies','Short, aim topmid/suicide'), notes: 'Mid heavy setup. Drop dualies to APX for lower presence.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'dust2', side: 't', type: 'pistol', name: 'Open Pistol', player_roles: roles('Smoke+2x flash, outside long, flash long, smoke cross or mid','Jumpspot suicide for lower info','Go outside B, listen/lurk timing','Close long, commit A on entry or go mid','Close long, commit A on entry or go mid'), notes: 'Open-ended pistol. Spawn based who goes suicide.\n\nZYW and APX play off long info.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'dust2', side: 't', type: 'strat', name: 'Ramp Resmoke', player_roles: roles('Can smoke long early, runthrow bounce flash, path up rain','Smoke mid doors, drop flashes B, break smoke, entry left+car','Go tunnels, throw 3x car flashes on pop','Bounce flash tunnels, peek left then path out','Smoke doors, flash above tunnels, molly where contacts'), notes: 'B pop with ramp resmoke pressure. Flash lower early.', tags: [], updated_at: new Date().toISOString() },

  // ── INFERNO ─────────────────────────────────────────────────
  { team_id: T, map: 'inferno', side: 't', type: 'default', name: 'B Default', player_roles: roles('Pressure banana, call info','Smoke mid, go banana with ZWO','Flash banana, entry support','Lurk from mid to A','Slow A push, watch flank'), notes: 'Standard 3B 2 watching A. ZWO calls mid round.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'inferno', side: 't', type: 'strat', name: 'A Fast Execute', player_roles: roles('Smoke CT, flash site, entry short','Smoke library, entry with ZWO','Smoke top of apartments','Flash 2x above site, run apps','Lurk through mid, hold B rotation'), notes: 'Fast A exec off apartments pressure. APX cuts CT rotation.\n\nCall when opponent goes passive A.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'inferno', side: 't', type: 'anti_eco', name: 'B Quick Exec', player_roles: roles('Molly behind car, smoke CT','Molly backsite, smoke mid','Flash 3x over site, entry second','First entry banana, break smoke','Hold mid, come B late to support'), notes: 'Full banana commitment anti-eco. NKO second through car.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'inferno', side: 'ct', type: 'setup', name: 'Double Mid Squeeze', player_roles: roles('Hold B apps with AWP','Aggressive banana hold, early pick','Lurk mid on timing','Hold A arch from close','Close B site, late flank mid'), notes: 'Squeeze mid from both sides on T push.\n\nZWO AWP banana, ZYW cuts mid timing.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'inferno', side: 'ct', type: 'opening', name: 'Banana Aggro', player_roles: roles('Push early banana on flash','Flash 2x banana for ZWO, hold', 'Hold A solo','Boost MAT early, support banana', 'Hold mid from close'), notes: 'Early banana aggro to deny T control. Drop back if no pick.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'inferno', side: 't', type: 'ender', name: 'B Split', player_roles: roles('Smoke CT, push through car','Molly backsite, entry banana', 'Flash above B, second entry','Lurk mid, cut rotation', 'Hold A apps, come late'), notes: 'Classic B split. Time ZWO car push with APX mid rotation cut.\n\nMolly backsite before entry.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'inferno', side: 't', type: 'pistol', name: 'A Pistol Rush', player_roles: roles('Flash apps 2x, entry first','Follow ZWO, smoke library','Third entry, cover CT','Flash 2x above short, apps run','Hold mid, rotate late'), notes: 'Full A rush pistol. ZYW holds mid in case.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'inferno', side: 'ct', type: 'force', name: 'Force Hold Banana', player_roles: roles('Stack banana with MAT','Stack banana with ZWO','AWP banana close','Hold A arch','Hold mid'), notes: 'Force 3 banana, dare them to A. APX holds arch alone.\n\nOnly use on eco round — risky on full buy.', tags: [], updated_at: new Date().toISOString() },

  // ── ANUBIS ──────────────────────────────────────────────────
  { team_id: T, map: 'anubis', side: 't', type: 'default', name: 'Mid Default', player_roles: roles('Pressure mid, call info','Lurk B through water','Entry A on mid contact','Support mid with util','Hold A and lurk canal'), notes: 'Standard flexible round — reads mid info and commits.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'anubis', side: 't', type: 'strat', name: 'A Fast Execute', player_roles: roles('Smoke palace, flash 2x site, entry','Smoke CT, second entry','Flash above site twice, follow','Lurk from B, cut rotation','Third entry, plant cover'), notes: 'Quick A exec. ZWO smokes palace to blind long rotation.\n\nAPX lurks B canal to cut rotate.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'anubis', side: 't', type: 'strat', name: 'B Water Execute', player_roles: roles('Smoke bridge, flash 2x over site','Entry through water first','Molly backsite, second entry','Third entry through water','Hold A to block rotation'), notes: 'Full B through water. Time flash pop with entry movement.\n\nZYW holds A alone — delay rotation.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'anubis', side: 'ct', type: 'default', name: 'Canal Split Hold', player_roles: roles('AWP mid from site','Hold B site close','Hold A aggressive','Hold canal lurk angle','Rotate position, hold B halls'), notes: 'Split canal control — ZWO AWP mid early picks.\n\nMAT aggressive A to create space.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'anubis', side: 'ct', type: 'setup', name: 'Stack A', player_roles: roles('3A with AWP','3A support','3A entry hold','1B solo hold','Hold mid and rotate'), notes: 'Hard stack A — dare them to go B 5v1.\n\nOnly use when we read A heavy opponent.', tags: [], updated_at: new Date().toISOString() },
  { team_id: T, map: 'anubis', side: 't', type: 'pistol', name: 'Mid Pistol Control', player_roles: roles('Rush mid, pressure hard','Flash mid for ZWO','Support mid, hold B','Rush B on mid contact','Flash B on timing'), notes: 'Take mid fast pistol — build pressure for next round read.', tags: [], updated_at: new Date().toISOString() },
]

// ─────────────────────────────────────────────────────────────
// OPPONENTS (antistrat)
// ─────────────────────────────────────────────────────────────
const mkPlan = (pistols, style, antiecos, forces, tend, exploits, solutions) => ({
  pistols, style, antiecos, forces, tendencies: tend, exploits, solutions
})
const mkPos = (A, B, AWP, MID, extra = '') => ({ A, B, AWP, MID, ...(extra ? { EXTRA: extra } : {}) })

const opponents = [
  {
    team_id: T, name: 'Natus Vincere', favored_maps: ['nuke', 'inferno', 'ancient'],
    antistrat: {
      nuke: {
        ct_plan: mkPlan('Stack B, push banana early R1', 'Reactive, info-based. AWP repositions each round.', 'Stack mid + apps. Watch for B rush.', 'Full B stack. Don\'t push mid.', 'Fast rotates on any info. AWP repositions without flashing.', 'Weak to mid flash before 20s. Connector smoke timing inconsistent.', 'Flash mid pre-20s. Fake B, rotate, split A.'),
        t_plan: mkPlan('Force B rush R2. All-in banana.', 'Slow default, heavy mid first 30s.', 'Stack B, force pick banana.', 'Push mid immediately, deny info.', 'Slow default, heavy mid. Almost never eco rushes.', 'Plant timing predictable B site. Late rotates from mid.', 'Deny banana before 20s. Fake B early, split A late.'),
        ct_positions: mkPos('1 anchor', '2 banana', '1 ramp', '1 IGL roam'),
        t_positions: mkPos('2 B default', '1 long', '1 mid', '1 lurk'),
      }
    },
    ct_gameplan: {}, t_gameplan: {}, updated_at: new Date().toISOString()
  },
  {
    team_id: T, name: 'MOUZ', favored_maps: ['ancient', 'mirage', 'dust2'],
    antistrat: {
      ancient: {
        ct_plan: mkPlan('Aggressive cave R1, play tight.', 'Aggressive, info-forward. Always pushing.', 'Rush cave early to deny eco rush.', 'All rush cave, don\'t play passive.', 'Fast rotates, heavy cave presence first 20s.', 'Weak to B fake into A. Over-rotates cave.', 'Fake cave, hard A main walk with lane smoke.'),
        t_plan: mkPlan('Take mid fast pistol.', 'Heavy mid take into flexible ending.', 'Full B on eco round.', 'Fast B force, no util needed.', 'Slow default when full buy, fast mid when half-buy.', 'Late cave entries — punishable with early swing.', 'Swing cave early with 2 rifles + flash support.'),
        ct_positions: mkPos('2 cave', '1 B door', '1 mid', '1 A main'),
        t_positions: mkPos('1 A main', '2 B', '1 mid', '1 cave'),
      }
    },
    ct_gameplan: {}, t_gameplan: {}, updated_at: new Date().toISOString()
  },
  {
    team_id: T, name: 'G2 Esports', favored_maps: ['mirage', 'inferno', 'anubis'],
    antistrat: {
      mirage: {
        ct_plan: mkPlan('Passive B pistol, lurk short.', 'Patient, angle-based. AWP topmid.', 'Full B stack on eco.', 'Rush short on force.', 'Very patient CT — wait for T over-aggression. AWP topmid baits.', 'Slow to rotate off mid take. Leave topmid uncontested.', 'Fake B 2nd wave, smoke topmid instantly, split A on rotation.'),
        t_plan: mkPlan('Mid rush R1.', 'Heavy mid take, early A endings.', 'Full palace rush on eco.', 'Rush ramp on force, no util.', 'Always through mid — control and then split A or B.', 'Predictable A endings after mid. CT stacks ramp.', 'Fake mid, full B execute. Smoke window, go aps.'),
        ct_positions: mkPos('1 A site', '1 B aps', '1 topmid', '1 short', '1 rotator'),
        t_positions: mkPos('2 ramp', '2 mid', '1 palace lurk'),
      }
    },
    ct_gameplan: {}, t_gameplan: {}, updated_at: new Date().toISOString()
  },
  {
    team_id: T, name: 'Astralis', favored_maps: ['inferno', 'nuke', 'mirage'],
    antistrat: {
      inferno: {
        ct_plan: mkPlan('Stack banana 3 pistol.', 'Textbook — very structured setups.', 'Always 3 banana on eco. Predict it.', 'Rush banana, no util force.', 'Rotate off banana fast. Never leave B uncovered long.', 'Slow A rotation — window to plant A before they arrive.', 'Fast A exec when they stack banana. Smoke library+CT.'),
        t_plan: mkPlan('Full A apps rush pistol.', 'Methodical — do not rush. Patient execute.', 'Eco B rush with 2 fast, 3 hold mid.', 'Force A with utility even on half-buy.', 'Slow controlled banana. Methodical site exec.', 'Predictable banana timing. Always 1.20 car contact.', 'Aggressive early pick banana before 1.20. Force early decision.'),
        ct_positions: mkPos('1 arch', '3 banana', '1 mid', ''),
        t_positions: mkPos('2 apps', '2 banana', '1 mid lurk'),
      }
    },
    ct_gameplan: {}, t_gameplan: {}, updated_at: new Date().toISOString()
  },
  {
    team_id: T, name: 'Team Vitality', favored_maps: ['dust2', 'ancient', 'nuke'],
    antistrat: {
      dust2: {
        ct_plan: mkPlan('Passive B pistol, long hold.', 'Passive — wait and react. ZywOo mid.', 'Rush B tunnels on eco.', 'Force long 3 on force.', 'ZywOo holds mid from B doors. Very patient.', 'Passive mid — can abuse with early long push.', 'Rush long early before ZywOo sets up mid.'),
        t_plan: mkPlan('2 long, 3 B tunnels pistol.', 'Long into split — never straight B.', 'Full B rush eco.', 'Force long 3.', 'Always 2-3 long. Very rarely pure B push.', 'Predictable — always long entry attempt.', 'Stack long 4, hard A fake with lurk through mid to B.'),
        ct_positions: mkPos('1 long', '2 B', '1 mid doors', '1 short'),
        t_positions: mkPos('3 long', '2 B tunnel', '', 'ZywOo mid'),
      }
    },
    ct_gameplan: {}, t_gameplan: {}, updated_at: new Date().toISOString()
  },
  {
    team_id: T, name: 'FURIA', favored_maps: ['ancient', 'mirage', 'overpass'],
    antistrat: {
      ancient: {
        ct_plan: mkPlan('Rush cave pistol all-in.', 'Hyper-aggressive, chaotic. Difficult to read.', 'Rush everything on eco.', 'Force rush cave every time.', 'FURIA rushes every round. Condition with passive, punish aggression.', 'Over-extend cave — easy to retake when isolated.', 'Let them rush, hold close angles, isolate entries one by one.'),
        t_plan: mkPlan('All 5 cave rush, no util.', 'Rush-heavy. Very fast paced.', 'Eco rush no util.', 'Force rush all-in.', 'Every round is a rush. Never slow. Always early contacts.', 'No mid-round adaptation. Easy to predict with early stack.', 'Stack cave 4 early, one B. Let them walk into numbers disadvantage.'),
        ct_positions: mkPos('1 cave', '2 B', '1 mid', '1 A main'),
        t_positions: mkPos('0 A', '1 B', '4 cave', ''),
      }
    },
    ct_gameplan: {}, t_gameplan: {}, updated_at: new Date().toISOString()
  },
]

// ─────────────────────────────────────────────────────────────
// SCHEDULE EVENTS
// ─────────────────────────────────────────────────────────────
const events = [
  // Past
  { team_id: T, title: 'Scrim vs MOUZ', type: 'scrim', date: dt(-28, 19, 0), end_date: dt(-28, 21, 0), opponent: 'MOUZ', notes: 'Focus on Ancient CT side and Nuke executes' },
  { team_id: T, title: 'VOD Review — MOUZ Scrim', type: 'vod_review', date: dt(-26, 18, 0), end_date: dt(-26, 19, 30), opponent: null, notes: 'Review mid-round calling issues from Monday' },
  { team_id: T, title: 'Scrim vs Astralis', type: 'scrim', date: dt(-24, 20, 0), end_date: dt(-24, 22, 0), opponent: 'Astralis', notes: 'Map pool: Inferno, Mirage, Ancient' },
  { team_id: T, title: 'Team Meeting — Map Pool', type: 'meeting', date: dt(-22, 17, 0), end_date: dt(-22, 18, 0), opponent: null, notes: 'Decide on 3rd map pick. Anubis vs Overpass discussion.' },
  { team_id: T, title: 'CCT Open Qualifier — vs G2', type: 'tournament', date: dt(-20, 15, 0), end_date: dt(-20, 17, 0), opponent: 'G2 Esports', notes: 'Best of 3. Veto order: we ban Inferno, they ban Dust2' },
  { team_id: T, title: 'CCT Open Qualifier — vs NaVi', type: 'tournament', date: dt(-20, 18, 30), end_date: dt(-20, 20, 30), opponent: 'Natus Vincere', notes: 'Semifinal — winner makes it to main event' },
  { team_id: T, title: 'Scrim vs Vitality', type: 'scrim', date: dt(-17, 19, 0), end_date: dt(-17, 21, 0), opponent: 'Team Vitality', notes: null },
  { team_id: T, title: 'VOD Review — Tournament', type: 'vod_review', date: dt(-15, 18, 0), end_date: dt(-15, 19, 30), opponent: null, notes: 'Full review of both tournament maps. ZWO leads session.' },
  { team_id: T, title: 'Scrim vs FURIA', type: 'scrim', date: dt(-13, 20, 0), end_date: dt(-13, 22, 0), opponent: 'FURIA', notes: 'Practice anti-rush protocols on Ancient and Nuke' },
  { team_id: T, title: 'Utility Workshop', type: 'meeting', date: dt(-10, 17, 30), end_date: dt(-10, 18, 30), opponent: null, notes: 'ZYW leads. Standardise exec smoke+flash timing across all maps.' },
  { team_id: T, title: 'Scrim vs MOUZ', type: 'scrim', date: dt(-7, 19, 0), end_date: dt(-7, 21, 0), opponent: 'MOUZ', notes: 'Rematch. Focus on improvements from last session.' },
  { team_id: T, title: 'Scrim vs Astralis', type: 'scrim', date: dt(-5, 20, 0), end_date: dt(-5, 22, 0), opponent: 'Astralis', notes: 'Map pool: Nuke, Inferno' },
  { team_id: T, title: 'VOD Review — Weekly', type: 'vod_review', date: dt(-3, 18, 0), end_date: dt(-3, 19, 30), opponent: null, notes: 'Review last 3 scrims. Focus on pistol rounds and advantage rounds.' },
  // Future
  { team_id: T, title: 'Scrim vs G2 Esports', type: 'scrim', date: dt(2, 19, 0), end_date: dt(2, 21, 0), opponent: 'G2 Esports', notes: 'Prepare for upcoming qualifier. Focus on Mirage.' },
  { team_id: T, title: 'Scrim vs Natus Vincere', type: 'scrim', date: dt(4, 20, 0), end_date: dt(4, 22, 0), opponent: 'Natus Vincere', notes: 'Nuke + Ancient block' },
  { team_id: T, title: 'CCT Qualifier Day 1', type: 'tournament', date: dt(7, 14, 0), end_date: dt(7, 18, 0), opponent: 'TBD', notes: 'Group stage. Check bracket morning of event.' },
  { team_id: T, title: 'CCT Qualifier Day 2', type: 'tournament', date: dt(8, 14, 0), end_date: dt(8, 18, 0), opponent: 'TBD', notes: 'Playoff stage if we qualify through groups' },
  { team_id: T, title: 'Recovery VOD Session', type: 'vod_review', date: dt(10, 18, 0), end_date: dt(10, 19, 30), opponent: null, notes: 'Post-tournament review' },
  { team_id: T, title: 'Scrim vs Vitality', type: 'scrim', date: dt(12, 19, 0), end_date: dt(12, 21, 0), opponent: 'Team Vitality', notes: null },
  { team_id: T, title: 'Team Strategy Meeting', type: 'meeting', date: dt(14, 17, 0), end_date: dt(14, 18, 0), opponent: null, notes: 'Quarterly debrief. Review goals, map pool decisions, roster check-in.' },
]

// ─────────────────────────────────────────────────────────────
// VODS / MATCH RESULTS
// ─────────────────────────────────────────────────────────────
const mkMap = (map, us, them, overview, ct, t) => ({
  map, score_us: us, score_them: them,
  notes: { overview, ct_side: ct, t_side: t }
})

const vods = [
  {
    team_id: T, opponent: 'Natus Vincere', match_type: 'scrim', match_date: d(-28).slice(0,10), result: 'win', maps: [
      mkMap('mirage', 16, 12, 'Dominant CT half, 11-4 going in. T side was clean mid-rounds.', 'Excellent banana control early. NKO AWP impact very high. Only 1 rotation error round 19.', 'Mid control led to easy A exec in 4 rounds. B default worked well with APX lurk.'),
      mkMap('ancient', 13, 16, 'Lost cave control too early. Good comeback 2nd half but not enough.', 'Cave control was poor — gave NaVi free info every round.', 'Good T side but started 3-8 CT. Too much to climb back.'),
    ]
  },
  {
    team_id: T, opponent: 'MOUZ', match_type: 'scrim', match_date: d(-24).slice(0,10), result: 'loss', maps: [
      mkMap('nuke', 11, 16, 'Lost ramp control completely. MOUZ exploited our slow rotation.', 'Let them take ramp every round. AWP not impactful enough inside.', 'Executes were slow — smokes popped before entries were close enough.'),
      mkMap('inferno', 14, 16, 'Very close. Lost in overtime. Pistol both rounds went to them.', 'Good setups, banana control solid. Lost two clutch rounds mid-half.', 'T side pressure was good but exec timing inconsistent on A.'),
    ]
  },
  {
    team_id: T, opponent: 'G2 Esports', match_type: 'tournament', match_date: d(-20).slice(0,10), result: 'win', maps: [
      mkMap('ancient', 16, 9, 'Completely outplayed G2 on CT. B rush strat worked perfectly round 1.', 'Shut down their mid every round. Cave control was dominant.', 'After winning CT 11-4, T side was easy. Comfort played well.'),
      mkMap('mirage', 16, 14, 'Close match. Won in 30 rounds. Mid control was key.', 'Held mid every round. Only gave up short once — retook instantly.', 'A execute worked 3 times in a row. They never adjusted.'),
    ]
  },
  {
    team_id: T, opponent: 'Natus Vincere', match_type: 'tournament', match_date: d(-20).slice(0,10), result: 'loss', maps: [
      mkMap('nuke', 9, 16, 'Poor performance. NaVi dominated ramp. Lost every ramp fight.', 'Couldn\'t hold ramp consistently. AWP timing was off — gave too many free entries.', 'T side was passive — never committed to executes. Stalled too long mid-round.'),
      mkMap('inferno', 13, 16, 'Close but lost key rounds. Banana control was inconsistent.', 'Good arch holds. Lost 3 rounds from late B rotations.', 'A execute timing was great. Lost it in banana fights we should avoid.'),
    ]
  },
  {
    team_id: T, opponent: 'Team Vitality', match_type: 'scrim', match_date: d(-17).slice(0,10), result: 'win', maps: [
      mkMap('dust2', 16, 10, 'Long control dominant. ZywOo was quiet — our mid flash cut him off.', 'Mid flash strategy worked — ZywOo had 0 impact mid.', 'Long rush strat worked twice. They never adjusted their long setup.'),
      mkMap('mirage', 16, 13, 'Good map. Palace rush caught them twice on T.', 'AWP held topmid perfectly. Short aggro gave us 3 free picks.', 'Palace rush round 4 and 22 both worked. Should keep this pattern.'),
    ]
  },
  {
    team_id: T, opponent: 'FURIA', match_type: 'scrim', match_date: d(-13).slice(0,10), result: 'win', maps: [
      mkMap('ancient', 16, 7, 'Anti-rush protocols worked perfectly. FURIA had no answer.', 'Held every cave rush with 2-3 players. Never gave up free cave.', 'T side was clean — after winning CT 11-4 had enough buffer.'),
      mkMap('nuke', 16, 11, 'FURIA struggled in structured maps. Our ramp setups held well.', 'Ramp control was excellent. Never gave up ramp for free.', 'Secret walk into ramp caught them twice. Great strat execution.'),
    ]
  },
  {
    team_id: T, opponent: 'MOUZ', match_type: 'scrim', match_date: d(-7).slice(0,10), result: 'draw', maps: [
      mkMap('inferno', 16, 14, 'Won Inferno. Banana control much better than last time.', 'B site holds improved — only gave up banana once round 12.', 'A execute timing fixed — smokes and flashes coordinated properly now.'),
      mkMap('ancient', 14, 16, 'Lost Ancient. Cave control still an issue.', 'Mid control unstable — need dedicated cave player every round.', 'T side good but gave up too many CT-side advantage rounds.'),
    ]
  },
  {
    team_id: T, opponent: 'Astralis', match_type: 'scrim', match_date: d(-5).slice(0,10), result: 'win', maps: [
      mkMap('nuke', 16, 12, 'Clean win. Ramp pop strat caught them 3 times.', 'Outside hold was very strong. AWP had great ramp peeking positions.', 'Ramp pop round 4, 11, 24 all worked. Astralis didn\'t adjust.'),
      mkMap('mirage', 16, 14, 'Close but won. B execute end rounds were decisive.', 'Good mid control. Only gave up short twice all half.', 'Mid to B split in rounds 22 and 27 won us the match.'),
    ]
  },
]

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log('Clearing existing demo data…')
  for (const t of ['roster','keywords','goals','issues','strats','events','vods','opponents']) await del(t)

  console.log('\nSeeding…')
  await post('roster',    roster)
  await post('keywords',  keywords)
  await post('goals',     goals)
  await post('issues',    issues)
  await post('strats',    strats)
  await post('events',    events)
  await post('vods',      vods)
  await post('opponents', opponents)

  console.log('\n✅ Demo team fully seeded!')
  console.log(`   ${roster.length} players · ${keywords.length} keywords · ${goals.length} goals · ${issues.length} issues`)
  console.log(`   ${strats.length} strats · ${events.length} events · ${vods.length} matches · ${opponents.length} opponents`)
}

main().catch(e => { console.error(e); process.exit(1) })
