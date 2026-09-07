/**
 * Google Calendar Push — KSCW home games → "KSCW Heimspiele/Halle KWI".
 *
 * The pull half (gcal-sync.js) imports hall closures FROM that calendar. This is
 * the other direction: every KSCW home game in a KWI hall is written TO it, so
 * the hall administration (who own the calendar) and the club see the same
 * fixture list without anyone retyping it. Until 2026-07 this was a manual bulk
 * entry by the hall admin once per season.
 *
 * Auth is a Google service account (wiedisync-gcal@kscw-calendar.iam...), added
 * to the calendar's share list as a writer. No user, no OAuth consent, no
 * refresh token — we sign a JWT with the private key and swap it for an access
 * token. Key lives in GCAL_SERVICE_ACCOUNT_B64 (base64 of the JSON key file);
 * with no key set, push is a no-op and the pull behaves exactly as before.
 *
 * Ownership rule: we only ever touch events carrying our own private
 * extendedProperty (wiedisync=game). Everything else on that calendar — the hall
 * closures, the Handball tournament, ASVZ Volleynight — is other people's data
 * and is never updated or deleted, no matter what our DB thinks.
 */

import crypto from 'node:crypto'

export const KSCW_CALENDAR_ID = '145bqacb4v5qfkr97u2fdchi5o@group.calendar.google.com'
const KWI_ADDRESS = 'Kantonsschule Wiedikon, Goldbrunnenstrasse 80, 8055 Zürich'
const GAME_DURATION_MIN = 120 // games carry no end time; the hall admin's own entries used 2h

// ── auth ──────────────────────────────────────────────────────────────────────

let cachedToken = null // { token, expiresAt }

function loadKey() {
  const b64 = process.env.GCAL_SERVICE_ACCOUNT_B64
  if (!b64) return null
  try {
    const key = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    return key.client_email && key.private_key ? key : null
  } catch {
    return null
  }
}

export function isPushEnabled() {
  return loadKey() !== null
}

// Which environment is this? Stamped onto every event we create, so ownership is
// not merely "wiedisync wrote it" but "THIS instance wrote it".
export const pushEnv = () => ((process.env.PUBLIC_URL || '').includes('directus-dev') ? 'dev' : 'prod')

// There is exactly ONE production calendar and dev's database is a nightly clone
// of prod — so a dev instance with a key would push the same games and then fight
// prod over every edit.
//
// ⚠⚠ Dev is dry-run BY CODE, not merely by env var. It used to rest solely on
// GCAL_PUSH_DRY_RUN=true in dev's .env, which is one lost env var — or one
// container recreate — away from dev writing to the school's live calendar. And
// it would not just create noise: the closure reconciler's delete loop removes
// every event marked ours that dev does not also have flagged, and dev's
// push_to_gcal flags diverge from prod's the moment anyone toggles one. A dev run
// on 2026-08-18 reported `-2` — it would have deleted both VB U20 Tournament
// entries from the hall administration's calendar.
//
// GCAL_PUSH_FORCE_WRITE=1 is the deliberate escape hatch for testing a real write
// from dev; nothing sets it, and it has to be typed on purpose.
export const isDryRun = () => process.env.GCAL_PUSH_DRY_RUN === 'true'
  || (pushEnv() === 'dev' && process.env.GCAL_PUSH_FORCE_WRITE !== '1')

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token
  const key = loadKey()
  if (!key) throw new Error('GCAL_SERVICE_ACCOUNT_B64 not set')

  const b64url = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })}`
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url')

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  })
  const body = await resp.json()
  if (!body.access_token) throw new Error(`GCal token exchange failed: ${JSON.stringify(body).slice(0, 200)}`)
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
  return cachedToken.token
}

async function api(path, { method = 'GET', body, query } = {}) {
  const token = await getAccessToken()
  const qs = query ? `?${new URLSearchParams(query)}` : ''
  const resp = await fetch(`https://www.googleapis.com/calendar/v3${path}${qs}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (resp.status === 204) return null
  const json = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(`GCal ${method} ${path} → ${resp.status} ${JSON.stringify(json.error ?? json).slice(0, 200)}`)
  return json
}

// ── shaping ───────────────────────────────────────────────────────────────────

