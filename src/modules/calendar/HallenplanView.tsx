import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { useAdminMode } from '../../hooks/useAdminMode'
import { useRealtime } from '../../hooks/useRealtime'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { useWeekNavigation } from '../hallenplan/hooks/useWeekNavigation'
import { useHallenplanData } from '../hallenplan/hooks/useHallenplanData'
import WeekNavigation from '../hallenplan/components/WeekNavigation'
import WeekSlotView from '../hallenplan/components/WeekSlotView'
import DayNavigation from '../hallenplan/components/DayNavigation'
import DaySlotView from '../hallenplan/components/DaySlotView'
import SlotEditor from '../hallenplan/components/SlotEditor'
import VirtualSlotDetailModal from '../hallenplan/components/VirtualSlotDetailModal'
import SummaryView from '../hallenplan/components/SummaryView'
import ClaimModal from '../hallenplan/components/ClaimModal'
import ClaimDetailModal from '../hallenplan/components/ClaimDetailModal'
import LoadingSpinner from '../../components/LoadingSpinner'
import { relId } from '../../utils/relations'
import { formatDateCompactZurich } from '../../utils/dateHelpers'
import type { HallSlot, HallClosure, SlotClaim, Game, Training, HallEvent, Hall, Team } from '../../types'
import type { FreedSlotInfo, SportFilter } from '../hallenplan/HallenplanPage'

function getTodayDayIndex(): number {
  const dow = new Date().getDay()
  return dow === 0 ? 6 : dow - 1
}

