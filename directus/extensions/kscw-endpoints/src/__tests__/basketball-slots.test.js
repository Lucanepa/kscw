/**
 * Unit tests for the basketball slot generator's rule engine (basketball-slots.js).
 *
 * Hermetic — every function under test is pure and the DB context is injected, so nothing
 * here touches Postgres. What is pinned:
 *   · the mirrored constants that MUST agree with the frontend
 *     (src/modules/gameScheduling/utils/probasketSeason.ts + utils/hallOccupancy.ts) —
 *     these are the tests that fail when someone edits one side of the mirror only;
 *   · the Ferien hard/soft split, which is the one rule that binds different teams
 *     differently and must never be derived from teams.league;
 *   · the "holidays and weekend before" offset, which silently drops a whole weekend if the
 *     Friday walk-back is wrong;
 *   · A+B ↔ A/B mutual exclusion, the single most load-bearing piece of hall arithmetic;
 *   · idempotency: the same inputs must produce byte-identical rows and scores.
 */
import { describe, it, expect } from 'vitest'
import {
  FRIDAY_SLOTS, SATURDAY_SLOTS, SUNDAY_SLOTS,
  HALL_A, HALL_B, HALL_C, HALL_AB,
  BB_GAME_MINUTES, VB_CHANGEOVER_MINUTES,
  PROBASKET_LEAGUE_GRIDS_2026_27, PROBASKET_BLACKOUTS_2026_27, DEFAULT_TIMESLOT_MATRIX,
  blackoutsForCanton, blackoutsOn,
  slotsForDate, slotEndTime, hallComponents, hallTierFor,
  minutesOfDay, intervalsOverlap, hallsCollide, vbBusyWindow, vbBlocksSlot,
  addDays, dowOf, eachDate, candidateSlots, expandBlockedRules,
  hardReject, scoreSlot, planSlots, slotKey, parseJsonColumn,
  restGapApplies, REST_GAP_DAYS,
  REJECT_CODES, SCORE,
} from '../basketball-slots.js'

// ── Fixtures ───────────────────────────────────────────────────────────────────────────

/** A minimal generator context with nothing blocked. Override per test. */
function ctx(over = {}) {
  const timeslotByKey = new Map()
  for (const t of DEFAULT_TIMESLOT_MATRIX) {
    timeslotByKey.set(`${t.dow}|${t.time}`, { allow: t.allow, tolerate: t.tolerate })
  }
  return {
    timeslotByKey,
    spielsamstagStatus: new Map(),
    gridsByLeague: PROBASKET_LEAGUE_GRIDS_2026_27,
    blackouts: blackoutsForCanton(PROBASKET_BLACKOUTS_2026_27),
    closedHallsByDate: new Map(),
    holidayRanges: [],
    clubBlockedDates: new Set(),
    vbBusyByDate: new Map(),
    placementsByPitch: new Map(),
    bbPlacementCountByDate: new Map(),
    exclusivePartners: new Map(),
    adjacentPartners: new Map(),
    unavailableTeamDates: new Set(),
    awayGameTeamDates: new Set(),
    teamGameDates: new Set(),
    homeGameTeamDates: new Set(),
    ownPlacementPitches: new Set(),
    ...over,
  }
}

/** A prepared basketball_team_rules row (as prepareTeamRule() would hand it over). */
function team(over = {}) {
  return {
    id: 1,
    team: 86,
    league: 'D1LI',
    category: 'seniors',
    ferien_hard: false,
    allowed_dows: [5, 6, 0],
    preferred_dows: [],
    start_min: null,
    start_max: null,
    start_hard: true,
    halls: { hard: false, tiers: [] },
    own_back_to_back: true,
    rest_gap: true,          // category 'seniors' — prepareTeamRule derives it
    blockedDates: new Set(),
    ...over,
  }
}

// 2026-11-07 is a Saturday, 2026-11-06 a Friday, 2026-11-08 a Sunday. Used throughout.
const SAT = '2026-11-07'
const FRI = '2026-11-06'
const SUN = '2026-11-08'

