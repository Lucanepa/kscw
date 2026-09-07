import { describe, it, expect } from 'vitest'
import { buildEvent, isOwnGameTitle } from '../gcal-push.js'

const base = { away_team: 'RJ Lakers D1', hall_letter: 'A', time: '20:00:00', date: '2026-09-19', game_id: 'x' }

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
