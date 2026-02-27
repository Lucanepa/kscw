import { useMemo } from 'react'
import CalendarGrid from '../../components/CalendarGrid'
import type { CalendarEntry } from '../../types/calendar'
import { toDateKey } from '../../utils/dateUtils'

interface UnifiedCalendarViewProps {
  entries: CalendarEntry[]
  closedDates: Set<string>
  month: Date
  onMonthChange: (month: Date) => void
}

const typeStyles: Record<CalendarEntry['type'], string> = {
  game: 'bg-blue-100 text-blue-800',
  training: 'bg-green-100 text-green-800',
  closure: 'bg-red-100 text-red-800',
  event: 'bg-purple-100 text-purple-800',
}

export default function UnifiedCalendarView({
  entries,
  closedDates,
  month,
  onMonthChange,
}: UnifiedCalendarViewProps) {
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
      renderDayContent={(_date, items) => {
        const visible = items.slice(0, 3)
        const overflow = items.length - 3

        return (
          <>
            {visible.map((entry) => (
              <div
                key={entry.id}
                className={`truncate rounded px-1 text-[10px] leading-tight ${typeStyles[entry.type]}`}
              >
                {entry.startTime && (
                  <span className="font-medium">{entry.startTime} </span>
                )}
                {entry.title}
              </div>
            ))}
            {overflow > 0 && (
              <div className="text-[10px] text-gray-400">+{overflow} weitere</div>
            )}
          </>
        )
      }}
    />
  )
}
