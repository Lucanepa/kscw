import { useMemo } from 'react'
import type { HallSlot, HallClosure, Hall } from '../../../types'
import { toISODate, minutesToTime } from '../../../utils/dateHelpers'
import { positionSlotsMultiHall, generateTimeLabels, SLOT_HEIGHT, TOTAL_ROWS, topToMinutes, START_HOUR, SLOT_MINUTES, getDayRange } from '../utils/timeGrid'
import { buildConflictSet } from '../utils/conflictDetection'
import SlotBlock from './SlotBlock'
import ClosureOverlay from './ClosureOverlay'

const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

interface WeekSlotViewProps {
  slots: HallSlot[]
  closures: HallClosure[]
  weekDays: Date[]
  halls: Hall[]
  selectedHallIds: string[]
  isAdmin: boolean
  isCoach?: boolean
  onSlotClick: (slot: HallSlot) => void
  onEmptyCellClick: (dayOfWeek: number, time: string, hallId: string) => void
}

export default function WeekSlotView({
  slots,
  closures,
  weekDays,
  halls,
  selectedHallIds,
  isAdmin,
  isCoach = false,
  onSlotClick,
  onEmptyCellClick,
}: WeekSlotViewProps) {
  const timeLabels = useMemo(() => generateTimeLabels(), [])
  const conflictSet = useMemo(() => buildConflictSet(slots), [slots])
  const gridHeight = TOTAL_ROWS * SLOT_HEIGHT

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

  const multiHall = visibleHalls.length > 1

  // Position slots using multi-hall grouping when multiple halls visible
  const positioned = useMemo(
    () => positionSlotsMultiHall(slots),
    [slots],
  )

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

  // Determine which days have content (slots or closures) — hide empty days
  const visibleDays = useMemo(() => {
    if (!multiHall) return [0, 1, 2, 3, 4, 5, 6]
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
    return Array.from(daysWithContent).sort((a, b) => a - b)
  }, [multiHall, positioned, closures, weekDays])

  const todayIndex = useMemo(() => {
    const today = toISODate(new Date())
    return weekDays.findIndex((d) => toISODate(d) === today)
  }, [weekDays])

  // Grid template: time label + (day × halls) columns
  const totalDataCols = multiHall
    ? visibleDays.length * visibleHalls.length
    : visibleDays.length

  function handleCellClick(dayIndex: number, hallId: string, e: React.MouseEvent<HTMLDivElement>) {
    if (!isAdmin) return
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const minutes = topToMinutes(y)
    const snapped = Math.floor(minutes / SLOT_MINUTES) * SLOT_MINUTES
    if (snapped < START_HOUR * 60) return
    const time = minutesToTime(snapped)
    onEmptyCellClick(dayIndex, time, hallId)
  }

  function getTeamName(slot: HallSlot): string {
    const expanded = (slot as Record<string, unknown>).expand as Record<string, Record<string, unknown>> | undefined
    return (expanded?.team?.name as string) ?? ''
  }

  return (
    <div className="rounded-lg bg-white shadow-sm dark:bg-gray-800">
      <div className="min-w-[700px] overflow-x-auto">
        {/* Day headers row */}
        <div
          className="grid border-b border-gray-200 dark:border-gray-700"
          style={{ gridTemplateColumns: `60px repeat(${totalDataCols}, 1fr)` }}
        >
          <div className="border-r border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900" />
          {visibleDays.map((dayIndex) => {
            const day = weekDays[dayIndex]
            const dateStr = `${String(day.getDate()).padStart(2, '0')}.${String(day.getMonth() + 1).padStart(2, '0')}.`
            const colSpan = multiHall ? visibleHalls.length : 1
            return (
              <div
                key={dayIndex}
                className={`border-r border-gray-200 p-1 text-center text-sm last:border-r-0 dark:border-gray-700 ${
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
            {visibleDays.map((dayIndex) =>
              visibleHalls.map((hall, hi) => (
                <div
                  key={`${dayIndex}-${hall.id}`}
                  className={`border-r border-gray-100 px-0.5 py-0.5 text-center text-[10px] font-medium text-gray-500 dark:border-gray-800 dark:text-gray-400 ${
                    hi === visibleHalls.length - 1 ? 'border-r-gray-200 dark:border-r-gray-700' : ''
                  }`}
                >
                  {hall.name}
                </div>
              )),
            )}
          </div>
        )}

        {/* Time grid body */}
        <div
          className="grid"
          style={{ gridTemplateColumns: `60px repeat(${totalDataCols}, 1fr)` }}
        >
          {/* Time labels column */}
          <div className="sticky left-0 z-30 border-r border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900">
            {timeLabels.map(({ time, isFullHour }) => (
              <div
                key={time}
                className={`flex items-start justify-end pr-2 text-xs ${
                  isFullHour ? 'font-medium text-gray-500 dark:text-gray-400' : 'text-gray-300'
                }`}
                style={{ height: SLOT_HEIGHT }}
              >
                {isFullHour ? time : ''}
              </div>
            ))}
          </div>

          {/* Day × Hall columns */}
          {visibleDays.map((dayIndex) => {
            const { startMin, endMin } = getDayRange(dayIndex)
            const inactiveTopH = ((startMin - START_HOUR * 60) / SLOT_MINUTES) * SLOT_HEIGHT
            const inactiveBottomTop = ((endMin - START_HOUR * 60) / SLOT_MINUTES) * SLOT_HEIGHT
            const inactiveBottomH = gridHeight - inactiveBottomTop

            if (multiHall) {
              return visibleHalls.map((hall, hi) => {
                const dayHallKey = `${dayIndex}:${hall.id}`
                const hallSlots = slotsByDayHall.get(dayHallKey) ?? []
                const hallClosures = closuresByDayHall.get(dayHallKey) ?? []
                const isLastInDay = hi === visibleHalls.length - 1

                return (
                  <div
                    key={dayHallKey}
                    className={`relative ${isLastInDay ? 'border-r border-gray-200 dark:border-gray-700' : 'border-r border-gray-100 dark:border-r-gray-800'} ${isAdmin ? 'cursor-cell' : ''}`}
                    style={{ height: gridHeight }}
                    onClick={(e) => handleCellClick(dayIndex, hall.id, e)}
                  >
                    {inactiveTopH > 0 && (
                      <div className="absolute inset-x-0 top-0 z-10 bg-gray-100/60 dark:bg-gray-900/40" style={{ height: inactiveTopH }} />
                    )}
                    {inactiveBottomH > 0 && (
                      <div className="absolute inset-x-0 bottom-0 z-10 bg-gray-100/60 dark:bg-gray-900/40" style={{ height: inactiveBottomH }} />
                    )}

                    {timeLabels.map(({ time, isFullHour }, rowIndex) => (
                      <div
                        key={time}
                        className={`absolute inset-x-0 ${
                          isFullHour
                            ? 'border-b border-gray-200 dark:border-gray-700'
                            : 'border-b border-dashed border-gray-100 dark:border-gray-800'
                        }`}
                        style={{ top: rowIndex * SLOT_HEIGHT }}
                      />
                    ))}

                    {hallClosures.map((closure, idx) => (
                      <ClosureOverlay key={`${closure.id}-${idx}`} reason={closure.reason} />
                    ))}

                    {hallSlots.map((ps) => (
                      <SlotBlock
                        key={ps.slot.id}
                        positioned={ps}
                        teamName={getTeamName(ps.slot)}
                        hasConflict={conflictSet.has(ps.slot.id)}
                        isAdmin={isAdmin}
                        isCoach={isCoach}
                        compact={true}
                        onClick={() => onSlotClick(ps.slot)}
                      />
                    ))}
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
                className={`relative border-r border-gray-200 last:border-r-0 dark:border-gray-700 ${isAdmin ? 'cursor-cell' : ''}`}
                style={{ height: gridHeight }}
                onClick={(e) => handleCellClick(dayIndex, visibleHalls[0]?.id ?? '', e)}
              >
                {inactiveTopH > 0 && (
                  <div className="absolute inset-x-0 top-0 z-10 bg-gray-100/60 dark:bg-gray-900/40" style={{ height: inactiveTopH }} />
                )}
                {inactiveBottomH > 0 && (
                  <div className="absolute inset-x-0 bottom-0 z-10 bg-gray-100/60 dark:bg-gray-900/40" style={{ height: inactiveBottomH }} />
                )}

                {timeLabels.map(({ time, isFullHour }, rowIndex) => (
                  <div
                    key={time}
                    className={`absolute inset-x-0 ${
                      isFullHour
                        ? 'border-b border-gray-200 dark:border-gray-700'
                        : 'border-b border-dashed border-gray-100 dark:border-gray-800'
                    }`}
                    style={{ top: rowIndex * SLOT_HEIGHT }}
                  />
                ))}

                {dayClos.map((closure, idx) => (
                  <ClosureOverlay key={`${closure.id}-${idx}`} reason={closure.reason} />
                ))}

                {daySlots.map((ps) => (
                  <SlotBlock
                    key={ps.slot.id}
                    positioned={ps}
                    teamName={getTeamName(ps.slot)}
                    hasConflict={conflictSet.has(ps.slot.id)}
                    isAdmin={isAdmin}
                    isCoach={isCoach}
                    compact={false}
                    onClick={() => onSlotClick(ps.slot)}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
