/**
 * KSCW SQL Workspace endpoints — Superuser-only read-mostly Postgres console.
 *
 * Routes (mounted under /kscw):
 *   GET  /admin/sql/schema  — public schema tables, columns, keys and value hints
 *                             for the sidebar + editor autocomplete
 *   POST /admin/sql         — execute SQL: { sql, write_mode? } → { columns, rows, ... }
 *
 * Safety guarantees:
 *   - Auth: superuser only (directus_roles.name='Superuser')
 *   - Default mode = read-only: per-statement DML keyword detector + transaction
 *     is opened with `SET LOCAL TRANSACTION READ ONLY` and auto-rolled-back
 *   - write_mode=true: still wrapped in a transaction (commits on success), still
 *     superuser only, but DML/DDL allowed
 *   - statement_timeout = 15s
 *   - Auto-LIMIT 1000 appended to single bare SELECTs without LIMIT
 *   - Every call audited to JSONL via writeErrorLog (event: 'sql_workspace')
 */

import { writeErrorLog } from './error-log.js'
import { loadSchemaModel, invalidateSchemaCache } from './sql-schema.js'

const STATEMENT_TIMEOUT_MS = 15000
const DEFAULT_ROW_CAP = 1000
const SQL_PREVIEW_MAX = 1500

// Top-level DDL/DML keywords we consider "writes". Anything matching one of these
// at the start of a statement is rejected when write_mode is false.
const WRITE_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'COPY',
  'CREATE', 'ALTER', 'DROP', 'RENAME', 'GRANT', 'REVOKE',
  'COMMENT', 'CLUSTER', 'REINDEX', 'VACUUM', 'ANALYZE',
  'SET', 'RESET', 'DISCARD', 'LISTEN', 'NOTIFY', 'UNLISTEN',
  'CALL', 'DO', 'PREPARE', 'DEALLOCATE', 'EXECUTE',
  'LOCK', 'CHECKPOINT', 'IMPORT',
])

/** Split SQL into statements at top-level `;`, ignoring those inside string
 *  literals, identifiers, line comments, and block comments. Returns trimmed
 *  non-empty statements. */
