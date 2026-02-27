import { useMemo } from 'react'
import type { CalendarEntry } from '../../types/calendar'
import {
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addWeeks,
  isSameDay,
  toDateKey,
  formatDateDE,
  DAY_HEADERS,
} from '../../utils/dateUtils'

interface MobileWeekViewProps {
  entries: CalendarEntry[]
  closedDates: Set<string>
  weekStart: Date
  onWeekChange: (weekStart: Date) => void
}

const typeStyles: Record<CalendarEntry['type'], string> = {
  game: 'bg-brand-100 text-brand-800 dark:bg-brand-900 dark:text-brand-200',
  training: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  closure: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  event: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
}

export default function MobileWeekView({
  entries,
  closedDates,
  weekStart,
  onWeekChange,
}: MobileWeekViewProps) {
  const weekMonday = startOfWeek(weekStart)
  const weekSunday = endOfWeek(weekStart)
  const weekDays = eachDayOfInterval(weekMonday, weekSunday)
  const today = new Date()

  // Group entries by date key, filtered to this week
  const entriesByDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    const startKey = toDateKey(weekMonday)
    const endKey = toDateKey(weekSunday)

    for (const entry of entries) {
      const key = toDateKey(entry.date)
      if (key >= startKey && key <= endKey) {
        const existing = map.get(key) ?? []
        existing.push(entry)
        map.set(key, existing)
      }
    }
    return map
  }, [entries, weekMonday, weekSunday])

  // Week label: "KW 9: 24. Feb – 2. Mär"
  const weekLabel = `KW ${formatDateDE(weekMonday, 'w')}: ${formatDateDE(weekMonday, 'd. MMM')} – ${formatDateDE(weekSunday, 'd. MMM')}`

  return (
    <div>
      {/* Week navigation */}
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={() => onWeekChange(addWeeks(weekMonday, -1))}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{weekLabel}</h2>
          <button
            onClick={() => onWeekChange(startOfWeek(new Date()))}
            className="rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          >
            Heute
          </button>
        </div>

        <button
          onClick={() => onWeekChange(addWeeks(weekMonday, 1))}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* 7-column day grid */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-gray-200 dark:border-gray-700">
          {weekDays.map((date, i) => {
            const isToday = isSameDay(date, today)
            return (
              <div
                key={i}
                className="flex flex-col items-center py-2"
              >
                <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400">
                  {DAY_HEADERS[i]}
                </span>
                <span
                  className={`mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                    isToday
                      ? 'bg-gold-400 text-brand-900'
                      : 'text-gray-900 dark:text-gray-100'
                  }`}
                >
                  {date.getDate()}
                </span>
              </div>
            )
          })}
        </div>

        {/* Event columns */}
        <div className="grid grid-cols-7 divide-x divide-gray-200 dark:divide-gray-700">
          {weekDays.map((date, i) => {
            const key = toDateKey(date)
            const dayEntries = entriesByDay.get(key) ?? []
            const isClosed = closedDates.has(key)
            const isToday = isSameDay(date, today)
            const visible = dayEntries.slice(0, 4)
            const overflow = dayEntries.length - 4

            return (
              <div
                key={i}
                className={`min-h-[5rem] p-0.5 ${
                  isClosed
                    ? 'bg-red-50/50 dark:bg-red-950/30'
                    : isToday
                      ? 'bg-gold-50/50 dark:bg-gold-900/10'
                      : ''
                }`}
              >
                {visible.map((entry) => (
                  <div
                    key={entry.id}
                    className={`mb-0.5 truncate rounded px-0.5 py-px text-[9px] leading-tight ${typeStyles[entry.type]}`}
                    title={`${entry.startTime ?? ''} ${entry.title}`}
                  >
                    {entry.startTime && (
                      <span className="font-semibold">{entry.startTime.slice(0, 5)} </span>
                    )}
                    <span className="hidden min-[400px]:inline">{entry.title}</span>
                  </div>
                ))}
                {overflow > 0 && (
                  <div className="px-0.5 text-[8px] text-gray-400">+{overflow}</div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