// Wall-clock time in Zurich, as YYYY-MM-DDTHH:MM. Comparing wall time (rather
// than instants) keeps the DST boundary honest: a 20:00 game is 20:00 whether
// it falls in CET or CEST, and Google echoes back an offset we'd otherwise have
// to re-derive.
function zurichWallTime(isoWithOffset) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Zurich',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(isoWithOffset))
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + minutes
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// "VB D4 vs. Rüschlikon 4 (Halle A)" — the format the hall administration has
// used for years. Keep it; they read this calendar.
//
// ⚠ The sport comes from the TEAM, not from `game.source`. Deriving it from the
// source ("basketplan → BB, else VB") mislabelled every hand-entered basketball
// fixture: `ManualGameModal` writes source='manual', so all 5 upcoming BB home
// games at KWI read "VB Lions D1 vs. RJ Lakers D1" on the school's calendar
// (reported 07.09.2026 by the hall administration). `source` still decides the
// two Basketplan rows that carry no kscw_team.
export function buildEvent(game) {
  const prefix = game.sport === 'basketball' || game.source === 'basketplan' ? 'BB' : 'VB'
  const team = game.team_name || game.home_team || '?'
  // "A" for one floor, "A+B" for a game that takes the divider out. The hall
  // administration schedules by floor, so a double-floor fixture that reads
  // "(Halle A)" tells them B is free when it is not.
  const hall = `Halle ${game.hall_label}`
  const startTime = String(game.time).slice(0, 5)
  const day = String(game.date).slice(0, 10)

  return {
    summary: `${prefix} ${team} vs. ${game.away_team} (${hall})`,
    description: `KSC Wiedikon ${team} – ${game.away_team}\nDetails: wiedisync.kscw.ch`,
    location: `${hall}, ${KWI_ADDRESS}`,
    start: { dateTime: `${day}T${startTime}:00`, timeZone: 'Europe/Zurich' },
    end: { dateTime: `${day}T${addMinutes(startTime, GAME_DURATION_MIN)}:00`, timeZone: 'Europe/Zurich' },
    transparency: 'transparent', // never block anyone's own calendar
    extendedProperties: { private: { wiedisync: 'game', game_id: game.game_id } },
  }
}

// A `basketball_slot_plan` row in the shape buildEvent() expects. The grid
// stores a hall LABEL ("KWI A+B"), not a hall id, so the floor part is a string
// trim rather than the vb_slot_floors projection the `games` side needs.
export function placementFixture(p) {
  return {
    game_id: `bbplan_${p.id}`,
    sport: 'basketball',
    team_name: p.team_name,
    home_team: p.kscw_team_label,
    away_team: p.opponent,
    hall_label: String(p.hall ?? '').replace(/^kwi\s*/i, '').trim(),
    date: p.date,
    time: String(p.time).slice(0, 5),
  }
}

// The exact shape buildEvent() emits. The pull half uses it as a backstop for
// "this event is ours" when the event-id set is unavailable (push disabled), so
// it must stay narrow: the hall administration hand-types its own basketball
// entries ("BB - Freundschaftsspiel", "BB DU16E …") which are NOT ours and must
// keep importing as hall_events.
const OWN_GAME_TITLE = /^(?:VB|BB) .+ vs\. .+ \(Halle [A-Z](?:\+[A-Z])*\)$/

export function isOwnGameTitle(title) {
  return OWN_GAME_TITLE.test(String(title ?? '').trim())
}

function needsUpdate(existing, desired) {
  return (
    existing.summary !== desired.summary ||
    (existing.description ?? '') !== desired.description ||
    (existing.location ?? '') !== desired.location ||
    zurichWallTime(existing.start?.dateTime) !== `${desired.start.dateTime.slice(0, 16)}` ||
    zurichWallTime(existing.end?.dateTime) !== `${desired.end.dateTime.slice(0, 16)}` ||
    existing.extendedProperties?.private?.game_id !== desired.extendedProperties.private.game_id
  )
}

// ── sync ──────────────────────────────────────────────────────────────────────

/**
 * Reconcile KWI home fixtures onto the calendar — `games` rows plus accepted
 * basketball placements that have no `games` row yet.
 * Returns { created, updated, deleted, skipped, eventIds } — eventIds is every
 * event we own, so the pull half can skip its own output instead of re-importing
 * our games as hall_events.
 */
