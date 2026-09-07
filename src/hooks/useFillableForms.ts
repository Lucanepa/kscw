import { useCallback, useMemo } from 'react'
import { useAuth } from './useAuth'
import { useCollection } from '../lib/query'
import type { FormDef, AnswerValue } from '../modules/forms/types'

/** Extract the targeted team ids from a form's (possibly junction-expanded) teams. */
function teamIdsOf(form: FormDef): string[] {
  return (form.teams ?? []).map((tref) => {
    if (typeof tref === 'object' && tref !== null && 'teams_id' in tref) {
      const tid = (tref as { teams_id: unknown }).teams_id
      return String(typeof tid === 'object' && tid !== null ? (tid as { id: unknown }).id : tid)
    }
    return String(tref)
  })
}

interface SubRef { id: string; form: string; answers: Record<string, AnswerValue> }

export interface FillableForm {
  form: FormDef
  /** The member's existing submission, when the form is editable (non-anonymous,
   *  single-submission, already answered). Drives the Edit affordance + prefill. */
  submission: { id: string; answers: Record<string, AnswerValue> } | null
}

/**
 * Forms the current member can act on from Home — club-wide ∪ their player teams.
 * Includes both not-yet-submitted forms (→ "Fill in") and already-submitted,
 * still-editable ones (→ "Edit", with the prior answers for prefill). Anonymous
 * and multi-submission forms are never marked editable. Surfaced on Home because
 * the /forms nav item is author-only.
 */
export function useFillableForms() {
  const { user, memberTeamIds, teamsLoading } = useAuth()

  const { data: formsRaw, isLoading: formsLoading, refetch: refetchForms } = useCollection<FormDef>('forms', {
    filter: { status: { _eq: 'open' } },
    fields: ['*', 'teams.teams_id.id'],
    sort: ['-date_created'],
    limit: 200,
    enabled: !!user,
  })

  // ⚠ Both of this query's flags are load-bearing. While it is in flight
  // `subByForm` is empty — and an empty map used to be indistinguishable from
  // "the member has answered nothing": every form painted as unanswered with a
  // primary "Fill in" button, and tapping one opened FormFillModal with
  // `existing = null`, i.e. a blank create. The member retyped the whole form
  // and the BEFORE INSERT trigger then rejected it with "already submitted".
  const { data: subsRaw, isLoading: subsLoading, refetch: refetchSubs } = useCollection<SubRef>('form_submissions', {
    filter: { member: { _eq: user?.id } },
    fields: ['id', 'form', 'answers'],
    limit: 1000,
    enabled: !!user,
  })

  const subByForm = useMemo(() => {
    const m = new Map<string, SubRef>()
    for (const s of subsRaw ?? []) m.set(String(s.form), s)
    return m
  }, [subsRaw])

  const items = useMemo<FillableForm[]>(
    () =>
      (formsRaw ?? [])
        .filter((f) => f.audience === 'club_wide' || teamIdsOf(f).some((id) => memberTeamIds.includes(id)))
        .map((f) => {
          const sub = subByForm.get(String(f.id))
          const editable = !!sub && !f.anonymous && !f.allow_multiple
          // Hide forms that are answered and NOT editable (single-shot, already done).
          if (sub && !editable && !f.allow_multiple) return null
          return {
            form: f,
            submission: editable && sub ? { id: String(sub.id), answers: sub.answers ?? {} } : null,
          }
        })
        .filter((x): x is FillableForm => x !== null),
    [formsRaw, memberTeamIds, subByForm],
  )

  // Count of forms still needing a first answer (drives the Home badge / visibility).
  const todoCount = useMemo(() => items.filter((i) => !i.submission).length, [items])

  // Refetch BOTH queries. `submission` is derived from form_submissions, and
  // FormFillModal writes through the raw createRecord/updateRecord helpers,
  // which invalidate nothing — so a forms-only refetch left a just-answered
  // form sitting there with a "Fill in" button until the 30s staleTime expired.
  const refetch = useCallback(
    () => Promise.all([refetchForms(), refetchSubs()]),
    [refetchForms, refetchSubs],
  )

  return {
    items,
    todoCount,
    // Covers every input `items` is derived from — the open forms, the member's
    // existing submissions, and the team context `memberTeamIds` comes from —
    // so consumers that gate on it can never paint "not loaded" as "not
    // answered". (Layout already holds routed pages until teams are ready; the
    // term is here so the hook's own contract does not depend on that.)
    isLoading: formsLoading || subsLoading || teamsLoading,
    refetch,
  }
}
