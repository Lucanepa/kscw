import { useMemo } from 'react'
import type { HallSlot, HallClosure, Hall } from '../../../types'
import { toISODate, minutesToTime } from '../../../utils/dateHelpers'
import { positionSlotsMultiHall, generateTimeLabels, SLOT_HEIGHT, TOTAL_ROWS, topToMinutes, START_HOUR, SLOT_MINUTES, getDayRange } from '../utils/timeGrid'
import { buildConflictSet } from '../utils/conflictDetection'
import SlotBlock from './SlotBlock'
import ClosureOverlay from './ClosureOverlay'

interface DaySlotViewProps {
  slots: HallSlot[]
  closures: HallClosure[]
  day: Date
  dayIndex: number
  halls: Hall[]
  selectedHallIds: string[]
  isAdmin: boolean
  onSlotClick: (slot: HallSlot) => void
  onEmptyCellClick: (dayOfWeek: number, time: string, hallId: string) => void
}

export default function DaySlotView({
  slots,
  closures,
  day,
  dayIndex,
  halls,
  selectedHallIds,
  isAdmin,
  onSlotClick,
  onEmptyCellClick,
}: DaySlotViewProps) {
  const timeLabels = useMemo(() => generateTimeLabels(), [])

  // Filter slots for the selected day only
  const daySlots = useMemo(
    () => slots.filter((s) => s.day_of_week === dayIndex),
    [slots, dayIndex],
  )

  const positioned = useMemo(() => positionSlotsMultiHall(daySlots), [daySlots])
  const conflictSet = useMemo(() => buildConflictSet(daySlots), [daySlots])
  const gridHeight = TOTAL_ROWS * SLOT_HEIGHT

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
    const activeHallIds = new Set([...hallsWithSlots, ...hallsWithClosures])
    const filtered = selectedHallIds.length > 0
      ? halls.filter((h) => selectedHallIds.includes(h.id))
      : halls.filter((h) => activeHallIds.has(h.id))
    return filtered.length > 0 ? filtered : halls.slice(0, 1)
  }, [halls, daySlots, closures, day, selectedHallIds])

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

  function handleCellClick(hallId: string, e: React.MouseEvent<HTMLDivElement>) {
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
    const expanded = (slot as Record<string, unknown>).expand as
      | Record<string, Record<string, unknown>>
      | undefined
    return (expanded?.team?.name as string) ?? ''
  }

  const { startMin, endMin } = getDayRange(dayIndex)
  const inactiveTopH = ((startMin - START_HOUR * 60) / SLOT_MINUTES) * SLOT_HEIGHT
  const inactiveBottomTop = ((endMin - START_HOUR * 60) / SLOT_MINUTES) * SLOT_HEIGHT
  const inactiveBottomH = gridHeight - inactiveBottomTop

  return (
    <div className="overflow-y-auto rounded-lg bg-white shadow-sm dark:bg-gray-800">
      {/* Hall sub-headers (only when multi-hall) */}
      {multiHall && (
        <div
          className="grid border-b border-gray-200 dark:border-gray-700"
          style={{ gridTemplateColumns: `40px repeat(${visibleHalls.length}, 1fr)` }}
        >
          <div className="border-r border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900" />
          {visibleHalls.map((hall) => (
            <div
              key={hall.id}
              className="border-r border-gray-100 px-1 py-1.5 text-center text-xs font-medium text-gray-600 last:border-r-0 dark:border-gray-800 dark:text-gray-400"
            >
              {hall.name.replace(/^KWI /, '')}
            </div>
          ))}
        </div>
      )}

      {/* Time grid body */}
      <div
        className="grid"
        style={{ gridTemplateColumns: multiHall ? `40px repeat(${visibleHalls.length}, 1fr)` : '40px 1fr' }}
      >
        {/* Time labels column */}
        <div className="border-r border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900">
          {timeLabels.map(({ time, isFullHour }) => (
            <div
              key={time}
              className={`flex items-start justify-end pr-1 text-[10px] ${
                isFullHour
                  ? 'font-medium text-gray-500 dark:text-gray-400'
                  : 'text-gray-300 dark:text-gray-600'
              }`}
              style={{ height: SLOT_HEIGHT }}
            >
              {isFullHour ? time : ''}
            </div>
          ))}
        </div>

        {/* Hall columns */}
        {visibleHalls.map((hall) => {
          const hallSlots = slotsByHall.get(hall.id) ?? []
          const hallClosures = closuresByHall.get(hall.id) ?? []

          return (
            <div
              key={hall.id}
              className={`relative border-r border-gray-100 last:border-r-0 dark:border-gray-800 ${isAdmin ? 'cursor-cell' : ''}`}
              style={{ height: gridHeight }}
              onClick={(e) => handleCellClick(hall.id, e)}
            >
              {inactiveTopH > 0 && (
                <div className="absolute inset-x-0 top-0 z-10 bg-gray-100/60 dark:bg-gray-900/40" style={{ height: inactiveTopH }} />
              )}
              {inactiveBottomH > 0 && (
                <div className="absolute inset-x-0 bottom-0 z-10 bg-gray-100/60 dark:bg-gray-900/40" style={{ height: inactiveBottomH }} />
              )}

              {timeLabels.map(({ time, isFullHour }, idx) => (
                <div
                  key={time}
                  className={`absolute inset-x-0 ${
                    isFullHour
                      ? 'border-b border-gray-200 dark:border-gray-700'
                      : 'border-b border-dashed border-gray-100 dark:border-gray-800'
                  }`}
                  style={{ top: idx * SLOT_HEIGHT, height: SLOT_HEIGHT }}
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
                  compact={multiHall}
                  onClick={() => onSlotClick(ps.slot)}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
