import { useMemo } from 'react'
import TeamChip from '../../components/TeamChip'
import type { Game, Team } from '../../types'
import { parseDate, formatDate } from '../../utils/dateUtils'

interface ListViewProps {
  games: Game[]
  mode: 'date' | 'team'
  teams: Team[]
}

function getTeamName(game: Game, teams: Team[]): string {
  const expanded = (game.expand as { kscw_team?: Team })?.kscw_team
  if (expanded) return expanded.name
  const team = teams.find((t) => t.id === game.kscw_team)
  return team?.name ?? ''
}

function getHallName(game: Game): string {
  const expanded = (game.expand as { hall?: { name: string } })?.hall
  return expanded?.name ?? ''
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    scheduled: 'bg-brand-50 text-brand-700',
    live: 'bg-green-50 text-green-700',
    completed: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
    postponed: 'bg-amber-50 text-amber-700',
  }
  const labels: Record<string, string> = {
    scheduled: 'Planned',
    live: 'Live',
    completed: 'Played',
    postponed: 'Postponed',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}>
      {labels[status] ?? status}
    </span>
  )
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
        type === 'home' ? 'bg-green-50 text-green-700' : 'bg-orange-50 text-orange-700'
      }`}
    >
      {type === 'home' ? 'H' : 'A'}
    </span>
  )
}

function GameRow({ game, teams, showTeam }: { game: Game; teams: Team[]; showTeam: boolean }) {
  const teamName = getTeamName(game, teams)
  const hallName = getHallName(game)

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700">
      {/* Time */}
      <div className="w-14 shrink-0 text-sm font-medium text-gray-700 dark:text-gray-300">
        {game.time || '–'}
      </div>

      {/* Team chip */}
      {showTeam && (
        <div className="w-16 shrink-0">
          <TeamChip team={teamName} size="sm" />
        </div>
      )}

      {/* Matchup */}
      <div className="min-w-0 flex-1">
        <span className="text-sm text-gray-900 dark:text-gray-100">
          {game.home_team} – {game.away_team}
        </span>
      </div>

      {/* Type badge */}
      <TypeBadge type={game.type} />

      {/* Hall */}
      <div className="hidden w-40 truncate text-xs text-gray-500 md:block">
        {hallName}
      </div>

      {/* Status */}
      <StatusBadge status={game.status} />
    </div>
  )
}

function ByDateView({ games, teams }: { games: Game[]; teams: Team[] }) {
  const grouped = useMemo(() => {
    const sorted = [...games].sort((a, b) => {
      const dateCmp = a.date.localeCompare(b.date)
      if (dateCmp !== 0) return dateCmp
      return (a.time ?? '').localeCompare(b.time ?? '')
    })

    const groups: { date: string; label: string; games: Game[] }[] = []
    let currentDate = ''
    for (const game of sorted) {
      const dateStr = game.date.split(' ')[0] ?? game.date
      if (dateStr !== currentDate) {
        currentDate = dateStr
        const d = parseDate(dateStr)
        groups.push({
          date: dateStr,
          label: formatDate(d, 'EEEE, MMMM d, yyyy'),
          games: [],
        })
      }
      groups[groups.length - 1].games.push(game)
    }
    return groups
  }, [games])

  if (games.length === 0) {
    return <div className="py-8 text-center text-gray-500 dark:text-gray-400">No games found</div>
  }

  return (
    <div className="space-y-4">
      {grouped.map((group) => (
        <div key={group.date} className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="border-b border-gray-100 bg-gray-50 dark:bg-gray-900 px-4 py-2">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{group.label}</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {group.games.map((game) => (
              <GameRow key={game.id} game={game} teams={teams} showTeam />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function ByTeamView({ games, teams }: { games: Game[]; teams: Team[] }) {
  const grouped = useMemo(() => {
    const byTeam = new Map<string, { team: Team; games: Game[] }>()

    for (const game of games) {
      const teamId = game.kscw_team
      if (!byTeam.has(teamId)) {
        const team = teams.find((t) => t.id === teamId)
        const expanded = (game.expand as { kscw_team?: Team })?.kscw_team
        byTeam.set(teamId, { team: team ?? expanded ?? ({ name: '?' } as Team), games: [] })
      }
      byTeam.get(teamId)!.games.push(game)
    }

    // Sort games within each group chronologically
    for (const group of byTeam.values()) {
      group.games.sort((a, b) => {
        const dateCmp = a.date.localeCompare(b.date)
        if (dateCmp !== 0) return dateCmp
        return (a.time ?? '').localeCompare(b.time ?? '')
      })
    }

    // Sort groups by team name
    return [...byTeam.values()].sort((a, b) => a.team.name.localeCompare(b.team.name))
  }, [games, teams])

  if (games.length === 0) {
    return <div className="py-8 text-center text-gray-500 dark:text-gray-400">No games found</div>
  }

  return (
    <div className="space-y-4">
      {grouped.map((group) => (
        <div key={group.team.id} className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50 dark:bg-gray-900 px-4 py-2">
            <TeamChip team={group.team.name} />
            <span className="text-sm text-gray-500 dark:text-gray-400">{group.team.league}</span>
            <span className="text-xs text-gray-400">({group.games.length} games)</span>
          </div>
          <div className="divide-y divide-gray-100">
            {group.games.map((game) => (
              <div key={game.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700">
                {/* Date */}
                <div className="w-24 shrink-0 text-xs text-gray-500 dark:text-gray-400">
                  {formatDate(parseDate(game.date.split(' ')[0] ?? game.date), 'MM/dd/yyyy')}
                </div>
                {/* Time */}
                <div className="w-14 shrink-0 text-sm font-medium text-gray-700 dark:text-gray-300">
                  {game.time || '–'}
                </div>
                {/* Matchup */}
                <div className="min-w-0 flex-1 text-sm text-gray-900 dark:text-gray-100">
                  {game.home_team} – {game.away_team}
                </div>
                <TypeBadge type={game.type} />
                <div className="hidden w-40 truncate text-xs text-gray-500 md:block">
                  {getHallName(game)}
                </div>
                <StatusBadge status={game.status} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function ListView({ games, mode, teams }: ListViewProps) {
  if (mode === 'team') {
    return <ByTeamView games={games} teams={teams} />
  }
  return <ByDateView games={games} teams={teams} />
}