export async function pushHomeGames(db, log) {
  if (!isPushEnabled()) return { created: 0, updated: 0, deleted: 0, skipped: 0, eventIds: new Set(), disabled: true }

  // Manage today forward only. Past events are frozen history: never rewritten,
  // never swept, even if the game row is later corrected or deleted.
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date())

  const games = await db('games as g')
    .join('halls as h', 'h.id', 'g.hall')
    .leftJoin('teams as t', 't.id', 'g.kscw_team')
    .where('g.type', 'home')
    .whereRaw("h.name ~* '^kwi'")
    .andWhere('g.date', '>=', today)
    .whereNotNull('g.game_id')
    .select(
      'g.game_id',
      'g.away_team',
      'g.home_team',
      'g.source',
      db.raw('g.date::text as date'),
      db.raw("to_char(g.time, 'HH24:MI') as time"),
      // Same floor projection the Hallenplan and bb_floor_claims_all use, so a
      // game booked across the divider says so. NULLIF guards a hall whose name
      // vb_slot_floors cannot map, which falls back to the trailing letter.
      db.raw("COALESCE(NULLIF(array_to_string(vb_slot_floors(g.hall, g.additional_halls::jsonb), '+'), ''), right(h.name, 1)) as hall_label"),
      'g.kscw_team',
      't.name as team_name',
      't.sport as sport',
    )

  // Basketball home fixtures reach the DB by two independent roads and only one
  // of them is a `games` row: the prep grid at /admin/terminplanung/basketball
  // writes `basketball_slot_plan` placements, which hold the KWI floor from the
  // moment the opponent agrees but may not become a `games` row until Basketplan
  // publishes the fixture — months later, or never for a friendly. Publishing
  // only `games` left 8 agreed KWI fixtures off the hall administration's
  // calendar (reported 07.09.2026 alongside the VB/BB mislabelling).
  //
  // ⚠ ACCEPTED ONLY. A draft placement is a negotiating position — 44 of the 52
  // upcoming ones were drafts — and republishing every counter-proposal onto a
  // calendar the school owns would be worse than publishing nothing.
  const placements = await db('basketball_slot_plan as p')
    .leftJoin('teams as t', 't.id', 'p.kscw_team')
    .where('p.game_type', 'home')
    .andWhere('p.proposal_status', 'accepted')
    .andWhere('p.date', '>=', today)
    .whereRaw("p.hall ~* '^kwi'")
    .select(
      'p.id',
      'p.kscw_team',
      'p.time',
      'p.hall',
      'p.opponent',
      'p.kscw_team_label',
      db.raw('p.date::text as date'),
      't.name as team_name',
    )

  const desired = new Map()
  let skipped = 0
  // "This team already has a home fixture that day", so a placement that has
  // since been promoted to a `games` row is published once, not twice. Keyed on
  // date+team rather than date+floor because a promotion routinely corrects the
  // time or moves the game between floors, and rather than on the opponent
  // because the two roads spell club names differently (the grid's free-text
  // name vs. Basketplan's).
  const fixtureDays = new Set()
  for (const game of games) {
    // No kick-off time means we cannot place it in a hall slot honestly. Leave it
    // off the calendar rather than invent an hour.
    if (!game.time || !game.away_team) { skipped++; continue }
    desired.set(game.game_id, buildEvent(game))
    if (game.kscw_team) fixtureDays.add(`${game.date}|${game.kscw_team}`)
  }

  let superseded = 0
  for (const p of placements) {
    // Migration 346's fail-safe stores '' for a fixture with no tip-off yet. It
    // blocks the floor all day internally; on the calendar it would be a lie.
    if (!p.time || !p.opponent) { skipped++; continue }
    if (p.kscw_team && fixtureDays.has(`${p.date}|${p.kscw_team}`)) { superseded++; continue }
    desired.set(`bbplan_${p.id}`, buildEvent(placementFixture(p)))
  }

  // Everything we own, from today forward. Two sources: the private marker
  // (everything the sync itself has written) and the transitional signature of
  // the 70 events seeded by hand in 2026-07, which predate the marker.
  const existing = new Map() // game_id → event
  const timeMin = `${today}T00:00:00Z`

  const collect = async (query) => {
    let pageToken
    do {
      const page = await api(`/calendars/${encodeURIComponent(KSCW_CALENDAR_ID)}/events`, {
        query: { timeMin, singleEvents: 'true', maxResults: '250', ...query, ...(pageToken ? { pageToken } : {}) },
      })
      for (const ev of page.items ?? []) {
        const marked = ev.extendedProperties?.private?.wiedisync === 'game'
        const gameId = ev.extendedProperties?.private?.game_id
        if (marked && gameId) { existing.set(gameId, ev); continue }
        // Transitional: seeded by hand, keyed by the visible "Spielnummer" line.
        // Both halves of the signature must match so we can never adopt — and
        // therefore never delete — an event a human wrote.
        const desc = ev.description ?? ''
        const legacy = /Spielnummer (\S+)/.exec(desc)
        if (legacy && desc.includes('wiedisync.kscw.ch')) existing.set(`vb_${legacy[1]}`, ev)
      }
      pageToken = page.nextPageToken
    } while (pageToken)
  }

  await collect({ privateExtendedProperty: 'wiedisync=game' })
  await collect({}) // adoption sweep; drops out naturally once every event is marked

  const dryRun = isDryRun()
  let created = 0
  let updated = 0
  let deleted = 0
  const eventIds = new Set()

  for (const [gameId, event] of desired) {
    const current = existing.get(gameId)
    if (!current) {
      if (!dryRun) {
        const made = await api(`/calendars/${encodeURIComponent(KSCW_CALENDAR_ID)}/events`, {
          method: 'POST', body: event, query: { sendUpdates: 'none' },
        })
        eventIds.add(made.id)
      }
      created++
    } else {
      eventIds.add(current.id)
      if (needsUpdate(current, event)) {
        if (!dryRun) {
          await api(`/calendars/${encodeURIComponent(KSCW_CALENDAR_ID)}/events/${current.id}`, {
            method: 'PATCH', body: event, query: { sendUpdates: 'none' },
          })
        }
        updated++
      }
    }
  }

  // Ours, but no longer a KWI home game — cancelled, rescheduled away, or moved
  // to Döltschi. Only events we own reach this loop.
  for (const [gameId, event] of existing) {
    if (desired.has(gameId)) continue
    if (!dryRun) {
      await api(`/calendars/${encodeURIComponent(KSCW_CALENDAR_ID)}/events/${event.id}`, {
        method: 'DELETE', query: { sendUpdates: 'none' },
      })
    }
    deleted++
  }

  if (skipped) log.warn({ msg: `gcal-push: ${skipped} home fixture(s) skipped (no kick-off time or opponent)`, endpoint: 'gcal-sync' })
  log.info({
    msg: `gcal-push${dryRun ? ' (dry run — nothing written)' : ''}: +${created} ~${updated} -${deleted}`
      + ` (${games.length} games, ${placements.length} accepted placements, ${superseded} superseded)`,
    endpoint: 'gcal-sync',
  })
  return { created, updated, deleted, skipped, superseded, dryRun, eventIds }
}

