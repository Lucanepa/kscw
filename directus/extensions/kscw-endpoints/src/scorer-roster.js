/**
 * The match sheet for one game.
 *   GET  /kscw/scorer/game/:gameId/roster   — read it
 *   POST /kscw/scorer/game/:gameId/roster   — the coach adjusts it (coach/TR only)
 *
 * Returns the playing team's sheet — jersey number, last name, first initial, and FULL
 * date of birth for every player, plus the team's officials, so the sheet can be filled.
 * This is the ONE sanctioned place that exposes full DoB (including minors): the club's
 * public team API strips under-18 PII in three layers, but the people at the table
 * legitimately need ages. It is therefore gated by WHO you are and WHEN you ask.
 *
 * TWO AUDIENCES, different gates:
 *
 *   scorer — the assigned Schreiber. SCORER roles only (scorer / scorer_scoreboard /
 *            bb_scorer); the pure Täfeler / timekeeper / 24s roles do NOT get the sheet.
 *            Window: kickoff −40min … +3h (opens once RSVPs are final, stays for the
 *            match). Home games only — the sheet we hold is the home team's.
 *            READ ONLY: a scorer never edits the sheet.
 *
 *   coach  — a coach or team responsible of the playing team. Window: kickoff −3h … +3h,
 *            wider than the scorer's because they prepare before they travel and because
 *            a hall has no signal (the app pre-loads while they still have bars). Home
 *            AND away: a team files an Einsatzliste for every fixture, and VM's call is
 *            scoped to the active party, so it hands us OUR list on either side.
 *            MAY EDIT (see POST below).
 *
 * Directus admins bypass both. Every read is audit-logged (writeUserLog) precisely
 * because it surfaces minor PII — a deliberate exception to the "reads need no actor
 * capture" rule.
 *
 * THREE SOURCES, in order:
 *   - `saved` — a snapshot in `game_rosters`, written the first time a coach edits this
 *               game. If rows exist they ARE the sheet: the coach has already looked at
 *               it and corrected it, and their correction must not be silently reverted
 *               by a later VM re-read.
 *   - `vm`    — the Einsatzliste the team filed in Volleymanager. The legal document the
 *               scorer copies, so it wins over RSVPs: a nominated player who never RSVP'd
 *               still belongs on the sheet. Available for HOME and AWAY fixtures alike —
 *               the club files one for every game, and VM returns whichever side is ours.
 *               VM carries no jersey number, no captain and no libero, so those are
 *               merged in from `members` by joining person.associationId to license_nr.
 *   - `rsvp`  — fallback: confirmed RSVPs (confirmed guests included). Basketball (no VM),
 *               unfiled lists, and whenever VM is slow/down/unauthenticated.
 *
 * WHAT THE COACH MAY CHANGE, AND WHY IT IS SAFE
 * --------------------------------------------
 * number / is_captain / is_libero do not exist on the Einsatzliste at all — they are ours
 * — so editing them cannot contradict Volleymanager. Adding or dropping a PLAYER does
 * diverge from it; that is the emergency door (someone turns up who was not nominated, or
 * a nominated player does not). We do NOT push it: the UI shows a red banner telling the
 * coach to make the same change by hand in Volleymanager. See migration 211.
 *
 * NOTE on migration 206 (auto_nomination_list), which files the Einsatzliste from RSVPs ~60
 * min before kickoff and "closes" it: closing in Volleymanager SAVES the list, it does not
 * lock it — the team can still edit it until game start. So there is no conflict with the
 * coach's window here, and the red "enter it manually in Volleymanager" banner is
 * actionable rather than a dead letter: the coach really can still go and fix it.
 * (An earlier version of this comment claimed the two collide. They do not.)
 */

import { writeUserLog } from './activity-log.js'
import { fetchOwnNominationList } from './vm-nomination-list.js'
import { seasonForYmd } from './season.js'

// SCORER roles → assigned-member FK on `games`. Täfeler/timekeeper/24s excluded on
// purpose — they don't fill the match sheet, so they don't get the roster.
const ROSTER_ROLE_COLS = ['scorer_member', 'scorer_scoreboard_member', 'bb_scorer_member']

