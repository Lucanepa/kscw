/**
 * Did this write fail because migration 354's `trainings_hall_slot_date_uq`
 * rejected it?
 *
 * That partial unique index is the guard against slot-cascade generating the same
 * session twice (two overlapping cascades both found no row for the date and both
 * inserted). It is enforced by Postgres, not declared in Directus, so a violation
 * arrives at the client as whatever the items API made of a 23505 — sometimes
 * Directus's own "has to be unique" wording, sometimes the raw driver text naming
 * the index. Match either, rather than the exact shape of one of them.
 *
 * Callers should show `trainings:duplicateSlotDate`, never the raw message: the
 * batch create is atomic, so nothing was written and re-running is safe.
 */
export function isDuplicateSlotTraining(err: unknown): boolean {
  const parts: string[] = []
  if (err instanceof Error) parts.push(err.message)
  const e = err as { message?: string; errors?: { message?: string }[] }
  if (typeof e?.message === 'string') parts.push(e.message)
  for (const x of e?.errors ?? []) if (x?.message) parts.push(x.message)
  const text = parts.join(' ')
  if (!text) return false
  return /trainings_hall_slot_date_uq/i.test(text)
    || (/has to be unique/i.test(text) && /hall_slot/i.test(text))
}
