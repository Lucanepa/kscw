import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../hooks/useAuth'
import { usePB } from '../../hooks/usePB'
import StatusBadge from '../../components/StatusBadge'
import TeamChip from '../../components/TeamChip'
import ParticipationButton from '../../components/ParticipationButton'
import { getFileUrl } from '../../utils/pbFile'
import { formatDate, getCurrentSeason, toISODate } from '../../utils/dateHelpers'
import ProfileEditModal from './ProfileEditModal'
import type { MemberTeam, Team, Absence, Training, Game, Event } from '../../types'

type ExpandedMemberTeam = MemberTeam & { expand?: { team?: Team } }
type ExpandedTraining = Training & { expand?: { team?: Team } }
type ExpandedGame = Game & { expand?: { kscw_team?: Team } }

export default function ProfilePage() {
  const { user } = useAuth()
  const { t } = useTranslation('auth')
  const { t: tc } = useTranslation('common')
  const [editOpen, setEditOpen] = useState(false)

  const { data: memberTeams } = usePB<ExpandedMemberTeam>('member_teams', {
    filter: user ? `member="${user.id}"` : '',
    expand: 'team',
    perPage: 20,
  })

  const teamIds = memberTeams.map((mt) => mt.team)
  const today = toISODate(new Date())
  const fourWeeks = toISODate(new Date(Date.now() + 28 * 24 * 60 * 60 * 1000))

  const teamFilter = teamIds.length > 0
    ? teamIds.map((id) => `team="${id}"`).join(' || ')
    : 'team=""'

  const kscwTeamFilter = teamIds.length > 0
    ? teamIds.map((id) => `kscw_team="${id}"`).join(' || ')
    : 'kscw_team=""'

  const { data: upcomingTrainings } = usePB<ExpandedTraining>('trainings', {
    filter: `(${teamFilter}) && date>="${today}" && date<="${fourWeeks}" && cancelled=false`,
    sort: 'date,start_time',
    expand: 'team',
    perPage: 10,
  })

  const { data: upcomingGames } = usePB<ExpandedGame>('games', {
    filter: `(${kscwTeamFilter}) && date>="${today}" && date<="${fourWeeks}"`,
    sort: 'date,time',
    expand: 'kscw_team',
    perPage: 10,
  })

  const { data: upcomingEvents } = usePB<Event>('events', {
    filter: `start_date>="${today}" && start_date<="${fourWeeks}"`,
    sort: 'start_date',
    perPage: 10,
  })

  const { data: activeAbsences } = usePB<Absence>('absences', {
    filter: user ? `member="${user.id}" && end_date>="${today}"` : '',
    sort: 'start_date',
    perPage: 20,
  })

  if (!user) return <Navigate to="/login" replace />

  const initials = `${user.first_name?.[0] ?? ''}${user.last_name?.[0] ?? ''}`.toUpperCase()
  const season = getCurrentSeason()

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-start gap-6">
        {user.photo ? (
          <img
            src={getFileUrl('members', user.id, user.photo)}
            alt={user.name}
            className="h-24 w-24 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-24 w-24 items-center justify-center rounded-full bg-gray-200 text-2xl font-bold text-gray-500 dark:bg-gray-700 dark:text-gray-400">
            {initials}
          </div>
        )}
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{user.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
            {user.number > 0 && <span>#{user.number}</span>}
            <span className="capitalize">{user.position}</span>
            {user.role.map((r) => <StatusBadge key={r} status={r} />)}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {memberTeams.map((mt) => (
              <Link key={mt.id} to={`/teams/${mt.team}`}>
                <TeamChip team={mt.expand?.team?.name ?? '?'} />
              </Link>
            ))}
          </div>
          <button
            onClick={() => setEditOpen(true)}
            className="mt-3 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
          >
            {t('editProfile')}
          </button>
        </div>
      </div>

      {/* Contact Info */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('contact')}</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('email')}</p>
            <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">{user.email || '—'}</p>
          </div>
          <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('phone')}</p>
            <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">{user.phone || '—'}</p>
          </div>
          <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('licenseNr')}</p>
            <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">{user.license_nr || '—'}</p>
          </div>
          <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-sm text-gray-500 dark:text-gray-400">{tc('season')}</p>
            <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">{season}</p>
          </div>
        </div>
      </div>

      {/* Upcoming Activities */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('upcomingActivities')}</h2>
        <div className="mt-3 space-y-2">
          {upcomingTrainings.map((tr) => (
            <div key={tr.id} className="flex items-center gap-3 rounded-lg border bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
              <span className="text-lg">🎯</span>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t('training')} {tr.expand?.team?.name ?? ''}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {formatDate(tr.date)} · {tr.start_time}–{tr.end_time}
                </p>
              </div>
              <ParticipationButton
                activityType="training"
                activityId={tr.id}
                activityDate={tr.date}
                compact
              />
            </div>
          ))}
          {upcomingGames.map((g) => (
            <div key={g.id} className="flex items-center gap-3 rounded-lg border bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
              <span className="text-lg">🏐</span>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {g.home_team} vs {g.away_team}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {formatDate(g.date)} · {g.time}
                </p>
              </div>
              <ParticipationButton
                activityType="game"
                activityId={g.id}
                activityDate={g.date}
                compact
              />
            </div>
          ))}
          {upcomingEvents.map((ev) => (
            <div key={ev.id} className="flex items-center gap-3 rounded-lg border bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
              <span className="text-lg">🎉</span>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{ev.title}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {formatDate(ev.start_date)}
                  {ev.start_date !== ev.end_date && ` — ${formatDate(ev.end_date)}`}
                </p>
              </div>
              <ParticipationButton
                activityType="event"
                activityId={ev.id}
                activityDate={ev.start_date}
                compact
              />
            </div>
          ))}
          {upcomingTrainings.length === 0 && upcomingGames.length === 0 && upcomingEvents.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('noUpcomingActivities')}</p>
          )}
        </div>
      </div>

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
        {activeAbsences.length > 0 ? (
          <div className="mt-3 space-y-2">
            {activeAbsences.slice(0, 5).map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-lg border bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
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
        ) : (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{t('noActiveAbsences')}</p>
        )}
      </div>

      <ProfileEditModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
      />
    </div>
  )
}
