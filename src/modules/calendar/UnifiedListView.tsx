import { useMemo } from 'react'
import TeamChip from '../../components/TeamChip'
import type { CalendarEntry } from '../../types/calendar'
import { toDateKey, formatDateDE } from '../../utils/dateUtils'

interface UnifiedListViewProps {
  entries: CalendarEntry[]
}

const typeDots: Record<CalendarEntry['type'], string> = {
  game: 'bg-blue-500',
  training: 'bg-green-500',
  closure: 'bg-red-500',
  event: 'bg-purple-500',
}

const typeLabels: Record<CalendarEntry['type'], string> = {
  game: 'Spiel',
  training: 'Training',
  closure: 'Hallensperre',
  event: 'Event',
}

export default function UnifiedListView({ entries }: UnifiedListViewProps) {
  const grouped = useMemo(() => {
    const groups: { dateKey: string; label: string; entries: CalendarEntry[] }[] = []
    let currentKey = ''

    for (const entry of entries) {
      const key = toDateKey(entry.date)
      if (key !== currentKey) {
        currentKey = key
        groups.push({
          dateKey: key,
          label: formatDateDE(entry.date, 'EEEE, d. MMMM yyyy'),
          entries: [],
        })
      }
      groups[groups.length - 1].entries.push(entry)
    }

    return groups
  }, [entries])

  if (entries.length === 0) {
    return <div className="py-8 text-center text-gray-500">Keine Einträge gefunden</div>
  }

  return (
    <div className="space-y-4">
      {grouped.map((group) => (
        <div key={group.dateKey} className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <div className="border-b border-gray-100 bg-gray-50 px-4 py-2">
            <h3 className="text-sm font-semibold text-gray-700">{group.label}</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {group.entries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50"
              >
                {/* Type indicator */}
                <div className="flex w-20 shrink-0 items-center gap-2">
                  <div className={`h-2 w-2 shrink-0 rounded-full ${typeDots[entry.type]}`} />
                  <span className="text-xs text-gray-500">{typeLabels[entry.type]}</span>
                </div>

                {/* Title */}
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-gray-900">{entry.title}</span>
                  {entry.description && (
                    <span className="ml-2 text-xs text-gray-400">{entry.description}</span>
                  )}
                </div>

                {/* Time */}
                <div className="w-24 shrink-0 text-right text-sm text-gray-600">
                  {entry.allDay
                    ? 'Ganztags'
                    : entry.startTime
                      ? entry.endTime
                        ? `${entry.startTime}–${entry.endTime}`
                        : entry.startTime
                      : ''}
                </div>

                {/* Location */}
                <div className="hidden w-36 truncate text-xs text-gray-500 md:block">
                  {entry.location}
                </div>

                {/* Team chips */}
                <div className="flex shrink-0 gap-1">
                  {entry.teamNames.map((name) => (
                    <TeamChip key={name} team={name} size="sm" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
