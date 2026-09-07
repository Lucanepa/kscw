// src/modules/admin/utils/sqlSchema.ts
//
// Schema-shaped helpers shared by the SQL workspace editor (autocomplete) and
// the page (the "did you mean…" error panel). Deliberately dependency-free and
// pure so both can call them on every keystroke / every failed query.

export interface SqlSchemaColumn {
  name: string
  /** Postgres type, surfaced in the completion popup's detail line. */
  dataType?: string
  /** Values this column actually holds, when it is low-cardinality (an enum,
   *  or sampled from the planner statistics). Drives value autocomplete. */
  values?: readonly string[]
  /** Part of the table's primary key. */
  pk?: boolean
  /** Foreign-key target, `table.column`. */
  ref?: string
}

export interface SqlSchemaTable {
  name: string
  columns: readonly SqlSchemaColumn[]
}

/** A table brought into scope by a FROM/JOIN/UPDATE/INTO clause. */
export interface TableRef {
  /** How the query refers to it — the alias if there is one, else the name. */
  alias: string
  table: string
}

/** Words that can follow a table name but are never an alias. */
const NOT_AN_ALIAS = new Set([
  'ON', 'USING', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'HAVING', 'SET',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'LATERAL', 'NATURAL',
  'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING', 'VALUES', 'SELECT', 'FROM', 'AS',
  'WITH', 'WINDOW', 'FETCH', 'FOR', 'AND', 'OR', 'NOT', 'IS', 'IN',
])

const TABLE_CLAUSE_RE =
  /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:ONLY\s+)?("?[A-Za-z_][\w$]*"?)(?:\s+(?:AS\s+)?("?[A-Za-z_][\w$]*"?))?/gi

const unquote = (s: string) => s.replace(/^"|"$/g, '')

/**
 * Collect every table the query has brought into scope, with its alias.
 * `FROM member_teams mt JOIN teams t` -> `[{alias:'mt',table:'member_teams'}, …]`.
 * Names that are not in the schema are dropped: an alias resolving to nothing
 * is worse than no alias, because it would scope suggestions to a table that
 * does not exist.
 */