// ═══════════════════════════════════════════════════════════════════════════════════════
describe('mirrored constants (must match probasketSeason.ts / hallOccupancy.ts)', () => {
  it('pins the fixed pitch grid', () => {
    expect(FRIDAY_SLOTS).toEqual(['20:00'])
    expect(SATURDAY_SLOTS).toEqual(['11:00', '13:30', '16:00', '18:30'])
    expect(SUNDAY_SLOTS).toEqual(['10:00', '12:30', '15:00'])
  })

  it('pins the hall vocabulary and the durations', () => {
    expect([HALL_A, HALL_B, HALL_C, HALL_AB]).toEqual(['KWI A', 'KWI B', 'KWI C', 'KWI A+B'])
    expect(BB_GAME_MINUTES).toBe(120)
    expect(VB_CHANGEOVER_MINUTES).toBe(30)
  })

  it('offers the combined court on every play day, and KWI C only at the weekend', () => {
    expect(slotsForDate(5).halls).toEqual([HALL_A, HALL_B, HALL_AB])
    expect(slotsForDate(6).halls).toEqual([HALL_A, HALL_B, HALL_C, HALL_AB])
    expect(slotsForDate(0).halls).toEqual([HALL_A, HALL_B, HALL_C, HALL_AB])
    expect(slotsForDate(3)).toEqual({ times: [], halls: [] })
  })

  it('keeps the 1.-Liga grid running into May and the junior grid ending in December', () => {
    // The bug this pins: one season-wide window shipped 38 of the 93 rows ProBasket's
    // senior template asks for.
    const senior = PROBASKET_LEAGUE_GRIDS_2026_27.H1LI
    expect(senior[0].start).toBe('2026-09-25')
    expect(senior[senior.length - 1].end).toBe('2027-05-09')
    expect(PROBASKET_LEAGUE_GRIDS_2026_27.JUN_REG).toEqual([{ start: '2026-09-19', end: '2026-12-13' }])
  })

  it('adds two hours for the end time, clamped at midnight', () => {
    expect(slotEndTime('18:30')).toBe('20:30')
    expect(slotEndTime('20:00')).toBe('22:00')
    expect(slotEndTime('23:30')).toBe('01:30')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
describe('hall arithmetic', () => {
  it('treats A+B as the same floor as A and B, and C as separate', () => {
    expect(hallsCollide(HALL_AB, HALL_A)).toBe(true)
    expect(hallsCollide(HALL_A, HALL_AB)).toBe(true)
    expect(hallsCollide(HALL_AB, HALL_B)).toBe(true)
    expect(hallsCollide(HALL_A, HALL_B)).toBe(false)
    expect(hallsCollide(HALL_C, HALL_AB)).toBe(false)
    expect(hallsCollide(HALL_C, HALL_C)).toBe(true)
  })

  it('expands A+B into both halves so a closure on either half kills it', () => {
    expect(hallComponents(HALL_AB)).toEqual([HALL_A, HALL_B])
    expect(hallComponents(HALL_C)).toEqual([HALL_C])
  })

  it('empty tiers mean every hall is equal; hard tiers mean rank 1 only', () => {
    expect(hallTierFor({ hard: false, tiers: [] }, HALL_C)).toEqual({ rank: 1, last_resort: false })

    const hard = { hard: true, tiers: [{ rank: 1, options: [HALL_AB] }, { rank: 2, options: [HALL_A] }] }
    expect(hallTierFor(hard, HALL_AB)).toEqual({ rank: 1, last_resort: false })
    // The sheet's "A+B (hard)" has NO fallback — rank 2 must be unreachable even if listed.
    expect(hallTierFor(hard, HALL_A)).toBeNull()

    const soft = {
      hard: false,
      tiers: [{ rank: 1, options: [HALL_AB] }, { rank: 2, options: [HALL_A, HALL_B] }, { rank: 3, options: [HALL_C], last_resort: true }],
    }
    expect(hallTierFor(soft, HALL_B).rank).toBe(2)
    expect(hallTierFor(soft, HALL_C)).toEqual({ rank: 3, last_resort: true })

    // "A+B (soft) otherwise A or B" — C is NOT in any tier, so it is never generated.
    const noC = { hard: false, tiers: [{ rank: 1, options: [HALL_AB] }, { rank: 2, options: [HALL_A, HALL_B] }] }
    expect(hallTierFor(noC, HALL_C)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
describe('volleyball occupancy (mirrors hallOccupancy.ts)', () => {
  it('parses times and rejects nonsense', () => {
    expect(minutesOfDay('13:30')).toBe(810)
    expect(minutesOfDay('13:30:00')).toBe(810)
    expect(minutesOfDay('25:00')).toBeNull()
    expect(minutesOfDay(null)).toBeNull()
  })

  it('treats a boundary touch as no overlap', () => {
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false)
    expect(intervalsOverlap(0, 11, 10, 20)).toBe(true)
  })

  it('adds the changeover either side and falls back to a normal match on a bad end', () => {
    expect(vbBusyWindow({ hall: HALL_A, start: '13:30', end: '15:30' })).toEqual({ start: 780, end: 960 })
    // end <= start is corrupt → a zero-width window would block nothing at all.
    expect(vbBusyWindow({ hall: HALL_A, start: '13:30', end: '13:30' })).toEqual({ start: 780, end: 960 })
    expect(vbBusyWindow({ hall: HALL_A, start: null })).toBeNull()
  })

  it('blocks only the overlapping pitch, not the whole day', () => {
    const bookings = [{ hall: HALL_A, start: '13:30', end: '15:30' }]
    expect(vbBlocksSlot(bookings, HALL_A, '13:30')).toBe(true)
    expect(vbBlocksSlot(bookings, HALL_A, '11:00')).toBe(false) // 11:00–13:00 vs 13:00–16:00
    expect(vbBlocksSlot(bookings, HALL_A, '16:00')).toBe(false) // 16:00–18:00 vs 13:00–16:00
    expect(vbBlocksSlot(bookings, HALL_B, '13:30')).toBe(false)
    expect(vbBlocksSlot(bookings, HALL_AB, '13:30')).toBe(true) // A+B needs both halves
  })

  it('blocks the whole day when a booking has no start time', () => {
    const bookings = [{ hall: HALL_A, start: null }]
    expect(vbBlocksSlot(bookings, HALL_A, '20:00')).toBe(true)
    expect(vbBlocksSlot(bookings, HALL_C, '20:00')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
describe('date helpers + candidate enumeration', () => {
  it('walks dates in UTC without local-timezone drift', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-10-05', -1)).toBe('2026-10-04')
    expect(dowOf(SAT)).toBe(6)
    expect(dowOf(SUN)).toBe(0)
    expect(dowOf(FRI)).toBe(5)
    expect(eachDate('2026-11-06', '2026-11-08')).toEqual([FRI, SAT, SUN])
  })

  it('emits only Fri/Sat/Sun, one entry per (date,time,hall), in a stable order', () => {
    const cands = candidateSlots([{ start: '2026-11-02', end: '2026-11-08' }]) // Mon..Sun
    expect([...new Set(cands.map((c) => c.date))]).toEqual([FRI, SAT, SUN])
    // Fri 1×3 + Sat 4×4 + Sun 3×4 = 31
    expect(cands.length).toBe(31)
    expect(cands[0]).toEqual({ date: FRI, dow: 5, time: '20:00', hall: HALL_A })
    const twice = candidateSlots([{ start: '2026-11-02', end: '2026-11-08' }])
    expect(twice).toEqual(cands) // deterministic
  })

  it('never duplicates a date shared by two grid ranges', () => {
    const cands = candidateSlots([
      { start: '2026-11-06', end: '2026-11-08' },
      { start: '2026-11-07', end: '2026-11-08' },
    ])
    expect(new Set(cands.map((c) => c.date)).size).toBe(3)
    expect(cands.length).toBe(31)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
describe('expandBlockedRules', () => {
  const dates = eachDate('2026-09-19', '2026-10-31').filter((d) => [5, 6, 0].includes(dowOf(d)))

  it('"until oct" blocks every candidate date before 01.10 and nothing after', () => {
    const blocked = expandBlockedRules([{ kind: 'before_date', date: '2026-10-01' }], [], dates)
    // The two September weekends inside the Vorrunde: 19/20 and 25/26/27.
    expect([...blocked].sort()).toEqual(['2026-09-19', '2026-09-20', '2026-09-25', '2026-09-26', '2026-09-27'])
    expect(blocked.has('2026-10-02')).toBe(false)
  })

  it('"holidays and weekend before" walks back to the FRIDAY on-or-before the range start', () => {
    // ZH Herbstferien 2026: Mon 05.10 → Fri 16.10. The weekend before is Fri 02.10.
    const holidays = [{ start: '2026-10-05', end: '2026-10-16' }]
    const blocked = expandBlockedRules(
      [{ kind: 'school_holidays', canton: 'ZH', include_weekend_before: true }], holidays, dates,
    )
    expect(blocked.has('2026-10-02')).toBe(true)  // Friday before
    expect(blocked.has('2026-10-03')).toBe(true)  // Saturday before
    expect(blocked.has('2026-10-04')).toBe(true)  // Sunday before
    expect(blocked.has('2026-10-05')).toBe(true)  // first holiday day
    expect(blocked.has('2026-10-16')).toBe(true)  // last holiday day
    expect(blocked.has('2026-10-01')).toBe(false) // Thursday before the offset — untouched
    expect(blocked.has('2026-10-17')).toBe(false)
  })

  it('without include_weekend_before, only the holiday range itself is blocked', () => {
    const holidays = [{ start: '2026-10-05', end: '2026-10-16' }]
    const blocked = expandBlockedRules([{ kind: 'school_holidays' }], holidays, dates)
    expect(blocked.has('2026-10-04')).toBe(false)
    expect(blocked.has('2026-10-05')).toBe(true)
  })

  it('a holiday range that STARTS on a Saturday still walks back to the Friday before it', () => {
    const blocked = expandBlockedRules(
      [{ kind: 'school_holidays', include_weekend_before: true }],
      [{ start: '2026-10-10', end: '2026-10-12' }], dates,
    )
    // 09.10 is the Friday before 10.10 — the weekend must not be half-open.
    expect(blocked.has('2026-10-09')).toBe(true)
    expect(blocked.has('2026-10-08')).toBe(false)
  })

  it('handles explicit date ranges and ignores unknown kinds', () => {
    const blocked = expandBlockedRules(
      [{ kind: 'date_range', start: '2026-11-06', end: '2026-11-08' }, { kind: 'nonsense' }], [], dates,
    )
    expect([...blocked].sort()).toEqual([FRI, SAT, SUN])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
describe('ProBasket blackouts', () => {
  it('resolves the Osterferien to the ZH/ZG window only — never both', () => {
    const zh = blackoutsForCanton(PROBASKET_BLACKOUTS_2026_27, 'ZH')
    const labels = zh.filter((b) => b.label.startsWith('Osterferien')).map((b) => b.label)
    expect(labels).toEqual(['Osterferien (ZH/ZG)'])
    const be = blackoutsForCanton(PROBASKET_BLACKOUTS_2026_27, 'BE')
    expect(be.filter((b) => b.label.startsWith('Osterferien')).map((b) => b.label))
      .toEqual(['Osterferien (ausser ZH/ZG)'])
  })

  it('sorts a sperr ahead of a ferien on a date carrying both', () => {
    // 25.04.2027 is inside the ZH Osterferien AND is the ProBasket Classics Final.
    const hits = blackoutsOn('2027-04-25', blackoutsForCanton(PROBASKET_BLACKOUTS_2026_27, 'ZH'))
    expect(hits.length).toBe(2)
    expect(hits[0].kind).toBe('sperr')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
describe('hardReject', () => {
  const cand = { date: SAT, dow: 6, time: '13:30', hall: HALL_A }

  it('accepts a plain candidate', () => {
    expect(hardReject(cand, team(), ctx())).toBeNull()
  })

  it('"weekends" excludes Friday', () => {
    const t = team({ allowed_dows: [6, 0] })
    expect(hardReject({ date: FRI, dow: 5, time: '20:00', hall: HALL_A }, t, ctx())).toBe(REJECT_CODES.DAY_NOT_ALLOWED)
    expect(hardReject(cand, t, ctx())).toBeNull()
  })

  it('a sperr blocks every team; a ferien blocks ONLY the ferien_hard ones', () => {
    // Herbstferien 05.–11.10.2026 is a 'ferien'. 2026-10-10 is a Saturday inside it.
    const inFerien = { date: '2026-10-10', dow: 6, time: '13:30', hall: HALL_A }
    expect(hardReject(inFerien, team({ ferien_hard: true }), ctx())).toBe(REJECT_CODES.BLACKOUT_FERIEN)
    expect(hardReject(inFerien, team({ ferien_hard: false }), ctx())).toBeNull()

    // Weihnachtsferien 21.12.26–04.01.27 is a 'sperr'. 2026-12-26 is a Saturday inside it.
    const inSperr = { date: '2026-12-26', dow: 6, time: '13:30', hall: HALL_A }
    expect(hardReject(inSperr, team({ ferien_hard: false }), ctx())).toBe(REJECT_CODES.BLACKOUT_SPERR)
    expect(hardReject(inSperr, team({ ferien_hard: true }), ctx())).toBe(REJECT_CODES.BLACKOUT_SPERR)
  })

  it('a club-wide blackout blocks everyone', () => {
    expect(hardReject(cand, team(), ctx({ clubBlockedDates: new Set([SAT]) }))).toBe(REJECT_CODES.CLUB_BLOCK)
  })

  it('a closure on ONE half kills the combined court but not the other half', () => {
    const c = ctx({ closedHallsByDate: new Map([[SAT, new Set([HALL_A])]]) })
    expect(hardReject({ ...cand, hall: HALL_A }, team(), c)).toBe(REJECT_CODES.HALL_CLOSED)
    expect(hardReject({ ...cand, hall: HALL_AB }, team(), c)).toBe(REJECT_CODES.HALL_CLOSED)
    expect(hardReject({ ...cand, hall: HALL_B }, team(), c)).toBeNull()
  })

  it('a site-wide closure ("*") kills every hall', () => {
    const c = ctx({ closedHallsByDate: new Map([[SAT, new Set(['*'])]]) })
    expect(hardReject({ ...cand, hall: HALL_C }, team(), c)).toBe(REJECT_CODES.HALL_CLOSED)
  })

  it('volleyball blocks the overlapping pitch only', () => {
    const c = ctx({ vbBusyByDate: new Map([[SAT, [{ hall: HALL_A, start: '13:30', end: '15:30' }]]]) })
    expect(hardReject({ ...cand, time: '13:30', hall: HALL_A }, team(), c)).toBe(REJECT_CODES.VOLLEYBALL)
    expect(hardReject({ ...cand, time: '13:30', hall: HALL_AB }, team(), c)).toBe(REJECT_CODES.VOLLEYBALL)
    expect(hardReject({ ...cand, time: '18:30', hall: HALL_A }, team(), c)).toBeNull()
    expect(hardReject({ ...cand, time: '13:30', hall: HALL_C }, team(), c)).toBeNull()
  })

  it('start windows are INCLUSIVE on both sides — 13:30 belongs to both camps', () => {
    const after = team({ start_min: '13:30' })
    const before = team({ start_max: '13:30', category: 'youth' })
    expect(hardReject({ ...cand, time: '13:30' }, after, ctx())).toBeNull()
    expect(hardReject({ ...cand, time: '11:00' }, after, ctx())).toBe(REJECT_CODES.START_WINDOW)
    expect(hardReject({ ...cand, time: '13:30' }, before, ctx())).toBeNull()
    expect(hardReject({ ...cand, time: '16:00' }, before, ctx())).toBe(REJECT_CODES.START_WINDOW)
  })

  it('a SOFT start window filters nothing', () => {
    // Sun 12:30 allows seniors, so the ONLY thing that could reject here is the window.
    const early = { date: SUN, dow: 0, time: '12:30', hall: HALL_A }
    expect(hardReject(early, team({ start_min: '13:30', start_hard: true }), ctx())).toBe(REJECT_CODES.START_WINDOW)
    expect(hardReject(early, team({ start_min: '13:30', start_hard: false }), ctx())).toBeNull()
  })

  it('rejects a blocked date', () => {
    expect(hardReject(cand, team({ blockedDates: new Set([SAT]) }), ctx())).toBe(REJECT_CODES.BLOCKED_RULE)
  })

  it('rejects a hall outside the team tiers', () => {
    const t = team({ halls: { hard: true, tiers: [{ rank: 1, options: [HALL_AB] }] } })
    expect(hardReject({ ...cand, hall: HALL_A }, t, ctx())).toBe(REJECT_CODES.HALL_NOT_ALLOWED)
    expect(hardReject({ ...cand, hall: HALL_AB }, t, ctx())).toBeNull()
  })

  it('the Friday 20:00 pitch tolerates u18 and excludes the younger youth teams', () => {
    const fri = { date: FRI, dow: 5, time: '20:00', hall: HALL_A }
    expect(hardReject(fri, team({ category: 'seniors' }), ctx())).toBeNull()
    expect(hardReject(fri, team({ category: 'u18' }), ctx())).toBeNull()
    expect(hardReject(fri, team({ category: 'youth' }), ctx())).toBe(REJECT_CODES.CATEGORY_NOT_ALLOWED)
  })

  it('Saturday 18:30 is seniors-only — not even tolerated for youth', () => {
    const late = { date: SAT, dow: 6, time: '18:30', hall: HALL_A }
    expect(hardReject(late, team({ category: 'seniors' }), ctx())).toBeNull()
    expect(hardReject(late, team({ category: 'youth' }), ctx())).toBe(REJECT_CODES.CATEGORY_NOT_ALLOWED)
    expect(hardReject(late, team({ category: 'u18' }), ctx())).toBe(REJECT_CODES.CATEGORY_NOT_ALLOWED)
  })

  it('honours a hand-set per-team unavailability', () => {
    expect(hardReject(cand, team(), ctx({ unavailableTeamDates: new Set([`86|${SAT}`]) })))
      .toBe(REJECT_CODES.TEAM_UNAVAILABLE)
    expect(hardReject(cand, team(), ctx({ unavailableTeamDates: new Set([`99|${SAT}`]) }))).toBeNull()
  })

  it('a team playing away that day cannot also host at KWI', () => {
    // The report that produced this rule: Herren 2 agreed 03.03.2027 at Unicorns 02's gym
    // bilaterally, and the planner kept offering KWI pitches on the same date because
    // nothing in the generator had ever read `games`.
    expect(hardReject(cand, team(), ctx({ awayGameTeamDates: new Set([`86|${SAT}`]) })))
      .toBe(REJECT_CODES.AWAY_GAME)
  })

  it('blocks only the team that travels, and only on that date', () => {
    expect(hardReject(cand, team(), ctx({ awayGameTeamDates: new Set([`99|${SAT}`]) }))).toBeNull()
    expect(hardReject(cand, team(), ctx({ awayGameTeamDates: new Set(['86|2026-12-25']) }))).toBeNull()
  })

  it('keeps the away block distinct from a hand-set unavailability', () => {
    // Same effect, different fix: a manual block is undone by un-blocking it, an away
    // fixture only by moving the game. One shared code would send the planner to the
    // wrong screen.
    expect(hardReject(cand, team(), ctx({ unavailableTeamDates: new Set([`86|${SAT}`]) })))
      .toBe(REJECT_CODES.TEAM_UNAVAILABLE)
    expect(hardReject(cand, team(), ctx({ awayGameTeamDates: new Set([`86|${SAT}`]) })))
      .toBe(REJECT_CODES.AWAY_GAME)
    expect(REJECT_CODES.AWAY_GAME).not.toBe(REJECT_CODES.TEAM_UNAVAILABLE)
  })

  it('does not offer the day after one of the team\'s own placed games', () => {
    // Club rule 2026-09-02: "soft block one day before and one day after … so that a game
    // can be placed manually but the date gets not suggested". Not writing the candidate
    // IS the soft block — the prep grid's pitches come from the weekday grid, not from
    // this inventory, so the date stays clickable.
    expect(hardReject(cand, team(), ctx({ teamGameDates: new Set([`86|${FRI}`]) })))
      .toBe(REJECT_CODES.ADJACENT_GAME)
  })

  it('does not offer the day before one either — an away fixture counts the same', () => {
    expect(hardReject(cand, team(), ctx({ teamGameDates: new Set([`86|${SUN}`]) })))
      .toBe(REJECT_CODES.ADJACENT_GAME)
  })

  it('reaches exactly one day, and only for this team', () => {
    // Two days out is untouched: the gap is a rest day, not a weekend exclusion.
    expect(hardReject(cand, team(), ctx({ teamGameDates: new Set(['86|2026-11-05']) }))).toBeNull()
    expect(hardReject(cand, team(), ctx({ teamGameDates: new Set(['86|2026-11-09']) }))).toBeNull()
    expect(hardReject(cand, team(), ctx({ teamGameDates: new Set([`99|${FRI}`]) }))).toBeNull()
    expect(REST_GAP_DAYS).toBe(1)
  })

  it('exempts junior teams — back-to-back days are at times unavoidable for them', () => {
    expect(restGapApplies('seniors')).toBe(true)
    expect(restGapApplies('u18')).toBe(false)
    expect(restGapApplies('youth')).toBe(false)
    expect(restGapApplies(null)).toBe(false)
    const junior = team({ category: 'youth', rest_gap: restGapApplies('youth') })
    expect(hardReject(cand, junior, ctx({ teamGameDates: new Set([`86|${FRI}`]) }))).toBeNull()
  })

  it('says nothing about the day itself — that is the away block\'s job', () => {
    // A game ON the date has a different fix, so it must keep its own code: an away
    // fixture is undone by moving the game, a rest gap by placing it by hand anyway.
    expect(hardReject(cand, team(), ctx({ teamGameDates: new Set([`86|${SAT}`]) }))).toBeNull()
    expect(hardReject(cand, team(), ctx({
      teamGameDates: new Set([`86|${SAT}`]),
      awayGameTeamDates: new Set([`86|${SAT}`]),
    }))).toBe(REJECT_CODES.AWAY_GAME)
  })

  it('a team that already HOSTS that day gets no second suggestion — except its own pitch', () => {
    // Reported 06.09.2026: "slots kept being suggested during which the team already has
    // a home game". 98 live suggestions on prod sat on such a date.
    const c = ctx({ homeGameTeamDates: new Set([`86|${SAT}`]) })
    expect(hardReject(cand, team(), c)).toBe(REJECT_CODES.HOME_GAME)
    expect(hardReject({ ...cand, time: '18:30' }, team(), c)).toBe(REJECT_CODES.HOME_GAME)
    // Another team, and another date, are untouched.
    expect(hardReject(cand, team(), ctx({ homeGameTeamDates: new Set([`99|${SAT}`]) }))).toBeNull()
    expect(hardReject(cand, team(), ctx({ homeGameTeamDates: new Set(['86|2026-12-25']) }))).toBeNull()
  })

  it('its OWN placed pitch stays offered, so the placement stays visible and removable', () => {
    const c = ctx({
      homeGameTeamDates: new Set([`86|${SAT}`]),
      ownPlacementPitches: new Set([`86|${SAT}|13:30|${HALL_A}`]),
    })
    expect(hardReject({ ...cand, time: '13:30', hall: HALL_A }, team(), c)).toBeNull()
    // …but only that exact pitch.
    expect(hardReject({ ...cand, time: '13:30', hall: HALL_B }, team(), c)).toBe(REJECT_CODES.HOME_GAME)
    expect(hardReject({ ...cand, time: '16:00', hall: HALL_A }, team(), c)).toBe(REJECT_CODES.HOME_GAME)
  })

  it('a placed game takes the pitch — including across the A+B / A boundary', () => {
    const c = ctx({ placementsByPitch: new Map([[`${SAT}|13:30`, [{ hall: HALL_AB, kscw_team: 75 }]]]) })
    expect(hardReject({ ...cand, hall: HALL_A }, team(), c)).toBe(REJECT_CODES.PITCH_TAKEN)
    expect(hardReject({ ...cand, hall: HALL_C }, team(), c)).toBeNull()
  })

  it('a team is not blocked by its OWN placement in the very same slot', () => {
    const c = ctx({ placementsByPitch: new Map([[`${SAT}|13:30`, [{ hall: HALL_A, kscw_team: 86 }]]]) })
    expect(hardReject({ ...cand, hall: HALL_A }, team(), c)).toBeNull()
  })

  it('"cannot play at the same time as" blocks a partner-occupied pitch even in another hall', () => {
    const c = ctx({
      placementsByPitch: new Map([[`${SAT}|13:30`, [{ hall: HALL_C, kscw_team: 72 }]]]),
      exclusivePartners: new Map([['86', new Set(['72'])]]),
    })
    expect(hardReject({ ...cand, hall: HALL_A }, team(), c)).toBe(REJECT_CODES.PARTNER_SAME_TIME)
    // A different pitch on the same day is fine — the rule is same-TIME, not same-day.
    expect(hardReject({ ...cand, time: '16:00', hall: HALL_A }, team(), c)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
describe('scoreSlot', () => {
  const cand = { date: SAT, dow: 6, time: '13:30', hall: HALL_A }

  it('rewards the preferred weekday', () => {
    const s = scoreSlot({ date: FRI, dow: 5, time: '20:00', hall: HALL_A }, team({ preferred_dows: [5] }), ctx())
    expect(s.reasons).toContainEqual({ code: 'preferred_day', delta: SCORE.PREFERRED_DAY })
  })

  it('ranks the Spielsamstag statuses given > desired > fraglich > bei_bedarf', () => {
    const score = (status) =>
      scoreSlot(cand, team(), ctx({ spielsamstagStatus: new Map([[SAT, status]]) })).score
    expect(score('given')).toBeGreaterThan(score('desired'))
    expect(score('desired')).toBeGreaterThan(score('fraglich'))
    expect(score('fraglich')).toBeGreaterThan(score('bei_bedarf'))
    expect(score('unknown_status')).toBe(scoreSlot(cand, team(), ctx()).score)
  })

  it('an allowed category outscores a merely tolerated one', () => {
    // Sat 16:00 allows seniors and tolerates youth/u18.
    const late = { date: SAT, dow: 6, time: '16:00', hall: HALL_A }
    const allowed = scoreSlot(late, team({ category: 'seniors' }), ctx())
    const tolerated = scoreSlot(late, team({ category: 'youth' }), ctx())
    expect(allowed.score - tolerated.score).toBe(SCORE.CATEGORY_ALLOW)
  })

  it('ranks the hall tiers and penalises a last resort', () => {
    const halls = {
      hard: false,
      tiers: [{ rank: 1, options: [HALL_AB] }, { rank: 2, options: [HALL_A, HALL_B] }, { rank: 3, options: [HALL_C], last_resort: true }],
    }
    const at = (hall) => scoreSlot({ ...cand, hall }, team({ halls }), ctx()).score
    expect(at(HALL_AB)).toBeGreaterThan(at(HALL_A))
    expect(at(HALL_A)).toBeGreaterThan(at(HALL_C))
    expect(at(HALL_AB) - at(HALL_A)).toBe(SCORE.HALL_RANK1 - SCORE.HALL_RANK2)
  })

  it('rewards keeping an adjacent partner back-to-back', () => {
    const c = ctx({
      placementsByPitch: new Map([[`${SAT}|11:00`, [{ hall: HALL_A, kscw_team: 72 }]]]),
      adjacentPartners: new Map([['86', new Set(['72'])]]),
    })
    expect(scoreSlot(cand, team(), c).reasons).toContainEqual({ code: 'adjacent_partner', delta: SCORE.ADJACENT_PARTNER })
    // Two pitches away is not adjacent.
    expect(scoreSlot({ ...cand, time: '18:30' }, team(), c).reasons.map((r) => r.code))
      .not.toContain('adjacent_partner')
  })

  it('penalises — never removes — a back-to-back the team said no to', () => {
    const c = ctx({ placementsByPitch: new Map([[`${SAT}|11:00`, [{ hall: HALL_B, kscw_team: 86 }]]]) })
    const t = team({ own_back_to_back: false })
    expect(hardReject(cand, t, c)).toBeNull()
    expect(scoreSlot(cand, t, c).reasons).toContainEqual({ code: 'own_back_to_back', delta: SCORE.OWN_BACK_TO_BACK })
    expect(scoreSlot(cand, team({ own_back_to_back: true }), c).reasons.map((r) => r.code))
      .not.toContain('own_back_to_back')
  })

  it('a Ferien week a team is not bound by is a soft penalty, not a rejection', () => {
    const inFerien = { date: '2026-10-10', dow: 6, time: '13:30', hall: HALL_A }
    const t = team({ ferien_hard: false })
    expect(hardReject(inFerien, t, ctx())).toBeNull()
    expect(scoreSlot(inFerien, t, ctx()).reasons).toContainEqual({ code: 'ferien_soft', delta: SCORE.FERIEN_SOFT })
  })

  it('caps the volleyball-busy-day penalty', () => {
    const many = Array.from({ length: 6 }, () => ({ hall: HALL_C, start: '09:00', end: '10:00' }))
    const r = scoreSlot(cand, team(), ctx({ vbBusyByDate: new Map([[SAT, many]]) }))
    expect(r.reasons.find((x) => x.code === 'vb_same_day').delta).toBe(SCORE.VB_SAME_DAY_FLOOR)
  })

  it('score always equals the sum of its reasons', () => {
    const c = ctx({ spielsamstagStatus: new Map([[SAT, 'given']]) })
    const r = scoreSlot(cand, team({ preferred_dows: [6] }), c)
    expect(r.score).toBe(r.reasons.reduce((s, x) => s + x.delta, 0))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
describe('planSlots (end to end, pure)', () => {
  /** Two teams, one weekend, so the assertions stay countable. */
  const gridsByLeague = { TESTLEAGUE: [{ start: '2026-11-06', end: '2026-11-08' }] }

  const lions = team({
    team: 86, league: 'TESTLEAGUE', category: 'seniors', start_min: '13:30',
    halls: { hard: true, tiers: [{ rank: 1, options: [HALL_AB] }] },
  })
  const du14 = team({
    team: 71, league: 'TESTLEAGUE', category: 'youth', start_max: '13:30',
    halls: { hard: false, tiers: [{ rank: 1, options: [HALL_AB] }, { rank: 2, options: [HALL_A, HALL_B] }, { rank: 3, options: [HALL_C], last_resort: true }] },
  })

  it('applies each team its own rules', () => {
    const { rows, perTeam } = planSlots([lions, du14], ctx({ gridsByLeague }))

    const lionRows = rows.filter((r) => r.kscw_team === 86)
    // A+B only, seniors slots from 13:30: Sat 13:30/16:00/18:30 + Sun 15:00 (12:30 is
    // seniors-allowed but before the 13:30 floor) + Fri 20:00.
    expect(new Set(lionRows.map((r) => r.hall))).toEqual(new Set([HALL_AB]))
    expect(lionRows.every((r) => r.time >= '13:30')).toBe(true)
    expect(lionRows.map((r) => `${r.date} ${r.time}`)).toEqual([
      '2026-11-06 20:00', '2026-11-07 13:30', '2026-11-07 16:00', '2026-11-07 18:30', '2026-11-08 15:00',
    ])

    const du14Rows = rows.filter((r) => r.kscw_team === 71)
    // Youth, ≤13:30: Sat 11:00 + 13:30, Sun 10:00 + 12:30. Never Friday ("U18 only").
    expect(new Set(du14Rows.map((r) => `${r.date} ${r.time}`))).toEqual(new Set([
      '2026-11-07 11:00', '2026-11-07 13:30', '2026-11-08 10:00', '2026-11-08 12:30',
    ]))
    expect(du14Rows.some((r) => r.date === FRI)).toBe(false)
    // All four halls are offered to DU14 (its tier list covers A, B, C and A+B).
    expect(new Set(du14Rows.map((r) => r.hall))).toEqual(new Set([HALL_A, HALL_B, HALL_C, HALL_AB]))

    expect(perTeam.map((p) => p.team)).toEqual([86, 71])
    expect(perTeam[0].kept).toBe(lionRows.length)
    expect(perTeam[0].rejects[REJECT_CODES.HALL_NOT_ALLOWED]).toBeGreaterThan(0)
  })

  it('is deterministic and idempotent — same inputs, byte-identical rows', () => {
    const a = planSlots([lions, du14], ctx({ gridsByLeague }))
    const b = planSlots([lions, du14], ctx({ gridsByLeague }))
    expect(JSON.stringify(b.rows)).toBe(JSON.stringify(a.rows))
    // …and the identity keys are unique, which is what the table's unique index enforces.
    const keys = a.rows.map((r) => slotKey(1, r))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('falls back to the default league window for an unknown league code', () => {
    const stray = team({ team: 99, league: 'NOT_A_LEAGUE', category: 'seniors' })
    const { perTeam } = planSlots([stray], ctx({ gridsByLeague: { ...gridsByLeague, JUN_REG: gridsByLeague.TESTLEAGUE } }))
    expect(perTeam[0].candidates).toBe(31)
  })

  it('every row carries a two-hour end time', () => {
    const { rows } = planSlots([lions], ctx({ gridsByLeague }))
    for (const r of rows) expect(r.end_time).toBe(slotEndTime(r.time))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
describe('parseJsonColumn', () => {
  it('passes objects through, parses strings, and never throws', () => {
    expect(parseJsonColumn({ a: 1 }, null)).toEqual({ a: 1 })
    expect(parseJsonColumn('[5,6,0]', null)).toEqual([5, 6, 0])
    expect(parseJsonColumn('not json', 'fallback')).toBe('fallback')
    expect(parseJsonColumn(null, 'fallback')).toBe('fallback')
  })
})
