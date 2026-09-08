import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { fetchItems } from '../lib/api'
import { useCollection } from '../lib/query'
import { useMutation } from './useMutation'
import { useAuth } from './useAuth'
import { useRealtime } from './useRealtime'
import { useMyCoveringAbsence } from './useMyCoveringAbsence'
import type { Participation, VolleyPosition } from '../types'

export function useParticipation(
  activityType: Participation['activity_type'],
  activityId: string,
  activityDate?: string,
  sessionId?: string,
  isStaff?: boolean,
  /**
   * Every participation row the opening surface already holds for this activity
   * (the home page's `useBulkParticipations` result, i.e. ALL members' rows —
   * the caller does not pre-filter to the viewer). Passing it makes this hook
   * read the viewer's own row out of that list instead of opening its own
   * request, so a detail modal paints the Yes/Maybe/No selection on its FIRST
   * frame. Without it `isLoading` is true for a round-trip and the buttons open
   * disabled-and-unselected, which reads as an unanswered activity.
   *
   * Live updates then come from the parent's realtime subscription (it refetches
   * the bulk query), so this hook's own subscription is switched off — one
   * subscription per surface instead of one per mounted row.
   */
  prefetched?: Participation[],
) {
  const { user } = useAuth()
  const { t } = useTranslation('common')

  const skipFetch = !!prefetched
  const { data: participationsRaw, refetch, isLoading: fetchLoading } = useCollection<Participation>('participations', {
    filter: user && activityId
      ? { _and: [
          { member: { _eq: user.id } },
          { activity_type: { _eq: activityType } },
          { activity_id: { _eq: activityId } },
          ...(sessionId ? [{ session_id: { _eq: sessionId } }] : []),
        ] }
      : { id: { _eq: -1 } },
    limit: 1,
    enabled: !!user && !!activityId && !skipFetch,
  })
  const isLoading = skipFetch ? false : fetchLoading

  // Covering-absence lookup lives in one place (useMyCoveringAbsence) — reused by
  // the game/training/event cards + detail modals so the rule can't drift.
  const { hasAbsence } = useMyCoveringAbsence(activityType, activityDate)

  const { create, update, remove } = useMutation<Participation>('participations')

  // Realtime: refetch when any participation for this activity changes
  useRealtime<Participation>('participations', (e) => {
    if (e.record.activity_id === activityId && e.record.member === user?.id) {
      refetch()
    }
  }, undefined, skipFetch)

  // Optimistic status: shown immediately while the API call is in-flight.
  // Scoped to the current activity via `activityKey` so a previously-opened
  // activity's optimistic RSVP can't bleed into a freshly-opened one — the
  // detail modals are a single persistent instance whose activityId prop
  // changes WITHOUT remounting, so plain state would survive the switch and
  // show a phantom "Yes" on a game the user never touched.
  const activityKey = `${activityType}|${activityId}|${sessionId ?? ''}`
  const [optimistic, setOptimistic] = useState<{ key: string; status: Participation['status'] } | null>(null)
  const [saveConfirmed, setSaveConfirmed] = useState(false)

  // `prefetched` is the whole activity's roster, so the viewer's own row has to
  // be picked out of it. Session leg included: a whole-activity RSVP is the row
  // with no `session_id`, and adopting a per-day row here would show the wrong
  // answer AND make `setStatus` update the wrong record.
  const participation = useMemo(() => {
    if (!prefetched) return participationsRaw?.[0] ?? null
    if (!user) return null
    return prefetched.find((p) => (
      String(p.member) === String(user.id)
      && p.activity_type === activityType
      && String(p.activity_id) === String(activityId)
      && (sessionId ? String(p.session_id) === String(sessionId) : !p.session_id)
    )) ?? null
  }, [prefetched, participationsRaw, user, activityType, activityId, sessionId])

  // The row this hook last wrote for the current activity. `participations` is a
  // cached read that only catches up on the next refetch/realtime tick, so a second
  // click inside that window would take the create branch again and trip the
  // (activity_type, activity_id, member[, session_id]) partial unique index from
  // migration 246. Keyed like `optimistic` so a switched activity can't reuse it.
  const writtenRef = useRef<{ key: string; id: string | number } | null>(null)

  // Auto-decline is handled by the backend (Directus hooks) when absences
  // or activities are created. The frontend only displays the absence state.

  const setStatus = useCallback(async (
    status: Participation['status'],
    note = '',
    guestCount = 0,
    positions?: { position_1?: VolleyPosition | null; position_2?: VolleyPosition | null; position_3?: VolleyPosition | null },
  ) => {
    if (!user) return
    // Optimistic update — show status immediately
    setOptimistic({ key: activityKey, status })
    setSaveConfirmed(false)
    const posFields = positions ? {
      position_1: positions.position_1 || null,
      position_2: positions.position_2 || null,
      position_3: positions.position_3 || null,
    } : {}
    const writtenId = writtenRef.current?.key === activityKey ? writtenRef.current.id : null
    const existingId = participation?.id ?? writtenId
    try {
      if (existingId) {
        // Preserve the row's original is_staff classification on update — set it
        // only on create (matches GameCard / TrainingCard / EventCard /
        // ParticipationButton, which all omit is_staff on update). Writing it
        // here clobbered an existing player RSVP to staff whenever the viewer's
        // role context drifted (e.g. a season-lagged member_teams row makes
        // isStaffOnly flip true), silently yanking the row out of the player
        // tally so the participation bricks dropped to zero on every click.
        await update(existingId, { status, note, guest_count: guestCount, ...posFields })
      } else {
        try {
          const created = await create({
            member: user.id,
            activity_type: activityType,
            activity_id: activityId,
            status,
            note,
            guest_count: guestCount,
            is_staff: isStaff ?? false,
            ...(sessionId ? { session_id: sessionId } : {}),
            ...posFields,
          }, { silentOnUnique: true })
          writtenRef.current = { key: activityKey, id: created.id }
        } catch (err) {
          // A row already exists that our cached read never saw — a second click
          // inside the refetch window, or the backend auto-decline hook wrote it
          // first. Update that row so the click still lands instead of failing at
          // the user with a bare error toast (prod, 18. + 19.08.2026). The lookup
          // matches whichever partial unique index was violated, hence the explicit
          // session_id IS NULL leg — a session-less RSVP must not adopt a per-day row.
          if (!/has to be unique/i.test(err instanceof Error ? err.message : String(err))) throw err
          const [row] = await fetchItems<Participation>('participations', {
            filter: { _and: [
              { member: { _eq: user.id } },
              { activity_type: { _eq: activityType } },
              { activity_id: { _eq: activityId } },
              sessionId ? { session_id: { _eq: sessionId } } : { session_id: { _null: true } },
            ] },
            limit: 1,
          })
          if (!row) throw err
          writtenRef.current = { key: activityKey, id: row.id }
          await update(row.id, { status, note, guest_count: guestCount, ...posFields })
          refetch()
        }
      }
      setSaveConfirmed(true)
      // Skip explicit refetch — realtime subscription handles data sync
    } catch {
      // Revert optimistic update on failure + let the user know the RSVP didn't save
      setOptimistic(null)
      toast.error(t('error'))
    }
  }, [user, participation, activityType, activityId, activityKey, isStaff, sessionId, create, update, refetch, t])

  const clearStatus = useCallback(async () => {
    // Same blind spot as setStatus: a just-created row is not in `participations`
    // yet, and without the ref the clear would silently no-op and leave the RSVP.
    const writtenId = writtenRef.current?.key === activityKey ? writtenRef.current.id : null
    const existingId = participation?.id ?? writtenId
    if (existingId) {
      const previous = participation?.status ?? null
      setOptimistic(null)
      setSaveConfirmed(false)
      try {
        await remove(existingId)
        writtenRef.current = null
        // Skip explicit refetch — realtime subscription handles data sync
      } catch {
        // Revert — restore the original status + surface the failure to the user
        if (previous) setOptimistic({ key: activityKey, status: previous })
        toast.error(t('error'))
      }
    }
  }, [participation, activityKey, remove, t])

  // Optimistic status only applies to the activity it was set for; once the
  // user switches activities its key no longer matches and we fall back to the
  // server value (null for an untouched activity).
  const serverStatus = participation?.status ?? null
  const optimisticStatus = optimistic && optimistic.key === activityKey ? optimistic.status : null
  const displayStatus = optimisticStatus ?? serverStatus

  return {
    participation,
    hasAbsence,
    /**
     * ⚠ `effectiveStatus: null` means TWO things — "still loading" and "has not
     * answered" — and a caller cannot tell them apart. Rendering the Yes/Maybe/No
     * row off it alone paints all three unselected first, which reads as an
     * unanswered game and invites a tap to re-set what is already set. Gate the
     * control on this flag; do not infer it from a null status.
     */
    isLoading,
    effectiveStatus: displayStatus,
    note: participation?.note ?? '',
    setStatus,
    clearStatus,
    refetch,
    saveConfirmed,
    dismissConfirmed: useCallback(() => setSaveConfirmed(false), []),
  }
}

