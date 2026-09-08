/**
 * Basketplan Sync — ported from bp_sync_lib.js
 *
 * Fetches basketball games and rankings from Basketplan XML API
 * and upserts into Directus via knex.
 */

import { sweepGameAutoConfirm } from './game-auto-confirm-sweep.js'

const BP_BASE = 'https://www.basketplan.ch'
const BP_CLUB_ID = 166

/** Normalize season string to short format: "2025/2026" → "2025/26" */
function normalizeSeason(s) {
  if (!s) return s
  const m = s.match(/^(\d{4})\/(\d{4})$/)
  return m ? `${m[1]}/${m[2].slice(2)}` : s
}

const HALL_MAP = {
  'Kantonsschule Wiedikon 2fach': 'KWI A',
  'Kantonsschule Wiedikon 1fach': 'KWI C',
}

const STATUS_MAP = {
  upcoming: 'scheduled',
  played: 'completed',
  postponed: 'postponed',
  cancelled: 'postponed',
}

// ── XML helpers ─────────────────────────────────────────────────────

function getAttr(xml, attr) {
  const re = new RegExp(attr + '="([^"]*)"')
  const m = xml.match(re)
  return m ? m[1] : ''
}

function parseGames(teamXml, teamIdSet) {
  const games = []
  const gameBlocks = teamXml.split('<GameVO ').slice(1)

  for (const block of gameBlocks) {
    const fullBlock = block.split('</GameVO>')[0] || block
    const id = getAttr(fullBlock, ' id')
    if (!id) continue

    const gameNumber = getAttr(fullBlock, 'gameNumber')
    const yearMonthDay = getAttr(fullBlock, 'yearMonthDay')
    const timeOfDay = getAttr(fullBlock, 'timeOfDay')
    const withdrawn = getAttr(fullBlock, 'withdrawn') === 'true'

    const homeBlock = fullBlock.match(/<homeTeam\s[^>]*\/>|<homeTeam\s[\s\S]*?<\/homeTeam>/)?.[0] || ''
    const homeTeamName = getAttr(homeBlock, ' name')
    const homeTeamId = getAttr(homeBlock, ' id')

    const guestBlock = fullBlock.match(/<guestTeam\s[^>]*\/>|<guestTeam\s[\s\S]*?<\/guestTeam>/)?.[0] || ''
    const guestTeamName = getAttr(guestBlock, ' name')
    const guestTeamId = getAttr(guestBlock, ' id')

    const locBlock = fullBlock.match(/<location\s[^>]*\/>|<location\s[\s\S]*?<\/location>/)?.[0] || ''
    const locName = getAttr(locBlock, ' name') || getAttr(locBlock, 'shortName')
    const locCity = getAttr(locBlock, 'city')
    const locAddr = getAttr(locBlock, 'line1')

    const lhBlock = fullBlock.match(/<leagueHolding\s[\s\S]*?<\/leagueHolding>/)?.[0] || ''
    const leagueBlock = lhBlock.match(/<league\s[\s\S]*?<\/league>/)?.[0] || ''
    const leagueName = getAttr(leagueBlock, 'shortName') || getAttr(lhBlock, 'fullName')
    const seasonBlock = lhBlock.match(/<season\s[^>]*\/>|<season\s[\s\S]*?<\/season>/)?.[0] || ''
    const seasonName = getAttr(seasonBlock, ' name')

    const resultBlock = fullBlock.match(/<result\s[^>]*\/?>/)?.[0] || ''
    const scoreHome = resultBlock ? getAttr(resultBlock, 'homeTeamScore') : ''
    const scoreGuest = resultBlock ? getAttr(resultBlock, 'guestTeamScore') : ''

    const rescheduleRequested = getAttr(fullBlock, 'rescheduleRequested') === 'true'
    const hasScore = scoreHome !== '' && scoreGuest !== ''
    let status = 'upcoming'
    if (withdrawn) status = 'cancelled'
    else if (rescheduleRequested) status = 'postponed'
    else if (hasScore) status = 'played'

    games.push({
      id, gameNumber, date: yearMonthDay, time: timeOfDay,
      homeTeam: homeTeamName, homeTeamId,
      guestTeam: guestTeamName, guestTeamId,
      location: locName, locationCity: locCity, locationAddress: locAddr,
      league: (leagueName || '').trim(), season: normalizeSeason(seasonName),
      status,
      scoreHome: scoreHome !== '' ? parseInt(scoreHome, 10) : 0,
      scoreGuest: scoreGuest !== '' ? parseInt(scoreGuest, 10) : 0,
      isHome: teamIdSet[homeTeamId] === true,
      // An intra-club fixture has BOTH sides in our team set. Recorded here so
      // the upsert can emit one row per KSCW side (audit 2026-08-08, #34).
      isGuestOurs: teamIdSet[guestTeamId] === true,
    })
  }
  return games
}

