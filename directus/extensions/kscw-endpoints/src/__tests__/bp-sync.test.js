/**
 * Unit tests for the bp-sync update-path guards (bp-sync.js).
 *
 *  • cmpVal — the normalizer ported from sv-sync (which fixed the same trap
 *    on 2026-07-04): pg returns date columns as JS Date objects, time as
 *    HH:MM:SS and json parsed, so the old naive String() coercion flagged
 *    every BB game as changed on every run — all 208 rows rewritten nightly,
 *    defeating the skip that exists to avoid trigger notification spam.
 *  • applyLocalGuards — a local cancel survives the feed (Basketplan has no
 *    notion of it; only a played result overrides), and hall/away_hall_json
 *    default to the existing value when the feed resolves nothing, so an
 *    absent key neither clears a hand-set hall nor reads as a change.
 *
 * The headline regression here is the "unchanged nightly run" case: a row
 * exactly as pg returns it vs the same game exactly as the feed builds it
 * must compare as NOT changed.
 *
 * Hermetic — pure functions, no DB or network.
 */
import { describe, it, expect } from 'vitest'
import { applyLocalGuards, cmpVal, buildGameIntents, planManualSweep } from '../bp-sync.js'

// bp-sync's COMPARE_FIELDS (module-internal; mirrored here as the contract).
const COMPARE_FIELDS = [
  'date', 'time', 'status', 'home_score', 'away_score',
  'home_team', 'away_team', 'hall', 'away_hall_json', 'league',
  'kscw_team',
]

// A home game exactly as pg hands the existing row back: DATE at local
// midnight, TIME with seconds, json parsed, no away venue.
const pgHomeRow = () => ({
  status: 'scheduled', kscw_team: 40,
  date: new Date(2026, 9, 24), time: '14:30:00',
  home_score: 0, away_score: 0,
  home_team: 'KSC Wiedikon Basketball H2', away_team: 'BC Divac',
  hall: 3, away_hall_json: null, league: '2LM',
})

// The same game exactly as syncBpGames builds `data` when HALL_MAP misses
// (hall key absent — e.g. a hand-set Döltschi hall) and there is no away venue.
const feedHomeData = () => ({
  status: 'scheduled', kscw_team: 40,
  date: '2026-10-24', time: '14:30',
  home_score: 0, away_score: 0,
  home_team: 'KSC Wiedikon Basketball H2', away_team: 'BC Divac',
  league: '2LM',
})

const isChanged = (data, existing) =>
  COMPARE_FIELDS.some(f => cmpVal(f, data[f]) !== cmpVal(f, existing[f]))

describe('unchanged nightly run — the GAMES-08 regression', () => {
  it('an unchanged home game compares as NOT changed (no nightly rewrite)', () => {
    const existing = pgHomeRow()
    const data = feedHomeData()
    applyLocalGuards(data, existing)
    expect(isChanged(data, existing)).toBe(false)
  })

  it('an unchanged away game (json venue) compares as NOT changed', () => {
    const venue = { name: 'Saalsporthalle', address: 'Giesshübelstrasse 45', city: 'Zürich' }
    const existing = { ...pgHomeRow(), hall: null, away_hall_json: venue }
    const data = { ...feedHomeData(), away_hall_json: JSON.stringify(venue) }
    applyLocalGuards(data, existing)
    expect(isChanged(data, existing)).toBe(false)
  })

  it('a real change still registers — a moved date', () => {
    const existing = pgHomeRow()
    const data = { ...feedHomeData(), date: '2026-10-25' }
    applyLocalGuards(data, existing)
    expect(isChanged(data, existing)).toBe(true)
  })

  it('a real change still registers — a result coming in', () => {
    const existing = pgHomeRow()
    const data = { ...feedHomeData(), status: 'completed', home_score: 68, away_score: 54 }
    applyLocalGuards(data, existing)
    expect(isChanged(data, existing)).toBe(true)
  })
})

