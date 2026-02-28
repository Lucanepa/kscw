import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Game, Member, Team } from '../../types'
import { usePB } from '../../hooks/usePB'
import { useRealtime } from '../../hooks/useRealtime'
import { useAuth } from '../../hooks/useAuth'
import pb from '../../pb'
import TeamFilterBar from '../games/components/TeamFilterBar'
import ScorerRow, { hasAnyAssignment } from './components/ScorerRow'
import TeamOverview from './components/TeamOverview'
import LoadingSpinner from '../../components/LoadingSpinner'

type StatusFilter = 'all' | 'open' | 'assigned' | 'confirmed'
type Tab = 'games' | 'overview'

const EXPAND_FIELDS =
  'kscw_team,hall,scorer_member,taefeler_member,scorer_taefeler_member,scorer_duty_team,taefeler_duty_team,scorer_taefeler_duty_team'

function buildTeamFilter(teams: string[]): string {
  if (teams.length === 0) return ''
  const clauses = teams.map((t) => `kscw_team.name ~ "${t}"`)
  return `(${clauses.join(' || ')})`
}

export default function ScorerPage() {
  const { t } = useTranslation('scorer')
  const { user, isAdmin, isCoach } = useAuth()
  const canEdit = isAdmin || isCoach

  const STATUS_OPTIONS: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: t('filterAll') },
    { key: 'open', label: t('filterOpen') },
    { key: 'assigned', label: t('filterAssigned') },
    { key: 'confirmed', label: t('filterConfirmed') },
  ]

  const [tab, setTab] = useState<Tab>('games')
  const [selectedTeams, setSelectedTeams] = useState<string[]>([])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [showPast, setShowPast] = useState(false)

  const today = useMemo(() => new Date().toISOString().split('T')[0], [])
  const teamFilter = buildTeamFilter(selectedTeams)

  // Upcoming home games
  const upcomingFilter = useMemo(() => {
    const parts = [
      `type = "home"`,
      `date >= "${today}"`,
      `status != "completed"`,
      `status != "postponed"`,
    ]
    if (teamFilter) parts.push(teamFilter)
    return parts.join(' && ')
  }, [teamFilter, today])

  // Past home games
  const pastFilter = useMemo(() => {
    const parts = [`type = "home"`, `date < "${today}"`]
    if (teamFilter) parts.push(teamFilter)
    return parts.join(' && ')
  }, [teamFilter, today])

  const {
    data: upcomingGames,
    isLoading: gamesLoading,
    refetch,
  } = usePB<Game>('games', {
    filter: upcomingFilter,
    sort: '+date,+time',
    expand: EXPAND_FIELDS,
    perPage: 200,
  })

  const { data: pastGames, isLoading: pastLoading } = usePB<Game>('games', {
    filter: pastFilter,
    sort: '-date,-time',
    expand: EXPAND_FIELDS,
    perPage: 50,
    enabled: showPast,
  })

  const { data: members } = usePB<Member>('members', {
    filter: 'active = true',
    sort: '+last_name,+first_name',
    perPage: 500,
  })

  const { data: teams } = usePB<Team>('teams', {
    filter: 'active = true',
    sort: '+name',
    perPage: 50,
  })

  // Realtime updates
  useRealtime<Game>('games', () => {
    refetch()
  }, ['update'])

  // Client-side status filtering
  const filteredGames = useMemo(() => {
    if (statusFilter === 'all') return upcomingGames
    return upcomingGames.filter((g) => {
      const assigned = hasAnyAssignment(g)
      switch (statusFilter) {
        case 'open':
          return !assigned
        case 'assigned':
          return assigned && !g.duty_confirmed
        case 'confirmed':
          return g.duty_confirmed
        default:
          return true
      }
    })
  }, [upcomingGames, statusFilter])

  async function handleUpdate(gameId: string, fields: Partial<Game>) {
    // Find old game for audit log
    const oldGame = upcomingGames.find((g) => g.id === gameId) || pastGames.find((g) => g.id === gameId)

    try {
      await pb.collection('games').update(gameId, fields)

      // Audit log
      if (user && oldGame) {
        for (const [key, newVal] of Object.entries(fields)) {
          const oldVal = (oldGame as Record<string, unknown>)[key]
          if (oldVal !== newVal) {
            pb.collection('scorer_edit_log')
              .create({
                action: 'UPDATE',
                game: gameId,
                field_name: key,
                old_value: String(oldVal ?? ''),
                new_value: String(newVal ?? ''),
                changed_by: user.id,
              })
              .catch(() => {}) // non-blocking
          }
        }
      }

      refetch()
    } catch (err) {
      console.error('Failed to update game:', err)
    }
  }

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 sm:text-2xl">{t('title')}</h1>
      <p className="mt-1 text-gray-600 dark:text-gray-400">{t('subtitle')}</p>

      {/* Tab bar */}
      <div className="mt-4 flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {(['games', 'overview'] as Tab[]).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === key
                ? 'border-b-2 border-brand-600 text-brand-700 dark:text-brand-400'
                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
            }`}
          >
            {key === 'games' ? t('tabGames') : t('tabOverview')}
          </button>
        ))}
      </div>

      {tab === 'games' && (
        <>
          <div className="mt-4 space-y-4">
            <TeamFilterBar selected={selectedTeams} onChange={setSelectedTeams} />

            {/* Status filter */}
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setStatusFilter(opt.key)}
                  className={`rounded-full px-3 py-2 text-sm font-medium transition-colors sm:py-1 ${
                    statusFilter === opt.key
                      ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Upcoming games */}
          <div className="mt-6">
            {gamesLoading && <LoadingSpinner />}

            {!gamesLoading && filteredGames.length === 0 && (
              <div className="py-12 text-center text-gray-500 dark:text-gray-400">
                <p>{t('noGames')}</p>
                <p className="mt-1 text-sm">{t('noGamesDescription')}</p>
              </div>
            )}

            {!gamesLoading && filteredGames.length > 0 && (
              <div className="space-y-3">
                {filteredGames.map((g) => (
                  <ScorerRow
                    key={g.id}
                    game={g}
                    members={members}
                    teams={teams}
                    onUpdate={handleUpdate}
                    canEdit={canEdit}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Past games toggle */}
          <div className="mt-8">
            <button
              onClick={() => setShowPast(!showPast)}
              className="flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
            >
              <svg
                className={`h-4 w-4 transition-transform ${showPast ? 'rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              {showPast ? t('hidePast') : t('showPast')}
            </button>

            {showPast && (
              <div className="mt-4">
                {pastLoading && <LoadingSpinner />}
                {!pastLoading && pastGames.length === 0 && (
                  <p className="py-4 text-center text-sm text-gray-400">{t('noGames')}</p>
                )}
                {!pastLoading && pastGames.length > 0 && (
                  <div className="space-y-3 opacity-75">
                    {pastGames.map((g) => (
                      <ScorerRow
                        key={g.id}
                        game={g}
                        members={members}
                        teams={teams}
                        onUpdate={handleUpdate}
                        canEdit={canEdit}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'overview' && (
        <TeamOverview games={upcomingGames} members={members} />
      )}

      {!canEdit && (
        <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">{t('permissionsNotice')}</p>
      )}
    </div>
  )
}
