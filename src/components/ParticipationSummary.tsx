import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X, HelpCircle, Hourglass, Award } from 'lucide-react'
import { useCollection } from '../lib/query'
import { useRealtime } from '../hooks/useRealtime'
import { kscwApi } from '../lib/api'
import type { Participation } from '../types'

// Sourced from config (CF Pages env var) so a data reseed / different
// environment doesn't silently break the non-member add-on. Falls back to the
// current prod record ID when unset.
const MIXED_TOURNAMENT_EVENT_ID = import.meta.env.VITE_MIXED_TOURNAMENT_EVENT_ID ?? '5'

/** Same box metrics as the live `bars` counters — keep the two in step. */
const BAR_BOX = 'flex min-w-[3.25rem] items-center justify-center gap-1 rounded-md px-2 py-1'

/** Placeholder for the three RSVP rectangles while their fetch is in flight. */
function ParticipationBarsSkeleton() {
  return (
    <div className="flex animate-pulse flex-col items-start gap-0.5 lg:flex-row lg:items-center lg:gap-2" aria-hidden="true">
      <div className="flex items-center gap-1">
        {['bg-green-50 dark:bg-green-900/20', 'bg-yellow-50 dark:bg-yellow-900/20', 'bg-red-50 dark:bg-red-900/20'].map((tint) => (
          <div key={tint} className={`${BAR_BOX} ${tint}`}>
            <span className="h-3 w-3 rounded-full bg-gray-300 dark:bg-gray-600" />
            <span className="h-4 w-2 rounded-sm bg-gray-300 dark:bg-gray-600" />
          </div>
        ))}
      </div>
    </div>
  )
}

interface ParticipationSummaryProps {
  activityType: Participation['activity_type']
  activityId: string
  compact?: boolean
  stacked?: boolean
  /** 3 colored rectangles layout — use beneath card info rows */
  bars?: boolean
  /** Hide coach/guest breakdowns — show only raw counts */
  hideExtras?: boolean
  /** Pre-fetched participations — skips internal API call when provided */
  participations?: Participation[]
  /** Coach/captain/TR member IDs — used to detect "Coach present" for player-coaches */
  coachMemberIds?: string[]
  /** Render the counters even when there are no participations yet (shows 0/0/0 instead of hiding) */
  alwaysShow?: boolean
}

