import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { XCircle, ChevronRight, Mail, Phone, Award, Calendar, TrendingUp, AlertCircle, AlertTriangle } from 'lucide-react'
import { differenceInYears } from 'date-fns'
import { useCollection } from '../../lib/query'
import { useAdminMode } from '../../hooks/useAdminMode'
import { useTeamPermissions } from '../../hooks/useTeamPermissions'
import TeamChip from '../../components/TeamChip'
import StatusBadge from '../../components/StatusBadge'
import EmptyState from '../../components/EmptyState'
import { getFileUrl } from '../../utils/fileUrl'
import { coercePositions, getPositionI18nKey } from '../../utils/memberPositions'
import { asObj, relId, memberDisplayName, memberFirstName } from '../../utils/relations'
import { formatDate, getCurrentSeason, todayLocal } from '../../utils/dateHelpers'
import { seasonRolloverDate } from '../../utils/season'
import ImageLightbox from '../../components/ImageLightbox'
import type { Member, MemberTeam, Team, Absence, Participation } from '../../types'
import { absenceCoversActivity } from '../../utils/absenceHelpers'
import { fetchAllItems, fetchItem } from '../../lib/api'
import StartDmButton from '../messaging/components/StartDmButton'
import { useReportPageLoading } from '../../hooks/usePageReady'

type ExpandedMemberTeam = MemberTeam & { team: Team | string }

type Attendance = { total: number; present: number }

/**
 * Identity of an attendance batch: the member and the exact set of active teams
 * it was computed from. A stored batch whose key no longer matches the render
 * is not an answer about this player — it is either stale (route switched to
 * another member without a remount) or absent (the fan-out has not resolved
 * yet), and both must render as "still loading", never as "—".
 */
function statsBatchKey(memberId: string | undefined, memberTeams: ExpandedMemberTeam[]): string {
  return `${memberId ?? ''}|${memberTeams.map((mt) => relId(mt.team)).join(',')}`
}

/** Count confirmed attendance vs excused (covering absence) across activities. */
function computeAttendance(
  activities: Array<{ id: string; date: string }>,
  participations: Participation[],
  seasonAbsences: Absence[],
  activityType: Participation['activity_type'],
): Attendance {
  let present = 0
  let excused = 0
  for (const activity of activities) {
    const activityDate = activity.date.split(' ')[0]
    // Delegate — a bare range check ignores `indefinite`, `type: 'weekly'` +
    // days_of_week, and `affects`. Here that was the worst of the three copies:
    // a covered activity is EXCLUDED from the denominator below, so one
    // indefinite weekly row drove `total` to 0 and rendered 0/0 with "—"
    // percentages for an actively-training player (audit 2026-08-08,
    // finding 32). Prod has 10 indefinite weekly rows, 9 with activities in the
    // current season window.
    const hasAbsence = seasonAbsences.some((a) => absenceCoversActivity(a, activityType, activityDate))
    if (hasAbsence) {
      excused++
    } else {
      const p = participations.find((p) => p.activity_id === activity.id)
      if (p?.status === 'confirmed') present++
    }
  }
  return { total: activities.length - excused, present }
}

