import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { RecordModel } from 'pocketbase'
import pb from '../../../pb'
import { usePB } from '../../../hooks/usePB'
import ResultsTable from './ResultsTable'
import SchemaViewer from './SchemaViewer'
import RecordEditModal from './RecordEditModal'

interface CollectionInfo {
  id: string
  name: string
  type: string
  schema: SchemaField[]
}

interface SchemaField {
  id: string
  name: string
  type: string
  required: boolean
  options: Record<string, unknown>
}

const PER_PAGE = 25

export default function TableBrowser() {
  const { t } = useTranslation('admin')
  const [collections, setCollections] = useState<CollectionInfo[]>([])
  const [loadingCollections, setLoadingCollections] = useState(true)
  const [selected, setSelected] = useState('')
  const [page, setPage] = useState(1)
  const [sortField, setSortField] = useState('')
  const [sortDir, setSortDir] = useState<'+' | '-'>('+')
  const [filterText, setFilterText] = useState('')
  const [appliedFilter, setAppliedFilter] = useState('')
  const [showSchema, setShowSchema] = useState(false)
  const [editRecord, setEditRecord] = useState<RecordModel | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  // Fetch all collections via our SQL admin endpoint (pb.collections API is superusers-only)
  useEffect(() => {
    setLoadingCollections(true)
    pb.send('/api/admin/sql', {
      method: 'POST',
      body: JSON.stringify({
        query: "SELECT id, name, type, fields FROM _collections ORDER BY name",
      }),
    })
      .then((res: { success: boolean; columns: string[]; rows: unknown[][] }) => {
        if (!res.success) return
        const idIdx = res.columns.indexOf('id')
        const nameIdx = res.columns.indexOf('name')
        const typeIdx = res.columns.indexOf('type')
        const fieldsIdx = res.columns.indexOf('fields')
        const infos: CollectionInfo[] = res.rows.map((row) => {
          let fields: SchemaField[] = []
          try {
            const parsed = JSON.parse(String(row[fieldsIdx] || '[]'))
            fields = parsed
              .filter((f: Record<string, unknown>) => !f.system && f.name !== 'id')
              .map((f: Record<string, unknown>) => ({
                id: f.id || '',
                name: f.name || '',
                type: f.type || 'text',
                required: !!f.required,
                options: (f.options || {}) as Record<string, unknown>,
              }))
          } catch {}
          return {
            id: String(row[idIdx]),
            name: String(row[nameIdx]),
            type: String(row[typeIdx]),
            schema: fields,
          }
        })
        infos.sort((a, b) => a.name.localeCompare(b.name))
        setCollections(infos)
      })
      .catch(() => {})
      .finally(() => setLoadingCollections(false))
  }, [])

  const selectedCol = collections.find((c) => c.name === selected)

  // Build sort string
  const sort = sortField ? `${sortDir}${sortField}` : ''

  // Fetch records for selected collection
  const { data: records, total, isLoading, refetch } = usePB(selected, {
    page,
    perPage: PER_PAGE,
    sort,
    filter: appliedFilter,
    enabled: !!selected,
  })

  const totalPages = Math.ceil(total / PER_PAGE)

  // Column names for the results table
  const columns = useMemo(() => {
    if (!selectedCol) return []
    return ['id', ...selectedCol.schema.map((f) => f.name), 'created', 'updated']
  }, [selectedCol])

  // Convert records to rows for ResultsTable
  const rows = useMemo(() => {
    return records.map((rec) => columns.map((col) => rec[col]))
  }, [records, columns])

  // Group collections by type
  const grouped = useMemo(() => {
    const groups: Record<string, CollectionInfo[]> = { auth: [], base: [], view: [] }
    for (const col of collections) {
      const key = col.type in groups ? col.type : 'base'
      groups[key].push(col)
    }
    return groups
  }, [collections])

  const handleSelectCollection = (name: string) => {
    setSelected(name)
    setPage(1)
    setFilterText('')
    setAppliedFilter('')
    setSortField('')
    setSortDir('+')
    setShowSchema(false)
  }

  const handleApplyFilter = () => {
    setAppliedFilter(filterText)
    setPage(1)
  }

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir((d) => (d === '+' ? '-' : '+'))
    } else {
      setSortField(field)
      setSortDir('+')
    }
    setPage(1)
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      {/* ── Collection list (sidebar on desktop, select on mobile) ── */}
      <div className="shrink-0 sm:w-48">
        {/* Mobile: select dropdown */}
        <select
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 sm:hidden"
          value={selected}
          onChange={(e) => handleSelectCollection(e.target.value)}
        >
          <option value="">{t('selectTable')}</option>
          {collections.map((c) => (
            <option key={c.id} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>

        {/* Desktop: sidebar */}
        <div className="hidden max-h-[calc(100vh-14rem)] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 sm:block">
          {loadingCollections ? (
            <p className="p-3 text-sm text-gray-500">...</p>
          ) : (
            Object.entries(grouped).map(
              ([type, cols]) =>
                cols.length > 0 && (
                  <div key={type}>
                    <p className="sticky top-0 bg-gray-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:bg-gray-800 dark:text-gray-500">
                      {type}
                    </p>
                    {cols.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => handleSelectCollection(c.name)}
                        className={`block w-full truncate px-3 py-1.5 text-left text-xs ${
                          selected === c.name
                            ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-900/30 dark:text-brand-400'
                            : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                        }`}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                ),
            )
          )}
        </div>
      </div>

      {/* ── Main content area ── */}
      <div className="min-w-0 flex-1">
        {!selected ? (
          <p className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('selectTable')}
          </p>
        ) : (
          <div className="space-y-3">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{selected}</h2>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowSchema(!showSchema)}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                >
                  {t('schema')}
                </button>
                <button
                  onClick={() => setShowCreate(true)}
                  className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600"
                >
                  {t('newRecord')}
                </button>
              </div>
            </div>

            {/* Schema (collapsible) */}
            {showSchema && selectedCol && (
              <SchemaViewer schema={selectedCol.schema} collectionType={selectedCol.type} />
            )}

            {/* Filter bar */}
            <div className="flex gap-2">
              <input
                type="text"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleApplyFilter()
                }}
                placeholder={t('filterPlaceholder')}
                className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
              <button
                onClick={handleApplyFilter}
                className="rounded-lg bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 dark:bg-gray-600 dark:text-gray-200 dark:hover:bg-gray-500"
              >
                {t('filter')}
              </button>
            </div>

            {/* Sortable column headers */}
            {columns.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {columns.map((col) => (
                  <button
                    key={col}
                    onClick={() => handleSort(col)}
                    className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                      sortField === col
                        ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600'
                    }`}
                  >
                    {col}
                    {sortField === col && (sortDir === '+' ? ' ↑' : ' ↓')}
                  </button>
                ))}
              </div>
            )}

            {/* Data */}
            {isLoading ? (
              <p className="py-4 text-center text-sm text-gray-500">...</p>
            ) : records.length === 0 ? (
              <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
                {t('noRecords')}
              </p>
            ) : (
              <div
                className="cursor-pointer"
                onClick={(e) => {
                  // Find which row was clicked
                  const target = e.target as HTMLElement
                  const row = target.closest('tr')
                  if (!row || row.closest('thead')) return
                  const idx = Array.from(row.parentElement?.children ?? []).indexOf(row)
                  if (idx >= 0 && records[idx]) {
                    setEditRecord(records[idx])
                  }
                }}
              >
                <ResultsTable columns={columns} rows={rows} />
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-700"
                >
                  ←
                </button>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {page} / {totalPages} ({total})
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-700"
                >
                  →
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Record edit modal */}
      {selectedCol && (
        <>
          <RecordEditModal
            open={!!editRecord}
            onClose={() => setEditRecord(null)}
            collection={selected}
            schema={selectedCol.schema}
            record={editRecord}
            onSaved={refetch}
          />
          <RecordEditModal
            open={showCreate}
            onClose={() => setShowCreate(false)}
            collection={selected}
            schema={selectedCol.schema}
            record={null}
            onSaved={refetch}
          />
        </>
      )}
    </div>
  )
}
