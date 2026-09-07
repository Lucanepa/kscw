import { useState, useMemo, useEffect } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Plus, X, Clock } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useCollection } from '../../lib/query'
import { kscwApi } from '../../lib/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import StatusBadge from '../../components/StatusBadge'
import TeamChip from '../../components/TeamChip'
import { getFileUrl } from '../../utils/fileUrl'
import { coercePositions, getPositionI18nKey } from '../../utils/memberPositions'
import { memberName, memberFirstName, flattenMemberIds } from '../../utils/relations'
import { formatDate, toISODate } from '../../utils/dateHelpers'
import DeleteAccountModal from './DeleteAccountModal'
import TeamRequestModal from './TeamRequestModal'
import Modal from '@/components/Modal'
import MessagingSettingsCard from '../messaging/pages/MessagingSettingsCard'
import MyRegistrationDocs from './MyRegistrationDocs'
import { useReportPageLoading } from '../../hooks/usePageReady'
import type { MemberTeam, Team, Absence, LicenceType, Fine } from '../../types'
import { formatFineAmount } from '../../hooks/useFines'
import { licencesOf } from '../../types'
import { TRAINER_LICENCE_I18N_KEYS, parseTrainerLicences } from '../../utils/trainerLicences'
import { LICENCE_STATUS_BADGE, effectiveLicenceStatus } from '../../utils/licenceStatus'
import { currentSeasonShort } from '../../utils/season'
import { updateRecord, deleteRecord } from '../../lib/api'
import { asObj } from '../../utils/relations'

const LICENCE_LABELS: Record<LicenceType, string> = {
  scorer_vb: 'licenceScorer',
  referee_vb: 'licenceReferee',
  otr1_bb: 'licenceOTR1',
  otr2_bb: 'licenceOTR2',
  otn1_bb: 'licenceOTN1',
  otn2_bb: 'licenceOTN2',
  referee_bb: 'licenceRefereeBB',
}

type ExpandedMemberTeam = MemberTeam & { team: Team | string }

/**
 * Per-member auto sign-in (auto-confirm RSVP) toggles — migration 077.
 * When a toggle is on, the member is auto-confirmed on every new activity of
 * that type, and flipping it on backfills existing upcoming ones (server-side
 * via the members.items.update hook). Already-answered / absence-declined
 * activities are never changed. Independent of (OR-ed with) the team setting.
 */
function AutoSignInCard() {
  const { user } = useAuth()
  const { t } = useTranslation('participation')
  const [state, setState] = useState({
    trainings: !!user?.auto_confirm_trainings,
    games: !!user?.auto_confirm_games,
    events: !!user?.auto_confirm_events,
  })
  const [saving, setSaving] = useState<string | null>(null)

  // Re-sync from the auth user when it refreshes elsewhere (the useState
  // initializer only runs on mount). Keyed on the specific flags so it's a
  // no-op unless a value actually changes — same trigger as the old effect's
  // dependency array, but applied during render (no cascading re-render).
  const syncKey = `${!!user?.auto_confirm_trainings}|${!!user?.auto_confirm_games}|${!!user?.auto_confirm_events}`
  const [prevSyncKey, setPrevSyncKey] = useState(syncKey)
  if (prevSyncKey !== syncKey) {
    setPrevSyncKey(syncKey)
    setState({
      trainings: !!user?.auto_confirm_trainings,
      games: !!user?.auto_confirm_games,
      events: !!user?.auto_confirm_events,
    })
  }

  if (!user) return null

  const rows: { key: 'trainings' | 'games' | 'events'; field: string; label: string }[] = [
    { key: 'trainings', field: 'auto_confirm_trainings', label: t('autoSignInTrainings') },
    { key: 'games', field: 'auto_confirm_games', label: t('autoSignInGames') },
    { key: 'events', field: 'auto_confirm_events', label: t('autoSignInEvents') },
  ]

  async function toggle(key: 'trainings' | 'games' | 'events', field: string, val: boolean) {
    setState((s) => ({ ...s, [key]: val }))
    setSaving(key)
    try {
      await updateRecord('members', user!.id, { [field]: val })
    } catch {
      setState((s) => ({ ...s, [key]: !val })) // revert on failure
    } finally {
      setSaving(null)
    }
  }

  return (
    <div data-tour="profile-attendance" className="mt-8">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('autoSignInTitle')}</h2>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('autoSignInHint')}</p>
      <div className="mt-3 divide-y divide-gray-100 rounded-lg border bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.label}</span>
            <Switch
              checked={state[r.key]}
              disabled={saving === r.key}
              onCheckedChange={(v) => toggle(r.key, r.field, v)}
              aria-label={r.label}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Per-member notification opt-out toggles — migration 156. Default-on flags;
 * turning one off suppresses that email (or, for form submissions, that push) in
 * the backend send paths — never the in-app notification bell. Each row only
 * shows to people who can actually receive that notification, so a plain member
 * sees just club news + event invitations.
 */