export default function HallenplanView() {
  const { t } = useTranslation('hallenplan')
  const navigate = useNavigate()
  const { isCoach } = useAuth()
  const { effectiveIsAdmin: isAdmin } = useAdminMode()
  const isMobile = useIsMobile()
  const { weekDays, goNext, goPrev, goToday, weekLabel, mondayStr, sundayStr } = useWeekNavigation()

  const [selectedHallIds, setSelectedHallIds] = useState<string[]>([])
  const [selectedDayIndex, setSelectedDayIndex] = useState(getTodayDayIndex)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingSlot, setEditingSlot] = useState<HallSlot | null>(null)
  const [prefill, setPrefill] = useState<{ day: number; time: string; hall: string } | null>(null)
  const [virtualDetailSlot, setVirtualDetailSlot] = useState<HallSlot | null>(null)
  const [showSummary, setShowSummary] = useState(false)
  const [sportFilter, setSportFilter] = useState<SportFilter>('vb')

  // Claim modals
  const [claimSlot, setClaimSlot] = useState<HallSlot | null>(null)
  const [claimDetailSlot, setClaimDetailSlot] = useState<HallSlot | null>(null)
  const [claimDetailRecord, setClaimDetailRecord] = useState<SlotClaim | null>(null)

  function handleToggleSummary() {
    const next = !showSummary
    setShowSummary(next)
    if (next) {
      // Enter fullscreen + landscape on mobile (requires user gesture)
      const el = document.documentElement
      const requestFs = el.requestFullscreen?.bind(el)
        ?? (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(el)
      if (requestFs) {
        requestFs()
          .then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.('landscape'))
          .catch(() => {})
      }
    } else {
      // Exit fullscreen + unlock orientation
      screen.orientation?.unlock?.()
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {})
      }
    }
  }

  // Sync summary state when user exits fullscreen via system gesture
  useEffect(() => {
    function onFsChange() {
      if (!document.fullscreenElement && showSummary) {
        setShowSummary(false)
        screen.orientation?.unlock?.()
      }
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [showSummary])

  const { halls, teams, slots, rawSlots, closures, isLoading, refetch } = useHallenplanData(
    selectedHallIds,
    mondayStr,
    sundayStr,
    weekDays,
  )

  // Filter slots by sport. Team ids must be compared as strings: `teams` ids are
  // stringified by the API layer, but a slot's `team` entries can be numbers,
  // strings, or expanded objects — comparing across those types silently fails
  // the Set lookup and empties the VB/BB views (the symptom that made every
  // slot vanish under the sport filter).
  const teamsBySport = useMemo(() => {
    const vb = new Set(teams.filter((t: Team) => t.sport === 'volleyball').map((t: Team) => String(t.id)))
    const bb = new Set(teams.filter((t: Team) => t.sport === 'basketball').map((t: Team) => String(t.id)))
    return { vb, bb }
  }, [teams])
  const filteredSlots = useMemo(() => {
    if (sportFilter === 'all') return slots
    const allowedTeams = sportFilter === 'vb' ? teamsBySport.vb : teamsBySport.bb
    return slots.filter((s) => {
      if (!s.team?.length) return true
      if (!s.team.some(t => allowedTeams.has(relId(t)))) return false
      if (sportFilter === 'vb' && s._virtual?.source === 'hall_event' && s.slot_type === 'game') return false
      return true
    })
  }, [slots, sportFilter, teamsBySport])

  const DAY_KEYS = ['dayMonday', 'dayTuesday', 'dayWednesday', 'dayThursday', 'dayFriday', 'daySaturday', 'daySunday'] as const
  const freedSlotInfos = useMemo(() => {
    const now = new Date()
    const hallMap = new Map<string, Hall>(halls.map((h) => [h.id, h]))
    return filteredSlots
      .filter((s) => s._virtual?.isFreed || (!s._virtual && !s.team?.length))
      .filter((s) => {
        const slotDate = weekDays[s.day_of_week]
        if (!slotDate) return true
        const [h, m] = (s.end_time || '23:59').split(':').map(Number)
        const slotEnd = new Date(slotDate)
        slotEnd.setHours(h, m, 0, 0)
        return slotEnd > now
      })
      .map((s): FreedSlotInfo => {
        const slotDate = weekDays[s.day_of_week]
        return {
          hallName: hallMap.get(s.hall)?.name || '?',
          dayLabel: t(DAY_KEYS[s.day_of_week] ?? 'dayMonday'),
          dateStr: slotDate ? formatDateCompactZurich(slotDate) : '',
          startTime: s.start_time,
          endTime: s.end_time,
          slot: s,
        }
      })
  }, [filteredSlots, halls, t, weekDays])

  // Debounce realtime refetch
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const debouncedRefetch = useCallback(() => {
    clearTimeout(refetchTimerRef.current)
    refetchTimerRef.current = setTimeout(() => refetch(), 300)
  }, [refetch])
  useEffect(() => () => clearTimeout(refetchTimerRef.current), [])

  useRealtime<HallSlot>('hall_slots', debouncedRefetch)
  useRealtime<HallClosure>('hall_closures', debouncedRefetch)
  useRealtime<SlotClaim>('slot_claims', debouncedRefetch)
  useRealtime<Game>('games', debouncedRefetch)
  useRealtime<Training>('trainings', debouncedRefetch)
  useRealtime<HallEvent>('hall_events', debouncedRefetch)

  function handleSlotClick(slot: HallSlot) {
    const meta = slot._virtual
    const isManuallyFree = !meta && !slot.team

    // Freed slot (virtual or manual) → open claim modal (for coaches/admins)
    if ((meta?.isFreed || isManuallyFree) && (isCoach || isAdmin)) {
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

  function toggleHall(hallId: string) {
    if (selectedHallIds.includes(hallId)) {
      setSelectedHallIds(selectedHallIds.filter((id) => id !== hallId))
    } else {
      setSelectedHallIds([...selectedHallIds, hallId])
    }
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
            onOpenClosureManager={() => navigate('/admin/hallenplan/closures')}
            onOpenHallManager={() => navigate('/admin/hallenplan/halls')}
            showSummary={showSummary}
            onToggleSummary={handleToggleSummary}
            sportFilter={sportFilter}
            onSetSportFilter={setSportFilter}
            freedSlots={freedSlotInfos}
            onFreedSlotClick={handleSlotClick}
          />

          {isLoading ? (
            <LoadingSpinner />
          ) : showSummary ? (
            <SummaryView slots={filteredSlots} closures={closures} weekDays={weekDays} halls={halls} teams={teams} />
          ) : (
            <DaySlotView
              slots={filteredSlots}
              closures={closures}
              day={weekDays[selectedDayIndex]}
              dayIndex={selectedDayIndex}
              halls={halls}
              teams={teams}
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
            onOpenClosureManager={() => navigate('/admin/hallenplan/closures')}
            onOpenHallManager={() => navigate('/admin/hallenplan/halls')}
            sportFilter={sportFilter}
            onSetSportFilter={setSportFilter}
            freedSlots={freedSlotInfos}
            onFreedSlotClick={handleSlotClick}
          />

          {isLoading ? (
            <LoadingSpinner />
          ) : (
            <WeekSlotView
              slots={filteredSlots}
              closures={closures}
              weekDays={weekDays}
              halls={halls}
              teams={teams}
              selectedHallIds={selectedHallIds}
              isAdmin={isAdmin}
              isCoach={isCoach}
              onSlotClick={handleSlotClick}
              onEmptyCellClick={handleEmptyCellClick}
            />
          )}
        </>
      )}

      {/* Hall filter chips — below content, compact */}
      {halls.length > 0 && (
        <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setSelectedHallIds([])}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                selectedHallIds.length === 0
                  ? 'border-gold-400 bg-gold-100 text-gold-900 dark:border-gold-400/50 dark:bg-gold-400/20 dark:text-gold-300'
                  : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
              }`}
            >
              {t('common:allHalls')}
            </button>
            {halls.map((hall) => (
              <button
                key={hall.id}
                onClick={() => toggleHall(hall.id)}
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  selectedHallIds.includes(hall.id)
                    ? 'border-gold-400 bg-gold-100 text-gold-900 dark:border-gold-400/50 dark:bg-gold-400/20 dark:text-gold-300'
                    : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                {hall.name}
              </button>
            ))}
          </div>
        </div>
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
          weekDays={weekDays}
          onClose={() => setClaimSlot(null)}
          onClaimed={handleClaimed}
          onEditSlot={(s) => {
            setClaimSlot(null)
            setEditingSlot(s)
            setPrefill(null)
            setEditorOpen(true)
          }}
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
    </>
  )
}
