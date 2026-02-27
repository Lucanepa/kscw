import { useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Game, SvRanking } from '../../types'
import { usePB } from '../../hooks/usePB'
import { svTeamIds } from '../../utils/teamColors'
import GameTabs from './components/GameTabs'
import type { TabKey } from './components/GameTabs'
import GameCard from './components/GameCard'
import RankingsTable from './components/RankingsTable'
import LoadingSpinner from '../../components/LoadingSpinner'

function buildTeamFilter(team: string): string {
  if (!team) return ''
  return `kscw_team.name ~ "${team}"`
}

export default function EmbedGamesPage() {
  const [searchParams] = useSearchParams()
  const teamParam = (searchParams.get('team') ?? '').toUpperCase()
  const [activeTab, setActiveTab] = useState<TabKey>('upcoming')

  const today = useMemo(() => new Date().toISOString().split('T')[0], [])
  const teamFilter = buildTeamFilter(teamParam)

  const gameQuery = useMemo(() => {
    if (activeTab === 'rankings') return null

    const parts: string[] = []
    switch (activeTab) {
      case 'upcoming':
        parts.push(`status = "scheduled"`, `date >= "${today}"`)
        break
      case 'recent':
        parts.push(`status = "completed"`, `date < "${today}"`)
        break
      case 'results':
        parts.push(`(status = "completed" || status = "live")`)
        break
    }
    if (teamFilter) parts.push(teamFilter)

    return {
      filter: parts.join(' && '),
      sort: activeTab === 'upcoming' ? '+date,+time' : '-date,-time',
    }
  }, [activeTab, teamFilter, today])

  const { data: games, isLoading: gamesLoading } = usePB<Game>(
    'games',
    gameQuery
      ? { filter: gameQuery.filter, sort: gameQuery.sort, expand: 'kscw_team,hall', perPage: 50 }
      : { filter: 'id = ""', perPage: 1 },
  )

  const { data: allRankings, isLoading: rankingsLoading } = usePB<SvRanking>('sv_rankings', {
    sort: '+league,+rank',
    perPage: 200,
  })

  const leagueGroups = useMemo(() => {
    const grouped = new Map<string, SvRanking[]>()
    for (const r of allRankings) {
      const existing = grouped.get(r.league) ?? []
      existing.push(r)
      grouped.set(r.league, existing)
    }

    if (!teamParam) return grouped

    // Filter to leagues containing the selected team
    const selectedSvIds = new Set(
      Object.entries(svTeamIds)
        .filter(([, code]) => code.replace(/-\d+$/, '') === teamParam)
        .map(([id]) => id),
    )

    const filtered = new Map<string, SvRanking[]>()
    for (const [league, rows] of grouped) {
      if (rows.some((r) => selectedSvIds.has(r.sv_team_id))) {
        filtered.set(league, rows)
      }
    }
    return filtered
  }, [allRankings, teamParam])

  const isLoading = activeTab === 'rankings' ? rankingsLoading : gamesLoading

  return (
    <div className="min-h-screen bg-white dark:bg-gray-800 p-4">
      {teamParam && (
        <h2 className="mb-4 text-lg font-bold text-gray-900 dark:text-gray-100">{teamParam} — Games</h2>
      )}

      <GameTabs activeTab={activeTab} onChange={setActiveTab} />

      <div className="mt-4">
        {isLoading && <LoadingSpinner size="sm" />}

        {!isLoading && activeTab !== 'rankings' && (
          <>
            {games.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">No games found.</p>
            ) : (
              <div className="space-y-3">
                {games.map((g) => (
                  <GameCard key={g.id} game={g} variant="compact" />
                ))}
              </div>
            )}
          </>
        )}

        {!isLoading && activeTab === 'rankings' && (
          <>
            {leagueGroups.size === 0 ? (
              <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">No rankings available.</p>
            ) : (
              <div className="space-y-6">
                {[...leagueGroups.entries()].map(([league, rows]) => (
                  <RankingsTable key={league} league={league} rankings={rows} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
