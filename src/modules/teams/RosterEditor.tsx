import { useState, useEffect, useCallback, useMemo } from 'react'
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

type LeadershipRole = 'coach' | 'captain' | 'team_responsible'
const ROLES: LeadershipRole[] = ['coach', 'captain', 'team_responsible']

function displayName(m: Member): string {
  return [m.last_name, m.first_name].filter(Boolean).join(' ') || '—'
}

function getMemberRoles(memberId: string, team: Team): LeadershipRole[] {
  return ROLES.filter((r) => team[r]?.includes(memberId))
}

const ROLE_SHORT: Record<LeadershipRole, string> = {
  coach: 'C',
  captain: 'Cap',
  team_responsible: 'TR',
}

const ROLE_I18N: Record<LeadershipRole, string> = {
  coach: 'roleCoach',
  captain: 'roleCaptain',
  team_responsible: 'roleTeamResponsible',
}

const ROLE_COLORS: Record<LeadershipRole, string> = {
  coach: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  captain: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  team_responsible: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
}

export default function RosterEditor() {
  const { t } = useTranslation('teams')
  const { teamSlug } = useParams<{ teamSlug: string }>()
  const { isCoachOf } = useAuth()
  const season = getCurrentSeason()
  const { data: allMembers } = usePB<Member>('members', { filter: 'active=true', perPage: 500, sort: 'last_name', fields: 'id,name,first_name,last_name,photo,number,position' })
  const { create, remove } = useMutation<MemberTeam>('member_teams')

  const [team, setTeam] = useState<Team | null>(null)
  const [search, setSearch] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [editingNumber, setEditingNumber] = useState<string | null>(null)
  const [numberValue, setNumberValue] = useState('')
  const teamId = team?.id
  const { members, isLoading, refetch } = useTeamMembers(teamId, season)

  useEffect(() => {
    if (!teamSlug) return
    pb.collection('teams')
      .getFirstListItem<Team>(`name="${teamSlug}"`)
      .then(setTeam)
      .catch(() => setTeam(null))
  }, [teamSlug])

  if (team && !isCoachOf(team.id)) {
    return <Navigate to={`/teams/${teamSlug}`} replace />
  }

  const sortedMembers = useMemo(() => {
    return [...members].sort((a, b) => {
      const ma = a.expand?.member
      const mb = b.expand?.member
      if (!ma || !mb) return 0
      return (ma.last_name ?? '').localeCompare(mb.last_name ?? '') || (ma.first_name ?? '').localeCompare(mb.first_name ?? '')
    })
  }, [members])

  const rosterMemberIds = new Set(members.map((mt) => mt.member))
  const searchLower = search.toLowerCase()
  const availableMembers = allMembers.filter(
    (m) =>
      !rosterMemberIds.has(m.id) &&
      (displayName(m).toLowerCase().includes(searchLower) ||
        m.first_name?.toLowerCase().includes(searchLower) ||
        m.last_name?.toLowerCase().includes(searchLower)),
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

  const toggleRole = useCallback(async (memberId: string, role: LeadershipRole) => {
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

  async function saveNumber(memberId: string) {
    const num = numberValue ? parseInt(numberValue, 10) : 0
    try {
      await pb.collection('members').update(memberId, { number: num })
      // Update local state
      const mt = members.find((m) => m.expand?.member?.id === memberId)
      if (mt?.expand?.member) {
        ;(mt.expand.member as Record<string, unknown>).number = num
      }
    } catch {
      // ignore
    }
    setEditingNumber(null)
  }

  if (isLoading) {
    return <div className="py-12 text-center text-gray-500 dark:text-gray-400">{t('common:loading')}</div>
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Link to="/teams" className="hover:text-gray-700 dark:text-gray-300">{t('title')}</Link>
        <span>/</span>
        <Link to={`/teams/${teamSlug}`} className="hover:text-gray-700 dark:text-gray-300">
          {team?.full_name ?? 'Team'}
        </Link>
        <span>/</span>
        <span className="text-gray-900 dark:text-gray-100">{t('editRoster')}</span>
      </div>

      <div className="flex items-center gap-3">
        {team && <TeamChip team={team.name} />}
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t('editRoster')}</h1>
      </div>

      {/* Current roster */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('currentRoster', { count: members.length })}
        </h2>

        {members.length === 0 ? (
          <EmptyState icon="👤" title={t('noMembers')} description={t('noMembersDescription')} />
        ) : (
          <div className="mt-4 space-y-2">
            {sortedMembers.map((mt) => {
              const member = mt.expand?.member
              if (!member) return null
              const initials = `${member.first_name?.[0] ?? ''}${member.last_name?.[0] ?? ''}`.toUpperCase()
              const roles = team ? getMemberRoles(member.id, team) : []

              return (
                <div key={mt.id} className="flex items-center gap-3 rounded-lg border bg-white dark:bg-gray-800 dark:border-gray-700 px-4 py-2.5">
                  {member.photo ? (
                    <img
                      src={getFileUrl('members', member.id, member.photo)}
                      alt=""
                      className="h-8 w-8 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-600 text-xs font-medium text-gray-600 dark:text-gray-300">
                      {initials}
                    </div>
                  )}

                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {displayName(member)}
                  </span>

                  {/* Editable number */}
                  {editingNumber === member.id ? (
                    <input
                      type="number"
                      value={numberValue}
                      onChange={(e) => setNumberValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveNumber(member.id)
                        else if (e.key === 'Escape') setEditingNumber(null)
                      }}
                      onBlur={() => saveNumber(member.id)}
                      className="w-14 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-1.5 py-0.5 text-center text-sm text-gray-900 dark:text-gray-100"
                      autoFocus
                    />
                  ) : (
                    <button
                      onClick={() => { setEditingNumber(member.id); setNumberValue(String(member.number || '')) }}
                      className="w-10 text-center text-sm text-gray-400 hover:text-brand-500"
                      title={t('numberCol')}
                    >
                      #{member.number || '—'}
                    </button>
                  )}

                  {/* Role toggles */}
                  <div className="hidden sm:flex gap-1">
                    {ROLES.map((r) => {
                      const active = roles.includes(r)
                      return (
                        <button
                          key={r}
                          onClick={() => toggleRole(member.id, r)}
                          title={t(ROLE_I18N[r])}
                          className={`rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                            active
                              ? ROLE_COLORS[r]
                              : 'bg-gray-100 text-gray-400 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-500 dark:hover:bg-gray-600'
                          }`}
                        >
                          {ROLE_SHORT[r]}
                        </button>
                      )
                    })}
                  </div>

                  <button
                    onClick={() => setRemovingId(mt.id)}
                    className="shrink-0 text-sm text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                  >
                    {t('common:remove')}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Add member */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('addPlayer')}</h2>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="mt-2 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
        />
        {search.length >= 2 && (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
            {availableMembers.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t('noSearchResults')}</p>
            ) : (
              availableMembers.slice(0, 10).map((m) => (
                <button
                  key={m.id}
                  onClick={() => handleAdd(m.id)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  {m.photo ? (
                    <img
                      src={getFileUrl('members', m.id, m.photo)}
                      alt=""
                      className="h-6 w-6 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-600 text-xs text-gray-600 dark:text-gray-300">
                      {m.first_name?.[0]}{m.last_name?.[0]}
                    </div>
                  )}
                  <span>{displayName(m)}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={removingId !== null}
        onClose={() => setRemovingId(null)}
        onConfirm={handleRemove}
        title={t('removeConfirmTitle')}
        message={t('removeConfirmMessage', {
          name: (() => {
            const m = members.find((mt) => mt.id === removingId)?.expand?.member
            return m ? displayName(m) : ''
          })(),
        })}
        confirmLabel={t('common:remove')}
        danger
      />
    </div>
  )
}
