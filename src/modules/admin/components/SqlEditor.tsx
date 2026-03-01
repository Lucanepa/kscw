import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import pb from '../../../pb'
import ResultsTable from './ResultsTable'
import ConfirmDialog from '../../../components/ConfirmDialog'

interface SqlResult {
  success: boolean
  columns: string[]
  rows: unknown[][]
  rowCount: number
  message?: string
  error?: string
}

const HISTORY_KEY = 'kscw-sql-history'
const MAX_HISTORY = 20

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  } catch {
    return []
  }
}

export default function SqlEditor() {
  const { t } = useTranslation('admin')
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SqlResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState(loadHistory)
  const [showHistory, setShowHistory] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [execTimeMs, setExecTimeMs] = useState<number | null>(null)

  const isDangerous = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)/i.test(query)

  const executeQuery = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    setLoading(true)
    setResult(null)
    setExecTimeMs(null)
    const start = performance.now()
    try {
      const res = (await pb.send('/api/admin/sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      })) as SqlResult
      setExecTimeMs(Math.round(performance.now() - start))
      setResult(res)
      if (res.success) {
        const newHistory = [q, ...history.filter((h) => h !== q)].slice(0, MAX_HISTORY)
        setHistory(newHistory)
        localStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory))
      }
    } catch (err) {
      setExecTimeMs(Math.round(performance.now() - start))
      setResult({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        columns: [],
        rows: [],
        rowCount: 0,
      })
    } finally {
      setLoading(false)
    }
  }, [query, history])

  const handleExecute = () => {
    if (isDangerous) {
      setShowConfirm(true)
    } else {
      executeQuery()
    }
  }

  return (
    <div className="space-y-4">
      {/* SQL Input */}
      <div>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              handleExecute()
            }
          }}
          placeholder={t('sqlPlaceholder')}
          rows={8}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleExecute}
          disabled={loading || !query.trim()}
          className="min-h-[44px] rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 sm:min-h-0"
        >
          {loading ? '...' : t('execute')}
        </button>
        <button
          onClick={() => {
            setQuery('')
            setResult(null)
            setExecTimeMs(null)
          }}
          className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 sm:min-h-0 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          {t('clear')}
        </button>
        {history.length > 0 && (
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 sm:min-h-0 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {t('history')} ({history.length})
          </button>
        )}
        {execTimeMs !== null && (
          <span className="text-xs text-gray-500 dark:text-gray-400">{execTimeMs}ms</span>
        )}
      </div>

      {/* History */}
      {showHistory && history.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700">
          {history.map((h, i) => (
            <button
              key={i}
              onClick={() => {
                setQuery(h)
                setShowHistory(false)
              }}
              className="block w-full truncate border-b border-gray-100 px-3 py-2 text-left font-mono text-xs text-gray-700 hover:bg-gray-50 last:border-b-0 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {h}
            </button>
          ))}
        </div>
      )}

      {/* Error */}
      {result && !result.success && result.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          <p className="font-semibold">{t('queryError')}</p>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{result.error}</pre>
        </div>
      )}

      {/* Success message for non-SELECT */}
      {result && result.success && result.message && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400">
          {result.message}
        </div>
      )}

      {/* Results table */}
      {result && result.success && result.columns.length > 0 && !result.message && (
        <ResultsTable columns={result.columns} rows={result.rows} />
      )}

      {/* Dangerous query confirmation */}
      <ConfirmDialog
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={executeQuery}
        title={t('dangerousQueryTitle')}
        message={t('dangerousQueryMessage')}
        confirmLabel={t('execute')}
        danger
      />
    </div>
  )
}
