/**
 * Hall-slot → trainings cascade.
 *
 * Centralizes the "edit the recurring slot, propagate to upcoming trainings"
 * logic that used to live in the React SlotEditor. Running it as a Directus
 * hook means edits via the admin UI, REST, or any other client cascade the
 * same way — no more silent divergence when someone touches `hall_slots`
 * outside the React editor.
 *
 * Scope: only `slot_type = 'training'` slots, only future trainings
 * (`date >= today`). Past trainings stay frozen as historical snapshots
 * (RSVPs/attendance from last month must not retcon).
 *
 * Cascaded fields:
 *   • day_of_week           → shifts each future training's date by
 *                              (newDay − oldDay) days, keeping the row in
 *                              the same Mon–Sun calendar week so RSVPs +
 *                              notes carry over.
 *   • start_time / end_time → patched in place.
 *   • hall                  → patched in place.
 *   • team (M2M)            → first selected team patched onto trainings.
 *   • valid_from / valid_until / indefinite
 *                           → trim future trainings outside the new window;
 *                              generate missing dates inside the new window
 *                              (skipping closures + existing dates).
 *
 * Window rule: `valid_until` is the bound whenever it is set, `indefinite` or
 * not — indefinite only decides what happens when there is NO end date (the
 * rolling 12-week horizon). See effectiveEnd / validityEnd.
 *
 * Create-time generation (called from `hall_slots.items.create`) lives in
 * the same module so the rules match exactly.
 */

import { seasonEndDate as sharedSeasonEndDate } from '../../kscw-endpoints/src/season.js'

/** ISO date (YYYY-MM-DD) for "today" in the server's timezone. */
function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

/** Format a JS Date as YYYY-MM-DD (UTC components — we anchor everything to
 *  UTC midnight to dodge DST surprises in date arithmetic). */