export default function PlayerProfile() {
  const { t } = useTranslation('teams')
  const { t: tm } = useTranslation('messaging')
  const { t: tc } = useTranslation('common')
  const { memberId } = useParams<{ memberId: string }>()
  const [searchParams] = useSearchParams()
  const fromTeam = searchParams.get('from')
  const { canManageTeam } = useTeamPermissions()
  const { effectiveIsAdmin } = useAdminMode()
  const [member, setMember] = useState<Member | null>(null)
  const [loading, setLoading] = useState(true)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  const { data: memberTeamsRaw, isLoading: memberTeamsLoading } = useCollection<ExpandedMemberTeam>('member_teams', {
    // Gate on the TEAM being active, not member_teams.season — the archived
    // same-name row this was written to hide is inactive, and the season stamp
    // is uncoupled from the rollover, which blanked the chips AND short-
    // circuited the whole stats batch below for actively-training players.
    filter: memberId ? { _and: [{ member: { _eq: memberId } }, { team: { active: { _eq: true } } }] } : { id: { _eq: -1 } },
    fields: ['*', 'team.*'],
    limit: 20,
  })
  const memberTeams = memberTeamsRaw ?? []

  const season = getCurrentSeason()
  // ⚠ Anchor the window on the ROLLOVER (Jun 1), not on getSeasonDateRange's
  // Sep 1. The season label flips on Jun 1, so a Sep-1 start means that from
  // Jun 1 to Aug 31 the whole window sits in the FUTURE — every training and
  // game of the season that just ended falls outside it, and because
  // computeAttendance applies no past cut the denominator then counts hundreds
  // of unplayed future sessions and every player reads 0%.
  // `end` is capped at today for the same reason: attendance is a record of
  // what has happened, never a prediction about fixtures not yet played.
  const start = seasonRolloverDate()
  const end = todayLocal()

  const { data: absencesRaw, isLoading: absencesLoading } = useCollection<Absence>('absences', {
    filter: memberId ? { _and: [{ member: { _eq: memberId } }, { end_date: { _gte: todayLocal() } }] } : { id: { _eq: -1 } },
    sort: ['start_date'],
    limit: 20,
  })
  const absences = absencesRaw ?? []

  // The attendance batch below is fetched by an effect, so it is NEVER present
  // on the first painted frame — the same commit that lifts the boot gate is the
  // one that schedules the four requests. Storing it under the key it was
  // computed for (member + active teams) is what lets the render tell "not
  // loaded yet" apart from "genuinely none": a missing or mismatched key is a
  // skeleton, `status: 'error'` is a failure, and only a matching ready batch
  // may print a ratio. `null` no longer means four different things at once.
  const [statsBatch, setStatsBatch] = useState<{
    key: string
    status: 'ready' | 'error'
    training: Attendance | null
    games: Attendance | null
  } | null>(null)

  // Re-enter the loading state when the route switches to another member (the
  // page is not remounted). `loading` already starts true, so this only fires on
  // a change — React's adjust-state-during-render pattern, same trigger as the
  // effect below.
  const [prevMemberId, setPrevMemberId] = useState(memberId)
  if (prevMemberId !== memberId) {
    setPrevMemberId(memberId)
    if (memberId) setLoading(true)
  }

  useEffect(() => {
    if (!memberId) return
    fetchItem<Member>('members', memberId)
      .then(setMember)
      .catch(() => setMember(null))
      .finally(() => setLoading(false))
  }, [memberId])

  // Training + game attendance in a single batch. Both stats share the same
  // member participations + season absences, so they're fetched once here (was
  // two effects × 3 queries with participations/absences fetched redundantly).
  useEffect(() => {
    if (!memberId || !memberTeams?.length) return
    const key = statsBatchKey(memberId, memberTeams)
    const teamIds = memberTeams.map((mt) => relId(mt.team))
    let cancelled = false
    Promise.all([
      fetchAllItems<{ id: string; date: string }>('trainings', {
        filter: { _and: [{ team: { _in: teamIds } }, { date: { _gte: start } }, { date: { _lte: end } }, { cancelled: { _eq: false } }] },
        fields: ['id', 'date'],
      }),
      fetchAllItems<{ id: string; date: string }>('games', {
        filter: { _and: [{ kscw_team: { _in: teamIds } }, { date: { _gte: start } }, { date: { _lte: end } }, { _or: [{ status: { _neq: 'postponed' } }, { status: { _null: true } }] }] },
        fields: ['id', 'date'],
      }),
      fetchAllItems<Participation>('participations', {
        filter: { member: { _eq: memberId } },
      }),
      fetchAllItems<Absence>('absences', {
        filter: { _and: [{ member: { _eq: memberId } }, { end_date: { _gte: start } }, { start_date: { _lte: end } }] },
      }),
    ])
      .then(([trainings, games, participations, seasonAbsences]) => {
        if (cancelled) return
        const trainingParts = participations.filter((p) => p.activity_type === 'training')
        const gameParts = participations.filter((p) => p.activity_type === 'game')
        setStatsBatch({
          key,
          status: 'ready',
          training: computeAttendance(trainings, trainingParts, seasonAbsences, 'training'),
          games: computeAttendance(games, gameParts, seasonAbsences, 'game'),
        })
      })
      .catch(() => {
        if (cancelled) return
        // A failed batch is still an ANSWER — it releases the skeleton and says
        // so. Leaving it pending would strand three tiles on a spinner forever.
        setStatsBatch({ key, status: 'error', training: null, games: null })
      })
    return () => { cancelled = true }
  }, [memberId, memberTeams, start, end])

  // Report to app boot gate — see usePageReady.tsx
  useReportPageLoading(loading || memberTeamsLoading || absencesLoading)

  if (loading || memberTeamsLoading || absencesLoading) {
    return null
  }

  if (!member) {
    return <EmptyState icon={<XCircle className="h-10 w-10" />} title={t('playerNotFound')} />
  }

  const initials = `${memberFirstName(member)[0] ?? ''}${member.last_name?.[0] ?? ''}`.toUpperCase()
  const positions = coercePositions(member.position)

  // A member on no ACTIVE team is a real answer, not a pending one: the effect
  // never runs for them and the `_in: []` filters would have matched nothing
  // anyway — so they read 0/0 immediately rather than waiting on a request that
  // is never made. Everyone else is pending until a batch keyed to THIS member
  // and THIS team set has landed, which is also what stops a route switch from
  // painting the previous player's numbers under the new player's name.
  const teamless = memberTeams.length === 0
  const batch = statsBatch?.key === statsBatchKey(memberId, memberTeams) ? statsBatch : null
  const statsPending = !teamless && batch === null
  const statsFailed = batch?.status === 'error'
  const trainingStats: Attendance | null = teamless ? { total: 0, present: 0 } : (batch?.training ?? null)
  const gameStats: Attendance | null = teamless ? { total: 0, present: 0 } : (batch?.games ?? null)

  const trainingPct = trainingStats && trainingStats.total > 0
    ? Math.round((trainingStats.present / trainingStats.total) * 100)
    : null
  const gamePct = gameStats && gameStats.total > 0
    ? Math.round((gameStats.present / gameStats.total) * 100)
    : null

  // Resolve the "from" team for breadcrumb
  const fromTeamData = fromTeam
    ? asObj<Team>(memberTeams.find((mt) => asObj<Team>(mt.team)?.name === fromTeam)?.team)
    : null

  const isCoach = memberTeams.some((mt) => canManageTeam(relId(mt.team)))

  // Absence status: currently absent, soon absent, or count
  const today = todayLocal()
  const in30Days = new Date(new Date(today).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const currentlyAbsent = absences.some(a => a.start_date <= today && a.end_date >= today)
  const soonAbsent = !currentlyAbsent && absences.some(a => a.start_date > today && a.start_date <= in30Days)

  return (
    <div className="mx-auto max-w-3xl">
      {/* Breadcrumb */}
      <nav className="mb-6 flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
        <Link to="/teams" className="transition-colors hover:text-gray-700 dark:hover:text-gray-200">
          {t('title')}
        </Link>
        {fromTeamData && (
          <>
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            <Link
              to={`/teams/${fromTeamData.name}`}
              className="transition-colors hover:text-gray-700 dark:hover:text-gray-200"
            >
              {fromTeamData.full_name}
            </Link>
          </>
        )}
        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium text-gray-900 dark:text-gray-100">{memberDisplayName(member)}</span>
      </nav>

      {effectiveIsAdmin && member.communications_banned === true && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">{tm('bannedBannerTitle')}</div>
            <div className="text-xs text-destructive/80">{tm('bannedBannerBody')}</div>
          </div>
        </div>
      )}

      {/* Profile card */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        {/* Header section */}
        <div className="relative px-6 pb-5 pt-6">
          <div className="flex items-start gap-5">
            {/* Avatar */}
            {member.photo ? (
              <>
                <div className="relative shrink-0">
                  <img
                    src={getFileUrl('members', member.id, member.photo)}
                    alt={memberDisplayName(member)}
                    className="h-20 w-20 cursor-pointer rounded-full object-cover ring-2 ring-white sm:h-24 sm:w-24 dark:ring-gray-800"
                    onClick={() => setLightboxOpen(true)}
                  />
                  {member.number > 0 && (
                    <span className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white ring-2 ring-white dark:ring-gray-800">
                      {member.number}
                    </span>
                  )}
                </div>
                <ImageLightbox
                  src={getFileUrl('members', member.id, member.photo)}
                  alt={memberDisplayName(member)}
                  open={lightboxOpen}
                  onClose={() => setLightboxOpen(false)}
                />
              </>
            ) : (
              <div className="relative shrink-0">
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-brand-100 text-2xl font-bold text-brand-600 sm:h-24 sm:w-24 dark:bg-brand-900/40 dark:text-brand-300">
                  {initials}
                </div>
                {member.number > 0 && (
                  <span className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white ring-2 ring-white dark:ring-gray-800">
                    {member.number}
                  </span>
                )}
              </div>
            )}

            {/* Info */}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">
                  {memberDisplayName(member)}
                </h1>
                {member.role.map((r) => <StatusBadge key={r} status={r} />)}
              </div>

              {positions.length > 0 && (
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  {positions.map((p) => (getPositionI18nKey(p) ? t(getPositionI18nKey(p)!) : p)).join(' · ')}
                </p>
              )}

              {/* Contact info — coach only */}
              {isCoach && (
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
                  {member.birthdate_visibility !== 'hidden' && member.birthdate && (
                    <span className="inline-flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5" />
                      {t('age', { years: differenceInYears(new Date(), new Date(member.birthdate)) })}
                    </span>
                  )}
                  {!member.hide_email && member.email && (
                    <a href={`mailto:${member.email}`} className="inline-flex items-center gap-1.5 transition-colors hover:text-brand-500">
                      <Mail className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">{member.email}</span>
                      <span className="sm:hidden">Email</span>
                    </a>
                  )}
                  {!member.hide_phone && member.phone && (
                    <a href={`tel:${member.phone}`} className="inline-flex items-center gap-1.5 transition-colors hover:text-brand-500">
                      <Phone className="h-3.5 w-3.5" />
                      {member.phone}
                    </a>
                  )}
                  {member.license_nr && (
                    <span className="inline-flex items-center gap-1.5">
                      <Award className="h-3.5 w-3.5" />
                      {member.license_nr}
                    </span>
                  )}
                </div>
              )}

              {/* Start DM entry point — self-hides when viewing own profile, feature flag off, or DMs disabled */}
              <div className="mt-3">
                <StartDmButton recipientId={String(member.id)} />
              </div>
            </div>
          </div>
        </div>

        {/* Teams row */}
        <div className="border-t border-gray-100 bg-gray-50 px-6 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <div className="flex flex-wrap items-center gap-2">
            {memberTeams.map((mt) => {
              const teamObj = asObj<Team>(mt.team)
              return (
                <Link key={mt.id} to={`/teams/${teamObj?.name ?? (mt.team as string)}`}>
                  <TeamChip team={teamObj?.name ?? '?'} />
                </Link>
              )
            })}
            {memberTeams.length === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('noTeams')}</p>
            )}
          </div>
        </div>
      </div>

      {/* Statistics */}
      <div className="mt-6">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {t('statistics')} ({season})
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label={t('trainingsAttended')}
            value={trainingStats ? `${trainingStats.present}/${trainingStats.total}` : statsFailed ? tc('error') : '—'}
            sub={trainingPct !== null ? `${trainingPct}%` : undefined}
            icon={<TrendingUp className="h-4 w-4" />}
            color="brand"
            loading={statsPending}
            muted={statsFailed}
          />
          <StatCard
            label={t('gamesAttended')}
            value={gameStats ? `${gameStats.present}/${gameStats.total}` : statsFailed ? tc('error') : '—'}
            sub={gamePct !== null ? `${gamePct}%` : undefined}
            icon={<TrendingUp className="h-4 w-4" />}
            color="emerald"
            loading={statsPending}
            muted={statsFailed}
          />
          {/* The red flag is a claim about a loaded number — never let it appear
              (or vanish) under the reader while the batch is still in flight. */}
          <StatCard
            label={t('trainingRate')}
            value={trainingPct !== null ? `${trainingPct}%` : statsFailed ? tc('error') : '—'}
            icon={<TrendingUp className="h-4 w-4" />}
            color="amber"
            highlight={!statsPending && trainingPct !== null && trainingPct < 50}
            loading={statsPending}
            muted={statsFailed}
          />
          <StatCard
            label={currentlyAbsent ? t('currentlyAbsent') : soonAbsent ? t('soonAbsent') : t('activeAbsences')}
            value={currentlyAbsent ? t('absent') : soonAbsent ? t('upcoming') : String(absences.length)}
            icon={<AlertCircle className="h-4 w-4" />}
            color={currentlyAbsent ? 'red' : soonAbsent ? 'amber' : 'red'}
            highlight={currentlyAbsent}
          />
        </div>
      </div>

      {/* Active Absences */}
      {absences.length > 0 && (
        <div className="mt-6">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('currentAbsences')}
          </h2>
          <div className="mt-3 space-y-2">
            {absences.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800"
              >
                <StatusBadge status={a.reason} />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {formatDate(a.start_date)}
                  {a.start_date !== a.end_date && ` — ${formatDate(a.end_date)}`}
                </span>
                {a.reason_detail && (
                  <span className="text-sm text-gray-400">{a.reason_detail}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  icon,
  color,
  highlight,
  loading,
  muted,
}: {
  label: string
  value: string
  sub?: string
  icon: React.ReactNode
  color: 'brand' | 'emerald' | 'amber' | 'red'
  highlight?: boolean
  /**
   * The number behind this tile has not arrived yet. The value slot becomes a
   * skeleton of exactly the line's height, so the tile keeps its size and an
   * unloaded stat can never be misread as "no attendance on record".
   */
  loading?: boolean
  /** The value is a message (a failed fetch), not a figure — render it as prose. */
  muted?: boolean
}) {
  const iconColors = {
    brand: 'text-brand-500 bg-brand-50 dark:bg-brand-900/30 dark:text-brand-400',
    emerald: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-400',
    amber: 'text-amber-600 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-400',
    red: 'text-red-600 bg-red-50 dark:bg-red-900/30 dark:text-red-400',
  }

  return (
    <div
      className={`rounded-lg border p-3 sm:p-4 ${
        highlight && !loading
          ? 'border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-900/10'
          : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`flex h-6 w-6 items-center justify-center rounded-md ${iconColors[color]}`}>
          {icon}
        </span>
        <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        {loading ? (
          // h-7 / sm:h-8 matches the value line's height exactly — the tile does
          // not resize when the real figure lands.
          <span
            aria-hidden="true"
            className="inline-block h-7 w-16 animate-pulse rounded bg-gray-200 sm:h-8 dark:bg-gray-700"
          />
        ) : (
          <>
            <p
              className={
                muted
                  ? 'text-sm font-medium leading-7 text-gray-500 sm:leading-8 dark:text-gray-400'
                  : 'text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100'
              }
            >
              {value}
            </p>
            {sub && (
              <span className="text-sm text-gray-400 dark:text-gray-500">{sub}</span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
