import type { Hall } from '../../../types'

interface WeekNavigationProps {
  weekLabel: string
  onPrev: () => void
  onNext: () => void
  onToday: () => void
  halls: Hall[]
  selectedHallId: string
  onSelectHall: (hallId: string) => void
  isAdmin: boolean
  onOpenClosureManager: () => void
}

export default function WeekNavigation({
  weekLabel,
  onPrev,
  onNext,
  onToday,
  halls,
  selectedHallId,
  onSelectHall,
  isAdmin,
  onOpenClosureManager,
}: WeekNavigationProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white dark:bg-gray-800 p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <button
          onClick={onPrev}
          className="rounded-md p-2 text-gray-600 hover:bg-gray-100 sm:p-1.5 dark:hover:bg-gray-700"
          title="Vorherige Woche"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="min-w-[220px] text-center text-sm font-semibold text-gray-900 lg:text-base">
          {weekLabel}
        </span>
        <button
          onClick={onNext}
          className="rounded-md p-2 text-gray-600 hover:bg-gray-100 sm:p-1.5 dark:hover:bg-gray-700"
          title="Nächste Woche"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button
          onClick={onToday}
          className="rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Heute
        </button>
      </div>

      <div className="flex items-center gap-3">
        <select
          value={selectedHallId}
          onChange={(e) => onSelectHall(e.target.value)}
          className="rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">Alle Hallen</option>
          {halls.map((hall) => (
            <option key={hall.id} value={hall.id}>
              {hall.name}
            </option>
          ))}
        </select>

        {isAdmin && (
          <button
            onClick={onOpenClosureManager}
            className="rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Hallensperren
          </button>
        )}
      </div>
    </div>
  )
}