function extractLeagueHoldingIds(teamXml) {
  const ids = {}
  const lhMatches = teamXml.match(/<leagueHolding[^>]*>/g)
  if (lhMatches) {
    const now = new Date()
    // ⚠ Sep 1, NOT the club's Jun 1 cutover (season.js) — deliberate. This matches
    // BASKETPLAN's season convention against their `from` dates; it is their
    // calendar, not ours, so it must not follow our rollover.
    const seasonPrefix = String(now.getMonth() < 8 ? now.getFullYear() - 1 : now.getFullYear())
    for (const tag of lhMatches) {
      const id = getAttr(tag, ' id')
      const from = getAttr(tag, 'from')
      if (id && from?.startsWith(seasonPrefix)) ids[id] = true
    }
  }
  return ids
}

function parseRankings(rankingXml) {
  const rankings = []
  const lhMatch = rankingXml.match(/<leagueHolding[^>]*fullName="([^"]*)"/)
  const leagueName = lhMatch ? lhMatch[1] : ''
  const seasonMatch = rankingXml.match(/<season[^>]*name="([^"]*)"/)
  const season = seasonMatch ? seasonMatch[1] : ''

  const rankBlocks = rankingXml.split('<Ranking>').slice(1)
  for (const block of rankBlocks) {
    const chunk = block.split('</Ranking>')[0] || block
    const rdMatch = chunk.match(/<rankingDataVO[^>]*\/>/)
    if (!rdMatch) continue
    const rd = rdMatch[0]
    const teamMatch = chunk.match(/<team[^>]*\/>|<team[^>]*>[\s\S]*?<\/team>/)
    if (!teamMatch) continue
    const teamBlock = teamMatch[0]

    rankings.push({
      bpTeamId: getAttr(teamBlock, ' id'),
      teamName: getAttr(teamBlock, ' name'),
      league: leagueName, season: normalizeSeason(season),
      rank: parseInt(getAttr(rd, 'currentRanking'), 10) || 0,
      played: parseInt(getAttr(rd, 'gamesPlayed'), 10) || 0,
      won: parseInt(getAttr(rd, 'victories'), 10) || 0,
      lost: parseInt(getAttr(rd, 'defeats'), 10) || 0,
      pointsFor: parseInt(getAttr(rd, 'totalScoreFor'), 10) || 0,
      pointsAgainst: parseInt(getAttr(rd, 'totalScoreAgainst'), 10) || 0,
      totalPoints: parseInt(getAttr(rd, 'totalPoints'), 10) || 0,
    })
  }
  return rankings
}

// ── Main sync functions ─────────────────────────────────────────────

// Change-detection normalizer, mirrored from sv-sync.js (keep the two in
// sync): values must be normalized before comparing feed data against a pg
// row — pg returns json columns PARSED (String([]) is '' — never equal to the
// '[]' we write), date columns as JS Date objects, and time columns as
// HH:MM:SS while the feed gives HH:MM — the old naive String() coercion
// flagged every BB game as changed on every run, rewriting all rows nightly.
// Exported for tests.
export function cmpVal(f, v) {
  if (v == null) return ''
  if (f === 'sets_json' || f === 'referees_json' || f === 'away_hall_json') {
    return typeof v === 'string' ? v : JSON.stringify(v)
  }
  if (f === 'date') {
    return v instanceof Date
      ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
      : String(v).slice(0, 10)
  }
  if (f === 'time') return String(v).slice(0, 5)
  return String(v)
}

