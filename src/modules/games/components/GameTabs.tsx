import { useTranslation } from 'react-i18next'

export type TabKey = 'upcoming' | 'recent' | 'results' | 'rankings'

const TAB_KEYS: { key: TabKey; labelKey: string }[] = [
  { key: 'upcoming', labelKey: 'tabUpcoming' },
  { key: 'recent', labelKey: 'tabRecent' },
  { key: 'results', labelKey: 'tabResults' },
  { key: 'rankings', labelKey: 'tabRankings' },
]

interface GameTabsProps {
  activeTab: TabKey
  onChange: (tab: TabKey) => void
}

export default function GameTabs({ activeTab, onChange }: GameTabsProps) {
  const { t } = useTranslation('games')

  return (
    <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-gray-700">
      {TAB_KEYS.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`shrink-0 border-b-2 px-4 py-3 text-sm font-medium transition-colors sm:py-2.5 ${
            activeTab === tab.key
              ? 'border-gold-400 text-brand-700 dark:text-gold-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </div>
  )
}
