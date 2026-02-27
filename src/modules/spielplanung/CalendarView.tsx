import { useMemo } from 'react'
import CalendarGrid from '../../components/CalendarGrid'
import TeamChip from '../../components/TeamChip'
import type { CalendarEntry } from '../../types/calendar'
import type { Game } from '../../types'
import { toDateKey, getSeasonMonths, getSeasonYear, formatDateDE } from '../../utils/dateUtils'

interface CalendarViewProps {
  entries: CalendarEntry[]
  closedDates: Set<string>
  month: Date
  onMonthChange: (month: Date) => void
}

function getOpponent(game: Game): string {
  if (game.type === 'home') {
    return game.away_team
  }
  return game.home_team
}

function isCupMatch(game: Game): '🏆' | '🥈' | null {
  const league = (game.league ?? '').toLowerCase()
  if (league.includes('swiss volley cup') || league.includes('schweizer cup')) return '🏆'
  if (league.includes('züri cup') || league.includes('zueri cup') || league.includes('zuri cup')) return '🥈'
  return null
}

export default function CalendarView({ entries, closedDates, month, onMonthChange }: CalendarViewProps) {
  const seasonYear = getSeasonYear(month)
  const seasonMonths = getSeasonMonths(seasonYear)
  const minMonth = seasonMonths[0]
  const maxMonth = seasonMonths[seasonMonths.length - 1]

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

  const highlightedDates = useMemo(() => {
    const dates = new Set<string>()
    for (const entry of entries) {
      if (entry.date.getDay() === 6) {
        dates.add(toDateKey(entry.date))
      }
    }
    return dates
  }, [entries])

  return (
    <div className="space-y-4">
      {/* Season month quick navigation */}
      <div className="flex flex-wrap gap-1">
        {seasonMonths.map((m) => {
          const isActive = m.getMonth() === month.getMonth() && m.getFullYear() === month.getFullYear()
          return (
            <button
              key={m.toISOString()}
              onClick={() => onMonthChange(m)}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
              }`}
            >
              {formatDateDE(m, 'MMM')}
            </button>
          )
        })}
      </div>

      <CalendarGrid
        month={month}
        onMonthChange={onMonthChange}
        itemsByDate={itemsByDate}
        closedDates={closedDates}
        highlightedDates={highlightedDates}
        minMonth={minMonth}
        maxMonth={maxMonth}
        renderDayContent={(_date, items) => {
          const visible = items.slice(0, 3)
          const overflow = items.length - 3

          return (
            <>
              {visible.map((entry) => {
                const game = entry.source as Game
                const cup = isCupMatch(game)
                const opponent = getOpponent(game)

                return (
                  <div
                    key={entry.id}
                    className="flex items-center gap-1 truncate text-[10px] leading-tight"
                  >
                    <TeamChip team={entry.teamNames[0] ?? '?'} size="sm" className="!text-[9px] !px-1.5 !py-0" />
                    <span className="truncate text-gray-600">
                      {opponent.length > 12 ? opponent.slice(0, 12) + '…' : opponent}
                    </span>
                    {cup && <span className="shrink-0">{cup}</span>}
                  </div>
                )
              })}
              {overflow > 0 && (
                <div className="text-[10px] text-gray-400">+{overflow} weitere</div>
              )}
            </>
          )
        }}
      />
    </div>
  )
}