// ── club closures → their calendar ────────────────────────────────────────────

/**
 * Stable identity for a closure GROUP. A KWI closure is three rows (hall A/B/C)
 * and the calendar convention is one entry naming the halls, so the key is the
 * span + reason, not a row id — which also means re-saving a closure (delete +
 * recreate, as the edit path does) keeps the same calendar event instead of
 * orphaning one and creating another.
 */
export function closureKey(startDate, endDate, reason) {
  return crypto.createHash('sha1')
    .update(`${startDate}|${endDate}|${String(reason || '').trim().toLowerCase()}`)
    .digest('hex').slice(0, 32)
}

/**
 * Does the hall administration already cover this span?
 *
 * Read from `hall_events` — our mirror of THEIR calendar. Our own pushed events
 * never land there (the pull half skips them by event id), so any overlap is
 * genuinely theirs and pushing on top would be the duplicate the club asked us
 * to avoid. Derived per run, never cached: their entry can appear or vanish at
 * any time, and a stale boolean is the exact failure this feature exists to fix.
 */
export function findDuplicate(hallEvents, startDate, endDate) {
  return hallEvents.find((he) => {
    const s = String(he.date || '').slice(0, 10)
    const e = String(he.end_date || he.date || '').slice(0, 10)
    return s && s <= endDate && e >= startDate
  }) || null
}

/**
 * May THIS instance delete an event another wiedisync instance may have written?
 *
 * `wiedisync=closure` only says "some wiedisync wrote it" — dev and prod share
 * one calendar and their push_to_gcal flags diverge, so "marked ours but not in
 * my desired set" is not grounds to remove it. Unstamped events predate the
 * stamp and only prod ever wrote, so prod adopts them and dev leaves them alone.
 */
export function mayDelete(eventEnv, myEnv) {
  return eventEnv ? eventEnv === myEnv : myEnv === 'prod'
}

