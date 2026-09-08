/**
 * Unit tests for findDuplicateFixtures (dataHealthChecks.ts).
 *
 * The detector behind /admin/data-health's "Possible duplicate fixture" row.
 * Both sync sources are blind to hand-entered games — bp-sync pairs on
 * `bb_<gameNumber>`, sv-sync on `vb_<svrz_number>`, and each loads only its own
 * `source` when looking for the existing row — so a fixture typed in before the
 * feed carried it survives alongside the published one. bp-sync's sweep retires
 * the basketball placeholders it can PROVE are placeholders; this is the net for
 * everything else, both sports.
 *
 * The headline case is the pair the sweep deliberately does not touch: a manual
 * row created AFTER the schedule was published (the sweep reads that as a
 * friendly, correctly) which nevertheless collides with a real fixture.
 *
 * Hermetic — a pure function over rows, no fetch and no database.
 */
import { describe, it, expect } from 'vitest'
import { findDuplicateFixtures } from '../dataHealthChecks'

const manual = (o: Record<string, unknown> = {}) => ({
  id: 1, game_id: 'manual_abc', source: 'manual', kscw_team: 75,
  date: '2026-10-03', time: '15:40:00', status: 'scheduled',
  home_team: 'BC Winti', away_team: 'Herren 1', ...o,
})
const synced = (o: Record<string, unknown> = {}) => ({
  id: 2, game_id: 'bb_25-1234', source: 'basketplan', kscw_team: 75,
  date: '2026-10-03', time: '15:40:00', status: 'scheduled',
  home_team: 'BC Winterthur 2 H1', away_team: 'Herren 1', ...o,
})

describe('findDuplicateFixtures', () => {
  it('flags a manual game sharing team + date with a synced one', () => {
    const out = findDuplicateFixtures([manual(), synced()])
    expect(out).toHaveLength(1)
    expect(out[0].issueKey).toBe('duplicateFixture')
    expect(out[0].id).toBe('1') // the MANUAL row is the one reported
    expect(out[0].collection).toBe('games')
  })

  it('matches despite opponent-name drift — the reason it is not keyed on opponent', () => {
    // "BC Winti" vs "BC Winterthur 2 H1" is the same club. Keying on the
    // opponent would miss this, which is the wrong way to be wrong here.
    const out = findDuplicateFixtures([manual(), synced()])
    expect(out).toHaveLength(1)
    // Both sides ride in the detail so an admin can adjudicate at a glance.
    expect(out[0].detail).toContain('BC Winti')
    expect(out[0].detail).toContain('BC Winterthur 2 H1')
  })

  it('is never auto-fixable — which row to keep is a judgement call', () => {
    // Deleting a game takes its RSVPs with it (trg_games_0_purge_polymorphic),
    // and the manual row may carry a hand-set hall or a corrected time.
    const out = findDuplicateFixtures([manual(), synced()])
    expect(out[0].autoFixable).toBe(false)
    expect(out[0].fixValue).toBeUndefined()
    expect(out[0].severity).toBe('warning')
  })

  it('catches the pair bp-sync\'s sweep deliberately leaves — a post-publish manual row', () => {
    // The sweep only retires rows created BEFORE the schedule arrived, so this
    // one is invisible to it by design. That is exactly what the net is for.
    const out = findDuplicateFixtures([manual({ id: 9 }), synced()])
    expect(out.map((i) => i.id)).toEqual(['9'])
  })

  it('covers volleyball too — a hand-typed cup game the SV feed later carried', () => {
    const out = findDuplicateFixtures([
      manual({ id: 5, kscw_team: 40, home_team: 'Herren 1', away_team: 'Züri Cup R2' }),
      synced({ id: 6, kscw_team: 40, source: 'swiss_volley', game_id: 'vb_397153' }),
    ])
    expect(out.map((i) => i.id)).toEqual(['5'])
  })

  it('does NOT flag two synced fixtures on one day — tournaments and double-headers', () => {
    // Real prod shape: U12/MU10 tournament days and an HU23-1 double-header,
    // two genuine fixtures with distinct feed numbers.
    const out = findDuplicateFixtures([
      synced({ id: 1, game_id: 'bb_25-09706' }),
      synced({ id: 2, game_id: 'bb_25-09723' }),
    ])
    expect(out).toEqual([])
  })

  it('does NOT flag two MANUAL games on one day', () => {
    // Nothing has published them, so neither is a duplicate of the other.
    const out = findDuplicateFixtures([manual({ id: 1 }), manual({ id: 2, game_id: 'manual_def' })])
    expect(out).toEqual([])
  })

  it('does not cross teams', () => {
    const out = findDuplicateFixtures([manual({ kscw_team: 75 }), synced({ kscw_team: 86 })])
    expect(out).toEqual([])
  })

  it('does not cross dates', () => {
    const out = findDuplicateFixtures([manual({ date: '2026-10-03' }), synced({ date: '2026-10-04' })])
    expect(out).toEqual([])
  })

  it('compares a stringified team id against a numeric one', () => {
    // fetchItems stringifies integers unless the field is in KEEP_AS_NUMBER, so
    // the two sides can legitimately arrive as '75' and 75.
    const out = findDuplicateFixtures([manual({ kscw_team: '75' }), synced({ kscw_team: 75 })])
    expect(out).toHaveLength(1)
  })

  it('handles an expanded M2O object as well as a bare id', () => {
    const out = findDuplicateFixtures([
      manual({ kscw_team: { id: 75, name: 'Herren 1' } }),
      synced({ kscw_team: 75 }),
    ])
    expect(out).toHaveLength(1)
  })

  it('tolerates a full ISO timestamp in date', () => {
    const out = findDuplicateFixtures([
      manual({ date: '2026-10-03T00:00:00' }), synced({ date: '2026-10-03' }),
    ])
    expect(out).toHaveLength(1)
  })

  it('ignores a cancelled manual row — already out of every live view', () => {
    const out = findDuplicateFixtures([manual({ status: 'cancelled' }), synced()])
    expect(out).toEqual([])
  })

  it('skips rows with no team or no date rather than grouping them together', () => {
    // Two undated rows must not read as "same day". Prod carries exactly this:
    // two basketplan DU10 rows whose kscw_team is NULL.
    const out = findDuplicateFixtures([
      manual({ id: 1, kscw_team: null }), synced({ id: 2, kscw_team: null }),
      manual({ id: 3, date: '' }), synced({ id: 4, date: '' }),
    ])
    expect(out).toEqual([])
  })

  it('reports one issue per manual row when several synced fixtures share the day', () => {
    const out = findDuplicateFixtures([
      manual(), synced({ id: 2, game_id: 'bb_A' }), synced({ id: 3, game_id: 'bb_B' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].detail).toContain('bb_A')
    expect(out[0].detail).toContain('bb_B')
  })

  it('is empty on the current prod shape — 59 manual BB games, nothing published', () => {
    const rows = Array.from({ length: 59 }, (_, i) =>
      manual({ id: i + 1, game_id: `manual_${i}`, kscw_team: 70 + (i % 11), date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}` }))
    expect(findDuplicateFixtures(rows)).toEqual([])
  })
})
