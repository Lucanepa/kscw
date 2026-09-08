/**
 * Duty-late alarm — GET/POST /kscw/games/:id/duty-late
 *
 * A coach or team-responsible of the PLAYING team (games.kscw_team) can flag an
 * assigned duty official (scorer / Täfeler / combined / referee / BB officials)
 * as "late" once they're inside the role's arrival window. Flagging:
 *   - emails the official (to) + the sport's TK (vb_admin / bb_admin, cc) + the
 *     club admin (cc),
 *   - records the report on games.duty_late_json (idempotent — one email even if
 *     the button is pressed again / reopened),
 *   - returns the official's phone/email so the coach can reach them.
 *
 * GET returns the already-flagged roles + contact for a game (in-window only),
 * so reopening the game keeps the reveal WITHOUT re-emailing anyone.
 *
 * Contact is time-gated server-side to [kickoff − arrival, kickoff + grace] and
 * scoped to the caller's OWN team — mirrors scorer-contacts.js. Member
 * hide_phone / hide_email flags are honoured. writeUserLog on every first flag
 * (raw-knex writes bypass the items audit hook — CLAUDE.md audit rule).
 *
 * Why an endpoint and not Directus permissions: the grant is "the official
 * assigned to a game MY playing team is in" — a per-game relationship that a
 * field-level policy filter can't express without the documented deep-filter
 * silent-empty trap. Authorising per-game in code keeps coaches from bulk
 * reading contacts via the items API.
 */

import { buildEmailLayout, buildAlertBox, buildInfoCard, formatDateCH, FRONTEND_URL } from './email-template.js'
import { writeUserLog } from './activity-log.js'
import { sendPushToMembers } from './web-push.js'
import { sendLocalizedPush } from './push-i18n.js'

// Club admin who is cc'd on every late alarm (you). Env override, else the
// same personal inbox the hooks use for owner routing.
const DUTY_LATE_ADMIN_EMAIL = process.env.DUTY_LATE_ADMIN_EMAIL || process.env.OWNER_EMAIL || 'admin@wiedisync.kscw.ch'

// role → { assigned-member column, duty-team column, arrival minutes, sport, label }.
// arrival minutes MUST match src/utils/dateHelpers.ts DUTY_ARRIVAL_MIN.
export const ROLE_DEFS = {
  scorer:            { member: 'scorer_member',            duty: 'scorer_duty_team',            arrival: 30, sport: 'volleyball', label: 'Schreiber' },
  scoreboard:        { member: 'scoreboard_member',        duty: 'scoreboard_duty_team',        arrival: 15, sport: 'volleyball', label: 'Täfeler' },
  scorer_scoreboard: { member: 'scorer_scoreboard_member', duty: 'scorer_scoreboard_duty_team', arrival: 30, sport: 'volleyball', label: 'Schreiber/Täfeler' },
  referee:           { member: 'referee_member',           duty: 'referee_duty_team',           arrival: 30, sport: 'volleyball', label: 'Schiedsrichter' },
  bb_scorer:         { member: 'bb_scorer_member',         duty: 'bb_scorer_duty_team',         arrival: 15, sport: 'basketball', label: 'Scorer' },
  bb_timekeeper:     { member: 'bb_timekeeper_member',     duty: 'bb_timekeeper_duty_team',     arrival: 15, sport: 'basketball', label: 'Zeitnehmer' },
  bb_24s_official:   { member: 'bb_24s_official',          duty: 'bb_24s_duty_team',            arrival: 15, sport: 'basketball', label: '24s-Bediener' },
}

// Alarm + contact stay available for this long AFTER kickoff (a missing official
// is still a live problem once the game should have started).
const GRACE_MS = 30 * 60 * 1000

// Auto-fine — a flagged late/no-show official is fined automatically. Category
// 'no_show' (the closest fit; there is no dedicated 'late' category). The amount
// comes from the fines engine (kscw_compute_fine_amount) when the duty team has a
// no_show rule, otherwise this flat fallback — the documented CHF 50 duty penalty.
const NO_SHOW_FALLBACK_CHF = 50
const NO_SHOW_FINE_REASON = 'Late arrival or no-show for duty'