export function useTeamParticipations(
  activityType: Participation['activity_type'],
  activityId: string,
  memberIds: string[],
  sessionId?: string,
) {
  const { data, refetch, isLoading } = useCollection<Participation>('participations', {
    filter: activityId && memberIds.length > 0
      ? { _and: [
          { member: { _in: memberIds } },
          { activity_type: { _eq: activityType } },
          { activity_id: { _eq: activityId } },
          ...(sessionId ? [{ session_id: { _eq: sessionId } }] : []),
        ] }
      : { id: { _eq: -1 } },
    all: true,
    enabled: !!activityId && memberIds.length > 0,
  })

  return { participations: data ?? [], refetch, isLoading }
}

/** Fetch all participations for an event across all sessions (for roster aggregation) */
export function useAllEventParticipations(
  activityId: string,
  memberIds: string[],
) {
  const { data, refetch, isLoading } = useCollection<Participation>('participations', {
    filter: activityId && memberIds.length > 0
      ? { _and: [
          { member: { _in: memberIds } },
          { activity_type: { _eq: 'event' } },
          { activity_id: { _eq: activityId } },
        ] }
      : { id: { _eq: -1 } },
    all: true,
    enabled: !!activityId && memberIds.length > 0,
  })

  return { participations: data ?? [], refetch, isLoading }
}
