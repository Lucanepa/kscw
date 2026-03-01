import { useTranslation } from 'react-i18next'

interface ResultsTableProps {
  columns: string[]
  rows: unknown[][]
  maxHeight?: string
}

function formatCell(value: unknown): React.ReactNode {
  if (value === null || value === undefined)
    return <span className="text-gray-400 italic">NULL</span>
  if (typeof value === 'boolean')
    return (
      <span className={value ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
        {String(value)}
      </span>
    )
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (str.length > 120)
    return <span title={str}>{str.slice(0, 120)}…</span>
  return str
}

export default function ResultsTable({ columns, rows, maxHeight = 'max-h-[60vh]' }: ResultsTableProps) {
  const { t } = useTranslation('admin')

  if (columns.length === 0)
    return <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">{t('noResults')}</p>

  return (
    <div>
      <div className={`overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 ${maxHeight}`}>
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800">
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  className="whitespace-nowrap border-b border-gray-200 px-3 py-2 font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-300"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className="whitespace-nowrap px-3 py-1.5 font-mono text-gray-900 dark:text-gray-100"
                  >
                    {formatCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-right text-xs text-gray-500 dark:text-gray-400">
        {t('rowsReturned', { count: rows.length })}
      </p>
    </div>
  )
}
