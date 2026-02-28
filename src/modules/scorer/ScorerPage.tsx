import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Game, Member, Team, MemberTeam } from '../../types'
import { usePB } from '../../hooks/usePB'
import { useRealtime } from '../../hooks/useRealtime'
import { useAuth } from '../../hooks/useAuth'
import pb from '../../pb'
import ScorerRow, { hasAnyAssignment } from './components/ScorerRow'
import TeamOverview from './components/TeamOverview'
import LoadingSpinner from '../../components/LoadingSpinner'

type Tab = 'games' | 'overview'
type DutyTypeFilter = 'all' | 'scorer' | 'taefeler' | 'scorer_taefeler'
type UnassignedFilter = 'all' | 'scorer' | 'taefeler' | 'scorer_taefeler' | 'any'

const EXPAND_FIELDS =
  'kscw_team,hall,scorer_member,taefeler_member,scorer_taefeler_member,scorer_duty_team,taefeler_duty_team,scorer_taefeler_duty_team'

const PAST_PAGE_SIZE = 5

export default function ScorerPage() {
  const { t } = useTranslation('scorer')
  const { user, isAdmin, isCoach } = useAuth()
  const canEdit = isAdmin || isCoach

  const [tab, setTab] = useState<Tab>('games')

  // Filters
  const [dateFilter, setDateFilter] = useState('')
  const [dutyTeamFilter, setDutyTeamFilter] = useState('')
  const [dutyTypeFilter, setDutyTypeFilter] = useState<DutyTypeFilter>('all')
  const [unassignedFilter, setUnassignedFilter] = useState<UnassignedFilter>('all')
  const [searchAssignee, setSearchAssignee] = useState('')

  // Past games
  const [showPast, setShowPast] = useState(false)
  const [pastVisible, setPastVisible] = useState(PAST_PAGE_SIZE)

  const today = useMemo(() => new Date().toISOString().split('T')[0], [])

  // Upcoming home games (all, filter client-side)
  const {
    data: upcomingGames,
    isLoading: gamesLoading,
    refetch,
  } = usePB<Game>('games', {
    filter: `type = "home" && date >= "${today}" && status != "completed" && status != "postponed"`,
    sort: '+date,+time',
    expand: EXPAND_FIELDS,
    perPage: 200,
  })

  // Past home games
  const { data: allPastGames, isLoading: pastLoading, total: pastTotal } = usePB<Game>('games', {
    filter: `type = "home" && date < "${today}"`,
    sort: '-date,-time',
    expand: EXPAND_FIELDS,
    perPage: 200,
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

  // User's team memberships (for self-assign)
  const { data: userMemberTeams } = usePB<MemberTeam>('member_teams', {
    filter: user ? `member="${user.id}"` : '',
    perPage: 20,
    enabled: !!user,
  })
  const userTeamIds = useMemo(() => userMemberTeams.map((mt) => mt.team), [userMemberTeams])

  // Member lookup for search
  const memberMap = useMemo(() => {
    const map = new Map<string, Member>()
    for (const m of members) map.set(m.id, m)
    return map
  }, [members])

  useRealtime<Game>('games', () => { refetch() }, ['update'])

  // Client-side filtering for upcoming games
  const filteredGames = useMemo(() => {
    return upcomingGames.filter((g) => {
      // Date filter
      if (dateFilter && g.date !== dateFilter) return false

      // Duty team filter
      if (dutyTeamFilter) {
        const matchesTeam =
          g.scorer_duty_team === dutyTeamFilter ||
          g.taefeler_duty_team === dutyTeamFilter ||
          g.scorer_taefeler_duty_team === dutyTeamFilter
        if (!matchesTeam) return false
      }

      // Duty type filter
      if (dutyTypeFilter !== 'all') {
        if (dutyTypeFilter === 'scorer_taefeler') {
          if (!g.scorer_taefeler_duty_team && !g.scorer_taefeler_member) return false
        } else if (dutyTypeFilter === 'scorer') {
          if (!g.scorer_duty_team && !g.scorer_member) return false
        } else if (dutyTypeFilter === 'taefeler') {
          if (!g.taefeler_duty_team && !g.taefeler_member) return false
        }
      }

      // Unassigned filter
      if (unassignedFilter !== 'all') {
        if (unassignedFilter === 'any') {
          const hasUnassigned =
            ((g.scorer_duty_team || g.scorer_member) && !g.scorer_member) ||
            ((g.taefeler_duty_team || g.taefeler_member) && !g.taefeler_member) ||
            ((g.scorer_taefeler_duty_team || g.scorer_taefeler_member) && !g.scorer_taefeler_member)
          // Also count games with no assignments at all as unassigned
          if (!hasUnassigned && hasAnyAssignment(g)) return false
          if (!hasUnassigned && !hasAnyAssignment(g)) return true // no duty set = open
        } else if (unassignedFilter === 'scorer') {
          if (g.scorer_member) return false
          if (!g.scorer_duty_team) return false
        } else if (unassignedFilter === 'taefeler') {
          if (g.taefeler_member) return false
          if (!g.taefeler_duty_team) return false
        } else if (unassignedFilter === 'scorer_taefeler') {
          if (g.scorer_taefeler_member) return false
          if (!g.scorer_taefeler_duty_team) return false
        }
      }

      // Search assignee
      if (searchAssignee.trim()) {
        const q = searchAssignee.toLowerCase()
        const ids = [g.scorer_member, g.taefeler_member, g.scorer_taefeler_member].filter(Boolean) as string[]
        const matches = ids.some((id) => {
          const m = memberMap.get(id)
          if (!m) return false
          return `${m.first_name} ${m.last_name}`.toLowerCase().includes(q)
        })
        if (!matches) return false
      }

      return true
    })
  }, [upcomingGames, dateFilter, dutyTeamFilter, dutyTypeFilter, unassignedFilter, searchAssignee, memberMap])

  // Past games with load-more
  const visiblePastGames = useMemo(() => allPastGames.slice(0, pastVisible), [allPastGames, pastVisible])

  const hasActiveFilters = !!(dateFilter || dutyTeamFilter || dutyTypeFilter !== 'all' || unassignedFilter !== 'all' || searchAssignee)

  function clearFilters() {
    setDateFilter('')
    setDutyTeamFilter('')
    setDutyTypeFilter('all')
    setUnassignedFilter('all')
    setSearchAssignee('')
  }

  async function handleUpdate(gameId: string, fields: Partial<Game>) {
    const oldGame = upcomingGames.find((g) => g.id === gameId) || allPastGames.find((g) => g.id === gameId)
    try {
      await pb.collection('games').update(gameId, fields)
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
              .catch(() => {})
          }
        }
      }
      refetch()
    } catch (err) {
      console.error('Failed to update game:', err)
    }
  }

  const selectClass = 'min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'
  const inputClass = selectClass

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
          {/* Filters */}
          <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {/* Date */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {t('filterDate')}
                </label>
                <input
                  type="date"
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                  className={inputClass}
                />
              </div>

              {/* Duty Team */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {t('filterDutyTeam')}
                </label>
                <select value={dutyTeamFilter} onChange={(e) => setDutyTeamFilter(e.target.value)} className={selectClass}>
                  <option value="">{t('filterAllTeams')}</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>{team.name}</option>
                  ))}
                </select>
              </div>

              {/* Duty Type */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {t('filterDutyType')}
                </label>
                <select value={dutyTypeFilter} onChange={(e) => setDutyTypeFilter(e.target.value as DutyTypeFilter)} className={selectClass}>
                  <option value="all">{t('filterAllTypes')}</option>
                  <option value="scorer">{t('scorer')}</option>
                  <option value="taefeler">{t('referee')}</option>
                  <option value="scorer_taefeler">{t('scorerTaefeler')}</option>
                </select>
              </div>

              {/* Unassigned Duty */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {t('filterUnassigned')}
                </label>
                <select value={unassignedFilter} onChange={(e) => setUnassignedFilter(e.target.value as UnassignedFilter)} className={selectClass}>
                  <option value="all">{t('filterAllDuties')}</option>
                  <option value="any">{t('filterAnyUnassigned')}</option>
                  <option value="scorer">{t('scorer')}</option>
                  <option value="taefeler">{t('referee')}</option>
                  <option value="scorer_taefeler">{t('scorerTaefeler')}</option>
                </select>
              </div>

              {/* Search Assignee */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  {t('filterSearchAssignee')}
                </label>
                <input
                  type="text"
                  value={searchAssignee}
                  onChange={(e) => setSearchAssignee(e.target.value)}
                  placeholder={t('searchAssigneePlaceholder')}
                  className={inputClass}
                />
              </div>
            </div>

            {/* Clear filters */}
            {hasActiveFilters && (
              <div className="mt-3 flex justify-center">
                <button
                  onClick={clearFilters}
                  className="rounded-full border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
                >
                  {t('clearFilters')}
                </button>
              </div>
            )}
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
                    userId={user?.id}
                    userTeamIds={userTeamIds}
                    userHasLicence={user?.scorer_licence ?? false}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Past games — show older games button + load more */}
          <div className="mt-8">
            {!showPast ? (
              <button
                onClick={() => { setShowPast(true); setPastVisible(PAST_PAGE_SIZE) }}
                className="mx-auto flex items-center gap-2 rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
              >
                {t('showOlderGames', { count: pastTotal || '...' })}
              </button>
            ) : (
              <div className="mt-4">
                {pastLoading && <LoadingSpinner />}
                {!pastLoading && allPastGames.length === 0 && (
                  <p className="py-4 text-center text-sm text-gray-400">{t('noGames')}</p>
                )}
                {!pastLoading && visiblePastGames.length > 0 && (
                  <>
                    <div className="space-y-3 opacity-75">
                      {visiblePastGames.map((g) => (
                        <ScorerRow
                          key={g.id}
                          game={g}
                          members={members}
                          teams={teams}
                          onUpdate={handleUpdate}
                          canEdit={canEdit}
                          userId={user?.id}
                          userTeamIds={userTeamIds}
                          userHasLicence={user?.scorer_licence ?? false}
                        />
                      ))}
                    </div>
                    {pastVisible < allPastGames.length && (
                      <div className="mt-4 flex justify-center">
                        <button
                          onClick={() => setPastVisible((v) => v + PAST_PAGE_SIZE)}
                          className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
                        >
                          {t('loadMore')}
                        </button>
                      </div>
                    )}
                  </>
                )}
                <div className="mt-3 flex justify-center">
                  <button
                    onClick={() => setShowPast(false)}
                    className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                  >
                    {t('hidePast')}
                  </button>
                </div>
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
