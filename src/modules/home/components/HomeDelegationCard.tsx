import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowRightLeft } from 'lucide-react'
import type { Member, Game } from '../../../types'
import { useCollection } from '../../../lib/query'
import { useScorerDelegations } from '../../scorer/hooks/useScorerDelegations'
import DelegationRequestBanner from '../../scorer/components/DelegationRequestBanner'

/**
 * Homepage surface for pending incoming duty-delegation requests.
 *
 * A delegated duty is only transferred once the recipient accepts, so the
 * accept/decline action needs to be reachable without hunting through the
 * scorer page. This reuses the same DelegationRequestBanner shown on /scorer.
 *
 * Self-contained: `useScorerDelegations` already scopes to the logged-in user
 * (to_member = me, status = pending) and refetches on realtime. We only fetch
 * the delegator names + game details referenced by the pending rows, so the
 * card costs nothing when the user has no requests (returns null → no render).
 */
export default function HomeDelegationCard() {
  const { t } = useTranslation('scorer')
  const { pendingIncoming, acceptDelegation, declineDelegation } = useScorerDelegations()

  const fromIds = useMemo(
    () => [...new Set(pendingIncoming.map((d) => d.from_member).filter(Boolean))],
    [pendingIncoming],
  )
  const gameIds = useMemo(
    () => [...new Set(pendingIncoming.map((d) => d.game).filter(Boolean))],
    [pendingIncoming],
  )

  // Delegator names — members' first/last name are readable by any member
  // (MEMBER_VISIBLE_FIELDS, null row filter). Games are public.
  const { data: membersRaw, isLoading: membersLoading, isError: membersError } = useCollection<Member>('members', {
    filter: { id: { _in: fromIds.length ? fromIds : [-1] } },
    fields: ['id', 'nickname', 'first_name', 'last_name'],
    limit: 50,
    enabled: fromIds.length > 0,
  })
  const { data: gamesRaw, isLoading: gamesLoading, isError: gamesError } = useCollection<Game>('games', {
    filter: { id: { _in: gameIds.length ? gameIds : [-1] } },
    fields: ['id', 'home_team', 'away_team', 'date', 'time', 'league'],
    limit: 50,
    enabled: gameIds.length > 0,
  })

  // Strict waterfall: both queries are `enabled` off ids derived from
  // `pendingIncoming`, so the very render that makes this card appear is the
  // render that first enables them — `membersRaw`/`gamesRaw` are necessarily
  // `undefined` there. `?? []` would then feed the banner an empty delegator
  // list and an empty game list, and it renders that as "" — a duty request
  // with no name, no fixture and no date, but with live Accept/Decline
  // buttons that then jump down when the meta line appears. `isLoading` alone
  // is not enough: it is false while `enabled` is still false, so also treat
  // "we asked for ids but have no rows yet" as pending.
  // // ⚠ `isLoading` goes false on ERROR while `data` stays undefined, so a bare
  // `data === undefined` gate never releases after a failed fetch — a permanent
  // skeleton is worse than the wrong frame it replaced. Errors fall through.
  // Here that would strand the Accept / Decline buttons behind the skeleton, so a
  // failed read must still render the banner — blank names beat no buttons.
  const detailsPending =
    !membersError && !gamesError && (
      membersLoading ||
      gamesLoading ||
      (fromIds.length > 0 && membersRaw === undefined) ||
      (gameIds.length > 0 && gamesRaw === undefined)
    )

  if (pendingIncoming.length === 0) return null

  async function handleAccept(id: string) {
    try {
      await acceptDelegation(id)
      toast.success(t('delegateAccepted'))
    } catch {
      toast.error(t('errorAcceptDelegation'))
    }
  }
  async function handleDecline(id: string) {
    try {
      await declineDelegation(id)
      toast.success(t('delegateDeclined'))
    } catch {
      toast.error(t('errorDeclineDelegation'))
    }
  }

  return (
    <div className="mb-6 lg:flex lg:flex-col lg:items-center">
      <div className="w-full lg:max-w-2xl">
        {detailsPending ? (
          // Same amber shell + real title, one per pending request, with the
          // sentence, the meta line and the button row reserved as pulse bars —
          // so nothing shifts and nothing is tappable until the names land.
          <div className="space-y-3" aria-busy="true">
            {pendingIncoming.map((d) => (
              <div
                key={d.id}
                className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20"
              >
                <div className="flex items-start gap-3">
                  <ArrowRightLeft className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {t('delegateRequestTitle')}
                    </p>
                    {/* The request sentence usually wraps to two lines. */}
                    <div className="mt-2 h-3.5 w-full animate-pulse rounded bg-amber-200 dark:bg-amber-800" />
                    <div className="mt-1.5 h-3.5 w-3/4 animate-pulse rounded bg-amber-200 dark:bg-amber-800" />
                    {/* Date · time · league. */}
                    <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-amber-200/70 dark:bg-amber-800/60" />
                    {/* Accept / decline row — 44px, its final height. */}
                    <div className="mt-3 h-11 w-56 max-w-full animate-pulse rounded-lg bg-amber-200 dark:bg-amber-800" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <DelegationRequestBanner
            delegations={pendingIncoming}
            members={membersRaw ?? []}
            games={gamesRaw ?? []}
            onAccept={handleAccept}
            onDecline={handleDecline}
          />
        )}
      </div>
    </div>
  )
}
