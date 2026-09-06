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
export function timeToTop(time: string, baseMinute = START_HOUR * 60): number {
  const minutes = timeToMinutes(time)
  return ((minutes - baseMinute) / SLOT_MINUTES) * SLOT_HEIGHT
}

/** Converts a pixel offset from grid top to minutes since midnight */
export function topToMinutes(top: number, baseMinute = START_HOUR * 60): number {
  return Math.round(top / SLOT_HEIGHT) * SLOT_MINUTES + baseMinute
}

/**
 * Positions slots within each day column. Overlapping slots stack on top of each other
 * (full width) instead of being placed side-by-side.
 */
export function positionSlots(slots: HallSlot[], baseMinute = START_HOUR * 60): PositionedSlot[] {
  const result: PositionedSlot[] = []

  for (const slot of slots) {
    const startMin = timeToMinutes(slot.start_time)
    const endMin = timeToMinutes(slot.end_time)

    result.push({
      slot,
      top: ((startMin - baseMinute) / SLOT_MINUTES) * SLOT_HEIGHT,
      height: ((endMin - startMin) / SLOT_MINUTES) * SLOT_HEIGHT,
      left: 0,
      width: 100,
      dayIndex: slot.day_of_week,
    })
  }

  return result
}

/**
 * Positions slots grouped by (day, hall). Overlapping slots in the same hall
 * stack on top of each other (full width) instead of being placed side-by-side.
 */
export function positionSlotsMultiHall(slots: HallSlot[], baseMinute = START_HOUR * 60): PositionedSlot[] {
  const result: PositionedSlot[] = []

  for (const slot of slots) {
    const startMin = timeToMinutes(slot.start_time)
    const endMin = timeToMinutes(slot.end_time)

    result.push({
      slot,
      top: ((startMin - baseMinute) / SLOT_MINUTES) * SLOT_HEIGHT,
      height: ((endMin - startMin) / SLOT_MINUTES) * SLOT_HEIGHT,
      left: 0,
      width: 100,
      dayIndex: slot.day_of_week,
    })
  }

  return result
}

/** Generates time labels for the grid (every SLOT_MINUTES from startHour to endHour) */
export function generateTimeLabels(startHour = START_HOUR, endHour = END_HOUR): { time: string; isFullHour: boolean }[] {
  const labels: { time: string; isFullHour: boolean }[] = []
  for (let h = startHour; h < endHour; h++) {
    for (let m = 0; m < 60; m += SLOT_MINUTES) {
      labels.push({
        time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        isFullHour: m === 0,
      })
    }
  }
  return labels
}

/** Compute a smart visible start hour for a day based on actual slots (30min before earliest slot, floored to hour) */
export function getSmartStartHour(daySlots: HallSlot[], dayIndex: number): number {
  if (daySlots.length === 0) return getDayRange(dayIndex).startMin / 60 | 0
  let earliest = Infinity
  for (const s of daySlots) {
    earliest = Math.min(earliest, timeToMinutes(s.start_time))
  }
  // 30 min before earliest, floored to the hour
  return Math.max(Math.floor((earliest - 30) / 60), START_HOUR)
}

/** Compute a smart visible end hour for a day based on actual slots (ceiled to hour after latest slot) */
export function getSmartEndHour(daySlots: HallSlot[], dayIndex: number): number {
  if (daySlots.length === 0) return Math.ceil(getDayRange(dayIndex).endMin / 60)
  let latest = -Infinity
  for (const s of daySlots) {
    latest = Math.max(latest, timeToMinutes(s.end_time))
  }
  return Math.min(Math.ceil(latest / 60), END_HOUR)
}

// ── Collapsed-gap time axis ──────────────────────────────────────────
// The grid used to be one linear minute→pixel map, so a week whose halls sit
// empty from 11:00 to 16:00 rendered five hours of blank rows and pushed the
// evening — the only part anyone reads — below the fold. The axis below is
// piecewise: stretches with nothing in them, ON ANY DAY IN ANY HALL, collapse
// to a single band.
//
// ⚠ The inverse (`axisTopToMinutes`) is what click-to-create reads. It has to
// stay the exact inverse of `axisTimeToTop` or clicking an empty cell prefills
// the slot editor with the wrong time — silently, since both numbers look
// plausible. The round-trip is pinned by tests.

/** A gap must be at least this long, AFTER snapping to whole hours, to collapse. */
export const MIN_COLLAPSIBLE_MINUTES = 120
/** Rendered height of one collapsed band. */
export const BREAK_HEIGHT = 22

export interface TimeAxisSegment {
  startMin: number
  endMin: number
  collapsed: boolean
  top: number
  height: number
}

export interface TimeAxisRow {
  time: string
  isFullHour: boolean
  isBreak: boolean
  top: number
  height: number
  /** Break rows only: the end of the skipped range, for the label. */
  breakEndTime?: string
  /** Break rows only: stable key for the caller's "expand this one" set. */
  breakKey?: string
}