export function parseQueryScope(sql: string, tables: readonly SqlSchemaTable[]): TableRef[] {
  const known = new Map(tables.map((t) => [t.name.toLowerCase(), t.name]))
  const out: TableRef[] = []
  const seen = new Set<string>()
  TABLE_CLAUSE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TABLE_CLAUSE_RE.exec(sql)) !== null) {
    const table = known.get(unquote(m[1]).toLowerCase())
    if (!table) continue
    const rawAlias = m[2] ? unquote(m[2]) : ''
    const alias = rawAlias && !NOT_AN_ALIAS.has(rawAlias.toUpperCase()) ? rawAlias : table
    const key = `${alias} ${table}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ alias, table })
  }
  return out
}

/** `member_teams` -> `mt`, `sv_vm_check` -> `svc` — the abbreviation people
 *  actually type as an alias. */
function initials(name: string): string {
  return name.split('_').filter(Boolean).map((p) => p[0]).join('')
}

/**
 * Resolve whatever the user typed before a dot to a real table.
 *
 * In order: an alias the query declared, an exact table name, the snake_case
 * initials of a table name (`mt` -> `member_teams`), then a unique prefix
 * (`memb` -> `members`). Returns null rather than guessing between two equally
 * good candidates — a wrong table is exactly what produces the "column does
 * not exist" errors this is meant to prevent.
 */
export function resolveTableRef(
  ref: string,
  tables: readonly SqlSchemaTable[],
  scope: readonly TableRef[] = [],
): SqlSchemaTable | null {
  const needle = unquote(ref).toLowerCase()
  if (!needle) return null

  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]))

  const scoped = scope.find((s) => s.alias.toLowerCase() === needle)
  if (scoped) return byName.get(scoped.table.toLowerCase()) ?? null

  const exact = byName.get(needle)
  if (exact) return exact

  const byInitials = tables.filter((t) => initials(t.name).toLowerCase() === needle)
  if (byInitials.length === 1) return byInitials[0]

  const byPrefix = tables.filter((t) => t.name.toLowerCase().startsWith(needle))
  if (byPrefix.length === 1) return byPrefix[0]

  return null
}

/** Levenshtein distance, capped: anything past `max` stops early and returns
 *  `max + 1` instead of finishing the matrix. */
function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      row[j] = v
      if (v < best) best = v
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length]
}

/**
 * Rank `candidates` by closeness to `name` — for "did you mean…". Scores on
 * edit distance, and treats a candidate that contains the typed name (or vice
 * versa) as a near miss, which is what catches `member_team` -> `member_teams`
 * and `guest_lvl` -> `guest_level`.
 */
export function suggestSimilar(
  name: string,
  candidates: readonly string[],
  limit = 3,
): string[] {
  const needle = name.toLowerCase()
  if (!needle) return []
  const max = needle.length <= 4 ? 2 : needle.length <= 8 ? 3 : 4
  const scored: { c: string; d: number }[] = []
  for (const c of candidates) {
    const lc = c.toLowerCase()
    if (lc === needle) continue
    let d = editDistance(needle, lc, max)
    if (d > max && (lc.includes(needle) || needle.includes(lc))) {
      // Containment is a strong signal even when the length gap blows the cap.
      d = max + Math.abs(lc.length - needle.length) / 100
    }
    // `max + 1` is the early-exit sentinel from editDistance, i.e. "too far" —
    // keeping it would let every candidate through and turn "did you mean" into
    // a list of the schema.
    if (d < max + 1) scored.push({ c, d })
  }
  scored.sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
  return scored.slice(0, limit).map((s) => s.c)
}

export interface MissingIdentifier {
  kind: 'column' | 'table'
  /** The identifier Postgres could not resolve, e.g. `guest_lvl`. */
  name: string
  /** The qualifier it was written with, e.g. `mt` in `mt.guest_lvl`. */
  qualifier?: string
}

/** Pull the unresolved identifier out of a Postgres error message. */
export function parseMissingIdentifier(message: string): MissingIdentifier | null {
  if (!message) return null

  // `column x of relation y does not exist` names the column first — check it
  // before the generic column pattern, whose groups run the other way round.
  const ofRelation = message.match(
    /column\s+"?([\w$]+)"?\s+of relation\s+"?([\w$]+)"?\s+does not exist/i,
  )
  if (ofRelation) return { kind: 'column', name: ofRelation[1], qualifier: ofRelation[2] }

  const column = message.match(/column\s+"?(?:([\w$]+)\.)?([\w$]+)"?\s+does not exist/i)
  if (column) return { kind: 'column', name: column[2], qualifier: column[1] || undefined }

  const relation = message.match(/relation\s+"?(?:([\w$]+)\.)?([\w$]+)"?\s+does not exist/i)
  if (relation) return { kind: 'table', name: relation[2], qualifier: relation[1] || undefined }

  const fromClause = message.match(/missing FROM-clause entry for table\s+"?([\w$]+)"?/i)
  if (fromClause) return { kind: 'table', name: fromClause[1] }

  return null
}

export interface DidYouMean {
  missing: MissingIdentifier
  /** Ranked replacements, already qualified the way the user wrote them. */
  suggestions: string[]
}

/**
 * Turn a failed query plus its Postgres error into concrete replacements.
 * Column lookups are scoped to the tables the query actually joined (or to the
 * qualifier's table when it wrote one), so `mt.guest_lvl` proposes
 * `mt.guest_level` and not the same-named column of six unrelated tables.
 */
export function didYouMean(
  errorMessage: string,
  sql: string,
  tables: readonly SqlSchemaTable[],
): DidYouMean | null {
  const missing = parseMissingIdentifier(errorMessage)
  if (!missing) return null

  if (missing.kind === 'table') {
    const suggestions = suggestSimilar(missing.name, tables.map((t) => t.name))
    return suggestions.length ? { missing, suggestions } : null
  }

  const scope = parseQueryScope(sql, tables)
  const qualifierTable = missing.qualifier
    ? resolveTableRef(missing.qualifier, tables, scope)
    : null

  // Candidate columns: the qualifier's table when we can resolve one, else
  // every table the query brought into scope, else the whole schema.
  const pool: { column: string; alias: string }[] = []
  if (qualifierTable) {
    const alias = missing.qualifier as string
    for (const c of qualifierTable.columns) pool.push({ column: c.name, alias })
  } else if (scope.length) {
    for (const s of scope) {
      const t = tables.find((tb) => tb.name === s.table)
      if (!t) continue
      for (const c of t.columns) pool.push({ column: c.name, alias: s.alias })
    }
  } else {
    for (const t of tables) {
      for (const c of t.columns) pool.push({ column: c.name, alias: t.name })
    }
  }

  const unique = Array.from(new Set(pool.map((p) => p.column)))
  const suggestions: string[] = []
  for (const col of suggestSimilar(missing.name, unique)) {
    for (const p of pool) {
      if (p.column !== col) continue
      const qualify = Boolean(missing.qualifier) || scope.length > 1
      const label = qualify ? `${p.alias}.${col}` : col
      if (!suggestions.includes(label)) suggestions.push(label)
    }
  }
  return suggestions.length ? { missing, suggestions: suggestions.slice(0, 4) } : null
}
