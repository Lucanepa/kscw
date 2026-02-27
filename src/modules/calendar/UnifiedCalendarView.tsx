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
}

const typeStyles: Record<CalendarEntry['type'], string> = {
  game: 'bg-brand-100 text-brand-800',
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
      renderDayContent={(_date, items) => {
        const visible = items.slice(0, maxItems)
        const overflow = items.length - maxItems

        return (
          <>
            {visible.map((entry) => (
              <div
                key={entry.id}
                className={`truncate rounded px-0.5 text-[9px] leading-[1.1] sm:px-1 sm:text-[10px] sm:leading-tight ${typeStyles[entry.type]}`}
              >
                {entry.startTime && (
                  <span className="font-medium">{entry.startTime} </span>
                )}
                <span className="hidden sm:inline">{entry.title}</span>
              </div>
            ))}
            {overflow > 0 && (
              <div className="text-[8px] text-gray-400 sm:text-[10px]">+{overflow}</div>
            )}
          </>
        )
      }}
    />
  )
}
