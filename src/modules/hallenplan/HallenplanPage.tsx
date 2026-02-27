import { useState, useCallback } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { useRealtime } from '../../hooks/useRealtime'
import { useWeekNavigation } from './hooks/useWeekNavigation'
import { useHallenplanData } from './hooks/useHallenplanData'
import WeekNavigation from './components/WeekNavigation'
import WeekSlotView from './components/WeekSlotView'
import SlotEditor from './components/SlotEditor'
import ClosureManager from './components/ClosureManager'
import type { HallSlot, HallClosure } from '../../types'

export default function HallenplanPage() {
  const { isAdmin } = useAuth()
  const { weekDays, goNext, goPrev, goToday, weekLabel, mondayStr, sundayStr } = useWeekNavigation()

  const [selectedHallId, setSelectedHallId] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingSlot, setEditingSlot] = useState<HallSlot | null>(null)
  const [prefill, setPrefill] = useState<{ day: number; time: string; hall: string } | null>(null)
  const [closureManagerOpen, setClosureManagerOpen] = useState(false)

  const { halls, teams, slots, closures, isLoading, refetch } = useHallenplanData(
    selectedHallId,
    mondayStr,
    sundayStr,
  )

  // Realtime: auto-refresh when another user makes changes
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

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Hallenplan</h1>
        <p className="mt-1 text-sm text-gray-600">
          Wochenansicht der Hallenbelegung — Trainings, Spiele, Events.
        </p>
      </div>

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
        <div className="flex items-center justify-center py-20">
          <div className="text-gray-500">Laden...</div>
        </div>
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
