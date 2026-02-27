export type TabKey = 'upcoming' | 'recent' | 'results' | 'rankings'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'upcoming', label: 'Nächste Spiele' },
  { key: 'recent', label: 'Letzte Spiele' },
  { key: 'results', label: 'Resultate' },
  { key: 'rankings', label: 'Rangliste' },
]

interface GameTabsProps {
  activeTab: TabKey
  onChange: (tab: TabKey) => void
}

export default function GameTabs({ activeTab, onChange }: GameTabsProps) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-gray-700">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`shrink-0 border-b-2 px-4 py-3 text-sm font-medium transition-colors sm:py-2.5 ${
            activeTab === tab.key
              ? 'border-gold-400 text-brand-700 dark:text-gold-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
