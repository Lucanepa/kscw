import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Hall, HallSlot } from '../../../types'
import Modal from '@/components/Modal'
import type { FreedSlotInfo, SportFilter } from '../HallenplanPage'
import { dayHeaders } from '../../../utils/dateUtils'
import { currentLocale } from '../../../utils/dateHelpers'

interface DayNavigationProps {
  weekDays: Date[]
  selectedDayIndex: number
  onSelectDay: (index: number) => void
  onPrevWeek: () => void
  onNextWeek: () => void
  onToday: () => void
  halls: Hall[]
  selectedHallIds: string[]
  onSelectHalls: (hallIds: string[]) => void
  isAdmin: boolean
  onOpenClosureManager: () => void
  onOpenHallManager: () => void
  showSummary: boolean
  onToggleSummary: () => void
  sportFilter: SportFilter
  onSetSportFilter: (filter: SportFilter) => void
  freedSlots?: FreedSlotInfo[]
  onFreedSlotClick?: (slot: HallSlot) => void
}

export default function DayNavigation({
  weekDays,
  selectedDayIndex,
  onSelectDay,
  onPrevWeek,
  onNextWeek,
  onToday,
  halls: _halls,
  selectedHallIds: _selectedHallIds,
  onSelectHalls: _onSelectHalls,
  isAdmin,
  onOpenClosureManager,
  onOpenHallManager,
  showSummary,
  onToggleSummary,
  sportFilter,
  onSetSportFilter,
  freedSlots = [],
  onFreedSlotClick,
}: DayNavigationProps) {
  // Hall filter chips are rendered separately below content by HallenplanView
  void _halls; void _selectedHallIds; void _onSelectHalls
  const { t } = useTranslation('hallenplan')
  const [showSlotsModal, setShowSlotsModal] = useState(false)

  const DAY_FULL = [
    t('dayMonday'),
    t('dayTuesday'),
    t('dayWednesday'),
    t('dayThursday'),
    t('dayFriday'),
    t('daySaturday'),
    t('daySunday'),
  ] as const

  const selectedDay = weekDays[selectedDayIndex]
  const dateStr = selectedDay
    ? `${DAY_FULL[selectedDayIndex]}, ${selectedDay.getDate()} ${selectedDay.toLocaleString(currentLocale(), { month: 'short' })}`
    : ''

  const todayStr = new Date().toDateString()

  return (
    <div className="mb-4 space-y-3 rounded-xl bg-white p-3 shadow-card dark:bg-gray-800">
      {/* Week navigation row */}
      <div data-tour="week-nav" className="flex items-center justify-between">
        <button
          onClick={onPrevWeek}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          title={t('prevWeek')}
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <div className="text-center">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {dateStr}
          </div>
        </div>

        <button
          onClick={onNextWeek}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          title={t('nextWeek')}
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Day dots */}
      <div className="flex justify-center gap-1">
        {weekDays.map((day, i) => {
          const isToday = day.toDateString() === todayStr
          const isSelected = i === selectedDayIndex
          return (
            <button
              key={i}
              onClick={() => onSelectDay(i)}
              className={`flex h-10 w-10 flex-col items-center justify-center rounded-lg text-xs font-medium transition-colors ${
                isSelected
                  ? 'bg-brand-500 text-white'
                  : isToday
                    ? 'bg-gold-100 text-gold-700 dark:bg-gold-900/30 dark:text-gold-400'
                    : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'
              }`}
            >
              <span className="text-[10px] leading-none">{dayHeaders()[i]}</span>
              <span className="leading-tight">{day.getDate()}</span>
            </button>
          )
        })}
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onToday}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          {t('today')}
        </button>

        <button
          onClick={onToggleSummary}
          className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
            showSummary
              ? 'border-brand-400 bg-brand-100 text-brand-800 dark:border-brand-400 dark:bg-brand-700 dark:text-white'
              : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
          }`}
        >
          {t('summary')}
        </button>

        <div data-tour="sport-filter" className="flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600">
          {(['vb', 'bb', 'all'] as const).map((f) => (
            <button
              key={f}
              onClick={() => onSetSportFilter(f)}
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                sportFilter === f
                  ? 'bg-brand-100 text-brand-800 dark:bg-brand-700 dark:text-white'
                  : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700'
              } ${f !== 'vb' ? 'border-l border-gray-300 dark:border-gray-600' : ''}`}
            >
              {f === 'vb' ? 'VB' : f === 'bb' ? 'BB' : t('all')}
            </button>
          ))}
        </div>

        {isAdmin && (
          <>
            <button
              data-tour="closures"
              onClick={onOpenClosureManager}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {t('closures')}
            </button>
            <button
              data-tour="halls"
              onClick={onOpenHallManager}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {t('hallsNav')}
            </button>
          </>
        )}
      </div>

      {/* Available slots button + modal */}
      {freedSlots.length > 0 && (
        <>
          <div className="border-t border-gray-200 pt-3 dark:border-gray-700">
            <button
              onClick={() => setShowSlotsModal(true)}
              className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 transition-colors hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              {t('slotsAvailable', { count: freedSlots.length })}
            </button>
          </div>
          <Modal open={showSlotsModal} onClose={() => setShowSlotsModal(false)} title={t('slotsAvailableTitle')} size="sm">
            <div className="space-y-1.5">
              {freedSlots.map((fs, i) => (
                <button
                  key={i}
                  onClick={() => { onFreedSlotClick?.(fs.slot); setShowSlotsModal(false) }}
                  className="flex w-full items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
                >
                  <span className="font-medium">{fs.dayLabel} {fs.dateStr} {fs.startTime}–{fs.endTime}</span>
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">{fs.hallName}</span>
                </button>
              ))}
            </div>
          </Modal>
        </>
      )}

      {/* Hall filter chips — hidden, rendered separately below content by HallenplanView */}
    </div>
  )
}
