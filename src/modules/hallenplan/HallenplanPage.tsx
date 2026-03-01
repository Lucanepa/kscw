import { useState, useCallback, useEffect, useRef } from 'react'
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
import SummaryView from './components/SummaryView'
import VirtualSlotDetailModal from './components/VirtualSlotDetailModal'
import ClaimModal from './components/ClaimModal'
import ClaimDetailModal from './components/ClaimDetailModal'
import LoadingSpinner from '../../components/LoadingSpinner'
import type { HallSlot, HallClosure, SlotClaim } from '../../types'

function getTodayDayIndex(): number {
  const dow = new Date().getDay()
  return dow === 0 ? 6 : dow - 1
}

export default function HallenplanPage() {
  const { t } = useTranslation('hallenplan')
  const { isAdmin, isCoach } = useAuth()
  const isMobile = useIsMobile()
  const { weekDays, goNext, goPrev, goToday, weekLabel, mondayStr, sundayStr } = useWeekNavigation()

  const [selectedHallIds, setSelectedHallIds] = useState<string[]>([])
  const [selectedDayIndex, setSelectedDayIndex] = useState(getTodayDayIndex)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingSlot, setEditingSlot] = useState<HallSlot | null>(null)
  const [prefill, setPrefill] = useState<{ day: number; time: string; hall: string } | null>(null)
  const [closureManagerOpen, setClosureManagerOpen] = useState(false)
  const [showSummary, setShowSummary] = useState(false)

  // Claim modals
  const [claimSlot, setClaimSlot] = useState<HallSlot | null>(null)
  const [claimDetailSlot, setClaimDetailSlot] = useState<HallSlot | null>(null)
  const [claimDetailRecord, setClaimDetailRecord] = useState<SlotClaim | null>(null)
  // Virtual slot detail modal (read-only, for non-admin viewing)
  const [virtualDetailSlot, setVirtualDetailSlot] = useState<HallSlot | null>(null)

  const { halls, teams, slots, rawSlots, closures, isLoading, refetch } = useHallenplanData(
    selectedHallIds,
    mondayStr,
    sundayStr,
    weekDays,
  )

  // Debounce realtime refetch to avoid request storms (multiple subscriptions firing at once)
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const debouncedRefetch = useCallback(() => {
    clearTimeout(refetchTimerRef.current)
    refetchTimerRef.current = setTimeout(() => refetch(), 300)
  }, [refetch])
  useEffect(() => () => clearTimeout(refetchTimerRef.current), [])

  useRealtime<HallSlot>('hall_slots', debouncedRefetch)
  useRealtime<HallClosure>('hall_closures', debouncedRefetch)
  useRealtime<SlotClaim>('slot_claims', debouncedRefetch)

  function handleSlotClick(slot: HallSlot) {
    const meta = slot._virtual

    // Freed slot → open claim modal (for coaches)
    if (meta?.isFreed && isCoach) {
      setClaimSlot(slot)
      return
    }

    // Claimed slot → open claim detail modal
    if (meta?.isClaimed && meta.claimRecord) {
      setClaimDetailSlot(slot)
      setClaimDetailRecord(meta.claimRecord)
      return
    }

    // Virtual slot (non-freed, non-claimed) → open read-only detail modal
    if (meta && !isAdmin) {
      setVirtualDetailSlot(slot)
      return
    }

    // Admin: real slots → open slot editor
    if (isAdmin && !meta) {
      setEditingSlot(slot)
      setPrefill(null)
      setEditorOpen(true)
      return
    }

    // Admin: virtual slots → open virtual detail modal
    if (isAdmin && meta) {
      setVirtualDetailSlot(slot)
    }
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

  function handleClaimed() {
    setClaimSlot(null)
    refetch()
  }

  function handleClaimReleased() {
    setClaimDetailSlot(null)
    setClaimDetailRecord(null)
    refetch()
  }

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 sm:text-2xl">{t('title')}</h1>
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
              isCoach={isCoach}
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
              isCoach={isCoach}
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

      {virtualDetailSlot && (
        <VirtualSlotDetailModal
          slot={virtualDetailSlot}
          halls={halls}
          teams={teams}
          onClose={() => setVirtualDetailSlot(null)}
        />
      )}

      {claimSlot && (
        <ClaimModal
          slot={claimSlot}
          halls={halls}
          teams={teams}
          rawSlots={rawSlots}
          onClose={() => setClaimSlot(null)}
          onClaimed={handleClaimed}
        />
      )}

      {claimDetailSlot && claimDetailRecord && (
        <ClaimDetailModal
          slot={claimDetailSlot}
          claim={claimDetailRecord}
          halls={halls}
          teams={teams}
          onClose={() => { setClaimDetailSlot(null); setClaimDetailRecord(null) }}
          onReleased={handleClaimReleased}
        />
      )}
    </div>
  )
}
