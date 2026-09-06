import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { useAdminMode } from '../../hooks/useAdminMode'
import { useRealtime } from '../../hooks/useRealtime'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { useWeekNavigation } from './hooks/useWeekNavigation'
import { useHallenplanData } from './hooks/useHallenplanData'
import WeekNavigation from './components/WeekNavigation'
import WeekSlotView from './components/WeekSlotView'
import DayNavigation from './components/DayNavigation'
import DaySlotView from './components/DaySlotView'
import SlotEditor from './components/SlotEditor'
import SummaryView from './components/SummaryView'
import VirtualSlotDetailModal from './components/VirtualSlotDetailModal'
import ClaimModal from './components/ClaimModal'
import ClaimDetailModal from './components/ClaimDetailModal'
import type { HallSlot, HallClosure, SlotClaim, Team, Hall, Training } from '../../types'
import { fetchItem, fetchItems, flattenM2MTeams } from '../../lib/api'
import { useReportPageLoading } from '../../hooks/usePageReady'
import { TourPageButton } from '../guide/TourPageButton'

export type SportFilter = 'all' | 'vb' | 'bb'

export interface FreedSlotInfo {
  hallName: string
  dayLabel: string
  dateStr: string
  startTime: string
  endTime: string
  slot: HallSlot
}

function getTodayDayIndex(): number {
  const dow = new Date().getDay()
  return dow === 0 ? 6 : dow - 1
}

