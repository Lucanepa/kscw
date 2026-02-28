import { useTranslation } from 'react-i18next'

const PB_ADMIN_URL = `${import.meta.env.VITE_PB_URL || 'https://kscw-api.lucanepa.com'}/_/`

export default function DatabasePage() {
  const { t } = useTranslation('nav')

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t('manageDb')}
        </h1>
        <a
          href={PB_ADMIN_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t('openInNewTab')}
        </a>
      </div>
      <iframe
        src={PB_ADMIN_URL}
        className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700"
        title="PocketBase Admin"
      />
    </div>
  )
}
