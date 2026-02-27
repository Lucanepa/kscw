import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ViewToggle from '../../components/ViewToggle'
import CalendarFilters from './CalendarFilters'
import UnifiedCalendarView from './UnifiedCalendarView'
import UnifiedListView from './UnifiedListView'
import MobileWeekView from './MobileWeekView'
import HallenplanView from './HallenplanView'
import { useCalendarData } from './hooks/useCalendarData'
import { downloadICal } from '../../utils/icalGenerator'
import { startOfMonth, startOfWeek } from '../../utils/dateUtils'
import { useIsMobile } from '../../hooks/useMediaQuery'
import LoadingSpinner from '../../components/LoadingSpinner'
import type { CalendarViewMode, CalendarFilterState } from '../../types/calendar'

export default function CalendarPage() {
  const { t } = useTranslation('calendar')
  const isMobile = useIsMobile()
  const [viewMode, setViewMode] = useState<CalendarViewMode>(() => isMobile ? 'week' : 'month')
  const [filters, setFilters] = useState<CalendarFilterState>({
    sources: [],
    selectedTeamIds: [],
  })
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()))
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()))

  // Determine which month to fetch data for
  const dataMonth = viewMode === 'week' ? startOfMonth(weekStart) : month
  const needsData = viewMode === 'week' || viewMode === 'month' || viewMode === 'list'
  const { entries, closedDates, isLoading } = useCalendarData({ filters, month: dataMonth, enabled: needsData })

  function handleExport() {
    downloadICal(entries, 'kscw-kalender.ics')
  }

  function handleViewChange(v: string) {
    const newMode = v as CalendarViewMode
    // Sync month/week state when switching between views
    if (newMode === 'month' && viewMode === 'week') {
      setMonth(startOfMonth(weekStart))
    } else if (newMode === 'week' && viewMode === 'month') {
      setWeekStart(startOfWeek(new Date()))
    }
    setViewMode(newMode)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{t('title')}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {({ hallenplan: t('subtitleHall'), week: t('subtitleWeek'), month: t('subtitleMonth'), list: t('subtitleList') } as Record<CalendarViewMode, string>)[viewMode]}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {needsData && (
            <button
              onClick={handleExport}
              disabled={entries.length === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              <span className="hidden sm:inline">{t('exportICal')}</span>
            </button>
          )}
          <ViewToggle
            options={[
              { value: 'hallenplan', label: t('viewHall') },
              { value: 'week', label: t('viewWeek') },
              { value: 'month', label: t('viewMonth') },
              { value: 'list', label: t('viewList') },
            ]}
            value={viewMode}
            onChange={handleViewChange}
          />
        </div>
      </div>

      {/* Calendar filters — for week/month/list views */}
      {needsData && <CalendarFilters filters={filters} onChange={setFilters} />}

      {/* Views */}
      {viewMode === 'hallenplan' && <HallenplanView />}

      {needsData && isLoading && <LoadingSpinner />}

      {needsData && !isLoading && (
        <>
          {viewMode === 'week' && (
            <MobileWeekView
              entries={entries}
              closedDates={closedDates}
              weekStart={weekStart}
              onWeekChange={setWeekStart}
            />
          )}
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
