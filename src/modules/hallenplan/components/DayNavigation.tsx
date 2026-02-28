import { useTranslation } from 'react-i18next'
import type { Hall } from '../../../types'

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

interface DayNavigationProps {
  weekDays: Date[]
  selectedDayIndex: number
  onSelectDay: (index: number) => void
  onPrevWeek: () => void
  onNextWeek: () => void
  onToday: () => void
  halls: Hall[]
  selectedHallIds: string[]
  onSelectHalls: (hallIds: string[]) => void
  isAdmin: boolean
  onOpenClosureManager: () => void
  showSummary: boolean
  onToggleSummary: () => void
}

export default function DayNavigation({
  weekDays,
  selectedDayIndex,
  onSelectDay,
  onPrevWeek,
  onNextWeek,
  onToday,
  halls,
  selectedHallIds,
  onSelectHalls,
  isAdmin,
  onOpenClosureManager,
  showSummary,
  onToggleSummary,
}: DayNavigationProps) {
  const { t } = useTranslation('hallenplan')

  const DAY_FULL = [
    t('dayMonday'),
    t('dayTuesday'),
    t('dayWednesday'),
    t('dayThursday'),
    t('dayFriday'),
    t('daySaturday'),
    t('daySunday'),
  ] as const

  const selectedDay = weekDays[selectedDayIndex]
  const dateStr = selectedDay
    ? `${DAY_FULL[selectedDayIndex]}, ${selectedDay.getDate()} ${selectedDay.toLocaleString('en-US', { month: 'short' })}`
    : ''

  const todayStr = new Date().toDateString()

  function toggleHall(hallId: string) {
    if (selectedHallIds.includes(hallId)) {
      onSelectHalls(selectedHallIds.filter((id) => id !== hallId))
    } else {
      onSelectHalls([...selectedHallIds, hallId])
    }
  }

  return (
    <div className="mb-4 space-y-3 rounded-lg bg-white p-3 shadow-sm dark:bg-gray-800">
      {/* Week navigation row */}
      <div className="flex items-center justify-between">
        <button
          onClick={onPrevWeek}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          title={t('prevWeek')}
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <div className="text-center">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {dateStr}
          </div>
        </div>

        <button
          onClick={onNextWeek}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          title={t('nextWeek')}
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Day dots */}
      <div className="flex justify-center gap-1">
        {weekDays.map((day, i) => {
          const isToday = day.toDateString() === todayStr
          const isSelected = i === selectedDayIndex
          return (
            <button
              key={i}
              onClick={() => onSelectDay(i)}
              className={`flex h-10 w-10 flex-col items-center justify-center rounded-lg text-xs font-medium transition-colors ${
                isSelected
                  ? 'bg-brand-500 text-white'
                  : isToday
                    ? 'bg-gold-100 text-gold-700 dark:bg-gold-900/30 dark:text-gold-400'
                    : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'
              }`}
            >
              <span className="text-[10px] leading-none">{DAY_LABELS[i]}</span>
              <span className="leading-tight">{day.getDate()}</span>
            </button>
          )
        })}
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onToday}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          {t('today')}
        </button>

        <button
          onClick={onToggleSummary}
          className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
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
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {t('closures')}
          </button>
        )}
      </div>

      {/* Hall filter chips */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => onSelectHalls([])}
          className={`min-h-[44px] rounded-full border px-3 py-2 text-sm font-medium transition-colors ${
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
            className={`min-h-[44px] rounded-full border px-3 py-2 text-sm font-medium transition-colors ${
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