// Update-path guards for fields whose current value the APP owns, not the
// feed. Mutates `data` in place and must run BEFORE the change comparison, so
// a preserved value never registers as a diff that rewrites (and re-notifies)
// the row on every run. Exported for tests.
export function applyLocalGuards(data, existing) {
  // A game cancelled in the app stays cancelled: the feed has no notion of a
  // local cancel and keeps serving the fixture, which used to silently
  // resurrect a game the team was already told is gone. Only an actual
  // result (completed) overrides the cancel. 'cancelled' can only come from
  // the app — a Basketplan withdrawal lands as 'postponed' via STATUS_MAP.
  if (existing.status === 'cancelled' && data.status !== 'completed') {
    data.status = 'cancelled'
  }
  // HALL_MAP resolves only the two KWI home mappings — when it misses, keep
  // the existing (possibly hand-set) hall rather than leaving the key absent,
  // where the comparison reads '' against the real value as a change every
  // run. Same for the away venue json. The feed still wins whenever it
  // resolves a value.
  if (data.hall === undefined) data.hall = existing.hall
  if (data.away_hall_json === undefined) data.away_hall_json = existing.away_hall_json
}

/**
 * One intent per `games` row a Basketplan fixture should produce.
 *
 * An INTRA-CLUB fixture — both sides in our team set — needs TWO rows, one per
 * KSCW team, which is what migration 250's partial unique `games (game_id,
 * kscw_team)` enforces and what sv-sync has always done for volleyball
 * derbies. bp-sync picked a single `kscwBpId` and wrote one row, so the away
 * squad silently got nothing: no `games` row, therefore no participations from
 * `sweepGameAutoConfirm` (it joins `member_teams` on `g.kscw_team`) and no
 * respond_by reminder (audit 2026-08-08, finding 34).
 *
 * Latent when written — all 17 active BB teams sit in distinct Basketplan
 * groups — but migration 287 seeds both `KSC Wiedikon DU18 A` and `DU18 B` into
 * DU18/U20 Rookie, and it goes live the moment DU18 B gets a `teams` row (an
 * explicit TODO in basketballGroups.ts). Fixed ahead of that, because the
 * failure is silent.
 *
 * Both intra-club rows carry OUR hall and no `away_hall_json`: the fixture is
 * at our venue, so it is nobody's away game.
 *
 * Pure, so the one-row-vs-two decision is testable without XML or a database.
 */
export function buildGameIntents(g, hallId, awayHallJson) {
  const intraClub = g.isHome === true && g.isGuestOurs === true
  if (intraClub) {
    return [
      { bpId: g.homeTeamId, type: 'home', hall: hallId, awayHallJson: null },
      { bpId: g.guestTeamId, type: 'away', hall: hallId, awayHallJson: null },
    ]
  }
  return [{
    bpId: g.isHome ? g.homeTeamId : g.guestTeamId,
    type: g.isHome ? 'home' : 'away',
    hall: hallId,
    awayHallJson,
  }]
}

