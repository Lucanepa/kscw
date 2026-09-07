/**
 * KSCW SQL Workspace — shared schema model.
 *
 * One loader for both consumers of the public schema:
 *   - GET /admin/sql/schema  (sidebar + editor autocomplete)
 *   - POST /admin/sql/ask    (the cached system block handed to Claude)
 *
 * Beyond the plain column list it resolves two things the console used to be
 * blind to:
 *   - **keys** — primary keys and foreign-key targets, so the editor can offer
 *     a join and the model stops guessing at `mt.team = t.id`.
 *   - **value hints** — the actual strings a low-cardinality text column holds
 *     (`sport` is `volleyball` / `basketball`, never `vb`). Enum columns are
 *     read exactly from `pg_enum`; plain text columns are sampled from
 *     `pg_stats.most_common_vals`, i.e. from the planner's existing statistics,
 *     so this costs no table scan.
 *
 * Everything except the column list is best-effort: a failing catalog query
 * degrades the response, it never fails it.
 */

const VALUE_HINT_MAX = 40
/** Sample values only for columns with at most this many distinct values —
 *  above that a hint list is noise, not help. `n_distinct` is an absolute
 *  count when positive, a negative ratio when Postgres thinks it scales with
 *  the row count (which is exactly the high-cardinality case we skip). */
const VALUE_HINT_MAX_DISTINCT = 40
const CACHE_TTL_MS = 60_000

let cache = null // { at: number, model: SchemaModel }

/** Base columns of every public BASE TABLE, in ordinal order. */
async function loadColumns(database) {
  const result = await database.raw(`
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.ordinal_position
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position
  `)
  const byTable = new Map()
  for (const r of result.rows) {
    let entry = byTable.get(r.table_name)
    if (!entry) { entry = { name: r.table_name, columns: [] }; byTable.set(r.table_name, entry) }
    entry.columns.push({
      name: r.column_name,
      data_type: r.data_type,
      udt_name: r.udt_name,
      nullable: r.is_nullable === 'YES',
    })
  }
  return byTable
}

/** `table.column` → { pk?: true, ref?: 'other_table.other_column' }. */
async function loadKeys(database, log) {
  const keys = new Map()
  try {
    // Read from pg_constraint rather than information_schema: the latter's
    // key_column_usage x constraint_column_usage join has no ordinal, so a
    // composite foreign key comes back as a cross product of its columns and
    // every column it points at. Pairing on WITH ORDINALITY keeps
    // `(a, b) REFERENCES t(x, y)` as a→x and b→y.
    const result = await database.raw(`
      SELECT con.contype,
             cl.relname   AS table_name,
             att.attname  AS column_name,
             fcl.relname  AS foreign_table,
             fatt.attname AS foreign_column
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
      JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
      LEFT JOIN pg_class fcl ON fcl.oid = con.confrelid
      LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
      LEFT JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = fk.attnum
      WHERE con.contype IN ('p', 'f')
    `)
    for (const r of result.rows) {
      const key = `${r.table_name}.${r.column_name}`
      let entry = keys.get(key)
      if (!entry) { entry = {}; keys.set(key, entry) }
      if (r.contype === 'p') entry.pk = true
      else if (r.foreign_table) entry.ref = `${r.foreign_table}.${r.foreign_column}`
    }
  } catch (err) {
    log?.warn({ msg: 'sql schema: key introspection failed', error: err.message })
  }
  return keys
}

