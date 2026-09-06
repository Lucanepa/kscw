import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { HallSlot, HallClosure, Hall, Team } from '../../../types'
import { toISODate, minutesToTime, timeToMinutes } from '../../../utils/dateHelpers'
import { SLOT_MINUTES, getDayRange, getSmartStartHour, getSmartEndHour, buildTimeAxis, axisTimeToTop, axisTopToMinutes, positionSlotsOnAxis } from '../utils/timeGrid'
import { buildConflictSet } from '../utils/conflictDetection'
import { useOverlapResolution, useTeamResolver } from '../slotViewShared'
import SlotBlock from './SlotBlock'
import ClosureOverlay from './ClosureOverlay'

interface WeekSlotViewProps {
  slots: HallSlot[]
  closures: HallClosure[]
  weekDays: Date[]
  halls: Hall[]
  teams: Team[]
  selectedHallIds: string[]
  isAdmin: boolean
  isCoach?: boolean
  coachTeamIds?: string[]
  onSlotClick: (slot: HallSlot) => void
  onEmptyCellClick: (dayOfWeek: number, time: string, hallId: string) => void
}

export default function WeekSlotView({
  slots,
  closures,
  weekDays,
  halls,
  teams,
  selectedHallIds,
  isAdmin,
  isCoach = false,
  coachTeamIds = [],
  onSlotClick,
  onEmptyCellClick,
}: WeekSlotViewProps) {
  // Smart time range across all week slots
  const smartStart = useMemo(() => {
    if (slots.length === 0) return 10
    let best = Infinity
    for (let d = 0; d < 7; d++) {
      const ds = slots.filter((s) => s.day_of_week === d)
      if (ds.length > 0) best = Math.min(best, getSmartStartHour(ds, d))
    }
    return best === Infinity ? 10 : best
  }, [slots])
  const smartEnd = useMemo(() => {
    if (slots.length === 0) return 22
    let best = -Infinity
    for (let d = 0; d < 7; d++) {
      const ds = slots.filter((s) => s.day_of_week === d)
      if (ds.length > 0) best = Math.max(best, getSmartEndHour(ds, d))
    }
    return best === -Infinity ? 22 : best
  }, [slots])
  const baseMinute = smartStart * 60

  // Stretches with nothing in them on ANY day in ANY hall collapse to a band,
  // so an empty 11:00-16:00 stops pushing the evening below the fold. Clicking
  // a band re-expands just that range, which is the only way to keep
  // click-to-create reachable inside a collapsed hour.
  const [expandedBreaks, setExpandedBreaks] = useState<ReadonlySet<string>>(new Set())
  const axis = useMemo(
    () => buildTimeAxis(
      slots.map((s) => ({ startMin: timeToMinutes(s.start_time), endMin: timeToMinutes(s.end_time) })),
      smartStart,
      smartEnd,
      expandedBreaks,
    ),
    [slots, smartStart, smartEnd, expandedBreaks],
  )
  const timeLabels = axis.rows
  const conflictSet = useMemo(() => buildConflictSet(slots), [slots])
  const gridHeight = axis.totalHeight

  function toggleBreak(key: string) {
    setExpandedBreaks((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }

  // Determine which halls are visible (selected or all halls that have data)
  const visibleHalls = useMemo(() => {
    if (selectedHallIds.length === 1) return halls.filter((h) => h.id === selectedHallIds[0])
    const hallsWithSlots = new Set(slots.map((s) => s.hall))
    const hallsWithClosures = new Set(closures.map((c) => c.hall))
    const activeHallIds = new Set([...hallsWithSlots, ...hallsWithClosures])
    const filtered = selectedHallIds.length > 0
      ? halls.filter((h) => selectedHallIds.includes(h.id))
      : halls.filter((h) => activeHallIds.has(h.id))
    return filtered.length > 0 ? filtered : halls.slice(0, 1)
  }, [halls, slots, closures, selectedHallIds])

  const { t } = useTranslation('hallenplan')
  const DAY_HEADERS = [
    t('dayMonShort'), t('dayTueShort'), t('dayWedShort'), t('dayThuShort'),
    t('dayFriShort'), t('daySatShort'), t('daySunShort'),
  ]
  const multiHall = visibleHalls.length > 1

  const todayIndex = useMemo(() => {
    const today = toISODate(new Date())
    return weekDays.findIndex((d) => toISODate(d) === today)
  }, [weekDays])

  // Position slots using multi-hall grouping when multiple halls visible
  const positioned = useMemo(() => positionSlotsOnAxis(slots, axis), [slots, axis])

  // Group positioned slots by (day, hall) for rendering
  const slotsByDayHall = useMemo(() => {
    const map = new Map<string, typeof positioned>()
    for (const ps of positioned) {
      const key = `${ps.dayIndex}:${ps.slot.hall}`
      const group = map.get(key) ?? []
      group.push(ps)
      map.set(key, group)
    }
    return map
  }, [positioned])

  // Overlap resolution (detect overlapping siblings per day:hall group, track
  // which slot is boosted to the front, cycle on swap) — shared with DaySlotView.
  const { overlapGroups: overlapGroupsByKey, boostedMap, handleSwap } = useOverlapResolution(slotsByDayHall)

  // Determine closures per day per hall
  const closuresByDayHall = useMemo(() => {
    const map = new Map<string, HallClosure[]>()
    for (const closure of closures) {
      for (let i = 0; i < 7; i++) {
        const dayStr = toISODate(weekDays[i])
        if (dayStr >= closure.start_date && dayStr <= closure.end_date) {
          const key = `${i}:${closure.hall}`
          const existing = map.get(key) ?? []
          existing.push(closure)
          map.set(key, existing)
        }
      }
    }
    return map
  }, [closures, weekDays])

  // Determine which days have content (slots or closures) — hide empty days and past days
  const visibleDays = useMemo(() => {
    if (!multiHall) {
      // Single hall: show today onwards (or full week if today is not in this week)
      if (todayIndex >= 0) return [0, 1, 2, 3, 4, 5, 6].filter((d) => d >= todayIndex)
      return [0, 1, 2, 3, 4, 5, 6]
    }
    const daysWithContent = new Set<number>()
    for (const ps of positioned) daysWithContent.add(ps.dayIndex)
    for (const closure of closures) {
      for (let i = 0; i < 7; i++) {
        const dayStr = toISODate(weekDays[i])
        if (dayStr >= closure.start_date && dayStr <= closure.end_date) {
          daysWithContent.add(i)
        }
      }
    }
    // Always show Mon-Fri at minimum
    for (let i = 0; i < 5; i++) daysWithContent.add(i)
    // Hide past days when viewing the current week
    const days = Array.from(daysWithContent).sort((a, b) => a - b)
    if (todayIndex >= 0) return days.filter((d) => d >= todayIndex)
    return days
  }, [multiHall, positioned, closures, weekDays, todayIndex])

  // Per-day visible halls: only show halls that have slots on that day
  // Closure-only halls are excluded — they're handled by allClosedDays (collapsed column)
  const hallsByDay = useMemo(() => {
    if (!multiHall) return new Map<number, Hall[]>()
    const map = new Map<number, Hall[]>()
    for (const dayIndex of visibleDays) {
      const activeHallIds = new Set<string>()
      for (const hall of visibleHalls) {
        const key = `${dayIndex}:${hall.id}`
        if ((slotsByDayHall.get(key)?.length ?? 0) > 0) {
          activeHallIds.add(hall.id)
        }
      }
      // Also include halls spanned by multi-hall slots (spanHallIds)
      for (const ps of positioned) {
        if (ps.dayIndex === dayIndex && ps.slot._virtual?.spanHallIds) {
          for (const hid of ps.slot._virtual.spanHallIds) activeHallIds.add(hid)
        }
      }
      const dayHalls = visibleHalls.filter((h) => activeHallIds.has(h.id))
      if (dayHalls.length > 0) {
        map.set(dayIndex, dayHalls)
        continue
      }
      // No slots this day. When some (but not all) halls are closed the
      // all-closed collapse path never fires, so show the actually-closed halls
      // with their CLOSED overlay instead of an arbitrary placeholder hall —
      // which would otherwise display a misleading name that flips with the hall
      // filter (it was just visibleHalls[0]). Fall back to the first visible
      // hall only when nothing is closed either (e.g. a forced-empty weekday).
      const closedHalls = visibleHalls.filter(
        (h) => (closuresByDayHall.get(`${dayIndex}:${h.id}`)?.length ?? 0) > 0,
      )
      map.set(dayIndex, closedHalls.length > 0 ? closedHalls : [visibleHalls[0]])
    }
    return map
  }, [multiHall, visibleDays, visibleHalls, slotsByDayHall, positioned, closuresByDayHall])

  // Detect days where ALL visible halls are closed and no slots exist → collapse to 1 column
  const allClosedDays = useMemo(() => {
    if (!multiHall) return new Map<number, HallClosure>()
    const map = new Map<number, HallClosure>()
    for (const dayIndex of visibleDays) {
      // Check if there are any slots on this day. Hall-less slots don't belong
      // to any column, so they must not count as content (they'd otherwise
      // block the all-halls-closed collapse while rendering nowhere).
      const hasSlots = positioned.some((ps) => ps.dayIndex === dayIndex && ps.slot.hall)
      if (hasSlots) continue
      // Check if every visible hall is closed on this day
      const dayClosures: HallClosure[] = []
      let allClosed = true
      for (const hall of visibleHalls) {
        const key = `${dayIndex}:${hall.id}`
        const closures = closuresByDayHall.get(key)
        if (!closures || closures.length === 0) {
          allClosed = false
          break
        }
        dayClosures.push(closures[0])
      }
      if (allClosed && dayClosures.length > 0) {
        // Use the first closure's reason as representative
        map.set(dayIndex, dayClosures[0])
      }
    }
    return map
  }, [multiHall, visibleDays, visibleHalls, closuresByDayHall, positioned])

  // Merge consecutive all-closed days with the same reason into single spans
  // Returns a map: first dayIndex of run → { span: number of merged days, closure }
  // Days that are part of a merged run (but not the first) are in mergedSkipDays
  const { mergedClosureRuns, mergedSkipDays } = useMemo(() => {
    const runs = new Map<number, { span: number; closure: HallClosure }>()
    const skip = new Set<number>()
    if (!multiHall) return { mergedClosureRuns: runs, mergedSkipDays: skip }

    let i = 0
    while (i < visibleDays.length) {
      const dayIndex = visibleDays[i]
      const closure = allClosedDays.get(dayIndex)
      if (!closure) { i++; continue }

      // Find consecutive all-closed days with the same reason
      let span = 1
      while (i + span < visibleDays.length) {
        const nextDay = visibleDays[i + span]
        const nextClosure = allClosedDays.get(nextDay)
        if (!nextClosure || nextClosure.reason !== closure.reason) break
        skip.add(nextDay)
        span++
      }
      runs.set(dayIndex, { span, closure })
      i += span
    }
    return { mergedClosureRuns: runs, mergedSkipDays: skip }
  }, [multiHall, visibleDays, allClosedDays])

  // todayIndex moved above visibleDays (computed earlier in file)

  // Grid template: time label + per-day hall columns (variable width per day)
  // Merged closure runs count as 1 column, skipped days contribute 0
  const totalDataCols = multiHall
    ? visibleDays.reduce((sum, d) => {
        if (mergedSkipDays.has(d)) return sum
        if (mergedClosureRuns.has(d)) return sum + 1
        return sum + (hallsByDay.get(d)?.length ?? 1)
      }, 0)
    : visibleDays.length

  function handleCellClick(dayIndex: number, hallId: string, e: React.MouseEvent<HTMLDivElement>) {
    if (!isAdmin && !isCoach) return
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const minutes = axisTopToMinutes(axis, y)
    const snapped = Math.floor(minutes / SLOT_MINUTES) * SLOT_MINUTES
    if (snapped < baseMinute) return
    const time = minutesToTime(snapped)
    onEmptyCellClick(dayIndex, time, hallId)
  }

  // Team name/sport resolution (skips stale archived team ids) — shared with DaySlotView.
  const { getTeamName, getTeamSport } = useTeamResolver(teams)

  return (
    <div className="rounded-lg bg-white shadow-card dark:bg-gray-800">
      <div data-tour="day-columns" className="min-w-[700px] overflow-x-auto">
        {/* Day headers row */}
        <div
          className="grid border-b border-gray-200 dark:border-gray-700"
          style={{ gridTemplateColumns: `60px repeat(${totalDataCols}, 1fr)` }}
        >
          <div className="border-r border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900" />
          {visibleDays.map((dayIndex) => {
            if (mergedSkipDays.has(dayIndex)) return null
            const mergedRun = mergedClosureRuns.get(dayIndex)
            if (mergedRun && mergedRun.span > 1) {
              // Merged closure header spanning multiple days
              const firstDay = weekDays[dayIndex]
              const lastDay = weekDays[visibleDays[visibleDays.indexOf(dayIndex) + mergedRun.span - 1]]
              const firstStr = `${String(firstDay.getDate()).padStart(2, '0')}.${String(firstDay.getMonth() + 1).padStart(2, '0')}.`
              const lastStr = `${String(lastDay.getDate()).padStart(2, '0')}.${String(lastDay.getMonth() + 1).padStart(2, '0')}.`
              return (
                <div
                  key={dayIndex}
                  className="border-r-2 border-gray-300 p-1 text-center text-sm last:border-r-0 dark:border-gray-600 text-gray-700 dark:text-gray-300"
                >
                  <div className="font-medium">{DAY_HEADERS[dayIndex]} – {DAY_HEADERS[visibleDays[visibleDays.indexOf(dayIndex) + mergedRun.span - 1]]}</div>
                  <div className="text-xs">{firstStr} – {lastStr}</div>
                </div>
              )
            }
            const day = weekDays[dayIndex]
            const dateStr = `${String(day.getDate()).padStart(2, '0')}.${String(day.getMonth() + 1).padStart(2, '0')}.`
            const colSpan = multiHall ? (mergedRun ? 1 : (hallsByDay.get(dayIndex)?.length ?? 1)) : 1
            return (
              <div
                key={dayIndex}
                className={`border-r-2 border-gray-300 p-1 text-center text-sm last:border-r-0 dark:border-gray-600 ${
                  dayIndex === todayIndex ? 'bg-brand-50 font-bold text-brand-700 dark:bg-brand-900/30 dark:text-brand-300' : 'text-gray-700 dark:text-gray-300'
                }`}
                style={{ gridColumn: `span ${colSpan}` }}
              >
                <div className="font-medium">{DAY_HEADERS[dayIndex]}</div>
                <div className="text-xs">{dateStr}</div>
              </div>
            )
          })}
        </div>

        {/* Hall sub-headers (only when multi-hall) */}
        {multiHall && (
          <div
            className="grid border-b border-gray-200 dark:border-gray-700"
            style={{ gridTemplateColumns: `60px repeat(${totalDataCols}, 1fr)` }}
          >
            <div className="border-r border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900" />
            {visibleDays.map((dayIndex) => {
              if (mergedSkipDays.has(dayIndex)) return null
              if (allClosedDays.has(dayIndex)) {
                return (
                  <div
                    key={`${dayIndex}-allclosed`}
                    data-tour="all-halls"
                    className="border-r-2 border-gray-300 px-0.5 py-0.5 text-center text-[10px] font-medium text-gray-500 dark:border-gray-600 dark:text-gray-400"
                  >
                    {t('allHalls')}
                  </div>
                )
              }
              const dayHalls = hallsByDay.get(dayIndex) ?? [visibleHalls[0]]
              return dayHalls.map((hall, hi) => (
                <div
                  key={`${dayIndex}-${hall.id}`}
                  className={`border-r px-0.5 py-0.5 text-center text-[10px] font-medium text-gray-500 dark:text-gray-400 ${
                    hi === dayHalls.length - 1 ? 'border-r-2 border-gray-300 dark:border-gray-600' : 'border-gray-100 dark:border-gray-800'
                  }`}
                >
                  {hall.name}
                </div>
              ))
            })}
          </div>
        )}

        {/* Time grid body */}
        <div
          className="grid"
          style={{ gridTemplateColumns: `60px repeat(${totalDataCols}, 1fr)` }}
        >
          {/* Time labels column */}
          <div className="sticky left-0 z-30 border-r border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900">
            {timeLabels.map((row) => (
              row.isBreak ? (
                <button
                  key={row.time}
                  type="button"
                  onClick={() => row.breakKey && toggleBreak(row.breakKey)}
                  title={t('breakExpand', { from: row.time, to: row.breakEndTime })}
                  className="flex w-full items-center justify-end gap-1 pr-2 text-[10px] text-gray-400 hover:text-brand-600 dark:text-gray-500 dark:hover:text-brand-400"
                  style={{ height: row.height }}
                >
                  <span className="tabular-nums">{row.time}–{row.breakEndTime}</span>
                </button>
              ) : (
                <div
                  key={row.time}
                  className={`flex items-start justify-end pr-2 text-xs ${
                    row.isFullHour ? 'font-medium text-gray-500 dark:text-gray-400' : 'text-gray-300'
                  }`}
                  style={{ height: row.height }}
                >
                  {row.isFullHour ? row.time : ''}
                </div>
              )
            ))}
          </div>

          {/* Day × Hall columns */}
          {visibleDays.map((dayIndex) => {
            // Skip days merged into a previous closure run
            if (mergedSkipDays.has(dayIndex)) return null

            const { startMin, endMin } = getDayRange(dayIndex)
            const inactiveTopH = Math.max(0, axisTimeToTop(axis, startMin))
            const inactiveBottomTop = axisTimeToTop(axis, endMin)
            const inactiveBottomH = Math.max(0, gridHeight - inactiveBottomTop)

            if (multiHall) {
              // All halls closed on this day → single collapsed column (possibly merged with adjacent days)
              const allClosedClosure = allClosedDays.get(dayIndex)
              if (allClosedClosure) {
                return (
                  <div
                    key={`${dayIndex}-allclosed`}
                    className="relative border-r-2 border-gray-300 dark:border-gray-600"
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
                          style={{ top: row.top }}
                        />
                      )
                    ))}
                    <ClosureOverlay reason={allClosedClosure.reason} hallName={t('allHalls')} />
                  </div>
                )
              }

              const dayHalls = hallsByDay.get(dayIndex) ?? [visibleHalls[0]]
              return dayHalls.map((hall, hi) => {
                const dayHallKey = `${dayIndex}:${hall.id}`
                const hallSlots = slotsByDayHall.get(dayHallKey) ?? []
                const hallClosures = closuresByDayHall.get(dayHallKey) ?? []
                const isLastInDay = hi === dayHalls.length - 1

                return (
                  <div
                    key={dayHallKey}
                    className={`relative overflow-visible ${isLastInDay ? 'border-r-2 border-gray-300 dark:border-gray-600' : 'border-r border-gray-100 dark:border-r-gray-800'} ${(isAdmin || isCoach) ? 'cursor-cell' : ''}`}
                    style={{ height: gridHeight }}
                    onClick={(e) => handleCellClick(dayIndex, hall.id, e)}
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
                          style={{ top: row.top }}
                        />
                      )
                    ))}

                    {hallClosures.map((closure, idx) => (
                      <ClosureOverlay key={`${closure.id}-${idx}`} reason={closure.reason} />
                    ))}

                    {overlapGroupsByKey.has(dayHallKey) && (
                      <button
                        className="absolute right-0.5 top-0.5 z-50 flex h-5 w-5 items-center justify-center rounded bg-gray-700/60 text-white hover:bg-gray-700/80"
                        onClick={(e) => { e.stopPropagation(); handleSwap(dayHallKey) }}
                        title={t('switchOverlap')}
                        aria-label={t('switchOverlap')}
                      >
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4" />
                        </svg>
                      </button>
                    )}

                    {hallSlots.map((ps) => {
                      // Compute hall span for multi-hall slots
                      const spanIds = ps.slot._virtual?.spanHallIds
                      const span = spanIds
                        ? spanIds.filter((hid) => dayHalls.some((h) => h.id === hid)).length
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
                          compact={true}
                          isBoosted={boostedMap.get(dayHallKey) === ps.slot.id}
                          hallSpan={span}
                          onClick={() => onSlotClick(ps.slot)}
                        />
                      )
                    })}
                  </div>
                )
              })
            }

            // Single hall mode — original layout
            const daySlots = positioned.filter((ps) => ps.dayIndex === dayIndex)
            const dayClos = closuresByDayHall.get(`${dayIndex}:${visibleHalls[0]?.id}`) ?? []

            return (
              <div
                key={dayIndex}
                className={`relative border-r-2 border-gray-300 last:border-r-0 dark:border-gray-600 ${(isAdmin || isCoach) ? 'cursor-cell' : ''}`}
                style={{ height: gridHeight }}
                onClick={(e) => handleCellClick(dayIndex, visibleHalls[0]?.id ?? '', e)}
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
                      style={{ top: row.top }}
                    />
                  )
                ))}

                {dayClos.map((closure, idx) => (
                  <ClosureOverlay key={`${closure.id}-${idx}`} reason={closure.reason} />
                ))}

                {(() => {
                  const singleHallKey = `${dayIndex}:${visibleHalls[0]?.id}`
                  return (
                    <>
                      {overlapGroupsByKey.has(singleHallKey) && (
                        <button
                          className="absolute right-1 top-1 z-50 flex h-6 w-6 items-center justify-center rounded bg-gray-700/60 text-white hover:bg-gray-700/80"
                          onClick={(e) => { e.stopPropagation(); handleSwap(singleHallKey) }}
                          title={t('switchOverlap')}
                          aria-label={t('switchOverlap')}
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4" />
                          </svg>
                        </button>
                      )}
                      {daySlots.map((ps) => (
                        <SlotBlock
                          key={ps.slot.id}
                          positioned={ps}
                          teamName={getTeamName(ps.slot)}
                          teamSport={getTeamSport(ps.slot)}
                          hasConflict={conflictSet.has(ps.slot.id)}
                          isAdmin={isAdmin}
                          isCoach={isCoach}
                          coachTeamIds={coachTeamIds}
                          compact={false}
                          isBoosted={boostedMap.get(singleHallKey) === ps.slot.id}
                          onClick={() => onSlotClick(ps.slot)}
                        />
                      ))}
                    </>
                  )
                })()}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