// ── Superseded manual games ─────────────────────────────────────────
//
// Until ProBasket publishes a season into Basketplan there is nothing to sync,
// so the BB planner enters the fixtures agreed at the Spielplansitzung by hand
// (`ManualGameModal` → source='manual', game_id `manual_<uuid>`). Those rows are
// PLACEHOLDERS for a schedule that does not exist upstream yet.
//
// The day Basketplan publishes, bp-sync inserts the real fixtures as
// `bb_<gameNumber>` / source='basketplan' and — before this — left every
// placeholder standing beside them. That is not a cosmetic duplicate: each
// fixture would appear twice in the calendar and the team views, fan out two
// sets of push/email notifications from `trg_games_notify`, and (home games)
// claim the KWI floor twice through `basketball_game_floor_claims` →
// `bb_floor_claims_all`, taking volleyball slots away for a game that exists
// once.
//
// WHAT COUNTS AS SUPERSEDED — three conditions, all required. The rule is
// deliberately narrow: this deletes rows, and the failure mode of being too
// eager (wiping a schedule nobody can reconstruct) is far worse than the
// failure mode of being too shy (a duplicate somebody deletes by hand).
//
//   1. Same (kscw_team, season) as a published Basketplan fixture. A team
//      ProBasket has not published yet keeps its manual schedule untouched —
//      leagues go live at different times (the junior 1. Phase and the senior
//      season do not even share a date window), so a whole-club sweep keyed on
//      "some team got fixtures" would wipe schedules that are still the only
//      copy the club has.
//
//   2. The manual game's date falls INSIDE the published date range for that
//      team+season. A partial publish (Vorrunde only) therefore clears only the
//      part it actually covers; the manual Rückrunde survives until the rest
//      lands, and the next nightly run picks it up as the range grows.
//
//   3. The manual row was created BEFORE the team's first published fixture
//      arrived. This is what makes the rule mean "placeholder", not "manual".
//      A friendly, a tournament or a cup fixture Basketplan does not carry —
//      anything a planner adds AFTER the real schedule is in — is never
//      touched, however well its date lines up.
//
// Idempotent by construction: once swept there is nothing left in range, so
// every subsequent run is two indexed reads and a no-op.
//
// ⚠ A swept game takes its RSVPs with it. `trg_games_0_purge_polymorphic`
// (migration 246) deletes the `participations` and `notifications` that hang
// off it polymorphically — there is no FK, so nothing else would. That is the
// right outcome (the placeholder's date/venue is exactly what the real fixture
// is about to correct, so the answers were given about a different game), but
// it is member data, so the count rides in the return value, the log line and
// the `user_logs` entry rather than disappearing quietly. bp-sync's own
// `sweepGameAutoConfirm` re-asks the squad on the published rows.

/** Local-midnight-safe YYYY-MM-DD for a pg date or a feed string. */
function dateKey(v) {
  if (v == null) return ''
  return v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    : String(v).slice(0, 10)
}

/** ms since epoch for a pg timestamp; null-safe per the caller's fail direction. */
function stamp(v, fallback) {
  if (v == null) return fallback
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime()
  return Number.isFinite(t) ? t : fallback
}

/**
 * Decide which manual rows a published schedule supersedes.
 *
 * Pure — the whole delete decision is testable without a database or the feed,
 * which is the point: this is the function that removes data.
 *
 * @param published rows {kscw_team, season, date, date_created} source='basketplan'
 * @param manual    rows {id, kscw_team, season, date, date_created, ...} source='manual'
 * @returns {{ deleteIds:number[], byTeam:Map, rows:object[] }}
 */
export function planManualSweep(published, manual) {
  // Published envelope per team+season: date range + when the first fixture landed.
  const env = new Map()
  for (const p of published) {
    const key = `${p.kscw_team}|${p.season ?? ''}`
    const d = dateKey(p.date)
    if (!d) continue
    // A published row with no date_created cannot establish WHEN the schedule
    // arrived, and condition 3 is "the manual row predates it". Unknown must
    // therefore push the cutoff to -Infinity, which nothing predates, so the
    // team is simply not swept. +Infinity would do the exact opposite — every
    // manual row counts as earlier and the whole schedule goes. Because the
    // cutoff is a min(), one undated published row makes its team unsweepable;
    // that is the intended direction (skip, never over-delete), and bp-sync
    // always stamps date_created so it should not arise in practice.
    const created = stamp(p.date_created, Number.NEGATIVE_INFINITY)
    const cur = env.get(key)
    if (!cur) env.set(key, { min: d, max: d, firstCreated: created })
    else {
      if (d < cur.min) cur.min = d
      if (d > cur.max) cur.max = d
      if (created < cur.firstCreated) cur.firstCreated = created
    }
  }

  const rows = []
  for (const m of manual) {
    const key = `${m.kscw_team}|${m.season ?? ''}`
    const e = env.get(key)
    if (!e) continue // (1) team+season not published yet
    const d = dateKey(m.date)
    if (!d || d < e.min || d > e.max) continue // (2) outside the published range
    // (3) added after the real schedule arrived → a friendly/cup, not a placeholder.
    // A manual row with no date_created cannot be shown to predate it, so it stays.
    if (stamp(m.date_created, Number.POSITIVE_INFINITY) >= e.firstCreated) continue
    rows.push(m)
  }

  const byTeam = new Map()
  for (const r of rows) {
    const k = `${r.kscw_team}|${r.season ?? ''}`
    byTeam.set(k, (byTeam.get(k) || 0) + 1)
  }
  return { deleteIds: rows.map((r) => r.id), byTeam, rows }
}

