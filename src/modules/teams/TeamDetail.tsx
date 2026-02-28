import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, Link } from 'react-router-dom'
import pb from '../../pb'
import { useTeamMembers } from '../../hooks/useTeamMembers'
import { useAuth } from '../../hooks/useAuth'
import { usePendingMembers } from '../../hooks/usePendingMembers'
import TeamChip from '../../components/TeamChip'
import EmptyState from '../../components/EmptyState'
import MemberRow from './MemberRow'
import { getFileUrl } from '../../utils/pbFile'
import { getCurrentSeason } from '../../utils/dateHelpers'
import type { Team, Member } from '../../types'

export default function TeamDetail() {
  const { t } = useTranslation('teams')
  const { teamId } = useParams<{ teamId: string }>()
  const { isCoachOf, isAdmin } = useAuth()
  const [team, setTeam] = useState<Team | null>(null)
  const [loading, setLoading] = useState(true)
  const { members, isLoading: membersLoading } = useTeamMembers(teamId)
  const canManage = isCoachOf(teamId ?? '') || isAdmin
  const { data: pendingMembers, refetch: refetchPending } = usePendingMembers(canManage ? teamId : undefined)

  async function handleApprove(member: Member) {
    try {
      await pb.collection('members').update(member.id, { approved: true })
      await pb.collection('member_teams').create({
        member: member.id,
        team: teamId,
        season: getCurrentSeason(),
      })
      refetchPending()
    } catch {
      // ignore
    }
  }

  async function handleReject(memberId: string) {
    try {
      await pb.collection('members').delete(memberId)
      refetchPending()
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!teamId) return
    setLoading(true)
    pb.collection('teams')
      .getOne<Team>(teamId)
      .then(setTeam)
      .catch(() => setTeam(null))
      .finally(() => setLoading(false))
  }, [teamId])

  if (loading || membersLoading) {
    return <div className="py-12 text-center text-gray-500 dark:text-gray-400">{t('common:loading')}</div>
  }

  if (!team) {
    return <EmptyState icon="❌" title={t('noTeams')} />
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Link to="/teams" className="hover:text-gray-700 dark:text-gray-300">{t('title')}</Link>
        <span>/</span>
        <span className="text-gray-900 dark:text-gray-100">{team.full_name}</span>
      </div>

      {team.team_picture && (
        <div className="mb-6 overflow-hidden rounded-lg">
          <img
            src={getFileUrl('teams', team.id, team.team_picture)}
            alt={team.full_name}
            className="h-48 w-full object-cover sm:h-64"
          />
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <TeamChip team={team.name} />
            <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{team.full_name}</h1>
            {team.social_url && (
              <a
                href={team.social_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 transition-colors hover:text-brand-500"
                title="Social"
              >
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
                </svg>
              </a>
            )}
          </div>
          <div className="mt-2 flex gap-4 text-sm text-gray-500 dark:text-gray-400">
            <span>{team.league}</span>
            <span>{team.season}</span>
            <span>{team.sport === 'volleyball' ? 'Volleyball' : 'Basketball'}</span>
          </div>
        </div>

        {isCoachOf(teamId ?? '') && (
          <Link
            to={`/teams/${teamId}/roster/edit`}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
          >
            {t('editRoster')}
          </Link>
        )}
      </div>

      {/* Pending member requests */}
      {canManage && pendingMembers.length > 0 && (
        <div className="mt-6 rounded-lg border-2 border-amber-300 bg-amber-50 p-4 dark:border-amber-600 dark:bg-amber-900/20">
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            {t('pendingRequests', { count: pendingMembers.length })}
          </h3>
          <div className="mt-3 space-y-3">
            {pendingMembers.map((member) => (
              <div key={member.id} className="flex items-center justify-between rounded-lg bg-white p-3 dark:bg-gray-800">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {member.first_name} {member.last_name}
                  </p>
                  <p className="truncate text-sm text-gray-500 dark:text-gray-400">{member.email}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => handleApprove(member)}
                    className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700"
                  >
                    {t('approve')}
                  </button>
                  <button
                    onClick={() => handleReject(member.id)}
                    className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                  >
                    {t('reject')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('currentRoster', { count: members.length })}</h2>

        {members.length === 0 ? (
          <EmptyState
            icon="👤"
            title={t('noMembers')}
            description={t('noMembersDescription')}
            action={
              isCoachOf(teamId ?? '') ? (
                <Link
                  to={`/teams/${teamId}/roster/edit`}
                  className="text-sm text-brand-600 hover:text-brand-700"
                >
                  {t('addPlayer')}
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border bg-white dark:bg-gray-800">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-3">{t('playerCol')}</th>
                  <th className="px-4 py-3">{t('numberCol')}</th>
                  <th className="hidden px-4 py-3 sm:table-cell">{t('positionCol')}</th>
                  <th className="px-4 py-3">{t('roleCol')}</th>
                </tr>
              </thead>
              <tbody>
                {members.map((mt) => (
                  <MemberRow key={mt.id} memberTeam={mt} teamId={team.id} team={team} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Sponsors */}
      {team.sponsors && team.sponsors.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('sponsors')}</h2>
          <div className="mt-3 flex flex-wrap items-center gap-6">
            {team.sponsors.map((name, i) => (
              <div key={i} className="flex flex-col items-center gap-2">
                {team.sponsors_logos?.[i] && (
                  <img
                    src={getFileUrl('teams', team.id, team.sponsors_logos[i])}
                    alt={name}
                    className="h-12 w-auto object-contain"
                  />
                )}
                <span className="text-sm text-gray-500 dark:text-gray-400">{name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
