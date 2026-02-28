import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import pb from '../../pb'

interface SyncDetail {
  row: number
  action: 'created' | 'updated' | 'skipped' | 'error'
  name?: string
  via?: string
  fields?: string[]
  reason?: string
  error?: string
}

interface SyncResult {
  success: boolean
  synced_at: string
  created: number
  updated: number
  skipped: number
  errors: number
  details: SyncDetail[]
  error?: string
}

export default function ClubDeskSyncPage() {
  const { t } = useTranslation('admin')
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback((f: File | null) => {
    if (f && !f.name.endsWith('.csv')) {
      setError(t('csvOnly'))
      return
    }
    setFile(f)
    setError(null)
    setResult(null)
  }, [t])

  const handleSync = useCallback(async () => {
    if (!file) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const csv = await file.text()
      const response = await pb.send('/api/clubdesk-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
      })
      setResult(response as SyncResult)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [file])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }, [handleFile])

  const actionColor = (action: string) => {
    switch (action) {
      case 'created': return 'text-green-600 dark:text-green-400'
      case 'updated': return 'text-blue-600 dark:text-blue-400'
      case 'skipped': return 'text-gray-500 dark:text-gray-400'
      case 'error': return 'text-red-600 dark:text-red-400'
      default: return ''
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-4">
      <h1 className="mb-2 text-2xl font-bold text-gray-900 dark:text-white">
        ClubDesk Sync
      </h1>
      <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
        {t('clubdeskDescription')}
      </p>

      {/* Drop zone */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`flex min-h-[160px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 transition-colors ${
          file
            ? 'border-brand-400 bg-brand-50 dark:border-brand-600 dark:bg-brand-900/20'
            : 'border-gray-300 bg-gray-50 hover:border-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:hover:border-gray-500'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
        />
        {file ? (
          <>
            <svg className="mb-2 h-8 w-8 text-brand-600 dark:text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-gray-900 dark:text-white">{file.name}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {(file.size / 1024).toFixed(1)} KB
            </p>
          </>
        ) : (
          <>
            <svg className="mb-2 h-8 w-8 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('dropCsv')}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('orClickToSelect')}</p>
          </>
        )}
      </div>

      {/* Sync button */}
      <button
        onClick={handleSync}
        disabled={!file || loading}
        className="mt-4 w-full rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {t('syncing')}
          </span>
        ) : (
          t('startSync')
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Results */}
      {result && result.success && (
        <div className="mt-6 space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-green-50 p-3 dark:bg-green-900/20">
              <p className="text-2xl font-bold text-green-700 dark:text-green-400">{result.created}</p>
              <p className="text-xs text-green-600 dark:text-green-500">{t('created')}</p>
            </div>
            <div className="rounded-lg bg-blue-50 p-3 dark:bg-blue-900/20">
              <p className="text-2xl font-bold text-blue-700 dark:text-blue-400">{result.updated}</p>
              <p className="text-xs text-blue-600 dark:text-blue-500">{t('updated')}</p>
            </div>
            <div className="rounded-lg bg-gray-100 p-3 dark:bg-gray-800">
              <p className="text-2xl font-bold text-gray-700 dark:text-gray-300">{result.skipped}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('skippedLabel')}</p>
            </div>
            <div className="rounded-lg bg-red-50 p-3 dark:bg-red-900/20">
              <p className="text-2xl font-bold text-red-700 dark:text-red-400">{result.errors}</p>
              <p className="text-xs text-red-600 dark:text-red-500">{t('errorsLabel')}</p>
            </div>
          </div>

          {/* Details toggle */}
          {result.details.length > 0 && (
            <div>
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <svg
                  className={`h-4 w-4 transition-transform ${showDetails ? 'rotate-90' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
                {t('details')} ({result.details.length})
              </button>

              {showDetails && (
                <div className="mt-2 max-h-80 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800">
                      <tr>
                        <th className="px-3 py-2">#</th>
                        <th className="px-3 py-2">{t('nameLabel')}</th>
                        <th className="px-3 py-2">{t('actionLabel')}</th>
                        <th className="px-3 py-2">{t('info')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {result.details.map((d, i) => (
                        <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <td className="px-3 py-1.5 text-gray-400">{d.row}</td>
                          <td className="px-3 py-1.5 text-gray-900 dark:text-white">{d.name || '-'}</td>
                          <td className={`px-3 py-1.5 font-medium ${actionColor(d.action)}`}>
                            {d.action}
                          </td>
                          <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400">
                            {d.via && `via ${d.via}`}
                            {d.fields && ` → ${d.fields.join(', ')}`}
                            {d.reason && d.reason}
                            {d.error && <span className="text-red-500">{d.error}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