describe('applyLocalGuards — local cancel preservation', () => {
  it('keeps a locally-cancelled game cancelled when the feed says scheduled', () => {
    const data = { ...feedHomeData() }
    applyLocalGuards(data, { ...pgHomeRow(), status: 'cancelled' })
    expect(data.status).toBe('cancelled')
  })

  it('keeps the local cancel on a Basketplan withdrawal too (maps to postponed)', () => {
    const data = { ...feedHomeData(), status: 'postponed' }
    applyLocalGuards(data, { ...pgHomeRow(), status: 'cancelled' })
    expect(data.status).toBe('cancelled')
  })

  it('lets a played result through — completed overrides the local cancel', () => {
    const data = { ...feedHomeData(), status: 'completed', home_score: 68, away_score: 54 }
    applyLocalGuards(data, { ...pgHomeRow(), status: 'cancelled' })
    expect(data.status).toBe('completed')
  })

  it('a preserved cancel does not register as a diff — the row is not rewritten nightly', () => {
    const existing = { ...pgHomeRow(), status: 'cancelled' }
    const data = feedHomeData()
    applyLocalGuards(data, existing)
    expect(isChanged(data, existing)).toBe(false)
  })
})

describe('applyLocalGuards — hall / away venue defaulting', () => {
  it('keeps the existing hall when the feed resolves nothing (absent key)', () => {
    const data = feedHomeData()
    applyLocalGuards(data, pgHomeRow())
    expect(data.hall).toBe(3)
  })

  it('the feed still wins when it resolves a hall', () => {
    const data = { ...feedHomeData(), hall: 7 }
    const existing = pgHomeRow()
    applyLocalGuards(data, existing)
    expect(data.hall).toBe(7)
    expect(isChanged(data, existing)).toBe(true)
  })

  it('keeps the existing away venue when the feed sends none', () => {
    const venue = { name: 'Saalsporthalle', city: 'Zürich' }
    const data = feedHomeData()
    applyLocalGuards(data, { ...pgHomeRow(), away_hall_json: venue })
    expect(data.away_hall_json).toEqual(venue)
  })
})

describe('cmpVal — normalization primitives', () => {
  it('pg Date (local midnight) equals the feed date string', () => {
    expect(cmpVal('date', new Date(2026, 9, 24))).toBe('2026-10-24')
    expect(cmpVal('date', '2026-10-24')).toBe('2026-10-24')
  })

  it('pg HH:MM:SS equals the feed HH:MM', () => {
    expect(cmpVal('time', '14:30:00')).toBe('14:30')
    expect(cmpVal('time', '14:30')).toBe('14:30')
  })

  it('parsed json equals the string we write; nullish maps to empty string', () => {
    expect(cmpVal('away_hall_json', { name: 'X' })).toBe('{"name":"X"}')
    expect(cmpVal('away_hall_json', '{"name":"X"}')).toBe('{"name":"X"}')
    expect(cmpVal('away_hall_json', null)).toBe('')
    expect(cmpVal('hall', null)).toBe('')
    expect(cmpVal('home_score', 68)).toBe('68')
  })
})

