import { timeToMinutes } from '../../../utils/dateHelpers'
import type { VirtualSlotMeta } from '../../../types'

export interface SlotCandidate {
  hall: string
  team?: string
  day_of_week: number
  start_time: string
  end_time: string
  valid_from: string
  valid_until: string
  _virtual?: VirtualSlotMeta
}

/**
 * Checks if two time ranges overlap.
 * Ranges [s1,e1) and [s2,e2) overlap iff s1 < e2 && s2 < e1.
 */
export function timesOverlap(
  start1: string,
  end1: string,
  start2: string,
  end2: string,
): boolean {
  const s1 = timeToMinutes(start1)
  const e1 = timeToMinutes(end1)
  const s2 = timeToMinutes(start2)
  const e2 = timeToMinutes(end2)
  return s1 < e2 && s2 < e1
}

/**
 * Checks if two date validity ranges overlap.
 * Empty strings mean unbounded.
 */
export function validityOverlaps(
  from1: string,
  until1: string,
  from2: string,
  until2: string,
): boolean {
  const f1 = from1 || '0000-01-01'
  const u1 = until1 || '9999-12-31'
  const f2 = from2 || '0000-01-01'
  const u2 = until2 || '9999-12-31'
  return f1 <= u2 && f2 <= u1
}

/**
 * Returns all slots from `existingSlots` that conflict with `candidate`.
 * A conflict exists when: same hall, same day, overlapping times, overlapping validity.
 */
export function findConflicts<T extends SlotCandidate & { id: string }>(
  candidate: SlotCandidate,
  existingSlots: T[],
  excludeId?: string,
): T[] {
  return existingSlots.filter((existing) => {
    if (existing.id === excludeId) return false
    if (existing.hall !== candidate.hall) return false
    if (existing.day_of_week !== candidate.day_of_week) return false
    if (!timesOverlap(candidate.start_time, candidate.end_time, existing.start_time, existing.end_time)) return false
    if (!validityOverlaps(candidate.valid_from, candidate.valid_until, existing.valid_from, existing.valid_until)) return false
    return true
  })
}

/** Builds a Set of slot IDs that have at least one conflict within the array */
export function buildConflictSet<T extends SlotCandidate & { id: string }>(slots: T[]): Set<string> {
  const conflicting = new Set<string>()
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]
      const b = slots[j]
      if (a.hall !== b.hall) continue
      if (a.day_of_week !== b.day_of_week) continue
      if (!timesOverlap(a.start_time, a.end_time, b.start_time, b.end_time)) continue
      // Skip: don't flag conflicts between two virtual slots of the same team
      // (a game naturally replaces training for that team)
      if (a._virtual && b._virtual && a.team && a.team === b.team) continue
      conflicting.add(a.id)
      conflicting.add(b.id)
    }
  }
  return conflicting
}
