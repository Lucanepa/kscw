// src/modules/admin/SqlWorkspacePage.tsx
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Play, AlertTriangle, History, Database, RefreshCw, X, FileDown,
  FileSpreadsheet, ClipboardCopy, Check, Sparkles, Wand2, Table2, ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { API_URL } from '@/lib/api'
import CodeMirrorEditor from './components/CodeMirrorEditor'
import ResultsTable from './components/ResultsTable'
import { didYouMean, shortType, type DidYouMean, type SqlSchemaTable } from './utils/sqlSchema'
import { toCSV, toXlsx, copyAsTable, downloadBlob, downloadText } from './utils/exportResults'

interface SchemaColumn {
  name: string
  data_type: string
  nullable: boolean
  /** Primary key member. */
  pk?: boolean
  /** Foreign-key target, `table.column`. */
  ref?: string
  /** The values this column actually holds, when it is low-cardinality. */
  values?: string[]
}
interface SchemaTable {
  name: string
  columns: SchemaColumn[]
}
interface ApiSchemaResponse {
  tables: SchemaTable[]
}
interface ApiQueryResponse {
  columns: string[]
  rows: unknown[][]
  row_count: number
  duration_ms: number
  truncated: boolean
  statements: number
  write_mode: boolean
}
interface ApiErrorResponse {
  error: string
  code?: string | null
  detail?: string | null
  hint?: string | null
  position?: string | null
  statement_index?: number | null
  duration_ms?: number
}

interface RecentQuery {
  sql: string
  ts: number
}

/** One natural-language question and the SQL the model produced for it. Kept
 *  so a follow-up ("now only H1") has something to refine, and so the model
 *  stops re-deriving conventions it already got right once. */
interface AiTurn {
  prompt: string
  sql: string
  ts: number
}

const RECENT_KEY = 'kscw-sql-workspace-recent'
const DRAFT_KEY = 'kscw-sql-workspace-draft'
const AI_MEMORY_KEY = 'kscw-sql-workspace-ai-memory'
const MAX_RECENT = 20
const MAX_AI_MEMORY = 6

function loadRecent(): RecentQuery[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

function saveRecent(list: RecentQuery[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))) } catch { /* quota */ }
}

function loadAiMemory(): AiTurn[] {
  try {
    const raw = localStorage.getItem(AI_MEMORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(-MAX_AI_MEMORY) : []
  } catch {
    return []
  }
}

function saveAiMemory(list: AiTurn[]) {
  try { localStorage.setItem(AI_MEMORY_KEY, JSON.stringify(list.slice(-MAX_AI_MEMORY))) } catch { /* quota */ }
}

async function fetchSchema(force = false): Promise<SchemaTable[]> {
  const resp = await fetch(`${API_URL}/kscw/admin/sql/schema${force ? '?refresh=1' : ''}`, {
    credentials: 'include',
  })
  if (!resp.ok) throw new Error(`schema fetch failed: ${resp.status}`)
  const data: ApiSchemaResponse = await resp.json()
  return data.tables
}

async function runQuery(sql: string, writeMode: boolean): Promise<ApiQueryResponse> {
  const resp = await fetch(`${API_URL}/kscw/admin/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ sql, write_mode: writeMode }),
  })
  const body = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const errBody = body as ApiErrorResponse
    const err = new Error(errBody?.error ?? `query failed: ${resp.status}`) as Error & {
      code?: string | null
      detail?: string | null
      hint?: string | null
      position?: string | null
    }
    err.code = errBody?.code ?? null
    err.detail = errBody?.detail ?? null
    err.hint = errBody?.hint ?? null
    err.position = errBody?.position ?? null
    throw err
  }
  return body as ApiQueryResponse
}

interface AskAiResponse {
  sql: string
  model: string
  duration_ms: number
  tokens_in: number | null
  tokens_cached: number | null
  tokens_out: number | null
}

async function askAi(prompt: string, history: AiTurn[]): Promise<AskAiResponse> {
  const resp = await fetch(`${API_URL}/kscw/admin/sql/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      prompt,
      history: history.map((h) => ({ prompt: h.prompt, sql: h.sql })),
    }),
  })
  const body = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const err = new Error((body as ApiErrorResponse)?.error ?? `AI request failed: ${resp.status}`)
    ;(err as Error & { code?: string | null }).code = (body as ApiErrorResponse)?.code ?? null
    throw err
  }
  return body as AskAiResponse
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Swap a mistyped identifier for the suggested one. Qualified references are
 *  replaced whole (`mt.guest_lvl` → `mt.guest_level`) so the alias survives. */
