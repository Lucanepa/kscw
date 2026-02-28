import { timeToMinutes } from '../../../utils/dateHelpers'
import type { HallSlot } from '../../../types'

export const START_HOUR = 10
export const END_HOUR = 22
export const SLOT_MINUTES = 15 // minutes per grid row
export const SLOT_HEIGHT = 16 // px per 15-min row
export const TOTAL_ROWS = (END_HOUR - START_HOUR) * (60 / SLOT_MINUTES)

/** Per-day active time ranges (in minutes from midnight) */
const WEEKDAY_START = 16 * 60       // 16:00
const WEEKDAY_END = 22 * 60         // 22:00
const WEEKEND_START = 10 * 60 + 30  // 10:30
const WEEKEND_END = 20 * 60         // 20:00

/** Returns active time range [startMin, endMin] for a day index (0=Mon..6=Sun) */
export function getDayRange(dayIndex: number): { startMin: number; endMin: number } {
  const isWeekend = dayIndex === 5 || dayIndex === 6
  return {
    startMin: isWeekend ? WEEKEND_START : WEEKDAY_START,
    endMin: isWeekend ? WEEKEND_END : WEEKDAY_END,
  }
}

export interface PositionedSlot {
  slot: HallSlot
  top: number          // px from grid top
  height: number       // px
  left: number         // percentage (0-100)
  width: number        // percentage (0-100)
  dayIndex: number     // 0=Mon..6=Sun
}

/** Converts a time string to pixel offset from grid top */
export function timeToTop(time: string): number {
  const minutes = timeToMinutes(time)
  return ((minutes - START_HOUR * 60) / SLOT_MINUTES) * SLOT_HEIGHT
}

/** Converts a pixel offset from grid top to minutes since midnight */
export function topToMinutes(top: number): number {
  return Math.round(top / SLOT_HEIGHT) * SLOT_MINUTES + START_HOUR * 60
}

/**
 * Positions slots within each day column, handling overlaps with sub-column layout.
 * Uses a greedy interval coloring algorithm.
 */
export function positionSlots(slots: HallSlot[]): PositionedSlot[] {
  // Group by day_of_week
  const byDay = new Map<number, HallSlot[]>()
  for (const slot of slots) {
    const group = byDay.get(slot.day_of_week) ?? []
    group.push(slot)
    byDay.set(slot.day_of_week, group)
  }

  const result: PositionedSlot[] = []

  for (const [day, daySlots] of byDay) {
    // Sort by start_time, then by duration descending
    const sorted = [...daySlots].sort((a, b) => {
      const diff = timeToMinutes(a.start_time) - timeToMinutes(b.start_time)
      if (diff !== 0) return diff
      return (timeToMinutes(b.end_time) - timeToMinutes(b.start_time)) -
             (timeToMinutes(a.end_time) - timeToMinutes(a.start_time))
    })

    // Greedy column assignment: track end_time (minutes) of last slot in each sub-column
    const columns: number[] = []
    const assignments = new Map<string, number>()

    for (const slot of sorted) {
      const startMin = timeToMinutes(slot.start_time)
      let placed = false
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= startMin) {
          columns[c] = timeToMinutes(slot.end_time)
          assignments.set(slot.id, c)
          placed = true
          break
        }
      }
      if (!placed) {
        assignments.set(slot.id, columns.length)
        columns.push(timeToMinutes(slot.end_time))
      }
    }

    const totalCols = Math.max(columns.length, 1)

    for (const slot of sorted) {
      const subCol = assignments.get(slot.id)!
      const startMin = timeToMinutes(slot.start_time)
      const endMin = timeToMinutes(slot.end_time)

      result.push({
        slot,
        top: ((startMin - START_HOUR * 60) / SLOT_MINUTES) * SLOT_HEIGHT,
        height: ((endMin - startMin) / SLOT_MINUTES) * SLOT_HEIGHT,
        left: (subCol / totalCols) * 100,
        width: (1 / totalCols) * 100,
        dayIndex: day,
      })
    }
  }

  return result
}

/**
 * Positions slots grouped by (day, hall). Within each hall column, uses greedy overlap.
 * `left`/`width` are percentages within the hall sub-column.
 */
export function positionSlotsMultiHall(slots: HallSlot[]): PositionedSlot[] {
  // Group by (day_of_week, hall)
  const byDayHall = new Map<string, HallSlot[]>()
  for (const slot of slots) {
    const key = `${slot.day_of_week}:${slot.hall}`
    const group = byDayHall.get(key) ?? []
    group.push(slot)
    byDayHall.set(key, group)
  }

  const result: PositionedSlot[] = []

  for (const [key, groupSlots] of byDayHall) {
    const day = Number(key.split(':')[0])

    const sorted = [...groupSlots].sort((a, b) => {
      const diff = timeToMinutes(a.start_time) - timeToMinutes(b.start_time)
      if (diff !== 0) return diff
      return (timeToMinutes(b.end_time) - timeToMinutes(b.start_time)) -
             (timeToMinutes(a.end_time) - timeToMinutes(a.start_time))
    })

    const columns: number[] = []
    const assignments = new Map<string, number>()

    for (const slot of sorted) {
      const startMin = timeToMinutes(slot.start_time)
      let placed = false
      for (let c = 0; c < columns.length; c++) {
        if (columns[c] <= startMin) {
          columns[c] = timeToMinutes(slot.end_time)
          assignments.set(slot.id, c)
          placed = true
          break
        }
      }
      if (!placed) {
        assignments.set(slot.id, columns.length)
        columns.push(timeToMinutes(slot.end_time))
      }
    }

    const totalCols = Math.max(columns.length, 1)

    for (const slot of sorted) {
      const subCol = assignments.get(slot.id)!
      const startMin = timeToMinutes(slot.start_time)
      const endMin = timeToMinutes(slot.end_time)

      result.push({
        slot,
        top: ((startMin - START_HOUR * 60) / SLOT_MINUTES) * SLOT_HEIGHT,
        height: ((endMin - startMin) / SLOT_MINUTES) * SLOT_HEIGHT,
        left: (subCol / totalCols) * 100,
        width: (1 / totalCols) * 100,
        dayIndex: day,
      })
    }
  }

  return result
}

/** Generates time labels for the grid (every SLOT_MINUTES from START_HOUR to END_HOUR) */
export function generateTimeLabels(): { time: string; isFullHour: boolean }[] {
  const labels: { time: string; isFullHour: boolean }[] = []
  for (let h = START_HOUR; h < END_HOUR; h++) {
    for (let m = 0; m < 60; m += SLOT_MINUTES) {
      labels.push({
        time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        isFullHour: m === 0,
      })
    }
  }
  return labels
}
