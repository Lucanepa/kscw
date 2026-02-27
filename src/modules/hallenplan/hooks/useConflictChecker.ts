import { useMemo } from 'react'
import { findConflicts, type SlotCandidate } from '../utils/conflictDetection'
import type { HallSlot } from '../../../types'

export function useConflictChecker(
  candidate: SlotCandidate,
  allSlots: HallSlot[],
  excludeId?: string,
) {
  return useMemo(
    () => findConflicts(candidate, allSlots, excludeId),
    [
      candidate.hall,
      candidate.day_of_week,
      candidate.start_time,
      candidate.end_time,
      candidate.valid_from,
      candidate.valid_until,
      allSlots,
      excludeId,
    ],
  )
}
