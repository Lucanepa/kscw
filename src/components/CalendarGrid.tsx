import type { ReactNode } from 'react'
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  addMonths,
  formatDateDE,
  toDateKey,
  DAY_HEADERS,
} from '../utils/dateUtils'

interface CalendarGridProps<T> {
  month: Date
  onMonthChange: (month: Date) => void
  itemsByDate: Map<string, T[]>
  renderDayContent: (date: Date, items: T[]) => ReactNode
  closedDates?: Set<string>
  highlightedDates?: Set<string>
  minMonth?: Date
  maxMonth?: Date
}

export default function CalendarGrid<T>({
  month,
  onMonthChange,
  itemsByDate,
  renderDayContent,
  closedDates,
  highlightedDates,
  minMonth,
  maxMonth,
}: CalendarGridProps<T>) {
  const monthStart = startOfMonth(month)
  const monthEnd = endOfMonth(month)
  const gridStart = startOfWeek(monthStart)
  const gridEnd = endOfWeek(monthEnd)
  const days = eachDayOfInterval(gridStart, gridEnd)

  const today = new Date()
  const canGoPrev = !minMonth || addMonths(month, -1) >= startOfMonth(minMonth)
  const canGoNext = !maxMonth || addMonths(month, 1) <= startOfMonth(maxMonth)

  return (
    <div>
      {/* Month header */}
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={() => onMonthChange(addMonths(month, -1))}
          disabled={!canGoPrev}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent dark:text-gray-400 dark:hover:bg-gray-700"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {formatDateDE(month, 'MMMM yyyy')}
        </h2>
        <button
          onClick={() => onMonthChange(addMonths(month, 1))}
          disabled={!canGoNext}
          className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent dark:text-gray-400 dark:hover:bg-gray-700"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 border-b border-gray-200 dark:border-gray-700">
        {DAY_HEADERS.map((d) => (
          <div
            key={d}
            className="py-2 text-center text-[10px] font-medium text-gray-500 sm:text-xs dark:text-gray-400"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 border-l border-gray-200 dark:border-gray-700">
        {days.map((date) => {
          const key = toDateKey(date)
          const inMonth = isSameMonth(date, month)
          const isToday = isSameDay(date, today)
          const items = itemsByDate.get(key) ?? []
          const isClosed = closedDates?.has(key) ?? false
          const isHighlighted = highlightedDates?.has(key) ?? false

          return (
            <div
              key={key}
              className={`relative min-h-[3rem] border-b border-r border-gray-200 p-0.5 sm:min-h-[5rem] sm:p-1 lg:min-h-[6.5rem] lg:p-2 dark:border-gray-700 ${
                !inMonth ? 'bg-gray-50 dark:bg-gray-900' : isHighlighted ? 'bg-amber-50 dark:bg-amber-950' : 'bg-white dark:bg-gray-800'
              }`}
            >
              {/* Closure overlay */}
              {isClosed && (
                <div className="pointer-events-none absolute inset-0 bg-red-50 opacity-50" />
              )}

              {/* Day number */}
              <div
                className={`mb-0.5 text-[10px] font-medium sm:mb-1 sm:text-xs ${
                  isToday
                    ? 'inline-flex h-4 w-4 items-center justify-center rounded-full bg-gold-400 text-brand-900 sm:h-5 sm:w-5'
                    : !inMonth
                      ? 'text-gray-300 dark:text-gray-600'
                      : 'text-gray-700 dark:text-gray-300'
                }`}
              >
                {date.getDate()}
              </div>

              {/* Content */}
              {inMonth && (
                <div className="space-y-0.5 overflow-hidden">
                  {renderDayContent(date, items)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
