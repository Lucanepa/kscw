import { useMemo } from 'react'
import CalendarGrid from '../../components/CalendarGrid'
import { useIsMobile } from '../../hooks/useMediaQuery'
import type { CalendarEntry } from '../../types/calendar'
import { toDateKey } from '../../utils/dateUtils'

interface UnifiedCalendarViewProps {
  entries: CalendarEntry[]
  closedDates: Set<string>
  month: Date
  onMonthChange: (month: Date) => void
  onEntryClick?: (entry: CalendarEntry) => void
  onOverflowClick?: (entries: CalendarEntry[], date: Date) => void
}

const typeStyles: Record<string, string> = {
  game: 'bg-brand-100 text-brand-800',
  'game-home': 'bg-brand-100 text-brand-800',
  'game-away': 'bg-amber-100 text-amber-800',
  training: 'bg-green-100 text-green-800',
  closure: 'bg-red-100 text-red-800',
  event: 'bg-purple-100 text-purple-800',
  hall: 'bg-cyan-100 text-cyan-800',
}

function entryStyle(entry: CalendarEntry): string {
  if (entry.type === 'game' && entry.gameType) {
    return typeStyles[`game-${entry.gameType}`]
  }
  return typeStyles[entry.type]
}

export default function UnifiedCalendarView({
  entries,
  closedDates,
  month,
  onMonthChange,
  onEntryClick,
  onOverflowClick,
}: UnifiedCalendarViewProps) {
  const isMobile = useIsMobile()
  const maxItems = isMobile ? 2 : 3

  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    for (const entry of entries) {
      const key = toDateKey(entry.date)
      const existing = map.get(key) ?? []
      existing.push(entry)
      map.set(key, existing)
    }
    return map
  }, [entries])

  return (
    <CalendarGrid
      month={month}
      onMonthChange={onMonthChange}
      itemsByDate={itemsByDate}
      closedDates={closedDates}
      renderDayContent={(date, items) => {
        const visible = items.slice(0, maxItems)
        const overflow = items.length - maxItems

        return (
          <>
            {visible.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onEntryClick?.(entry)
                }}
                className={`w-full truncate rounded px-0.5 text-left text-xs leading-snug transition-opacity hover:opacity-80 sm:px-1 sm:text-sm ${entryStyle(entry)}`}
              >
                {entry.startTime && (
                  <span className="font-medium">{entry.startTime} </span>
                )}
                <span className="hidden sm:inline">{entry.title}</span>
              </button>
            ))}
            {overflow > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onOverflowClick?.(items, date)
                }}
                className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 hover:bg-gray-200 sm:text-xs dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600"
              >
                +{overflow}
              </button>
            )}
          </>
        )
      }}
    />
  )
}
