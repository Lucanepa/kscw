/**
 * Google Calendar Sync — ported from gcal_sync_lib.js
 * POST /kscw/admin/gcal-sync — manual trigger (admin only)
 * Also registered as cron in hooks extension (04:00 UTC daily).
 *
 * The KSCW public calendar (embedded at kscw.ch/weiteres/kalender) is a
 * closures-only calendar — every entry means the hall is unavailable that day
 * ("Halle geschlossen", school holidays, tournaments occupying the gym, etc.).
 * So EVERY event is treated as a hall closure:
 *   • hall_closures (source='gcal') — the functional block. One row per KWI hall
 *     (A/B/C — the school gym the calendar refers to), written via ItemsService
 *     so the `hall_closures.items.create/delete` auto-cancel hook fires and
 *     overlapping trainings get cancelled / reversed. This is what makes the
 *     closure actually take effect.
 *   • hall_events (source='gcal') — the display row the Hallenplan / iCal feed
 *     render. Kept for continuity (upserted by uid).
 * Both are reconciled against the live feed each run (insert new, delete stale)
 * so nothing churns for unchanged entries.
 */

import { pushHomeGames, pushClubClosures, listOwnedClosureEventIds, findDuplicate, isOwnGameTitle, KSCW_CALENDAR_ID } from './gcal-push.js'
import { writeUserLog } from './activity-log.js'
import { emptyChanges, hasChanges, notifyGCalChanges } from './gcal-notify.js'

const GCAL_IDS = [
  // KSCW public calendar (kscw.ch/weiteres/kalender → embedded Google Calendar).
  KSCW_CALENDAR_ID,
]

// ── In-flight guard for the sync ───────────────────────────────────────
// `runSync` is one long check-then-act with no transaction around it: it reads
// the current state (the hall_closures rows in `existKeys`, and the events
// already on the calendar inside pushHomeGames) and then creates whatever that
// snapshot says is missing. Nothing arbitrates a second, overlapping run —
// hall_closures has no unique index on (hall, start_date, end_date) and Google
// accepts a second identical event without complaint — so two runs that both
// read the pre-state both write: twin closure rows for one hall+span (the twin
// then blocks the delete path's NOT EXISTS guard from reinstating trainings),
// twin fixture events on a calendar the club does not own, and the club-admin
// change digest mailed twice. The overlapping actors are real and ordinary: the
// 04:00 UTC cron POSTs this endpoint while an admin presses "Run now" on
// /admin/status, or two admins press it.
//
// The guard is PROCESS-LOCAL on purpose. Closing this in the database would need
// a schema change (a partial unique index on hall_closures), which is out of
// scope for this batch. Directus runs as ONE container here, so a module-level
// claim genuinely covers both actor pairs today. ⚠ It would NOT survive scaling
// to multiple Directus instances — that needs the index, or an advisory lock
// taken on a connection pinned for the whole run. It is also crash-safe in the
// only way that matters: the claim lives in memory and dies with the process,
// and every exit path releases it in a `finally`.
const IN_FLIGHT = new Set()
const SYNC_KEY = 'gcal-sync'

function parseIcsDatetime(str) {
  if (!str) return null
  str = str.trim()
  // DATE-only: YYYYMMDD
  if (/^\d{8}$/.test(str)) {
    return { date: `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`, allDay: true }
  }
  // DATETIME: YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
  const m = str.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/)
  if (!m) return null
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
  if (m[7]) {
    // UTC — convert to Zurich (approximate: +1 in winter, +2 in summer)
    const month = dt.getUTCMonth()
    const offset = (month >= 2 && month <= 9) ? 2 : 1
    dt.setUTCHours(dt.getUTCHours() + offset)
  }
  const d = dt.toISOString().slice(0, 10)
  const t = dt.toISOString().slice(11, 16)
  return { date: d, time: t, allDay: false }
}