/** `table.column` → string[] of the values that column actually holds. */
async function loadValueHints(database, log) {
  const values = new Map()

  // 1. Enum-typed columns — exact and complete, straight from the catalog.
  try {
    const enums = await database.raw(`
      SELECT c.table_name, c.column_name, e.enumlabel
      FROM information_schema.columns c
      JOIN pg_type pt ON pt.typname = c.udt_name
      JOIN pg_namespace pn ON pn.oid = pt.typnamespace AND pn.nspname = 'public'
      JOIN pg_enum e ON e.enumtypid = pt.oid
      WHERE c.table_schema = 'public'
      ORDER BY c.table_name, c.column_name, e.enumsortorder
    `)
    for (const r of enums.rows) {
      const key = `${r.table_name}.${r.column_name}`
      const list = values.get(key) ?? []
      if (list.length < VALUE_HINT_MAX) list.push(r.enumlabel)
      values.set(key, list)
    }
  } catch (err) {
    log?.warn({ msg: 'sql schema: enum introspection failed', error: err.message })
  }

  // 2. Plain text columns — sampled from the planner statistics. `anyarray`
  //    has no direct JS mapping, hence the `::text::text[]` round-trip.
  try {
    const stats = await database.raw(`
      SELECT s.tablename, s.attname, s.most_common_vals::text::text[] AS vals
      FROM pg_stats s
      JOIN information_schema.columns c
        ON c.table_schema = s.schemaname
       AND c.table_name = s.tablename
       AND c.column_name = s.attname
      WHERE s.schemaname = 'public'
        AND s.most_common_vals IS NOT NULL
        AND s.n_distinct > 0
        AND s.n_distinct <= ${VALUE_HINT_MAX_DISTINCT}
        AND c.data_type IN ('character varying', 'text', 'character')
    `)
    for (const r of stats.rows) {
      const key = `${r.tablename}.${r.attname}`
      if (values.has(key)) continue // an enum list is authoritative — keep it
      const list = (r.vals ?? [])
        .filter((v) => typeof v === 'string' && v !== '' && v.length <= 60)
        .slice(0, VALUE_HINT_MAX)
        .sort((a, b) => a.localeCompare(b))
      if (list.length > 0) values.set(key, list)
    }
  } catch (err) {
    log?.warn({ msg: 'sql schema: value sampling failed', error: err.message })
  }

  return values
}

/**
 * Load the full schema model. Cached for {@link CACHE_TTL_MS} — the console
 * fetches it on every mount and every /ask call rebuilds the prompt from it.
 * @param {boolean} [force] bypass the cache (the sidebar's refresh button)
 */
export async function loadSchemaModel(database, log, force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.model

  const byTable = await loadColumns(database)
  const [keys, values] = await Promise.all([
    loadKeys(database, log),
    loadValueHints(database, log),
  ])

  const tables = []
  for (const entry of byTable.values()) {
    tables.push({
      name: entry.name,
      columns: entry.columns.map((c) => {
        const key = `${entry.name}.${c.name}`
        const k = keys.get(key)
        const v = values.get(key)
        return {
          name: c.name,
          data_type: c.data_type,
          nullable: c.nullable,
          ...(k?.pk ? { pk: true } : {}),
          ...(k?.ref ? { ref: k.ref } : {}),
          ...(v && v.length ? { values: v } : {}),
        }
      }),
    })
  }

  const model = { tables, generated_at: new Date().toISOString() }
  cache = { at: Date.now(), model }
  return model
}

/** Drop the cached model (called after a write-mode statement, which may have
 *  been DDL). */
export function invalidateSchemaCache() {
  cache = null
}

/**
 * Compact text rendering for the model's cached system block. One line per
 * table; PK marked `*`, FK rendered `→table.column`, value hints inlined so
 * the model writes `'volleyball'` and never invents `'vb'`.
 */
export function formatSchemaForPrompt(model) {
  const lines = []
  for (const t of model.tables) {
    const cols = t.columns.map((c) => {
      let s = `${c.name} ${c.data_type}${c.nullable ? '?' : ''}`
      if (c.pk) s += ' *'
      if (c.ref) s += ` →${c.ref}`
      if (c.values) s += ` in{${c.values.map((v) => `'${v}'`).join(',')}}`
      return s
    })
    lines.push(`${t.name}(${cols.join(', ')})`)
  }
  return lines.join('\n')
}
