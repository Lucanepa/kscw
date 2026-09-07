import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { makeCompletionSource } from './sqlCompletion'
import type { SqlSchemaTable } from './sqlSchema'

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

const source = makeCompletionSource(tables)

/** Run the completion source with the caret at the end of `doc`. */
function complete(doc: string, explicit = false): CompletionResult | null {
  const state = EditorState.create({ doc })
  const ctx = new CompletionContext(state, doc.length, explicit)
  return source(ctx) as CompletionResult | null
}

const labels = (r: CompletionResult | null) => (r?.options ?? []).map((o) => o.label)

const FROM = "SELECT *\nFROM member_teams mt\nJOIN teams t ON t.id = mt.team\nWHERE "

describe('completion: qualified reference', () => {
  it('offers only the aliased table’s columns', () => {
    const r = complete(`${FROM}mt.`)
    expect(labels(r)).toEqual(['id', 'member', 'team', 'season', 'guest_level'])
  })

  it('narrows to the typed prefix without leaking other tables', () => {
    const r = complete(`${FROM}mt.gu`)
    expect(labels(r)).toEqual(['id', 'member', 'team', 'season', 'guest_level'])
    // CodeMirror filters by `from`..`to`; what matters is that no column of
    // `trainings` is in the pool at all.
    expect(labels(r)).not.toContain('excluded_guest_levels')
  })

  it('resolves an abbreviation even before the FROM clause is written', () => {
    expect(labels(complete('SELECT mt.'))).toContain('guest_level')
  })

  it('stays silent on a qualifier that resolves to nothing', () => {
    expect(complete(`${FROM}zz.`)).toBeNull()
  })

  it('replaces only the text after the dot', () => {
    const doc = `${FROM}mt.gu`
    const r = complete(doc)
    expect(r?.from).toBe(doc.length - 2)
    expect(r?.to).toBe(doc.length)
  })
})

describe('completion: values', () => {
  it('offers quoted values right after the operator', () => {
    expect(labels(complete(`${FROM}t.sport = `))).toEqual(["'basketball'", "'volleyball'"])
  })

  it('offers bare values inside an open quote', () => {
    expect(labels(complete(`${FROM}t.sport = '`))).toEqual(['basketball', 'volleyball'])
  })

  it('keeps offering values further into an IN list', () => {
    expect(labels(complete(`${FROM}t.sport IN ('basketball', `))).toEqual([
      "'basketball'",
      "'volleyball'",
    ])
  })

  it('resolves an unqualified column against the tables in scope', () => {
    expect(labels(complete(`${FROM}season = `))).toEqual(["'2025/26'", "'2026/27'"])
  })

  it('offers nothing special for a column with no value hints', () => {
    const r = complete(`${FROM}mt.guest_level = `)
    expect(labels(r)).not.toContain("'volleyball'")
  })

  it('does not offer tables or keywords inside a string literal', () => {
    expect(complete(`${FROM}t.name = 'H`)).toBeNull()
  })
})

describe('completion: identifiers', () => {
  it('offers only tables right after FROM', () => {
    expect(labels(complete('SELECT * FROM mem'))).toEqual([
      'member_teams',
      'members',
      'teams',
      'trainings',
    ])
  })

  it('qualifies in-scope columns with the alias the query declared', () => {
    const l = labels(complete(`${FROM}gue`))
    expect(l).toContain('mt.guest_level')
    expect(l).toContain('t.sport')
    expect(l).not.toContain('guest_level')
  })

  it('qualifies with the table name when no FROM clause exists yet', () => {
    const l = labels(complete('SELECT gue', true))
    expect(l).toContain('member_teams.guest_level')
    expect(l).not.toContain('guest_level')
  })

  it('returns nothing at an empty position unless asked explicitly', () => {
    expect(complete(`${FROM}`)).toBeNull()
    expect(complete(`${FROM}`, true)).not.toBeNull()
  })
})