/**
 * Delete the manual placeholders a published Basketplan schedule has replaced.
 *
 * `dryRun` returns exactly what a real run would delete, having changed nothing —
 * the preview the planner sees before the first sweep of a season.
 */
export async function sweepSupersededManualGames(db, log, { dryRun = false } = {}) {
  const published = await db('games')
    .where('source', 'basketplan')
    .whereNotNull('kscw_team')
    .select('kscw_team', 'season', 'date', 'date_created')

  if (published.length === 0) {
    return { deleted: 0, rsvpsRemoved: 0, teams: 0, dryRun, rows: [] }
  }

  const teamIds = [...new Set(published.map((p) => p.kscw_team))]
  const manual = await db('games')
    .where('source', 'manual')
    .whereIn('kscw_team', teamIds)
    .select('id', 'kscw_team', 'season', 'date', 'time', 'type',
      'game_id', 'home_team', 'away_team', 'date_created')

  const { deleteIds, byTeam, rows } = planManualSweep(published, manual)
  if (deleteIds.length === 0) {
    return { deleted: 0, rsvpsRemoved: 0, teams: 0, dryRun, rows: [] }
  }

  // RSVPs the delete will take with it (polymorphic — no FK, purged by
  // trg_games_0_purge_polymorphic). Counted BEFORE the delete so the number is
  // reportable either way; `activity_id` is text, `games.id` an integer.
  const rsvpRow = await db('participations')
    .where('activity_type', 'game')
    .whereIn('activity_id', deleteIds.map(String))
    .count({ n: '*' })
    .first()
  const rsvpsRemoved = Number(rsvpRow?.n) || 0

  const teamNames = Object.fromEntries(
    (await db('teams').whereIn('id', [...new Set(rows.map((r) => r.kscw_team))]).select('id', 'name'))
      .map((t) => [t.id, t.name]),
  )
  const detail = rows.map((r) => ({
    id: r.id, game_id: r.game_id, team: teamNames[r.kscw_team] ?? r.kscw_team,
    season: r.season, date: dateKey(r.date), time: String(r.time ?? '').slice(0, 5),
    type: r.type, home_team: r.home_team, away_team: r.away_team,
  }))

  if (dryRun) {
    log.info(`[BP Sync] Manual sweep (DRY RUN): ${deleteIds.length} superseded placeholder(s) across ${byTeam.size} team(s), ${rsvpsRemoved} RSVP(s) would be removed`)
    return { deleted: 0, wouldDelete: deleteIds.length, rsvpsRemoved, teams: byTeam.size, dryRun: true, rows: detail }
  }

  // One transaction, notifications silenced: this is a bulk tidy-up of rows the
  // squad is about to be re-asked about on the published fixtures, not 59
  // separate "game deleted" pushes. GUC is txn-local (migration 095).
  let deleted = 0
  await db.transaction(async (trx) => {
    await trx.raw("SELECT set_config('kscw.skip_games_notify', 'on', true)")
    deleted = await trx('games').whereIn('id', deleteIds).del()
  })

  log.info(`[BP Sync] Manual sweep: deleted ${deleted} superseded placeholder(s) across ${byTeam.size} team(s), ${rsvpsRemoved} RSVP(s) removed`)
  for (const d of detail) {
    log.info(`[BP Sync]   superseded: ${d.team} ${d.date} ${d.time} ${d.home_team} vs ${d.away_team} (${d.game_id})`)
  }
  return { deleted, rsvpsRemoved, teams: byTeam.size, dryRun: false, rows: detail }
}

