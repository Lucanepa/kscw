import { useMemo } from 'react'
import type { HallSlot, HallClosure, Hall } from '../../../types'
import { toISODate, minutesToTime } from '../../../utils/dateHelpers'
import { positionSlots, generateTimeLabels, SLOT_HEIGHT, TOTAL_ROWS, topToMinutes, START_HOUR, SLOT_MINUTES } from '../utils/timeGrid'
import { buildConflictSet } from '../utils/conflictDetection'
import SlotBlock from './SlotBlock'
import ClosureOverlay from './ClosureOverlay'

interface DaySlotViewProps {
  slots: HallSlot[]
  closures: HallClosure[]
  day: Date
  dayIndex: number
  halls: Hall[]
  selectedHallId: string
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
  selectedHallId,
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

  const positioned = useMemo(() => positionSlots(daySlots), [daySlots])
  const conflictSet = useMemo(() => buildConflictSet(daySlots), [daySlots])
  const gridHeight = TOTAL_ROWS * SLOT_HEIGHT

  // Check closures for this day
  const dayClosures = useMemo(() => {
    const dayStr = toISODate(day)
    return closures.filter(
      (c) => dayStr >= c.start_date.split(' ')[0] && dayStr <= c.end_date.split(' ')[0],
    )
  }, [closures, day])

  function handleDayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!isAdmin) return
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const minutes = topToMinutes(y)
    const snapped = Math.floor(minutes / SLOT_MINUTES) * SLOT_MINUTES
    if (snapped < START_HOUR * 60) return
    const time = minutesToTime(snapped)
    onEmptyCellClick(dayIndex, time, selectedHallId || (halls[0]?.id ?? ''))
  }

  function getTeamName(slot: HallSlot): string {
    const expanded = (slot as Record<string, unknown>).expand as
      | Record<string, Record<string, unknown>>
      | undefined
    return (expanded?.team?.name as string) ?? ''
  }

  function getHallName(closure: HallClosure): string {
    const expanded = (closure as Record<string, unknown>).expand as
      | Record<string, Record<string, unknown>>
      | undefined
    return (expanded?.hall?.name as string) ?? ''
  }

  return (
    <div className="overflow-y-auto rounded-lg bg-white shadow-sm dark:bg-gray-800">
      {/* Time grid body */}
      <div className="grid" style={{ gridTemplateColumns: '40px 1fr' }}>
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

        {/* Day column */}
        <div
          className={`relative ${isAdmin ? 'cursor-cell' : ''}`}
          style={{ height: gridHeight }}
          onClick={handleDayClick}
        >
          {/* Grid lines */}
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

          {/* Closure overlays */}
          {dayClosures.map((closure, idx) => (
            <ClosureOverlay
              key={`${closure.id}-${idx}`}
              reason={closure.reason}
              hallName={!selectedHallId ? getHallName(closure) : undefined}
            />
          ))}

          {/* Slot blocks */}
          {positioned.map((ps) => (
            <SlotBlock
              key={ps.slot.id}
              positioned={ps}
              teamName={getTeamName(ps.slot)}
              hasConflict={conflictSet.has(ps.slot.id)}
              isAdmin={isAdmin}
              onClick={() => onSlotClick(ps.slot)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
