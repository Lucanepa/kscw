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
  selectedHallId: string
  onSelectHall: (hallId: string) => void
  isAdmin: boolean
  onOpenClosureManager: () => void
}

export default function DayNavigation({
  weekDays,
  selectedDayIndex,
  onSelectDay,
  onPrevWeek,
  onNextWeek,
  onToday,
  halls,
  selectedHallId,
  onSelectHall,
  isAdmin,
  onOpenClosureManager,
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

        <select
          value={selectedHallId}
          onChange={(e) => onSelectHall(e.target.value)}
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-600 dark:text-gray-300"
        >
          <option value="">{t('common:allHalls')}</option>
          {halls.map((hall) => (
            <option key={hall.id} value={hall.id}>
              {hall.name}
            </option>
          ))}
        </select>

        {isAdmin && (
          <button
            onClick={onOpenClosureManager}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {t('closures')}
          </button>
        )}
      </div>
    </div>
  )
}
