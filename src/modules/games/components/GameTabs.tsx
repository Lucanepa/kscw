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
    <div className="flex gap-1 overflow-x-auto border-b border-gray-200">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === tab.key
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
