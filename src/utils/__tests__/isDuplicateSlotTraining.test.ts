import { describe, it, expect } from 'vitest'
import { isDuplicateSlotTraining } from '../isDuplicateSlotTraining'

/**
 * The detector decides whether a coach sees "a training already exists for this
 * slot on that date" or a raw Postgres index name. A violation of migration 354's
 * `trainings_hall_slot_date_uq` reaches the client in more than one shape,
 * depending on whether Directus recognises the constraint or passes the driver
 * error through, so both are pinned here.
 */
describe('isDuplicateSlotTraining', () => {
  it('matches the raw driver error naming the index', () => {
    expect(isDuplicateSlotTraining(
      new Error('insert into "trainings" - duplicate key value violates unique constraint "trainings_hall_slot_date_uq"'),
    )).toBe(true)
  })

  it("matches Directus's own wording when it names the field", () => {
    expect(isDuplicateSlotTraining({
      errors: [{ message: 'Value for field "hall_slot, date" has to be unique.' }],
    })).toBe(true)
  })

  it('reads the index name out of a nested errors array', () => {
    expect(isDuplicateSlotTraining({
      errors: [{ message: 'trainings_hall_slot_date_uq' }],
    })).toBe(true)
  })

  it('reads a plain message property, not only an Error instance', () => {
    expect(isDuplicateSlotTraining({ message: 'violates trainings_hall_slot_date_uq' })).toBe(true)
  })

  // The narrow half matters as much as the broad half: this message must NOT be
  // shown for an unrelated conflict, or it sends the coach looking for a training
  // that has nothing to do with the failure.
  it('does not match a different unique violation', () => {
    expect(isDuplicateSlotTraining({
      errors: [{ message: 'Value for field "events_id, teams_id" has to be unique.' }],
    })).toBe(false)
  })

  it('does not match an unrelated failure', () => {
    expect(isDuplicateSlotTraining(new Error('Network request failed'))).toBe(false)
  })

  it('survives the shapes a rejected fetch can actually take', () => {
    expect(isDuplicateSlotTraining(null)).toBe(false)
    expect(isDuplicateSlotTraining(undefined)).toBe(false)
    expect(isDuplicateSlotTraining({})).toBe(false)
    expect(isDuplicateSlotTraining({ errors: [] })).toBe(false)
    expect(isDuplicateSlotTraining('trainings_hall_slot_date_uq')).toBe(false)
  })
})
