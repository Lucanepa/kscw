import { useState } from 'react'
import ViewToggle from '../../components/ViewToggle'
import CalendarFilters from './CalendarFilters'
import UnifiedCalendarView from './UnifiedCalendarView'
import UnifiedListView from './UnifiedListView'
import { useCalendarData } from './hooks/useCalendarData'
import { downloadICal } from '../../utils/icalGenerator'
import { startOfMonth } from '../../utils/dateUtils'
import type { CalendarViewMode, CalendarFilterState } from '../../types/calendar'

const viewOptions = [
  { value: 'month', label: 'Monat' },
  { value: 'list', label: 'Liste' },
]

export default function CalendarPage() {
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month')
  const [filters, setFilters] = useState<CalendarFilterState>({
    sources: [],
    selectedTeamIds: [],
  })
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()))

  const { entries, closedDates, isLoading } = useCalendarData({ filters, month })

  function handleExport() {
    downloadICal(entries, 'kscw-kalender.ics')
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Kalender</h1>
          <p className="mt-1 text-sm text-gray-500">Vereinskalender — alle Termine auf einen Blick</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleExport}
            disabled={entries.length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            iCal Export
          </button>
          <ViewToggle
            options={viewOptions}
            value={viewMode}
            onChange={(v) => setViewMode(v as CalendarViewMode)}
          />
        </div>
      </div>

      {/* Filters */}
      <CalendarFilters filters={filters} onChange={setFilters} />

      {/* Loading */}
      {isLoading && (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      )}

      {/* Views */}
      {!isLoading && (
        <>
          {viewMode === 'month' && (
            <UnifiedCalendarView
              entries={entries}
              closedDates={closedDates}
              month={month}
              onMonthChange={setMonth}
            />
          )}
          {viewMode === 'list' && <UnifiedListView entries={entries} />}
        </>
      )}
    </div>
  )
}
