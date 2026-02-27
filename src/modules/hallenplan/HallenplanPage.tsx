import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../hooks/useAuth'
import { useRealtime } from '../../hooks/useRealtime'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { useWeekNavigation } from './hooks/useWeekNavigation'
import { useHallenplanData } from './hooks/useHallenplanData'
import WeekNavigation from './components/WeekNavigation'
import WeekSlotView from './components/WeekSlotView'
import DayNavigation from './components/DayNavigation'
import DaySlotView from './components/DaySlotView'
import SlotEditor from './components/SlotEditor'
import ClosureManager from './components/ClosureManager'
import LoadingSpinner from '../../components/LoadingSpinner'
import type { HallSlot, HallClosure } from '../../types'

function getTodayDayIndex(): number {
  const dow = new Date().getDay()
  return dow === 0 ? 6 : dow - 1
}

export default function HallenplanPage() {
  const { t } = useTranslation('hallenplan')
  const { isAdmin } = useAuth()
  const isMobile = useIsMobile()
  const { weekDays, goNext, goPrev, goToday, weekLabel, mondayStr, sundayStr } = useWeekNavigation()

  const [selectedHallId, setSelectedHallId] = useState('')
  const [selectedDayIndex, setSelectedDayIndex] = useState(getTodayDayIndex)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingSlot, setEditingSlot] = useState<HallSlot | null>(null)
  const [prefill, setPrefill] = useState<{ day: number; time: string; hall: string } | null>(null)
  const [closureManagerOpen, setClosureManagerOpen] = useState(false)

  const { halls, teams, slots, closures, isLoading, refetch } = useHallenplanData(
    selectedHallId,
    mondayStr,
    sundayStr,
  )

  const handleRealtimeUpdate = useCallback(() => {
    refetch()
  }, [refetch])

  useRealtime<HallSlot>('hall_slots', handleRealtimeUpdate)
  useRealtime<HallClosure>('hall_closures', handleRealtimeUpdate)

  function handleSlotClick(slot: HallSlot) {
    if (!isAdmin) return
    setEditingSlot(slot)
    setPrefill(null)
    setEditorOpen(true)
  }

  function handleEmptyCellClick(dayOfWeek: number, time: string, hallId: string) {
    if (!isAdmin) return
    setPrefill({ day: dayOfWeek, time, hall: hallId })
    setEditingSlot(null)
    setEditorOpen(true)
  }

  function handleEditorClose() {
    setEditorOpen(false)
    setEditingSlot(null)
    setPrefill(null)
  }

  function handleToday() {
    goToday()
    setSelectedDayIndex(getTodayDayIndex())
  }

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{t('title')}</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {isMobile
            ? t('subtitleDay')
            : t('subtitleWeek')}
        </p>
      </div>

      {isMobile ? (
        <>
          <DayNavigation
            weekDays={weekDays}
            selectedDayIndex={selectedDayIndex}
            onSelectDay={setSelectedDayIndex}
            onPrevWeek={goPrev}
            onNextWeek={goNext}
            onToday={handleToday}
            halls={halls}
            selectedHallId={selectedHallId}
            onSelectHall={setSelectedHallId}
            isAdmin={isAdmin}
            onOpenClosureManager={() => setClosureManagerOpen(true)}
          />

          {isLoading ? (
            <LoadingSpinner />
          ) : (
            <DaySlotView
              slots={slots}
              closures={closures}
              day={weekDays[selectedDayIndex]}
              dayIndex={selectedDayIndex}
              halls={halls}
              selectedHallId={selectedHallId}
              isAdmin={isAdmin}
              onSlotClick={handleSlotClick}
              onEmptyCellClick={handleEmptyCellClick}
            />
          )}
        </>
      ) : (
        <>
          <WeekNavigation
            weekLabel={weekLabel}
            onPrev={goPrev}
            onNext={goNext}
            onToday={goToday}
            halls={halls}
            selectedHallId={selectedHallId}
            onSelectHall={setSelectedHallId}
            isAdmin={isAdmin}
            onOpenClosureManager={() => setClosureManagerOpen(true)}
          />

          {isLoading ? (
            <LoadingSpinner />
          ) : (
            <WeekSlotView
              slots={slots}
              closures={closures}
              weekDays={weekDays}
              halls={halls}
              selectedHallId={selectedHallId}
              isAdmin={isAdmin}
              onSlotClick={handleSlotClick}
              onEmptyCellClick={handleEmptyCellClick}
            />
          )}
        </>
      )}

      {editorOpen && (
        <SlotEditor
          slot={editingSlot}
          prefill={prefill}
          halls={halls}
          teams={teams}
          allSlots={slots}
          onClose={handleEditorClose}
          onSaved={refetch}
        />
      )}

      {closureManagerOpen && (
        <ClosureManager
          halls={halls}
          closures={closures}
          onClose={() => setClosureManagerOpen(false)}
          onChanged={refetch}
        />
      )}
    </div>
  )
}
