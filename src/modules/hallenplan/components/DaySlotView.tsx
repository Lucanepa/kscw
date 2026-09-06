import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { HallSlot, HallClosure, Hall, Team } from '../../../types'
import { toISODate, minutesToTime, timeToMinutes } from '../../../utils/dateHelpers'
import { SLOT_MINUTES, getDayRange, getSmartStartHour, getSmartEndHour, buildTimeAxis, axisTimeToTop, axisTopToMinutes, positionSlotsOnAxis } from '../utils/timeGrid'
import { buildConflictSet } from '../utils/conflictDetection'
import { useOverlapResolution, useTeamResolver } from '../slotViewShared'
import SlotBlock from './SlotBlock'
import ClosureOverlay from './ClosureOverlay'

interface DaySlotViewProps {
  slots: HallSlot[]
  closures: HallClosure[]
  day: Date
  dayIndex: number
  halls: Hall[]
  teams: Team[]
  selectedHallIds: string[]
  isAdmin: boolean
  isCoach?: boolean
  coachTeamIds?: string[]
  onSlotClick: (slot: HallSlot) => void
  onEmptyCellClick: (dayOfWeek: number, time: string, hallId: string) => void
}

export default function DaySlotView({
  slots,
  closures,
  day,
  dayIndex,
  halls,
  teams,
  selectedHallIds,
  isAdmin,
  isCoach = false,
  coachTeamIds = [],
  onSlotClick,
  onEmptyCellClick,
}: DaySlotViewProps) {
  // Filter slots for the selected day only
  const daySlots = useMemo(
    () => slots.filter((s) => s.day_of_week === dayIndex),
    [slots, dayIndex],
  )

  // Smart time range: 30min before earliest slot → latest slot end
  const smartStart = useMemo(() => getSmartStartHour(daySlots, dayIndex), [daySlots, dayIndex])
  const smartEnd = useMemo(() => getSmartEndHour(daySlots, dayIndex), [daySlots, dayIndex])
  const baseMinute = smartStart * 60

  // Same collapsed-gap axis the week view uses — see buildTimeAxis. On a phone
  // the saving matters more, not less: an empty afternoon is pure scrolling.
  const [expandedBreaks, setExpandedBreaks] = useState<ReadonlySet<string>>(new Set())
  const axis = useMemo(
    () => buildTimeAxis(
      daySlots.map((s) => ({ startMin: timeToMinutes(s.start_time), endMin: timeToMinutes(s.end_time) })),
      smartStart,
      smartEnd,
      expandedBreaks,
    ),
    [daySlots, smartStart, smartEnd, expandedBreaks],
  )
  const timeLabels = axis.rows
  const positioned = useMemo(() => positionSlotsOnAxis(daySlots, axis), [daySlots, axis])
  const conflictSet = useMemo(() => buildConflictSet(daySlots), [daySlots])
  const gridHeight = axis.totalHeight

  function toggleBreak(key: string) {
    setExpandedBreaks((prev) => new Set(prev).add(key))
  }

  // Visible halls: selected halls or halls with data
  const visibleHalls = useMemo(() => {
    if (selectedHallIds.length === 1) return halls.filter((h) => h.id === selectedHallIds[0])
    const hallsWithSlots = new Set(daySlots.map((s) => s.hall))
    const dayStr = toISODate(day)
    const hallsWithClosures = new Set(
      closures
        .filter((c) => dayStr >= c.start_date && dayStr <= c.end_date)
        .map((c) => c.hall),
    )
    // Include halls spanned by multi-hall slots
    const hallsFromSpans = new Set(
      daySlots.flatMap((s) => s._virtual?.spanHallIds ?? []),
    )
    const activeHallIds = new Set([...hallsWithSlots, ...hallsWithClosures, ...hallsFromSpans])
    const filtered = selectedHallIds.length > 0
      ? halls.filter((h) => selectedHallIds.includes(h.id))
      : halls.filter((h) => activeHallIds.has(h.id))
    return filtered.length > 0 ? filtered : halls.slice(0, 1)
  }, [halls, daySlots, closures, day, selectedHallIds])

  const { t } = useTranslation('hallenplan')
  const multiHall = visibleHalls.length > 1

  // Check closures for this day per hall
  const closuresByHall = useMemo(() => {
    const dayStr = toISODate(day)
    const map = new Map<string, HallClosure[]>()
    for (const c of closures) {
      if (dayStr >= c.start_date.split(' ')[0] && dayStr <= c.end_date.split(' ')[0]) {
        const existing = map.get(c.hall) ?? []
        existing.push(c)
        map.set(c.hall, existing)
      }
    }
    return map
  }, [closures, day])

  // Detect if all visible halls are closed and no slots exist → collapse to single column
  const allHallsClosed = useMemo(() => {
    if (!multiHall || daySlots.length > 0) return null
    for (const hall of visibleHalls) {
      if (!closuresByHall.has(hall.id)) return null
    }
    // All halls closed — return the first closure's reason
    const first = closuresByHall.values().next().value
    return first?.[0] ?? null
  }, [multiHall, daySlots, visibleHalls, closuresByHall])

  // Group positioned slots by hall
  const slotsByHall = useMemo(() => {
    const map = new Map<string, typeof positioned>()
    for (const ps of positioned) {
      const key = ps.slot.hall
      const group = map.get(key) ?? []
      group.push(ps)
      map.set(key, group)
    }
    return map
  }, [positioned])

  // Overlap resolution (detect overlapping siblings per hall, track which slot is
  // boosted to the front, cycle on swap) — shared with WeekSlotView.
  const { overlapGroups: overlapGroupsByHall, boostedMap, handleSwap } = useOverlapResolution(slotsByHall)

  function handleCellClick(hallId: string, e: React.MouseEvent<HTMLDivElement>) {
    if (!isAdmin && !isCoach) return
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const minutes = axisTopToMinutes(axis, y)
    const snapped = Math.floor(minutes / SLOT_MINUTES) * SLOT_MINUTES
    if (snapped < baseMinute) return
    const time = minutesToTime(snapped)
    onEmptyCellClick(dayIndex, time, hallId)
  }

  // Team name/sport resolution (skips stale archived team ids) — shared with WeekSlotView.
  const { getTeamName, getTeamSport } = useTeamResolver(teams)

  const { startMin, endMin } = getDayRange(dayIndex)
  const inactiveTopH = Math.max(0, axisTimeToTop(axis, startMin))
  const inactiveBottomTop = axisTimeToTop(axis, endMin)
  const inactiveBottomH = Math.max(0, gridHeight - inactiveBottomTop)

  return (
    <div className="overflow-y-auto rounded-lg bg-white shadow-card dark:bg-gray-800">
      {/* Hall sub-headers (only when multi-hall) */}
      {multiHall && (
        <div
          className="grid border-b border-gray-200 dark:border-gray-700"
          style={{ gridTemplateColumns: allHallsClosed ? '40px 1fr' : `40px repeat(${visibleHalls.length}, 1fr)` }}
        >
          <div className="border-r border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900" />
          {allHallsClosed ? (
            <div className="border-r border-gray-100 px-1 py-1.5 text-center text-xs font-medium text-gray-600 last:border-r-0 dark:border-gray-800 dark:text-gray-400">
              {t('allHalls')}
            </div>
          ) : (
            visibleHalls.map((hall) => (
              <div
                key={hall.id}
                className="border-r border-gray-100 px-1 py-1.5 text-center text-xs font-medium text-gray-600 last:border-r-0 dark:border-gray-800 dark:text-gray-400"
              >
                {hall.name}
              </div>
            ))
          )}
        </div>
      )}

      {/* Time grid body */}
      <div
        className="grid"
        style={{ gridTemplateColumns: allHallsClosed ? '40px 1fr' : (multiHall ? `40px repeat(${visibleHalls.length}, 1fr)` : '40px 1fr') }}
      >
        {/* Time labels column */}
        <div className="border-r border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900">
          {timeLabels.map((row) => (
            row.isBreak ? (
              <button
                key={row.time}
                type="button"
                onClick={() => row.breakKey && toggleBreak(row.breakKey)}
                title={t('breakExpand', { from: row.time, to: row.breakEndTime })}
                className="flex w-full items-center justify-end pr-1 text-[9px] tabular-nums text-gray-400 dark:text-gray-500"
                style={{ height: row.height }}
              >
                {row.time}–{row.breakEndTime}
              </button>
            ) : (
              <div
                key={row.time}
                className={`flex items-start justify-end pr-1 text-[10px] ${
                  row.isFullHour
                    ? 'font-medium text-gray-500 dark:text-gray-400'
                    : 'text-gray-300 dark:text-gray-600'
                }`}
                style={{ height: row.height }}
              >
                {row.isFullHour ? row.time : ''}
              </div>
            )
          ))}
        </div>

        {/* Hall columns */}
        {allHallsClosed ? (
          <div
            className="relative"
            style={{ height: gridHeight }}
          >
            {timeLabels.map((row) => (
              row.isBreak ? (
                <div
                  key={row.time}
                  className="absolute inset-x-0 z-10 border-y border-dashed border-gray-300 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(148,163,184,0.18)_4px,rgba(148,163,184,0.18)_8px)] dark:border-gray-600"
                  style={{ top: row.top, height: row.height }}
                />
              ) : (
                <div
                  key={row.time}
                  className={`absolute inset-x-0 ${
                    row.isFullHour
                      ? 'border-b border-gray-200 dark:border-gray-700'
                      : 'border-b border-dashed border-gray-100 dark:border-gray-800'
                  }`}
                  style={{ top: row.top, height: row.height }}
                />
              )
            ))}
            <ClosureOverlay reason={allHallsClosed.reason} hallName={t('allHalls')} />
          </div>
        ) : visibleHalls.map((hall) => {
          const hallSlots = slotsByHall.get(hall.id) ?? []
          const hallClosures = closuresByHall.get(hall.id) ?? []

          return (
            <div
              key={hall.id}
              className={`relative overflow-visible border-r border-gray-100 last:border-r-0 dark:border-gray-800 ${(isAdmin || isCoach) ? 'cursor-cell' : ''}`}
              style={{ height: gridHeight }}
              onClick={(e) => handleCellClick(hall.id, e)}
            >
              {inactiveTopH > 0 && (
                <div className="absolute inset-x-0 top-0 z-10 bg-gray-100/60 dark:bg-gray-900/40" style={{ height: inactiveTopH }} />
              )}
              {inactiveBottomH > 0 && (
                <div className="absolute inset-x-0 bottom-0 z-10 bg-gray-100/60 dark:bg-gray-900/40" style={{ height: inactiveBottomH }} />
              )}

              {timeLabels.map((row) => (
                row.isBreak ? (
                  <div
                    key={row.time}
                    className="absolute inset-x-0 z-10 border-y border-dashed border-gray-300 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(148,163,184,0.18)_4px,rgba(148,163,184,0.18)_8px)] dark:border-gray-600"
                    style={{ top: row.top, height: row.height }}
                  />
                ) : (
                  <div
                    key={row.time}
                    className={`absolute inset-x-0 ${
                      row.isFullHour
                        ? 'border-b border-gray-200 dark:border-gray-700'
                        : 'border-b border-dashed border-gray-100 dark:border-gray-800'
                    }`}
                    style={{ top: row.top, height: row.height }}
                  />
                )
              ))}

              {hallClosures.map((closure, idx) => (
                <ClosureOverlay key={`${closure.id}-${idx}`} reason={closure.reason} />
              ))}

              {overlapGroupsByHall.has(hall.id) && (
                <button
                  className="absolute right-1 top-1 z-50 flex h-6 w-6 items-center justify-center rounded bg-gray-700/60 text-white hover:bg-gray-700/80"
                  onClick={(e) => { e.stopPropagation(); handleSwap(hall.id) }}
                  title={t('switchOverlap')}
                  aria-label={t('switchOverlap')}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4" />
                  </svg>
                </button>
              )}

              {hallSlots.map((ps) => {
                const spanIds = ps.slot._virtual?.spanHallIds
                const span = spanIds
                  ? spanIds.filter((hid) => visibleHalls.some((h) => h.id === hid)).length
                  : 1
                return (
                  <SlotBlock
                    key={ps.slot.id}
                    positioned={ps}
                    teamName={getTeamName(ps.slot)}
                    teamSport={getTeamSport(ps.slot)}
                    hasConflict={conflictSet.has(ps.slot.id)}
                    isAdmin={isAdmin}
                    isCoach={isCoach}
                    coachTeamIds={coachTeamIds}
                    compact={multiHall}
                    isBoosted={boostedMap.get(hall.id) === ps.slot.id}
                    hallSpan={span}
                    onClick={() => onSlotClick(ps.slot)}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