export async function syncBpGames(db, log, { sweepManual = 'on' } = {}) {
  log.info('[BP Sync] Starting games sync...')

  // Build lookups
  const pbTeams = await db('teams')
    .where('sport', 'basketball')
    .where('active', true) // current-season team only (post-rollover the bb_source_id collides with the archived row)
    .whereNot('bb_source_id', '')
    .select('id', 'bb_source_id', 'features_enabled')
  const bpToPb = Object.fromEntries(pbTeams.map(t => [t.bb_source_id, t]))
  const teamIdSet = Object.fromEntries(pbTeams.map(t => [t.bb_source_id, true]))
  const teamIds = pbTeams.map(t => t.bb_source_id)

  if (teamIds.length === 0) {
    log.warn('[BP Sync] No basketball teams with bb_source_id')
    return { created: 0, updated: 0, errors: 0, leagueHoldingIds: {} }
  }
  log.info(`[BP Sync] ${teamIds.length} basketball teams`)

  const hallRows = await db('halls').select('id', 'name')
  const hallByName = Object.fromEntries(hallRows.map(h => [h.name, h.id]))

  const allGames = []
  const seenIds = {}
  const allLhIds = {}

  for (const teamId of teamIds) {
    try {
      const res = await fetch(
        `${BP_BASE}/findTeamById.do?teamId=${teamId}&clubId=${BP_CLUB_ID}&federationId=10&xmlView=true`,
        { headers: { 'User-Agent': 'KSCW-Sync/1.0' } },
      )
      const xml = await res.text()
      if (!xml || xml.length < 100) continue

      const lhIds = extractLeagueHoldingIds(xml)
      Object.assign(allLhIds, lhIds)

      const games = parseGames(xml, teamIdSet)
      let newCount = 0
      for (const g of games) {
        if (!seenIds[g.id]) { seenIds[g.id] = true; allGames.push(g); newCount++ }
      }
      log.info(`[BP Sync] Team ${teamId}: ${games.length} games (${newCount} new)`)
    } catch (err) {
      log.warn(`[BP Sync] Team ${teamId} fetch error: ${err.message}`)
    }
  }

  log.info(`[BP Sync] ${allGames.length} unique games`)

  // Batch-fetch all existing BB games into a Map (1 query instead of N)
  const existingRows = await db('games').where('source', 'basketplan')
    .select('id', 'game_id', 'date', 'time', 'status', 'home_score', 'away_score',
      'home_team', 'away_team', 'hall', 'away_hall_json', 'league',
      'referees_json', 'respond_by', 'kscw_team')
  // Keyed by game_id → ALL its rows, not one row per id. A fixture where both
  // sides are ours keeps TWO rows (one per KSCW team), which is what migration
  // 250's partial unique `games (game_id, kscw_team)` already enforces and what
  // sv-sync has always done for volleyball derbies. Keying on game_id alone
  // meant the away squad silently got no row at all — no participations from
  // sweepGameAutoConfirm (it joins member_teams on g.kscw_team) and no
  // respond_by reminder (audit 2026-08-08, #34).
  const existingByGameId = new Map()
  for (const r of existingRows) {
    const arr = existingByGameId.get(r.game_id)
    if (arr) arr.push(r)
    else existingByGameId.set(r.game_id, [r])
  }

  const COMPARE_FIELDS = [
    'date', 'time', 'status', 'home_score', 'away_score',
    'home_team', 'away_team', 'hall', 'away_hall_json', 'league',
    // kscw_team: re-point an unchanged fixture to the active team after a season
    // rollover (lookup is active-only) instead of leaving it on the archived team.
    'kscw_team',
  ]

  let created = 0, updated = 0, skipped = 0, errors = 0

  for (const g of allGames) {
    const gameId = `bb_${g.gameNumber}`
    if (!g.date?.trim()) { log.warn(`[BP Sync] Game ${gameId}: missing date, skipping`); errors++; continue }
    const awayTeam = (!g.guestTeam?.trim() || g.guestTeam.trim() === '?') ? 'Opponent TBD' : g.guestTeam

    let hallId = null, awayHallJson = null
    if (g.isHome && g.location) {
      const mapped = HALL_MAP[g.location]
      if (mapped) hallId = hallByName[mapped] || null
    }
    if (!g.isHome && g.location) {
      awayHallJson = { name: g.location, address: g.locationAddress, city: g.locationCity }
    }

    const intents = buildGameIntents(g, hallId, awayHallJson)

    // Pair existing rows to intents, mirroring sv-sync: same kscw_team first,
    // then same type, then any leftover. The fallbacks let a row that a
    // pre-fix sync collapsed onto the wrong team be re-adopted rather than
    // duplicated, and survive a season rollover re-pointing kscw_team.
    const pool = [...(existingByGameId.get(gameId) || [])]
    const takeRow = (pred) => {
      const i = pool.findIndex(pred)
      return i === -1 ? null : pool.splice(i, 1)[0]
    }

    for (const intent of intents) {
    const pbTeam = bpToPb[intent.bpId]
    if (!pbTeam) { errors++; continue }
    hallId = intent.hall
    awayHallJson = intent.awayHallJson

    const data = {
      game_id: gameId, source: 'basketplan',
      kscw_team: pbTeam.id,
      home_team: g.homeTeam, away_team: awayTeam,
      date: g.date, time: g.time || '00:00',
      type: intent.type,
      status: STATUS_MAP[g.status] || 'scheduled',
      home_score: g.scoreHome, away_score: g.scoreGuest,
      league: g.league, season: normalizeSeason(g.season),
      referees_json: '[]',
    }
    if (hallId) data.hall = hallId
    if (awayHallJson) data.away_hall_json = JSON.stringify(awayHallJson)

    try {
      const existing =
        takeRow((r) => String(r.kscw_team ?? '') === String(pbTeam.id)) ||
        takeRow((r) => String(r.type || '') === intent.type) ||
        takeRow(() => true)
      if (existing) {
        // Fields the app owns (local cancel, hand-set halls) — must run
        // before the change comparison below.
        applyLocalGuards(data, existing)
        // Skip if nothing meaningful changed — avoids trigger-based
        // notification spam (values normalized via cmpVal — see its comment).
        const changed = COMPARE_FIELDS.some(f => cmpVal(f, data[f]) !== cmpVal(f, existing[f]))
        if (!changed) { skipped++; continue }
        // data.date, not raw string-vs-Date (existing.date !== g.date was
        // always true against a pg Date, recomputing respond_by on every
        // real update).
        if (existing.respond_by && existing.date && cmpVal('date', existing.date) !== cmpVal('date', data.date)) {
          const offset = new Date(existing.date).getTime() - new Date(existing.respond_by).getTime()
          data.respond_by = new Date(new Date(g.date).getTime() - offset).toISOString().split('T')[0]
        }
        await db('games').where('id', existing.id).update({ ...data, date_updated: new Date() })
        updated++
      } else {
        const fe = typeof pbTeam.features_enabled === 'string'
          ? JSON.parse(pbTeam.features_enabled || '{}') : (pbTeam.features_enabled || {})
        const days = fe?.game_respond_by_days
        if (days > 0 && g.date) {
          data.respond_by = new Date(new Date(g.date).getTime() - days * 86400000).toISOString().split('T')[0]
        }
        await db('games').insert({ ...data, date_created: new Date(), date_updated: new Date() })
        created++
      }
    } catch (e) {
      errors++
      log.warn(`[BP Sync] Game ${gameId}: ${e.message}`)
    }
    }
  }

  log.info(`[BP Sync] Games: ${created} created, ${updated} updated, ${skipped} unchanged, ${errors} errors`)

  // Retire the hand-entered placeholders the published schedule has replaced.
  // Runs even when nothing was created: a range that GREW on this run (ProBasket
  // publishing the Rückrunde) supersedes manual rows the earlier partial publish
  // did not cover. Idempotent, so a steady-state night is two indexed reads.
  let manualSweep = { deleted: 0, rsvpsRemoved: 0, teams: 0, skipped: true }
  if (sweepManual !== 'off') {
    try {
      manualSweep = await sweepSupersededManualGames(db, log, { dryRun: sweepManual === 'dry' })
    } catch (e) {
      // Never let the tidy-up fail the sync — the fixtures are the point, a
      // surviving duplicate is visible and the next run retries.
      errors++
      log.warn(`[BP Sync] Manual sweep failed: ${e.message}`)
      manualSweep = { deleted: 0, rsvpsRemoved: 0, teams: 0, error: e.message }
    }
  }

  if (created > 0) await sweepGameAutoConfirm(db, log)
  return { created, updated, skipped, errors, manualSweep, leagueHoldingIds: allLhIds }
}

