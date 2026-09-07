import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '../../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card'
import { kscwApi, SCHEDULING_ORIGIN } from '../../../lib/api'
import { useTeams } from '../../../hooks/useTeams'
import { formatDateTimeCompact } from '../../../utils/dateHelpers'
import type { Team } from '../../../types'

interface SvrzStatus {
  total: number
  home: number
  away: number
  last_synced_at: string | null
}
import { useInvites } from '../hooks/useInvites'
import InviteRow from './InviteRow'
import InvitesDrawer from './InvitesDrawer'
import SendInvitesModal from './SendInvitesModal'
import SyncNowButton from './SyncNowButton'

interface Props {
  teams: Team[]
  seasonId: string | number
  seasonName: string
}

export default function InvitesPanel({ teams, seasonId, seasonName }: Props) {
  const { t } = useTranslation('gameScheduling')
  // The `teams` prop comes from the page's own useTeams() query, which is still in
  // flight on a cold load — the page only blanks itself until the *season* exists,
  // so this panel mounts with an empty list. Reading the same query here (identical
  // key, so it is a deduped cache read, not a second request) is the only way to
  // tell "teams haven't arrived" apart from "there are no schedulable teams", which
  // the array on its own cannot express.
  const { isLoading: teamsQueryLoading, isError: teamsQueryError } = useTeams()
  // `isError` is the escape hatch: a failed teams fetch leaves isLoading false with
  // no rows, and must fall through to the real empty state rather than park the
  // panel behind a skeleton for good.
  const teamsPending = !teamsQueryError && teamsQueryLoading && teams.length === 0
  const [selectedTeamId, setSelectedTeamId] = useState<string | number | null>(teams[0]?.id ?? null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [svrz, setSvrz] = useState<SvrzStatus | null>(null)
  // `svrz === null` carried two meanings — "still fetching" and "never synced" — and
  // the summary line printed the second for both, inviting a redundant multi-minute
  // re-sync. Tracked apart so the panel makes no claim until the status call has
  // answered, and so a dead call never masquerades as a never-synced season.
  const [svrzState, setSvrzState] = useState<'loading' | 'ready' | 'failed'>('loading')

  // ⚠ Do NOT seed `selectedTeamId` from `teams[0]` to make the header read better.
  // It looks like a loading fix, but the ref-guarded effect below is gated on this
  // value and POSTs `ensureFromSvrz()`, which MINTS opponent invite tokens and
  // toasts. Seeding it fires that write unprompted on every mount of the setup
  // page, for whichever team happens to sort first. The panel's empty header is a
  // render race worth fixing only in ways that do not arm a mutation.

  const selectedTeam = useMemo(() => teams.find((t) => String(t.id) === String(selectedTeamId)) ?? null, [teams, selectedTeamId])
  const api = useInvites(selectedTeamId, seasonId)
  // Invites that can still receive an email (not revoked/expired); booked/viewed
  // can be re-emailed as a reminder.
  const sendableIds = useMemo(
    () => api.invites.filter((i) => i.status !== 'revoked' && i.status !== 'expired').map((i) => i.id),
    [api.invites],
  )
  // Invite links must point at the Spielplanung subdomain (once
  // VITE_SCHEDULING_ORIGIN is set); falls back to the current origin until then.
  const frontendUrl = SCHEDULING_ORIGIN

  // Auto-create invite links for synced opponents the first time a team is shown,
  // so the list populates itself. Runs once per team+season (ref-guarded); the
  // backend dedupes by opponent name, so it's safe regardless of load order.
  const ensuredRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!selectedTeamId || !seasonId) return
    const key = `${selectedTeamId}:${seasonId}`
    if (ensuredRef.current.has(key)) return
    ensuredRef.current.add(key)
    api
      .ensureFromSvrz()
      .then((r) => { if (r && r.created > 0) toast.success(t('invitesAutoCreated', { count: r.created })) })
      .catch(() => { /* best-effort — admin can still add manually */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeamId, seasonId])

  const fetchSvrz = useCallback(async () => {
    try {
      const r = await kscwApi(`/admin/terminplanung/svrz-status?season_name=${encodeURIComponent(seasonName)}`) as SvrzStatus
      setSvrz(r)
      setSvrzState('ready')
    } catch {
      // Still non-blocking, but the failure is recorded rather than swallowed —
      // otherwise a 403/500/offline status call left "SVRZ not synced yet" on
      // screen permanently. Keep whatever a previous call already showed.
      setSvrzState((prev) => (prev === 'ready' ? 'ready' : 'failed'))
    }
  }, [seasonName])
  // The summary fetch only setStates after the await; it runs from an effect-local
  // async function (React's documented data-fetching shape) so the effect body
  // itself stays free of state updates.
  useEffect(() => {
    async function run() { await fetchSvrz() }
    void run()
  }, [fetchSvrz])

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>{t('invites')}</CardTitle>
          <SyncNowButton seasonName={seasonName} onDone={fetchSvrz} />
        </CardHeader>
        <CardContent className="space-y-4">
          {/* SVRZ sync summary — a skeleton bar until the status call answers, so
              the panel never states "not synced yet" about a season it has not
              asked about. A season that synced but returned zero games is synced,
              so `last_synced_at` alone decides it. */}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {svrz && svrz.total > 0 && svrz.last_synced_at ? (
              t('svrzSynced', {
                date: formatDateTimeCompact(svrz.last_synced_at),
                total: svrz.total,
                home: svrz.home,
                away: svrz.away,
              })
            ) : svrzState === 'loading' ? (
              <span className="inline-block h-3 w-56 max-w-full animate-pulse rounded bg-gray-200 align-middle dark:bg-gray-700" aria-hidden />
            ) : svrzState === 'failed' ? (
              // The status call itself failed — say nothing rather than guess. An em
              // dash is the same "unknown" marker this panel already uses for a
              // missing league, and needs no new translated string.
              '—'
            ) : (
              t('svrzNotSynced')
            )}
          </p>

          {/* Team selector */}
          <div className="flex flex-wrap gap-1">
            {teamsPending
              ? [0, 1, 2].map((i) => (
                  <div key={i} className="h-8 w-32 animate-pulse rounded-md bg-gray-200 dark:bg-gray-700" aria-hidden />
                ))
              : teams.map((tm) => (
                  <Button
                    key={tm.id}
                    size="sm"
                    variant={String(tm.id) === String(selectedTeamId) ? 'default' : 'outline'}
                    onClick={() => setSelectedTeamId(tm.id)}
                  >
                    {tm.name} <span className="ml-1 text-xs opacity-70">({tm.league || '—'})</span>
                  </Button>
                ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 break-words text-sm text-gray-600 dark:text-gray-400">
              {teamsPending ? (
                <span className="inline-block h-4 w-52 max-w-full animate-pulse rounded bg-gray-200 align-middle dark:bg-gray-700" aria-hidden />
              ) : (
                <>
                  {selectedTeam ? `${selectedTeam.name} (${selectedTeam.league || '—'})` : '—'}{' · '}
                  {api.isLoading ? (
                    <span className="inline-block h-3 w-16 animate-pulse rounded bg-gray-200 align-middle dark:bg-gray-700" aria-hidden />
                  ) : (
                    `${api.invites.length} ${t('invites')}`
                  )}
                </>
              )}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setSendOpen(true)}
                disabled={!selectedTeam || sendableIds.length === 0}
              >
                {t('emailInvites')}
              </Button>
              <Button onClick={() => setDrawerOpen(true)} disabled={!selectedTeam}>
                {t('manageInvites')}
              </Button>
            </div>
          </div>

          {teamsPending || api.isLoading ? (
            // Skeleton rows, not a verdict: "No invites created yet" is a factual
            // claim, and it used to paint before a team had even been selected.
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-700/50" />
              ))}
            </div>
          ) : api.invites.length === 0 ? (
            <div className="rounded border border-dashed border-gray-300 py-6 text-center text-sm text-gray-500 dark:border-gray-700">
              {t('noInvitesYet')}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {api.invites.map((inv) => (
                <InviteRow
                  key={inv.id}
                  invite={inv}
                  kscwTeam={{ name: selectedTeam?.name ?? '', league: selectedTeam?.league ?? '' }}
                  season={{ name: seasonName }}
                  frontendUrl={frontendUrl}
                  onReissue={api.reissue}
                  onRevoke={api.revoke}
                  onSent={api.markSent}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <InvitesDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        kscwTeam={selectedTeam ? { id: selectedTeam.id, name: selectedTeam.name, league: selectedTeam.league || '' } : null}
        api={api}
      />

      {selectedTeam && (
        <SendInvitesModal
          open={sendOpen}
          onOpenChange={setSendOpen}
          ids={sendableIds}
          ctx={{ seasonName, kscwTeamName: selectedTeam.name, kscwLeague: selectedTeam.league || '' }}
          api={api}
        />
      )}
    </>
  )
}