// All-day event covering [start, end] inclusive. Google's `end.date` is
// EXCLUSIVE, so it is the day AFTER our inclusive end — the same conversion the
// pull half undoes with minusOneDay().
function buildClosureEvent(group) {
  const endExclusive = new Date(`${group.end_date}T00:00:00Z`)
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)
  const halls = group.halls.slice().sort()
  const hallText = halls.length ? ` (${halls.join(', ')})` : ''

  return {
    summary: `KSCW: ${group.reason}${hallText}`,
    description: `Belegung durch KSC Wiedikon.\nDetails: wiedisync.kscw.ch`,
    location: KWI_ADDRESS,
    start: { date: group.start_date },
    end: { date: endExclusive.toISOString().slice(0, 10) },
    transparency: 'transparent',
    extendedProperties: { private: { wiedisync: 'closure', closure_key: group.key, env: pushEnv() } },
  }
}

function closureNeedsUpdate(existing, desired) {
  return (
    existing.summary !== desired.summary
    || (existing.start?.date ?? '') !== desired.start.date
    || (existing.end?.date ?? '') !== desired.end.date
    // Also patches the two events pushed before the stamp existed, so they stop
    // being "unstamped legacy" after one prod run.
    || (existing.extendedProperties?.private?.env ?? '') !== desired.extendedProperties.private.env
  )
}

/**
 * Ids of every closure event WE own, today forward.
 *
 * The pull half parses the ICS feed, which carries no extendedProperties — so an
 * event we wrote is indistinguishable from the Hausdienst's unless we hand the
 * importer the ids. Games solve this by returning them from their push; closures
 * cannot, because their push must run AFTER the import (it needs the fresh
 * hall_events mirror to detect duplicates). Hence this separate cheap lookup,
 * called before the import.
 *
 * Without it our own pushed closure round-trips: imported as a hall_event, and
 * since migration 325 every hall_event closes the halls — so it would re-create
 * the very closure it describes, as a second row from a different source.
 */
export async function listOwnedClosureEventIds() {
  if (!isPushEnabled()) return new Set()
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date())
  const ids = new Set()
  let pageToken
  do {
    const page = await api(`/calendars/${encodeURIComponent(KSCW_CALENDAR_ID)}/events`, {
      query: {
        timeMin: `${today}T00:00:00Z`, singleEvents: 'true', maxResults: '250',
        privateExtendedProperty: 'wiedisync=closure',
        ...(pageToken ? { pageToken } : {}),
      },
    })
    for (const ev of page.items ?? []) ids.add(ev.id)
    pageToken = page.nextPageToken
  } while (pageToken)
  return ids
}

/**
 * Reconcile the club's OWN blocked dates onto the hall administration's calendar.
 *
 * Opt-in per closure (`hall_closures.push_to_gcal`), because that calendar is the
 * school's. Sources 'gcal' (came from there) and 'school_holidays' (theirs to
 * enter) are excluded regardless of the flag.
 *
 * ⚠ Ownership: only events carrying `wiedisync=closure` are ever updated or
 * deleted. Their closures, the Handball tournament, ASVZ Volleynight are never
 * touched — and note this marker is distinct from the games' `wiedisync=game`,
 * so the two reconcilers can never delete each other's events.
 *
 * @returns { created, updated, deleted, skippedDuplicate, eventIds }
 */