export async function syncBpRankings(db, log, leagueHoldingIds = {}) {
  const pbTeams = await db('teams')
    .where('sport', 'basketball')
    .where('active', true) // current-season team only (post-rollover the bb_source_id collides with the archived row)
    .whereNot('bb_source_id', '')
    .select('id', 'bb_source_id')
  const bpToPb = Object.fromEntries(pbTeams.map(t => [t.bb_source_id, t.id]))

  let lhIds = Object.keys(leagueHoldingIds)
  if (lhIds.length === 0) {
    log.info('[BP Sync] No cached leagueHoldingIds, fetching from team XMLs...')
    for (const t of pbTeams) {
      try {
        const res = await fetch(
          `${BP_BASE}/findTeamById.do?teamId=${t.bb_source_id}&clubId=${BP_CLUB_ID}&federationId=10&xmlView=true`,
          { headers: { 'User-Agent': 'KSCW-Sync/1.0' } },
        )
        const xml = await res.text()
        Object.assign(leagueHoldingIds, extractLeagueHoldingIds(xml))
      } catch (e) { /* skip */ }
    }
    lhIds = Object.keys(leagueHoldingIds)
  }

  log.info(`[BP Sync] Fetching rankings for ${lhIds.length} leagues...`)
  const nowStr = new Date().toISOString()
  let created = 0, updated = 0, errors = 0

  for (const lhId of lhIds) {
    try {
      const res = await fetch(
        `${BP_BASE}/showRankingForLeague.do?leagueHoldingId=${lhId}&xmlView=true`,
        { headers: { 'User-Agent': 'KSCW-Sync/1.0' } },
      )
      const xml = await res.text()
      if (!xml || xml.length < 100) continue

      const rankings = parseRankings(xml)
      if (!rankings.some(r => bpToPb[r.bpTeamId])) continue

      for (const r of rankings) {
        try {
          const teamId = `bb_${r.bpTeamId}`
          const data = {
            team_id: teamId, team_name: r.teamName, league: r.league,
            rank: r.rank, played: r.played, won: r.won, lost: r.lost,
            sets_won: 0, sets_lost: 0,
            points_won: r.pointsFor, points_lost: r.pointsAgainst,
            points: r.totalPoints, season: normalizeSeason(r.season), updated_at: nowStr,
          }
          const pbTeamId = bpToPb[r.bpTeamId]
          if (pbTeamId) data.team = pbTeamId

          const existing = await db('rankings').where('team_id', teamId).where('league', r.league).where('season', data.season).first()
          if (existing) { await db('rankings').where('id', existing.id).update({ ...data, date_updated: new Date() }); updated++ }
          else { await db('rankings').insert({ ...data, date_created: new Date(), date_updated: new Date() }); created++ }
        } catch (e) { errors++; log.warn(`[BP Sync] Ranking: ${e.message}`) }
      }
    } catch (e) { log.warn(`[BP Sync] League ${lhId}: ${e.message}`) }
  }

  log.info(`[BP Sync] Rankings: ${created} created, ${updated} updated, ${errors} errors`)
  return { created, updated, errors }
}
