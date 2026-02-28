import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ViewToggle from '../../components/ViewToggle'
import Modal from '../../components/Modal'
import CalendarFilters from './CalendarFilters'
import UnifiedCalendarView from './UnifiedCalendarView'
import UnifiedListView from './UnifiedListView'
import HallenplanView from './HallenplanView'
import CalendarEntryModal from './CalendarEntryModal'
import GameDetailModal from '../games/components/GameDetailModal'
import ICalModal from './ICalModal'
import { useCalendarData } from './hooks/useCalendarData'
import { useAuth } from '../../hooks/useAuth'
import { startOfMonth, formatDate } from '../../utils/dateUtils'
import LoadingSpinner from '../../components/LoadingSpinner'
import type { CalendarViewMode, CalendarFilterState, SourceFilter, CalendarEntry } from '../../types/calendar'
import type { Game } from '../../types'

const dotColors: Record<string, string> = {
  game: 'bg-brand-500',
  'game-home': 'bg-brand-500',
  'game-away': 'bg-amber-500',
  training: 'bg-green-500',
  closure: 'bg-red-500',
  event: 'bg-purple-500',
  hall: 'bg-cyan-500',
}

function entryDotColor(entry: CalendarEntry): string {
  if (entry.type === 'game' && entry.gameType) return dotColors[`game-${entry.gameType}`]
  return dotColors[entry.type]
}

export default function CalendarPage() {
  const { t } = useTranslation('calendar')
  const { user } = useAuth()
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month')
  const [filters, setFilters] = useState<CalendarFilterState>({
    sources: [],
    selectedTeamIds: [],
  })
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()))
  const [selectedEntry, setSelectedEntry] = useState<CalendarEntry | null>(null)
  const [dayOverflow, setDayOverflow] = useState<{ entries: CalendarEntry[]; date: Date } | null>(null)
  const [icalMode, setIcalMode] = useState<'subscribe' | 'download' | null>(null)

  // Logged out: only games. Logged in: games + trainings + events + closures
  const allowedSources: SourceFilter[] = user
    ? ['game-home', 'game-away', 'training', 'event', 'closure', 'hall']
    : ['game-home', 'game-away', 'hall']

  // When logged out, force games only; when logged in, empty = all allowed
  const effectiveFilters: CalendarFilterState = {
    ...filters,
    sources: user
      ? filters.sources
      : ['game-home', 'game-away', 'hall'],
  }

  const needsData = viewMode === 'month' || viewMode === 'list'
  const { entries, closedDates, isLoading } = useCalendarData({ filters: effectiveFilters, month, enabled: needsData })

  // Only show full-page spinner on initial load, not on month navigation
  const hasLoadedOnce = useRef(false)
  if (!isLoading && needsData) hasLoadedOnce.current = true
  const showSpinner = isLoading && !hasLoadedOnce.current

  function handleViewChange(v: string) {
    setViewMode(v as CalendarViewMode)
  }

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{t('title')}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {({ hallenplan: t('subtitleHall'), month: t('subtitleMonth'), list: t('subtitleList') } as Record<CalendarViewMode, string>)[viewMode]}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {needsData && (
            <>
              <button
                onClick={() => setIcalMode('subscribe')}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                title={t('subscribeICal')}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <span className="hidden sm:inline">{t('subscribeICal')}</span>
              </button>
              <button
                onClick={() => setIcalMode('download')}
                disabled={entries.length === 0}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span className="hidden sm:inline">{t('exportICal')}</span>
              </button>
            </>
          )}
          <ViewToggle
            options={[
              { value: 'hallenplan', label: t('viewHall') },
              { value: 'month', label: t('viewMonth') },
              { value: 'list', label: t('viewList') },
            ]}
            value={viewMode}
            onChange={handleViewChange}
          />
        </div>
      </div>

      {/* Calendar filters — for month/list views */}
      {needsData && (
        <CalendarFilters
          filters={filters}
          onChange={setFilters}
          allowedSources={allowedSources}
        />
      )}

      {/* Views */}
      {viewMode === 'hallenplan' && <HallenplanView />}

      {needsData && showSpinner && <LoadingSpinner />}

      {needsData && !showSpinner && (
        <div className="flex flex-1 flex-col">
          {viewMode === 'month' && (
            <UnifiedCalendarView
              entries={entries}
              closedDates={closedDates}
              month={month}
              onMonthChange={setMonth}
              onEntryClick={setSelectedEntry}
              onOverflowClick={(items, date) => setDayOverflow({ entries: items, date })}
            />
          )}
          {viewMode === 'list' && (
            <UnifiedListView entries={entries} onEntryClick={setSelectedEntry} />
          )}
        </div>
      )}

      {/* Day overflow modal */}
      <Modal
        open={!!dayOverflow}
        onClose={() => setDayOverflow(null)}
        title={dayOverflow ? formatDate(dayOverflow.date, 'EEEE, d MMMM') : ''}
        size="sm"
      >
        {dayOverflow && (
          <div className="space-y-2">
            {dayOverflow.entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => {
                  setDayOverflow(null)
                  setSelectedEntry(entry)
                }}
                className="flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors hover:bg-gray-50 active:bg-gray-100 dark:hover:bg-gray-700 dark:active:bg-gray-600"
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${entryDotColor(entry)}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {entry.title}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {entry.startTime ?? ''}{entry.location ? ` · ${entry.location}` : ''}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </Modal>

      {/* Detail modals */}
      {selectedEntry?.type === 'game' && (
        <GameDetailModal
          game={selectedEntry.source as Game}
          onClose={() => setSelectedEntry(null)}
        />
      )}
      {selectedEntry && selectedEntry.type !== 'game' && (
        <CalendarEntryModal
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
        />
      )}

      {/* iCal subscribe/download modal */}
      <ICalModal
        open={!!icalMode}
        mode={icalMode ?? 'subscribe'}
        onClose={() => setIcalMode(null)}
        entries={entries}
      />
    </div>
  )
}