// Scorer: opens once RSVPs are final, stays for the length of a match.
const SCORER_WINDOW_BEFORE_MS = 40 * 60 * 1000
const SCORER_WINDOW_AFTER_MS = 3 * 60 * 60 * 1000

// Coach: wider on the near side — they prepare before leaving, and halls have no signal, so
// the app must be able to pre-load while they still have a connection.
//
// ⚠ MUST be >= PRELOAD_BEFORE_MS in identity-document.js. The Show-IDs screen reads THIS
// endpoint to learn who is on the sheet before it fetches their documents, so a narrower
// window here silently breaks the ID pre-load: the coach taps "download for offline", the
// roster 403s, and nothing downloads — with no error that points at the cause.
const COACH_WINDOW_BEFORE_MS = 6 * 60 * 60 * 1000
const COACH_WINDOW_AFTER_MS = 3 * 60 * 60 * 1000

const dateYMD = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10))

// Offset (localZurich − UTC) in ms at a given UTC instant.
function zurichOffsetMs(instantMs) {
  const p = {}
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  for (const x of dtf.formatToParts(new Date(instantMs))) p[x.type] = x.value
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instantMs
}

// Zurich wall-clock (date+time on a game row) → absolute UTC epoch ms.
// Exported: the Einsatzliste cron needs the same kickoff instant, and `games` stores
// date and time as separate DST-naive columns — re-deriving this is how you get a
// job that fires an hour late for half the year.
export function gameStartMs(game) {
  const ymd = dateYMD(game.date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null
  const [hh, mm] = String(game.time ?? '').split(':')
  if (hh == null || mm == null || hh === '') return null
  const [y, mo, d] = ymd.split('-').map(Number)
  const guess = Date.UTC(y, mo - 1, d, Number(hh), Number(mm))
  const corrected = guess - zurichOffsetMs(guess)
  return guess - zurichOffsetMs(corrected)
}

// Season string ("YYYY/YY") containing a given YYYY-MM-DD. Delegates to the
// shared module — this was the FIFTH inline copy of the Jun-1 cutover and the
// only one no test covered. It is still needed because the season is persisted
// into the saved match-sheet snapshot; it is no longer used to FILTER a roster.
const seasonForDate = seasonForYmd

const firstInitial = (name) => {
  const s = String(name ?? '').trim()
  return s ? s.charAt(0).toUpperCase() + '.' : ''
}

// Jersey 0 is not a legal volleyball number — in `members` it means "never set",
// so render it as blank rather than a column of zeros on the sheet.
const jersey = (n) => (n == null || Number(n) === 0 ? null : Number(n))

// Jersey number descending; unnumbered players (staff, late entries) last.
const byJersey = (a, b) => (b.number == null ? -Infinity : b.number) - (a.number == null ? -Infinity : a.number)

/**
 * Libero is a per-MATCH designation in the rules, not a property of a person — but the
 * only thing we hold is `members.position`, a club-wide json array. So it seeds the
 * flag, and the coach corrects it per game (which is the whole point of game_rosters).
 */
function seedLibero(position) {
  if (!position) return false
  const raw = typeof position === 'string' ? position : JSON.stringify(position)
  return /libero/i.test(raw)
}

/**
 * VM game UUID for one of our games — MATCHED BY GAME NUMBER.
 *
 * `games.game_id` is `vb_<SwissVolley gameId>` and `svrz_games.svrz_number` is that same
 * number (the equivalence sv-sync.js already relies on), so the number is the join key —
 * no team-name matching, no UUID guessing. Returns null for basketball (`bb_` prefix, no
 * VM) and for games with no VM fixture.
 *
 * No home/away flag is passed on: VM's call is scoped to the active party and only ever
 * returns OUR list, so the reader takes whichever side is populated. Nothing here needs
 * to know which side we are on — and shouldn't, since a stale home_club_id in our own DB
 * would then silently degrade the sheet to the RSVP fallback.
 */
async function vmGameUuid(database, game) {
  const gid = String(game.game_id ?? '')
  if (!gid.startsWith('vb_')) return null
  const number = Number(gid.slice(3))
  if (!Number.isInteger(number)) return null

  const row = await database('svrz_games')
    .where('svrz_number', number)
    .first('svrz_persistence_id')
  return row?.svrz_persistence_id ?? null
}

/** Source: the Einsatzliste filed in Volleymanager. null → caller falls back to RSVP. */
async function loadVmRoster(database, log, game, captainId) {
  const uuid = await vmGameUuid(database, game)
  if (!uuid) return null
  const nl = await fetchOwnNominationList(uuid, log)
  if (!nl) return null

  // VM has no jersey number, no captain and no libero — merge ours in. VM's
  // person.associationId IS members.license_nr (same Swiss Volley licence), exact join.
  const licences = nl.players.map((p) => p.license_nr).filter(Boolean)
  const memberRows = licences.length
    ? await database('members').whereIn('license_nr', licences).select('id', 'number', 'position', 'license_nr')
    : []
  const byLicence = new Map(memberRows.map((m) => [String(m.license_nr), m]))

  const roster = nl.players
    .map((p) => {
      const m = p.license_nr ? byLicence.get(p.license_nr) : null
      return {
        // null when the Einsatzliste names a licence we hold no member for. They still
        // belong on the sheet (VM is the legal list) — we just cannot link them, and the
        // coach cannot edit them.
        member: m ? Number(m.id) : null,
        number: m ? jersey(m.number) : null,
        last_name: p.last_name,
        first_initial: p.first_initial,
        birthdate: p.birthdate,
        is_captain: m != null && captainId != null && Number(m.id) === captainId,
        is_libero: m ? seedLibero(m.position) : false,
        licence: p.licence,
        eligible: p.eligible,
        added: false,
        dropped: false,
      }
    })
    .sort(byJersey)

  return { source: 'vm', roster, coaches: nl.coaches, closed_at: nl.closed_at }
}

/**
 * Every RSVP for this game, member -> status. Feeds the match sheet's check column.
 *
 * The Einsatzliste WINS — it is the legal list, and nothing here can add or remove a
 * player. This is a read-only reconciliation: for each nominated player, did they
 * actually say they are coming? The actionable case is `declined` — nominated in
 * Volleymanager, and they told us they are not turning up.
 */
async function rsvpByMember(database, gameId) {
  const rows = await database('participations')
    .where('activity_type', 'game')
    .where('activity_id', String(gameId))
    .select('member', 'status')
  return new Map(rows.map((r) => [Number(r.member), String(r.status)]))
}

/** Fallback: members who RSVP'd "confirmed" (confirmed guests included). */
async function loadRsvpRoster(database, game, gameId, season, captainId) {
  const confirmedRows = await database('participations')
    .where('activity_type', 'game')
    .where('activity_id', String(gameId))
    .where('status', 'confirmed')
    .select('member')
  const confirmedIds = new Set(confirmedRows.map((r) => Number(r.member)))

  const rows = await squadRows(database, game.kscw_team, season, gameId)

  const roster = rows
    .filter((r) => confirmedIds.has(Number(r.id)))
    .map((r) => ({
      member: Number(r.id),
      number: jersey(r.number),
      last_name: r.last_name || '',
      first_initial: firstInitial(r.first_name),
      birthdate: r.birthdate ? dateYMD(r.birthdate) : null,
      is_captain: captainId != null && Number(r.id) === captainId,
      is_libero: seedLibero(r.position),
      licence: null,
      eligible: true,
      added: false,
      dropped: false,
    }))
    .sort(byJersey)

  return { source: 'rsvp', roster, coaches: [], closed_at: null }
}

/**
 * The full squad available for one game — the pool the coach may add from, and the
 * set the RSVP fallback resolves confirmations against.
 *
 * That is the team's season roster PLUS anyone the coach opened this game to
 * (migration 271). Guests are the whole reason the emergency pool exists: a borrowed
 * player has no `member_teams` row on this team, so without the union they RSVP
 * "confirmed", vanish from the Einsatzliste, and are rejected as an invalid `added`
 * player at line 515 — silently un-selectable for the one game they were invited to.
 *
 * `gameId` is optional so a caller with only a team in hand still gets the plain
 * roster; every in-tree caller passes it.
 */
async function squadRows(database, teamId, season, gameId = null) {
  const memberCols = [
    'members.id as id',
    'members.number as number',
    'members.position as position',
    'members.first_name as first_name',
    'members.last_name as last_name',
    'members.birthdate as birthdate',
  ]

  // ⚠ No season predicate: `teamId` is game.kscw_team, and a teams row belongs
  // to exactly one season by construction, so the FK already pins it. The season
  // filter could only SUBTRACT — dropping a player whose stamp lagged out of the
  // RSVP fallback roster, the bench and the server-side add-player validation.
  const rostered = await database('member_teams')
    .join('members', 'members.id', 'member_teams.member')
    .where('member_teams.team', teamId)
    .select(memberCols)

  if (gameId == null) return rostered

  const guests = await database('game_guests')
    .join('members', 'members.id', 'game_guests.member')
    .where('game_guests.game', gameId)
    .select(memberCols)

  // The migration-271 skip trigger already keeps a player off `game_guests` when
  // they are on the game's own team, but the two lists can still overlap.
  // Dedupe on member id.
  const seen = new Set(rostered.map((r) => Number(r.id)))
  return [...rostered, ...guests.filter((g) => !seen.has(Number(g.id)))]
}

/**
 * The coach's saved sheet. When rows exist they ARE the sheet — a coach has looked at
 * this game and corrected it, and a later VM re-read must not silently revert them.
 */
async function loadSavedSheet(database, gameId) {
  const rows = await database('game_rosters').where('game', gameId).select('*')
  if (!rows.length) return null

  const roster = rows
    .map((r) => ({
      member: r.member == null ? null : Number(r.member),
      number: jersey(r.number),
      last_name: r.last_name || '',
      first_initial: r.first_initial || '',
      birthdate: r.birthdate ? dateYMD(r.birthdate) : null,
      is_captain: r.is_captain === true,
      is_libero: r.is_libero === true,
      licence: r.licence,
      eligible: r.eligible !== false,
      added: r.added === true,
      dropped: r.dropped === true,
    }))
    .sort(byJersey)

  return {
    source: rows[0].source || 'vm',
    roster,
    coaches: [],
    closed_at: null,
    edited_by: rows[0].edited_by_name || null,
    edited_at: rows[0].date_updated || null,
  }
}

/**
 * Team officials from our own DB — the fallback when VM names none. Our `teams_coaches`
 * junction has NO role column, so these come back unlabelled. That is deliberate: VM
 * distinguishes coach / assistant 1 / assistant 2 and is the better source when it
 * exists; duplicating that into a hand-kept column would just be a second copy to drift.
 */
async function dbCoaches(database, teamId) {
  const rows = await database('teams_coaches')
    .join('members', 'members.id', 'teams_coaches.members_id')
    .where('teams_coaches.teams_id', teamId)
    .select('members.first_name as first_name', 'members.last_name as last_name', 'members.birthdate as birthdate')
  return rows.map((r) => ({
    last_name: r.last_name || '',
    first_initial: firstInitial(r.first_name),
    birthdate: r.birthdate ? dateYMD(r.birthdate) : null,
    role: null,
  }))
}

/** Is this member a coach or team responsible of the playing team? */
async function isTeamLeader(database, memberId, teamId) {
  if (memberId == null || teamId == null) return false
  const [coach, tr] = await Promise.all([
    database('teams_coaches').where({ teams_id: teamId, members_id: memberId }).first('id'),
    database('teams_responsibles').where({ teams_id: teamId, members_id: memberId }).first('id'),
  ])
  return !!coach || !!tr
}

export function registerScorerRoster(router, { database, logger }) {
  const log = logger.child({ endpoint: 'scorer-roster' })

  /**
   * Resolve caller → { access, member, game } or an error response.
   * access: 'admin' | 'scorer' | 'coach'
   */
  async function authorize(req, res) {
    const isAdmin = req.accountability?.admin === true
    const userId = req.accountability?.user
    if (!userId && !isAdmin) {
      res.status(401).json({ error: 'Authentication required' })
      return null
    }

    const gameId = req.params.gameId
    const game = await database('games').where('id', gameId).first('*')
    if (!game) {
      res.status(404).json({ error: 'Game not found' })
      return null
    }

    const member = userId ? await database('members').where('user', userId).first('id') : null

    const isScorer = !!member && ROSTER_ROLE_COLS.some(
      (col) => game[col] != null && Number(game[col]) === Number(member.id),
    )
    const isCoach = !!member && await isTeamLeader(database, Number(member.id), game.kscw_team)

    const access = isAdmin ? 'admin' : (isCoach ? 'coach' : (isScorer ? 'scorer' : null))
    if (!access) {
      res.status(403).json({
        error: 'Not the assigned scorer, coach or team responsible for this game',
        code: 'not_scorer',
      })
      return null
    }

    // Time window — per audience. Admins bypass.
    if (access !== 'admin') {
      const startMs = gameStartMs(game)
      if (startMs == null) {
        res.status(403).json({ error: 'Game has no scheduled time', code: 'no_time' })
        return null
      }
      const before = access === 'coach' ? COACH_WINDOW_BEFORE_MS : SCORER_WINDOW_BEFORE_MS
      const after = access === 'coach' ? COACH_WINDOW_AFTER_MS : SCORER_WINDOW_AFTER_MS
      const nowMs = Date.now()
      if (nowMs < startMs - before || nowMs > startMs + after) {
        res.status(403).json({ error: 'Roster is not available at this time', code: 'outside_window' })
        return null
      }
    }

    // The sheet we hold is the PLAYING team's. A scorer only ever scores a home game;
    // a coach travels to away games too, and gets the real Einsatzliste there — VM's
    // call is scoped to the active party, so it returns our list on either side.
    if (game.kscw_team == null) {
      res.status(422).json({ error: 'Game has no KSCW team', code: 'not_home' })
      return null
    }
    if (access === 'scorer' && game.type !== 'home') {
      res.status(422).json({ error: 'Roster is only available for home games', code: 'not_home' })
      return null
    }

    return { access, member, game, gameId }
  }

  /** The sheet as it stands: saved snapshot if the coach edited it, else VM, else RSVP. */
  async function buildSheet(game, gameId, season, captainId) {
    const saved = await loadSavedSheet(database, gameId)
    if (saved) return { ...saved, edited: true }
    const derived =
      (await loadVmRoster(database, log, game, captainId)) ??
      (await loadRsvpRoster(database, game, gameId, season, captainId))
    return { ...derived, edited: false }
  }

  // ── GET: read the sheet ───────────────────────────────────────────────────
  router.get('/scorer/game/:gameId/roster', async (req, res) => {
    try {
      const auth = await authorize(req, res)
      if (!auth) return
      const { access, game, gameId } = auth

      const season = seasonForDate(dateYMD(game.date))
      const teamRow = await database('teams').where('id', game.kscw_team).first('captain')
      const captainId = teamRow?.captain != null ? Number(teamRow.captain) : null

      const sheet = await buildSheet(game, gameId, season, captainId)

      // Officials: VM names them WITH their slot (coach / assistant 1 / assistant 2);
      // our junction cannot, so those come back unlabelled.
      const vmCoaches = sheet.coaches?.length
        ? sheet.coaches
        : (await loadVmRoster(database, log, game, captainId))?.coaches ?? []
      const coaches = vmCoaches.length ? vmCoaches : await dbCoaches(database, game.kscw_team)

      // The pool the coach may add from, in an emergency. Scorers never add, so they
      // don't get a squad list they have no business seeing.
      let bench = []
      if (access === 'coach' || access === 'admin') {
        const onSheet = new Set(sheet.roster.map((r) => r.member).filter((m) => m != null))
        bench = (await squadRows(database, game.kscw_team, season, gameId))
          .filter((r) => !onSheet.has(Number(r.id)))
          .map((r) => ({
            member: Number(r.id),
            number: jersey(r.number),
            last_name: r.last_name || '',
            first_initial: firstInitial(r.first_name),
            birthdate: r.birthdate ? dateYMD(r.birthdate) : null,
            is_libero: seedLibero(r.position),
          }))
          .sort(byJersey)
      }

      // The check column. Attached here rather than inside a loader so it covers ALL
      // three sheet paths (vm / rsvp fallback / saved game_rosters snapshot) alike.
      //
      // ⚠ Only meaningful against a VM Einsatzliste. When source === 'rsvp' the sheet
      // IS the confirmed RSVPs, so every row would read green and the tick would assert
      // a cross-check that never happened. Left null there, and the UI hides the column.
      //
      // ⚠ `member: null` (VM named a licence we hold no member for) stays null, NOT
      // "no answer" — there is no RSVP to look up, and rendering it as a warning would
      // flag every unlinked player as a problem.
      const rsvps = sheet.source === 'vm' ? await rsvpByMember(database, gameId) : null
      const withRsvp = (r) => ({
        ...r,
        rsvp: rsvps && r.member != null ? (rsvps.get(Number(r.member)) ?? 'none') : null,
      })
      sheet.roster = sheet.roster.map(withRsvp)
      // The inverse check, for whoever may act on it: someone who confirmed but was
      // never nominated. `bench` is exactly that pool, and is coach/admin-only already.
      bench = bench.map(withRsvp)

      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'read',
        collection: 'games',
        recordId: gameId,
        data: {
          what: 'match_sheet',
          as: access,
          team: game.kscw_team,
          season,
          source: sheet.source,
          edited: sheet.edited,
          count: sheet.roster.length,
          coaches: coaches.length,
        },
      })

      res.json({
        data: {
          game: {
            id: game.id,
            home_team: game.home_team,
            away_team: game.away_team,
            date: dateYMD(game.date),
            time: game.time ? String(game.time).slice(0, 5) : null,
          },
          access,
          can_edit: access === 'coach' || access === 'admin',
          source: sheet.source,
          edited: sheet.edited,
          edited_by: sheet.edited_by ?? null,
          closed_at: sheet.closed_at,
          roster: sheet.roster,
          coaches,
          bench,
        },
      })
    } catch (err) {
      log.error({
        msg: `GET scorer/game/:id/roster: ${err.message}`,
        endpoint: 'scorer/game/:gameId/roster',
        userId: req.accountability?.user || null,
        method: req.method,
        stack: err.stack,
      })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── POST: the coach adjusts the sheet ─────────────────────────────────────
  //
  // Body: { players: [{ member, number, is_captain, is_libero, dropped }], added: [memberId] }
  //
  // Identity (name / DoB / licence) is NEVER taken from the request — it is re-derived
  // server-side from the base sheet and from `members`. The client may only move the
  // three flags the coach owns, strike a player off, or add one from the team's own squad.
  router.post('/scorer/game/:gameId/roster', async (req, res) => {
    try {
      const auth = await authorize(req, res)
      if (!auth) return
      const { access, member, game, gameId } = auth

      if (access === 'scorer') {
        return res.status(403).json({ error: 'A scorer may not edit the sheet', code: 'read_only' })
      }

      const body = req.body ?? {}
      const edits = Array.isArray(body.players) ? body.players : []
      const addedIds = Array.isArray(body.added) ? body.added.map(Number).filter(Number.isInteger) : []

      const season = seasonForDate(dateYMD(game.date))
      const teamRow = await database('teams').where('id', game.kscw_team).first('captain')
      const captainId = teamRow?.captain != null ? Number(teamRow.captain) : null

      // Re-derive the base sheet from the ORIGINAL sources, not from the saved snapshot —
      // otherwise an edit compounds on an edit and the Einsatzliste can never be re-read.
      const base =
        (await loadVmRoster(database, log, game, captainId)) ??
        (await loadRsvpRoster(database, game, gameId, season, captainId))

      // An added player must actually be in the team's squad this season. Without this a
      // coach could put any member of the club onto their sheet.
      const squad = await squadRows(database, game.kscw_team, season, gameId)
      const squadById = new Map(squad.map((r) => [Number(r.id), r]))
      const onBase = new Set(base.roster.map((r) => r.member).filter((m) => m != null))
      const validAdded = addedIds.filter((id) => squadById.has(id) && !onBase.has(id))

      const editByMember = new Map(
        edits
          .filter((e) => e && Number.isInteger(Number(e.member)))
          .map((e) => [Number(e.member), e]),
      )

      const clampNumber = (n) => {
        const v = Number(n)
        return Number.isInteger(v) && v >= 1 && v <= 99 ? v : null
      }

      const rows = base.roster.map((r) => {
        const e = r.member != null ? editByMember.get(r.member) : null
        return {
          ...r,
          number: e && 'number' in e ? clampNumber(e.number) : r.number,
          is_captain: e ? e.is_captain === true : r.is_captain,
          is_libero: e ? e.is_libero === true : r.is_libero,
          dropped: e ? e.dropped === true : false,
        }
      })

      for (const id of validAdded) {
        const m = squadById.get(id)
        const e = editByMember.get(id)
        rows.push({
          member: id,
          number: e && 'number' in e ? clampNumber(e.number) : jersey(m.number),
          last_name: m.last_name || '',
          first_initial: firstInitial(m.first_name),
          birthdate: m.birthdate ? dateYMD(m.birthdate) : null,
          is_captain: e ? e.is_captain === true : false,
          is_libero: e ? e.is_libero === true : seedLibero(m.position),
          licence: null,
          eligible: true,
          added: true,
          dropped: false,
        })
      }

      // Captain is exclusive on a match sheet — keep the first, drop the rest.
      let seenCaptain = false
      for (const r of rows) {
        if (!r.is_captain || r.dropped) { r.is_captain = false; continue }
        if (seenCaptain) r.is_captain = false
        else seenCaptain = true
      }

      // Actor capture: raw-knex writes bypass Directus's revision trail, so the acting
      // user is lost unless we persist it (CLAUDE.md → Audit logging).
      const userRow = req.accountability?.user
        ? await database('directus_users')
          .where('id', req.accountability.user)
          .first('first_name', 'last_name', 'email')
        : null
      const actorName = userRow
        ? [userRow.first_name, userRow.last_name].filter(Boolean).join(' ') || null
        : null
      const actorEmail = userRow?.email ?? null

      const now = new Date()
      await database.transaction(async (trx) => {
        await trx('game_rosters').where('game', gameId).del()
        if (rows.length) {
          await trx('game_rosters').insert(rows.map((r) => ({
            game: Number(gameId),
            member: r.member,
            last_name: r.last_name,
            first_initial: r.first_initial,
            birthdate: r.birthdate,
            licence: r.licence,
            eligible: r.eligible !== false,
            number: r.number,
            is_captain: r.is_captain === true,
            is_libero: r.is_libero === true,
            added: r.added === true,
            dropped: r.dropped === true,
            source: base.source,
            edited_by_name: actorName,
            edited_by_email: actorEmail,
            date_created: now,
            date_updated: now,
          })))
        }
      })

      const dropped = rows.filter((r) => r.dropped).length
      const added = rows.filter((r) => r.added).length

      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'update',
        collection: 'game_rosters',
        recordId: gameId,
        data: {
          what: 'match_sheet_edit',
          team: game.kscw_team,
          season,
          source: base.source,
          count: rows.length,
          added,
          dropped,
          // Diverging from the Einsatzliste is the thing worth being able to find later.
          diverges_from_einsatzliste: added > 0 || dropped > 0,
          by_member: member ? Number(member.id) : null,
        },
      })

      res.json({
        data: {
          saved: true,
          count: rows.length,
          added,
          dropped,
          diverges_from_einsatzliste: added > 0 || dropped > 0,
        },
      })
    } catch (err) {
      log.error({
        msg: `POST scorer/game/:id/roster: ${err.message}`,
        endpoint: 'scorer/game/:gameId/roster',
        userId: req.accountability?.user || null,
        method: req.method,
        stack: err.stack,
      })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── DELETE: revert to the Einsatzliste ────────────────────────────────────
  router.delete('/scorer/game/:gameId/roster', async (req, res) => {
    try {
      const auth = await authorize(req, res)
      if (!auth) return
      const { access, game, gameId } = auth

      if (access === 'scorer') {
        return res.status(403).json({ error: 'A scorer may not edit the sheet', code: 'read_only' })
      }

      const removed = await database('game_rosters').where('game', gameId).del()

      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'delete',
        collection: 'game_rosters',
        recordId: gameId,
        data: { what: 'match_sheet_reset', team: game.kscw_team, rows: removed },
      })

      res.json({ data: { reset: true, rows: removed } })
    } catch (err) {
      log.error({
        msg: `DELETE scorer/game/:id/roster: ${err.message}`,
        endpoint: 'scorer/game/:gameId/roster',
        userId: req.accountability?.user || null,
        method: req.method,
        stack: err.stack,
      })
      res.status(500).json({ error: 'Internal error' })
    }
  })
}