export default function HallenplanPage() {
  const { t } = useTranslation('hallenplan')
  const navigate = useNavigate()
  const { isCoach, coachTeamIds, hasAdminAccessToTeam, hasAdminAccessToSport } = useAuth()
  const { effectiveIsAdmin } = useAdminMode()
  const isMobile = useIsMobile()
  const { weekDays, goNext, goPrev, goToday, weekLabel, mondayStr, sundayStr } = useWeekNavigation()

  const [selectedHallIds, setSelectedHallIds] = useState<string[]>([])
  const [selectedDayIndex, setSelectedDayIndex] = useState(getTodayDayIndex)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingSlot, setEditingSlot] = useState<HallSlot | null>(null)
  const [prefill, setPrefill] = useState<{ day: number; time: string; hall: string } | null>(null)
  const [showSummary, setShowSummary] = useState(false)
  const [sportFilter, setSportFilter] = useState<SportFilter>('all')

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

  // Filter slots by sport
  const teamsBySport = useMemo(() => {
    const vb = new Set(teams.filter((t: Team) => t.sport === 'volleyball').map((t: Team) => t.id))
    const bb = new Set(teams.filter((t: Team) => t.sport === 'basketball').map((t: Team) => t.id))
    return { vb, bb }
  }, [teams])
  const adminTeamIds = useMemo(
    () => teams.filter((team) => hasAdminAccessToTeam(team.id)).map((team) => team.id),
    [teams, hasAdminAccessToTeam],
  )
  const filteredSlots = useMemo(
    () => {
      if (sportFilter === 'all') return slots
      const allowedTeams = sportFilter === 'vb' ? teamsBySport.vb : teamsBySport.bb
      return slots.filter((s) => {
        // Slots with no team: need sport context to filter
        if (!s.team?.length) {
          // Virtual slots from a known team: check source team's sport
          if (s._virtual?.sourceRecord) {
            const sourceTeam = (s._virtual.sourceRecord as { team?: string }).team
            if (sourceTeam) return allowedTeams.has(sourceTeam)
          }
          // Teamless slots (real free slots, Spielhalle, etc.): only show in "All" view
          return false
        }
        // Filter by sport
        if (!s.team?.some(t => allowedTeams.has(t))) return false
        // VB mode: filter out BB game hall events (GCal basketball games)
        if (sportFilter === 'vb' && s._virtual?.source === 'hall_event' && s.slot_type === 'game') return false
        return true
      })
    },
    [slots, sportFilter, teamsBySport],
  )

  const DAY_KEYS = ['dayMonday', 'dayTuesday', 'dayWednesday', 'dayThursday', 'dayFriday', 'daySaturday', 'daySunday'] as const
  const freedSlotInfos = useMemo(() => {
    const now = new Date()
    const hallMap = new Map<string, Hall>(halls.map((h) => [h.id, h]))
    return filteredSlots
      .filter((s) => s._virtual?.isFreed || (!s._virtual && !s.team?.length))
      .filter((s) => {
        // Hide past slots that can no longer be claimed
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
          dateStr: slotDate ? `${slotDate.getDate()}.${slotDate.getMonth() + 1}.` : '',
          startTime: s.start_time,
          endTime: s.end_time,
          slot: s,
        }
      })
  }, [filteredSlots, halls, t, weekDays])

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
  useRealtime<Training>('trainings', debouncedRefetch)

  function handleSlotClick(slot: HallSlot) {
    const meta = slot._virtual
    const canAdminTeam = !!slot.team?.length && slot.team.some(t => hasAdminAccessToTeam(t))
    const canAdminCurrentSport = sportFilter === 'all'
      ? hasAdminAccessToSport('volleyball') || hasAdminAccessToSport('basketball')
      : hasAdminAccessToSport(sportFilter === 'vb' ? 'volleyball' : 'basketball')
    const canAdmin = canAdminTeam || canAdminCurrentSport
    // A real slot with no team = manually created "free" slot
    const isManuallyFree = !meta && !slot.team?.length

    // Admin mode: freed/manually-free slots → open slot editor (admins manage, not claim)
    if ((meta?.isFreed || isManuallyFree) && effectiveIsAdmin && canAdmin) {
      if (!meta && isManuallyFree) {
        // Real manually-free slot → edit it directly
        setEditingSlot(slot)
        setPrefill(null)
        setEditorOpen(true)
      } else {
        // Virtual freed slot → show detail modal (with admin context)
        setVirtualDetailSlot(slot)
      }
      return
    }

    // Freed slot (virtual or manual) → open claim modal (for coaches only)
    if ((meta?.isFreed || isManuallyFree) && isCoach) {
      setClaimSlot(slot)
      return
    }

    // Claimed slot → open claim detail modal
    if (meta?.isClaimed && meta.claimRecord) {
      setClaimDetailSlot(slot)
      setClaimDetailRecord(meta.claimRecord)
      return
    }

    // Virtual slot → open detail modal (read-only for non-admins, with nav links for admins)
    if (meta) {
      setVirtualDetailSlot(slot)
      return
    }

    // Admin or coach (own team): real slots → open slot editor
    if ((effectiveIsAdmin && canAdmin) || (isCoach && slot.team?.some(t => coachTeamIds.includes(t)))) {
      setEditingSlot(slot)
      setPrefill(null)
      setEditorOpen(true)
      return
    }
  }

  function handleEmptyCellClick(dayOfWeek: number, time: string, hallId: string) {
    if (!effectiveIsAdmin && !isCoach) return
    setPrefill({ day: dayOfWeek, time, hall: hallId })
    setEditingSlot(null)
    setEditorOpen(true)
  }

  function handleEditorClose() {
    setEditorOpen(false)
    setEditingSlot(null)
    setPrefill(null)
    refetch()
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

  // Report to app boot gate — see usePageReady.tsx
  useReportPageLoading(isLoading)

  return (
    <div>
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 sm:text-2xl">{t('title')}</h1>
          <TourPageButton />
        </div>
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
            isAdmin={effectiveIsAdmin}
            onOpenClosureManager={() => navigate('/admin/hallenplan/closures')}
            onOpenHallManager={() => navigate('/admin/hallenplan/halls')}
            showSummary={showSummary}
            onToggleSummary={() => setShowSummary((v) => !v)}
            sportFilter={sportFilter}
            onSetSportFilter={setSportFilter}
            freedSlots={freedSlotInfos}
            onFreedSlotClick={handleSlotClick}
          />

          {isLoading ? null : showSummary ? (
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
              isAdmin={effectiveIsAdmin}
              isCoach={isCoach}
              coachTeamIds={coachTeamIds}
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
            isAdmin={effectiveIsAdmin}
            onOpenClosureManager={() => navigate('/admin/hallenplan/closures')}
            onOpenHallManager={() => navigate('/admin/hallenplan/halls')}
            sportFilter={sportFilter}
            onSetSportFilter={setSportFilter}
            freedSlots={freedSlotInfos}
            onFreedSlotClick={handleSlotClick}
          />

          {isLoading ? null : (
            <WeekSlotView
              slots={filteredSlots}
              closures={closures}
              weekDays={weekDays}
              halls={halls}
              teams={teams}
              selectedHallIds={selectedHallIds}
              isAdmin={effectiveIsAdmin}
              isCoach={isCoach}
              coachTeamIds={coachTeamIds}
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
          isAdmin={effectiveIsAdmin}
          coachTeamIds={coachTeamIds}
          adminTeamIds={adminTeamIds}
          onClose={handleEditorClose}
          onSaved={refetch}
        />
      )}

      {virtualDetailSlot && (
        <VirtualSlotDetailModal
          slot={virtualDetailSlot}
          halls={halls}
          teams={teams}
          isAdmin={effectiveIsAdmin}
          onClose={() => { setVirtualDetailSlot(null); refetch() }}
          onEditSlot={async (training: Training) => {
            setVirtualDetailSlot(null)
            try {
              let parentSlot: HallSlot | null = null
              if (training.hall_slot) {
                parentSlot = flattenM2MTeams([await fetchItem<HallSlot>('hall_slots', training.hall_slot, { fields: ['*', 'teams.teams_id'] })])[0]
              } else {
                // No hall_slot reference — find matching slot by team + day + time
                // Use the virtual slot's own data as fallback (sourceRecord may be empty for freed slots)
                const slotTeam = training.team || virtualDetailSlot?.team?.[0]
                const slotStartTime = training.start_time || virtualDetailSlot?.start_time
                const slotEndTime = training.end_time || virtualDetailSlot?.end_time
                let dbDay: number | undefined
                if (training.date) {
                  const jsDay = new Date(training.date).getDay()
                  dbDay = jsDay === 0 ? 6 : jsDay - 1
                } else if (virtualDetailSlot?.day_of_week != null) {
                  dbDay = virtualDetailSlot.day_of_week
                }
                if (slotTeam && slotStartTime && slotEndTime && dbDay != null) {
                  const results = await fetchItems<HallSlot>('hall_slots', { limit: 1,
                    filter: { _and: [{ teams: { teams_id: { _eq: slotTeam } } }, { day_of_week: { _eq: dbDay } }, { start_time: { _eq: slotStartTime } }, { end_time: { _eq: slotEndTime } }] },
                    fields: ['*', 'teams.teams_id'],
                  })
                  if (results.length > 0) parentSlot = flattenM2MTeams(results)[0]
                }
              }
              if (parentSlot) {
                setEditingSlot(parentSlot)
                setPrefill(null)
                setEditorOpen(true)
              }
            } catch {
              // hall_slot not found — ignore
            }
          }}
        />
      )}

      {claimSlot && (
        <ClaimModal
          slot={claimSlot}
          halls={halls}
          teams={teams}
          rawSlots={rawSlots}
          weekDays={weekDays}
          onClose={() => { setClaimSlot(null); refetch() }}
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
          onClose={() => { setClaimDetailSlot(null); setClaimDetailRecord(null); refetch() }}
          onReleased={handleClaimReleased}
        />
      )}
    </div>
  )
}