type NotifyRow = {
  key: string
  field: keyof Pick<
    NonNullable<ReturnType<typeof useAuth>['user']>,
    | 'email_notify_registrations'
    | 'email_notify_join_requests'
    | 'email_notify_form_submissions'
    | 'email_notify_announcements'
    | 'email_notify_events'
  >
  label: string
  show: boolean
}

function EmailNotificationCard() {
  const { user, isAdmin, isCoach, teamResponsibleIds } = useAuth()
  const { t } = useTranslation('auth')
  const isLeader = isCoach || teamResponsibleIds.length > 0

  const allRows: NotifyRow[] = [
    { key: 'registrations', field: 'email_notify_registrations', label: t('emailNotifyRegistrations'), show: isAdmin },
    { key: 'joinRequests', field: 'email_notify_join_requests', label: t('emailNotifyJoinRequests'), show: isLeader },
    { key: 'forms', field: 'email_notify_form_submissions', label: t('emailNotifyFormSubmissions'), show: isLeader },
    { key: 'announcements', field: 'email_notify_announcements', label: t('emailNotifyAnnouncements'), show: true },
    { key: 'events', field: 'email_notify_events', label: t('emailNotifyEvents'), show: true },
  ]
  const rows = allRows.filter((r) => r.show)

  // Default-on: an undefined flag (older row, or before the migration lands)
  // reads as "receiving".
  const [state, setState] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(allRows.map((r) => [r.key, user?.[r.field] !== false])),
  )
  const [saving, setSaving] = useState<string | null>(null)

  // Re-sync from the auth user when it refreshes elsewhere (the useState
  // initializer only runs on mount). Keyed on the specific opt-out flags — the
  // same trigger the old effect's dependency array had, applied during render
  // (no cascading re-render). `String()` keeps `undefined` (default-on) and
  // `false` (opted out) distinguishable.
  const syncKey = [
    user?.email_notify_registrations,
    user?.email_notify_join_requests,
    user?.email_notify_form_submissions,
    user?.email_notify_announcements,
    user?.email_notify_events,
  ].map(String).join('|')
  const [prevSyncKey, setPrevSyncKey] = useState(syncKey)
  if (prevSyncKey !== syncKey) {
    setPrevSyncKey(syncKey)
    setState(Object.fromEntries(allRows.map((r) => [r.key, user?.[r.field] !== false])))
  }

  if (!user || rows.length === 0) return null

  async function toggle(row: NotifyRow, val: boolean) {
    setState((s) => ({ ...s, [row.key]: val }))
    setSaving(row.key)
    try {
      await updateRecord('members', user!.id, { [row.field]: val })
    } catch {
      setState((s) => ({ ...s, [row.key]: !val })) // revert on failure
    } finally {
      setSaving(null)
    }
  }

  return (
    <div data-tour="profile-emails" className="mt-8">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('emailNotifyTitle')}</h2>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('emailNotifyHint')}</p>
      <div className="mt-3 divide-y divide-gray-100 rounded-lg border bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800">
        {rows.map((r) => (
          <div key={r.key} className="flex min-h-[44px] items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.label}</span>
            <Switch
              checked={state[r.key]}
              disabled={saving === r.key}
              onCheckedChange={(v) => toggle(r, v)}
              aria-label={r.label}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function ProfilePage() {
  const { user, coachTeamIds, primarySport, refreshTeamContext } = useAuth()
  const { t } = useTranslation('auth')
  const { t: tt } = useTranslation('teams')
  const { t: tCommon } = useTranslation('common')
  // Never the raw column: between the 1 June rollover and the sweep that
  // follows it, `licence_status` still holds last season's answer, and a green
  // "Licenced" badge outliving its licence is the whole failure this guards.
  const licenceStatus = effectiveLicenceStatus(user)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [teamRequestOpen, setTeamRequestOpen] = useState(false)
  const [leavingTeam, setLeavingTeam] = useState<{ id: string; name: string } | null>(null)
  const [leaving, setLeaving] = useState(false)

  const { data: memberTeamsRaw, isLoading: memberTeamsLoading, refetch: refetchMemberTeams } = useCollection<ExpandedMemberTeam>('member_teams', {
    // Gate on the TEAM being active, not member_teams.season — the archived
    // same-name row this was written to hide is inactive, and the season stamp
    // is uncoupled from the rollover (it emptied /profile for ~34h in 2026,
    // taking the per-team leave buttons and `currentTeamIds` with it).
    filter: user ? { _and: [{ member: { _eq: user.id } }, { team: { active: { _eq: true } } }] } : undefined,
    fields: ['*', 'team.*'],
    limit: 20,
    enabled: !!user,
  })
  const memberTeams = memberTeamsRaw ?? []

  // Pending team requests
  interface TeamRequest { id: string; member: string; team: Team | string; status: string }
  const { data: pendingRequestsRaw, refetch: refetchRequests } = useCollection<TeamRequest>('team_requests', {
    filter: user ? { _and: [{ member: { _eq: user.id } }, { status: { _eq: 'pending' } }] } : undefined,
    fields: ['*', 'team.*'],
    limit: 20,
    enabled: !!user,
  })
  const pendingRequests = pendingRequestsRaw ?? []

  const currentTeamIds = useMemo(
    () => memberTeams.map((mt) => asObj<Team>(mt.team)?.id ?? (mt.team as string)),
    [memberTeams],
  )

  async function handleCancelRequest(requestId: string) {
    try {
      await updateRecord('team_requests', requestId, { status: 'cancelled' })
      refetchRequests()
    } catch {
      // updateRecord already captured the error; surface it so a failed cancel
      // isn't mistaken for success (was a silent swallow).
      toast.error(t('errorSaving'))
    }
  }

  async function handleLeaveTeam() {
    if (!leavingTeam) return
    setLeaving(true)
    try {
      await deleteRecord('member_teams', leavingTeam.id)
      setLeavingTeam(null)
      refetchMemberTeams()
      refreshTeamContext()
    } catch {
      // deleteRecord already captured the error; surface it so a failed leave
      // isn't mistaken for success (was a silent swallow).
      toast.error(t('leaveTeamError'))
    } finally {
      setLeaving(false)
    }
  }

  // Fetch extra VM data from sv_vm_check (LAS, foreigner, federation, FdO, dates)
  // via the dedicated /kscw/sv-licence/me endpoint. Direct sv_vm_check.read is
  // revoked for KSCW Member because Directus 11 emits invalid `CASE WHEN 1` SQL
  // when a row filter is applied to this collection.
  interface VmCheck { id: string; licence_category: string | null; licence_activated: boolean | null; licence_validated: boolean | null; is_locally_educated: boolean | null; is_foreigner: boolean | null; federation: string | null; nationality_code: string | null }
  const [vmCheck, setVmCheck] = useState<VmCheck | null>(null)
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    kscwApi('/sv-licence/me')
      .then((r) => { if (!cancelled) setVmCheck((r as { data: VmCheck | null })?.data ?? null) })
      .catch(() => { if (!cancelled) setVmCheck(null) })
    return () => { cancelled = true }
  }, [user?.id])

  const today = toISODate(new Date())

  const { data: activeAbsencesRaw, isLoading: absencesLoading } = useCollection<Absence>('absences', {
    filter: user ? { _and: [{ member: { _eq: user.id } }, { end_date: { _gte: today } }] } : undefined,
    sort: ['start_date'],
    limit: 20,
    enabled: !!user,
  })
  const activeAbsences = activeAbsencesRaw ?? []

  // Open fines summary (visible to the member themselves).
  const { data: openFinesRaw, isLoading: openFinesLoading } = useCollection<Fine>('fines', {
    filter: user ? { _and: [{ member: { _eq: user.id } }, { status: { _eq: 'open' } }] } : undefined,
    fields: ['id', 'amount', 'currency'],
    enabled: !!user,
    all: true,
  })
  const openFines = openFinesRaw ?? []
  const openFineTotal = openFines.reduce((acc, f) => acc + (Number(f.amount) || 0), 0)

  // Report to the app boot gate — see usePageReady.tsx. Must run on every render,
  // so it sits BEFORE the <Navigate> guard below (rules-of-hooks / React #310).
  // The absences + fines queries belong here alongside member_teams: they are
  // separate round-trips, and `?? []` makes "still in flight" indistinguishable
  // from "genuinely none", so gating on member_teams alone revealed the page
  // with a definitive "No active absences" (and no outstanding-fines strip)
  // that a moment later filled in.
  useReportPageLoading(memberTeamsLoading || absencesLoading || openFinesLoading)

  if (!user) return <Navigate to="/login" replace />

  const initials = `${memberFirstName(user)?.[0] ?? ''}${user.last_name?.[0] ?? ''}`.toUpperCase()
  const positions = coercePositions(user.position)

  return (
    <div>
      {/* Header card */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        {/* Top: avatar + name + edit */}
        <div className="flex items-center gap-4">
          {user.photo ? (
            <img
              src={getFileUrl('members', user.id, user.photo)}
              alt={memberName(user)}
              className="h-16 w-16 shrink-0 rounded-full object-cover ring-2 ring-brand-500/20 dark:ring-brand-400/30"
            />
          ) : (
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-brand-50 text-lg font-bold text-brand-600 ring-2 ring-brand-500/20 dark:bg-brand-900/30 dark:text-brand-400 dark:ring-brand-400/30">
              {initials}
            </div>
          )}
          <div className="min-w-0 flex-1">
            {/* First/last name on their own lines on mobile — never ellipsized. */}
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              {user.first_name || user.last_name ? (
                <>
                  <span className="block break-words sm:inline">{memberFirstName(user)}</span>
                  <span className="block break-words sm:ml-1.5 sm:inline">{user.last_name}</span>
                </>
              ) : (
                '—'
              )}
            </h1>
            {(user.number > 0 || positions.length > 0) && (
              <div className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                {user.number > 0 && (
                  <p className="font-semibold text-gray-700 dark:text-gray-300">#{user.number}</p>
                )}
                {positions.length > 0 && (
                  <p>{positions.map((p) => (getPositionI18nKey(p) ? tt(getPositionI18nKey(p)!) : p)).join(', ')}</p>
                )}
              </div>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            asChild
            className="shrink-0"
          >
            <Link to="/profile/edit">{t('editProfile')}</Link>
          </Button>
        </div>

        {/* Teams & Roles */}
        {(memberTeams.length > 0 || user.role.length > 0) && (
          <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-700">
            {memberTeams.length > 0 && (
              <div className="flex flex-col">
                <span className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('teams')}</span>
                {memberTeams.map((mt, i) => {
                  const team = asObj<Team>(mt.team)
                  const teamRoles: string[] = [tt('rolePlayer')]
                  if (team) {
                    const tid = String(team.id)
                    if (coachTeamIds.includes(tid)) teamRoles.push(tt('roleCoach'))
                    if (flattenMemberIds(team.captain).includes(String(user.id))) teamRoles.push(tt('roleCaptain'))
                  }
                  const isLast = i === memberTeams.length - 1
                  return (
                    <div key={mt.id} className="flex items-stretch">
                      {/* Vertical connector line */}
                      <div className="flex w-5 flex-col items-center">
                        <div className={`w-px flex-1 ${i === 0 ? 'bg-transparent' : 'bg-gray-300 dark:bg-gray-600'}`} />
                        <div className="h-2 w-2 shrink-0 rounded-full bg-gray-300 dark:bg-gray-500" />
                        <div className={`w-px flex-1 ${isLast ? 'bg-transparent' : 'bg-gray-300 dark:bg-gray-600'}`} />
                      </div>
                      {/* Horizontal connector + content */}
                      <div className="flex flex-1 items-center gap-2.5 py-1.5">
                        <div className="w-4 border-t border-gray-300 dark:border-gray-600" />
                        <Link to={`/teams/${team?.name ?? mt.team}`} className="flex shrink-0">
                          <TeamChip team={team?.name ?? '?'} size="sm" />
                        </Link>
                        <span className="text-xs text-gray-600 dark:text-gray-400">
                          {teamRoles.join(' · ')}
                        </span>
                        <button
                          onClick={() => setLeavingTeam({ id: mt.id, name: team?.name ?? String(mt.team) })}
                          className="ml-auto rounded-full p-0.5 text-gray-400 hover:bg-gray-100 hover:text-red-500 dark:hover:bg-gray-700 dark:hover:text-red-400"
                          title={t('leaveTeam')}
                          aria-label={t('leaveTeam')}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Pending team requests */}
            {pendingRequests.length > 0 && (
              <div className="mt-1 space-y-1">
                {pendingRequests.map((req) => (
                  <div key={req.id} className="flex items-center gap-2.5 py-1.5 pl-5">
                    <Clock className="h-3.5 w-3.5 text-amber-500" />
                    <TeamChip team={asObj<Team>(req.team)?.name ?? '?'} size="sm" />
                    <span className="text-xs text-amber-600 dark:text-amber-400">{t('pendingApproval')}</span>
                    <button
                      onClick={() => handleCancelRequest(req.id)}
                      className="ml-auto rounded-full p-0.5 text-gray-400 hover:bg-gray-100 hover:text-red-500 dark:hover:bg-gray-700 dark:hover:text-red-400"
                      title={t('common:cancel')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add Team button */}
            <button
              onClick={() => setTeamRequestOpen(true)}
              className="mt-1 flex items-center gap-1.5 py-1.5 pl-5 text-xs text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('addTeam')}
            </button>

            {user.role.length > 0 && (
              <div className={memberTeams.length > 0 ? 'mt-2 border-t border-gray-100 pt-2 dark:border-gray-700' : ''}>
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('roles')}</span>
                <div className="flex flex-col border-l-2 border-gray-300 pl-3 dark:border-gray-600">
                  {[...user.role].sort((a, b) => {
                    const order = ['user', 'coach', 'team_responsible', 'finance', 'vb_admin', 'bb_admin', 'vorstand', 'admin', 'superuser', 'superadmin']
                    return (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b))
                  }).map((r) => (
                    <div key={r} className="flex items-center gap-2.5 py-1">
                      <div className="w-4 border-t border-gray-300 dark:border-gray-600" />
                      <StatusBadge status={r} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Auto sign-in preferences */}
      <AutoSignInCard />

      {/* Email / notification preferences */}
      <EmailNotificationCard />

      {/* Contact Info */}
      <div data-tour="profile-contact" className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('contact')}</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('contactPrivacyNotice')}</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div data-tour="profile-privacy" className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center gap-2">
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('email')}</p>
              {user.hide_email && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">{t('hidden')}</span>
              )}
            </div>
            <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">{user.email || '—'}</p>
          </div>
          <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center gap-2">
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('phone')}</p>
              {user.hide_phone && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">{t('hidden')}</span>
              )}
            </div>
            <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">{user.phone || '—'}</p>
          </div>
          <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center gap-2">
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('birthdate')}</p>
              {user.birthdate_visibility === 'hidden' && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">{t('hidden')}</span>
              )}
              {user.birthdate_visibility === 'year_only' && (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">{t('yearOnly')}</span>
              )}
            </div>
            <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
              {user.birthdate ? formatDate(user.birthdate) : '—'}
            </p>
          </div>
          <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('licences')}</p>
            {(() => {
              const lics = licencesOf(user)
              return lics.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {lics.map((l) => (
                    <span key={l} className="inline-flex rounded-full bg-gold-100 px-2.5 py-0.5 text-xs font-medium text-gold-900 dark:bg-gold-400/20 dark:text-gold-300">
                      {tt(LICENCE_LABELS[l])}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">—</p>
              )
            })()}
          </div>
          {/* Coaching education (migration 274) — its own card rather than more
              chips in the licences one: J+S / C / B / A is a different kind of
              credential from the scorer/referee flags and reads as noise mixed in. */}
          <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('trainerLicences')}</p>
            {(() => {
              const codes = parseTrainerLicences(user.trainer_licences)
              return codes.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {codes.map((c) => (
                    <span key={c} className="inline-flex rounded-full bg-gold-100 px-2.5 py-0.5 text-xs font-medium text-gold-900 dark:bg-gold-400/20 dark:text-gold-300">
                      {t(TRAINER_LICENCE_I18N_KEYS[c])}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">—</p>
              )
            })()}
          </div>
          {/* Licence status (migration 301) — read-only for the member BY
              DESIGN. This is the club's answer to "where has your licence got
              to", not a claim the member gets to make about themselves; the
              write lives with admins and with the federation sync. Shown to
              everyone, both sports, because "No licence" is a real and useful
              answer for a coach or a passive member, not an empty state. */}
          <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center gap-2">
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('licenceStatusTitle')}</p>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                {currentSeasonShort()}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${LICENCE_STATUS_BADGE[licenceStatus.status]}`}>
                {tCommon(`licenceStatus_${licenceStatus.status}`)}
              </span>
              {licenceStatus.status === 'licenced' && user.licence_status_by_name && (
                <span className="text-xs text-gray-500 dark:text-gray-400">{user.licence_status_by_name}</span>
              )}
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t('licenceStatusHelp')}</p>
          </div>
        </div>
      </div>

      {/* Swiss Volley Licence Info — volleyball members only */}
      {(primarySport === 'volleyball' || primarySport === 'both') && user.license_nr && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Swiss Volley</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('svSyncInfo')}</p>
          <div className="mt-3">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('licence')}</span>
            <div className="space-y-2.5">
              {/* Licence card — absence-card style */}
              <div className="rounded-lg border bg-white dark:border-gray-700 dark:bg-gray-800">
                {/* Top row: badge + licence nr + status checks */}
                <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                  {vmCheck?.licence_category && (
                    <span className="inline-flex rounded-full bg-gold-100 px-2.5 py-0.5 text-xs font-medium text-gold-900 dark:bg-gold-400/20 dark:text-gold-300">
                      {vmCheck.licence_category}
                    </span>
                  )}
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t('licenseNr')}: {user.license_nr}
                  </span>
                  {/* LAS / Foreigner / FdO badges */}
                  {vmCheck?.is_locally_educated && (
                    <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
                      {t('svLas')}
                    </span>
                  )}
                  {vmCheck?.is_foreigner && (
                    <span className="inline-flex rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-800 dark:bg-orange-900/30 dark:text-orange-400">
                      {t('svForeigner')}
                    </span>
                  )}
                  {vmCheck?.nationality_code && vmCheck.nationality_code !== 'SUI' && (
                    <span className="inline-flex rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                      FdO: {vmCheck.nationality_code}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-3">
                    {vmCheck?.federation && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">{vmCheck.federation}</span>
                    )}
                    <div className="flex items-center gap-1">
                      <span className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('activated')}</span>
                      {vmCheck?.licence_activated == null
                        ? <span className="text-sm text-gray-400">—</span>
                        : vmCheck.licence_activated
                          ? <span className="text-sm text-green-600 dark:text-green-400">&#10003;</span>
                          : <span className="text-sm text-red-500 dark:text-red-400">&#10007;</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('validated')}</span>
                      {vmCheck?.licence_validated == null
                        ? <span className="text-sm text-gray-400">—</span>
                        : vmCheck.licence_validated
                          ? <span className="text-sm text-green-600 dark:text-green-400">&#10003;</span>
                          : <span className="text-sm text-red-500 dark:text-red-400">&#10007;</span>}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <MessagingSettingsCard />

      {/* Registration documents the member uploaded (renders nothing if none) */}
      <MyRegistrationDocs />

      {/* Open fines strip */}
      {openFines.length > 0 && (
        <div className="mt-6">
          <Link
            to="/fines"
            className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-900/20 dark:hover:bg-amber-900/30"
          >
            <div>
              <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {t('outstandingFines', { amount: formatFineAmount(openFineTotal) })}
              </div>
              <div className="text-xs text-amber-700 dark:text-amber-300">
                {t('outstandingFinesCount', { count: openFines.length })}
              </div>
            </div>
            <span className="text-sm text-amber-700 dark:text-amber-300">→</span>
          </Link>
        </div>
      )}

      {/* Active Absences */}
      <div className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('activeAbsences')}</h2>
          <Link
            to="/absences"
            className="text-sm text-brand-600 hover:text-brand-800 dark:text-gold-400 dark:hover:text-gold-300"
          >
            {t('showAll')}
          </Link>
        </div>
        {absencesLoading ? (
          // `activeAbsences` is `?? []` while the query is in flight, so without
          // this the empty-state paragraph below asserts "nothing on file" before
          // the answer has arrived.
          <div className="mt-3 h-16 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
        ) : activeAbsences.length > 0 ? (
          <div className="mt-3 space-y-2">
            {activeAbsences.slice(0, 5).map((a) => (
              <div key={a.id} className="rounded-lg border bg-white dark:border-gray-700 dark:bg-gray-800">
                <div className="flex items-center gap-3 px-4 py-3">
                  <StatusBadge status={a.reason} />
                  {a.reason_detail && (
                    <span className="text-sm text-gray-500 dark:text-gray-400">{a.reason_detail}</span>
                  )}
                </div>
                <div className="border-t border-gray-100 px-4 py-2 dark:border-gray-700">
                  <span className="text-sm text-gray-700 dark:text-gray-300">
                    {formatDate(a.start_date)}
                    {a.start_date !== a.end_date && ` — ${formatDate(a.end_date)}`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{t('noActiveAbsences')}</p>
        )}
      </div>

      {/* Danger Zone */}
      <div className="mt-8 rounded-2xl border border-red-200 bg-red-50/30 p-5 dark:border-red-900/40 dark:bg-red-950/10">
        <h2 className="text-base font-semibold text-red-600 dark:text-red-400">{t('dangerZone')}</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('deleteAccountDescription')}</p>
        <div className="mt-4">
          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
            {t('deleteAccount')}
          </Button>
        </div>
      </div>

      <TeamRequestModal
        open={teamRequestOpen}
        onClose={() => setTeamRequestOpen(false)}
        onComplete={() => {
          setTeamRequestOpen(false)
          refetchRequests()
        }}
        currentTeamIds={currentTeamIds}
        showLeave={false}
      />
      <DeleteAccountModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        userEmail={user.email}
      />
      <Modal open={!!leavingTeam} onClose={() => setLeavingTeam(null)} title={t('leaveTeamTitle')}>
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('leaveTeamConfirm', { team: leavingTeam?.name ?? '' })}
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setLeavingTeam(null)}>
              {t('common:cancel')}
            </Button>
            <Button variant="destructive" onClick={handleLeaveTeam} loading={leaving} disabled={leaving}>
              {t('leaveTeam')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