// Duty-late emails reach real inboxes (the official + sport TK + club admin). On
// dev (a scrubbed prod clone) suppress them so testing the alarm + auto-fine never
// spams anyone; set DUTY_LATE_FORCE_EMAIL=1 for a deliberate email test. Push is a
// natural no-op on dev (push_subscriptions is truncated by the nightly refresh).
const IS_DEV = (process.env.PUBLIC_URL || '').includes('directus-dev')
const SEND_DUTY_LATE_EMAILS = !IS_DEV || process.env.DUTY_LATE_FORCE_EMAIL === '1'

// games.date is TZ-naive (knex may hand back a Date at UTC-midnight or a string);
// games.time is "HH:MM[:SS]". Normalise + convert to an absolute epoch, DST-safe
// (mirrors scorer-contacts.js / dateHelpers.toUtcIsoFromDatetimeLocal).
export const dateYMD = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10))

function zurichOffsetMs(instantMs) {
  const p = {}
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  for (const x of dtf.formatToParts(new Date(instantMs))) p[x.type] = x.value
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instantMs
}

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

function inWindow(startMs, arrivalMin) {
  if (startMs == null) return false
  const now = Date.now()
  return now >= startMs - arrivalMin * 60 * 1000 && now <= startMs + GRACE_MS
}

function parseLate(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : {} } catch { return {} }
}

// Sport TK = the members holding the sport-admin role, with a login email.
export async function sportTkEmails(database, sport) {
  const role = sport === 'basketball' ? 'bb_admin' : 'vb_admin'
  const rows = await database('members')
    .join('directus_users', 'members.user', 'directus_users.id')
    .whereNotNull('directus_users.email')
    .whereRaw('members.role::jsonb @> ?', [JSON.stringify(role)])
    .select('directus_users.email')
  return [...new Set(rows.map((r) => String(r.email).toLowerCase()))]
}

async function sendLateEmails(database, MailService, getSchema, { game, def, official, reporterName }) {
  const schema = await getSchema()
  const mail = new MailService({ schema, knex: database })

  const tk = await sportTkEmails(database, def.sport)
  const cc = [...new Set([...tk, DUTY_LATE_ADMIN_EMAIL].filter(Boolean))]
    // Don't cc the official on their own alarm if they happen to be a TK.
    .filter((e) => e !== String(official.email || '').toLowerCase())

  const officialName = `${official.first_name} ${official.last_name}`.trim()
  const kickoff = `${formatDateCH(game.date)} ${String(game.time || '').slice(0, 5)}`.trim()
  const matchup = `${game.home_team || ''} vs ${game.away_team || ''}`.trim()
  const sportKey = def.sport === 'basketball' ? 'bb' : 'vb'

  const alert = buildAlertBox(
    'warning',
    'Verspätung gemeldet · Late arrival reported',
    `${officialName} (${def.label}) wurde noch nicht in der Halle angetroffen · has not yet arrived.`,
  )
  const card = buildInfoCard([
    { label: 'Aufgabe · Duty', value: def.label, halfWidth: true },
    { label: 'Person', value: officialName, halfWidth: true },
    { label: 'Spiel · Game', value: matchup || '—' },
    { label: 'Anpfiff · Start', value: kickoff || '—', halfWidth: true },
    { label: 'Gemeldet von · Reported by', value: reporterName, halfWidth: true },
  ])
  const html = buildEmailLayout(alert + card, {
    sport: sportKey,
    title: 'Einsatz-Verspätung · Duty running late',
    subtitle: matchup || undefined,
    greeting: official.first_name ? `Hallo ${official.first_name},` : undefined,
  })
  const text = `${officialName} (${def.label}) wurde für ${matchup} (${kickoff}) als verspätet gemeldet — bitte umgehend melden.`
    + `\n\n${officialName} (${def.label}) reported late for ${matchup} (${kickoff}).`

  const to = official.email || cc[0]
  if (!to) return // nobody to notify — skip silently
  await mail.send({
    to,
    ...(cc.length ? { cc } : {}),
    subject: `⚠ Verspätung · Late: ${def.label} — ${matchup || 'Spiel'}`,
    html,
    text,
  })
}

