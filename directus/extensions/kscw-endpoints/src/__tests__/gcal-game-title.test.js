import { describe, it, expect } from 'vitest'
import { buildEvent, isOwnGameTitle, placementFixture } from '../gcal-push.js'

const base = { away_team: 'RJ Lakers D1', hall_label: 'A', time: '20:00:00', date: '2026-09-19', game_id: 'x' }

describe('buildEvent — sport prefix', () => {
  // Reported 07.09.2026: the KWI calendar showed "VB Lions D1 vs. RJ Lakers D1"
  // for a basketball game. The prefix used to come from `source`, and the
  // Spielplanung editor writes source='manual' for both sports.
  it('labels a hand-entered basketball game BB, not VB', () => {
    const ev = buildEvent({ ...base, source: 'manual', sport: 'basketball', team_name: 'Lions D1' })
    expect(ev.summary).toBe('BB Lions D1 vs. RJ Lakers D1 (Halle A)')
  })

  it('labels a Basketplan game BB even with no team row', () => {
    const ev = buildEvent({ ...base, source: 'basketplan', sport: null, home_team: 'Herren 1' })
    expect(ev.summary).toBe('BB Herren 1 vs. RJ Lakers D1 (Halle A)')
  })

  it('still labels volleyball VB', () => {
    const ev = buildEvent({ ...base, source: 'swiss_volley', sport: 'volleyball', team_name: 'D4', away_team: 'Rüschlikon 4' })
    expect(ev.summary).toBe('VB D4 vs. Rüschlikon 4 (Halle A)')
  })

  it('labels a hand-entered volleyball game VB', () => {
    const ev = buildEvent({ ...base, source: 'manual', sport: 'volleyball', team_name: 'D4' })
    expect(ev.summary).toBe('VB D4 vs. RJ Lakers D1 (Halle A)')
  })
})

describe('isOwnGameTitle — the pull-side backstop', () => {
  it('recognises what buildEvent emits, both sports', () => {
    for (const g of [
      { ...base, source: 'manual', sport: 'basketball', team_name: 'Lions D1' },
      { ...base, source: 'swiss_volley', sport: 'volleyball', team_name: 'D4' },
    ]) expect(isOwnGameTitle(buildEvent(g).summary)).toBe(true)
  })

  // Skipping these by a bare "BB " prefix deleted 84 hall_events on dev — the
  // hall shows as free while a junior game is being played in it.
  it.each([
    'BB - Freundschaftsspiel',
    'BB DU16E Turnier',
    'VB U20 Tournament',
    'Halle geschlossen',
    'ASVZ Volleynight 2026',
  ])('leaves the hall administration\'s own entry alone: %s', (title) => {
    expect(isOwnGameTitle(title)).toBe(false)
  })

  it('is safe on a missing title', () => {
    expect(isOwnGameTitle(undefined)).toBe(false)
    expect(isOwnGameTitle(null)).toBe(false)
  })
})

describe('placementFixture — accepted BB placements with no games row', () => {
  const row = {
    id: 8, kscw_team: 75, team_name: 'Herren 1', kscw_team_label: null,
    opponent: 'BC Winterthur 2 H1', hall: 'KWI A+B', date: '2026-11-14', time: '16:00',
  }

  it('publishes an agreed placement in the hall administration\'s format', () => {
    expect(buildEvent(placementFixture(row)).summary)
      .toBe('BB Herren 1 vs. BC Winterthur 2 H1 (Halle A+B)')
  })

  it('keys the event on the placement id, not a game id', () => {
    const ev = buildEvent(placementFixture(row))
    expect(ev.extendedProperties.private.game_id).toBe('bbplan_8')
    expect(ev.extendedProperties.private.wiedisync).toBe('game')
  })

  it('is recognised by the pull-side backstop like any other of ours', () => {
    expect(isOwnGameTitle(buildEvent(placementFixture(row)).summary)).toBe(true)
  })

  it.each([['KWI A', 'A'], ['KWI B', 'B'], ['KWI C', 'C'], ['KWI A+B', 'A+B']])(
    'renders %s as (Halle %s)', (hall, label) => {
      expect(buildEvent(placementFixture({ ...row, hall })).summary).toContain(`(Halle ${label})`)
    })

  it('falls back to the grid label when the placement has no team row', () => {
    const fx = placementFixture({ ...row, team_name: null, kscw_team_label: 'Herren 3 (Unicorns)' })
    expect(buildEvent(fx).summary).toBe('BB Herren 3 (Unicorns) vs. BC Winterthur 2 H1 (Halle A+B)')
  })
})

describe('a double-floor game says so', () => {
  // vb_slot_floors joins the primary hall with additional_halls; a game across
  // the divider that reads "(Halle A)" tells the hall admin B is free.
  it('labels an A+B booking (Halle A+B)', () => {
    const ev = buildEvent({ ...base, source: 'manual', sport: 'basketball', team_name: 'Herren 1', hall_label: 'A+B' })
    expect(ev.summary).toBe('BB Herren 1 vs. RJ Lakers D1 (Halle A+B)')
    expect(isOwnGameTitle(ev.summary)).toBe(true)
  })
})