// ── buildGameIntents — the two-row derby model (audit 2026-08-08, #34) ───────
// bp-sync wrote ONE games row per fixture, keyed on game_id alone. For an
// intra-club fixture that means the away squad gets no row at all: no
// participations from sweepGameAutoConfirm (it joins member_teams on
// g.kscw_team) and no respond_by reminder — silently. Latent today because all
// 17 active BB teams sit in distinct Basketplan groups, but migration 287 seeds
// DU18 A and DU18 B into the same group and it goes live the moment DU18 B gets
// a teams row.
describe('buildGameIntents', () => {
  const HOME_AWAY = { homeTeamId: '111', guestTeamId: '222' }

  it('emits ONE intent for an ordinary home game', () => {
    const out = buildGameIntents({ ...HOME_AWAY, isHome: true, isGuestOurs: false }, 7, null)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ bpId: '111', type: 'home', hall: 7 })
  })

  it('emits ONE intent for an ordinary away game, keeping away_hall_json', () => {
    const away = { name: 'Sporthalle X', address: 'Y 1', city: 'Zürich' }
    const out = buildGameIntents({ ...HOME_AWAY, isHome: false, isGuestOurs: false }, null, away)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ bpId: '222', type: 'away', awayHallJson: away })
  })

  it('emits TWO intents when BOTH sides are ours — one per KSCW team', () => {
    const out = buildGameIntents({ ...HOME_AWAY, isHome: true, isGuestOurs: true }, 7, null)
    expect(out).toHaveLength(2)
    expect(out.map((i) => i.bpId)).toEqual(['111', '222'])
    expect(out.map((i) => i.type)).toEqual(['home', 'away'])
  })

  it('puts BOTH derby rows at our hall and neither at an away venue', () => {
    // The fixture is at our venue, so it is nobody's away game — an
    // away_hall_json here would send the second team to a hall they are at.
    const out = buildGameIntents({ ...HOME_AWAY, isHome: true, isGuestOurs: true }, 7, { name: 'wrong' })
    expect(out.every((i) => i.hall === 7)).toBe(true)
    expect(out.every((i) => i.awayHallJson === null)).toBe(true)
  })

  it('does NOT treat an away fixture as intra-club even if the guest flag is set', () => {
    // isGuestOurs only means "the guest side is a KSCW team". Without isHome we
    // are the guest, so there is exactly one KSCW side.
    const out = buildGameIntents({ ...HOME_AWAY, isHome: false, isGuestOurs: true }, null, null)
    expect(out).toHaveLength(1)
    expect(out[0].bpId).toBe('222')
  })

  it('treats a missing isGuestOurs as not-intra-club (feeds predating the flag)', () => {
    const out = buildGameIntents({ ...HOME_AWAY, isHome: true }, 7, null)
    expect(out).toHaveLength(1)
  })
})