export function registerDutyLate(router, ctx) {
  const { services, database, logger, getSchema } = ctx
  const { MailService } = services
  const log = logger.child({ endpoint: 'duty-late' })

  // Load the game + authorise: caller must be an admin, or coach / TR of the
  // game's playing team. Returns { game, memberId }.
  async function authorize(req) {
    const userId = req.accountability?.user
    if (!userId && !req.accountability?.admin) {
      const e = new Error('Authentication required'); e.status = 401; throw e
    }
    const game = await database('games').where('id', req.params.id).first()
    if (!game) { const e = new Error('Game not found'); e.status = 404; throw e }

    const m = userId ? await database('members').where('user', userId).first('id') : null
    let ledTeamIds = []
    if (m) {
      const [coachRows, trRows] = await Promise.all([
        database('teams_coaches').where('members_id', m.id).pluck('teams_id'),
        database('teams_responsibles').where('members_id', m.id).pluck('teams_id'),
      ])
      ledTeamIds = [...new Set([...coachRows, ...trRows].filter((t) => t != null).map(Number))]
    }
    const teamId = game.kscw_team != null ? Number(game.kscw_team) : null
    const authorized = !!req.accountability?.admin || (teamId != null && ledTeamIds.includes(teamId))
    if (!authorized) { const e = new Error('Forbidden'); e.status = 403; throw e }
    return { game, memberId: m?.id ?? null }
  }

  async function contactsFor(game, roles) {
    const wantIds = [...new Set(roles.map((r) => game[ROLE_DEFS[r].member]).filter((v) => v != null).map(String))]
    if (!wantIds.length) return {}
    const rows = await database('members').whereIn('id', wantIds)
      .select('id', 'phone', 'email', 'hide_phone', 'hide_email')
    const byId = {}
    for (const r of rows) byId[String(r.id)] = r
    const out = {}
    for (const role of roles) {
      const r = byId[String(game[ROLE_DEFS[role].member])]
      // Opt-out honoured server-side — same reasoning as scorer-contacts.js.
      // This file's own header claimed the flags "are honoured"; until
      // 2026-08-10 they were not (audit 2026-08-08, finding 26).
      if (r) out[role] = {
        phone: r.hide_phone ? null : (r.phone || null),
        email: r.hide_email ? null : (r.email || null),
        hide_phone: !!r.hide_phone,
        hide_email: !!r.hide_email,
      }
    }
    return out
  }

  // Auto-issue a no_show fine for a flagged official. Idempotent per
  // (member, game). Best-effort: a fine failure must never break the alarm.
  // Raw-knex insert bypasses the fines.items.create hook (which forces
  // auto_issued=false and scopes to the caller's own team), so this replicates
  // its engine snapshot + notification + push directly and sets auto_issued=true.
  async function issueNoShowFine({ game, role, def, official, reporterMemberId, accountability }) {
    // Team context — the offense counter is per team. Prefer the official's duty
    // team for this role; fall back to their first current team.
    let teamId = game[def.duty] != null ? Number(game[def.duty]) : null
    if (teamId == null) {
      // ⚠ Must be an ACTIVE team, deterministically chosen. Unqualified, this
      // picked an arbitrary row with no ORDER BY — and 648 of prod's rows sit on
      // archived teams — so the fine was booked against last season's team,
      // where it is invisible on the current team's fines page and tiers against
      // the wrong fine_rules. Falling through to the skip branch below is the
      // correct outcome when there is no active team.
      const mt = await database('member_teams as mt')
        .join('teams as t', 't.id', 'mt.team')
        .where('mt.member', official.id)
        .where('t.active', true)
        .orderBy('mt.team', 'asc')
        .first('mt.team as team')
      teamId = mt?.team != null ? Number(mt.team) : null
    }
    if (teamId == null) {
      log.warn({ msg: 'duty-late: no team to scope the auto-fine — skipped', gameId: game.id, member: official.id, role })
      return
    }

    // Never double-fine the same official for the same game.
    const dup = await database('fines')
      .where({ member: official.id, category: 'no_show', activity_type: 'game', activity_id: Number(game.id) })
      .first('id')
    if (dup) return

    // Amount: engine tier when a no_show rule exists for the team, else flat CHF 50.
    let amount = NO_SHOW_FALLBACK_CHF
    let tierOffense = null
    let resetWindow = null
    try {
      const res = await database.raw(
        'SELECT amount, tier_offense, reset_window_at_issue FROM kscw_compute_fine_amount(?::int, ?::int, ?::text)',
        [Number(official.id), teamId, 'no_show'],
      )
      const row = res?.rows?.[0]
      if (row && row.amount != null) {
        amount = row.amount
        tierOffense = row.tier_offense ?? null
        resetWindow = row.reset_window_at_issue ?? null
      }
    } catch (e) {
      log.warn({ msg: `duty-late: fine engine query failed: ${e.message}`, gameId: game.id })
    }

    const ymd = dateYMD(game.date)
    const matchup = `${game.home_team || ''} vs ${game.away_team || ''}`.trim()

    const inserted = await database('fines')
      .insert({
        member: official.id,
        team: teamId,
        category: 'no_show',
        amount,
        currency: 'CHF',
        status: 'open',
        activity_type: 'game',
        activity_id: Number(game.id),
        activity_date: /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : null,
        tier_offense: tierOffense,
        reset_window_at_issue: resetWindow,
        reason: NO_SHOW_FINE_REASON,
        issued_by: reporterMemberId ?? null,
        auto_issued: true,
        notes: `Auto-issued from the duty-late alarm — ${def.label}${matchup ? ` · ${matchup}` : ''}.`,
      })
      .returning('id')
    const fineId = Array.isArray(inserted)
      ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0])
      : inserted

    await writeUserLog(database, log, {
      accountability,
      action: 'fine-auto-issue',
      collection: 'fines',
      recordId: fineId,
      data: { member: official.id, team: teamId, category: 'no_show', amount, game: game.id, role },
    })

    // Notify the fined member (in-app + push), mirroring the fines create hook.
    try {
      const team = await database('teams').where('id', teamId).first('name')
      const teamName = team?.name || `Team ${teamId}`
      const amountStr = `CHF ${Number(amount).toFixed(2)}`

      await database('notifications').insert({
        member: official.id,
        type: 'fine_issued',
        title: 'fine_issued',
        body: JSON.stringify({ team: teamName, amount: amountStr, reason: NO_SHOW_FINE_REASON, fineId, category: 'no_show' }),
        activity_type: 'fine',
        activity_id: String(fineId),
        team: teamId,
        read: false,
      })

      await sendLocalizedPush(
        database, [official.id],
        (ids, title, body) => sendPushToMembers(database, ids, title, body, `${FRONTEND_URL}/fines`, `fine-${fineId}`, log),
        'fineIssued.title', 'fineIssued.body',
        { team: teamName, amount: amountStr, reason: NO_SHOW_FINE_REASON },
      )
    } catch (e) {
      log.error({ msg: `duty-late: fine notify failed: ${e.message}`, gameId: game.id, stack: e.stack })
    }

    log.info({ msg: 'duty-late: auto-fine issued', gameId: game.id, member: official.id, team: teamId, amount, role })
  }

  function fail(res, err, req) {
    if (err && err.status) return res.status(err.status).json({ error: err.message })
    log.error({
      msg: `duty-late: ${err?.message}`,
      endpoint: 'games/:id/duty-late',
      userId: req.accountability?.user || null,
      method: req.method,
      stack: err?.stack,
    })
    return res.status(500).json({ error: 'Internal error' })
  }

  // GET — already-flagged roles + contact (in-window only). Never emails.
  router.get('/games/:id/duty-late', async (req, res) => {
    try {
      const { game } = await authorize(req)
      const startMs = gameStartMs(game)
      const late = parseLate(game.duty_late_json)
      const reports = {}
      const liveRoles = []
      for (const [role, rep] of Object.entries(late)) {
        const def = ROLE_DEFS[role]
        if (!def || !rep) continue
        if (!inWindow(startMs, def.arrival)) continue
        reports[role] = { at: rep.at, by_name: rep.by_name }
        liveRoles.push(role)
      }
      const contacts = await contactsFor(game, liveRoles)
      res.json({ reports, contacts })
    } catch (err) { fail(res, err, req) }
  })

  // POST { role } — flag a role late (idempotent), email on first flag, reveal contact.
  router.post('/games/:id/duty-late', async (req, res) => {
    try {
      const { game, memberId } = await authorize(req)
      const role = String(req.body?.role || '')
      const def = ROLE_DEFS[role]
      if (!def) return res.status(400).json({ error: 'Invalid role' })

      const officialId = game[def.member]
      if (officialId == null) return res.status(400).json({ error: 'No official assigned for this role' })

      const startMs = gameStartMs(game)
      if (!inWindow(startMs, def.arrival)) return res.status(409).json({ error: 'Outside the reporting window' })

      const official = await database('members').where('id', officialId)
        .first('id', 'first_name', 'last_name', 'email', 'phone', 'hide_phone', 'hide_email')
      if (!official) return res.status(404).json({ error: 'Assigned official not found' })

      const late = parseLate(game.duty_late_json)
      const already = late[role]

      // Claim the role in ONE statement, and only then fire the side effects.
      //
      // This used to be a read-modify-write: the WHOLE `duty_late_json` blob was
      // read back in authorize() and the WHOLE blob written back here. Two people
      // standing in the hall at kickoff — the coach flagging `scorer` while the
      // team responsible flags `referee` — both wrote a blob built from a snapshot
      // taken before the other's write, so the second one ERASED the first role's
      // report together with its idempotency flag: the alarm button came back and
      // the next press re-fired the whole mail chain. Two reports of the SAME role
      // both saw `!already` and both emailed the official + TK + club admin.
      //
      // The "not already flagged" test and the merge are now a single conditional
      // UPDATE. `||` merges server-side, so two DIFFERENT roles flagged at the same
      // moment both survive (legitimate concurrent callers are never serialised),
      // and the WHERE makes exactly one of two same-role racers the winner. Nothing
      // here is a lease, so a crashed request strands nothing: the row only ever
      // gains a finished report.
      let claimed = 0
      let reporterName = '—'
      if (!already) {
        const reporter = memberId
          ? await database('members').where('id', memberId).first('first_name', 'last_name')
          : null
        reporterName = reporter
          ? `${reporter.first_name} ${reporter.last_name}`.trim()
          : (req.accountability?.admin ? 'Admin' : '—')

        const entry = { at: new Date().toISOString(), by_name: reporterName }
        // jsonb_typeof() rather than a bare COALESCE: `||` would splice a stray
        // JSON scalar into an ARRAY, and parseLate() has always recovered from
        // one by starting over from {}. Constant SQL — the values are bound.
        const baseJson = "CASE WHEN jsonb_typeof(duty_late_json) = 'object' THEN duty_late_json ELSE '{}'::jsonb END"
        claimed = await database('games')
          .where('id', game.id)
          // jsonb_exists(), NOT the `?` operator — knex reads `?` as a binding.
          .whereRaw(`NOT jsonb_exists(${baseJson}, ?)`, [role])
          .update({
            duty_late_json: database.raw(`${baseJson} || ?::jsonb`, [JSON.stringify({ [role]: entry })]),
          })

        if (claimed === 1) {
          late[role] = entry
        } else {
          // Someone else flagged this role between our read and our write. Not an
          // error — the report exists and this endpoint is idempotent by contract,
          // so answer with THEIR report and send no second mail / fine / audit row.
          const fresh = await database('games').where('id', game.id).first('duty_late_json')
          late[role] = parseLate(fresh?.duty_late_json)[role] || entry
          log.warn({ msg: 'duty-late: role was flagged by a concurrent report — no second alarm', gameId: game.id, role })
        }
      }

      if (claimed === 1) {
        await writeUserLog(database, log, {
          accountability: req.accountability,
          action: 'duty-late',
          collection: 'games',
          recordId: game.id,
          data: { role, official: officialId, official_name: `${official.first_name} ${official.last_name}`.trim() },
        })

        // Auto-fine the flagged official (best-effort — never break the alarm).
        try {
          await issueNoShowFine({ game, role, def, official, reporterMemberId: memberId, accountability: req.accountability })
        } catch (e) {
          log.error({ msg: `duty-late: auto-fine failed: ${e.message}`, gameId: game.id, role, stack: e.stack })
        }

        // Email is best-effort — a mail failure must not lose the recorded flag.
        // Suppressed on dev (see SEND_DUTY_LATE_EMAILS) so tests don't spam.
        if (SEND_DUTY_LATE_EMAILS) {
          try {
            await sendLateEmails(database, MailService, getSchema, { game, def, official, reporterName })
          } catch (e) {
            log.error({ msg: `duty-late email failed: ${e.message}`, gameId: game.id, role, stack: e.stack })
          }
        } else {
          log.info({ msg: 'duty-late: email suppressed (dev)', gameId: game.id, role })
        }
      }

      const rep = late[role]
      res.json({
        report: { at: rep.at, by_name: rep.by_name },
        contact: {
          phone: official.phone || null,
          email: official.email || null,
          hide_phone: !!official.hide_phone,
          hide_email: !!official.hide_email,
        },
      })
    } catch (err) { fail(res, err, req) }
  })
}
