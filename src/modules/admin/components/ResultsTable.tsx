import { useTranslation } from 'react-i18next'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTimeCompactZurich } from '@/utils/dateHelpers'

interface ResultsTableProps {
  columns: string[]
  rows: unknown[][]
  maxHeight?: string
  /** Map of column index → (id → display label) for relation fields */
  relationLabels?: Record<number, Record<string, string>>
}

function formatCell(value: unknown, labelMap?: Record<string, string>): React.ReactNode {
  if (value === null || value === undefined)
    return <span className="italic text-muted-foreground">NULL</span>
  if (typeof value === 'boolean')
    return (
      <span className={value ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
        {String(value)}
      </span>
    )
  // Format ISO datetime strings
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) {
    const d = new Date(value)
    if (!isNaN(d.getTime())) {
      return (
        <span className="text-muted-foreground" title={value}>
          {formatDateTimeCompactZurich(d)}
        </span>
      )
    }
  }
  // Resolve relation IDs to display labels
  if (labelMap) {
    const str = String(value)
    // Could be a single ID or JSON array of IDs
    if (Array.isArray(value)) {
      const labels = value.map((id) => labelMap[String(id)] || String(id))
      const display = labels.join(', ')
      if (display.length > 120) return <span title={display}>{display.slice(0, 120)}…</span>
      return display
    }
    if (labelMap[str]) {
      return <span title={str}>{labelMap[str]}</span>
    }
  }
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (str.length > 120)
    return <span title={str}>{str.slice(0, 120)}…</span>
  return str
}

export default function ResultsTable({ columns, rows, maxHeight = 'max-h-[60vh]', relationLabels }: ResultsTableProps) {
  const { t } = useTranslation('admin')

  if (columns.length === 0)
    return <p className="py-4 text-center text-sm text-muted-foreground">{t('noResults')}</p>

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
        {t('resultsSummary', { rows: rows.length, cols: columns.length })}
      </div>
      {/* This div is the single scroll container for both axes. shadcn's
          <Table> wraps the <table> in its own overflow-x-auto div; left as-is
          that inner wrapper becomes the scroll context and the sticky header
          sticks to it instead of here. Neutralise it with
          [&>div]:overflow-visible — same pattern as ExplorerGrid. */}
      <div className={`overflow-auto [&>div]:overflow-visible ${maxHeight}`}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead
              className="sticky left-0 top-0 z-30 w-10 whitespace-nowrap border-r border-border bg-muted text-right font-semibold text-muted-foreground"
              aria-label="#"
            >
              #
            </TableHead>
            {columns.map((col) => (
              // Sticky lives on the th cells, not thead — cross-browser
              // reliability, per ExplorerGrid.
              <TableHead key={col} className="sticky top-0 z-20 whitespace-nowrap bg-muted font-semibold">
                {col}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i} className={i % 2 === 1 ? 'bg-muted/30' : undefined}>
              {/* Row number (1-indexed). `bg-card` is opaque on purpose — a
                  translucent gutter shows the cells sliding under it. */}
              <TableCell className="sticky left-0 z-10 whitespace-nowrap border-r border-border bg-card text-right font-mono tabular-nums text-muted-foreground">
                {i + 1}
              </TableCell>
              {row.map((cell, j) => (
                <TableCell key={j} className="whitespace-nowrap font-mono text-xs text-foreground">
                  {formatCell(cell, relationLabels?.[j])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </div>
  )
}