function applyIdentifierFix(sql: string, fix: DidYouMean, suggestion: string): string {
  const { name, qualifier } = fix.missing
  const pattern = qualifier
    ? new RegExp(`\\b${escapeRe(qualifier)}\\s*\\.\\s*${escapeRe(name)}\\b`, 'i')
    : new RegExp(`\\b${escapeRe(name)}\\b`, 'i')
  return sql.replace(pattern, suggestion)
}

export default function SqlWorkspacePage() {
  const { t } = useTranslation('admin')

  const [sql, setSql] = useState<string>(() => {
    try { return localStorage.getItem(DRAFT_KEY) ?? '' } catch { return '' }
  })
  const [writeMode, setWriteMode] = useState(false)
  const [tables, setTables] = useState<SchemaTable[]>([])
  // Starts true: the schema is fetched on mount (see the effect below), so the
  // sidebar is loading from the first paint — the flag used to be flipped by
  // loadSchema() itself, one render later.
  const [schemaLoading, setSchemaLoading] = useState(true)
  const [tableFilter, setTableFilter] = useState('')
  const [expandedTable, setExpandedTable] = useState<string | null>(null)
  const [schemaSheetOpen, setSchemaSheetOpen] = useState(false)

  const [result, setResult] = useState<ApiQueryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [errorHint, setErrorHint] = useState<string | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  /** The SQL the failed run used — `didYouMean` scopes its candidates to the
   *  tables that query joined, so it must not drift with later edits. */
  const [errorSql, setErrorSql] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [recent, setRecent] = useState<RecentQuery[]>(() => loadRecent())
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | 'table' | null>(null)

  // ── AI assistant ──
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiMemory, setAiMemory] = useState<AiTurn[]>(() => loadAiMemory())

  // Persist draft to localStorage (debounced)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, sql) } catch { /* quota */ }
    }, 400)
    return () => { if (draftTimer.current) clearTimeout(draftTimer.current) }
  }, [sql])

  // The fetch itself, without the `schemaLoading = true` flip — `schemaLoading`
  // already starts true, so the on-mount call below needs no flip; only the
  // manual refresh button does.
  const loadSchemaInto = useCallback(async (force = false) => {
    try { setTables(await fetchSchema(force)) } catch (e) { console.warn('[sql-workspace] schema:', e) }
    finally { setSchemaLoading(false) }
  }, [])

  const loadSchema = useCallback(async () => {
    setSchemaLoading(true)
    await loadSchemaInto(true)
  }, [loadSchemaInto])

  useEffect(() => { void (async () => { await loadSchemaInto() })() }, [loadSchemaInto])

  // Map → SqlSchemaTable for autocomplete (columns, keys, value hints)
  const editorTables = useMemo<SqlSchemaTable[]>(
    () =>
      tables.map((tb) => ({
        name: tb.name,
        columns: tb.columns.map((c) => ({
          name: c.name,
          dataType: c.data_type,
          values: c.values,
          pk: c.pk,
          ref: c.ref,
        })),
      })),
    [tables],
  )

  /** "Did you mean…" for the identifier Postgres could not resolve. */
  const fix = useMemo<DidYouMean | null>(
    () => (error ? didYouMean(error, errorSql, editorTables) : null),
    [error, errorSql, editorTables],
  )

  const filteredTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase()
    if (!q) return tables
    return tables.filter((tb) =>
      tb.name.toLowerCase().includes(q) ||
      tb.columns.some((c) => c.name.toLowerCase().includes(q)),
    )
  }, [tables, tableFilter])

  const execute = useCallback(async () => {
    const text = sql.trim()
    if (!text || loading) return
    setLoading(true)
    setError(null)
    setErrorCode(null)
    setErrorHint(null)
    setErrorDetail(null)
    try {
      const r = await runQuery(text, writeMode)
      setResult(r)
      const next = [{ sql: text, ts: Date.now() }, ...recent.filter((q) => q.sql !== text)]
      setRecent(next)
      saveRecent(next)
      // A write may have been DDL — pick up the new shape for autocomplete.
      if (writeMode) void loadSchemaInto(true)
    } catch (e) {
      const ex = e as Error & { code?: string | null; hint?: string | null; detail?: string | null }
      setError(ex.message)
      setErrorCode(ex.code ?? null)
      setErrorHint(ex.hint ?? null)
      setErrorDetail(ex.detail ?? null)
      setErrorSql(text)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }, [sql, writeMode, loading, recent, loadSchemaInto])

  const insertTableRef = useCallback((name: string) => {
    setSql((cur) => (cur.trim() ? cur : `SELECT * FROM ${name} LIMIT 100;`))
    setSchemaSheetOpen(false)
  }, [])

  const applyFix = useCallback((suggestion: string) => {
    if (!fix) return
    setSql((cur) => applyIdentifierFix(cur, fix, suggestion))
    setError(null)
    setErrorCode(null)
    setErrorHint(null)
    setErrorDetail(null)
  }, [fix])

  const clearRecent = useCallback(() => { setRecent([]); saveRecent([]) }, [])

  const clearAiMemory = useCallback(() => { setAiMemory([]); saveAiMemory([]) }, [])

  const exportFilename = useCallback((ext: string) => {
    const ts = new Date()
      .toISOString()
      .replace(/[:T]/g, '-')
      .replace(/\..+$/, '')
    return `kscw-sql-${ts}.${ext}`
  }, [])

  const handleExportCsv = useCallback(() => {
    if (!result) return
    setExporting('csv')
    try {
      const text = toCSV(result.columns, result.rows)
      downloadText(text, exportFilename('csv'), 'text/csv;charset=utf-8')
    } finally {
      setExporting(null)
    }
  }, [result, exportFilename])

  const handleExportXlsx = useCallback(async () => {
    if (!result) return
    setExporting('xlsx')
    try {
      const blob = await toXlsx(result.columns, result.rows)
      downloadBlob(blob, exportFilename('xlsx'))
    } catch (e) {
      // Was silently swallowed before — surface it so a failed export isn't a
      // dead button. exceljs is lazy-loaded, so a stale chunk after a deploy
      // can also land here.
      console.error('[sql-workspace] xlsx export failed:', e)
      toast.error(t('sqlWorkspaceExportFailed'))
    } finally {
      setExporting(null)
    }
  }, [result, exportFilename, t])

  const handleAskAi = useCallback(async () => {
    const text = aiPrompt.trim()
    if (!text || aiLoading) return
    setAiLoading(true)
    setAiError(null)
    try {
      const r = await askAi(text, aiMemory)
      setSql(r.sql)
      const next = [...aiMemory, { prompt: text, sql: r.sql, ts: Date.now() }].slice(-MAX_AI_MEMORY)
      setAiMemory(next)
      saveAiMemory(next)
      setAiPrompt('')
      setAiOpen(false)
    } catch (e) {
      setAiError((e as Error).message)
    } finally {
      setAiLoading(false)
    }
  }, [aiPrompt, aiLoading, aiMemory])

  const handleCopyTable = useCallback(async () => {
    if (!result) return
    setExporting('table')
    try {
      await copyAsTable(result.columns, result.rows)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch (e) {
      console.warn('[sql-workspace] copy failed:', e)
    } finally {
      setExporting(null)
    }
  }, [result])

  // ── Schema browser, shared by the md+ sidebar and the mobile sheet ──
  // A table per row, its columns as indented rows underneath — a data list, so
  // it renders as a <Table> like every other record list in the app.
  const schemaBrowser = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex items-center gap-1.5">
        <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-semibold text-foreground">{t('sqlWorkspaceSchema')}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{tables.length}</span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void loadSchema()}
          title={t('sqlWorkspaceRefreshSchema')}
          aria-label={t('sqlWorkspaceRefreshSchema')}
          className="h-8 w-8"
        >
          <RefreshCw className={schemaLoading ? 'animate-spin motion-reduce:animate-none' : ''} />
        </Button>
      </div>
      <Input
        type="text"
        value={tableFilter}
        onChange={(e) => setTableFilter(e.target.value)}
        placeholder={t('sqlWorkspaceFilterTables')}
        className="mb-2 h-9 text-xs"
      />
      {/* `table-fixed` + the neutralised inner wrapper is what keeps this
          honest: long identifiers (`svrz_spielplaner_contacts`) otherwise widen
          the table past the pane, and everything right-aligned — the column
          count, the type, the SELECT button — scrolls out of sight. */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card [&>div]:overflow-visible">
        <Table className="table-fixed">
          <TableBody>
            {filteredTables.map((tb) => {
              const open = expandedTable === tb.name
              return (
                <Fragment key={tb.name}>
                  <TableRow>
                    <TableCell className="p-0">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setExpandedTable(open ? null : tb.name)}
                        className="flex min-h-11 w-full items-center gap-1.5 px-2 text-left sm:min-h-9"
                        title={tb.name}
                      >
                        <ChevronRight
                          className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{tb.name}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                          {tb.columns.length}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell className="w-16 p-0 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => insertTableRef(tb.name)}
                        title={t('sqlWorkspaceInsertSelect')}
                        className="min-h-11 font-mono text-[10px] text-primary sm:min-h-9"
                      >
                        SELECT
                      </Button>
                    </TableCell>
                  </TableRow>
                  {open &&
                    tb.columns.map((c) => (
                      <TableRow key={c.name} className="bg-muted/30">
                        <TableCell colSpan={2} className="py-1 pl-6 pr-2 text-[11px]">
                          <div className="flex items-baseline gap-1.5">
                            <span className="min-w-0 flex-1 truncate font-mono text-foreground">{c.name}</span>
                            {c.pk && (
                              <span className="shrink-0 text-[9px] font-semibold uppercase text-primary">pk</span>
                            )}
                            <span className="shrink-0 text-right text-muted-foreground">
                              {shortType(c.data_type)}{c.nullable ? '?' : ''}
                            </span>
                          </div>
                          {c.ref && (
                            <div className="font-mono text-[10px] text-primary/80">&rarr; {c.ref}</div>
                          )}
                          {c.values && c.values.length > 0 && (
                            <div
                              className="truncate font-mono text-[10px] text-emerald-600 dark:text-emerald-400"
                              title={c.values.join(', ')}
                            >
                              {c.values.join(' \u00b7 ')}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                </Fragment>
              )
            })}
            {!schemaLoading && filteredTables.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={2} className="px-2 py-3 text-xs text-muted-foreground">
                  {t('sqlWorkspaceNoTables')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )

  return (
    // Mobile: natural height, the whole page scrolls in Layout's <main> (one
    // scroll context — a fixed height + nested scroller traps touch gestures).
    // md+: fixed workspace height with internally scrolling panes.
    <div className="flex flex-col bg-background text-foreground md:h-[calc(100vh-4rem)]">
      {/* Sticky on a phone so Run and the write-mode switch stay reachable while
          the results scroll. The negative margins cancel Layout's `main` padding
          so the bar bleeds edge to edge instead of letting content slide through
          the 16px gutters beside it. */}
      <header className="sticky top-0 z-20 -mx-4 -mt-4 border-b border-border bg-card sm:-mx-6 sm:-mt-6 md:static md:mx-0 md:mt-0">
        {/* Identity row — on md+ it shares one line with the toolbar */}
        <div className="flex items-center gap-2 px-3 pt-2 md:hidden">
          <h1 className="text-sm font-bold text-primary">{t('sqlWorkspaceTitle')}</h1>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">PG 15.8</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSchemaSheetOpen(true)}
            className="ml-auto min-h-9"
          >
            <Table2 />
            {t('sqlWorkspaceTables', { count: tables.length })}
          </Button>
        </div>

        {/* Toolbar: the three controls get equal thirds on a phone, and sit
            right-aligned next to the title from md up. */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2 px-3 py-2 md:flex md:items-center md:px-4">
          <h1 className="hidden text-sm font-bold text-primary md:block">{t('sqlWorkspaceTitle')}</h1>
          <span
            className="hidden rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground md:inline"
            title={t('sqlWorkspaceDialectHint')}
          >
            PostgreSQL 15.8
          </span>
          <div className="hidden flex-1 md:block" />

          <Popover open={aiOpen} onOpenChange={setAiOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                title={t('sqlWorkspaceAskAiHint')}
                className="w-full gap-1.5 border-primary/60 bg-primary/5 px-2.5 text-xs font-semibold text-primary hover:bg-primary/10 hover:text-primary md:h-9 md:min-h-9 md:w-auto"
              >
                <Sparkles />
                <span className="truncate">{t('sqlWorkspaceAskAi')}</span>
                {aiMemory.length > 0 && (
                  <span
                    className="rounded-full bg-primary/15 px-1.5 font-mono text-[10px]"
                    title={t('sqlWorkspaceAiMemoryHint')}
                  >
                    {aiMemory.length}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="center" sideOffset={6} className="w-[min(calc(100vw-1.5rem),440px)] p-3">
              <div className="mb-2 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <h2 className="text-sm font-semibold">{t('sqlWorkspaceAskAi')}</h2>
                <span className="ml-auto text-[10px] text-muted-foreground">{t('sqlWorkspaceAskAiTagline')}</span>
              </div>

              {aiMemory.length > 0 && (
                <div className="mb-2 rounded-md border border-border bg-muted/40 p-2">
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('sqlWorkspaceAiMemory')}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={clearAiMemory}
                      className="ml-auto h-7 min-h-0 px-1.5 text-[10px] text-muted-foreground hover:text-destructive"
                    >
                      {t('sqlWorkspaceAiClearMemory')}
                    </Button>
                  </div>
                  <ul className="space-y-0.5">
                    {aiMemory.slice(-3).map((turn) => (
                      <li key={turn.ts} className="truncate text-[11px] text-muted-foreground" title={turn.prompt}>
                        · {turn.prompt}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-[10px] text-muted-foreground">{t('sqlWorkspaceAiMemoryHint')}</p>
                </div>
              )}

              <Textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    void handleAskAi()
                  }
                }}
                placeholder={t('sqlWorkspaceAskAiPlaceholder')}
                rows={4}
                className="resize-y text-xs"
                autoFocus
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="hidden text-[10px] text-muted-foreground sm:inline">{t('sqlWorkspaceAskAiSubmitHint')}</span>
                <Button
                  onClick={() => void handleAskAi()}
                  disabled={!aiPrompt.trim()}
                  loading={aiLoading}
                  icon={<Sparkles />}
                  className="flex-1 px-3 text-xs font-semibold sm:h-9 sm:min-h-9 sm:flex-none"
                >
                  {t('sqlWorkspaceAskAiGenerate')}
                </Button>
              </div>
              {aiError && (
                <div className="mt-2 rounded-md border border-destructive bg-destructive/10 p-2 text-[11px] text-destructive">
                  {aiError}
                </div>
              )}
            </PopoverContent>
          </Popover>

          <label
            htmlFor="sql-write-mode"
            className={`inline-flex min-h-11 w-full cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-xs font-medium transition-colors md:min-h-9 md:w-auto md:gap-2 md:px-2.5 ${
              writeMode
                ? 'border-destructive bg-destructive/10 text-destructive'
                : 'border-border bg-background text-muted-foreground'
            }`}
            title={t('sqlWorkspaceWriteMode')}
          >
            <Switch
              id="sql-write-mode"
              checked={writeMode}
              onCheckedChange={setWriteMode}
              aria-label={t('sqlWorkspaceWriteMode')}
            />
            <span>{t('sqlWorkspaceWriteMode')}</span>
          </label>

          <Button
            onClick={execute}
            disabled={!sql.trim()}
            loading={loading}
            icon={<Play />}
            title={t('sqlWorkspaceRunHint')}
            className="w-full px-3 text-xs font-semibold md:h-9 md:min-h-9 md:w-auto"
          >
            {t('sqlWorkspaceRun')}
          </Button>
        </div>
      </header>

      {/* Mobile schema browser */}
      <Sheet open={schemaSheetOpen} onOpenChange={setSchemaSheetOpen}>
        <SheetContent side="left" className="flex w-[88vw] max-w-sm flex-col p-3 md:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>{t('sqlWorkspaceSchema')}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 pt-6">{schemaBrowser}</div>
        </SheetContent>
      </Sheet>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar: schema */}
        <aside className="hidden w-[290px] flex-shrink-0 overflow-hidden border-r border-border bg-card p-2 md:block">
          {schemaBrowser}
        </aside>

        {/* Main: editor + results */}
        <main className="flex min-w-0 flex-1 flex-col gap-2 p-3 md:overflow-y-auto">
          <CodeMirrorEditor
            value={sql}
            onChange={setSql}
            onExecute={execute}
            tables={editorTables}
            placeholder={t('sqlWorkspacePlaceholder')}
          />

          {/* Recent strip */}
          {recent.length > 0 && (
            <div className="flex items-center gap-2">
              <History className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="hidden shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground sm:inline">
                {t('sqlWorkspaceRecent')}
              </span>
              <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden">
                {recent.slice(0, 10).map((r) => (
                  <Button
                    key={r.ts}
                    variant="outline"
                    size="sm"
                    onClick={() => setSql(r.sql)}
                    title={r.sql}
                    className="block max-w-[200px] shrink-0 truncate px-2 font-mono text-[11px] font-normal text-muted-foreground"
                  >
                    {r.sql.replace(/\s+/g, ' ').slice(0, 60)}
                  </Button>
                ))}
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={clearRecent}
                aria-label={t('sqlWorkspaceClearRecent')}
                title={t('sqlWorkspaceClearRecent')}
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              >
                <X />
              </Button>
            </div>
          )}

          {/* Status bar + export toolbar */}
          {result && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>{t('sqlWorkspaceRows', { count: result.row_count })}</span>
                <span>· {t('sqlWorkspaceDuration', { ms: result.duration_ms })}</span>
                {result.statements > 1 && <span>· {t('sqlWorkspaceStatements', { count: result.statements })}</span>}
                {result.truncated && (
                  <span className="font-semibold text-amber-600 dark:text-amber-400">· {t('sqlWorkspaceTruncated')}</span>
                )}
                {result.write_mode && <span className="font-semibold text-destructive">· WRITE</span>}
              </div>
              {result.rows.length > 0 && (
                <div className="grid grid-cols-3 gap-1.5 sm:flex sm:justify-end">
                  <Button
                    variant="outline"
                    onClick={handleExportCsv}
                    disabled={exporting !== null}
                    icon={<FileDown />}
                    title={t('sqlWorkspaceExportCsv')}
                    className="gap-1 px-2 text-[11px] sm:h-9 sm:min-h-9"
                  >
                    {t('sqlWorkspaceExportCsv')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleExportXlsx}
                    disabled={exporting !== null}
                    loading={exporting === 'xlsx'}
                    icon={<FileSpreadsheet />}
                    title={t('sqlWorkspaceExportXlsx')}
                    className="gap-1 px-2 text-[11px] sm:h-9 sm:min-h-9"
                  >
                    {t('sqlWorkspaceExportXlsx')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleCopyTable}
                    disabled={exporting !== null}
                    icon={copied ? <Check className="text-emerald-600 dark:text-emerald-400" /> : <ClipboardCopy />}
                    title={t('sqlWorkspaceCopyTableHint')}
                    className="gap-1 px-2 text-[11px] sm:h-9 sm:min-h-9"
                  >
                    {copied ? t('sqlWorkspaceCopied') : t('sqlWorkspaceCopyTable')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive bg-destructive/10 p-2.5 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1 break-words">
                <div className="font-semibold">
                  {t('sqlWorkspaceError')}
                  {errorCode && <span className="ml-1.5 font-mono text-[10px] opacity-75">[{errorCode}]</span>}
                </div>
                <div className="font-mono">{error}</div>

                {/* Did you mean… — one tap rewrites the identifier in place */}
                {fix && (
                  <div className="mt-2 rounded-md border border-border bg-card p-2 text-foreground">
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold">
                      <Wand2 className="h-3.5 w-3.5 text-primary" />
                      {t('sqlWorkspaceDidYouMean')}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {fix.suggestions.map((s) => (
                        <Button
                          key={s}
                          variant="outline"
                          size="sm"
                          onClick={() => applyFix(s)}
                          className="min-h-11 border-primary/60 bg-primary/15 px-2.5 font-mono text-[11px] font-semibold text-foreground hover:bg-primary/25 sm:min-h-9"
                        >
                          {s}
                        </Button>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[10px] text-muted-foreground">
                      {t('sqlWorkspaceDidYouMeanHint', { name: fix.missing.name })}
                    </p>
                  </div>
                )}

                {errorHint && (
                  <div className="mt-1 font-mono text-foreground/80">
                    <span className="font-sans font-semibold">hint:</span> {errorHint}
                  </div>
                )}
                {errorDetail && (
                  <div className="mt-1 font-mono text-foreground/80">
                    <span className="font-sans font-semibold">detail:</span> {errorDetail}
                  </div>
                )}
                {errorCode === 'write_required' && (
                  <div className="mt-1 text-foreground/80">{t('sqlWorkspaceWriteRequiredHint')}</div>
                )}
              </div>
            </div>
          )}

          {result && (
            <ResultsTable columns={result.columns} rows={result.rows} maxHeight="max-h-[55vh]" />
          )}
        </main>
      </div>
    </div>
  )
}