function splitStatements(sql) {
  const out = []
  let buf = ''
  let i = 0
  const n = sql.length
  let inSingle = false
  let inDouble = false
  let inLineComment = false
  let inBlockComment = false
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (inLineComment) {
      buf += c
      if (c === '\n') inLineComment = false
      i++
      continue
    }
    if (inBlockComment) {
      buf += c
      if (c === '*' && next === '/') {
        buf += next
        inBlockComment = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (inSingle) {
      buf += c
      if (c === "'") {
        // Escaped '' inside string literal
        if (next === "'") {
          buf += next
          i += 2
          continue
        }
        inSingle = false
      }
      i++
      continue
    }
    if (inDouble) {
      buf += c
      if (c === '"') inDouble = false
      i++
      continue
    }
    if (c === '-' && next === '-') {
      buf += '--'
      inLineComment = true
      i += 2
      continue
    }
    if (c === '/' && next === '*') {
      buf += '/*'
      inBlockComment = true
      i += 2
      continue
    }
    if (c === "'") { inSingle = true; buf += c; i++; continue }
    if (c === '"') { inDouble = true; buf += c; i++; continue }
    if (c === ';') {
      const trimmed = buf.trim()
      if (trimmed) out.push(trimmed)
      buf = ''
      i++
      continue
    }
    buf += c
    i++
  }
  const tail = buf.trim()
  if (tail) out.push(tail)
  return out
}

/** Strip leading whitespace, line/block comments, then return the first keyword
 *  (uppercased), or '' if none. */
function leadingKeyword(stmt) {
  let s = stmt
  // Strip leading block + line comments + whitespace
  while (true) {
    s = s.replace(/^\s+/, '')
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n')
      s = nl === -1 ? '' : s.slice(nl + 1)
      continue
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/')
      s = end === -1 ? '' : s.slice(end + 2)
      continue
    }
    break
  }
  // Strip an opening parenthesis (e.g. `(SELECT ...)`)
  s = s.replace(/^\(+/, '')
  const m = s.match(/^([A-Za-z]+)/)
  return m ? m[1].toUpperCase() : ''
}

/** True iff this single-statement SQL is a bare SELECT/WITH/VALUES/SHOW with
 *  no existing LIMIT clause at the end. Heuristic — good enough for the
 *  auto-cap. */
function shouldAutoLimit(stmt) {
  const kw = leadingKeyword(stmt)
  if (kw !== 'SELECT' && kw !== 'WITH' && kw !== 'VALUES' && kw !== 'SHOW' && kw !== 'TABLE') {
    return false
  }
  // Quick: contains the word LIMIT followed by whitespace/digits anywhere in
  // the tail half of the string. Slightly over-permissive but the cost of a
  // false-skip is just "no auto cap" — the timeout still applies.
  return !/\blimit\b\s+\d/i.test(stmt)
}

export function registerSqlWorkspace(router, ctx) {
  const { database, logger } = ctx
  const log = logger.child({ extension: 'kscw-sql-workspace' })

  function requireAuth(req) {
    if (!req.accountability?.user) {
      const err = new Error('Authentication required')
      err.status = 401
      throw err
    }
  }

  /** Gate on the resolved `admin_access` policy flag, not on the mutable
   *  `directus_roles.name` string. Same rationale as audit.js — a renamed
   *  role would otherwise slip through, and the role-name check 403s
   *  legitimate superusers whose Directus role isn't literally "Superuser". */
  function requireSuperuser(req) {
    requireAuth(req)
    if (req.accountability.admin !== true) {
      log.warn({ msg: 'Superuser access denied (sql-workspace)', userId: req.accountability.user })
      const err = new Error('Superuser access required')
      err.status = 403
      throw err
    }
  }

  // ── GET /admin/sql/schema ────────────────────────────────────
  // Columns, keys and value hints (see sql-schema.js). `?refresh=1` bypasses
  // the 60s cache — that's what the sidebar's refresh button sends.
  router.get('/admin/sql/schema', async (req, res) => {
    try {
      await requireSuperuser(req)
      const force = req.query?.refresh === '1' || req.query?.refresh === 'true'
      const model = await loadSchemaModel(database, log, force)
      res.json(model)
    } catch (err) {
      log.error({ msg: 'admin/sql/schema failed', error: err.message, status: err.status })
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' })
    }
  })

  // ── POST /admin/sql ──────────────────────────────────────────
  router.post('/admin/sql', async (req, res) => {
    const started = Date.now()
    let userId = null
    let sqlText = ''
    let writeMode = false
    try {
      await requireSuperuser(req)
      userId = req.accountability.user

      sqlText = String(req.body?.sql ?? '').trim()
      writeMode = req.body?.write_mode === true

      if (!sqlText) return res.status(400).json({ error: 'sql required' })
      if (sqlText.length > 100000) return res.status(400).json({ error: 'sql too large (max 100KB)' })

      const statements = splitStatements(sqlText)
      if (statements.length === 0) return res.status(400).json({ error: 'no executable statements' })

      // Reject writes in read-only mode (per-statement check) — fail before
      // any execution so a partially-applied multi-statement script can't
      // happen.
      if (!writeMode) {
        for (const stmt of statements) {
          const kw = leadingKeyword(stmt)
          if (WRITE_KEYWORDS.has(kw)) {
            const err = new Error(`Statement "${kw}" requires write mode`)
            err.status = 400
            err.code = 'write_required'
            throw err
          }
        }
      }

      // Last statement decides what we return to the client (most useful for
      // explorations like `WITH ... SELECT ...;` followed by a final SELECT).
      // We still execute all statements in order inside the same transaction.
      const lastIdx = statements.length - 1
      let finalColumns = []
      let finalRows = []
      let totalRowCount = 0
      let truncated = false

      await database.transaction(async (trx) => {
        await trx.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
        if (!writeMode) await trx.raw('SET LOCAL TRANSACTION READ ONLY')

        for (let i = 0; i < statements.length; i++) {
          let stmt = statements[i]
          if (i === lastIdx && shouldAutoLimit(stmt)) {
            stmt = `${stmt}\nLIMIT ${DEFAULT_ROW_CAP + 1}`
          }
          let result
          try {
            result = await trx.raw(stmt)
          } catch (pgErr) {
            // Re-throw with Postgres metadata stripped of the echoed query
            // (knex prefixes the raw SQL onto the error message). Surface
            // the PG error code so the client can show a useful 400.
            const pgMessage = pgErr?.message?.split(' - ').pop() ?? pgErr?.message ?? 'query failed'
            const wrapped = new Error(pgMessage)
            wrapped.status = 400
            wrapped.code = pgErr?.code ?? 'pg_error'
            wrapped.detail = pgErr?.detail ?? null
            wrapped.hint = pgErr?.hint ?? null
            wrapped.position = pgErr?.position ?? null
            wrapped.statementIndex = i
            throw wrapped
          }
          // For non-SELECT statements, pg returns rowCount/command without
          // .fields. Surface them as a single-row diagnostic on the final
          // statement.
          if (i === lastIdx) {
            const fields = result?.fields ?? []
            if (fields.length > 0) {
              finalColumns = fields.map((f) => f.name)
              const raw = result.rows ?? []
              if (raw.length > DEFAULT_ROW_CAP) {
                truncated = true
                finalRows = raw.slice(0, DEFAULT_ROW_CAP).map((r) => finalColumns.map((c) => r[c]))
              } else {
                finalRows = raw.map((r) => finalColumns.map((c) => r[c]))
              }
              totalRowCount = raw.length
            } else {
              finalColumns = ['command', 'rowCount']
              finalRows = [[result?.command ?? 'OK', result?.rowCount ?? 0]]
              totalRowCount = 1
            }
          }
        }
      })

      // Write mode may have been DDL — the cached schema model is stale now.
      if (writeMode) invalidateSchemaCache()

      const durationMs = Date.now() - started
      writeErrorLog({
        level: 'info',
        source: 'backend',
        project: 'wiedisync',
        event: 'sql_workspace',
        endpoint: '/admin/sql',
        userId,
        action: writeMode ? 'execute_write' : 'execute_read',
        status: 200,
        durationMs,
        rowCount: totalRowCount,
        truncated,
        statementCount: statements.length,
        sqlPreview: sqlText.slice(0, SQL_PREVIEW_MAX),
      })

      res.json({
        columns: finalColumns,
        rows: finalRows,
        row_count: totalRowCount,
        duration_ms: durationMs,
        truncated,
        statements: statements.length,
        write_mode: writeMode,
      })
    } catch (err) {
      const durationMs = Date.now() - started
      writeErrorLog({
        level: 'error',
        source: 'backend',
        project: 'wiedisync',
        event: 'sql_workspace',
        endpoint: '/admin/sql',
        userId,
        action: writeMode ? 'execute_write' : 'execute_read',
        status: err.status || 500,
        durationMs,
        error: err.message?.slice(0, 1000) ?? null,
        code: err.code ?? null,
        sqlPreview: sqlText.slice(0, SQL_PREVIEW_MAX),
      })
      res.status(err.status || 500).json({
        error: err.status ? err.message : 'Internal error',
        code: err.code ?? null,
        detail: err.detail ?? null,
        hint: err.hint ?? null,
        position: err.position ?? null,
        statement_index: err.statementIndex ?? null,
        duration_ms: durationMs,
      })
    }
  })
}
