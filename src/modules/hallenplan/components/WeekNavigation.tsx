import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Hall, HallSlot } from '../../../types'
import Modal from '@/components/Modal'
import type { FreedSlotInfo, SportFilter } from '../HallenplanPage'

interface WeekNavigationProps {
  weekLabel: string
  onPrev: () => void
  onNext: () => void
  onToday: () => void
  halls: Hall[]
  selectedHallIds: string[]
  onSelectHalls: (hallIds: string[]) => void
  isAdmin: boolean
  onOpenClosureManager: () => void
  onOpenHallManager: () => void
  sportFilter?: SportFilter
  onSetSportFilter?: (filter: SportFilter) => void
  freedSlots?: FreedSlotInfo[]
  onFreedSlotClick?: (slot: HallSlot) => void
}

export default function WeekNavigation({
  weekLabel,
  onPrev,
  onNext,
  onToday,
  halls: _halls,
  selectedHallIds: _selectedHallIds,
  onSelectHalls: _onSelectHalls,
  isAdmin,
  onOpenClosureManager,
  onOpenHallManager,
  sportFilter = 'all',
  onSetSportFilter,
  freedSlots = [],
  onFreedSlotClick,
}: WeekNavigationProps) {
  // Hall filter chips are rendered separately below content by HallenplanView
  void _halls; void _selectedHallIds; void _onSelectHalls
  const { t } = useTranslation('hallenplan')
  const [showSlotsModal, setShowSlotsModal] = useState(false)

  return (
    <div className="mb-4 space-y-3 rounded-xl bg-white p-4 shadow-card dark:bg-gray-800">
      {/* Top row: week nav + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div data-tour="week-nav" className="flex items-center gap-2">
          <button
            onClick={onPrev}
            className="rounded-md p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 sm:p-1.5 dark:hover:bg-gray-700"
            title={t('prevWeek')}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="min-w-[220px] text-center text-sm font-semibold text-gray-900 dark:text-gray-100 lg:text-base">
            {weekLabel}
          </span>
          <button
            onClick={onNext}
            className="rounded-md p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 sm:p-1.5 dark:hover:bg-gray-700"
            title={t('nextWeek')}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <button
            onClick={onToday}
            className="rounded-md border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {t('today')}
          </button>
        </div>

        <div className="flex items-center gap-2">
          {onSetSportFilter && (
            <div data-tour="sport-filter" className="flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600">
              {(['vb', 'bb', 'all'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => onSetSportFilter(f)}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    sportFilter === f
                      ? 'bg-brand-100 text-brand-800 dark:bg-brand-700 dark:text-white'
                      : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700'
                  } ${f !== 'vb' ? 'border-l border-gray-300 dark:border-gray-600' : ''}`}
                >
                  {f === 'vb' ? 'VB' : f === 'bb' ? 'BB' : t('all')}
                </button>
              ))}
            </div>
          )}

          {isAdmin && (
            <>
              <button
                data-tour="closures"
                onClick={onOpenClosureManager}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {t('closures')}
              </button>
              <button
                data-tour="halls"
                onClick={onOpenHallManager}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {t('hallsNav')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Available slots button + modal */}
      {freedSlots.length > 0 && (
        <>
          <div className="border-t border-gray-200 pt-3 dark:border-gray-700">
            <button
              data-tour="claim-slot"
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
