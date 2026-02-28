import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, Link, Navigate } from 'react-router-dom'
import pb from '../../pb'
import { useAuth } from '../../hooks/useAuth'
import { useTeamMembers } from '../../hooks/useTeamMembers'
import { useMutation } from '../../hooks/useMutation'
import { usePB } from '../../hooks/usePB'
import TeamChip from '../../components/TeamChip'
import ConfirmDialog from '../../components/ConfirmDialog'
import EmptyState from '../../components/EmptyState'
import { getFileUrl } from '../../utils/pbFile'
import { getCurrentSeason } from '../../utils/dateHelpers'
import type { Team, Member, MemberTeam } from '../../types'

type LeadershipRole = 'coach' | 'assistant' | 'captain' | 'team_responsible'

export default function RosterEditor() {
  const { t } = useTranslation('teams')
  const { teamId } = useParams<{ teamId: string }>()
  const { isCoachOf } = useAuth()
  const season = getCurrentSeason()
  const { members, isLoading, refetch } = useTeamMembers(teamId, season)
  const { data: allMembers } = usePB<Member>('members', { filter: 'active=true', perPage: 500, sort: 'name' })
  const { create, remove } = useMutation<MemberTeam>('member_teams')

  const [team, setTeam] = useState<Team | null>(null)
  const [search, setSearch] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)

  useEffect(() => {
    if (!teamId) return
    pb.collection('teams')
      .getOne<Team>(teamId)
      .then(setTeam)
      .catch(() => setTeam(null))
  }, [teamId])

  if (!isCoachOf(teamId ?? '')) {
    return <Navigate to={`/teams/${teamId}`} replace />
  }

  const rosterMemberIds = new Set(members.map((mt) => mt.member))
  const availableMembers = allMembers.filter(
    (m) => !rosterMemberIds.has(m.id) && m.name.toLowerCase().includes(search.toLowerCase()),
  )

  async function handleAdd(memberId: string) {
    if (!teamId) return
    await create({ member: memberId, team: teamId, season })
    setSearch('')
    refetch()
  }

  async function handleRemove() {
    if (!removingId) return
    await remove(removingId)
    setRemovingId(null)
    refetch()
  }

  // Leadership role management — stored on teams collection
  const leadershipRoles: { key: LeadershipRole; label: string }[] = [
    { key: 'coach', label: t('roleCoach') },
    { key: 'assistant', label: t('roleAssistant') },
    { key: 'captain', label: t('roleCaptain') },
    { key: 'team_responsible', label: t('roleTeamResponsible') },
  ]

  const rosterMembers = useMemo(
    () => members.map((mt) => mt.expand?.member).filter((m): m is Member => !!m),
    [members],
  )

  const toggleLeadership = useCallback(async (memberId: string, role: LeadershipRole) => {
    if (!team) return
    const current: string[] = team[role] ?? []
    const next = current.includes(memberId)
      ? current.filter((id) => id !== memberId)
      : [...current, memberId]
    try {
      await pb.collection('teams').update(team.id, { [role]: next })
      setTeam((prev) => prev ? { ...prev, [role]: next } : prev)
    } catch {
      // ignore
    }
  }, [team])

  if (isLoading) {
    return <div className="py-12 text-center text-gray-500 dark:text-gray-400">{t('common:loading')}</div>
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Link to="/teams" className="hover:text-gray-700 dark:text-gray-300">{t('title')}</Link>
        <span>/</span>
        <Link to={`/teams/${teamId}`} className="hover:text-gray-700 dark:text-gray-300">
          {team?.full_name ?? 'Team'}
        </Link>
        <span>/</span>
        <span className="text-gray-900 dark:text-gray-100">{t('editRoster')}</span>
      </div>

      <div className="flex items-center gap-3">
        {team && <TeamChip team={team.name} />}
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('editRoster')}</h1>
      </div>

      {/* Add member */}
      <div className="mt-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('addPlayer')}</label>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="mt-1 w-full max-w-md rounded-lg border px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
        />
        {search.length >= 2 && (
          <div className="mt-2 max-h-48 max-w-md overflow-y-auto rounded-lg border bg-white dark:bg-gray-800 shadow-sm">
            {availableMembers.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t('noSearchResults')}</p>
            ) : (
              availableMembers.slice(0, 10).map((m) => (
                <button
                  key={m.id}
                  onClick={() => handleAdd(m.id)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  {m.photo ? (
                    <img
                      src={getFileUrl('members', m.id, m.photo)}
                      alt=""
                      className="h-6 w-6 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-xs">
                      {m.first_name?.[0]}{m.last_name?.[0]}
                    </div>
                  )}
                  <span>{m.name}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Team leadership */}
      {team && rosterMembers.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('teamLeadership')}</h2>
          <div className="mt-4 space-y-4">
            {leadershipRoles.map(({ key, label }) => {
              const currentIds: string[] = team[key] ?? []
              return (
                <div key={key}>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {rosterMembers.map((m) => {
                      const active = currentIds.includes(m.id)
                      return (
                        <button
                          key={m.id}
                          onClick={() => toggleLeadership(m.id, key)}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                            active
                              ? 'bg-brand-500 text-white'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                          }`}
                        >
                          {m.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Current roster */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('currentRoster', { count: members.length })}
        </h2>

        {members.length === 0 ? (
          <EmptyState icon="👤" title={t('noMembers')} description={t('noMembersDescription')} />
        ) : (
          <div className="mt-4 space-y-2">
            {members.map((mt) => {
              const member = mt.expand?.member
              if (!member) return null
              const initials = `${member.first_name?.[0] ?? ''}${member.last_name?.[0] ?? ''}`.toUpperCase()

              return (
                <div key={mt.id} className="flex items-center gap-4 rounded-lg border bg-white dark:bg-gray-800 px-4 py-3">
                  {member.photo ? (
                    <img
                      src={getFileUrl('members', member.id, member.photo)}
                      alt=""
                      className="h-8 w-8 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-600 dark:text-gray-400">
                      {initials}
                    </div>
                  )}
                  <span className="flex-1 text-sm font-medium text-gray-900 dark:text-gray-100">{member.name}</span>
                  <button
                    onClick={() => setRemovingId(mt.id)}
                    className="text-sm text-red-600 hover:text-red-800"
                  >
                    {t('common:remove')}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={removingId !== null}
        onClose={() => setRemovingId(null)}
        onConfirm={handleRemove}
        title={t('removeConfirmTitle')}
        message={t('removeConfirmMessage', { name: members.find((mt) => mt.id === removingId)?.expand?.member?.name ?? '' })}
        confirmLabel={t('common:remove')}
        danger
      />
    </div>
  )
}