// ── planManualSweep ─────────────────────────────────────────────────
//
// The delete decision, tested without a database because it is the part that
// removes data. Scenario throughout: ProBasket publishes the 26/27 schedule
// into Basketplan weeks after the Spielplansitzung, by which time the BB
// planner has hand-entered the agreed fixtures as `manual_<uuid>` placeholders.
// Those must go; anything else must not.
describe('planManualSweep — retiring superseded placeholders', () => {
  // The real shape: manual rows entered on 06.09, Basketplan publishing on 20.09.
  const ENTERED = new Date('2026-09-06T10:00:00Z')
  const PUBLISHED = new Date('2026-09-20T06:05:00Z')

  const pub = (team, date, created = PUBLISHED) =>
    ({ kscw_team: team, season: '2026/27', date, date_created: created })
  const man = (id, team, date, created = ENTERED) =>
    ({ id, kscw_team: team, season: '2026/27', date, date_created: created })

  it('deletes a placeholder the published schedule covers', () => {
    const out = planManualSweep(
      [pub(75, '2026-10-03'), pub(75, '2026-12-10')],
      [man(578, 75, '2026-10-03')],
    )
    expect(out.deleteIds).toEqual([578])
  })

  it('leaves a team ProBasket has NOT published alone', () => {
    // The junior 1. Phase and the senior season go live at different times —
    // sweeping the whole club off one team's publish would wipe the only copy
    // of a schedule that is still hand-kept.
    const out = planManualSweep(
      [pub(75, '2026-10-03'), pub(75, '2026-12-10')],
      [man(578, 75, '2026-10-03'), man(628, 72, '2026-11-15')],
    )
    expect(out.deleteIds).toEqual([578])
  })

  it('leaves a placeholder OUTSIDE the published date range (partial publish)', () => {
    // Vorrunde published, Rückrunde not yet: the March game is still the only
    // record of that fixture.
    const out = planManualSweep(
      [pub(75, '2026-10-03'), pub(75, '2026-12-10')],
      [man(578, 75, '2026-11-19'), man(583, 75, '2027-03-27')],
    )
    expect(out.deleteIds).toEqual([578])
  })

  it('picks up the rest once the range grows on a later run', () => {
    // Same manual rows, Rückrunde now published — idempotent re-run reaches it.
    const out = planManualSweep(
      [pub(75, '2026-10-03'), pub(75, '2027-05-07')],
      [man(578, 75, '2026-11-19'), man(583, 75, '2027-03-27')],
    )
    expect(out.deleteIds).toEqual([578, 583])
  })

  it('NEVER touches a game added after the real schedule arrived', () => {
    // A friendly / cup fixture Basketplan does not carry. Dead centre of the
    // published range, and it must survive — this is the condition that makes
    // the rule mean "placeholder" rather than "manual".
    const friendly = man(999, 75, '2026-11-19', new Date('2026-10-01T09:00:00Z'))
    const out = planManualSweep([pub(75, '2026-10-03'), pub(75, '2026-12-10')], [friendly])
    expect(out.deleteIds).toEqual([])
  })

  it('does not cross seasons', () => {
    const out = planManualSweep(
      [pub(75, '2026-10-03'), pub(75, '2026-12-10')],
      [{ ...man(500, 75, '2026-11-19'), season: '2025/26' }],
    )
    expect(out.deleteIds).toEqual([])
  })

  it('compares pg Date objects and feed strings alike', () => {
    // pg hands dates back as local-midnight Date objects; a naive compare
    // against the 'YYYY-MM-DD' bounds would silently never match.
    const out = planManualSweep(
      [pub(75, new Date(2026, 9, 3)), pub(75, new Date(2026, 11, 10))],
      [man(578, 75, new Date(2026, 10, 19))],
    )
    expect(out.deleteIds).toEqual([578])
  })

  it('includes the range endpoints', () => {
    const out = planManualSweep(
      [pub(75, '2026-10-03'), pub(75, '2026-12-10')],
      [man(1, 75, '2026-10-03'), man(2, 75, '2026-12-10')],
    )
    expect(out.deleteIds).toEqual([1, 2])
  })

  it('fails SAFE when the published row has no date_created', () => {
    // Nothing can be shown to predate an unknown arrival, so nothing is swept —
    // the null must not read as "epoch", which would license deleting everything.
    const out = planManualSweep(
      [{ ...pub(75, '2026-10-03'), date_created: null }],
      [man(578, 75, '2026-10-03')],
    )
    expect(out.deleteIds).toEqual([])
  })

  it('fails SAFE when the manual row has no date_created', () => {
    const out = planManualSweep([pub(75, '2026-10-03')], [man(578, 75, '2026-10-03', null)])
    expect(out.deleteIds).toEqual([])
  })

  it('uses the EARLIEST publish as the cutoff when fixtures arrive in waves', () => {
    // A row added between the two waves is not a placeholder for wave one.
    const between = man(999, 75, '2026-12-05', new Date('2026-10-05T09:00:00Z'))
    const out = planManualSweep(
      [pub(75, '2026-10-03'), pub(75, '2026-12-10', new Date('2026-11-01T06:05:00Z'))],
      [man(578, 75, '2026-11-19'), between],
    )
    expect(out.deleteIds).toEqual([578])
  })

  it('groups the summary by team', () => {
    const out = planManualSweep(
      [pub(75, '2026-10-03'), pub(75, '2026-12-10'), pub(86, '2026-10-21'), pub(86, '2026-12-04')],
      [man(1, 75, '2026-11-19'), man(2, 75, '2026-12-10'), man(3, 86, '2026-10-28')],
    )
    expect(out.deleteIds).toEqual([1, 2, 3])
    expect(out.byTeam.get('75|2026/27')).toBe(2)
    expect(out.byTeam.get('86|2026/27')).toBe(1)
  })

  it('is a no-op when nothing is published', () => {
    // Today's real state: 59 placeholders, zero Basketplan fixtures.
    const out = planManualSweep([], [man(578, 75, '2026-10-03'), man(628, 72, '2026-09-19')])
    expect(out.deleteIds).toEqual([])
  })
})
