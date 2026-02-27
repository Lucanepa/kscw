import { useState, useMemo } from 'react'
import type { Game, SvRanking } from '../../types'
import { usePB } from '../../hooks/usePB'
import { svTeamIds } from '../../utils/teamColors'
import TeamFilterBar from './components/TeamFilterBar'
import GameTabs from './components/GameTabs'
import type { TabKey } from './components/GameTabs'
import GameCard from './components/GameCard'
import RankingsTable from './components/RankingsTable'
import GameDetailModal from './components/GameDetailModal'

function buildTeamFilter(teams: string[]): string {
  if (teams.length === 0) return ''
  const clauses = teams.map((t) => `kscw_team.name ~ "${t}"`)
  return `(${clauses.join(' || ')})`
}

export default function GamesPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('upcoming')
  const [selectedTeams, setSelectedTeams] = useState<string[]>([])
  const [selectedGame, setSelectedGame] = useState<Game | null>(null)

  const today = useMemo(() => new Date().toISOString().split('T')[0], [])
  const teamFilter = buildTeamFilter(selectedTeams)

  // Build game filter/sort based on active tab
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

  // Rankings — always fetch (small dataset), group client-side
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

    if (selectedTeams.length === 0) return grouped

    // Filter to leagues containing a selected team
    const selectedSvIds = new Set(
      selectedTeams.flatMap((t) =>
        Object.entries(svTeamIds)
          .filter(([, code]) => code.replace(/-\d+$/, '') === t)
          .map(([id]) => id),
      ),
    )

    const filtered = new Map<string, SvRanking[]>()
    for (const [league, rows] of grouped) {
      if (rows.some((r) => selectedSvIds.has(r.sv_team_id))) {
        filtered.set(league, rows)
      }
    }
    return filtered
  }, [allRankings, selectedTeams])

  const isLoading = activeTab === 'rankings' ? rankingsLoading : gamesLoading
  const showGames = activeTab !== 'rankings' && !isLoading

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Spiele & Resultate</h1>
      <p className="mt-1 text-gray-600">Swiss Volley Daten — nächste Spiele, Resultate, Ranglisten.</p>

      <div className="mt-6 space-y-4">
        <TeamFilterBar selected={selectedTeams} onChange={setSelectedTeams} />
        <GameTabs activeTab={activeTab} onChange={setActiveTab} />
      </div>

      <div className="mt-6">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600" />
          </div>
        )}

        {/* Upcoming / Recent: card grid */}
        {showGames && (activeTab === 'upcoming' || activeTab === 'recent') && (
          <>
            {games.length === 0 ? (
              <EmptyState tab={activeTab} />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {games.map((g) => (
                  <GameCard key={g.id} game={g} onClick={setSelectedGame} />
                ))}
              </div>
            )}
          </>
        )}

        {/* Results: compact list */}
        {showGames && activeTab === 'results' && (
          <>
            {games.length === 0 ? (
              <EmptyState tab={activeTab} />
            ) : (
              <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                {games.map((g) => (
                  <GameCard key={g.id} game={g} onClick={setSelectedGame} variant="compact" />
                ))}
              </div>
            )}
          </>
        )}

        {/* Rankings */}
        {activeTab === 'rankings' && !rankingsLoading && (
          <>
            {leagueGroups.size === 0 ? (
              <EmptyState tab="rankings" />
            ) : (
              <div className="space-y-8">
                {[...leagueGroups.entries()].map(([league, rows]) => (
                  <RankingsTable key={league} league={league} rankings={rows} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <GameDetailModal game={selectedGame} onClose={() => setSelectedGame(null)} />
    </div>
  )
}

function EmptyState({ tab }: { tab: string }) {
  const messages: Record<string, string> = {
    upcoming: 'Keine kommenden Spiele gefunden.',
    recent: 'Keine vergangenen Spiele gefunden.',
    results: 'Keine Resultate vorhanden.',
    rankings: 'Keine Ranglisten verfügbar.',
  }

  return (
    <div className="py-12 text-center text-gray-500">
      <p>{messages[tab] ?? 'Keine Daten gefunden.'}</p>
      <p className="mt-1 text-sm">Versuche, den Teamfilter anzupassen.</p>
    </div>
  )
}
