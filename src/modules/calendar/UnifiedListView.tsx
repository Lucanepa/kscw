import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import TeamChip from '../../components/TeamChip'
import type { CalendarEntry } from '../../types/calendar'
import { toDateKey, formatDate } from '../../utils/dateUtils'

interface UnifiedListViewProps {
  entries: CalendarEntry[]
  onEntryClick?: (entry: CalendarEntry) => void
}

const typeDots: Record<string, string> = {
  game: 'bg-brand-500',
  'game-home': 'bg-brand-500',
  'game-away': 'bg-amber-500',
  training: 'bg-green-500',
  closure: 'bg-red-500',
  event: 'bg-purple-500',
}

function entryDot(entry: CalendarEntry): string {
  if (entry.type === 'game' && entry.gameType) {
    return typeDots[`game-${entry.gameType}`]
  }
  return typeDots[entry.type]
}

export default function UnifiedListView({ entries, onEntryClick }: UnifiedListViewProps) {
  const { t } = useTranslation('calendar')

  const typeLabels: Record<CalendarEntry['type'], string> = {
    game: t('typeGame'),
    training: t('typeTraining'),
    closure: t('typeClosure'),
    event: t('typeEvent'),
  }
  const grouped = useMemo(() => {
    const groups: { dateKey: string; label: string; entries: CalendarEntry[] }[] = []
    let currentKey = ''

    for (const entry of entries) {
      const key = toDateKey(entry.date)
      if (key !== currentKey) {
        currentKey = key
        groups.push({
          dateKey: key,
          label: formatDate(entry.date, 'EEEE, MMMM d, yyyy'),
          entries: [],
        })
      }
      groups[groups.length - 1].entries.push(entry)
    }

    return groups
  }, [entries])

  if (entries.length === 0) {
    return <div className="py-8 text-center text-gray-500 dark:text-gray-400">{t('noEntries')}</div>
  }

  return (
    <div className="space-y-4">
      {grouped.map((group) => (
        <div key={group.dateKey} className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="border-b border-gray-100 bg-gray-50 dark:bg-gray-900 px-4 py-2">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{group.label}</h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {group.entries.map((entry) => (
              <button
                type="button"
                key={entry.id}
                onClick={() => onEntryClick?.(entry)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                {/* Type indicator */}
                <div className="flex w-20 shrink-0 items-center gap-2">
                  <div className={`h-2 w-2 shrink-0 rounded-full ${entryDot(entry)}`} />
                  <span className="text-xs text-gray-500 dark:text-gray-400">{typeLabels[entry.type]}</span>
                </div>

                {/* Title */}
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-gray-900 dark:text-gray-100">{entry.title}</span>
                  {entry.description && (
                    <span className="ml-2 text-xs text-gray-400">{entry.description}</span>
                  )}
                </div>

                {/* Time */}
                <div className="w-24 shrink-0 text-right text-sm text-gray-600 dark:text-gray-400">
                  {entry.allDay
                    ? t('common:allDay')
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
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
