import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import SqlEditor from './components/SqlEditor'
import TableBrowser from './components/TableBrowser'

const PB_ADMIN_URL = `${import.meta.env.VITE_PB_URL || 'https://kscw-api.lucanepa.com'}/_/`

type Tab = 'sql' | 'tables' | 'pbadmin'

export default function DatabasePage() {
  const { t } = useTranslation('admin')
  const [tab, setTab] = useState<Tab>('sql')

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white sm:text-2xl">
          {t('database')}
        </h1>
        {tab === 'pbadmin' && (
          <a
            href={PB_ADMIN_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t('openInNewTab')}
          </a>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {(['sql', 'tables', 'pbadmin'] as Tab[]).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === key
                ? 'border-b-2 border-brand-600 text-brand-700 dark:text-brand-400'
                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
            }`}
          >
            {t(`tab_${key}`)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="mt-4 flex-1 overflow-auto">
        {tab === 'sql' && <SqlEditor />}
        {tab === 'tables' && <TableBrowser />}
        {tab === 'pbadmin' && (
          <iframe
            src={PB_ADMIN_URL}
            className="h-full w-full rounded-lg border border-gray-200 dark:border-gray-700"
            title="PocketBase Admin"
          />
        )}
      </div>
    </div>
  )
}
