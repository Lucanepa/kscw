import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import CalendarGrid from '../../components/CalendarGrid'
import GameChip from './GameChip'
import DayOverflowPopover from './DayOverflowPopover'
import AbsenceBadge from './AbsenceBadge'
import CrossTeamBadge from './CrossTeamBadge'
import type { CalendarEntry } from '../../types/calendar'
import type { Game } from '../../types'
import type { AbsentMember } from './utils/absencesByDate'
import type { CrossTeamConflict } from './hooks/useCrossTeamConflicts'
import { toDateKey, getSeasonMonths, getSeasonYear, formatDate } from '../../utils/dateUtils'

interface CalendarViewProps {
  entries: CalendarEntry[]
  closedDates: Set<string>
  /** Club-wide blackout days: date key (yyyy-MM-dd) -> reason. */
  blockedDates?: Map<string, string>
  month: Date
  onMonthChange: (month: Date) => void
  onGameClick?: (game: Game) => void
  onEmptyDayClick?: (date: Date) => void
  /** date key (yyyy-MM-dd) -> members unavailable for games that day. */
  absencesByDate?: Map<string, AbsentMember[]>
  /** date key (yyyy-MM-dd) -> roster-sharing teams playing that day. */
  crossTeamByDate?: Map<string, CrossTeamConflict[]>
  /** True while the absence overlay is still fetching: `absencesByDate` is empty
   *  because the answer is unknown, NOT because nobody is away. Render a pending
   *  pill instead of the day's real count. */
  absencesPending?: boolean
  /** Same, for the cross-team overlay. */
  crossTeamPending?: boolean
}

export default function CalendarView({ entries, closedDates, blockedDates, month, onMonthChange, onGameClick, onEmptyDayClick, absencesByDate, crossTeamByDate, absencesPending = false, crossTeamPending = false }: CalendarViewProps) {
  const { t } = useTranslation('spielplanung')
  // seasonMonths drives the season-month pill strip below. We intentionally
  // stopped passing min/maxMonth to CalendarGrid so the prev/next arrows can
  // cross season boundaries freely.
  const seasonYear = getSeasonYear(month)
  const seasonMonths = getSeasonMonths(seasonYear)

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
              className={`rounded px-2.5 py-1.5 text-sm font-medium transition-colors sm:px-2 sm:py-1 sm:text-xs ${
                isActive
                  ? 'bg-gold-400 text-brand-900'
                  : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:text-gray-300'
              }`}
            >
              {formatDate(m, 'MMM')}
            </button>
          )
        })}
      </div>

      <CalendarGrid
        month={month}
        onMonthChange={onMonthChange}
        itemsByDate={itemsByDate}
        closedDates={closedDates}
        blockedDates={blockedDates}
        blockedLabel={t('blockedDate')}
        highlightedDates={highlightedDates}
        onEmptyDayClick={onEmptyDayClick}
        renderDayContent={(date, items) => {
          const visible = items.slice(0, 3)
          const hidden = items.slice(3)
          const absent = absencesByDate?.get(toDateKey(date)) ?? []
          const crossTeam = crossTeamByDate?.get(toDateKey(date)) ?? []

          return (
            <>
              {/* Keep the badge row mounted while an overlay is pending, so an
                  unknown count reads as a pending pill rather than as "none" —
                  and so the game chips below don't shift down when it lands. */}
              {(absent.length > 0 || crossTeam.length > 0 || absencesPending || crossTeamPending) && (
                <div className="flex justify-end gap-1">
                  {crossTeamPending ? (
                    <span
                      role="img"
                      aria-label={t('common:loading')}
                      className="h-3 w-5 animate-pulse rounded-full bg-sky-100 dark:bg-sky-900/40"
                    />
                  ) : crossTeam.length > 0 && <CrossTeamBadge conflicts={crossTeam} />}
                  {absencesPending ? (
                    <span
                      role="img"
                      aria-label={t('common:loading')}
                      className="h-3 w-5 animate-pulse rounded-full bg-amber-100 dark:bg-amber-900/40"
                    />
                  ) : absent.length > 0 && <AbsenceBadge absent={absent} />}
                </div>
              )}
              {visible.map((entry) => (
                <GameChip
                  key={entry.id}
                  game={entry.source as Game}
                  teamName={entry.teamNames[0] ?? '?'}
                  onClick={onGameClick}
                />
              ))}
              {hidden.length > 0 && (
                <DayOverflowPopover
                  games={hidden.map((e) => e.source as Game)}
                  teamNames={hidden.map((e) => e.teamNames[0] ?? '?')}
                  count={hidden.length}
                  onGameClick={onGameClick}
                />
              )}
            </>
          )
        }}
      />
    </div>
  )
}
