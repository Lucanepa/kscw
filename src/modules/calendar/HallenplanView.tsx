import { useState, useCallback } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { useRealtime } from '../../hooks/useRealtime'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { useWeekNavigation } from '../hallenplan/hooks/useWeekNavigation'
import { useHallenplanData } from '../hallenplan/hooks/useHallenplanData'
import WeekNavigation from '../hallenplan/components/WeekNavigation'
import WeekSlotView from '../hallenplan/components/WeekSlotView'
import DayNavigation from '../hallenplan/components/DayNavigation'
import DaySlotView from '../hallenplan/components/DaySlotView'
import SlotEditor from '../hallenplan/components/SlotEditor'
import ClosureManager from '../hallenplan/components/ClosureManager'
import VirtualSlotDetailModal from '../hallenplan/components/VirtualSlotDetailModal'
import SummaryView from '../hallenplan/components/SummaryView'
import LoadingSpinner from '../../components/LoadingSpinner'
import type { HallSlot, HallClosure, Game, Training, HallEvent } from '../../types'

function getTodayDayIndex(): number {
  const dow = new Date().getDay()
  return dow === 0 ? 6 : dow - 1
}

export default function HallenplanView() {
  const { isAdmin } = useAuth()
  const isMobile = useIsMobile()
  const { weekDays, goNext, goPrev, goToday, weekLabel, mondayStr, sundayStr } = useWeekNavigation()

  const [selectedHallIds, setSelectedHallIds] = useState<string[]>([])
  const [selectedDayIndex, setSelectedDayIndex] = useState(getTodayDayIndex)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingSlot, setEditingSlot] = useState<HallSlot | null>(null)
  const [prefill, setPrefill] = useState<{ day: number; time: string; hall: string } | null>(null)
  const [closureManagerOpen, setClosureManagerOpen] = useState(false)
  const [virtualDetailSlot, setVirtualDetailSlot] = useState<HallSlot | null>(null)
  const [showSummary, setShowSummary] = useState(false)

  const { halls, teams, slots, rawSlots, closures, isLoading, refetch } = useHallenplanData(
    selectedHallIds,
    mondayStr,
    sundayStr,
    weekDays,
  )

  const handleRealtimeUpdate = useCallback(() => {
    refetch()
  }, [refetch])

  useRealtime<HallSlot>('hall_slots', handleRealtimeUpdate)
  useRealtime<HallClosure>('hall_closures', handleRealtimeUpdate)
  useRealtime<Game>('games', handleRealtimeUpdate)
  useRealtime<Training>('trainings', handleRealtimeUpdate)
  useRealtime<HallEvent>('hall_events', handleRealtimeUpdate)

  function handleSlotClick(slot: HallSlot) {
    if (slot._virtual) {
      setVirtualDetailSlot(slot)
      return
    }
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
    <>
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
            selectedHallIds={selectedHallIds}
            onSelectHalls={setSelectedHallIds}
            isAdmin={isAdmin}
            onOpenClosureManager={() => setClosureManagerOpen(true)}
            showSummary={showSummary}
            onToggleSummary={() => setShowSummary((v) => !v)}
          />

          {isLoading ? (
            <LoadingSpinner />
          ) : showSummary ? (
            <SummaryView slots={slots} closures={closures} weekDays={weekDays} halls={halls} />
          ) : (
            <DaySlotView
              slots={slots}
              closures={closures}
              day={weekDays[selectedDayIndex]}
              dayIndex={selectedDayIndex}
              halls={halls}
              selectedHallIds={selectedHallIds}
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
            selectedHallIds={selectedHallIds}
            onSelectHalls={setSelectedHallIds}
            isAdmin={isAdmin}
            onOpenClosureManager={() => setClosureManagerOpen(true)}
            showSummary={showSummary}
            onToggleSummary={() => setShowSummary((v) => !v)}
          />

          {isLoading ? (
            <LoadingSpinner />
          ) : showSummary ? (
            <SummaryView slots={slots} closures={closures} weekDays={weekDays} halls={halls} />
          ) : (
            <WeekSlotView
              slots={slots}
              closures={closures}
              weekDays={weekDays}
              halls={halls}
              selectedHallIds={selectedHallIds}
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
          allSlots={rawSlots}
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

      {virtualDetailSlot && (
        <VirtualSlotDetailModal
          slot={virtualDetailSlot}
          halls={halls}
          teams={teams}
          onClose={() => setVirtualDetailSlot(null)}
        />
      )}
    </>
  )
}
