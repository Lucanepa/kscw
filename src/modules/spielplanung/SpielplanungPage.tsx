import { useState, useMemo } from 'react'
import ViewToggle from '../../components/ViewToggle'
import SpielplanungFilters from './SpielplanungFilters'
import CalendarView from './CalendarView'
import ListView from './ListView'
import { useSpielplanungData } from './hooks/useSpielplanungData'
import { useTeams } from '../../hooks/useTeams'
import { startOfMonth, getSeasonYear } from '../../utils/dateUtils'
import { useIsMobile } from '../../hooks/useMediaQuery'
import LoadingSpinner from '../../components/LoadingSpinner'
import type { ViewMode, SpielplanungFilterState } from '../../types/calendar'

const viewOptions = [
  { value: 'calendar', label: 'Kalender' },
  { value: 'list-date', label: 'Nach Datum' },
  { value: 'list-team', label: 'Nach Team' },
]

function getInitialMonth(): Date {
  const now = new Date()
  const m = now.getMonth()
  if (m >= 8 || m <= 4) return startOfMonth(now)
  return new Date(now.getFullYear(), 8, 1)
}

export default function SpielplanungPage() {
  const isMobile = useIsMobile()
  const [viewMode, setViewMode] = useState<ViewMode>(() => isMobile ? 'list-date' : 'calendar')
  const [filters, setFilters] = useState<SpielplanungFilterState>({
    sport: 'all',
    selectedTeamIds: [],
    gameType: 'all',
    showAbsences: false,
  })
  const [month, setMonth] = useState<Date>(getInitialMonth)

  const seasonYear = getSeasonYear(month)
  const seasonStart = `${seasonYear}-09-01`
  const seasonEnd = `${seasonYear + 1}-05-31`

  const { games, entries, closedDates, isLoading, error } = useSpielplanungData({
    filters,
    seasonStart,
    seasonEnd,
  })

  const { data: teams } = useTeams()

  const filteredEntries = useMemo(() => entries, [entries])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">Spielplanung</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Saisonübersicht {seasonYear}/{(seasonYear + 1).toString().slice(2)}
          </p>
        </div>
        <ViewToggle
          options={viewOptions}
          value={viewMode}
          onChange={(v) => setViewMode(v as ViewMode)}
        />
      </div>

      {/* Filters */}
      <SpielplanungFilters filters={filters} onChange={setFilters} />

      {/* Loading / Error */}
      {isLoading && <LoadingSpinner />}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Fehler beim Laden: {error.message}
        </div>
      )}

      {/* Views */}
      {!isLoading && !error && (
        <>
          {viewMode === 'calendar' && (
            <CalendarView
              entries={filteredEntries}
              closedDates={closedDates}
              month={month}
              onMonthChange={setMonth}
            />
          )}
          {viewMode === 'list-date' && (
            <ListView games={games} mode="date" teams={teams} />
          )}
          {viewMode === 'list-team' && (
            <ListView games={games} mode="team" teams={teams} />
          )}
        </>
      )}
    </div>
  )
}