export default function ParticipationSummary({
  activityType,
  activityId,
  compact = false,
  stacked = false,
  bars = false,
  hideExtras = false,
  participations: prefetched,
  coachMemberIds,
  alwaysShow = false,
}: ParticipationSummaryProps) {
  const { t } = useTranslation('participation')

  const skipFetch = !!prefetched
  const { data: fetchedRaw, isLoading, isError, isPlaceholderData, refetch } = useCollection<Participation>('participations', {
    filter: activityId
      ? { _and: [{ activity_type: { _eq: activityType } }, { activity_id: { _eq: activityId } }] }
      : { id: { _eq: -1 } },
    all: true,
    enabled: !!activityId && !skipFetch,
  })
  const fetched = fetchedRaw ?? []

  // Auto-refresh when participations change (create/update/delete).
  // ⚠ `skipFetch` MUST be the `disabled` argument, not just an early return inside the
  // callback. A guard in the callback still opens the subscription, and the server side
  // is not free: Directus dispatches create/update by calling `readMany` under the
  // SUBSCRIBER's accountability — one permission-filtered `participations` read per
  // subscription, awaited sequentially across every connected client. The home page
  // mounts both the desktop table and the mobile list (CSS-hidden, both in the DOM), so
  // at ~20 rows that was ~20 policy-filtered reads per client per RSVP, every one of
  // them discarded because `prefetched` was already supplying the data. This is the
  // (instances × clients) multiplier that turned the 26.08.2026 participations read
  // from 7s uncontended into 2m05s under load — see DEVLOG 26.08.2026.
  useRealtime('participations', () => { refetch() }, undefined, skipFetch)

  // Mixed tournament: non-member signups (kscw-website form) don't create a
  // participations row (FK to members), so fetch them separately and add to confirmed.
  const isMixedTournament = activityType === 'event' && String(activityId) === MIXED_TOURNAMENT_EVENT_ID
  const [extraConfirmed, setExtraConfirmed] = useState(0)
  // Seeded TRUE for the mixed tournament so the FIRST paint is already "pending".
  // The effect below only runs after that paint, so without this the green tally
  // always rendered the members-only headcount as a settled number and then jumped
  // once the non-member signups landed. Worse on a remount: the participations come
  // back from the TanStack cache instantly while this count — plain component state,
  // uncached — restarts at 0, so the wrong number arrives faster than the right one.
  const [extraLoading, setExtraLoading] = useState(isMixedTournament)
  // Reset the add-on count when the activity stops being the mixed tournament.
  // Adjust-state-during-render instead of a synchronous setState in the effect.
  const [prevIsMixed, setPrevIsMixed] = useState(isMixedTournament)
  if (prevIsMixed !== isMixedTournament) {
    setPrevIsMixed(isMixedTournament)
    setExtraConfirmed(0)
    setExtraLoading(isMixedTournament)
  }
  useEffect(() => {
    // Deliberately no setState for the non-mixed case: the adjust-during-render block
    // above has already put `extraLoading` at false, and a synchronous setState in an
    // effect body is both an eslint error here and an extra render.
    if (!isMixedTournament) return
    let cancelled = false
    kscwApi<{ count: number }>('/public/mixed-tournament/non-member-count')
      .then((r) => { if (!cancelled) { setExtraConfirmed(r?.count ?? 0); setExtraLoading(false) } })
      // Release the gate on failure too. A tally short by the non-member signups is
      // bad; a placeholder that never resolves is worse.
      .catch(() => { if (!cancelled) setExtraLoading(false) })
    return () => { cancelled = true }
  }, [isMixedTournament])

  const data = prefetched ?? fetched

  // Deduplicate by member: when an event has multiple sessions, a member may
  // have several participation records. Pick the "best" status per member
  // (confirmed > tentative > waitlisted > declined) so counters reflect unique members.
  const statusPriority: Record<string, number> = { confirmed: 4, tentative: 3, waitlisted: 2, declined: 1 }
  const deduped = (() => {
    const byMember = new Map<string, Participation>()
    for (const p of data) {
      const existing = byMember.get(p.member)
      if (!existing || (statusPriority[p.status] ?? 0) > (statusPriority[existing.status] ?? 0)) {
        byMember.set(p.member, p)
      }
    }
    return Array.from(byMember.values())
  })()

  // Separate player and staff participations — staff don't count towards totals
  const playerData = deduped.filter(p => !p.is_staff)
  const staffData = deduped.filter(p => p.is_staff)

  const confirmedParts = playerData.filter(p => p.status === 'confirmed')
  const confirmed = confirmedParts.length
  const confirmedGuests = confirmedParts.reduce((sum, p) => sum + (p.guest_count ?? 0), 0)
  const tentativeParts = playerData.filter(p => p.status === 'tentative')
  const tentative = tentativeParts.length
  const tentativeGuests = tentativeParts.reduce((sum, p) => sum + (p.guest_count ?? 0), 0)
  const declinedParts = playerData.filter(p => p.status === 'declined')
  const declined = declinedParts.length
  const waitlisted = playerData.filter(p => p.status === 'waitlisted').length

  // Guests ride on their host's participation row. A host who is out (declined,
  // typically auto-declined while on holiday) can still register a guest — e.g. a
  // tryout player — who IS coming. So a declined host's guests still count toward
  // attendance even though the host themselves is absent.
  const declinedGuests = declinedParts.reduce((sum, p) => sum + (p.guest_count ?? 0), 0)

  // Coach present: count staff-only confirmed + player-coaches confirmed (via coachMemberIds)
  const staffOnlyConfirmed = staffData.filter(p => p.status === 'confirmed')
  const playerCoachConfirmed = coachMemberIds?.length
    ? playerData.filter(p => p.status === 'confirmed' && coachMemberIds.includes(p.member))
    : []
  const staffConfirmed = staffOnlyConfirmed.length + playerCoachConfirmed.length
  const staffConfirmedGuests = staffOnlyConfirmed.reduce((sum, p) => sum + (p.guest_count ?? 0), 0)
  const staffDeclinedGuests = staffData
    .filter(p => p.status === 'declined')
    .reduce((sum, p) => sum + (p.guest_count ?? 0), 0)

  // Total for green counter = players + all guests + extra non-member signups
  // (coaches excluded from number; extraConfirmed is only > 0 for the mixed tournament event)
  const allGuests = confirmedGuests + staffConfirmedGuests + declinedGuests + staffDeclinedGuests
  const confirmedTotal = confirmed + allGuests + extraConfirmed
  const hasGuestBreakdown = allGuests > 0

  // Has every source these counters are summed from actually landed?
  //  • the participations query — skipped entirely when the rows arrive as a prop
  //  • the SAME query on a changed key: `placeholderData: keepPreviousData` is a
  //    global default (src/lib/query.tsx), so a modal swapped onto another activity
  //    gets the PREVIOUS activity's rows — plausible, settled-looking, and wrong
  //  • the non-member add-on above, which is 0 until its own fetch resolves
  // Two escape hatches, both mandatory: `isError`, because TanStack reports
  // `isLoading === false` on a failed fetch while `data` stays undefined (a gate
  // without it swaps a wrong number for a PERMANENT placeholder), and `activityId`,
  // because the query is disabled without one so nothing is ever coming.
  const listPending = !!activityId && !skipFetch && !isError && (isLoading || isPlaceholderData)
  const countsPending = listPending || extraLoading

  // "Not loaded" must not be paintable as "these are the numbers". `bars` sits in the
  // middle of a layout (under the RSVP buttons in the game detail panel, in the card's
  // footer row), so its placeholder has to occupy the same footprint as the real
  // counters — swapping a one-character "…" for three rectangles reflows everything
  // below it once the fetch lands. The inline variants have no such footprint to hold,
  // so they keep this component's existing pending idiom.
  if (countsPending) {
    return bars ? <ParticipationBarsSkeleton /> : <span className="text-xs text-gray-400">…</span>
  }

  // Everything resolved with nothing to show. `alwaysShow` keeps the counters
  // visible (0/0/0) even for empty activities.
  if (!alwaysShow && data.length === 0 && extraConfirmed === 0) return null

  if (bars) {
    return (
      <div className="flex flex-col items-start gap-0.5 lg:flex-row lg:items-center lg:gap-2">
        <div className="flex items-center gap-1">
          <div className="flex min-w-[3.25rem] items-center justify-center gap-1 rounded-md bg-green-50 px-2 py-1 dark:bg-green-900/20">
            <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
            <span className="text-xs font-semibold tabular-nums text-green-700 dark:text-green-300">{confirmedTotal}</span>
          </div>
          <div className="flex min-w-[3.25rem] items-center justify-center gap-1 rounded-md bg-yellow-50 px-2 py-1 dark:bg-yellow-900/20">
            <HelpCircle className="h-3 w-3 text-yellow-600 dark:text-yellow-400" />
            <span className="text-xs font-semibold tabular-nums text-yellow-700 dark:text-yellow-300">{tentative}</span>
          </div>
          <div className="flex min-w-[3.25rem] items-center justify-center gap-1 rounded-md bg-red-50 px-2 py-1 dark:bg-red-900/20">
            <X className="h-3 w-3 text-red-600 dark:text-red-400" />
            <span className="text-xs font-semibold tabular-nums text-red-700 dark:text-red-300">{declined}</span>
          </div>
          {waitlisted > 0 && (
            <div className="flex min-w-[3.25rem] items-center justify-center gap-1 rounded-md bg-orange-50 px-2 py-1 dark:bg-orange-900/20">
              <Hourglass className="h-3 w-3 text-orange-600 dark:text-orange-400" />
              <span className="text-xs font-semibold tabular-nums text-orange-700 dark:text-orange-300">{waitlisted}</span>
            </div>
          )}
        </div>
        {!hideExtras && staffConfirmed > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-brand-600 dark:text-brand-400">
            <Award className="h-3 w-3" />
            {t('coachPresent')}
          </span>
        )}
      </div>
    )
  }

  if (stacked) {
    return (
      <div className="flex flex-col items-end gap-0.5 text-xs">
        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
          {!hideExtras && staffConfirmed > 0 && (
            <span className="text-[10px] text-gray-500 dark:text-gray-400">{t('coachPresent')}</span>
          )}
          {confirmedTotal}
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-green-600 text-white dark:bg-green-500"><Check className="h-2.5 w-2.5" /></span>
          {!hideExtras && hasGuestBreakdown && (
            <span className="text-[10px] text-gray-500 dark:text-gray-400">
              ({confirmed}P {allGuests}G)
            </span>
          )}
        </span>
        {tentative > 0 && (
          <span className="inline-flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
            {tentative}{!hideExtras && tentativeGuests > 0 && <span className="text-[10px] opacity-75">+{tentativeGuests}</span>}
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-yellow-500 text-white"><HelpCircle className="h-2.5 w-2.5" /></span>
          </span>
        )}
        {declined > 0 && (
          <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
            {declined}
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-white dark:bg-red-500"><X className="h-2.5 w-2.5" /></span>
          </span>
        )}
      </div>
    )
  }

  if (compact) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="inline-flex items-center gap-1.5 text-xs">
          {confirmedTotal > 0 && (
            <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
              {confirmedTotal}
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-green-600 text-white dark:bg-green-500"><Check className="h-2.5 w-2.5" /></span>
              {!hideExtras && hasGuestBreakdown && (
                <span className="text-[10px] text-gray-500 dark:text-gray-400">
                  ({confirmed}P {allGuests}G)
                </span>
              )}
            </span>
          )}
          {tentative > 0 && (
            <span className="inline-flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
              {tentative}{!hideExtras && tentativeGuests > 0 && <span className="text-[10px] opacity-75">+{tentativeGuests}</span>}
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-yellow-500 text-white"><HelpCircle className="h-2.5 w-2.5" /></span>
            </span>
          )}
          {declined > 0 && (
            <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
              {declined}
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-white dark:bg-red-500"><X className="h-2.5 w-2.5" /></span>
            </span>
          )}
          {waitlisted > 0 && (
            <span className="inline-flex items-center gap-1 text-orange-600 dark:text-orange-400">
              {waitlisted}
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-orange-500 text-white"><Hourglass className="h-2.5 w-2.5" /></span>
            </span>
          )}
        </span>
        {!hideExtras && staffConfirmed > 0 && (
          <span className="text-[10px] text-gray-500 dark:text-gray-400">{t('coachPresent')}</span>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-start gap-0.5">
      <div className="inline-flex items-center gap-2 text-xs">
        <span className="text-green-600 dark:text-green-400">
          {confirmedTotal}{!hideExtras && hasGuestBreakdown && ` (${confirmed}P ${allGuests}G)`} {t('confirmed')}
        </span>
        <span className="text-yellow-600 dark:text-yellow-400">
          {tentative}{!hideExtras && tentativeGuests > 0 && `+${tentativeGuests}`} {t('tentative')}
        </span>
        <span className="text-red-600 dark:text-red-400">{declined} {t('declined')}</span>
        {waitlisted > 0 && (
          <span className="text-orange-600 dark:text-orange-400">{waitlisted} {t('waitlisted')}</span>
        )}
      </div>
      {!hideExtras && staffConfirmed > 0 && (
        <span className="text-[10px] text-gray-500 dark:text-gray-400">{t('coachPresent')}</span>
      )}
    </div>
  )
}