// ICS all-day DTEND is EXCLUSIVE (a single 04.12 all-day event is
// DTSTART 20261204 / DTEND 20261205). Convert to an inclusive end date.
function minusOneDay(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function parseIcs(text) {
  const events = []
  const blocks = text.split('BEGIN:VEVENT')
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0]
    const ev = {}
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(':')
      const val = rest.join(':')
      const baseKey = key.split(';')[0]
      if (baseKey === 'SUMMARY') ev.title = val
      if (baseKey === 'DTSTART') ev.start = parseIcsDatetime(val)
      if (baseKey === 'DTEND') ev.end = parseIcsDatetime(val)
      if (baseKey === 'UID') ev.uid = val
      if (baseKey === 'LOCATION') ev.location = val
    }
    if (ev.uid && ev.start) events.push(ev)
  }
  return events
}

// ⚠ There is deliberately no keyword test any more (migration 325).
//
// Until 2026-08-18 a closure was an entry whose TITLE matched
// geschlossen|gesperrt|reserv|turnier|… and was not a club game or training.
// That fails on exactly the input a hand-typed calendar produces: the hall
// administration wrote `Halle Resveiert für Prüfung` for 24.–26.10.2026 and the
// typo missed `reserv`, so the hall read FREE while the school had it booked for
// an exam — six KWI trainings still standing on Monday 26.10. A keyword list is
// always one typo behind.
//
// So the rule is inverted: **anything the hall administration puts on that
// calendar closes the halls**, and a human decides the exceptions per entry via
// `hall_events.closure_override` (admin UI on /admin/hallenplan/closures).
// Measured against the live feed at the flip, this changed 1 of 19 future
// entries — the exam reservation; the other 18 already matched.
//
// Our OWN events never reach here: pushed games are dropped by event id and, as
// a backstop, by the exact title shape buildEvent() emits — both before this
// point. Closing the hall for our own game would cancel the very game it
// describes.
//
// override === false → admin says this one closes nothing.
// override === true / null/undefined → closes (true is a recorded human "yes").
export function closesTheHall(override) {
  return override !== false
}