function toISODate(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Coerce a Postgres `date` value (which pg-node returns as a JS Date
 *  object in the server's TZ, not a string) or an ISO string to a
 *  YYYY-MM-DD-anchored UTC Date. Bare `String(date)` produces
 *  `"Wed Sep 01 2025 …"` which slice(0,10)'d gives `"Wed Sep 01"` and
 *  blows up `new Date(...)` into Invalid Date → NaN-NaN-NaN downstream.
 *  Branch on Date instance so we read the calendar fields directly. */
function parseDate(s) {
  if (s instanceof Date) {
    const y = s.getFullYear()
    const m = String(s.getMonth() + 1).padStart(2, '0')
    const d = String(s.getDate()).padStart(2, '0')
    return new Date(`${y}-${m}-${d}T00:00:00Z`)
  }
  const str = String(s).slice(0, 10)
  return new Date(str + 'T00:00:00Z')
}

/** Rolling-horizon length for training slots with NO end date at all.
 *  "Indefinite" can't mean literally forever (the trainings table would be
 *  unbounded), so the cron + cascade keep `INDEFINITE_HORIZON_WEEKS` worth of
 *  upcoming trainings always populated and never trim past that point. 12
 *  weeks is the PlayerPlus default and matches the typical "next 3 months"
 *  planning window members care about. Tune here when needed.
 *
 *  ⚠ This is the FALLBACK, not the rule: an indefinite slot that carries an
 *  explicit `valid_until` is bounded, and generates to that date instead (see
 *  effectiveEnd). Treating those as open-ended is what left the 2026/27 season
 *  materialised only to today+12 weeks while the Hallenplan ran to 17.08.2027,
 *  so the J+S activity export stopped mid-November. */
const INDEFINITE_HORIZON_WEEKS = 12

/** Hard ceiling on how far ONE generation pass may reach, so a typo'd
 *  `valid_until` (2077) can't materialise decades of rows in a single insert.
 *  Soft by design: the nightly top-up walks it forward as today moves, exactly
 *  like the rolling horizon does. Only applies to indefinite slots — bounded
 *  ones are not topped up, so clamping them would strand the tail. */
const MAX_GENERATION_DAYS = 400

/** Season-end fallback for non-indefinite slots that omit `valid_until` —
 *  legacy create-time behavior the React editor used to apply. Returns
 *  May 31 of current or next season. */
// Was a UTC-month copy — flipped two hours early on Jun 1. See season.js.
const seasonEndDate = sharedSeasonEndDate

/** YYYY-MM-DD `INDEFINITE_HORIZON_WEEKS` weeks from today. */
function rollingHorizonDate() {
  const d = parseDate(todayStr())
  d.setUTCDate(d.getUTCDate() + INDEFINITE_HORIZON_WEEKS * 7)
  return toISODate(d)
}

/** YYYY-MM-DD `MAX_GENERATION_DAYS` from today. */
function maxGenerationDate() {
  const d = parseDate(todayStr())
  d.setUTCDate(d.getUTCDate() + MAX_GENERATION_DAYS)
  return toISODate(d)
}

/** Run a knex callback in a transaction that suppresses the
 *  `trg_trainings_notify` Postgres trigger via the
 *  `kscw.skip_trainings_notify` GUC (set by migration 054). Used so that
 *  slot-cascade bulk INSERTs/UPDATEs/DELETEs on `trainings` don't
 *  push-spam every member on every routine top-up.
 *
 *  Third arg to `set_config` is `is_local = true` → the setting is scoped
 *  to the current transaction only, so it can't leak to other queries on
 *  the pooled connection after COMMIT/ROLLBACK. */
async function withTrainingsNotifySilenced(database, fn) {
  return database.transaction(async (trx) => {
    await trx.raw("SELECT set_config('kscw.skip_trainings_notify', 'on', true)")
    return fn(trx)
  })
}

/** Postgres unique-violation SQLSTATE.
 *
 *  Migration 354 adds `trainings_hall_slot_date_uq` — UNIQUE (hall_slot, date)
 *  WHERE hall_slot IS NOT NULL — because all three generators below decide what
 *  is missing with a SELECT and then INSERT, holding no lock in between. Two
 *  cascades on the SAME slot (two Hallenplan editors saving within the same few
 *  hundred ms, or a slot edit landing while the 02:00 top-up runs) both read
 *  "no training on that date" — READ COMMITTED hides the sibling's uncommitted
 *  rows — and both insert, so the session renders twice in the calendar and the
 *  Hallenplan and collects two independent RSVP sets.
 *
 *  The index now arbitrates that; the code's job is only to make the loser a
 *  no-op. It must NOT let the violation escape: these generators run inside
 *  Directus ACTION hooks, where a thrown error is not attached to the request
 *  and would roll back the rest of the cascade (the date shift and the window
 *  trims) as well, surfacing as a 500 on the slot save. */
const PG_UNIQUE_VIOLATION = '23505'

function isDuplicateTraining(err) {
  return err?.code === PG_UNIQUE_VIOLATION || err?.original?.code === PG_UNIQUE_VIOLATION
}

/** Insert generated trainings, letting `trainings_hall_slot_date_uq` decide the
 *  race the pre-read SELECT cannot.
 *
 *  Happy path is untouched: one bulk INSERT … RETURNING id, same as before.
 *  Only when Postgres rejects the batch do we retry row by row, so the dates
 *  that did NOT collide still land instead of the whole batch being lost to one
 *  duplicate. Each attempt runs in its own SAVEPOINT (`trx.transaction()` on a
 *  knex transaction) because a unique violation poisons the enclosing
 *  transaction until it is rolled back — without the savepoint the caller's
 *  earlier statements would die with it.
 *
 *  A skipped date is a deliberate no-op — the training exists, which is exactly
 *  what the generator wanted — but it is logged at warn so the collision is
 *  visible rather than silent. Returns only the ids this call actually created,
 *  so `applyTrainingAutoRSVP` never runs against another writer's row. */
async function insertTrainings(trx, inserts, slotId, log) {
  const createdIds = []
  try {
    await trx.transaction(async (sp) => {
      const rows = await sp('trainings').insert(inserts).returning('id')
      for (const r of rows) createdIds.push(typeof r === 'object' ? r.id : r)
    })
    return createdIds
  } catch (err) {
    if (!isDuplicateTraining(err)) throw err
    createdIds.length = 0
  }
  let skipped = 0
  for (const row of inserts) {
    try {
      await trx.transaction(async (sp) => {
        const rows = await sp('trainings').insert(row).returning('id')
        for (const r of rows) createdIds.push(typeof r === 'object' ? r.id : r)
      })
    } catch (err) {
      if (!isDuplicateTraining(err)) throw err
      skipped += 1
    }
  }
  log?.warn?.({
    msg: `[slot-cascade] ${skipped} training(s) for slot ${slotId} already existed — a concurrent generator won the race; skipped as duplicates`,
    event: 'slot_generate_duplicate_skipped', slot: slotId, skipped, created: createdIds.length,
  })
  return createdIds
}

/** Map our day_of_week (0=Mon … 6=Sun) to JS getDay() (0=Sun … 6=Sat). */
function targetJsDay(dayOfWeek) {
  return (dayOfWeek + 1) % 7
}

/** Fetch the M2M teams attached to a slot (returns array of team ids). */
async function getSlotTeams(database, slotId) {
  const rows = await database('hall_slots_teams')
    .where('hall_slots_id', slotId)
    .select('teams_id')
  return rows.map(r => r.teams_id).filter(t => t != null)
}

/** Dates a coach has intentionally removed from a slot (deleted the occurrence
 *  or detached it by editing the time) that the generators must NOT regenerate.
 *  Backed by `training_slot_skips` (migration 162), keyed (hall_slot, date).
 *  Returns a Set of YYYY-MM-DD strings. The three generators below filter their
 *  candidate inserts against this so a removed occurrence stays removed instead
 *  of respawning on the nightly top-up / next slot edit. */
async function getSkipSet(database, slotId) {
  const rows = await database('training_slot_skips')
    .where('hall_slot', slotId)
    .select('date')
  return new Set(rows.map(r => toISODate(parseDate(r.date))))
}

/** Record a "do not regenerate" tombstone for (slotId, date). Idempotent —
 *  the unique(hall_slot, date) constraint makes a repeat a no-op. */
export async function addTrainingSkip(database, slotId, date, userUuid) {
  if (!slotId || !date) return
  await database('training_slot_skips')
    .insert({ hall_slot: slotId, date: toISODate(parseDate(date)), created_by: userUuid || null })
    .onConflict(['hall_slot', 'date'])
    .ignore()
}

/** Clear a tombstone for (slotId, date) — called when a training is (re)created
 *  or re-attached to the slot for that date, so the occurrence can come back. */
export async function clearTrainingSkip(database, slotId, date) {
  if (!slotId || !date) return
  await database('training_slot_skips')
    .where({ hall_slot: slotId, date: toISODate(parseDate(date)) })
    .delete()
}

/** Snapshot a slot's cascade-relevant fields plus its team junction. Used
 *  by the filter hook to capture pre-state before Directus applies the
 *  update. */
export async function snapshotSlot(database, slotId) {
  const slot = await database('hall_slots').where('id', slotId).first()
  if (!slot) return null
  const teams = await getSlotTeams(database, slotId)
  return {
    id: slot.id,
    day_of_week: slot.day_of_week,
    start_time: slot.start_time,
    end_time: slot.end_time,
    hall: slot.hall,
    slot_type: slot.slot_type,
    valid_from: slot.valid_from ? toISODate(parseDate(slot.valid_from)) : null,
    valid_until: slot.valid_until ? toISODate(parseDate(slot.valid_until)) : null,
    indefinite: !!slot.indefinite,
    teams,
  }
}

/** The slot's HARD validity end — the bound trimming is allowed to delete
 *  against. `null` means genuinely open-ended (indefinite with no end date),
 *  where the only upper bound is the soft rolling horizon and deleting past it
 *  would fight the nightly top-up. Legacy rows that are neither indefinite nor
 *  dated fall back to season-end, the old React create-time behaviour. */
export function validityEnd(slot) {
  if (slot.valid_until) return slot.valid_until
  return slot.indefinite ? null : seasonEndDate()
}

/** Effective window end for GENERATION.
 *
 *  ⚠ `indefinite` and `valid_until` are not alternatives — a slot can be both,
 *  and a dated one is bounded, it just keeps generating until that date. This
 *  used to return the rolling horizon for every indefinite slot and ignore
 *  `valid_until` entirely, which cut both ways: the HS26 plan ran to 17.08.2027
 *  but only ~12 weeks of it ever existed as concrete trainings, and stale slots
 *  whose valid_until had passed kept spawning phantoms past season end (purged
 *  by hand in July 2026). Honouring the date fixes both.
 *
 *  Clamped to MAX_GENERATION_DAYS for indefinite slots only; that clamp is soft
 *  and never trimmed against — see validityEnd. */
export function effectiveEnd(slot) {
  if (slot.indefinite) {
    const end = slot.valid_until || rollingHorizonDate()
    const cap = maxGenerationDate()
    return end < cap ? end : cap
  }
  return slot.valid_until || seasonEndDate()
}

/** Effective window start for generation: never reach into the past — the
 *  cascade only ever touches `date >= today`. */
function effectiveStart(slot) {
  const today = todayStr()
  return (slot.valid_from && slot.valid_from > today) ? slot.valid_from : today
}

/** Return all dates the slot's weekly recurrence would land on between
 *  `start` and `end` (inclusive), skipping hall closures. Used to compute
 *  which trainings need to exist for the new window. */
async function expectedDates(database, slot, start, end) {
  const out = []
  if (!start || !end || start > end) return out
  const closures = await database('hall_closures')
    .where('hall', slot.hall)
    .select('start_date', 'end_date')
  const isClosed = (dateStr) => closures.some(c => {
    const s = c.start_date ? toISODate(parseDate(c.start_date)) : null
    const e = c.end_date ? toISODate(parseDate(c.end_date)) : null
    return s && e && s <= dateStr && e >= dateStr
  })
  const target = targetJsDay(slot.day_of_week)
  const cur = parseDate(start)
  const endD = parseDate(end)
  while (cur.getUTCDay() !== target && cur <= endD) {
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  while (cur <= endD) {
    const dateStr = toISODate(cur)
    if (!isClosed(dateStr)) out.push(dateStr)
    cur.setUTCDate(cur.getUTCDate() + 7)
  }
  return out
}

/** Initial generation when a new training slot is created. Mirrors the old
 *  React `generateTrainings` exactly, just running server-side now.
 *  Notifications are suppressed for the bulk insert — admins creating a
 *  new slot shouldn't push-spam every member with 30+ "training_created"
 *  pings for the routine weekly skeleton. */
export async function generateInitialTrainings(database, slotId, log) {
  const slot = await database('hall_slots').where('id', slotId).first()
  if (!slot || slot.slot_type !== 'training' || !slot.hall) return []
  const teams = await getSlotTeams(database, slotId)
  const teamId = teams[0]
  if (!teamId) return []
  const start = effectiveStart(slot)
  const end = effectiveEnd(slot)
  const dates = await expectedDates(database, slot, start, end)
  if (dates.length === 0) return []
  const createdIds = []
  await withTrainingsNotifySilenced(database, async (trx) => {
    const existing = await trx('trainings').where('hall_slot', slotId).select('date')
    const existingSet = new Set(existing.map(r => toISODate(parseDate(r.date))))
    const skipSet = await getSkipSet(trx, slotId)
    const inserts = dates
      .filter(d => !existingSet.has(d) && !skipSet.has(d))
      .map(d => ({
        team: teamId,
        hall_slot: slotId,
        hall: slot.hall,
        date: d,
        start_time: slot.start_time,
        end_time: slot.end_time,
        cancelled: false,
      }))
    if (inserts.length === 0) return
    const ids = await insertTrainings(trx, inserts, slotId, log)
    for (const id of ids) createdIds.push(id)
    log?.info?.({ msg: '[slot-cascade] generated initial trainings', slot: slotId, count: ids.length, event: 'slot_generate' })
  })
  return createdIds
}

/** Apply the cascade after a slot update. `pre` is the snapshot from the
 *  filter hook; the post-state is re-read here so we see the actual stored
 *  values rather than trusting the payload (which may omit unchanged
 *  fields). */
export async function cascadeSlotUpdate(database, slotId, pre, log) {
  if (!pre) return []
  const post = await snapshotSlot(database, slotId)
  if (!post) return []
  if (post.slot_type !== 'training') return []

  const today = todayStr()
  const createdIds = []

  // All mutations on `trainings` here are routine slot-edit propagation —
  // members already know about the slot, they don't need a push per row.
  // Single transaction with the silencer flag set.
  await withTrainingsNotifySilenced(database, async (trx) => {
    // 1. Shift dates if day_of_week changed. Use signed delta so a switch
    //    from Sunday (6) → Monday (0) lands on the same calendar week's
    //    Monday rather than next week's. Range: -6..+6.
    let dateShiftApplied = false
    if (pre.day_of_week != null && post.day_of_week != null && pre.day_of_week !== post.day_of_week) {
      const delta = post.day_of_week - pre.day_of_week
      const future = await trx('trainings')
        .where('hall_slot', slotId)
        .andWhere('date', '>=', today)
        .select('id', 'date')
      for (const tr of future) {
        const newDate = parseDate(tr.date)
        newDate.setUTCDate(newDate.getUTCDate() + delta)
        const newDateStr = toISODate(newDate)
        // A NEGATIVE delta can push this week's occurrence into the past, which
        // breaks this module's own contract that past trainings stay frozen as
        // historical snapshots (audit 2026-08-08, finding 21). Concretely:
        // changing a slot from Wednesday to Monday ON A TUESDAY rewrote
        // tomorrow's session to yesterday, dragging its participations into
        // attendance history at the pre-edit time and hall — permanently, since
        // step 3's trim and step 4's regeneration are both bounded by
        // `date >= today` and never revisit it, while this week's real session
        // simply vanished from the calendar.
        //
        // Leaving the row untouched hands it to those two passes: step 3 trims
        // it (it no longer matches the slot's weekday) and step 4 regenerates
        // the correct occurrence.
        if (newDateStr < today) continue
        // Skip when shifted date already has a training (rare — happens if
        // the user previously moved a single training manually onto the
        // target weekday). Leave the conflict in place; admin can resolve.
        const clash = await trx('trainings')
          .where('hall_slot', slotId)
          .andWhere('date', newDateStr)
          .andWhereNot('id', tr.id)
          .first()
        if (clash) continue
        // The `clash` SELECT above is a check-then-act like every other one in
        // this module: a concurrent cascade on this same slot can put a row on
        // `newDateStr` in between, and `trainings_hall_slot_date_uq` then
        // rejects this UPDATE. Treat it exactly as the clash branch does —
        // leave the row where it is, let steps 3+4 sort it out — but do it in a
        // SAVEPOINT, or the violation would abort the whole cascade.
        try {
          await trx.transaction(async (sp) => {
            await sp('trainings').where('id', tr.id).update({ date: newDateStr })
          })
        } catch (err) {
          if (!isDuplicateTraining(err)) throw err
          log?.warn?.({ msg: `[slot-cascade] training ${tr.id} not shifted to ${newDateStr} — a concurrent cascade already placed one there`, slot: slotId, event: 'slot_shift_duplicate_skipped' })
          continue
        }
      }
      dateShiftApplied = true
    }

    // 2. Patch time / hall / team on remaining future trainings, OR
    //    delete them outright if the slot became teamless. Teamless slot
    //    means the slot is released for any team to claim — the existing
    //    committed sessions for the previous team no longer apply.
    const timeChanged = pre.start_time !== post.start_time || pre.end_time !== post.end_time
    const hallChanged = pre.hall !== post.hall
    const preTeam = pre.teams[0] ?? null
    const postTeam = post.teams[0] ?? null
    const teamChanged = preTeam !== postTeam

    if (teamChanged && postTeam == null) {
      const deleted = await trx('trainings')
        .where('hall_slot', slotId)
        .andWhere('date', '>=', today)
        .del()
      log?.info?.({ msg: '[slot-cascade] cleared future trainings for now-teamless slot', slot: slotId, count: deleted, event: 'slot_free' })
    } else if (timeChanged || hallChanged || teamChanged || dateShiftApplied) {
      const patch = {}
      if (timeChanged) { patch.start_time = post.start_time; patch.end_time = post.end_time }
      if (hallChanged) patch.hall = post.hall
      if (teamChanged && postTeam != null) patch.team = postTeam
      if (Object.keys(patch).length > 0) {
        await trx('trainings')
          .where('hall_slot', slotId)
          .andWhere('date', '>=', today)
          .update(patch)
      }
    }

    // 3. Trim trainings outside the new validity window. Lower bound always
    //    trims; the upper bound trims whenever the slot HAS one — which now
    //    includes indefinite slots carrying an explicit valid_until. Trimming
    //    against `newEnd` would be wrong here: that is the clamped GENERATION
    //    bound, and on a slot dated past the clamp it would delete exactly the
    //    rows a later top-up is meant to keep.
    const newStart = effectiveStart(post)
    const newEnd = effectiveEnd(post)
    const hardEnd = validityEnd(post)

    await trx('trainings')
      .where('hall_slot', slotId)
      .andWhere('date', '>=', today)
      .andWhere('date', '<', newStart)
      .del()

    if (hardEnd) {
      await trx('trainings')
        .where('hall_slot', slotId)
        .andWhere('date', '>=', today)
        .andWhere('date', '>', hardEnd)
        .del()
    }

    // 4. Generate missing dates inside the new window.
    const desired = await expectedDates(trx, post, newStart, newEnd)
    if (desired.length > 0 && postTeam != null) {
      const existing = await trx('trainings')
        .where('hall_slot', slotId)
        .andWhere('date', '>=', today)
        .select('date')
      const existingSet = new Set(existing.map(r => toISODate(parseDate(r.date))))
      const skipSet = await getSkipSet(trx, slotId)
      const inserts = desired
        .filter(d => !existingSet.has(d) && !skipSet.has(d))
        .map(d => ({
          team: postTeam,
          hall_slot: slotId,
          hall: post.hall,
          date: d,
          start_time: post.start_time,
          end_time: post.end_time,
          cancelled: false,
        }))
      if (inserts.length > 0) {
        const ids = await insertTrainings(trx, inserts, slotId, log)
        for (const id of ids) createdIds.push(id)
        log?.info?.({ msg: '[slot-cascade] filled missing trainings', slot: slotId, count: ids.length, event: 'slot_fill' })
      }
    }
  })
  return createdIds
}

/** Nightly rolling top-up for indefinite training slots. Generates any
 *  missing trainings between today and `today + INDEFINITE_HORIZON_WEEKS`,
 *  skipping closures and existing dates. Bounded slots are left alone —
 *  their valid_until is the source of truth. Past trainings are never
 *  touched.
 *
 *  Idempotent: safe to run every night; only new dates that crossed into
 *  the rolling window get an INSERT, everything else is a no-op. Returns
 *  the total number of trainings created across all slots so the cron
 *  caller can heartbeat it. */
export async function topUpIndefiniteSlots(database, log, onCreated) {
  const slots = await database('hall_slots')
    .where('slot_type', 'training')
    .andWhere('indefinite', true)
    .select('*')
  if (slots.length === 0) return 0
  const today = todayStr()
  let totalCreated = 0
  for (const slotRow of slots) {
    try {
      if (!slotRow.hall) continue
      const teams = await getSlotTeams(database, slotRow.id)
      const teamId = teams[0]
      if (!teamId) continue
      // Respect valid_from when set — don't generate before a slot starts.
      const slotStart = slotRow.valid_from ? toISODate(parseDate(slotRow.valid_from)) : today
      const start = slotStart > today ? slotStart : today
      // Per slot, not one shared horizon: a dated slot generates its whole
      // remaining window, an undated one rides the rolling 12 weeks. A slot
      // whose valid_until has already passed yields an empty range and stops
      // generating instead of trailing phantoms behind the season.
      const end = effectiveEnd({
        indefinite: true,
        valid_until: slotRow.valid_until ? toISODate(parseDate(slotRow.valid_until)) : null,
      })
      const desired = await expectedDates(database, slotRow, start, end)
      if (desired.length === 0) continue
      const existing = await database('trainings')
        .where('hall_slot', slotRow.id)
        .andWhere('date', '>=', today)
        .select('date')
      const existingSet = new Set(existing.map(r => toISODate(parseDate(r.date))))
      const skipSet = await getSkipSet(database, slotRow.id)
      const inserts = desired
        .filter(d => !existingSet.has(d) && !skipSet.has(d))
        .map(d => ({
          team: teamId,
          hall_slot: slotRow.id,
          hall: slotRow.hall,
          date: d,
          start_time: slotRow.start_time,
          end_time: slotRow.end_time,
          cancelled: false,
        }))
      if (inserts.length === 0) continue
      // `existing` above was read OUTSIDE any transaction, so a slot edit that
      // commits between that SELECT and this INSERT is invisible here. The
      // unique index is what makes the top-up genuinely idempotent under
      // concurrency; rows the other writer created are skipped, not duplicated.
      let createdIds = []
      await withTrainingsNotifySilenced(database, async (trx) => {
        createdIds = await insertTrainings(trx, inserts, slotRow.id, log)
      })
      totalCreated += createdIds.length
      if (onCreated && createdIds.length) {
        try { await onCreated(createdIds) } catch (err) {
          log?.error?.({ msg: `[slot-cascade] onCreated callback failed for slot ${slotRow.id}: ${err.message}`, event: 'slot_topup_oncreated_failed', slot: slotRow.id, stack: err.stack })
        }
      }
      log?.info?.({ msg: '[slot-cascade] rolling top-up', slot: slotRow.id, count: createdIds.length, event: 'slot_topup' })
    } catch (err) {
      log?.error?.({ msg: `[slot-cascade] top-up failed for slot ${slotRow.id}: ${err.message}`, event: 'slot_topup_failed', slot: slotRow.id, stack: err.stack })
    }
  }
  return totalCreated
}