export async function pushClubClosures(db, log, hallEvents = []) {
  if (!isPushEnabled()) {
    return { created: 0, updated: 0, deleted: 0, skippedDuplicate: 0, eventIds: new Set(), disabled: true }
  }

  // Today forward only — same rule as the games half. Past closures are frozen
  // history and pushing them tells the school nothing it can act on.
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date())

  const rows = await db('hall_closures as c')
    .join('halls as h', 'h.id', 'c.hall')
    .where('c.push_to_gcal', true)
    .whereNotIn('c.source', ['gcal', 'school_holidays'])
    .andWhere('c.end_date', '>=', today)
    .select(
      db.raw('c.start_date::text as start_date'),
      db.raw('c.end_date::text as end_date'),
      'c.reason',
      'h.name as hall_name',
    )

  // One event per (span, reason); the halls become part of the title.
  const groups = new Map()
  for (const r of rows) {
    const key = closureKey(r.start_date, r.end_date, r.reason)
    const g = groups.get(key)
      || { key, start_date: r.start_date, end_date: r.end_date, reason: r.reason, halls: [] }
    if (r.hall_name && !g.halls.includes(r.hall_name)) g.halls.push(r.hall_name)
    groups.set(key, g)
  }

  const desired = new Map()
  let skippedDuplicate = 0
  for (const [key, g] of groups) {
    const dup = findDuplicate(hallEvents, g.start_date, g.end_date)
    if (dup) {
      skippedDuplicate++
      log.info({ msg: `gcal-push: closure "${g.reason}" ${g.start_date}..${g.end_date} already covered by their "${dup.title}" — not pushed`, endpoint: 'gcal-sync' })
      continue
    }
    desired.set(key, buildClosureEvent(g))
  }

  // Everything WE own on the closure side, today forward.
  const existing = new Map()
  let pageToken
  do {
    const page = await api(`/calendars/${encodeURIComponent(KSCW_CALENDAR_ID)}/events`, {
      query: {
        timeMin: `${today}T00:00:00Z`, singleEvents: 'true', maxResults: '250',
        privateExtendedProperty: 'wiedisync=closure',
        ...(pageToken ? { pageToken } : {}),
      },
    })
    for (const ev of page.items ?? []) {
      const k = ev.extendedProperties?.private?.closure_key
      if (k) existing.set(k, ev)
    }
    pageToken = page.nextPageToken
  } while (pageToken)

  const dryRun = isDryRun()
  let created = 0, updated = 0, deleted = 0
  const eventIds = new Set()

  for (const [key, event] of desired) {
    const current = existing.get(key)
    if (!current) {
      if (!dryRun) {
        const made = await api(`/calendars/${encodeURIComponent(KSCW_CALENDAR_ID)}/events`, {
          method: 'POST', body: event, query: { sendUpdates: 'none' },
        })
        eventIds.add(made.id)
      }
      created++
    } else {
      eventIds.add(current.id)
      if (closureNeedsUpdate(current, event)) {
        if (!dryRun) {
          await api(`/calendars/${encodeURIComponent(KSCW_CALENDAR_ID)}/events/${current.id}`, {
            method: 'PATCH', body: event, query: { sendUpdates: 'none' },
          })
        }
        updated++
      }
    }
  }

  // Ours, but no longer wanted — un-ticked, deleted, or now covered by one of
  // their own entries. Only `wiedisync=closure` events reach this loop.
  //
  // ⚠⚠ THIS LOOP IS WHY `GCAL_PUSH_DRY_RUN=true` ON DEV IS LOAD-BEARING, and more
  // sharply so than for games. There is one production calendar, and the READ
  // above is never dry — so dev sees the events PROD published. Dev's `desired`
  // set is built from dev's own `push_to_gcal` flags, which diverge from prod's
  // the moment anybody toggles one on dev (they only agree just after the 03:00
  // clone). Every prod-published closure dev does not also have flagged
  // therefore lands here as a delete. Observed on 2026-08-18: a dev run reported
  // `-2`, i.e. it would have silently removed both VB U20 Tournament entries
  // from the hall administration's calendar. Only the dry run stopped it.
  const me = pushEnv()
  let foreign = 0
  for (const [key, event] of existing) {
    if (desired.has(key)) continue
    // ⚠⚠ Never delete another ENVIRONMENT's event. `wiedisync=closure` says only
    // that some wiedisync wrote it; dev and prod share one calendar and their
    // push_to_gcal flags diverge, so "marked ours but not in my desired set" is
    // NOT sufficient grounds to remove it. Unstamped events predate this guard
    // and only prod ever wrote, so prod adopts them (and stamps them on update);
    // dev leaves them alone. This is the belt to the dry-run's braces — the
    // failure it prevents is deleting the club's real bookings off the school's
    // calendar, which nothing would alert us to.
    if (!mayDelete(event.extendedProperties?.private?.env, me)) { foreign++; continue }
    if (!dryRun) {
      await api(`/calendars/${encodeURIComponent(KSCW_CALENDAR_ID)}/events/${event.id}`, {
        method: 'DELETE', query: { sendUpdates: 'none' },
      })
    }
    deleted++
  }
  if (foreign) {
    log.warn({ msg: `gcal-push closures: left ${foreign} event(s) belonging to another environment untouched`, endpoint: 'gcal-sync' })
  }

  log.info({ msg: `gcal-push closures${dryRun ? ' (dry run — nothing written)' : ''}: +${created} ~${updated} -${deleted} (${skippedDuplicate} already on their calendar)`, endpoint: 'gcal-sync' })
  return { created, updated, deleted, skippedDuplicate, dryRun, eventIds }
}