export function registerGCalSync(router, { database, logger, services, getSchema }) {
  const log = logger.child({ endpoint: 'gcal-sync' })
  // Factory, NOT a class — lowercase on purpose: `new ItemsServiceFor(...)` is a
  // TypeError that only shows up at request time (eslint no-undef cannot see it).
  const itemsServiceFor = (schema) => new services.ItemsService('hall_closures', { schema, knex: database })

  // Normalise a value read back from Postgres for comparison with what we are
  // about to write: knex hands `date` columns back as Date objects and `time`
  // columns as 'HH:MM:SS', while the ICS parser produces 'YYYY-MM-DD' / 'HH:MM'.
  // Compare the normalised forms or every row looks changed on every run.
  const asDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10))
  const asTime = (v) => (v == null || v === '' ? '' : String(v).slice(0, 5))
  const asText = (v) => String(v ?? '').trim()

  async function runSync(db, schema, { trigger = 'manual' } = {}) {
    const { ItemsService } = services
    // What the Hausdienst actually changed this run — drives the admin digest.
    const changes = emptyChanges()

    // ── PUSH first: our home games onto the calendar. It hands back the ids of
    // every event we own, so the import below can skip its own output instead of
    // re-importing our games as duplicate hall_events display rows.
    const push = await pushHomeGames(db, log)

    // Ids of the closure events we own. Fetched HERE, before the import, because
    // the ICS feed carries no extendedProperties: without them our own pushed
    // closure is imported as a hall_event, and since migration 325 every
    // hall_event closes the halls — so it would re-create the very closure it
    // describes, from a second source. The closure PUSH itself runs after the
    // import, which is why it cannot hand these back the way the games push does.
    let ownedClosureIds = new Set()
    try {
      ownedClosureIds = await listOwnedClosureEventIds()
    } catch (err) {
      // A failure here must not abort the pull. Worst case we re-import our own
      // closure as a hall_event, which the next run reconciles away.
      log.warn({ msg: `gcal-sync: could not list owned closure events: ${err.message}`, endpoint: 'gcal-sync' })
    }

    const halls = await db('halls').select('id', 'name')
    // Halls a calendar closure applies to: the KWI school gym (A/B/C). These are
    // the halls the public calendar's "Halle geschlossen" entries refer to and
    // the set the previous gcal sync used. Döltschi / external halls follow their
    // own availability and are not closed by this calendar.
    const kwiHallIds = halls.filter(h => /^kwi/i.test(h.name)).map(h => h.id)

    let eventsCreated = 0, eventsUpdated = 0, eventsDeleted = 0
    let closuresCreated = 0, closuresDeleted = 0
    // Entries an admin has explicitly marked as "closes nothing".
    let overriddenOff = 0

    for (const calId of GCAL_IDS) {
      const url = `https://calendar.google.com/calendar/ical/${encodeURIComponent(calId)}/public/basic.ics`
      const resp = await fetch(url)
      if (!resp.ok) { log.warn({ msg: `GCal fetch failed for ${calId}: ${resp.status}`, endpoint: 'gcal-sync', calendarId: calId, httpStatus: resp.status }); continue }
      const icsText = await resp.text()
      const events = parseIcs(icsText)

      // Season start (Sept 1 of current or previous year) — the floor for
      // importing hall_events DISPLAY rows, so the Hallenplan can still show the
      // season behind us.
      const now = new Date()
      // ⚠ Sep 1, NOT the club's Jun 1 cutover (season.js) — deliberate. This is a
      // churn floor, not a season label.
      const seasonStart = new Date(now.getMonth() < 8 ? now.getFullYear() - 1 : now.getFullYear(), 8, 1)
        .toISOString().split('T')[0]

      // ⚠ CLOSURES are managed from TODAY forward only, which is a tighter floor
      // than the display rows above. Under the old keyword rule the two could
      // share a floor because barely any past entry matched; since migration 325
      // every entry is a closure, and a season floor back-filled 150 closure rows
      // in one run — every club game and training the hall administration had
      // hand-typed since September, retroactively "closing" halls for evenings
      // that are long over. It cancelled nothing (the auto-cancel hook is bounded
      // to CURRENT_DATE), it was pure noise in the closures list. Closing a hall
      // in the past achieves nothing, so we neither create nor delete back there
      // — past closures stay exactly as they were.
      const todayYmd = new Date().toISOString().slice(0, 10)

      // Zurich school holidays are the curated source of truth and take
      // PRIORITY: never create a gcal closure where a school_holidays closure
      // already covers that hall+date (no duplicates; the holiday record stands,
      // and we don't churn/reverse it). Mirrors schulferien-sync's own
      // skip-if-overlapping rule.
      const shRows = await db('hall_closures')
        .where('source', 'school_holidays').andWhere('end_date', '>=', todayYmd)
        .select('hall', db.raw('start_date::text as s'), db.raw('end_date::text as e'))
      const shByHall = new Map()
      for (const r of shRows) {
        const list = shByHall.get(r.hall) || []
        list.push([(r.s || '').slice(0, 10), (r.e || '').slice(0, 10)])
        shByHall.set(r.hall, list)
      }
      const coveredBySchoolHoliday = (hall, start, end) =>
        (shByHall.get(hall) || []).some(([s, e]) => start <= e && end >= s)

      const seenUids = new Set()
      // Desired hall_closures for this feed, keyed hall|start|end (no reason in
      // the key, so re-titling an entry doesn't force a delete+recreate).
      const desiredClosures = new Map()

      for (const ev of events) {
        if (!ev.start || ev.start.date < seasonStart) continue
        // Never re-import an event WE wrote (ICS UID is "<eventId>@google.com").
        // Our games already reach the Hallenplan as virtual slots off `games`, so
        // a hall_events row would duplicate them — and a hall_closure would cancel
        // the very game it describes.
        //
        // Deliberately keyed on OUR event ids, not on a "BB "/"VB " title prefix:
        // the hall admin hand-types basketball friendlies and junior games
        // (`BB - Freundschaftsspiel`, `BB DU16E …`) that exist ONLY on this
        // calendar and in no `games` row. Skipping those by title deleted 84
        // hall_events on dev — i.e. showed the hall as free while a junior game
        // was being played in it. Other people's events keep importing exactly as
        // they did before.
        const evId = String(ev.uid).split('@')[0]
        if (push.eventIds.has(evId) || ownedClosureIds.has(evId)) continue
        // Backstop for the event-id skip above (empty when push is disabled).
        // Matches only "<VB|BB> <team> vs. <opponent> (Halle X)" — our own
        // format — so the hall admin's hand-typed "BB - Freundschaftsspiel" and
        // "BB DU16E …" still import. A bare "VB " prefix used to do this job and
        // covered nothing once basketball games stopped being mislabelled VB.
        if (isOwnGameTitle(ev.title)) continue // club games — app-managed, never a closure
        seenUids.add(ev.uid)

        // ── hall_events (display) — upsert by uid (raw knex; no hook needed).
        // No hall link here: hall_events has no physical hall column (the old
        // `hall` field was a Directus M2M alias raw knex can't write — setting
        // record.hall would crash the whole import with 42703). The Hallenplan
        // resolves halls from title/location text client-side
        // (virtualSlots.resolveHallEventHalls). ──
        // Inclusive last day. The ICS DTEND is EXCLUSIVE for all-day entries, so a
        // single 04.12 all-day event arrives as 04.12→05.12. Stored (migration
        // 325) because the span used to live only in the feed: the closure rows
        // were written from it and it was then thrown away, leaving nothing
        // outside a sync run able to say which days an entry covers — which is
        // precisely what the admin override needs.
        const startD = ev.start.date
        let endD = startD
        if (ev.end?.date) endD = ev.end.allDay ? minusOneDay(ev.end.date) : ev.end.date
        if (endD < startD) endD = startD

        const record = {
          title: ev.title || '', date: startD, end_date: endD,
          start_time: ev.start.time || null, end_time: ev.end?.time || null,
          all_day: ev.start.allDay, location: ev.location || '',
          source: 'gcal', uid: ev.uid,
        }
        const existing = await db('hall_events').where('uid', ev.uid).first()
        if (existing) {
          // The UPDATE below is unconditional (cheap, and it refreshes
          // date_updated), so `eventsUpdated` counts every row in the feed and is
          // NOT a change signal. Diff the stored row first so the digest reports
          // only what the hall administration actually moved.
          const diffs = []
          const cmp = (field, before, after) => { if (before !== after) diffs.push({ field, from: before, to: after }) }
          cmp('title', asText(existing.title), asText(record.title))
          cmp('date', asDay(existing.date), asDay(record.date))
          cmp('end_date', asDay(existing.end_date), asDay(record.end_date))
          cmp('start_time', asTime(existing.start_time), asTime(record.start_time))
          cmp('end_time', asTime(existing.end_time), asTime(record.end_time))
          cmp('location', asText(existing.location), asText(record.location))
          cmp('all_day', String(!!existing.all_day), String(!!record.all_day))
          if (diffs.length) changes.eventsChanged.push({ title: record.title, date: record.date, diffs })
          await db('hall_events').where('id', existing.id).update({ ...record, date_updated: new Date() })
          eventsUpdated++
        } else {
          await db('hall_events').insert({ ...record, date_created: new Date(), date_updated: new Date() })
          changes.eventsNew.push({
            title: record.title, date: record.date, time: record.start_time,
            endTime: record.end_time, allDay: record.all_day, location: record.location,
          })
          eventsCreated++
        }

        // ── hall_closures (block) — every entry closes the KWI halls for its
        // span unless an admin has overridden this one. `existing` is the row as
        // it was BEFORE this run's update, which is what carries the override
        // (the upsert payload deliberately does not include it). ──
        if (endD >= todayYmd && closesTheHall(existing?.closure_override)) {
          const reason = (ev.title || 'Halle geschlossen').slice(0, 255)
          for (const h of kwiHallIds) {
            if (coveredBySchoolHoliday(h, startD, endD)) continue // Zurich holiday wins
            desiredClosures.set(`${h}|${startD}|${endD}`, { hall: h, start_date: startD, end_date: endD, reason })
          }
        } else if (endD >= todayYmd) {
          overriddenOff++
        }
      }

      // Delete hall_events no longer in the feed (raw knex).
      const existingEvents = await db('hall_events').where('source', 'gcal').select('id', 'uid', 'title', 'date')
      for (const row of existingEvents) {
        if (!seenUids.has(row.uid)) {
          await db('hall_events').where('id', row.id).delete()
          changes.eventsRemoved.push({ title: row.title, date: asDay(row.date) })
          eventsDeleted++
        }
      }

      // Reconcile hall_closures (source='gcal') via ItemsService so the training
      // auto-cancel hook fires on create and reverses on delete. Scoped to
      // end_date >= today so past closures (and their frozen training
      // cancellations) are never touched.
      const closures = new ItemsService('hall_closures', { schema, knex: db })
      const existingClos = await db('hall_closures')
        .where('source', 'gcal').andWhere('end_date', '>=', todayYmd)
        .select('id', 'hall', 'reason', db.raw('start_date::text as start_date'), db.raw('end_date::text as end_date'))
      const existKeys = new Map()
      for (const c of existingClos) {
        existKeys.set(`${c.hall}|${(c.start_date || '').slice(0, 10)}|${(c.end_date || '').slice(0, 10)}`, c)
      }

      // ── Digest bookkeeping ──
      // One calendar entry becomes one closure row PER KWI hall, so report them
      // grouped by span+reason with the hall names listed, not as three rows.
      const hallName = new Map(halls.map(h => [h.id, h.name]))
      const groupInto = (bucket, { hall, start, end, reason }) => {
        const key = `${start}|${end}|${reason || ''}`
        const g = bucket.get(key) || { halls: [], start, end, reason: reason || 'Halle geschlossen' }
        g.halls.push(hallName.get(hall) || `Halle ${hall}`)
        bucket.set(key, g)
      }
      const newClosureGroups = new Map()
      const goneClosureGroups = new Map()

      // The training auto-cancel/reverse runs in a fire-and-forget `action` hook,
      // so reading the affected trainings AFTER the write races it. Read them
      // BEFORE, using the hook's own selection logic.
      const trainingRows = (qb) => qb
        .leftJoin('teams', 'teams.id', 'trainings.team')
        .leftJoin('halls', 'halls.id', 'trainings.hall')
        .select(db.raw('trainings.date::text as date'), 'trainings.start_time',
          'teams.name as team', 'halls.name as hall')
        .orderBy('trainings.date')

      // Delete stale closures (no longer in the feed). Never delete a gcal
      // closure that now sits under a Zurich school holiday — leave it as a
      // harmless duplicate rather than risk reversing a training cancellation.
      for (const [k, row] of existKeys) {
        if (desiredClosures.has(k)) continue
        const [h, s, e] = k.split('|')
        if (coveredBySchoolHoliday(parseInt(h, 10), s, e)) continue
        // Mirrors the delete hook's NOT EXISTS guard: a training another closure
        // still covers stays cancelled and must not be reported as reinstated.
        const restored = await trainingRows(db('trainings'))
          .where('trainings.auto_cancelled_by_closure', row.id)
          .whereRaw('trainings.date >= CURRENT_DATE')
          .whereRaw(
            'NOT EXISTS (SELECT 1 FROM hall_closures c2 WHERE c2.hall = trainings.hall'
            + ' AND c2.id <> ?::integer AND trainings.date BETWEEN c2.start_date AND c2.end_date)',
            [row.id],
          )
        changes.trainingsRestored.push(...restored)
        groupInto(goneClosureGroups, { hall: parseInt(h, 10), start: s, end: e, reason: row.reason })
        await closures.deleteOne(row.id); closuresDeleted++
      }
      // Insert newly-appeared closures.
      for (const [k, c] of desiredClosures) {
        if (!existKeys.has(k)) {
          // Same window the hook cancels: today forward, not-yet-cancelled.
          const willCancel = await trainingRows(db('trainings'))
            .where('trainings.hall', c.hall)
            .andWhere('trainings.cancelled', false)
            .whereRaw('trainings.date >= GREATEST(CURRENT_DATE, ?::date)', [c.start_date])
            .whereRaw('trainings.date <= ?::date', [c.end_date])
          changes.trainingsCancelled.push(...willCancel)
          groupInto(newClosureGroups, { hall: c.hall, start: c.start_date, end: c.end_date, reason: c.reason })
          await closures.createOne({ hall: c.hall, start_date: c.start_date, end_date: c.end_date, reason: c.reason, source: 'gcal' })
          closuresCreated++
        }
      }
      changes.closuresNew.push(...newClosureGroups.values())
      changes.closuresRemoved.push(...goneClosureGroups.values())
    }

    // ── PUSH the club's own blocked dates (opt-in per closure) ──
    // After the import on purpose: duplicate detection reads `hall_events`, our
    // mirror of THEIR calendar, and it has to be this run's version — a span
    // they covered an hour ago must suppress our push now, not tomorrow.
    let closurePush = { created: 0, updated: 0, deleted: 0, skippedDuplicate: 0, disabled: true }
    try {
      const mirror = await db('hall_events')
        .where('source', 'gcal')
        .select(db.raw('date::text as date'), db.raw('end_date::text as end_date'), 'title')
      closurePush = await pushClubClosures(db, log, mirror)
    } catch (err) {
      // Never fail the sync for the push half — the pull (closures IN, which
      // cancels trainings) is the load-bearing direction.
      log.error({ msg: `gcal-sync: closure push failed: ${err.message}`, endpoint: 'gcal-sync', stack: err.stack })
    }

    // ── Tell the club what the hall administration changed ──
    // Only the IMPORT side is reported: the push half is our own writes and the
    // club already knows about its own games. Mail failures are swallowed inside
    // notifyGCalChanges — the sync has already committed by here.
    const { MailService } = services
    const notified = await notifyGCalChanges({
      changes,
      trigger,
      mail: new MailService({ schema, knex: db }),
      log,
    })

    return {
      eventsCreated, eventsUpdated, eventsDeleted, closuresCreated, closuresDeleted,
      gamesPushed: push.created, gamesUpdated: push.updated, gamesRemoved: push.deleted,
      gamesSkipped: push.skipped, pushEnabled: !push.disabled,
      // `eventsUpdated` counts every feed row (unconditional UPDATE); this is the
      // count of rows whose content actually moved.
      eventsChanged: changes.eventsChanged.length,
      overriddenOff,
      trainingsCancelled: changes.trainingsCancelled.length,
      trainingsRestored: changes.trainingsRestored.length,
      closuresPushed: closurePush.created,
      closurePushUpdated: closurePush.updated,
      closurePushRemoved: closurePush.deleted,
      closurePushSkippedDuplicate: closurePush.skippedDuplicate,
      changed: hasChanges(changes),
      notified,
    }
  }

  // ── Admin override: "this calendar entry does not close the hall" ──
  //
  // Since migration 325 every hall-administration entry closes the KWI halls, so
  // there has to be a way out for the cases where that is wrong — the Hausdienst
  // has hand-typed our own activity onto that calendar before (`Training VB
  // (Halle C)`, `BB - Freundschaftsspiel`), and closing the hall for our own
  // training cancels the very training it describes.
  //
  // The flip takes effect IMMEDIATELY rather than waiting for the 04:00 cron:
  // closures go through ItemsService so the auto-cancel hook fires on create and
  // reverses on delete, which is what actually puts the trainings back.
  router.post('/admin/hall-events/:id/closure-override', async (req, res) => {
    if (!req.accountability?.admin) return res.status(403).json({ error: 'Admin access required' })
    try {
      const raw = req.body?.override
      // Tri-state, and the three values are NOT interchangeable: null is
      // "automatic", true is a human confirming it closes. Anything else is a
      // client bug and must not be coerced into one of them.
      if (raw !== true && raw !== false && raw !== null) {
        return res.status(400).json({ error: 'override must be true, false or null' })
      }

      const row = await database('hall_events').where('id', req.params.id).first()
      if (!row) return res.status(404).json({ error: 'Hall event not found' })
      if (row.source !== 'gcal') {
        return res.status(400).json({ error: 'Only calendar-imported entries can be overridden' })
      }

      const startD = asDay(row.date)
      const endD = asDay(row.end_date) || startD
      if (!startD) return res.status(400).json({ error: 'Hall event has no date' })

      const schema = await getSchema()
      const closures = itemsServiceFor(schema)
      const halls = await database('halls').select('id', 'name')
      const kwiHallIds = halls.filter(h => /^kwi/i.test(h.name)).map(h => h.id)
      const reason = (row.title || 'Halle geschlossen').slice(0, 255)

      // Zurich school holidays stay authoritative — turning an entry back ON must
      // not stack a duplicate closure on top of a holiday that already shuts the
      // hall (and whose training cancellations we must not churn).
      const shRows = await database('hall_closures')
        .where('source', 'school_holidays')
        .andWhere('end_date', '>=', startD)
        .select('hall', database.raw('start_date::text as s'), database.raw('end_date::text as e'))
      const coveredBySchoolHoliday = (hall, s, e) => shRows
        .some(r => r.hall === hall && s <= (r.e || '').slice(0, 10) && e >= (r.s || '').slice(0, 10))

      let closuresCreated = 0, closuresDeleted = 0
      const trainingsCancelled = [], trainingsRestored = []
      const trainingRows = (qb) => qb
        .leftJoin('teams', 'teams.id', 'trainings.team')
        .leftJoin('halls', 'halls.id', 'trainings.hall')
        .select(database.raw('trainings.date::text as date'), 'trainings.start_time',
          'teams.name as team', 'halls.name as hall')
        .orderBy('trainings.date')

      await database('hall_events').where('id', row.id).update({ closure_override: raw, date_updated: new Date() })

      const existing = await database('hall_closures')
        .where({ source: 'gcal' })
        .whereIn('hall', kwiHallIds.length ? kwiHallIds : [-1])
        .andWhereRaw('start_date = ?::date AND end_date = ?::date', [startD, endD])
        .select('id', 'hall', 'reason')

      if (raw === false) {
        // Match the reason too: two different entries can share a span, and
        // deleting a neighbour's closure would open a hall nobody un-closed.
        for (const c of existing.filter(c => c.reason === reason)) {
          // Read the reinstated trainings BEFORE the delete — the reverse runs in
          // a fire-and-forget action hook. Mirrors its NOT EXISTS guard so a
          // training another closure still covers is not reported as back on.
          const back = await trainingRows(database('trainings'))
            .where('trainings.auto_cancelled_by_closure', c.id)
            .whereRaw('trainings.date >= CURRENT_DATE')
            .whereRaw(
              'NOT EXISTS (SELECT 1 FROM hall_closures c2 WHERE c2.hall = trainings.hall'
              + ' AND c2.id <> ?::integer AND trainings.date BETWEEN c2.start_date AND c2.end_date)',
              [c.id],
            )
          trainingsRestored.push(...back)
          await closures.deleteOne(c.id); closuresDeleted++
        }
      } else {
        const haveHall = new Set(existing.map(c => c.hall))
        for (const h of kwiHallIds) {
          if (haveHall.has(h)) continue
          if (coveredBySchoolHoliday(h, startD, endD)) continue
          const willCancel = await trainingRows(database('trainings'))
            .where('trainings.hall', h)
            .andWhere('trainings.cancelled', false)
            .whereRaw('trainings.date >= GREATEST(CURRENT_DATE, ?::date)', [startD])
            .whereRaw('trainings.date <= ?::date', [endD])
          trainingsCancelled.push(...willCancel)
          await closures.createOne({ hall: h, start_date: startD, end_date: endD, reason, source: 'gcal' })
          closuresCreated++
        }
      }

      // Raw-knex writes bypass Directus's revision trail — record the actor.
      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'hall_event_closure_override',
        collection: 'hall_events',
        recordId: row.id,
        data: { uid: row.uid, title: row.title, start: startD, end: endD, override: raw, closuresCreated, closuresDeleted },
      })

      res.json({
        status: 'ok',
        override: raw,
        closuresCreated,
        closuresDeleted,
        trainingsCancelled: trainingsCancelled.length,
        trainingsRestored: trainingsRestored.length,
      })
    } catch (err) {
      log.error({ msg: `hall-event closure-override: ${err.message}`, endpoint: 'hall-events/:id/closure-override', userId: req?.accountability?.user || null, method: req?.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Admin choice: publish this closure to the hall administration's calendar ──
  //
  // Per (start_date, end_date, reason) GROUP, not per row: a KWI closure is three
  // rows (hall A/B/C) and the calendar convention is one entry naming the halls.
  // Pushes immediately rather than waiting for the 04:00 cron, so the admin sees
  // whether it landed — or why it did not.
  router.post('/admin/hall-closures/push-toggle', async (req, res) => {
    if (!req.accountability?.admin) return res.status(403).json({ error: 'Admin access required' })
    try {
      const { start_date: startD, end_date: endD, reason, push } = req.body || {}
      if (typeof push !== 'boolean') return res.status(400).json({ error: 'push must be true or false' })
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startD)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(endD))) {
        return res.status(400).json({ error: 'start_date and end_date must be yyyy-mm-dd' })
      }

      // Never publish what came FROM that calendar, nor the city's school
      // holidays which the hall administration enters themselves. Excluded here
      // as well as in the pusher — this is the door a human can knock on.
      const affected = await database('hall_closures')
        .whereRaw('start_date = ?::date AND end_date = ?::date', [startD, endD])
        .andWhere('reason', reason ?? '')
        .whereNotIn('source', ['gcal', 'school_holidays'])
        .update({ push_to_gcal: push })

      if (!affected) {
        return res.status(404).json({ error: 'No eligible closure found for that span and reason' })
      }

      const mirror = await database('hall_events')
        .where('source', 'gcal')
        .select(database.raw('date::text as date'), database.raw('end_date::text as end_date'), 'title')
      const result = await pushClubClosures(database, log, mirror)

      // The push is silent about WHY nothing happened, and "already on their
      // calendar" is the answer the admin most needs. Re-derive it for this span.
      const dup = push ? findDuplicate(mirror, startD, endD) : null

      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'hall_closure_gcal_push',
        collection: 'hall_closures',
        recordId: null,
        data: { start: startD, end: endD, reason, push, rows: affected, duplicateOf: dup?.title ?? null },
      })

      res.json({
        status: 'ok',
        push,
        rows: affected,
        duplicateOf: dup?.title ?? null,
        // Did THIS span end up on their calendar? The reconcile counts below are
        // global — every flagged closure — so on a second call they report the
        // FIRST closure's work and read like this one was published when it was
        // skipped as a duplicate.
        publishedThisSpan: push && !dup,
        reconcile: { created: result.created, updated: result.updated, deleted: result.deleted },
        dryRun: !!result.dryRun,
        disabled: !!result.disabled,
      })
    } catch (err) {
      log.error({ msg: `hall-closures push-toggle: ${err.message}`, endpoint: 'hall-closures/push-toggle', userId: req?.accountability?.user || null, method: req?.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/admin/gcal-sync', async (req, res) => {
    if (!req.accountability?.admin) return res.status(403).json({ error: 'Admin access required' })
    const trigger = req.get('x-kscw-trigger') === 'cron' ? 'cron' : 'manual'
    // One run at a time — see IN_FLIGHT at the top of this module for why two
    // overlapping runs duplicate closures, calendar events and the digest mail.
    // Claimed BEFORE any work and released in the `finally` below, so a caller
    // that overlaps is turned away rather than quietly doing the work twice.
    if (IN_FLIGHT.has(SYNC_KEY)) {
      log.warn({ msg: `gcal-sync: a sync is already running — this ${trigger} trigger was skipped`, endpoint: 'gcal-sync', trigger })
      // ⚠ 200, not 409: the nightly cron caller does `if (!res.ok) throw`, so a
      // deliberate skip would be recorded by logCronError() and paint the "Hall
      // schedule sync" card red. A skip is a healthy outcome, not a failure —
      // callers distinguish it on `status`, not on the HTTP code.
      return res.json({ status: 'skipped', code: 'gcal_sync_running', message: 'A calendar sync is already running' })
    }
    IN_FLIGHT.add(SYNC_KEY)
    try {
      log.info('Manual GCal sync triggered')
      const schema = await getSchema()
      const result = await runSync(database, schema, { trigger })
      // Writes to a calendar the hall administration reads — record who triggered it.
      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'gcal_sync',
        collection: 'hall_closures',
        recordId: null,
        data: result,
      })
      res.json({ status: 'ok', ...result })
    } catch (err) {
      log.error({ msg: `gcal-sync: ${err.message}`, endpoint: 'gcal-sync', userId: req?.accountability?.user || null, method: req?.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    } finally {
      IN_FLIGHT.delete(SYNC_KEY)
    }
  })
}
