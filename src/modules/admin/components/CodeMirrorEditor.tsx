import { useRef, useEffect, useMemo } from 'react'
import { EditorView, keymap, placeholder as cmPlaceholder, tooltips } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import {
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'
import { useTheme } from '@/hooks/useTheme'
import {
  parseQueryScope,
  resolveTableRef,
  type SqlSchemaColumn,
  type SqlSchemaTable,
} from '../utils/sqlSchema'

export type { SqlSchemaColumn, SqlSchemaTable }

interface CodeMirrorEditorProps {
  value: string
  onChange: (value: string) => void
  onExecute: () => void
  tables: readonly SqlSchemaTable[]
  placeholder?: string
}

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
  const bits = [c.dataType ?? '']
  if (c.pk) bits.push('PK')
  if (c.ref) bits.push(`→ ${c.ref}`)
  return bits.filter(Boolean).join(' · ')
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
function makeCompletionSource(tables: readonly SqlSchemaTable[]): CompletionSource {
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
    const openQuote = /'([^']*)$/.exec(before)
    const bareWord = /([A-Za-z0-9_$]*)$/.exec(before) as RegExpExecArray
    const typedFrom = openQuote ? openQuote.index + 1 : bareWord.index
    const head = stripValueList(before.slice(0, openQuote ? openQuote.index : bareWord.index))

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
              label: openQuote ? v : `'${v}'`,
              type: 'text',
              detail: ref[1] ? `${ref[1]}.${ref[2]}` : ref[2],
              boost: 20,
            })),
            validFor: openQuote ? /^[^']*$/ : /^[\w'$]*$/,
          }
        }
      }
    }
    // An open string literal is never an identifier position — offering tables
    // and keywords inside quotes is pure noise.
    if (openQuote) return null

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

function completionExtension(source: CompletionSource) {
  return autocompletion({
    activateOnTyping: true,
    defaultKeymap: true,
    maxRenderedOptions: 60,
    // The info panel is what covers the list on a phone: it is rendered beside
    // the options on a wide screen and on top of them on a narrow one. Below
    // `md` it is hidden entirely (see the theme) and every fact it carried is
    // in the option's own detail line instead.
    closeOnBlur: true,
    override: [source],
  })
}

export default function CodeMirrorEditor({
  value,
  onChange,
  onExecute,
  tables,
  placeholder,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const externalValueRef = useRef(value)
  const onExecuteRef = useRef(onExecute)
  const onChangeRef = useRef(onChange)
  const themeCompartment = useRef(new Compartment())
  const completionCompartment = useRef(new Compartment())
  const { theme } = useTheme()

  // Latest-callback refs. Written after commit (never during render) — the only
  // readers are the CodeMirror keymap handler and the updateListener, both of
  // which fire from editor events, i.e. always after the commit that wrote them.
  useEffect(() => {
    onExecuteRef.current = onExecute
    onChangeRef.current = onChange
  })

  const completionSource = useMemo(() => makeCompletionSource(tables), [tables])

  useEffect(() => {
    if (!containerRef.current) return

    const executeKeymap = keymap.of([
      {
        key: 'Ctrl-Enter',
        mac: 'Cmd-Enter',
        run: () => {
          onExecuteRef.current()
          return true
        },
      },
      {
        key: 'Ctrl-Space',
        run: (view) => {
          startCompletion(view)
          return true
        },
      },
    ])

    const state = EditorState.create({
      doc: value,
      extensions: [
        executeKeymap,
        basicSetup,
        // Wrap long lines instead of horizontal scrolling — on touch devices the
        // inner horizontal pan is unreachable (nested scroll containers swallow
        // the gesture), leaving long SQL cut off at both edges.
        EditorView.lineWrapping,
        // lang-sql for syntax highlighting only — we override completion
        // entirely below so column suggestions work at every position.
        sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
        // Fixed positioning keeps the completion popup out of the wrapper's
        // `overflow-hidden` box — otherwise the list is clipped at the bottom
        // edge of the editor, which on a phone is most of the list.
        tooltips({ position: 'fixed' }),
        completionCompartment.current.of(completionExtension(completionSource)),
        themeCompartment.current.of(theme === 'dark' ? oneDark : []),
        cmPlaceholder(placeholder || ''),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newValue = update.state.doc.toString()
            externalValueRef.current = newValue
            onChangeRef.current(newValue)
          }
        }),
        EditorView.theme({
          // Fill the (bounded, resizable) wrapper; `.cm-scroller` is the single
          // internal scroller — see the wrapper's className below.
          '&': { fontSize: '13px', height: '100%' },
          '.cm-content': { fontFamily: 'ui-monospace, "JetBrains Mono", monospace' },
          '.cm-gutters': { borderRight: 'none' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-tooltip-autocomplete': {
            fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
            borderRadius: '0.5rem',
            boxShadow: '0 10px 30px -10px rgb(0 0 0 / 0.45)',
          },
          '.cm-tooltip-autocomplete > ul': { maxHeight: '16rem' },
          '.cm-tooltip-autocomplete > ul > li': {
            padding: '3px 8px',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
          },
          '.cm-completionLabel': { flex: '0 1 auto', minWidth: 0 },
          '.cm-completionDetail': {
            color: '#94a3b8',
            fontStyle: 'normal',
            marginLeft: 'auto',
            paddingLeft: '0.75rem',
            fontSize: '0.85em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flex: '0 1 auto',
          },
          // Touch: taller rows, a list that is allowed to be tall, and no info
          // panel — on a narrow viewport it lands on top of the options it is
          // supposed to explain.
          '@media (max-width: 767px)': {
            '.cm-tooltip-autocomplete': { maxWidth: 'calc(100vw - 1.5rem)' },
            '.cm-tooltip-autocomplete > ul': { maxHeight: '45vh' },
            '.cm-tooltip-autocomplete > ul > li': { padding: '9px 10px', lineHeight: '1.25' },
            '.cm-completionInfo': { display: 'none' },
          },
        }),
      ],
    })

    const view = new EditorView({
      state,
      parent: containerRef.current,
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        theme === 'dark' ? oneDark : [],
      ),
    })
  }, [theme])

  // Reconfigure the autocomplete source when the schema (re)loads so
  // column suggestions appear as soon as the schema fetch resolves.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: completionCompartment.current.reconfigure(completionExtension(completionSource)),
    })
  }, [completionSource])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (value !== externalValueRef.current) {
      externalValueRef.current = value
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: value,
        },
      })
    }
  }, [value])

  return (
    // The wrapper is the bounded, user-resizable box: `resize-y` puts a drag
    // grip at the bottom edge, `overflow-hidden` clips to its bounds (and is
    // what makes `resize` take effect), and min/default/max heights bound it.
    // `.cm-editor` fills it (`h-full`) and `.cm-scroller` scrolls internally, so
    // a query taller than the box scrolls instead of being clipped.
    <div
      ref={containerRef}
      className="resize-y overflow-hidden rounded-lg border border-border bg-card min-h-[160px] h-[220px] max-h-[70vh] md:h-[260px] [&_.cm-editor]:h-full"
    />
  )
}
