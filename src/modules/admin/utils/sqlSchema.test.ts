import { describe, it, expect } from 'vitest'
import {
  parseQueryScope,
  resolveTableRef,
  suggestSimilar,
  parseMissingIdentifier,
  didYouMean,
  type SqlSchemaTable,
} from './sqlSchema'

const tables: SqlSchemaTable[] = [
  {
    name: 'member_teams',
    columns: [
      { name: 'id', dataType: 'integer', pk: true },
      { name: 'member', dataType: 'integer', ref: 'members.id' },
      { name: 'team', dataType: 'integer', ref: 'teams.id' },
      { name: 'season', dataType: 'character varying', values: ['2025/26', '2026/27'] },
      { name: 'guest_level', dataType: 'integer' },
    ],
  },
  {
    name: 'members',
    columns: [
      { name: 'id', dataType: 'integer', pk: true },
      { name: 'first_name', dataType: 'character varying' },
      { name: 'last_name', dataType: 'character varying' },
      { name: 'licence_activated', dataType: 'boolean' },
    ],
  },
  {
    name: 'teams',
    columns: [
      { name: 'id', dataType: 'integer', pk: true },
      { name: 'name', dataType: 'character varying' },
      { name: 'sport', dataType: 'character varying', values: ['basketball', 'volleyball'] },
    ],
  },
  { name: 'trainings', columns: [{ name: 'excluded_guest_levels', dataType: 'jsonb' }] },
]

const QUERY = `SELECT t.name, m.first_name
FROM member_teams mt
JOIN members m ON m.id = mt.member
JOIN teams t ON t.id = mt.team
WHERE mt.season = '2026/27'`

describe('parseQueryScope', () => {
  it('maps every alias in the query to its table', () => {
    expect(parseQueryScope(QUERY, tables)).toEqual([
      { alias: 'mt', table: 'member_teams' },
      { alias: 'm', table: 'members' },
      { alias: 't', table: 'teams' },
    ])
  })

  it('falls back to the table name when no alias is given', () => {
    expect(parseQueryScope('SELECT * FROM members WHERE id = 1', tables)).toEqual([
      { alias: 'members', table: 'members' },
    ])
  })

  it('does not mistake a following keyword for an alias', () => {
    expect(parseQueryScope('SELECT * FROM members WHERE id = 1', tables)[0].alias).toBe('members')
    expect(parseQueryScope('SELECT * FROM teams ORDER BY name', tables)[0].alias).toBe('teams')
  })

  it('ignores tables that are not in the schema', () => {
    expect(parseQueryScope('SELECT * FROM nope n', tables)).toEqual([])
  })
})

describe('resolveTableRef', () => {
  const scope = parseQueryScope(QUERY, tables)

  it('resolves a declared alias', () => {
    expect(resolveTableRef('mt', tables, scope)?.name).toBe('member_teams')
    expect(resolveTableRef('t', tables, scope)?.name).toBe('teams')
  })

  it('resolves an exact table name', () => {
    expect(resolveTableRef('members', tables)?.name).toBe('members')
  })

  it('resolves snake_case initials even without a FROM clause', () => {
    expect(resolveTableRef('mt', tables)?.name).toBe('member_teams')
  })

  it('resolves a unique prefix', () => {
    expect(resolveTableRef('train', tables)?.name).toBe('trainings')
  })

  it('resolves a single-word table by its initial', () => {
    // `members` is the only table whose initials are just `m` — `member_teams`
    // is `mt` — so `m.` is unambiguous even with no FROM clause yet.
    expect(resolveTableRef('m', tables)?.name).toBe('members')
  })

  it('returns null rather than guessing an ambiguous prefix', () => {
    // Both `teams` and `trainings` start with `t` and reduce to the initial `t`.
    expect(resolveTableRef('t', tables)).toBeNull()
    expect(resolveTableRef('zzz', tables)).toBeNull()
  })
})

describe('suggestSimilar', () => {
  it('ranks the near miss first', () => {
    expect(suggestSimilar('guest_lvl', ['guest_level', 'season', 'id'])[0]).toBe('guest_level')
  })

  it('catches a missing plural via containment', () => {
    expect(suggestSimilar('member_team', ['member_teams', 'members'])[0]).toBe('member_teams')
  })

  it('returns nothing for an unrelated name', () => {
    expect(suggestSimilar('qqqqqqqq', ['season', 'id'])).toEqual([])
  })
})

describe('parseMissingIdentifier', () => {
  it('reads an unqualified column', () => {
    expect(parseMissingIdentifier('column "guest_lvl" does not exist')).toEqual({
      kind: 'column',
      name: 'guest_lvl',
      qualifier: undefined,
    })
  })

  it('reads a qualified column', () => {
    expect(parseMissingIdentifier('column mt.guest_lvl does not exist')).toEqual({
      kind: 'column',
      name: 'guest_lvl',
      qualifier: 'mt',
    })
  })

  it('reads "column x of relation y"', () => {
    expect(parseMissingIdentifier('column "sprt" of relation "teams" does not exist')).toEqual({
      kind: 'column',
      name: 'sprt',
      qualifier: 'teams',
    })
  })

  it('reads a missing relation', () => {
    expect(parseMissingIdentifier('relation "member_team" does not exist')).toEqual({
      kind: 'table',
      name: 'member_team',
      qualifier: undefined,
    })
  })

  it('returns null for an unrelated error', () => {
    expect(parseMissingIdentifier('syntax error at or near "SELEC"')).toBeNull()
  })
})

describe('didYouMean', () => {
  it('scopes a qualified column to the alias table and keeps the alias', () => {
    const r = didYouMean('column mt.guest_lvl does not exist', QUERY, tables)
    expect(r?.suggestions).toEqual(['mt.guest_level'])
  })

  it('does not offer a same-named column from a table the query never joined', () => {
    const r = didYouMean('column mt.excluded_guest_level does not exist', QUERY, tables)
    // `trainings.excluded_guest_levels` is close, but `trainings` is not in scope.
    expect(r?.suggestions ?? []).not.toContain('mt.excluded_guest_levels')
  })

  it('suggests a table for a missing relation', () => {
    const r = didYouMean('relation "member_team" does not exist', 'SELECT * FROM member_team', tables)
    expect(r?.suggestions).toContain('member_teams')
  })

  it('returns null when nothing is close enough', () => {
    expect(didYouMean('column "xyzzy_qqq" does not exist', QUERY, tables)).toBeNull()
  })
})