export interface TimeAxis {
  segments: TimeAxisSegment[]
  rows: TimeAxisRow[]
  totalHeight: number
  startMin: number
  endMin: number
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

export const breakKeyOf = (startMin: number, endMin: number) => `${startMin}-${endMin}`

/**
 * Builds the axis for [startHour, endHour), collapsing every whole-hour gap of
 * at least `minGap` minutes that no busy interval touches.
 *
 * `busy` is every interval drawn in the view — across all days and halls, since
 * one column is enough to keep an hour open.
 * `forceExpanded` holds break keys the user clicked open.
 */
export function buildTimeAxis(
  busy: { startMin: number; endMin: number }[],
  startHour: number,
  endHour: number,
  forceExpanded: ReadonlySet<string> = new Set(),
  minGap = MIN_COLLAPSIBLE_MINUTES,
): TimeAxis {
  const startMin = startHour * 60
  const endMin = endHour * 60

  // Merge the busy intervals, clamped to the visible window.
  const merged: { startMin: number; endMin: number }[] = []
  for (const b of [...busy].sort((a, b) => a.startMin - b.startMin)) {
    const s = Math.max(b.startMin, startMin)
    const e = Math.min(b.endMin, endMin)
    if (e <= s) continue
    const last = merged[merged.length - 1]
    if (last && s <= last.endMin) last.endMin = Math.max(last.endMin, e)
    else merged.push({ startMin: s, endMin: e })
  }

  // Gaps between them become collapse candidates. Snapped INWARD to whole
  // hours so every expanded segment still starts on an hour and the 15-minute
  // label rows keep lining up with the hour rules.
  const collapsed: { startMin: number; endMin: number }[] = []
  let cursor = startMin
  for (const m of [...merged, { startMin: endMin, endMin }]) {
    const gapStart = Math.ceil(cursor / 60) * 60
    const gapEnd = Math.floor(m.startMin / 60) * 60
    if (gapEnd - gapStart >= minGap && !forceExpanded.has(breakKeyOf(gapStart, gapEnd))) {
      collapsed.push({ startMin: gapStart, endMin: gapEnd })
    }
    cursor = Math.max(cursor, m.endMin)
  }

  const segments: TimeAxisSegment[] = []
  const rows: TimeAxisRow[] = []
  let top = 0
  let at = startMin

  const pushExpanded = (from: number, to: number) => {
    if (to <= from) return
    const height = ((to - from) / SLOT_MINUTES) * SLOT_HEIGHT
    segments.push({ startMin: from, endMin: to, collapsed: false, top, height })
    for (let m = from; m < to; m += SLOT_MINUTES) {
      rows.push({
        time: hhmm(m),
        isFullHour: m % 60 === 0,
        isBreak: false,
        top: top + ((m - from) / SLOT_MINUTES) * SLOT_HEIGHT,
        height: SLOT_HEIGHT,
      })
    }
    top += height
  }

  for (const c of collapsed) {
    pushExpanded(at, c.startMin)
    segments.push({ startMin: c.startMin, endMin: c.endMin, collapsed: true, top, height: BREAK_HEIGHT })
    rows.push({
      time: hhmm(c.startMin),
      isFullHour: true,
      isBreak: true,
      top,
      height: BREAK_HEIGHT,
      breakEndTime: hhmm(c.endMin),
      breakKey: breakKeyOf(c.startMin, c.endMin),
    })
    top += BREAK_HEIGHT
    at = c.endMin
  }
  pushExpanded(at, endMin)

  return { segments, rows, totalHeight: top, startMin, endMin }
}

/** Minutes since midnight → px from the grid top. */
export function axisTimeToTop(axis: TimeAxis, minutes: number): number {
  if (minutes <= axis.startMin) return 0
  if (minutes >= axis.endMin) return axis.totalHeight
  for (const seg of axis.segments) {
    if (minutes < seg.startMin) return seg.top
    // `<` not `<=`: a segment's end IS the next one's start, and `<=` handed
    // 16:00 to the collapsed 11:00-16:00 band instead of to the evening
    // segment that actually begins there — every evening slot would have been
    // drawn at the break's y.
    if (minutes < seg.endMin) {
      if (seg.collapsed) return seg.top
      return seg.top + ((minutes - seg.startMin) / SLOT_MINUTES) * SLOT_HEIGHT
    }
  }
  return axis.totalHeight
}

/** px from the grid top → minutes since midnight. Inverse of `axisTimeToTop`. */
export function axisTopToMinutes(axis: TimeAxis, px: number): number {
  if (px <= 0) return axis.startMin
  for (const seg of axis.segments) {
    if (px < seg.top + seg.height) {
      if (seg.collapsed) return seg.startMin
      return seg.startMin + Math.round((px - seg.top) / SLOT_HEIGHT) * SLOT_MINUTES
    }
  }
  return axis.endMin
}

/** Positions slots on a piecewise axis. Heights follow the axis, so a slot
 *  never spans a collapsed band (nothing can be in one, by construction). */
export function positionSlotsOnAxis(slots: HallSlot[], axis: TimeAxis): PositionedSlot[] {
  return slots.map((slot) => {
    const top = axisTimeToTop(axis, timeToMinutes(slot.start_time))
    const bottom = axisTimeToTop(axis, timeToMinutes(slot.end_time))
    return {
      slot,
      top,
      height: Math.max(bottom - top, SLOT_HEIGHT / 2),
      left: 0,
      width: 100,
      dayIndex: slot.day_of_week,
    }
  })
}
