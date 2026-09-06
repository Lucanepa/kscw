import { describe, it, expect } from 'vitest'
import {
  buildTimeAxis,
  axisTimeToTop,
  axisTopToMinutes,
  positionSlotsOnAxis,
  breakKeyOf,
  SLOT_HEIGHT,
  SLOT_MINUTES,
  BREAK_HEIGHT,
} from '../timeGrid'
import type { HallSlot } from '../../../../types'

const busy = (start: string, end: string) => {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  return { startMin: m(start), endMin: m(end) }
}

/** The shape in the reported screenshot: a 09:00–11:00 morning slot, then
 *  nothing until the 16:00 evening block. */
const WEEK = [busy('09:00', '11:00'), busy('16:00', '22:00')]

describe('buildTimeAxis', () => {
  it('collapses a gap no day touches', () => {
    const axis = buildTimeAxis(WEEK, 9, 22)
    const breaks = axis.segments.filter((s) => s.collapsed)
    expect(breaks).toHaveLength(1)
    expect(breaks[0].startMin).toBe(11 * 60)
    expect(breaks[0].endMin).toBe(16 * 60)
  })

  it('is shorter than the equivalent linear grid', () => {
    const axis = buildTimeAxis(WEEK, 9, 22)
    const linear = ((22 - 9) * 60 / SLOT_MINUTES) * SLOT_HEIGHT
    // The five collapsed hours cost one band instead of 20 rows.
    expect(axis.totalHeight).toBe(linear - (5 * 60 / SLOT_MINUTES) * SLOT_HEIGHT + BREAK_HEIGHT)
  })

  it('never collapses an hour a single day uses, and collapses around it', () => {
    // One team trains 13:00-14:00 on one day. That hour must survive; the two
    // genuinely empty stretches either side of it should still collapse.
    const axis = buildTimeAxis([...WEEK, busy('13:00', '14:00')], 9, 22)
    const breaks = axis.segments.filter((s) => s.collapsed)
    expect(breaks.map((b) => [b.startMin, b.endMin])).toEqual([
      [11 * 60, 13 * 60],
      [14 * 60, 16 * 60],
    ])
    expect(axis.rows.some((r) => r.time === '13:00' && !r.isBreak)).toBe(true)
    expect(axis.rows.some((r) => r.time === '13:45' && !r.isBreak)).toBe(true)
  })

  it('leaves a short gap alone', () => {
    // 11:00-12:00 is only 60 min — below the 120 min floor.
    const axis = buildTimeAxis([busy('09:00', '11:00'), busy('12:00', '22:00')], 9, 22)
    expect(axis.segments.filter((s) => s.collapsed)).toHaveLength(0)
  })

  it('snaps a gap inward to whole hours so label rows stay aligned', () => {
    // 10:45 -> 16:20 empty. Only 11:00-16:00 may collapse.
    const axis = buildTimeAxis([busy('09:00', '10:45'), busy('16:20', '22:00')], 9, 22)
    const br = axis.segments.find((s) => s.collapsed)
    expect(br).toBeDefined()
    expect(br!.startMin).toBe(11 * 60)
    expect(br!.endMin).toBe(16 * 60)
    for (const seg of axis.segments.filter((s) => !s.collapsed)) {
      expect(seg.startMin % 60).toBe(0)
    }
  })

  it('re-expands a break the user clicked open', () => {
    const key = breakKeyOf(11 * 60, 16 * 60)
    const axis = buildTimeAxis(WEEK, 9, 22, new Set([key]))
    expect(axis.segments.filter((s) => s.collapsed)).toHaveLength(0)
    expect(axis.rows.some((r) => r.time === '13:00')).toBe(true)
  })

  it('emits no label rows inside a collapsed range', () => {
    const axis = buildTimeAxis(WEEK, 9, 22)
    const times = axis.rows.filter((r) => !r.isBreak).map((r) => r.time)
    expect(times).not.toContain('13:00')
    expect(times).toContain('10:00')
    expect(times).toContain('16:00')
    const brk = axis.rows.find((r) => r.isBreak)
    expect(brk?.time).toBe('11:00')
    expect(brk?.breakEndTime).toBe('16:00')
  })

  it('rows are contiguous and sum to the total height', () => {
    const axis = buildTimeAxis(WEEK, 9, 22)
    let expected = 0
    for (const row of axis.rows) {
      expect(row.top).toBe(expected)
      expected += row.height
    }
    expect(expected).toBe(axis.totalHeight)
  })
})

describe('axis round-trip (what click-to-create reads)', () => {
  it('px -> minutes is the exact inverse of minutes -> px outside breaks', () => {
    const axis = buildTimeAxis(WEEK, 9, 22)
    for (let m = 9 * 60; m < 22 * 60; m += SLOT_MINUTES) {
      const collapsed = m >= 11 * 60 && m < 16 * 60
      if (collapsed) continue
      expect(axisTopToMinutes(axis, axisTimeToTop(axis, m))).toBe(m)
    }
  })

  it('a click inside the break lands on its start, never mid-gap', () => {
    const axis = buildTimeAxis(WEEK, 9, 22)
    const brk = axis.segments.find((s) => s.collapsed)!
    expect(axisTopToMinutes(axis, brk.top)).toBe(11 * 60)
    expect(axisTopToMinutes(axis, brk.top + BREAK_HEIGHT - 1)).toBe(11 * 60)
  })

  it('still round-trips when nothing collapses', () => {
    const axis = buildTimeAxis([busy('09:00', '22:00')], 9, 22)
    for (let m = 9 * 60; m < 22 * 60; m += SLOT_MINUTES) {
      expect(axisTopToMinutes(axis, axisTimeToTop(axis, m))).toBe(m)
    }
  })
})

describe('positionSlotsOnAxis', () => {
  const slot = (start: string, end: string): HallSlot =>
    ({ id: '1', start_time: start, end_time: end, day_of_week: 0 } as unknown as HallSlot)

  it('places an evening slot above where the linear grid would have', () => {
    const axis = buildTimeAxis(WEEK, 9, 22)
    const [p] = positionSlotsOnAxis([slot('18:00', '20:00')], axis)
    const linearTop = ((18 * 60 - 9 * 60) / SLOT_MINUTES) * SLOT_HEIGHT
    expect(p.top).toBeLessThan(linearTop)
    // Height is untouched by the collapse — it does not span the break.
    expect(p.height).toBe((120 / SLOT_MINUTES) * SLOT_HEIGHT)
  })

  it('keeps a real duration for a zero-length slot rather than collapsing it', () => {
    const axis = buildTimeAxis(WEEK, 9, 22)
    const [p] = positionSlotsOnAxis([slot('18:00', '18:00')], axis)
    expect(p.height).toBeGreaterThan(0)
  })
})
