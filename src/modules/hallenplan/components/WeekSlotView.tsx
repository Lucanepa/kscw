import { useMemo } from 'react'
import type { HallSlot, HallClosure, Hall } from '../../../types'
import { toISODate, minutesToTime } from '../../../utils/dateHelpers'
import { positionSlots, generateTimeLabels, SLOT_HEIGHT, TOTAL_ROWS, topToMinutes, START_HOUR } from '../utils/timeGrid'
import { buildConflictSet } from '../utils/conflictDetection'
import SlotBlock from './SlotBlock'
import ClosureOverlay from './ClosureOverlay'

const DAY_HEADERS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const

interface WeekSlotViewProps {
  slots: HallSlot[]
  closures: HallClosure[]
  weekDays: Date[]
  halls: Hall[]
  selectedHallId: string
  isAdmin: boolean
  onSlotClick: (slot: HallSlot) => void
  onEmptyCellClick: (dayOfWeek: number, time: string, hallId: string) => void
}

export default function WeekSlotView({
  slots,
  closures,
  weekDays,
  halls,
  selectedHallId,
  isAdmin,
  onSlotClick,
  onEmptyCellClick,
}: WeekSlotViewProps) {
  const timeLabels = useMemo(() => generateTimeLabels(), [])
  const positioned = useMemo(() => positionSlots(slots), [slots])
  const conflictSet = useMemo(() => buildConflictSet(slots), [slots])
  const gridHeight = TOTAL_ROWS * SLOT_HEIGHT

  // Determine which days have closures
  const closuresByDay = useMemo(() => {
    const map = new Map<number, HallClosure[]>()
    for (const closure of closures) {
      for (let i = 0; i < 7; i++) {
        const dayStr = toISODate(weekDays[i])
        if (dayStr >= closure.start_date && dayStr <= closure.end_date) {
          const existing = map.get(i) ?? []
          existing.push(closure)
          map.set(i, existing)
        }
      }
    }
    return map
  }, [closures, weekDays])

  const todayIndex = useMemo(() => {
    const today = toISODate(new Date())
    return weekDays.findIndex((d) => toISODate(d) === today)
  }, [weekDays])

  // Group positioned slots by day for rendering in day columns
  const slotsByDay = useMemo(() => {
    const map = new Map<number, typeof positioned>()
    for (const ps of positioned) {
      const group = map.get(ps.dayIndex) ?? []
      group.push(ps)
      map.set(ps.dayIndex, group)
    }
    return map
  }, [positioned])

  function handleDayClick(dayIndex: number, e: React.MouseEvent<HTMLDivElement>) {
    if (!isAdmin) return
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const minutes = topToMinutes(y)
    // Snap to 30-min intervals
    const snapped = Math.floor(minutes / 30) * 30
    if (snapped < START_HOUR * 60) return
    const time = minutesToTime(snapped)
    onEmptyCellClick(dayIndex, time, selectedHallId || (halls[0]?.id ?? ''))
  }

  function getTeamName(slot: HallSlot): string {
    const expanded = (slot as Record<string, unknown>).expand as Record<string, Record<string, unknown>> | undefined
    return (expanded?.team?.name as string) ?? ''
  }

  function getHallName(closure: HallClosure): string {
    const expanded = (closure as Record<string, unknown>).expand as Record<string, Record<string, unknown>> | undefined
    return (expanded?.hall?.name as string) ?? ''
  }

  return (
    <div className="overflow-x-auto rounded-lg bg-white shadow-sm">
      <div className="min-w-[700px]">
        {/* Day headers */}
        <div className="grid border-b" style={{ gridTemplateColumns: '60px repeat(7, 1fr)' }}>
          <div className="border-r bg-gray-50 p-2" />
          {weekDays.map((day, i) => {
            const dateStr = `${String(day.getDate()).padStart(2, '0')}.${String(day.getMonth() + 1).padStart(2, '0')}.`
            return (
              <div
                key={i}
                className={`border-r p-2 text-center text-sm last:border-r-0 ${
                  i === todayIndex ? 'bg-blue-50 font-bold text-blue-700' : 'text-gray-700'
                }`}
              >
                <div className="font-medium">{DAY_HEADERS[i]}</div>
                <div className="text-xs">{dateStr}</div>
              </div>
            )
          })}
        </div>

        {/* Time grid body */}
        <div className="grid" style={{ gridTemplateColumns: '60px repeat(7, 1fr)' }}>
          {/* Time labels column */}
          <div className="sticky left-0 z-30 border-r bg-gray-50">
            {timeLabels.map(({ time, isFullHour }) => (
              <div
                key={time}
                className={`flex items-start justify-end pr-2 text-xs ${
                  isFullHour ? 'font-medium text-gray-500' : 'text-gray-300'
                }`}
                style={{ height: SLOT_HEIGHT }}
              >
                {isFullHour ? time : ''}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {weekDays.map((_, dayIndex) => (
            <div
              key={dayIndex}
              className={`relative border-r last:border-r-0 ${isAdmin ? 'cursor-cell' : ''}`}
              style={{ height: gridHeight }}
              onClick={(e) => handleDayClick(dayIndex, e)}
            >
              {/* Grid lines */}
              {timeLabels.map(({ time, isFullHour }) => {
                const rowIndex = timeLabels.indexOf(timeLabels.find((l) => l.time === time)!)
                return (
                  <div
                    key={time}
                    className={`absolute inset-x-0 ${isFullHour ? 'border-b border-gray-200' : 'border-b border-dashed border-gray-100'}`}
                    style={{ top: rowIndex * SLOT_HEIGHT, height: SLOT_HEIGHT }}
                  />
                )
              })}

              {/* Closure overlays */}
              {closuresByDay.get(dayIndex)?.map((closure, idx) => (
                <ClosureOverlay
                  key={`${closure.id}-${idx}`}
                  reason={closure.reason}
                  hallName={!selectedHallId ? getHallName(closure) : undefined}
                />
              ))}

              {/* Slot blocks */}
              {slotsByDay.get(dayIndex)?.map((ps) => (
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
          ))}
        </div>
      </div>
    </div>
  )
}
