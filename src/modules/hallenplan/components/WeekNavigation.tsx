import { useTranslation } from 'react-i18next'
import type { Hall } from '../../../types'

interface WeekNavigationProps {
  weekLabel: string
  onPrev: () => void
  onNext: () => void
  onToday: () => void
  halls: Hall[]
  selectedHallIds: string[]
  onSelectHalls: (hallIds: string[]) => void
  isAdmin: boolean
  onOpenClosureManager: () => void
  showSummary: boolean
  onToggleSummary: () => void
}

export default function WeekNavigation({
  weekLabel,
  onPrev,
  onNext,
  onToday,
  halls,
  selectedHallIds,
  onSelectHalls,
  isAdmin,
  onOpenClosureManager,
  showSummary,
  onToggleSummary,
}: WeekNavigationProps) {
  const { t } = useTranslation('hallenplan')

  function toggleHall(hallId: string) {
    if (selectedHallIds.includes(hallId)) {
      onSelectHalls(selectedHallIds.filter((id) => id !== hallId))
    } else {
      onSelectHalls([...selectedHallIds, hallId])
    }
  }

  return (
    <div className="mb-4 space-y-3 rounded-lg bg-white p-4 shadow-sm dark:bg-gray-800">
      {/* Top row: week nav + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={onPrev}
            className="rounded-md p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 sm:p-1.5 dark:hover:bg-gray-700"
            title={t('prevWeek')}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="min-w-[220px] text-center text-sm font-semibold text-gray-900 dark:text-gray-100 lg:text-base">
            {weekLabel}
          </span>
          <button
            onClick={onNext}
            className="rounded-md p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 sm:p-1.5 dark:hover:bg-gray-700"
            title={t('nextWeek')}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <button
            onClick={onToday}
            className="rounded-md border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {t('today')}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onToggleSummary}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
              showSummary
                ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-600 dark:bg-brand-900/30 dark:text-brand-300'
                : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
            }`}
          >
            {t('summary')}
          </button>

          {isAdmin && (
            <button
              onClick={onOpenClosureManager}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {t('closures')}
            </button>
          )}
        </div>
      </div>

      {/* Hall filter chips */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => onSelectHalls([])}
          className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
            selectedHallIds.length === 0
              ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-600 dark:bg-brand-900/30 dark:text-brand-300'
              : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
          }`}
        >
          {t('common:allHalls')}
        </button>
        {halls.map((hall) => (
          <button
            key={hall.id}
            onClick={() => toggleHall(hall.id)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              selectedHallIds.includes(hall.id)
                ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-600 dark:bg-brand-900/30 dark:text-brand-300'
                : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            }`}
          >
            {hall.name}
          </button>
        ))}
      </div>
    </div>
  )
}
