// src/modules/admin/utils/sqlCompletion.ts
//
// The SQL workspace's autocomplete engine. Kept out of the editor component so
// it stays a pure function of (schema, document, caret) — which is how it is
// tested.

import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import {
  parseQueryScope,
  resolveTableRef,
  shortType,
  type SqlSchemaColumn,
  type SqlSchemaTable,
} from './sqlSchema'

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE', 'IS', 'NULL',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'USING',
  'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'DISTINCT',
  'AS', 'WITH', 'RECURSIVE',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'UNION', 'INTERSECT', 'EXCEPT', 'ALL', 'EXISTS', 'ANY', 'BETWEEN', 'COALESCE', 'CAST',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ARRAY_AGG', 'JSONB_AGG', 'JSON_AGG', 'STRING_AGG',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'RETURNING',
  'TRUE', 'FALSE',
]

/** Positions where a table name is the only sensible completion. */
const AFTER_TABLE_CLAUSE = /\b(?:FROM|JOIN|UPDATE|INTO)\s+[\w$]*$/i

/** Comparison operators after which a *value* is expected, not an identifier. */
const VALUE_OPERATOR =
  /(?:<>|!=|<=|>=|=|<|>|\bLIKE\b|\bILIKE\b|\bNOT\s+LIKE\b|\bNOT\s+ILIKE\b|\bIN\b\s*\(|\bANY\b\s*\(|\bALL\b\s*\()\s*$/i

/** The column reference immediately left of an operator: `mt.guest_level` or
 *  a bare `sport`. */
const COLUMN_REF = /(?:([A-Za-z_][\w$]*)\s*\.\s*)?([A-Za-z_][\w$]*)\s*$/

/** Short marker appended to a column's detail line. */
function columnDetail(c: SqlSchemaColumn): string {
  const bits = [shortType(c.dataType)]
  if (c.pk) bits.push('PK')
  if (c.ref) bits.push(`→ ${c.ref}`)
  return bits.filter(Boolean).join(' · ')
}

/**
 * Index of the quote that opens an unterminated string literal, or null when
 * the caret is outside one. A trailing-quote regex cannot answer this: in
 * `IN ('basketball', ` it matches the *closing* quote and reports the caret as
 * being inside a string, which silences the completion for the rest of the
 * list.
 */
function openStringAt(text: string): number | null {
  let start: number | null = null
  let i = 0
  while (i < text.length) {
    if (text[i] === "'") {
      if (start === null) {
        start = i
      } else if (text[i + 1] === "'") {
        i += 2 // '' is an escaped quote inside the literal
        continue
      } else {
        start = null
      }
    }
    i++
  }
  return start
}

/**
 * Walk back over a completed `IN ('a', 'b', ` list so the operator match sees
 * the `IN (` rather than the trailing comma.
 */
function stripValueList(text: string): string {
  let h = text.trimEnd()
  for (;;) {
    if (!h.endsWith(',')) return h
    const withoutComma = h.slice(0, -1).trimEnd()
    const literal = /'(?:[^']|'')*'$/.exec(withoutComma)
    h = literal ? withoutComma.slice(0, literal.index).trimEnd() : withoutComma
  }
}

/**
 * Build a schema-aware autocomplete source.
 *
 * Four positions, each answered with only what is valid there — the point is
 * that a suggestion list which contains the wrong table's columns is how a
 * query ends up referencing a column that does not exist:
 *   - `alias.` / `table.` -> ONLY that table's columns, with aliases resolved
 *     against the query's own FROM/JOIN clauses (`mt.` -> member_teams)
 *   - after `FROM` / `JOIN` -> table names only
 *   - after `=`, `IN (`, `LIKE` -> the values that column actually holds
 *     (`sport = 'volleyball'`, never `'vb'`)
 *   - anywhere else -> table-qualified columns, tables and keywords; the
 *     qualifier is part of the inserted text, so the reference is unambiguous
 *     from the first keystroke
 */
export function makeCompletionSource(tables: readonly SqlSchemaTable[]): CompletionSource {
  const tableCompletions: Completion[] = tables.map((t) => ({
    label: t.name,
    type: 'type',
    detail: `${t.columns.length} cols`,
    boost: 5,
  }))

  // Per-table column lists, for the `alias.` / `table.` case.
  const columnsByTable = new Map<string, Completion[]>()
  for (const t of tables) {
    columnsByTable.set(
      t.name,
      t.columns.map((c) => ({
        label: c.name,
        type: c.pk ? 'constant' : 'property',
        detail: columnDetail(c),
        info: `${t.name}.${c.name} :: ${c.dataType ?? '?'}${c.values ? `\nin ${c.values.join(', ')}` : ''}`,
        boost: 10,
      })),
    )
  }

  // Every column in the schema, labelled `table.column` so an out-of-context
  // suggestion still says which table it came from.
  const qualifiedColumns: Completion[] = []
  for (const t of tables) {
    for (const c of t.columns) {
      qualifiedColumns.push({
        label: `${t.name}.${c.name}`,
        type: 'property',
        detail: columnDetail(c),
        boost: 0,
      })
    }
  }

  const keywordCompletions: Completion[] = SQL_KEYWORDS.map((k) => ({
    label: k,
    type: 'keyword',
    boost: -1,
  }))

  /** Values a column can hold, unioned across every table that defines a
   *  column of that name when the reference is unqualified. */
  function valuesFor(
    column: string,
    qualifier: string | undefined,
    scope: ReturnType<typeof parseQueryScope>,
  ): string[] {
    const lc = column.toLowerCase()
    const collect = (t: SqlSchemaTable) =>
      t.columns.find((c) => c.name.toLowerCase() === lc)?.values ?? []

    if (qualifier) {
      const t = resolveTableRef(qualifier, tables, scope)
      return t ? [...collect(t)] : []
    }
    const inScope = scope
      .map((s) => tables.find((t) => t.name === s.table))
      .filter((t): t is SqlSchemaTable => Boolean(t))
    const pool = inScope.length ? inScope : tables
    const out: string[] = []
    for (const t of pool) {
      for (const v of collect(t)) if (!out.includes(v)) out.push(v)
    }
    return out
  }

  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos)
    const before = line.text.slice(0, context.pos - line.from)
    const scope = parseQueryScope(context.state.doc.toString(), tables)

    // ── 1. A value, either inside an open quote or right after the operator ──
    const quoteAt = openStringAt(before)
    const inString = quoteAt !== null
    const bareWord = /([A-Za-z0-9_$]*)$/.exec(before) as RegExpExecArray
    const typedFrom = inString ? (quoteAt as number) + 1 : bareWord.index
    const head = stripValueList(before.slice(0, inString ? (quoteAt as number) : bareWord.index))

    if (VALUE_OPERATOR.test(head)) {
      const lhs = head.replace(VALUE_OPERATOR, '')
      const ref = COLUMN_REF.exec(lhs)
      if (ref) {
        const values = valuesFor(ref[2], ref[1], scope)
        if (values.length > 0) {
          return {
            from: line.from + typedFrom,
            to: context.pos,
            options: values.map((v) => ({
              label: inString ? v : `'${v}'`,
              type: 'text',
              detail: ref[1] ? `${ref[1]}.${ref[2]}` : ref[2],
              boost: 20,
            })),
            validFor: inString ? /^[^']*$/ : /^[\w'$]*$/,
          }
        }
      }
    }
    // An open string literal is never an identifier position — offering tables
    // and keywords inside quotes is pure noise.
    if (inString) return null

    // ── 2. `alias.` / `table.` — that table's columns and nothing else ──
    const dotted = context.matchBefore(/[A-Za-z_][\w$]*\s*\.\s*[\w$]*$/)
    if (dotted) {
      const m = /^([A-Za-z_][\w$]*)\s*\.\s*([\w$]*)$/.exec(dotted.text)
      if (m) {
        const table = resolveTableRef(m[1], tables, scope)
        // Unresolvable qualifier: stay silent rather than offer another
        // table's columns, which is what the flat list used to do.
        if (!table) return null
        return {
          from: context.pos - m[2].length,
          to: context.pos,
          options: columnsByTable.get(table.name) ?? [],
          validFor: /^[\w$]*$/,
        }
      }
    }

    // ── 3. Right after FROM / JOIN / UPDATE / INTO — tables only ──
    if (AFTER_TABLE_CLAUSE.test(before)) {
      return {
        from: line.from + bareWord.index,
        to: context.pos,
        options: tableCompletions,
        validFor: /^[\w$]*$/,
      }
    }

    // ── 4. Anything else — qualified columns first, then tables, keywords ──
    if (bareWord.index === before.length && !context.explicit) return null

    const options: Completion[] = []
    if (scope.length > 0) {
      // Columns of the tables this query actually joined, inserted with the
      // alias the query itself declared.
      for (const s of scope) {
        const t = tables.find((tb) => tb.name === s.table)
        if (!t) continue
        for (const c of t.columns) {
          options.push({
            label: `${s.alias}.${c.name}`,
            type: c.pk ? 'constant' : 'property',
            detail: columnDetail(c),
            info: s.alias === t.name ? undefined : `${t.name}.${c.name}`,
            boost: 8,
          })
        }
      }
      for (const s of scope) {
        if (s.alias !== s.table) options.push({ label: s.alias, type: 'type', detail: s.table, boost: 6 })
      }
    }
    options.push(...tableCompletions, ...keywordCompletions)
    // Out-of-scope columns stay available (people write sub-selects) but sort
    // below everything the current query can actually reference.
    if (scope.length === 0) options.push(...qualifiedColumns)

    return {
      from: line.from + bareWord.index,
      to: context.pos,
      options,
      validFor: /^[\w$]*$/,
    }
  }
}
